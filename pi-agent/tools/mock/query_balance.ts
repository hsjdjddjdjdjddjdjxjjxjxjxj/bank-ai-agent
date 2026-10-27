/** 查询余额：只读，无资金变动，绿。 */
import type { BankState } from "../../src/state.ts";
import type { MockTool, ToolOutput } from "./types.ts";
import { toolOk } from "./types.ts";

export const queryBalanceTool: MockTool = {
  name: "query_balance",
  requiredArgs: [],
  optionalArgs: [],
  run(_args: Record<string, unknown>, state: BankState): ToolOutput {
    return toolOk("query_balance", {
      availableCents: state.account.availableCents,
      balanceCents: state.account.balanceCents
    });
  }
};
