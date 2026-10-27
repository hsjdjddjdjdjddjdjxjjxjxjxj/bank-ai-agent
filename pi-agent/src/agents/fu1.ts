/**
 * 副1 Agent：入口 + 出口。
 *
 * 硬约束：
 * - 本文件是唯一产出用户可见文本的地方（main / fu2 / fu3 只返回结构体）。
 * - 理解以规则为主，模型只做兜底；模型输出必须过工具白名单与参数校验。
 * - 所有用户话术来自 config/copy.json 模板，改文案不改代码。
 * - 档位只在这里（反问颗粒度）和环节5（权限分流）生效，其余环节只做标记（SPEC 1.7）。
 */
import { yuan } from "../state.ts";
import type { ConfirmContract, ResultContract, Tier } from "../contracts.ts";
import type { CopyConfig, PermissionConfig } from "../config.ts";
import { compilePatterns, fmt, levelOfTool, requiredTierFor, toolLabel } from "../config.ts";
import type { ChatMessage, Transport } from "../transport.ts";
import type { FuseNotice } from "./fu3.ts";
import { MOCK_TOOLS } from "../../tools/mock/index.ts";

/** 待补槽位的草稿：反问时暂存，下一轮合并。 */
export interface DraftIntent {
  tool: string;
  slots: Record<string, unknown>;
  missing: string[];
}

export interface IntentParse {
  tool: string;
  slots: Record<string, unknown>;
  missing: string[];
  source: "rule" | "model";
  confidence: number;
}

export interface UnderstandInput {
  text: string;
  tier: Tier;
  clarifyRound: number;
  draft?: DraftIntent | null;
}

export interface UnderstandResult {
  understood: boolean;
  nonBank: boolean;
  intents: IntentParse[];
  missing: string[];
  source: "rule" | "model";
  normalizedText: string;
  tierAnnotation: string;
}

export interface AdmitResult {
  admit: boolean;
  reason: string;
  note: string;
}

export interface Fu1Deps {
  config: PermissionConfig;
  copy: CopyConfig;
  transport: Transport | null;
}

const KNOWN_PAYEES = ["张三", "王五", "小王", "王晓明", "李四", "刘洋"];

/** 归一化：全角转半角、去零宽字符，避免「１３８」这类绕过。 */
export function normalize(text: string): string {
  return text
    .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .trim();
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 中文数字 → 数（五百 / 三千五 / 一万二）。 */
export function cnToNumber(text: string): number | null {
  if (!/^[零一二两三四五六七八九十百千万]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of text) {
    if (char in CN_DIGITS) {
      current = CN_DIGITS[char];
      continue;
    }
    const unit = CN_UNITS[char];
    if (unit === undefined) return null;
    if (unit === 10000) {
      section = (section + current) * unit;
      total += section;
      section = 0;
      current = 0;
      continue;
    }
    section += (current === 0 ? 1 : current) * unit;
    current = 0;
  }
  return total + section + current;
}

/** 金额抽取，返回整数分。先剔手机号与长卡号，避免把号码当金额。 */
export function extractAmount(text: string): number | null {
  const cleaned = text.replace(/1[3-9]\d{9}/g, " ").replace(/\d{12,}/g, " ");
  const wan = cleaned.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wan !== null) return Math.round(Number(wan[1]) * 10000 * 100);
  const qian = cleaned.match(/(\d+(?:\.\d+)?)\s*千/);
  if (qian !== null) return Math.round(Number(qian[1]) * 1000 * 100);
  const arabic = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (arabic !== null) return Math.round(Number(arabic[1]) * 100);
  const cn = cleaned.match(/([零一二两三四五六七八九十百千万]+)\s*(?:元|块|钱)/);
  if (cn !== null) {
    const value = cnToNumber(cn[1]);
    return value === null ? null : value * 100;
  }
  return null;
}

/** 收款人抽取：先认通讯录白名单，再认语法位上的中文名。 */
export function extractPayee(text: string): string | null {
  for (const name of KNOWN_PAYEES) {
    if (text.includes(name)) return name;
  }
  const match = text.match(/(?:转给|打给|给|向)\s*([\u4e00-\u9fa5]{2,4})/);
  if (match === null) return null;
  const candidate = match[1];
  if (/^(我|他|她|您|你|这张|那个)/.test(candidate)) return null;
  return candidate;
}

export function extractPhone(text: string): string | null {
  const match = text.match(/1[3-9]\d{9}/);
  return match === null ? null : match[0];
}

/** 多请求拆段：一句话两业务靠这个分开（S5）。 */
export function splitSegments(text: string): string[] {
  return text
    .split(/[，,；;。]|顺便|同时|另外|并且/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** 单段解析：规则优先。返回 null 表示这段没听懂。 */
export function parseOne(segment: string, defaultCardId: string): IntentParse | null {
  const text = segment;
  if (/(挂失|丢了|丢卡|遗失)/.test(text)) {
    return { tool: "report_loss", slots: { cardId: defaultCardId }, missing: [], source: "rule", confidence: 0.9 };
  }
  if (/(锁卡|锁定|解锁)/.test(text) && /卡/.test(text)) {
    return { tool: "lock_card", slots: { cardId: defaultCardId }, missing: [], source: "rule", confidence: 0.9 };
  }
  if (/(手机号|预留号码|联系方式|电话号码)/.test(text) && /(改|换|变更|更新)/.test(text)) {
    const newPhone = extractPhone(text);
    const slots: Record<string, unknown> = {};
    if (newPhone !== null) slots.newPhone = newPhone;
    return {
      tool: "update_phone",
      slots,
      missing: newPhone === null ? ["newPhone"] : [],
      source: "rule",
      confidence: newPhone === null ? 0.8 : 0.95
    };
  }
  if (/(余额|还有多少钱|可用额度|活期)/.test(text)) {
    return { tool: "query_balance", slots: {}, missing: [], source: "rule", confidence: 0.95 };
  }
  if (/(账单|花超|消费|花了|支出|开销|话费)/.test(text)) {
    return { tool: "bill_query", slots: {}, missing: [], source: "rule", confidence: 0.95 };
  }
  if (/(转|汇|打款)/.test(text)) {
    const payee = extractPayee(text);
    const amount = extractAmount(text);
    const slots: Record<string, unknown> = {};
    if (payee !== null) slots.payee = payee;
    if (amount !== null) slots.amountCents = amount;
    const memo = text.match(/备注\s*([^\s，,。]+)/);
    if (memo !== null) slots.memo = memo[1];
    const missing: string[] = [];
    if (payee === null) missing.push("payee");
    if (amount === null) missing.push("amountCents");
    return { tool: "transfer", slots, missing, source: "rule", confidence: missing.length === 0 ? 0.95 : 0.8 };
  }
  return null;
}

/** 一句话拆成多意图，按出现顺序去重。 */
export function parseIntents(text: string, defaultCardId: string): IntentParse[] {
  const segments = splitSegments(text);
  const found: IntentParse[] = [];
  for (const segment of segments) {
    const one = parseOne(segment, defaultCardId);
    if (one !== null && !found.some((item) => item.tool === one.tool)) found.push(one);
  }
  if (found.length === 0) {
    const whole = parseOne(text, defaultCardId);
    if (whole !== null) found.push(whole);
  }
  return found;
}

/** 草稿合并：用户补「给张三」这种残句时，把槽位并回上一轮草稿。 */
function mergeDraft(draft: DraftIntent, text: string): IntentParse | null {
  const slots: Record<string, unknown> = { ...draft.slots };
  let changed = false;
  if (draft.missing.includes("payee")) {
    const payee = extractPayee(text);
    if (payee !== null) {
      slots.payee = payee;
      changed = true;
    }
  }
  if (draft.missing.includes("amountCents")) {
    const amount = extractAmount(text);
    if (amount !== null) {
      slots.amountCents = amount;
      changed = true;
    }
  }
  if (draft.missing.includes("newPhone")) {
    const phone = extractPhone(text);
    if (phone !== null) {
      slots.newPhone = phone;
      changed = true;
    }
  }
  if (!changed) return null;
  const missing = draft.missing.filter((key) => {
    const value = slots[key];
    return value === undefined || value === "";
  });
  return { tool: draft.tool, slots, missing, source: "rule", confidence: 0.9 };
}

function dataNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === "number" ? value : 0;
}

function dataString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

export class Fu1 {
  private readonly config: PermissionConfig;
  private readonly copy: CopyConfig;
  private readonly transport: Transport | null;
  private readonly nonBankPatterns: RegExp[];

  constructor(deps: Fu1Deps) {
    this.config = deps.config;
    this.copy = deps.copy;
    this.transport = deps.transport;
    this.nonBankPatterns = compilePatterns(deps.config.domain.nonBankPatterns);
  }

  /** 理解：规则 → 草稿合并 → 模型兜底。 */
  async understand(input: UnderstandInput): Promise<UnderstandResult> {
    const text = normalize(input.text);
    let intents = parseIntents(text, this.config.defaults.cardId);
    let source: "rule" | "model" = "rule";

    const draft = input.draft ?? null;
    if (draft !== null && intents.length === 0) {
      const merged = mergeDraft(draft, text);
      if (merged !== null) intents = [merged];
    }
    if (intents.length === 0) {
      const fromModel = await this.askModel(text);
      if (fromModel !== null) {
        intents = [fromModel];
        source = "model";
      }
    }

    const nonBank = intents.length === 0 && this.nonBankPatterns.some((pattern) => pattern.test(text));
    const understood = intents.length > 0 || nonBank;
    const missing: string[] = [];
    for (const intent of intents) {
      for (const key of intent.missing) {
        if (!missing.includes(key)) missing.push(key);
      }
    }
    const tierAnnotation = input.tier === "L1"
      ? "档位 " + input.tier + "：反问一次只问一个要素"
      : "档位 " + input.tier + "：反问一次问全部缺失要素";

    return {
      understood,
      nonBank,
      intents,
      missing,
      source,
      normalizedText: text,
      tierAnnotation
    };
  }

  /** 环节2 的「按档位判断是否放行」。颜色可达性归环节5，这里只挡敏感数据类请求。 */
  admit(result: UnderstandResult, tier: Tier): AdmitResult {
    if (!result.understood) {
      return { admit: false, reason: "not-understood", note: "没理解用户说了什么" };
    }
    if (result.nonBank) {
      return { admit: true, reason: "", note: "非业务域请求，交环节3判定" };
    }
    const sensitive = result.intents.some((intent) => this.config.requestTypeLevels[this.requestType(intent.tool)] === "red"
      && this.config.tools[intent.tool]?.scene === "敏感数据");
    if (sensitive && tier === "L1") {
      return { admit: false, reason: "tier-scope", note: "L1 不得发起敏感数据类请求" };
    }
    return { admit: true, reason: "", note: "放行至环节3；" + result.tierAnnotation };
  }

  /** 档位决定反问颗粒度（SPEC 1.7）。 */
  clarifySlots(tier: Tier, missing: string[]): string[] {
    if (missing.length === 0) return [];
    return tier === "L1" ? missing.slice(0, 1) : missing;
  }

  /** 请求类型（查询/办理/资金/敏感数据）。 */
  requestType(tool: string): string {
    const scene = this.config.tools[tool]?.scene;
    if (scene === undefined) return "敏感数据";
    return this.config.requestTypes[scene] ?? scene;
  }

  private async askModel(text: string): Promise<IntentParse | null> {
    const transport = this.transport;
    if (transport === null || !transport.available) return null;
    const tools = Object.keys(this.config.tools).map((name) => ({
      name,
      description: toolLabel(this.copy, name) + "（" + this.config.tools[name].scene + "，基础等级 " + this.config.tools[name].level + "）",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: true }
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: "你是银行智能体的意图解析器。只调用一个工具，金额用整数分，手机号用 11 位字符串。判断不了就调用 unknown。" },
      { role: "user", content: text }
    ];
    try {
      const reply = await transport.complete(messages, tools);
      const call = reply.toolCalls[0];
      if (call === undefined) return null;
      const tool = call.name;
      if (this.config.tools[tool] === undefined) return null;
      const spec = MOCK_TOOLS[tool];
      if (spec === undefined) return null;
      let slots: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.arguments);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          slots = parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
      const missing = spec.requiredArgs.filter((key) => slots[key] === undefined);
      return { tool, slots, missing, source: "model", confidence: 0.9 };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ 话术渲染（唯一出口）

  renderClarify(input: { tier: Tier; missing: string[]; round: number }): string {
    const asked = this.clarifySlots(input.tier, input.missing);
    const labels = asked.map((key) => this.copy.clarify.missingLabels[key] ?? key);
    const hint = asked.map((key) => this.copy.clarify.hints[key] ?? "").filter((item) => item !== "").join(" ");
    return fmt(this.copy.clarify.ask, {
      supplement: labels.join(this.copy.clarify.join),
      hint
    });
  }

  renderClarifyExhausted(input: { round: number }): string {
    return fmt(this.copy.clarify.tooManyRounds, { rounds: input.round });
  }

  renderNotUnderstood(): string {
    return this.copy.understand.notUnderstood;
  }

  renderNonBank(): string {
    return this.copy.understand.nonBank;
  }

  renderRiskRefusal(): string {
    return this.copy.reject.risk;
  }

  renderTierDenied(input: { tool: string; tier: Tier }): string {
    const level = levelOfTool(this.config, input.tool) ?? "red";
    const required = requiredTierFor(this.config, level);
    return fmt(this.copy.reject.tier, {
      toolLabel: toolLabel(this.copy, input.tool),
      requiredTier: this.config.tierLabels[required] ?? required,
      tier: this.config.tierLabels[input.tier] ?? input.tier
    });
  }

  renderIrreversible(input: { tool: string }): string {
    return fmt(this.copy.reject.irreversible, { toolLabel: toolLabel(this.copy, input.tool) });
  }

  renderIllegal(input: { reason: string }): string {
    return fmt(this.copy.reject.illegal, { reason: input.reason });
  }

  renderPendingExists(): string {
    return this.copy.confirm.pendingExists;
  }

  renderConfirm(input: { confirm: ConfirmContract; tool: string }): string {
    const header = fmt(this.copy.confirm.header, { toolLabel: toolLabel(this.copy, input.tool) });
    const items = input.confirm.items.map((item, index) => fmt(this.copy.confirm.item, {
      index: index + 1,
      object: item.object,
      amount: item.amount,
      consequence: item.consequence
    }));
    const ttl = Math.max(0, Math.round((input.confirm.expires_at - Date.now()) / 1000));
    const ask = fmt(this.copy.confirm.askUser, { ttl });
    const lines = [header, ...items, ask];
    if (input.confirm.dual_review_required) lines.push(this.copy.confirm.dualReview);
    return lines.join("\n");
  }

  renderDualReviewAsk(input: { confirm: ConfirmContract }): string {
    const items = input.confirm.items.map((item) => item.object + " / " + item.amount).join("；");
    return this.copy.confirm.dualReview + "\n待复核要素：" + items;
  }

  renderSuspended(input: { tool: string }): string {
    return fmt(this.copy.suspend.refused, { toolLabel: toolLabel(this.copy, input.tool) });
  }

  renderCancelled(): string {
    return this.copy.suspend.cancelled;
  }

  renderNoPending(): string {
    return this.copy.suspend.noPending;
  }

  /** 确认令牌过期：按 config.confirm.ttlSeconds 到期作废（SPEC 环节8 确认请求带 expires_at）。 */
  renderExpired(input: { ttlSeconds: number }): string {
    return fmt(this.copy.suspend.expired, { ttl: input.ttlSeconds });
  }

  /** 结果包装：工具原始输出必须经这里才可见（环节9）。 */
  renderResults(input: { results: ResultContract[] }): string {
    const lines = input.results.map((result) => this.renderOneResult(result));
    return lines.join("\n");
  }

  private renderOneResult(result: ResultContract): string {
    const tool = result.tool;
    const label = toolLabel(this.copy, tool);
    if (!result.ok) {
      return fmt(this.copy.result.failed, { toolLabel: label, reason: result.error ?? "未知原因" });
    }
    const data = result.data;
    if (tool === "query_balance") {
      return fmt(this.copy.result.query_balance, {
        available: yuan(dataNumber(data, "availableCents")),
        balance: yuan(dataNumber(data, "balanceCents"))
      });
    }
    if (tool === "bill_query") {
      const total = dataNumber(data, "totalCents");
      const rawCategories = Array.isArray(data.categories) ? data.categories : [];
      const categories = rawCategories.map((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        const cents = dataNumber(record, "cents");
        const percent = total === 0 ? 0 : Math.round((cents / total) * 100);
        return dataString(record, "name") + " " + yuan(cents) + " 元（" + String(percent) + "%）";
      }).join("、");
      const rawAnomalies = Array.isArray(data.anomalies) ? data.anomalies : [];
      const anomalyText = rawAnomalies.length === 0
        ? this.copy.result.billNoAnomaly
        : rawAnomalies.map((item) => {
          const record = (item ?? {}) as Record<string, unknown>;
          return fmt(this.copy.result.billAnomaly, {
            merchant: dataString(record, "merchant"),
            amount: yuan(dataNumber(record, "cents")),
            reason: dataString(record, "reason")
          });
        }).join("");
      return fmt(this.copy.result.bill_query, { total: yuan(total), categories, anomalyText });
    }
    if (tool === "update_phone") {
      return fmt(this.copy.result.update_phone, { phone: dataString(data, "phoneMasked") });
    }
    if (tool === "transfer") {
      const receipt = result.receipt === null ? "" : fmt(this.copy.result.receipt, { receipt: result.receipt });
      return fmt(this.copy.result.transfer, {
        payee: dataString(data, "payee"),
        amount: yuan(dataNumber(data, "amountCents")),
        receiptText: receipt
      });
    }
    if (tool === "lock_card") {
      const status = dataString(data, "status");
      return fmt(this.copy.result.lock_card, {
        cardLabel: dataString(data, "cardLabel"),
        statusText: this.copy.result.lockStatus[status] ?? status
      });
    }
    return fmt(this.copy.result.failed, { toolLabel: label, reason: "该工具没有包装模板" });
  }

  /** 副3 熔断时回传副1，由副1 说这唯一一条。 */
  renderCircuitBreak(notice: FuseNotice): string {
    const kindKey = notice.kind;
    const template = this.copy.circuit.kinds[kindKey] ?? this.copy.circuit.kinds.exception;
    const kindText = fmt(template, { count: notice.count });
    return fmt(this.copy.circuit.body, { kindText, ticket: notice.ticket });
  }

  /** 结果包装前的兜底：渲染一行执行失败说明（仍由副1 说）。 */
  renderExecutionFailure(input: { tool: string; error: string }): string {
    return fmt(this.copy.result.failed, {
      toolLabel: toolLabel(this.copy, input.tool),
      reason: input.error
    });
  }
}

/**
 * 副1 完全不可用时的单条兜底（SPEC 1.6-3 / 1.5-3）。
 * 仍然由副1 模块产出文本，只是不经过实例；副3 只负责给出结构化的熔断通知。
 * 只发这一条，不承接多轮。
 */
export function backupEmergencyLine(copy: CopyConfig, ticket: string): string {
  return fmt(copy.emergency, { ticket });
}
