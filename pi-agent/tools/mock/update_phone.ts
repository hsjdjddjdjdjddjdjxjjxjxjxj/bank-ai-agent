/** 修改预留手机号：信息变更，可撤回，黄。 */
import type { BankState, } from "../../src/state.ts";
import { maskPhone } from "../../src/state.ts";
import type { MockTool, ToolOutput } from "./types.ts";
import { readString, toolFail, toolOk } from "./types.ts";

const PHONE = /^1[3-9]\d{9}$/;

export const updatePhoneTool: MockTool = {
  name: "update_phone",
  requiredArgs: ["newPhone"],
  optionalArgs: [],
  run(args: Record<string, unknown>, state: BankState): ToolOutput {
    const newPhone = readString(args, "newPhone");
    if (!PHONE.test(newPhone)) return toolFail("update_phone", "手机号格式不合法");
    const oldPhone = state.phone;
    state.phone = newPhone;
    return toolOk("update_phone", {
      phoneMasked: maskPhone(newPhone),
      oldPhoneMasked: maskPhone(oldPhone)
    });
  }
};
