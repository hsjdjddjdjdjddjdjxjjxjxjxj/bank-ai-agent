/**
 * 编排器：9 环节状态机 + 三次分叉 + 驳回回退 + 挂起/确认/取消 + 副3 熔断。
 *
 * 不引 LangGraph / CrewAI：状态机自己写，环节编号与 flow.png 一一对应。
 * 唯一出口不变式：本文件不留任何用户可见文案，所有 userText 都来自 Fu1 的 render*。
 */
import type {
  ConfirmContract,
  Level,
  PlanContract,
  PlanStep,
  ResultContract,
  ReviewContract,
  RiskFlag,
  SelfCheck,
  TaskContract,
  Tier
} from "./contracts.ts";
import { assertContract, sha256Short } from "./contracts.ts";
import type { AppConfig, CopyConfig, PermissionConfig } from "./config.ts";
import type { DraftIntent, UnderstandResult } from "./agents/fu1.ts";
import { backupEmergencyLine, Fu1 } from "./agents/fu1.ts";
import type { DecomposeResult, LevelDecision } from "./agents/main.ts";
import { Main } from "./agents/main.ts";
import { Fu2 } from "./agents/fu2.ts";
import { Fu3 } from "./agents/fu3.ts";
import type { FuseKind, FuseNotice } from "./agents/fu3.ts";
import type { BankState } from "./state.ts";
import { initialState } from "./state.ts";
import type { Transport } from "./transport.ts";

export type TurnStatus =
  | "completed"
  | "need_clarify"
  | "need_confirm"
  | "need_dual_review"
  | "suspended"
  | "cancelled"
  | "rejected"
  | "circuit_break"
  | "error_handled";

export interface StageEvent {
  stage: number;
  kind: "enter" | "fork" | "rollback" | "note" | "suspend" | "resume" | "audit";
  label: string;
  detail?: Record<string, unknown>;
  at: string;
}

export interface DecisionView {
  level: Level | null;
  rules: string[];
  blocked: boolean;
  reason: string;
  requestType: string;
}

export interface TurnContracts {
  task?: TaskContract[];
  plan?: PlanContract;
  review?: ReviewContract;
  confirm?: ConfirmContract;
  result?: ResultContract[];
}

export interface TurnResult {
  sessionId: string;
  turnId: string;
  status: TurnStatus;
  userText: string;
  trajectory: string[];
  decision: DecisionView | null;
  executed: boolean;
  suspended: boolean;
  contracts: TurnContracts;
  audit: { seq: number; hash: string } | null;
  events: StageEvent[];
  note: string;
}

export interface OrchestratorOptions {
  config: AppConfig;
  transport?: Transport | null;
  /** 事件回调：每一步都 emit 给调用方（网页演示/评测都靠它）。 */
  onEvent?: (event: StageEvent) => void;
  /** 演示注入：用来构造「副2 发现权限标记被降级」（S7/S7B）。 */
  demoFault?: ((attempt: number, plan: PlanContract) => PlanContract) | null;
}

interface TurnContext {
  session: SessionState;
  turnId: string;
  sourceText: string;
  events: StageEvent[];
  trajectory: string[];
  contracts: TurnContracts;
  decision: DecisionView | null;
  audit: { seq: number; hash: string } | null;
}

interface PendingExecution {
  ctx: TurnContext;
  tasks: TaskContract[];
  plan: PlanContract;
  index: number;
  confirm: ConfirmContract;
  results: ResultContract[];
  phase: "await_user" | "await_dual" | "suspended";
  level: Level;
}

interface SessionState {
  id: string;
  tier: Tier;
  clarifyRound: number;
  draft: DraftIntent | null;
  pending: PendingExecution | null;
  turnSeq: number;
  lastTurn: TurnResult | null;
}

const LEVEL_ORDER: Record<Level, number> = { green: 0, yellow: 1, red: 2 };

function levelTag(level: Level): string {
  if (level === "green") return "绿";
  if (level === "yellow") return "黄";
  return "红";
}

function maxLevel(levels: Level[]): Level {
  let best: Level = "green";
  for (const level of levels) {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[best]) best = level;
  }
  return best;
}

export class Orchestrator {
  private readonly config: PermissionConfig;
  private readonly copy: CopyConfig;
  private readonly fu1: Fu1;
  private main: Main;
  private readonly fu2: Fu2;
  private readonly fu3: Fu3;
  private state: BankState;
  private readonly sessions = new Map<string, SessionState>();
  private readonly onEvent: ((event: StageEvent) => void) | null;
  private demoFault: ((attempt: number, plan: PlanContract) => PlanContract) | null;
  private sessionSeq = 0;
  /** 副1 是否可用：置 false 时只走副1 模块的单条兜底（SPEC 1.6-3）。 */
  private fu1Available = true;

  constructor(options: OrchestratorOptions) {
    this.config = options.config.permission;
    this.copy = options.config.copy;
    this.state = initialState();
    this.fu1 = new Fu1({ config: this.config, copy: this.copy, transport: options.transport ?? null });
    this.main = new Main({ config: this.config, copy: this.copy, state: this.state });
    this.fu2 = new Fu2(this.config);
    this.fu3 = new Fu3(this.config);
    this.onEvent = options.onEvent ?? null;
    this.demoFault = options.demoFault ?? null;
  }

  setDemoFault(fault: ((attempt: number, plan: PlanContract) => PlanContract) | null): void {
    this.demoFault = fault;
  }

  setFu1Available(available: boolean): void {
    this.fu1Available = available;
  }

  /** 演示用：重置合成账户数据（每个场景从同一份初始账本开始）。 */
  resetWorld(): void {
    this.state = initialState();
    this.main = new Main({ config: this.config, copy: this.copy, state: this.state });
    for (const session of this.sessions.values()) {
      session.pending = null;
    }
  }

  /** 建新会话（网页演示里每个场景一个）。 */
  newSession(tier: Tier): string {
    this.sessionSeq += 1;
    const id = "s-" + String(this.sessionSeq).padStart(2, "0") + "-" + String(Date.now()).slice(-5);
    this.sessions.set(id, {
      id,
      tier,
      clarifyRound: 0,
      draft: null,
      pending: null,
      turnSeq: 0,
      lastTurn: null
    });
    return id;
  }

  /** 一轮对话：环节 1 → … → 9 或挂起等待确认。 */
  async run(input: { text: string; tier?: Tier; sessionId?: string }): Promise<TurnResult> {
    if (!this.fu1Available) return this.fu1DownFallback(input.sessionId ?? "");
    const session = input.sessionId === undefined ? undefined : this.sessions.get(input.sessionId);
    const target = session ?? this.sessionFor(this.newSession(input.tier ?? "L2"));
    if (input.tier !== undefined) target.tier = input.tier;
    const ctx = this.beginTurn(target, input.text);
    this.mark(ctx, 1, "", "enter", { tier: target.tier, textHash: sha256Short(input.text) });

    if (target.pending !== null) {
      this.mark(ctx, 8, "·等待上一笔确认", "note");
      return this.finish(ctx, "suspended", this.fu1.renderPendingExists(), { suspended: true });
    }

    try {
      return await this.pipeline(ctx, input.text);
    } catch (error) {
      return this.handleException(ctx, error);
    }
  }

  /** 用户对确认请求的反馈：同意 / 拒绝 / 取消（环节8 的等待/取消支路）。 */
  confirm(decision: "agree" | "refuse" | "cancel", sessionId?: string): TurnResult {
    const session = this.findSession(sessionId);
    if (session === undefined || session.pending === null) {
      const fallbackCtx = this.beginTurn(this.sessionFor(sessionId), "");
      this.mark(fallbackCtx, 1, "");
      return this.finish(fallbackCtx, "suspended", this.fu1.renderNoPending(), { suspended: false });
    }
    const pending = session.pending;
    const ctx = pending.ctx;
    const step = pending.plan.plan[pending.index];
    if (Date.now() > pending.confirm.expires_at) {
      session.pending = null;
      this.mark(ctx, 8, "·确认超时作废", "fork");
      this.audit(ctx, { tool: step.tool, decision: "confirm_expired", level: pending.level, rules: ["confirm-ttl"], result: "确认超时，任务作废" });
      return this.finish(ctx, "suspended", this.fu1.renderExpired({ ttlSeconds: this.config.confirm.ttlSeconds }), { suspended: false });
    }
    const label = decision === "agree" ? "同意" : decision === "cancel" ? "取消" : "拒绝";
    this.mark(ctx, 8, "·用户" + label, "resume");

    if (decision === "cancel") {
      session.pending = null;
      this.audit(ctx, { tool: step.tool, decision: "cancelled", level: pending.level, rules: ["user-cancel"], result: "用户取消，任务终止" });
      return this.finish(ctx, "cancelled", this.fu1.renderCancelled(), { suspended: false });
    }
    if (decision === "refuse") {
      pending.phase = "suspended";
      this.audit(ctx, { tool: step.tool, decision: "suspended", level: pending.level, rules: ["user-refuse"], result: "用户拒绝，任务挂起" });
      return this.finish(ctx, "suspended", this.fu1.renderSuspended({ tool: step.tool }), { suspended: true });
    }

    if (pending.phase === "await_user" && pending.confirm.dual_review_required) {
      pending.phase = "await_dual";
      this.mark(ctx, 8, "·双人复核待授权", "suspend");
      this.audit(ctx, { tool: step.tool, decision: "await_dual_review", level: pending.level, rules: ["dual-review"], result: "等待复核岗二次授权" });
      return this.finish(ctx, "need_dual_review", this.fu1.renderDualReviewAsk({ confirm: pending.confirm }), { suspended: true });
    }
    return this.executePendingStep(ctx, session, pending, false);
  }

  /** 复核岗二次授权：红级强确认的第二把钥匙（环节8「红=强确认+双人复核」）。 */
  dualReview(decision: "approve" | "deny", sessionId?: string): TurnResult {
    const session = this.findSession(sessionId);
    if (session === undefined || session.pending === null) {
      const fallbackCtx = this.beginTurn(this.sessionFor(sessionId), "");
      this.mark(fallbackCtx, 1, "");
      return this.finish(fallbackCtx, "suspended", this.fu1.renderNoPending(), { suspended: false });
    }
    const pending = session.pending;
    const ctx = pending.ctx;
    const step = pending.plan.plan[pending.index];
    if (Date.now() > pending.confirm.expires_at) {
      session.pending = null;
      this.mark(ctx, 8, "·复核超时作废", "fork");
      this.audit(ctx, { tool: step.tool, decision: "confirm_expired", level: pending.level, rules: ["confirm-ttl"], result: "复核授权超时，任务作废" });
      return this.finish(ctx, "suspended", this.fu1.renderExpired({ ttlSeconds: this.config.confirm.ttlSeconds }), { suspended: false });
    }
    if (pending.phase !== "await_dual") {
      return this.finish(ctx, "suspended", this.fu1.renderNoPending(), { suspended: true });
    }
    if (decision === "deny") {
      pending.phase = "suspended";
      this.mark(ctx, 8, "·双人复核拒绝", "fork");
      this.audit(ctx, { tool: step.tool, decision: "dual_review_denied", level: pending.level, rules: ["dual-review"], result: "复核岗拒绝" });
      return this.finish(ctx, "suspended", this.fu1.renderSuspended({ tool: step.tool }), { suspended: true });
    }
    this.mark(ctx, 8, "·双人复核通过", "resume");
    this.audit(ctx, { tool: step.tool, decision: "dual_review_approved", level: pending.level, rules: ["dual-review"], result: "复核岗授权通过" });
    return this.executePendingStep(ctx, session, pending, true);
  }

  /** 副1 不可用时的唯一一条兜底：副1 模块产出文本，副3 只给结构化通知。 */
  fu1DownFallback(sessionId: string): TurnResult {
    const session = this.findSession(sessionId) ?? this.sessionFor(this.newSession("L2"));
    const pending = session.pending;
    const ticket = "HIT-" + String(8600 + this.fu3.list(999).length + 1);
    if (pending !== null) {
      session.pending = null;
    }
    const events: StageEvent[] = [];
    const record = this.fu3.append({
      sessionId: session.id,
      text: "",
      tool: "none",
      decision: "fu1_unavailable",
      level: "red",
      rules: ["fu1-down"],
      result: ticket
    });
    const ctx: TurnContext = {
      session,
      turnId: "t-" + String(Date.now()),
      sourceText: "",
      events,
      trajectory: ["副1不可用·兜底"],
      contracts: {},
      decision: { level: "red", rules: ["fu1-down"], blocked: true, reason: "副1 不可用", requestType: "系统" },
      audit: { seq: record.seq, hash: record.hash }
    };
    this.mark(ctx, 0, "·副1不可用", "note", { ticket });
    return this.finish(ctx, "error_handled", backupEmergencyLine(this.copy, ticket), { suspended: false });
  }

  // -------------------------------------------------------------- 主流程

  private async pipeline(ctx: TurnContext, text: string): Promise<TurnResult> {
    const session = ctx.session;
    this.mark(ctx, 2, "", "enter");

    const understand = await this.fu1.understand({
      text,
      tier: session.tier,
      clarifyRound: session.clarifyRound,
      draft: session.draft
    });

    if (!understand.understood) {
      this.mark(ctx, 2, "·否·礼貌拒绝", "fork");
      this.audit(ctx, { tool: "unknown", decision: "not_understood", level: "unknown", rules: ["intent-miss"], result: "未识别意图，结束本轮" });
      return this.finish(ctx, "rejected", this.fu1.renderNotUnderstood(), {
        decision: { level: null, rules: ["intent-miss"], blocked: true, reason: "未识别意图", requestType: "未知" }
      });
    }

    // 副3 旁路：同类意图连续重复熔断（S8）
    const signature = understand.intents.length === 0 ? "non-bank" : understand.intents.map((item) => item.tool).join("+");
    const intentCounter = this.fu3.observeIntent(signature, session.id);
    this.emit(ctx, {
      stage: 0,
      kind: "note",
      label: "副3 同类意图计数 " + String(intentCounter.count) + "/" + String(intentCounter.limit),
      detail: { signature, count: intentCounter.count, limit: intentCounter.limit }
    });
    if (intentCounter.tripped) return this.breakCircuit(ctx, "same-intent");

    // 反问补槽（maxRounds 从 config 读）。
    // 风险输入不进入反问：命中注入/越权/合规时直接进环节3/4，避免向攻击者追问槽位。
    let tasks: TaskContract[] | null = null;
    if (understand.missing.length > 0) {
      const provisional = this.buildTasks(ctx, understand, text);
      const preCheck = this.main.selfCheck(provisional[0], text);
      if (!preCheck.blocked) {
        const primary = understand.intents[0];
        session.draft = { tool: primary.tool, slots: { ...primary.slots }, missing: [...understand.missing] };
        session.clarifyRound += 1;
        const maxRounds = this.config.clarify.maxRounds;
        if (session.clarifyRound > maxRounds) {
          this.mark(ctx, 2, "·反问超限", "fork");
          this.audit(ctx, { tool: primary.tool, decision: "clarify_exhausted", level: "unknown", rules: ["clarify-limit"], result: "反问轮次超限，终止本轮" });
          return this.finish(ctx, "rejected", this.fu1.renderClarifyExhausted({ round: maxRounds }), {
            decision: { level: null, rules: ["clarify-limit"], blocked: true, reason: "反问轮次超限", requestType: "未知" }
          });
        }
        this.mark(ctx, 2, "·反问", "fork", { missing: understand.missing, round: session.clarifyRound });
        this.audit(ctx, { tool: primary.tool, decision: "need_slots", level: "unknown", rules: ["slot-missing"], result: "缺槽：" + understand.missing.join(",") });
        const userText = this.fu1.renderClarify({ tier: session.tier, missing: understand.missing, round: session.clarifyRound });
        return this.finish(ctx, "need_clarify", userText, { suspended: false });
      }
      this.mark(ctx, 2, "·风险输入跳过反问", "note", { flags: preCheck.flags });
      tasks = provisional;
    } else {
      session.draft = null;
      session.clarifyRound = 0;

      // 环节2 放行判断（档位只影响反问颗粒度与敏感数据范围，颜色可达性归环节5）
      const admit = this.fu1.admit(understand, session.tier);
      if (!admit.admit) {
        this.mark(ctx, 2, "·否·放行判断不通过", "fork");
        const tool = understand.intents[0]?.tool ?? "unknown";
        this.audit(ctx, { tool, decision: "fu1_denied", level: "red", rules: [admit.reason], result: admit.note });
        return this.finish(ctx, "rejected", this.fu1.renderTierDenied({ tool, tier: session.tier }), {
          decision: { level: "red", rules: [admit.reason], blocked: true, reason: admit.note, requestType: "敏感数据" }
        });
      }
      tasks = this.buildTasks(ctx, understand, text);
    }
    ctx.contracts.task = tasks;

    // 环节3：业务相关性判断
    this.mark(ctx, 3, "", "enter");
    for (const task of tasks) {
      this.emit(ctx, { stage: 3, kind: "enter", label: "业务相关性：" + task.intent, detail: { intent: task.intent } });
      const domain = this.main.domainCheck(task);
      if (!domain.inDomain) {
        this.mark(ctx, 3, "·否·非业务域", "fork");
        const repeat = this.fu3.observeNonBank(session.id);
        this.emit(ctx, {
          stage: 0,
          kind: "note",
          label: "副3 非业务域计数 " + String(repeat.count) + "/" + String(repeat.limit),
          detail: { count: repeat.count, limit: repeat.limit }
        });
        this.audit(ctx, { tool: task.intent, decision: "out_of_domain", level: "unknown", rules: [domain.rule], result: domain.detail });
        if (repeat.tripped) {
          // 环节3 否分支的「标记多次请求/直接驳回」：达到上限后不再逐轮解释，交副3 熔断 + 转人工
          return this.breakCircuit(ctx, "non-bank-repeat");
        }
        return this.finish(ctx, "rejected", this.fu1.renderNonBank(), {
          decision: { level: null, rules: [domain.rule], blocked: true, reason: domain.detail, requestType: "非业务域" }
        });
      }
    }

    // 环节4：风险自检
    let selfCheck: SelfCheck = { injection: false, privilege: false, compliance: false, passed: true };
    const riskFlags: RiskFlag[] = [];
    this.mark(ctx, 4, "", "enter");
    for (const task of tasks) {
      this.emit(ctx, { stage: 4, kind: "enter", label: "风险自检：" + task.intent, detail: { intent: task.intent } });
      const check = this.main.selfCheck(task, text);
      riskFlags.push(...check.flags);
      selfCheck = check.selfCheck;
      if (check.blocked) {
        this.mark(ctx, 4, "·是·命中风险", "fork", { flags: check.flags });
        this.audit(ctx, { tool: task.intent, decision: "blocked_risk", level: "red", rules: check.flags.map((flag) => flag.rule), result: check.reason });
        return this.finish(ctx, "rejected", this.fu1.renderRiskRefusal(), {
          decision: {
            level: "red",
            rules: check.flags.map((flag) => flag.rule),
            blocked: true,
            reason: check.reason,
            requestType: "风险请求"
          }
        });
      }
    }

    // 环节5：权限初判（三色分流）
    const decisions = tasks.map((task) => this.main.initialLevel(task));
    const turnLevel = maxLevel(decisions.map((item: LevelDecision) => item.level));
    const hitRules = decisions.flatMap((item) => item.hits.map((hit) => hit.rule));
    if (tasks.length > 1) hitRules.push("multi-step-escalate");
    const blocked = decisions.find((item) => item.blocked);
    ctx.decision = {
      level: turnLevel,
      rules: Array.from(new Set(hitRules)),
      blocked: blocked !== undefined,
      reason: blocked?.blockDetail ?? "",
      requestType: decisions.map((item) => item.requestType).join("+")
    };
    this.mark(ctx, 5, levelTag(turnLevel), "enter", { rules: ctx.decision.rules, requestType: ctx.decision.requestType });

    if (blocked !== undefined) {
      const blockedTask = tasks[decisions.indexOf(blocked)];
      if (blocked.blockRule === "irreversible") {
        this.mark(ctx, 5, "红·不可逆·拒绝", "fork");
        this.audit(ctx, { tool: blockedTask.intent, decision: "blocked_irreversible", level: "red", rules: ["irreversible"], result: blocked.blockDetail });
        return this.finish(ctx, "rejected", this.fu1.renderIrreversible({ tool: blockedTask.intent }), {
          decision: { ...ctx.decision, blocked: true, reason: blocked.blockDetail }
        });
      }
      this.mark(ctx, 5, "红·档位不可达", "fork");
      this.audit(ctx, { tool: blockedTask.intent, decision: "blocked_tier", level: "red", rules: ["tier-reach"], result: blocked.blockDetail });
      return this.finish(ctx, "rejected", this.fu1.renderTierDenied({ tool: blockedTask.intent, tier: tasks[0].tier }), {
        decision: { ...ctx.decision, blocked: true, reason: blocked.blockDetail }
      });
    }

    // 环节6：任务拆解与合法性判断
    this.mark(ctx, 6, "", "enter");
    const first = this.main.decompose({ tasks, tier: session.tier, attempt: 0, selfCheck, riskFlags });
    const firstPlan = this.planOrReject(ctx, first, tasks);
    if (typeof firstPlan === "string") return this.finish(ctx, "rejected", firstPlan, { decision: ctx.decision });
    let plan: PlanContract = firstPlan;

    // 环节7：副2 复核（不通过 → 驳回环节6 重做，最多 maxReject 次）
    let attempt = 0;
    let rejectCount = 0;
    while (true) {
      this.emit(ctx, { stage: 7, kind: "enter", label: "副2 复核" });
      const candidate = this.demoFault === null ? plan : this.demoFault(attempt, plan);
      if (candidate !== plan) {
        // 演示注入故障（不是真实业务违规）：把子任务权限标记降级，验证副2 抓不抓得到
        this.mark(ctx, 7, "·注入故障(演示)", "note", { detail: "演示注入：子任务权限标记被降级" });
      }
      plan = assertContract<PlanContract>("plan", candidate);
      ctx.contracts.plan = plan;
      const review = this.fu2.review(plan, { tasks, tier: session.tier, rejectCount });
      ctx.contracts.review = review;
      this.emit(ctx, { stage: 7, kind: "fork", label: review.verdict === "pass" ? "复核通过" : "复核驳回", detail: { violations: review.violations } });

      if (review.verdict === "pass") {
        this.mark(ctx, 7, "·通过", "fork");
        break;
      }

      const counter = this.fu3.observeReject();
      this.mark(ctx, 7, "·驳回", "fork", { violations: review.violations, count: counter.count, limit: counter.limit });
      this.audit(ctx, { tool: plan.plan[0].tool, decision: "review_reject", level: "yellow", rules: review.violations.map((item) => item.rule), result: "副2 驳回第 " + String(counter.count) + " 次" });
      if (counter.tripped) return this.breakCircuit(ctx, "reject-limit");

      rejectCount = review.reject_count;
      this.mark(ctx, 7, "·回退6", "rollback");
      attempt += 1;
      this.mark(ctx, 6, "·重做", "enter", { attempt });
      const retry: DecomposeResult = this.main.decompose({ tasks, tier: session.tier, attempt, selfCheck, riskFlags });
      const retryPlan = this.planOrReject(ctx, retry, tasks);
      if (typeof retryPlan === "string") return this.finish(ctx, "rejected", retryPlan, { decision: ctx.decision });
      plan = retryPlan;
    }

    // 环节8：执行（每步再校验权限标记与参数；黄/红先确认）
    return this.advance(ctx, session, plan, tasks, 0, []);
  }

  /** 环节8 推进：绿直接执行，黄/红挂起等确认。 */
  private advance(
    ctx: TurnContext,
    session: SessionState,
    plan: PlanContract,
    tasks: TaskContract[],
    startIndex: number,
    results: ResultContract[]
  ): TurnResult {
    for (let index = startIndex; index < plan.plan.length; index += 1) {
      const step = plan.plan[index];
      if (step.level !== "green") {
        const built = this.main.buildConfirm(step, plan.task_id, step.level);
        const confirm = assertContract<ConfirmContract>("confirm", built.confirm);
        session.pending = {
          ctx,
          tasks,
          plan,
          index,
          confirm,
          results,
          phase: "await_user",
          level: step.level
        };
        ctx.contracts.confirm = confirm;
        this.mark(ctx, 8, "·" + levelTag(step.level) + (step.level === "red" ? "·强确认" : "·确认"), "suspend");
        this.audit(ctx, { tool: step.tool, decision: "pending_confirm", level: step.level, rules: step.reason_rules, result: "等待用户确认" });
        ctx.decision = {
          level: step.level,
          rules: step.reason_rules,
          blocked: false,
          reason: "",
          requestType: this.main.requestType(step.tool)
        };
        return this.finish(ctx, "need_confirm", this.fu1.renderConfirm({ confirm, tool: step.tool }), { suspended: true });
      }

      this.mark(ctx, 8, "·绿·直通", "enter");
      const result = this.main.executeStep(step, plan.task_id, session.tier);
      results.push(result);
      ctx.contracts.result = [...results];
      const toolCounter = this.fu3.observeTool(step.tool, result.ok);
      this.audit(ctx, {
        tool: step.tool,
        decision: result.ok ? "auto_execute" : "executed_with_error",
        level: "green",
        rules: step.reason_rules,
        result: result.ok ? "绿级直接执行成功" : (result.error ?? "执行失败")
      });
      if (!result.ok && toolCounter.tripped) return this.breakCircuit(ctx, "tool-failure");
    }
    return this.finishCompleted(ctx, results);
  }

  /** 执行挂起队列里的当前步，然后继续后续步骤。 */
  private executePendingStep(ctx: TurnContext, session: SessionState, pending: PendingExecution, dualApproved: boolean): TurnResult {
    const step = pending.plan.plan[pending.index];
    this.mark(ctx, 8, "·执行" + levelTag(pending.level), "enter", { dualReview: dualApproved });
    const result = this.main.executeStep(step, pending.plan.task_id, session.tier);
    pending.results.push(result);
    ctx.contracts.result = [...pending.results];
    const toolCounter = this.fu3.observeTool(step.tool, result.ok);
    this.audit(ctx, {
      tool: step.tool,
      decision: result.ok ? "confirmed_execute" : "confirmed_failed",
      level: pending.level,
      rules: step.reason_rules,
      result: result.ok ? "确认后执行成功" : (result.error ?? "执行失败")
    });
    if (!result.ok && toolCounter.tripped) {
      session.pending = null;
      return this.breakCircuit(ctx, "tool-failure");
    }
    session.pending = null;
    return this.advance(ctx, session, pending.plan, pending.tasks, pending.index + 1, pending.results);
  }

  // -------------------------------------------------------------- 收尾

  private finishCompleted(ctx: TurnContext, results: ResultContract[]): TurnResult {
    // 环节9：记录（副3 执行日志）→ 回传副1 包装 → 返回用户
    this.audit(ctx, { tool: results.length === 0 ? "none" : results[results.length - 1].tool, decision: "completed", level: "green", rules: ["result-wrapped"], result: "结果已由副1 包装" });
    this.mark(ctx, 9, "", "enter", { results: results.length });
    const userText = this.fu1.renderResults({ results });
    return this.finish(ctx, "completed", userText, { executed: true });
  }

  private breakCircuit(ctx: TurnContext, kind: FuseKind): TurnResult {
    const notice = this.fu3.fuse(kind);
    this.emit(ctx, { stage: 0, kind: "note", label: "副3 熔断", detail: { kind, count: notice.count, limit: notice.limit, ticket: notice.ticket } });
    this.mark(ctx, 0, "副3·熔断" + kind, "fork", { count: notice.count, limit: notice.limit });
    this.audit(ctx, { tool: "none", decision: "circuit_break", level: "red", rules: [kind], result: "熔断：" + notice.ticket });
    // 回传副1：只由副1 说这一条，副3 不接管多轮
    const userText = this.fu1.renderCircuitBreak(notice);
    return this.finish(ctx, "circuit_break", userText, {
      decision: { level: "red", rules: [kind], blocked: true, reason: "副3 熔断：" + kind, requestType: "异常" }
    });
  }

  private handleException(ctx: TurnContext, error: unknown): TurnResult {
    const message = error instanceof Error ? error.message : String(error);
    this.mark(ctx, 0, "·异常捕获", "fork");
    const notice: FuseNotice = this.fu3.fuse("exception");
    this.audit(ctx, { tool: "none", decision: "exception", level: "red", rules: ["exception"], result: message.slice(0, 160) });
    return this.finish(ctx, "error_handled", this.fu1.renderCircuitBreak(notice), {
      decision: { level: "red", rules: ["exception"], blocked: true, reason: message, requestType: "异常" }
    });
  }

  private finish(
    ctx: TurnContext,
    status: TurnStatus,
    userText: string,
    options: { suspended?: boolean; executed?: boolean; decision?: DecisionView | null } = {}
  ): TurnResult {
    const result: TurnResult = {
      sessionId: ctx.session.id,
      turnId: ctx.turnId,
      status,
      userText,
      trajectory: [...ctx.trajectory],
      decision: options.decision === undefined ? ctx.decision : options.decision,
      executed: options.executed === true,
      suspended: options.suspended === true,
      contracts: {
        task: ctx.contracts.task,
        plan: ctx.contracts.plan,
        review: ctx.contracts.review,
        confirm: ctx.contracts.confirm,
        result: ctx.contracts.result === undefined ? undefined : [...ctx.contracts.result]
      },
      audit: ctx.audit,
      events: [...ctx.events],
      note: ""
    };
    ctx.session.lastTurn = result;
    return result;
  }

  // -------------------------------------------------------------- 内部工具

  private planOrReject(ctx: TurnContext, result: DecomposeResult, tasks: TaskContract[]): PlanContract | string {
    if (result.illegal !== null) {
      this.mark(ctx, 6, "·不合法不受理", "fork", { rule: result.illegal.rule, detail: result.illegal.detail });
      this.audit(ctx, { tool: result.illegal.tool, decision: "illegal_plan", level: "red", rules: [result.illegal.rule], result: result.illegal.detail });
      return this.fu1.renderIllegal({ reason: result.illegal.detail });
    }
    if (result.plan === null) {
      this.mark(ctx, 6, "·拆解失败", "fork");
      return this.fu1.renderIllegal({ reason: "任务拆解失败" });
    }
    const plan = assertContract<PlanContract>("plan", result.plan);
    ctx.contracts.plan = plan;
    this.emit(ctx, { stage: 6, kind: "enter", label: "拆解完成", detail: { steps: plan.plan.map((step: PlanStep) => ({ step: step.step, tool: step.tool, level: step.level })) } });
    return plan;
  }

  private buildTasks(ctx: TurnContext, understand: UnderstandResult, text: string): TaskContract[] {
    ctx.session.turnSeq += 1;
    const tasks: TaskContract[] = [];
    const intents = understand.intents.length === 0
      ? [{ tool: "unknown", slots: {} as Record<string, unknown>, missing: [] as string[], source: "rule" as const, confidence: 0 }]
      : understand.intents;
    intents.forEach((intent, index) => {
      const task: TaskContract = {
        task_id: ctx.session.id + "-t" + String(ctx.session.turnSeq) + "-" + String(index + 1),
        session_id: ctx.session.id,
        intent: intent.tool,
        slots: { ...intent.slots },
        missing: [],
        tier: ctx.session.tier,
        clarify_rounds: ctx.session.clarifyRound,
        user_text_hash: sha256Short(text)
      };
      tasks.push(assertContract<TaskContract>("task", task));
    });
    return tasks;
  }

  private beginTurn(session: SessionState, text: string): TurnContext {
    session.turnSeq += 1;
    this.fu3.resetRejects();
    return {
      session,
      turnId: "t-" + String(session.turnSeq) + "-" + String(Date.now()).slice(-5),
      sourceText: text,
      events: [],
      trajectory: [],
      contracts: {},
      decision: null,
      audit: null
    };
  }

  private mark(
    ctx: TurnContext,
    stage: number,
    label: string,
    kind: StageEvent["kind"],
    detail?: Record<string, unknown>
  ): void {
    const token = stage === 0 ? label : String(stage) + label;
    if (token !== "") ctx.trajectory.push(token);
    this.emit(ctx, { stage, kind, label, detail });
  }

  private emit(ctx: TurnContext, event: Omit<StageEvent, "at">): void {
    const full: StageEvent = { ...event, at: new Date().toISOString() };
    ctx.events.push(full);
    if (this.onEvent !== null) this.onEvent(full);
  }

  private audit(ctx: TurnContext, input: { tool: string; decision: string; level: string; rules: string[]; result: string }): void {
    const record = this.fu3.append({
      sessionId: ctx.session.id,
      text: ctx.sourceText,
      tool: input.tool,
      decision: input.decision,
      level: input.level,
      rules: input.rules,
      result: input.result
    });
    ctx.audit = { seq: record.seq, hash: record.hash };
    this.emit(ctx, { stage: 0, kind: "audit", label: "副3 记录", detail: { seq: record.seq, hash: record.hash, decision: input.decision } });
  }

  private sessionFor(sessionId: string | undefined): SessionState {
    if (sessionId !== undefined) {
      const found = this.sessions.get(sessionId);
      if (found !== undefined) return found;
    }
    const last = Array.from(this.sessions.values()).at(-1);
    if (last !== undefined) return last;
    return this.sessionFor(this.newSession("L2"));
  }

  private findSession(sessionId: string | undefined): SessionState | undefined {
    if (sessionId !== undefined) return this.sessions.get(sessionId);
    return Array.from(this.sessions.values()).at(-1);
  }

  // -------------------------------------------------------------- 给演示/评测用

  auditLog(limit: number = 10) {
    return this.fu3.list(limit);
  }

  verifyChain(): { ok: boolean; total: number; brokenAt: number | null } {
    return this.fu3.verifyChain();
  }

  counters() {
    return this.fu3.counters();
  }

  snapshot(): { tierBySession: Record<string, Tier>; pending: Record<string, boolean>; tools: string[]; rules: typeof this.config.statsKeyRules } {
    const tierBySession: Record<string, Tier> = {};
    const pending: Record<string, boolean> = {};
    for (const [id, session] of this.sessions) {
      tierBySession[id] = session.tier;
      pending[id] = session.pending !== null;
    }
    return { tierBySession, pending, tools: Object.keys(this.config.tools), rules: this.config.statsKeyRules };
  }
}
