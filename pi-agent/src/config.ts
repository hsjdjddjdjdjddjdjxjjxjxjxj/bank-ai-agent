/**
 * 配置装载：业务阈值一律从 config/permission.json 读，代码里不写死。
 * 每一条不确定的值在 config 里带 TODO(rule) 标记，装载时汇总成 todoRules。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Level, Tier } from "./contracts.ts";

export interface ToolSpec {
  level: Level;
  reversible: boolean;
  scene: string;
  irreversible: boolean;
}

export interface PermissionConfig {
  version: string;
  tiers: Record<Tier, Level[]>;
  tierRequirements: Record<Level, Tier>;
  tools: Record<string, ToolSpec>;
  requestTypes: Record<string, string>;
  requestTypeLevels: Record<string, Level>;
  defaults: { cardId: string };
  limits: { singleTransferCents: number; redDualReview: boolean };
  confirm: { ttlSeconds: number };
  clarify: { maxRounds: number };
  review: { maxReject: number; maxSameIntent: number; maxToolFailures: number };
  injection: { enabled: boolean; patterns: string[] };
  domain: { maxNonBank: number; nonBankPatterns: string[] };
  selfCheck: { privilegePatterns: string[]; compliancePatterns: string[] };
  fallback: { transferHuman: boolean };
  statsKeyRules: string[];
}

export interface CopyConfig {
  toolLabels: Record<string, string>;
  consequences: Record<string, string>;
  clarify: {
    ask: string;
    join: string;
    hints: Record<string, string>;
    missingLabels: Record<string, string>;
    tooManyRounds: string;
  };
  understand: { notUnderstood: string; nonBank: string };
  reject: { risk: string; tier: string; irreversible: string; illegal: string };
  confirm: { header: string; item: string; askUser: string; dualReview: string; pendingExists: string };
  suspend: { refused: string; cancelled: string };
  result: {
    query_balance: string;
    bill_query: string;
    billAnomaly: string;
    billNoAnomaly: string;
    update_phone: string;
    transfer: string;
    lock_card: string;
    lockStatus: Record<string, string>;
    receipt: string;
    failed: string;
  };
  circuit: { body: string; kinds: Record<string, string> };
  emergency: string;
}

export interface AppConfig {
  permission: PermissionConfig;
  copy: CopyConfig;
  todoRules: string[];
  configDir: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readJson(file: string): Record<string, unknown> {
  const raw = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置不是 JSON 对象：" + file);
  }
  return parsed as Record<string, unknown>;
}

function collectTodos(node: unknown, trail: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectTodos(item, trail + "[" + String(index) + "]", out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("_todo")) {
      if (typeof value === "string") out.push(trail + key + ": " + value);
      else if (Array.isArray(value)) value.forEach((item) => out.push(trail + key + ": " + String(item)));
      continue;
    }
    collectTodos(value, trail + key + ".", out);
  }
}

/** 装载并做最小结构校验：缺字段直接抛错，不静默用默认值。 */
export function loadConfig(configDir?: string): AppConfig {
  const dir = configDir ?? path.join(HERE, "..", "config");
  const permissionRaw = readJson(path.join(dir, "permission.json"));
  const copyRaw = readJson(path.join(dir, "copy.json"));

  const tiers = permissionRaw.tiers as PermissionConfig["tiers"] | undefined;
  if (tiers === undefined || tiers.L1 === undefined || tiers.L2 === undefined || tiers.L3 === undefined) {
    throw new Error("config/permission.json 缺 tiers.L1/L2/L3");
  }
  const tools = permissionRaw.tools as PermissionConfig["tools"] | undefined;
  if (tools === undefined || Object.keys(tools).length === 0) {
    throw new Error("config/permission.json 缺 tools");
  }
  const limits = permissionRaw.limits as PermissionConfig["limits"] | undefined;
  if (limits === undefined || typeof limits.singleTransferCents !== "number") {
    throw new Error("config/permission.json 缺 limits.singleTransferCents");
  }
  const review = permissionRaw.review as PermissionConfig["review"] | undefined;
  if (review === undefined || typeof review.maxReject !== "number") {
    throw new Error("config/permission.json 缺 review.maxReject");
  }
  const defaults = permissionRaw.defaults as PermissionConfig["defaults"] | undefined;
  if (defaults === undefined || typeof defaults.cardId !== "string" || defaults.cardId === "") {
    throw new Error("config/permission.json 缺 defaults.cardId（卡类业务未指明卡时的默认卡，标 TODO(rule)）");
  }

  const permission = permissionRaw as unknown as PermissionConfig;
  const copy = copyRaw as unknown as CopyConfig;
  const todoRules: string[] = [];
  collectTodos(permissionRaw, "", todoRules);
  collectTodos(copyRaw, "", todoRules);

  return { permission, copy, todoRules, configDir: dir };
}

/** 工具的基础等级（权限初判的唯一事实来源）。 */
export function levelOfTool(config: PermissionConfig, tool: string): Level | undefined {
  return config.tools[tool]?.level;
}

/** 档位能不能触达这个颜色。 */
export function tierCanReach(config: PermissionConfig, tier: Tier, level: Level): boolean {
  return config.tiers[tier].includes(level);
}

/** 这个颜色最低需要哪个档位。 */
export function requiredTierFor(config: PermissionConfig, level: Level): Tier {
  return config.tierRequirements[level];
}

/** 请求类型（查询/办理/资金/敏感数据），用于环节 5 的分流说明。 */
export function requestTypeOf(config: PermissionConfig, tool: string): string {
  const scene = config.tools[tool]?.scene;
  if (scene === undefined) return "敏感数据";
  return config.requestTypes[scene] ?? scene;
}

export function toolLabel(copy: CopyConfig, tool: string): string {
  return copy.toolLabels[tool] ?? tool;
}

/** 模板替换：{name} → 值。只认简单占位符，不做表达式。 */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}

/** 配置里的正则串编译成 RegExp；坏正则直接抛错，方便配置评审。 */
export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch (error) {
      throw new Error("配置里的正则不合法：" + pattern + " → " + String(error));
    }
  });
}
