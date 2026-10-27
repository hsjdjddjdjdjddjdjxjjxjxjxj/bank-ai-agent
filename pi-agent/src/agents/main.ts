/**
 * 主执 Agent：中台。业务相关性判断、风险自检、权限初判、任务拆解与合法性、执行。
 *
 * 硬约束：不出沙箱、不产出任何用户可见文本。所有方法只返回结构体，
 * 由副1 渲染成话术。判定一律带规则名（base-level / tier-reach / single-limit /
 * irreversible / injection / out-of-domain / multi-step-escalate）。
 */
import type {
  ConfirmContract,
  Level,
  PlanContract,
  PlanStep,
  ResultContract,
  RiskFlag,
  SelfCheck,
  TaskContract,
  Tier
} from "../contracts.ts";
import type { CopyConfig, PermissionConfig } from "../config.ts";
import { compilePatterns, levelOfTool, requestTypeOf, requiredTierFor, tierCanReach, toolLabel } from "../config.ts";
import type { BankState } from "../state.ts";
import { maskPhone, yuan } from "../state.ts";
import { MOCK_TOOLS } from "../../tools/mock/index.ts";

export interface RuleHit {
  rule: string;
  detail: string;
}

export interface DomainResult {
  inDomain: boolean;
  rule: string;
  detail: string;
}

export interface SelfCheckResult {
  selfCheck: SelfCheck;
  flags: RiskFlag[];
  blocked: boolean;
  reason: string;
}

export interface LevelDecision {
  level: Level;
  hits: RuleHit[];
  blocked: boolean;
  blockRule: string;
  blockDetail: string;
  requestType: string;
}

export interface DecomposeInput {
  tasks: TaskContract[];
  tier: Tier;
  attempt: number;
  selfCheck: SelfCheck;
  riskFlags: RiskFlag[];
}

export interface IllegalReason {
  rule: string;
  detail: string;
  tool: string;
}

export interface DecomposeResult {
  plan: PlanContract | null;
  illegal: IllegalReason | null;
}

export interface MainDeps {
  config: PermissionConfig;
  copy: CopyConfig;
  state: BankState;
}

const LEVEL_ORDER: Record<Level, number> = { green: 0, yellow: 1, red: 2 };

export class Main {
  private readonly config: PermissionConfig;
  private readonly copy: CopyConfig;
  private readonly state: BankState;
  private readonly injectionPatterns: RegExp[];
  private readonly privilegePatterns: RegExp[];
  private readonly compliancePatterns: RegExp[];

  constructor(deps: MainDeps) {
    this.config = deps.config;
    this.copy = deps.copy;
    this.state = deps.state;
    this.injectionPatterns = compilePatterns(deps.config.injection.patterns);
    this.privilegePatterns = compilePatterns(deps.config.selfCheck.privilegePatterns);
    this.compliancePatterns = compilePatterns(deps.config.selfCheck.compliancePatterns);
  }

  /** 环节3：业务相关性判断。不在银行业务域 → 转交副1 终止本轮。 */
  domainCheck(task: TaskContract): DomainResult {
    if (task.intent === "unknown" || this.config.tools[task.intent] === undefined) {
      return {
        inDomain: false,
        rule: "out-of-domain",
        detail: "请求不在银行业务域（账户/支付/理财/信贷/合规咨询）内"
      };
    }
    return { inDomain: true, rule: "", detail: "" };
  }

  /**
   * 环节4：风险自检（合规红线 / 越权 / 可疑诱导 / 提示词注入）。
   * 原始输入只用于特征匹配，不外传、不落明文日志（审计落脱敏文本）。
   */
  selfCheck(task: TaskContract, originalText: string): SelfCheckResult {
    const flags: RiskFlag[] = [];
    if (this.config.injection.enabled && this.injectionPatterns.some((pattern) => pattern.test(originalText))) {
      flags.push({ rule: "injection", detail: "命中提示词注入特征（试图覆盖规则或索取系统提示）" });
    }
    if (this.privilegePatterns.some((pattern) => pattern.test(originalText))) {
      flags.push({ rule: "privilege", detail: "命中越权特征（代查他人账户/免验证/提权限）" });
    }
    if (this.compliancePatterns.some((pattern) => pattern.test(originalText))) {
      flags.push({ rule: "compliance", detail: "命中合规红线特征（套现/洗钱/分拆/过账）" });
    }
    const selfCheck: SelfCheck = {
      injection: flags.some((flag) => flag.rule === "injection"),
      privilege: flags.some((flag) => flag.rule === "privilege"),
      compliance: flags.some((flag) => flag.rule === "compliance"),
      passed: flags.length === 0,
      detail: flags.map((flag) => flag.rule + "：" + flag.detail).join("；")
    };
    return {
      selfCheck,
      flags,
      blocked: flags.length > 0,
      reason: selfCheck.detail
    };
  }

  /**
   * 环节5：权限初判。第一次分流只看「请求本身 + 档位」，不做拆分。
   * 颜色 = 工具基础等级；不可逆直接锁红；档位不可达即拦。
   */
  initialLevel(task: TaskContract): LevelDecision {
    const tool = task.intent;
    const hitBase: RuleHit = {
      rule: "base-level",
      detail: toolLabel(this.copy, tool) + "属于" + this.requestType(tool) + "类请求，基础等级 " + (levelOfTool(this.config, tool) ?? "red")
    };
    const hits: RuleHit[] = [hitBase];
    let level: Level = levelOfTool(this.config, tool) ?? "red";

    const spec = this.config.tools[tool];
    if (spec === undefined) {
      hits.push({ rule: "base-level", detail: "工具不在配置表，按最高风险处理" });
      return { level: "red", hits, blocked: true, blockRule: "irreversible", blockDetail: "工具未登记", requestType: "敏感数据" };
    }

    if (spec.irreversible) {
      hits.push({ rule: "irreversible", detail: toolLabel(this.copy, tool) + "属于不可撤销业务，线上不受理" });
      level = "red";
      return { level, hits, blocked: true, blockRule: "irreversible", blockDetail: hits[1].detail, requestType: this.requestType(tool) };
    }

    if (!tierCanReach(this.config, task.tier, level)) {
      const required = requiredTierFor(this.config, level);
      hits.push({
        rule: "tier-reach",
        detail: "该请求需要 " + (this.config.tierLabels[required] ?? required) + "，当前档位 " + task.tier + " 不可触达 " + level
      });
      return { level, hits, blocked: true, blockRule: "tier-reach", blockDetail: hits[1].detail, requestType: this.requestType(tool) };
    }

    return { level, hits, blocked: false, blockRule: "", blockDetail: "", requestType: this.requestType(tool) };
  }

  /** 环节6：任务拆解 + 合法性判断。不合法 → 不受理，回副1。 */
  decompose(input: DecomposeInput): DecomposeResult {
    const steps: PlanStep[] = [];
    for (const task of input.tasks) {
      const tool = task.intent;
      const meta = MOCK_TOOLS[tool];
      const spec = this.config.tools[tool];
      if (meta === undefined || spec === undefined) {
        return { plan: null, illegal: { rule: "tool-whitelist", detail: "工具 " + tool + " 不在白名单", tool } };
      }
      const args = this.buildArgs(task);
      for (const key of meta.requiredArgs) {
        if (args[key] === undefined || args[key] === "") {
          return { plan: null, illegal: { rule: "args-invalid", detail: toolLabel(this.copy, tool) + "缺少参数 " + key, tool } };
        }
      }
      if (tool === "transfer") {
        const amount = args.amountCents;
        if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
          return { plan: null, illegal: { rule: "args-invalid", detail: "转账金额必须是正整数分", tool } };
        }
        const limit = this.config.limits.singleTransferCents;
        if (amount > limit) {
          return {
            plan: null,
            illegal: {
              rule: "single-limit",
              detail: "转账 " + yuan(amount) + " 元超过单笔限额 " + yuan(limit) + " 元（single-limit）",
              tool
            }
          };
        }
      }
      if (tool === "update_phone") {
        const phone = args.newPhone;
        if (typeof phone !== "string" || !/^1[3-9]\d{9}$/.test(phone)) {
          return { plan: null, illegal: { rule: "args-invalid", detail: "新手机号格式不合法", tool } };
        }
      }
      steps.push({
        step: steps.length + 1,
        tool,
        args,
        level: spec.level,
        reason_rules: ["base-level"]
      });
    }
    if (steps.length === 0) {
      return { plan: null, illegal: { rule: "args-invalid", detail: "没有可执行子任务", tool: "unknown" } };
    }

    // 执行顺序：绿先、黄次、红最后；同一颜色保持拆解顺序（S5：绿先执行）。
    const ordered = steps
      .map((step, index) => ({ step, index }))
      .sort((left, right) => {
        const diff = LEVEL_ORDER[left.step.level] - LEVEL_ORDER[right.step.level];
        return diff !== 0 ? diff : left.index - right.index;
      })
      .map((item, index) => ({ ...item.step, step: index + 1 }));

    const multiStep = ordered.length > 1;
    if (multiStep) {
      let highest = 0;
      for (let index = 0; index < ordered.length; index += 1) {
        if (LEVEL_ORDER[ordered[index].level] > LEVEL_ORDER[ordered[highest].level]) highest = index;
      }
      if (!ordered[highest].reason_rules.includes("multi-step-escalate")) {
        ordered[highest].reason_rules = [...ordered[highest].reason_rules, "multi-step-escalate"];
      }
    }

    const plan: PlanContract = {
      task_id: input.tasks[0].task_id,
      plan: ordered,
      risk_flags: input.riskFlags,
      self_check: input.selfCheck,
      tier: input.tier
    };
    return { plan, illegal: null };
  }

  /** 环节8：执行。执行前再校验一次权限标记与参数，配置对不上就拒绝执行。 */
  executeStep(step: PlanStep, taskId: string, tier: Tier): ResultContract {
    const spec = this.config.tools[step.tool];
    const tool = MOCK_TOOLS[step.tool];
    if (spec === undefined || tool === undefined) {
      return { task_id: taskId, ok: false, tool: step.tool, receipt: null, data: {}, error: "工具不在白名单" };
    }
    if (spec.level !== step.level) {
      return {
        task_id: taskId,
        ok: false,
        tool: step.tool,
        receipt: null,
        data: {},
        error: "权限标记 " + step.level + " 与配置等级 " + spec.level + " 不一致，拒绝执行"
      };
    }
    if (!tierCanReach(this.config, tier, step.level)) {
      return {
        task_id: taskId,
        ok: false,
        tool: step.tool,
        receipt: null,
        data: {},
        error: "当前档位 " + tier + " 不可执行 " + step.level + " 级操作"
      };
    }
    for (const key of tool.requiredArgs) {
      const value = step.args[key];
      if (value === undefined || value === "") {
        return { task_id: taskId, ok: false, tool: step.tool, receipt: null, data: {}, error: "缺少参数 " + key };
      }
    }
    const output = tool.run(step.args, this.state);
    return { task_id: taskId, ...output };
  }

  /** 确认契约：确认要素固定为对象 / 金额 / 后果（环节8）。 */
  buildConfirm(step: PlanStep, taskId: string, level: Level): ConfirmItemContract {
    const args = step.args;
    let object = toolLabel(this.copy, step.tool);
    let amount = "不涉及资金变动";
    if (step.tool === "transfer") {
      const payee = typeof args.payee === "string" ? args.payee : "";
      const memo = typeof args.memo === "string" && args.memo !== "" ? "（备注 " + args.memo + "）" : "";
      object = "收款人 " + payee + memo;
      amount = yuan(typeof args.amountCents === "number" ? args.amountCents : 0) + " 元";
    }
    if (step.tool === "update_phone") {
      const next = typeof args.newPhone === "string" ? args.newPhone : "";
      object = "预留手机号 " + maskPhone(this.state.phone) + " → " + maskPhone(next);
    }
    if (step.tool === "lock_card") {
      const card = this.state.cards[0];
      object = card === undefined ? "银行卡" : card.label;
    }
    const consequence = this.copy.consequences[step.tool] ?? "请确认是否继续";
    return {
      confirm: {
        task_id: taskId,
        level: level === "green" ? "yellow" : level,
        items: [{ object, amount, consequence }],
        dual_review_required: level === "red" && this.config.limits.redDualReview,
        expires_at: Date.now() + this.config.confirm.ttlSeconds * 1000
      },
      tool: step.tool
    };
  }

  requestType(tool: string): string {
    return requestTypeOf(this.config, tool);
  }

  private buildArgs(task: TaskContract): Record<string, unknown> {
    const slots = task.slots;
    switch (task.intent) {
      case "query_balance":
      case "bill_query":
        return {};
      case "update_phone":
        return { newPhone: slots.newPhone };
      case "lock_card":
        return { cardId: slots.cardId ?? this.config.defaults.cardId };
      case "report_loss":
        return { cardId: slots.cardId ?? this.config.defaults.cardId };
      case "transfer": {
        const args: Record<string, unknown> = { payee: slots.payee, amountCents: slots.amountCents };
        if (typeof slots.memo === "string") args.memo = slots.memo;
        return args;
      }
      default:
        return {};
    }
  }
}

/** buildConfirm 的返回：契约 + 本次涉及的工具有助于副1 选模板。 */
export interface ConfirmItemContract {
  confirm: ConfirmContract;
  tool: string;
}
