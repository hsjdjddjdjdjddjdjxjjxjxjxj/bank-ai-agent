/** 卡片挂失：不可撤销，红。线上不允许直接执行，只保留工具给柜面/人脸链路用。 */
import type { BankState } from "../../src/state.ts";
import type { MockTool, ToolOutput } from "./types.ts";
import { readString, toolFail, toolOk } from "./types.ts";

export const reportLossTool: MockTool = {
  name: "report_loss",
  requiredArgs: [],
  optionalArgs: ["cardId"],
  run(args: Record<string, unknown>, state: BankState): ToolOutput {
    const requested = readString(args, "cardId");
    const card = requested === "" ? state.cards[0] : state.cards.find((item) => item.id === requested);
    if (card === undefined) return toolFail("report_loss", "卡片不存在");
    if (card.status === "lost") return toolFail("report_loss", "卡片已挂失");
    card.status = "lost";
    return toolOk("report_loss", { cardId: card.id, cardLabel: card.label, status: card.status });
  }
};
