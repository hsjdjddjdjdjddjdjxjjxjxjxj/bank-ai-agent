/**
 * 副2 Agent：第二道防线，纯规则复核（格式 + 请求）。
 *
 * 硬约束：
 * - 本文件不 import 传输层、不引任何模型 SDK，副2 永远不调模型（任务包禁止事项 4）。
 * - 只返回 review.json 结构体，不产出用户可见文本。
 * - 每个子任务独立定色校验，不允许整体打包降级（SPEC 1.3）。
 */
import type { PlanContract, ReviewContract, TaskContract, Tier, Violation } from "../contracts.ts";
import { RULE_LABELS, validateContract } from "../contracts.ts";
import type { PermissionConfig } from "../config.ts";
import { levelOfTool, tierCanReach } from "../config.ts";
import { MOCK_TOOLS } from "../../tools/mock/index.ts";

export interface ReviewContext {
  tasks: TaskContract[];
  tier: Tier;
  rejectCount: number;
}

const ALLOWED_RULES: readonly string[] = RULE_LABELS;

export class Fu2 {
  private readonly config: PermissionConfig;

  constructor(config: PermissionConfig) {
    this.config = config;
  }

  /** 环节7：格式复核 + 请求复核。verdict=reject 由编排器驳回上一环节。 */
  review(plan: PlanContract, context: ReviewContext): ReviewContract {
    const violations: Violation[] = [];

    // ——格式：结构（契约 JSON Schema）——
    const structure = validateContract("plan", plan);
    if (!structure.ok) {
      for (const error of structure.errors) {
        violations.push({ rule: "structure", detail: error, step: 0 });
      }
    }

    if (plan.tier !== context.tier) {
      violations.push({
        rule: "structure",
        detail: "plan.tier=" + plan.tier + " 与本次档位 " + context.tier + " 不一致",
        step: 0
      });
    }

    const expectedTaskIds = context.tasks.map((task) => task.task_id);
    if (!expectedTaskIds.includes(plan.task_id)) {
      violations.push({
        rule: "structure",
        detail: "plan.task_id=" + plan.task_id + " 不在本次任务集合内",
        step: 0
      });
    }

    // ——格式：模板（reason_rules 只允许 SPEC 给的 7 个标签）——
    for (const step of plan.plan) {
      for (const label of step.reason_rules) {
        if (!ALLOWED_RULES.includes(label)) {
          violations.push({
            rule: "template",
            detail: "第 " + step.step + " 步的规则标签「" + label + "」不在允许集合内",
            step: step.step
          });
        }
      }
    }

    // ——格式：字段 / 参数——
    for (const step of plan.plan) {
      const meta = MOCK_TOOLS[step.tool];
      if (meta === undefined) {
        violations.push({ rule: "tool-whitelist", detail: "工具 " + step.tool + " 不在白名单", step: step.step });
        continue;
      }
      for (const key of meta.requiredArgs) {
        const value = step.args[key];
        if (value === undefined || value === "") {
          violations.push({
            rule: "args",
            detail: "第 " + step.step + " 步缺少必填参数 " + key,
            step: step.step
          });
        }
      }
      for (const key of Object.keys(step.args)) {
        if (!meta.requiredArgs.includes(key) && !meta.optionalArgs.includes(key)) {
          violations.push({
            rule: "args",
            detail: "第 " + step.step + " 步出现未声明参数 " + key,
            step: step.step
          });
        }
      }
      if (step.tool === "transfer") {
        const amount = step.args.amountCents;
        if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
          violations.push({ rule: "args", detail: "第 " + step.step + " 步转账金额不是正整数分", step: step.step });
        }
        if (typeof amount === "number" && amount > this.config.limits.singleTransferCents) {
          violations.push({
            rule: "single-limit",
            detail: "第 " + step.step + " 步转账金额超过单笔限额 " + (this.config.limits.singleTransferCents / 100).toFixed(2) + " 元",
            step: step.step
          });
        }
      }
      if (step.tool === "update_phone") {
        const phone = step.args.newPhone;
        if (typeof phone !== "string" || !/^1[3-9]\d{9}$/.test(phone)) {
          violations.push({ rule: "args", detail: "第 " + step.step + " 步新手机号格式不合法", step: step.step });
        }
      }
    }

    // ——请求：权限标记与档位/配置是否一致（含「不得降级」）——
    for (const step of plan.plan) {
      const expected = levelOfTool(this.config, step.tool);
      if (expected === undefined) continue;
      if (step.level !== expected) {
        violations.push({
          rule: "permission-mark",
          detail: "第 " + step.step + " 步（" + step.tool + "）权限标记为 " + step.level + "，配置等级是 " + expected + "，不允许降级",
          step: step.step
        });
      }
      if (!tierCanReach(this.config, context.tier, step.level)) {
        violations.push({
          rule: "tier-mark",
          detail: "第 " + step.step + " 步颜色 " + step.level + " 超出档位 " + context.tier + " 的可触达范围",
          step: step.step
        });
      }
      // 子任务不得整体降级：多步计划里每一步都必须等于自己的基础等级
      if (plan.plan.length > 1 && step.level !== expected) {
        violations.push({
          rule: "multi-step-escalate",
          detail: "第 " + step.step + " 步被整体打包降级（多子任务不允许合并定色）",
          step: step.step
        });
      }
    }

    // ——请求：与拆解结果、档位权限是否一致——
    for (const step of plan.plan) {
      const task = context.tasks.find((item) => item.intent === step.tool);
      if (task === undefined) {
        violations.push({
          rule: "request-consistency",
          detail: "第 " + step.step + " 步的工具 " + step.tool + " 不对应任何已拆解任务",
          step: step.step
        });
        continue;
      }
      if (step.tool === "transfer") {
        const payee = step.args.payee;
        const amount = step.args.amountCents;
        if (payee !== task.slots.payee) {
          violations.push({
            rule: "request-consistency",
            detail: "第 " + step.step + " 步收款人与任务槽位不一致",
            step: step.step
          });
        }
        if (amount !== task.slots.amountCents) {
          violations.push({
            rule: "request-consistency",
            detail: "第 " + step.step + " 步金额与任务槽位不一致",
            step: step.step
          });
        }
      }
      if (step.tool === "update_phone" && step.args.newPhone !== task.slots.newPhone) {
        violations.push({
          rule: "request-consistency",
          detail: "第 " + step.step + " 步新手机号与任务槽位不一致",
          step: step.step
        });
      }
    }

    // ——请求：步号必须是 1..n 连续——
    plan.plan.forEach((step, index) => {
      if (step.step !== index + 1) {
        violations.push({
          rule: "structure",
          detail: "第 " + String(index + 1) + " 个位置的步号是 " + String(step.step) + "，不连续",
          step: step.step
        });
      }
    });

    const verdict = violations.length === 0 ? "pass" : "reject";
    return {
      task_id: plan.task_id,
      verdict,
      violations,
      reject_count: context.rejectCount + (verdict === "reject" ? 1 : 0)
    };
  }
}
