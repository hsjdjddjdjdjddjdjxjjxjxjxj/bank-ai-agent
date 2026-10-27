# 网页演示源码（可读可改）

演示主件 `银行智能体_演示.html` 是**从本目录构建出来的单文件**（内联 CSS/JS，零依赖，双击可开）。

## 构建

```powershell
cd 网页源码
node build.mjs
```

会把 `index.template.html` + `styles.css` + `engine.js` + `ui.js` 内联，重新生成上一级的
`银行智能体_演示.html`。

## 文件

| 文件 | 作用 |
|---|---|
| `engine.js` | 纯逻辑引擎：9 环节状态机、四角色、三色权限、驳回回退、挂起/取消、副3 熔断、审计哈希链、三种沟通风格文案；不依赖 DOM，可直接在 Node 里跑 |
| `ui.js` | 渲染层：首屏沟通风格三选一、用户视角（手机框）、评委视角（三栏）、对话/契约/审计/账户权限与风格说明 |
| `styles.css` | 全部样式（手机框、首屏、三栏、笔记本小屏压缩） |
| `index.template.html` | 页面骨架，含 `/*__CSS__*/` 等三个占位符 |
| `build.mjs` | 构建脚本（无第三方依赖；自动判断输出到 `交付/` 还是上级目录） |
| `test-engine.js` | 引擎级回归：在 Node 里跑 15 条场景，检查终止状态、环节轨迹、确认/驳回/熔断 |

## 两个维度，别混

- **账户权限（内部）**：`CFG.account` 固定「已实名 · 全功能」（内部 L3）；网页**不让用户选**，真实环境由统一认证下发。
- **沟通风格（用户可选）**：`CFG.styles` + `STYLE_TEXT` 字典，小白 / 标准 / 专业三套说法；只影响副1 话术，不影响流程、颜色、确认次数。

## 两个视角

- 首屏 `#onboard` 三选一沟通风格，默认标准版；`?style=plain|standard|pro` 可直达。
- 视角：`?view=user|judge`；`?onboard=0` 跳过首屏；`?enter=1` 自动点「进入」。
- 用户视角只渲染副1 的话术 / 确认卡 / 凭证；评委视角才挂副3、九环节、契约、审计、账户权限与风格说明。

## 改一处的常见路径

- **改话术**：`STYLE_TEXT` 里三套一起改；只改某一档就改对应 key；
- **改阈值**：`engine.js` 顶部 `CONFIG`（全部标了 `TODO(rule)`），改完重新构建；
- **改风格名称/举例**：`CONFIG.styles` 与首屏 `sampleOf()`；
- **加场景**：`engine.js` 的 `SCENARIOS` 加一条，`ui.js` 的 `buildScenes` 分组里加 ID；
- **改步骤/环节**：`ui.js` 的 `STAGES`（只影响展示），流程逻辑在 `engine.js` 的 `handle()`。

## 回归

```powershell
node test-engine.js
```

会打印 15 条场景的最终状态与环节轨迹，最后一行 `FAILED: none` 即通过。
