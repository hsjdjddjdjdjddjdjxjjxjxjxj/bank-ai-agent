/** 查账单：只读，带分类聚合与异常交易提示，绿。 */
import type { BankState } from "../../src/state.ts";
import type { MockTool, ToolOutput } from "./types.ts";
import { toolOk } from "./types.ts";

export const billQueryTool: MockTool = {
  name: "bill_query",
  requiredArgs: [],
  optionalArgs: [],
  run(_args: Record<string, unknown>, state: BankState): ToolOutput {
    return toolOk("bill_query", {
      totalCents: state.bills.totalCents,
      categories: state.bills.categories.map((item) => ({ name: item.name, cents: item.cents })),
      anomalies: state.bills.anomalies.map((item) => ({
        merchant: item.merchant,
        cents: item.cents,
        reason: item.reason
      }))
    });
  }
};
