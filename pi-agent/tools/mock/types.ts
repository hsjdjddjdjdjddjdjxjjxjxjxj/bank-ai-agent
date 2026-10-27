/**
 * mock 工具的统一形状。真实接口只保留 adapter 签名（见 README「接真实接口」），
 * 这里每个工具都是同步的假实现，金额一律整数分，绝不返回给用户看的文案。
 */
import type { BankState } from "../../src/state.ts";
import type { ResultContract } from "../../src/contracts.ts";

/** 工具只交付 result.json 结构（task_id 由主执补），不出沙箱。 */
export type ToolOutput = Omit<ResultContract, "task_id">;

export interface MockTool {
  name: string;
  /** 字段/参数校验的事实来源：副2 用它核对 plan.args。 */
  requiredArgs: string[];
  optionalArgs: string[];
  run(args: Record<string, unknown>, state: BankState): ToolOutput;
}

export function toolOk(tool: string, data: Record<string, unknown>, receipt: string | null = null): ToolOutput {
  return { ok: true, tool, receipt, data, error: null };
}

export function toolFail(tool: string, error: string): ToolOutput {
  return { ok: false, tool, receipt: null, data: {}, error };
}

export function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

export function readAmount(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value) ? value : Number.NaN;
}
