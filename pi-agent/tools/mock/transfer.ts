/** 转账：资金类，一律红（SPEC 1.8 / flow.png）。不可撤销。 */
import type { BankState } from "../../src/state.ts";
import { yuan } from "../../src/state.ts";
import type { MockTool, ToolOutput } from "./types.ts";
import { readAmount, readString, toolFail, toolOk } from "./types.ts";

function receiptNo(state: BankState): string {
  state.receiptSeq += 1;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return "TR" + day + String(state.receiptSeq).padStart(6, "0");
}

export const transferTool: MockTool = {
  name: "transfer",
  requiredArgs: ["payee", "amountCents"],
  optionalArgs: ["memo"],
  run(args: Record<string, unknown>, state: BankState): ToolOutput {
    const payee = readString(args, "payee");
    const amountCents = readAmount(args, "amountCents");
    if (payee === "") return toolFail("transfer", "缺少收款人");
    if (!Number.isInteger(amountCents) || amountCents <= 0) return toolFail("transfer", "金额必须是正整数分");
    if (amountCents > state.account.availableCents) {
      return toolFail("transfer", "可用余额不足，当前可用 " + yuan(state.account.availableCents) + " 元");
    }
    state.account.availableCents -= amountCents;
    state.account.balanceCents -= amountCents;
    const receipt = receiptNo(state);
    return toolOk("transfer", { payee, amountCents, memo: readString(args, "memo"), receipt }, receipt);
  }
};
