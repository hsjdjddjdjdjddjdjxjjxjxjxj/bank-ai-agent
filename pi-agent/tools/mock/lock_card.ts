/** 锁定/解锁卡片：可自助恢复，黄。 */
import type { BankState } from "../../src/state.ts";
import type { MockTool, ToolOutput } from "./types.ts";
import { readString, toolFail, toolOk } from "./types.ts";

export const lockCardTool: MockTool = {
  name: "lock_card",
  requiredArgs: [],
  optionalArgs: ["cardId"],
  run(args: Record<string, unknown>, state: BankState): ToolOutput {
    const requested = readString(args, "cardId");
    const card = requested === "" ? state.cards[0] : state.cards.find((item) => item.id === requested);
    if (card === undefined) return toolFail("lock_card", "卡片不存在");
    if (card.status === "lost") return toolFail("lock_card", "卡片已挂失，无法锁定");
    card.status = card.status === "locked" ? "active" : "locked";
    return toolOk("lock_card", { cardId: card.id, cardLabel: card.label, status: card.status });
  }
};
