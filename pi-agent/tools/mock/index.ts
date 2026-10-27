/** mock 工具注册表。真实接口换成 adapter 实现即可，工具名与参数不变。 */
import type { MockTool } from "./types.ts";
import { queryBalanceTool } from "./query_balance.ts";
import { billQueryTool } from "./bill_query.ts";
import { updatePhoneTool } from "./update_phone.ts";
import { transferTool } from "./transfer.ts";
import { lockCardTool } from "./lock_card.ts";
import { reportLossTool } from "./report_loss.ts";

export const MOCK_TOOLS: Record<string, MockTool> = {
  query_balance: queryBalanceTool,
  bill_query: billQueryTool,
  update_phone: updatePhoneTool,
  transfer: transferTool,
  lock_card: lockCardTool,
  report_loss: reportLossTool
};

export function getTool(name: string): MockTool | undefined {
  return MOCK_TOOLS[name];
}

export function toolNames(): string[] {
  return Object.keys(MOCK_TOOLS);
}

export type { MockTool, ToolOutput } from "./types.ts";
