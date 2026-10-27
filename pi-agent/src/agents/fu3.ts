/**
 * 副3 Agent：旁路。只监听，不接管主流程。
 *
 * 职责三段（SPEC 1.4）：
 * 1. 记录：执行日志 / 全链路留痕 / 会话ID / 工具调用 / 授权标记；哈希链可校验。
 * 2. 打破死循环：同类意图重复、驳回次数、工具连续失败，超限 → 强制结束。
 * 3. 异常：捕获后中断并回传副1。
 *
 * 硬约束：本文件不产出任何用户可见文本。熔断只给结构化通知（FuseNotice），
 * 由编排器回传副1 渲染那唯一一条兜底话术（SPEC 1.5-2）。
 */
import { createHash } from "node:crypto";
import type { PermissionConfig } from "../config.ts";
import { redact } from "../state.ts";

export type FuseKind = "same-intent" | "reject-limit" | "tool-failure" | "non-bank-repeat" | "exception";

export interface FuseNotice {
  kind: FuseKind;
  count: number;
  limit: number;
  action: "terminate" | "transfer_human";
  ticket: string;
}

export interface AuditInput {
  sessionId: string;
  text: string;
  tool: string;
  decision: string;
  level: string;
  rules: string[];
  result: string;
}

export interface AuditRecord {
  seq: number;
  ts: string;
  session_id: string;
  user_text_masked: string;
  tool: string;
  decision: string;
  level: string;
  rules: string[];
  result: string;
  prev_hash: string;
  hash: string;
}

export interface CounterState {
  intent_signature: string;
  intent_count: number;
  non_bank_count: number;
  reject_count: number;
  tool_failures: Record<string, number>;
}

export class Fu3 {
  private readonly config: PermissionConfig;
  private readonly records: AuditRecord[] = [];
  private intentSignature = "";
  private sameIntentCount = 0;
  private intentSessionId = "";
  private nonBankCount = 0;
  private nonBankSessionId = "";
  private rejectCount = 0;
  private readonly toolFailures: Record<string, number> = {};

  constructor(config: PermissionConfig) {
    this.config = config;
  }

  /** 记录：哈希链追加。用户原文脱敏后再落盘，卡号/手机号不进日志。 */
  append(input: AuditInput): AuditRecord {
    const seq = this.records.length + 1;
    const prevHash = this.records.length === 0 ? "GENESIS" : this.records[this.records.length - 1].hash;
    const payload = JSON.stringify({
      seq,
      session_id: input.sessionId,
      user_text_masked: redact(input.text),
      tool: input.tool,
      decision: input.decision,
      level: input.level,
      rules: input.rules,
      result: input.result
    });
    const record: AuditRecord = {
      seq,
      ts: new Date().toISOString(),
      session_id: input.sessionId,
      user_text_masked: redact(input.text),
      tool: input.tool,
      decision: input.decision,
      level: input.level,
      rules: input.rules,
      result: input.result,
      prev_hash: prevHash,
      hash: createHash("sha256").update(prevHash + "|" + payload, "utf8").digest("hex")
    };
    this.records.push(record);
    return record;
  }

  /** 死循环计数 1：同类意图连续重复（S8）。按会话隔离，换会话清零。 */
  observeIntent(signature: string, sessionId: string = ""): { count: number; tripped: boolean; limit: number } {
    if (sessionId !== this.intentSessionId) {
      this.intentSessionId = sessionId;
      this.intentSignature = "";
      this.sameIntentCount = 0;
    }
    if (signature === this.intentSignature) {
      this.sameIntentCount += 1;
    } else {
      this.intentSignature = signature;
      this.sameIntentCount = 1;
    }
    const limit = this.config.review.maxSameIntent;
    return { count: this.sameIntentCount, tripped: this.sameIntentCount >= limit, limit };
  }

  /** 死循环计数 1.5：同一会话非业务域请求累计（环节3 否分支『标记多次请求』）。 */
  observeNonBank(sessionId: string): { count: number; tripped: boolean; limit: number } {
    if (sessionId !== this.nonBankSessionId) {
      this.nonBankSessionId = sessionId;
      this.nonBankCount = 0;
    }
    this.nonBankCount += 1;
    const limit = this.config.domain.maxNonBank;
    return { count: this.nonBankCount, tripped: this.nonBankCount >= limit, limit };
  }

  /** 死循环计数 2：副2 驳回次数（S7B）。一次运行开始时清零。 */
  resetRejects(): void {
    this.rejectCount = 0;
  }

  observeReject(): { count: number; tripped: boolean; limit: number } {
    this.rejectCount += 1;
    const limit = this.config.review.maxReject;
    return { count: this.rejectCount, tripped: this.rejectCount >= limit, limit };
  }

  /** 死循环计数 3：同一工具连续失败/超时。 */
  observeTool(tool: string, ok: boolean): { count: number; tripped: boolean; limit: number } {
    const limit = this.config.review.maxToolFailures;
    if (ok) {
      this.toolFailures[tool] = 0;
      return { count: 0, tripped: false, limit };
    }
    const next = (this.toolFailures[tool] ?? 0) + 1;
    this.toolFailures[tool] = next;
    return { count: next, tripped: next >= limit, limit };
  }

  /** 超限：给出结构化熔断通知，不含任何用户话术。 */
  fuse(kind: FuseKind): FuseNotice {
    const limitMap: Record<FuseKind, number> = {
      "same-intent": this.config.review.maxSameIntent,
      "reject-limit": this.config.review.maxReject,
      "tool-failure": this.config.review.maxToolFailures,
      "non-bank-repeat": this.config.domain.maxNonBank,
      exception: 1
    };
    const countMap: Record<FuseKind, number> = {
      "same-intent": this.sameIntentCount,
      "reject-limit": this.rejectCount,
      "tool-failure": Math.max(0, ...Object.values(this.toolFailures)),
      "non-bank-repeat": this.nonBankCount,
      exception: 1
    };
    return {
      kind,
      count: countMap[kind],
      limit: limitMap[kind],
      action: this.config.fallback.transferHuman ? "transfer_human" : "terminate",
      ticket: "HIT-" + String(8600 + this.records.length + 1)
    };
  }

  /** 审计链校验：任何一条被改，后续全部对不上。 */
  verifyChain(): { ok: boolean; total: number; brokenAt: number | null } {
    let prev = "GENESIS";
    for (const record of this.records) {
      const payload = JSON.stringify({
        seq: record.seq,
        session_id: record.session_id,
        user_text_masked: record.user_text_masked,
        tool: record.tool,
        decision: record.decision,
        level: record.level,
        rules: record.rules,
        result: record.result
      });
      const expected = createHash("sha256").update(prev + "|" + payload, "utf8").digest("hex");
      if (record.hash !== expected || record.prev_hash !== prev) {
        return { ok: false, total: this.records.length, brokenAt: record.seq };
      }
      prev = record.hash;
    }
    return { ok: true, total: this.records.length, brokenAt: null };
  }

  list(limit: number = 8): AuditRecord[] {
    return this.records.slice(-limit);
  }

  counters(): CounterState {
    return {
      intent_signature: this.intentSignature,
      intent_count: this.sameIntentCount,
      non_bank_count: this.nonBankCount,
      reject_count: this.rejectCount,
      tool_failures: { ...this.toolFailures }
    };
  }
}
