/**
 * 消息契约：结构定义在 contracts/*.json（JSON Schema 子集），运行时校验在这里。
 *
 * 硬约束 C4：agent 之间禁止裸字符串传参，一律走下面这 5 个结构体。
 * 副1 是唯一把结构体渲染成中文话术的角色，其余角色只能返回结构体。
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Level = "green" | "yellow" | "red";
export type Tier = "L1" | "L2" | "L3";
export type Verdict = "pass" | "reject";

/** task.json · 副1 → 主执（SPEC §3） */
export interface TaskContract {
  task_id: string;
  session_id: string;
  intent: string;
  slots: Record<string, unknown>;
  missing: string[];
  tier: Tier;
  clarify_rounds: number;
  user_text_hash: string;
}

/** plan.json · 主执 → 副2。子任务各自带权限标记，不允许整体打包降级。 */
export interface PlanStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  level: Level;
  reason_rules: string[];
}

export interface RiskFlag {
  rule: string;
  detail: string;
}

export interface SelfCheck {
  injection: boolean;
  privilege: boolean;
  compliance: boolean;
  passed: boolean;
  detail?: string;
}

export interface PlanContract {
  task_id: string;
  plan: PlanStep[];
  risk_flags: RiskFlag[];
  self_check: SelfCheck;
  tier: Tier;
}

/** review.json · 副2 → 编排器（纯规则复核，不调模型） */
export interface Violation {
  rule: string;
  detail: string;
  step: number;
}

export interface ReviewContract {
  task_id: string;
  verdict: Verdict;
  violations: Violation[];
  reject_count: number;
}

/** confirm.json · 执行层/主执 → 副1。确认要素固定为：对象 / 金额 / 后果。 */
export interface ConfirmItem {
  object: string;
  amount: string;
  consequence: string;
}

export interface ConfirmContract {
  task_id: string;
  level: Level;
  items: ConfirmItem[];
  dual_review_required: boolean;
  expires_at: number;
}

/** result.json · 主执/副3 → 副1。工具原始输出不出沙箱，先包装再给用户。 */
export interface ResultContract {
  task_id: string;
  ok: boolean;
  tool: string;
  receipt: string | null;
  data: Record<string, unknown>;
  error: string | null;
}

export const CONTRACT_NAMES = ["task", "plan", "review", "confirm", "result"] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

export const RULE_LABELS = [
  "base-level",
  "tier-reach",
  "single-limit",
  "irreversible",
  "injection",
  "out-of-domain",
  "multi-step-escalate"
] as const;

// ---------------------------------------------------------------- 契约结构定义

interface JsonSchema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  minimum?: number;
  pattern?: string;
  minItems?: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const schemaCache = new Map<string, JsonSchema>();

export function schemaPath(name: ContractName): string {
  return path.join(HERE, "..", "contracts", name + ".json");
}

/** 读 contracts/*.json。文件缺失直接抛错，不静默降级。 */
export function loadSchema(name: ContractName): JsonSchema {
  const cached = schemaCache.get(name);
  if (cached !== undefined) return cached;
  const raw = readFileSync(schemaPath(name), "utf8");
  const schema = JSON.parse(raw) as JsonSchema;
  schemaCache.set(name, schema);
  return schema;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateNode(schema: JsonSchema, value: unknown, pointer: string, errors: string[]): void {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    errors.push(pointer + ": 期望 " + types.join("|") + "，实际 " + describeValue(value));
    return;
  }
  if (schema.enum !== undefined) {
    const hit = schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value));
    if (!hit) {
      errors.push(pointer + ": 取值不在枚举 " + schema.enum.map((item) => JSON.stringify(item)).join("/") + " 内");
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(pointer + ": 长度小于 " + String(schema.minLength));
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(pointer + ": 不匹配模式 " + schema.pattern);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(pointer + ": 小于最小值 " + String(schema.minimum));
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(pointer + ": 至少 " + String(schema.minItems) + " 项");
    }
    if (schema.items !== undefined) {
      const itemSchema = schema.items;
      value.forEach((item, index) => validateNode(itemSchema, item, pointer + "[" + String(index) + "]", errors));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(pointer + "." + key + ": 必填字段缺失");
    }
    const properties = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in record) validateNode(propSchema, record[key], pointer + "." + key, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(pointer + "." + key + ": 契约未定义的字段");
      }
    }
  }
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** 运行时校验：任何跨角色消息必须先过这里。 */
export function validateContract(name: ContractName, value: unknown): ValidationResult {
  const errors: string[] = [];
  validateNode(loadSchema(name), value, name, errors);
  return { ok: errors.length === 0, errors };
}

export class ContractError extends Error {
  readonly contract: ContractName;
  readonly errors: string[];

  constructor(contract: ContractName, errors: string[]) {
    super(contract + ".json 校验失败：" + errors.join("；"));
    this.name = "ContractError";
    this.contract = contract;
    this.errors = errors;
  }
}

export function assertContract<T>(name: ContractName, value: unknown): T {
  const result = validateContract(name, value);
  if (!result.ok) throw new ContractError(name, result.errors);
  return value as T;
}

/** user_text_hash：只留 16 位十六进制，方便审计对账又不落原文。 */
export function sha256Short(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
