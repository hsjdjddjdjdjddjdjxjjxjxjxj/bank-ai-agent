# Pi 参照实现 · 银行 AI 智能体（pi-agent/）

> 对应 `..\SPEC_实现规格.md` 第 6 节。零依赖、工具全 mock、Node 24 原生跑 TypeScript。
> 流程拓扑的唯一事实来源是 `..\流程图_全链路.png`，本目录只做代码落地，不改 9 环节与三次分叉。

> **口径说明**：本目录是引擎参照实现。CLI 里的 L2 / L3 是**内部账户权限**（演示账户），不是网页首屏的「沟通风格」；S4B（受限账户）只在本 CLI 保留，用于验证权限矩阵。网页演示的账户固定为全功能，用户只选沟通风格。

## 1. 结论先说

- 9 环节状态机、三次分叉、驳回回退（7→6，上限 2 次）、黄/红挂起-确认-取消、多步任务、副3 三类熔断，全部可跑。
- 副1 是唯一用户出口：`src/agents/fu1.ts` 之外没有任何角色渲染中文话术（`run_demo.ts` 打印的 userText 全部来自 fu1 的 `render*`）。
- 副2 是纯规则复核：`src/agents/fu2.ts` 不 import 传输层、不引任何模型 SDK，`run_demo.ts` 自检 [2] 会扫源码给证据。
- 业务阈值全部来自 `config/permission.json` / `config/copy.json`，配置里逐条标 `TODO(rule)`（共 22 条），代码里没有散落魔法数。
- `node run_demo.ts` 一次跑 15 条场景（SPEC §4 全部 14 条 + 1 条非业务域边界），退出码 0。

## 2. 怎么跑

环境：Node.js 24（本机 `v24.21.0` 实测）。**不需要 `npm install`，不联网**。

```powershell
cd pi-agent        # 在交付根目录下执行

node run_demo.ts          # 全部 15 条场景 + 6 项自检
node run_demo.ts S4       # 只跑指定场景（可多个：S4 S7B s8，ID 大小写不敏感）
node run_demo.ts --help   # 打印用法后退出；未知 ID 会提示可用 ID 并返回退出码 1
```

每条场景打印 6 行结构化结果：环节轨迹 / 判定颜色+命中规则 / 副1 话术（逐轮）/ 契约流转 / 是否执行或挂起 / 审计 seq+hash。
全量运行末尾是 6 项可执行自检与审计链校验结果；筛选运行只打印所选场景 + 汇总。

预期结尾：

```text
汇总：15 条场景跑完；审计链 46 条记录，哈希校验通过
```

> 目录里的 `demo-output.txt` 是上一次全量运行的输出留档，便于对照；重新生成：
> `node run_demo.ts > demo-output.txt`（PowerShell）。
> 含故障注入的 S7 / S7B 会在轨迹里标 `7·注入故障(演示)`，并在「故障注入」一行与契约流转里注明「注入故障构造，非真实违规」。

## 3. 怎么接本地 vLLM / OpenAI 兼容端点

模型只用于**副1 理解兜底**（规则解析失败时才问模型），不配 key 就整条链路走规则模式。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI 兼容 baseUrl，末尾不用带 `/chat/completions` |
| `PI_API_KEY` | 空 | 空 = offline 规则模式；vLLM 可填 `EMPTY` |
| `PI_MODEL` | `qwen2.5-7b-instruct` | 服务端模型名（vLLM 的 `--served-model-name`） |
| `PI_TIMEOUT_MS` | `20000` | 单次请求超时 |
| `PI_OFFLINE` | 空 | 填 `1` 强制离线，即使配了 key |

本地 vLLM 示例：

```bash
vllm serve Qwen/Qwen2.5-7B-Instruct --served-model-name qwen2.5-7b-instruct --port 8000
```

```powershell
cd pi-agent        # 在交付根目录下执行
$env:PI_BASE_URL="http://127.0.0.1:8000/v1"
$env:PI_API_KEY="EMPTY"
$env:PI_MODEL="qwen2.5-7b-instruct"
node run_demo.ts
```

换成云端 OpenAI 协议端点同理，只改 `PI_BASE_URL` / `PI_API_KEY` / `PI_MODEL` 三个变量。
adapter 在 `src/transport.ts`，只用 `fetch`，没有 SDK 依赖；接口是 `Transport.complete(messages, tools)`。

> 模型返回的工具名必须过配置白名单，参数要能 JSON 解析，否则 `fu1` 直接丢弃（`src/agents/fu1.ts` 的 `askModel`）。

## 4. 目录说明

```text
pi-agent/
├─ run_demo.ts                  # 15 条场景驱动 + 自检，唯一入口
├─ package.json                 # 仅声明 type=module，无任何依赖（不需要 npm install）
├─ config/
│  ├─ permission.json           # 档位 / 工具三色 / 限额 / 轮次上限 / 注入与自检特征（全部 TODO(rule)）
│  └─ copy.json                 # 全部用户可见话术模板（改文案不改代码）
├─ contracts/
│  ├─ task.json plan.json review.json confirm.json result.json
│  └─ （JSON Schema 子集，运行时由 src/contracts.ts 校验）
├─ src/
│  ├─ orchestrator.ts           # 9 环节状态机 + 三次分叉 + 驳回回退 + 挂起/确认/取消 + 熔断
│  ├─ contracts.ts              # 契约类型 + 运行时校验 + user_text_hash
│  ├─ config.ts                 # 配置装载、TODO(rule) 汇总、模板渲染 fmt()
│  ├─ state.ts                  # 合成账本 + 金额整数分 + 手机号/卡号脱敏
│  ├─ transport.ts              # OpenAI 兼容 adapter，无 key 走 offline
│  └─ agents/
│     ├─ fu1.ts                 # 唯一用户出口：理解/反问/放行/确认询问/结果包装/兜底
│     ├─ main.ts                # 业务域判断/风险自检/权限初判/拆解合法性/执行（只返回结构体）
│     ├─ fu2.ts                 # 纯规则复核（结构/字段/参数/模板/权限标记/请求一致性）
│     └─ fu3.ts                 # 旁路：审计哈希链 + 三类死循环计数 + 熔断通知（无话术）
└─ tools/mock/
   ├─ query_balance.ts bill_query.ts update_phone.ts transfer.ts lock_card.ts report_loss.ts
   ├─ index.ts                 # mock 工具注册表（真实接口在这里换 adapter）
   └─ types.ts                 # 工具统一形状：只回 result.json 结构，不出沙箱
```

## 5. 9 环节 ↔ 代码位置

| 环节 | 动作 | 代码 |
|---|---|---|
| 1 | 交互入口（档位 + 文本；TTS 不在本实现范围） | `orchestrator.run()` 里的 `mark(ctx, 1, ...)` |
| 2 | 副1 理解 → 反问补槽 → 按档位放行 | `Fu1.understand` / `Fu1.admit` / `Fu1.renderClarify` |
| 3 | 主执业务相关性 | `Main.domainCheck` |
| 4 | 主执自检（注入/越权/合规） | `Main.selfCheck` |
| 5 | 权限初判三色 | `Main.initialLevel`（base-level / irreversible / tier-reach） |
| 6 | 拆解与合法性 | `Main.decompose`（single-limit / args-invalid / tool-whitelist） |
| 7 | 副2 复核 | `Fu2.review` → `verdict pass|reject` |
| 8 | 执行 / 黄红确认 / 双人复核 | `Orchestrator.advance` → `main.buildConfirm` → `fu1.renderConfirm` → `orchestrator.confirm/dualReview` |
| 9 | 记录 → 回传副1 → 用户 | `orchestrator.finishCompleted`：`fu3.append`（审计）→ `fu1.renderResults` |

三次分叉：

- 初判三色（环节5）：绿→直通 / 黄→确认 / 红→强控，颜色由「工具基础等级 + 档位可达性 + 不可逆」决定。
- 复核后二次分流（环节7 后）：每个子任务独立定色，`Fu2` 校验 `step.level === config.tools[tool].level`，降级即驳回。
- 回退：7→6（驳回重做，`maxReject=2`）、6/5/4/3/2→副1（拒绝/终止，本轮结束）。

## 6. 挂起 / 确认 / 取消（环节8）

```ts
const turn = await engine.run({ text: "转 500 给张三", tier: "L3", sessionId });
// status=need_confirm：黄/红挂起，userText 是 fu1 渲染的确认要素（对象/金额/后果）
const next = engine.confirm("agree" | "refuse" | "cancel", sessionId);
// 红级：confirm 后 status=need_dual_review，需要第二把钥匙
const done = engine.dualReview("approve" | "deny", sessionId);
```

- 拒绝：任务进入 `suspended`，不执行；之后仍可 `confirm("agree")` 恢复，或 `cancel()` 终止。
- 取消：清空 `pending`，`status=cancelled`，不执行、不留待办。
- 超时：`confirm.json` 带 `expires_at`（`config.confirm.ttlSeconds`），过期后确认/复核直接作废。

## 7. 角色边界（唯一出口不变式）

1. `main` / `fu2` / `fu3` 的返回值只能是结构体或结构体的字段，**没有任何 `render` / 话术方法**；`fu3.fuse()` 只回 `FuseNotice`。
2. 编排器不写文案，所有 `userText` 都来自 `Fu1.renderXxx()`；连「没有待确认任务」这种兜底也走 `Fu1.renderNoPending()`。
3. 副1 不可用（`orchestrator.setFu1Available(false)`）：只发一条 `backupEmergencyLine()`（仍在 `fu1.ts` 里）+ 转人工，不承接多轮；`run_demo.ts` 自检 [4] 有实证。
4. 工具原始输出（`tools/mock/*` 的 `data/receipt/error`）必须先被 `Fu1.renderResults()` 包装，才可能出现在用户面前。

## 8. 消息契约（禁止裸字符串）

`contracts/*.json` 是 JSON Schema 子集（type / required / properties / enum / items / pattern / additionalProperties），`src/contracts.ts` 在运行时逐条校验；校验失败抛 `ContractError`，编排器按异常熔断（副3 记录 + 副1 单条兜底）。

| 契约 | 方向 | 关键字段 |
|---|---|---|
| `task.json` | 副1 → 主执 | task_id / session_id / intent / slots / missing / tier / clarify_rounds / user_text_hash |
| `plan.json` | 主执 → 副2 | task_id / plan[{step,tool,args,level,reason_rules}] / risk_flags / self_check / tier |
| `review.json` | 副2 → 编排器 | task_id / verdict / violations[{rule,detail,step}] / reject_count |
| `confirm.json` | 执行层 → 副1 | task_id / level / items[{object,amount,consequence}] / dual_review_required / expires_at |
| `result.json` | 主执/副3 → 副1 | task_id / ok / tool / receipt / data / error |

`reason_rules` 的取值被契约限定为 SPEC §2 的 7 个标签：`base-level` / `tier-reach` / `single-limit` / `irreversible` / `injection` / `out-of-domain` / `multi-step-escalate`。

## 9. 配置与 TODO(rule)

- `config/permission.json`：`tiers`、`tools`（颜色/可逆/场景/不可逆）、`limits.singleTransferCents`、`limits.redDualReview`、`clarify.maxRounds`、`review.maxReject`、`review.maxSameIntent`、`review.maxToolFailures`、`confirm.ttlSeconds`、`injection.patterns`、`domain.nonBankPatterns`、`domain.maxNonBank`、`selfCheck.privilegePatterns`、`selfCheck.compliancePatterns`。
- `config/copy.json`：全部用户话术与业务后果描述，改文案不用改代码。
- 所有 `_todo` 字段由 `src/config.ts` 汇总成 `todoRules`（22 条），`run_demo.ts` 自检 [6] 会打印总数，与 `交付/assumptions.md` 一一对应。

### 我替你做主的取值（与 assumptions 对应）

| 项 | 取值 | 理由 |
|---|---|---|
| 反问轮次上限 | 3 | 任务包示例值；L1 一次只问一个要素，L2/L3 一次问全 |
| 副2 驳回上限 | 2 | SPEC 1.6 建议 2；第 2 次即副3 熔断（S7B） |
| 同类意图熔断 | 3 | SPEC S8「≥3」 |
| 工具连续失败熔断 | 2 | 图只写「连续失败」，次数自定 |
| 非业务域重复上限 | 2 | 环节3 否分支「标记多次请求」未给次数；达到上限交副3 熔断（`domain.maxNonBank`） |
| 单笔转账限额 | 5000.00 元（500000 分） | 图未定义，演示取值，S4C 用它构造限额拒绝 |
| 确认有效期 | 120 秒 | 图未定义 |
| 双人复核 | 开（`limits.redDualReview`） | SPEC 1.8 红=强确认+双人复核 |

## 10. 事件回调（给网页/评测用）

```ts
const engine = new Orchestrator({
  config: loadConfig(),
  transport: createTransport(readTransportSettings()),
  onEvent: (event) => {
    // event = { stage: 1..9 | 0, kind: "enter"|"fork"|"rollback"|"note"|"suspend"|"resume"|"audit", label, detail, at }
  }
});
```

`stage=0` 是旁路事件（副3 计数/记录/熔断）。`run_demo.ts` 的环节轨迹就是把 `enter` 事件按 `stage + label` 拼起来。

## 11. 接真实工具

`tools/mock/types.ts` 定义了 `MockTool` 形状：`{ name, requiredArgs, optionalArgs, run(args, state) }`，`run` 只能回 `result.json` 结构。
接真实接口时：

1. 在 `tools/` 下新建 `real/xxx.ts`，实现同一个 `MockTool` 接口（内部换成 HTTP/行内 SDK）。
2. 在 `tools/mock/index.ts` 的注册表里把 `MOCK_TOOLS[name]` 换成真实实现；`tool` 名字与 `requiredArgs` 不变。
3. `main.executeStep` 与 `fu2.review` 都读注册表，权限与字段校验自动跟上，不用改编排。

真实接口的鉴权、超时、重试、幂等键应在真实实现里做；本目录只保留 adapter 签名。

## 12. 已知偏差与边界（逐条，别当生产用）

1. **S9 档位**：原表写 L2，与 S4B「L2 转账必红不可达」冲突；SPEC 已同步为 L3，本实现与 SPEC 一致（按 L2 走会在环节5 被拒）。
2. **风险输入跳过反问**：命中注入/越权/合规的句子在环节2 不追问槽位，直接进环节3/4（不向攻击者索要参数）。轨迹里会多一个 `2·风险输入跳过反问` 节点；S6 因此拿到「4 自检命中注入」的路径。
3. **S7 的注入位置**：SPEC 写「第 2 步权限标记被降级」，但该场景计划只有 1 步，演示注入把唯一一步由红降黄，副2 照样抓 `permission-mark` 降级。`run_demo.ts` 会把注入单独标成 `7·注入故障(演示)`，契约摘要写「注入故障版 / 非真实违规」，与真实业务违规分开。
4. **副1 的档位放行**按 SPEC 1.7 只做两件事：决定反问颗粒度、挡 L1 的敏感数据类请求。颜色可达性由环节5 权威判定（S4B 才能拿到「5红·档位不可达」）。
5. **环节3 否分支的「多次请求」**：同一会话累计非业务域请求，达到 `domain.maxNonBank`（2 次）后交副3 熔断 `non-bank-repeat`（单条兜底+转人工）；未达上限仍是「转交副1 委婉终止本轮」。EX1 演示了这个两轮过程。
6. **双人复核由演示脚本模拟**（`dualReview("approve")`），真实系统要接柜面/风控席人工授权，不能由同一个用户点两下。
7. **会话与审计在进程内存**：重启丢失，审计链只能证明链内未被篡改，未接日志平台/WORM。
8. **TTS 未实现**：环节1 只做档位 + 文本录入，语音入口留接口位置（`run()` 的 `text`）。
9. **工具连续失败熔断**已实现并自检，但示例账本里没有构造「连续失败」场景（单笔限额先拦住了大额）。
10. **意图解析是演示级规则**：中文金额/收款人/手机号/挂失等有限说法，复杂表达靠模型兜底；模型兜底也可能给出非法工具名，会被白名单直接丢弃。

## 13. 自检证据（`node run_demo.ts` 末尾）

- `[1]` 契约运行时校验：故意传残缺 task，`assertContract` 抛 `ContractError` 并列出缺失字段。
- `[2]` 副2 不调模型：扫描 `fu2.ts` 源码中的 `transport.ts` / `pi-ai` / `fetch(` / `.complete(` / `openai`，应为 0 处。
- `[3]` 副3 四类熔断计数：同类意图、驳回、工具连续失败、非业务域重复达到配置上限都触发。
- `[4]` 副1 不可用：单条兜底 + 转人工，不承接多轮。
- `[5]` 日志脱敏：审计里手机号写作 `138****8000`。
- `[6]` TODO(rule) 汇总条数与示例。

## 14. 不做什么

- 不引 LangGraph / CrewAI / AutoGen，也不装任何 npm 包；编排就是 `src/orchestrator.ts` 的一个状态机。
- 不接真实银行接口、不落数据库、不做登录态；所有数据在 `src/state.ts` 里是合成的。
- 不允许副2 调模型做「LLM-as-judge」；副2 只看结构、字段、参数、模板、权限标记与请求一致性。
- 不在 README 里写「生产可用 / 已上线」：这是可跑通的参照实现，不是生产系统。