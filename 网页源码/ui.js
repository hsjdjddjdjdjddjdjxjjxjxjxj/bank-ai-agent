
/* =====================================================================
   演示界面：把引擎事件渲染成「流程图 + 对话 + 证据」
   ===================================================================== */
(function () {
  "use strict";
  const B = globalThis.BankEngine;
  if (!B) { document.body.innerHTML = "<pre style='padding:24px'>引擎未加载</pre>"; return; }
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const el = function (tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const fmt = B.fmtYuan;
  const CFG = B.CONFIG;
  window.__dshErrors = [];
  function showFatal(text) {
    try { window.__dshErrors.push(text); document.title = "ERR " + text; } catch (e) {}
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:999;background:#d63b3b;color:#fff;font:12px/1.6 monospace;padding:10px 16px;white-space:pre-wrap";
    d.textContent = "演示脚本错误：" + text;
    document.body.appendChild(d);
  }
  window.addEventListener("error", function (e) { showFatal(e.message + " @" + (e.filename || "") + ":" + (e.lineno || "")); });
  window.addEventListener("unhandledrejection", function (e) { showFatal(String(e.reason && e.reason.stack || e.reason)); });

  const STAGES = [
    { n: 1, name: "交互入口", sub: "选择档位 · 打字录入 · TTS 语音接入 → 汇入副1", tags: [{ t: "统一接入" }], branches: [] },
    { n: 2, name: "副1 Agent · 第一道防线", sub: "理解意图 / 实体 / 业务场景 → 缺槽一次问清 → 按档位判断是否放行", tags: [{ t: "唯一用户出口", c: "blue" }],
      branches: [{ dir: "yes", tone: "ok", text: "是 → 整理为结构化任务，交主执" }, { dir: "no", tone: "bad", text: "否 → 礼貌拒绝 · 退回用户" }] },
    { n: 3, name: "主执 · 业务相关性判断", sub: "是否属于银行业务域（账户 / 支付 / 理财 / 信贷 / 合规咨询）", tags: [{ t: "内部结构体 · 不出沙箱", c: "lock" }],
      branches: [{ dir: "yes", tone: "ok", text: "是 → 进入自检" }, { dir: "no", tone: "bad", text: "否 → 转交副1 · 终止本轮" }] },
    { n: 4, name: "主执自检 · 风险请求判断", sub: "合规红线 / 越权 / 可疑诱导 / 提示词注入；结论写入标记供副2 核对", tags: [{ t: "内部结构体 · 不出沙箱", c: "lock" }],
      branches: [{ dir: "no", tone: "ok", text: "否 → 进入权限初判" }, { dir: "yes", tone: "bad", text: "是 → 拒绝执行 · 回退副1" }] },
    { n: 5, name: "权限初判 · 按请求类型分流", sub: "查询 / 办理 / 资金 / 敏感 → 绿 / 黄 / 红；只看「请求本身 + 档位」，不做拆分", tags: [{ t: "权限分流节点" }],
      branches: [{ dir: "green", text: "绿 · 直通" }, { dir: "yellow", text: "黄 · 确认" }, { dir: "red", text: "红 · 强控" }] },
    { n: 6, name: "主执 · 任务拆解与合法性判断", sub: "拆子任务 → 格式合法 / 请求合理（规则 · 额度 · 档位）→ 结构化清单交副2", tags: [{ t: "内部结构体 · 不出沙箱", c: "lock" }],
      branches: [{ dir: "yes", tone: "ok", text: "合法 → 交副2 复核" }, { dir: "no", tone: "bad", text: "不合法 → 不受理 · 回副1" }] },
    { n: 7, name: "副2 Agent · 第二道防线：复核", sub: "格式（结构 / 字段 / 参数 / 模板）+ 请求（拆解结果 / 权限标记 / 档位一致）", tags: [{ t: "独立复核 · 不出沙箱", c: "blue" }],
      branches: [{ dir: "yes", tone: "ok", text: "通过 → 二次分流" }, { dir: "no", tone: "bad", text: "不通过 → 驳回⑥ 重做" }] },
    { n: 8, name: "执行 / 确认", sub: "校验权限标记与参数 → 工具执行；黄 = 二次确认；红 = 强确认 + 双人复核", tags: [{ t: "执行层 · 禁止直出", c: "warn" }],
      branches: [{ dir: "yes", tone: "ok", text: "用户同意 → 执行" }, { dir: "no", tone: "bad", text: "拒绝 → 等待 / 取消" }] },
    { n: 9, name: "结果输出", sub: "副3 记录 → 回传副1 统一话术 → 返回用户（文字 + TTS）", tags: [{ t: "统一出口", c: "blue" }], branches: [] }
  ];

  const state = { style: "standard", view: "user", speed: 1, sid: "—", ctCount: 0, stageEls: {}, pending: null, activeCard: null, busy: false, dualPhase: false, turns: 0 };

  /* ---------------- 静态结构 ---------------- */
  function buildFlow() {
    const body = $("#flowBody");
    STAGES.forEach(function (s) {
      const node = el("div", "stage");
      node.dataset.n = s.n;
      node.appendChild(el("div", "num", String(s.n)));
      const wrap = el("div", "body");
      const t = el("div", "t", s.name);
      const sub = el("div", "s", s.sub);
      wrap.appendChild(t); wrap.appendChild(sub);
      if (s.branches && s.branches.length) {
        const br = el("div", "branches");
        s.branches.forEach(function (b) {
          const chip = el("span", "bchip " + b.dir + (b.tone ? " tone-" + b.tone : ""), b.text);
          chip.dataset.dir = b.dir;
          br.appendChild(chip);
        });
        wrap.appendChild(br);
      }
      node.appendChild(wrap);
      const tags = el("div", "tags");
      (s.tags || []).forEach(function (tg) { tags.appendChild(el("span", "tag " + (tg.c || ""), tg.t)); });
      node.appendChild(tags);
      node.appendChild(el("div", "badge", "返回重做"));
      body.appendChild(node);
      state.stageEls[s.n] = node;
    });
  }

  function buildScenes() {
    const row = $("#sceneRow");
    const groups = [
      ["S1", "S2", "S3", "S3B"],
      ["S4", "S4B", "S4C", "S5", "S6"],
      ["S7", "S7B", "S8", "S9", "S10"],
      ["S11", "S12"]
    ];
    groups.forEach(function (ids, gi) {
      if (gi === 3) row.appendChild(el("span", "lbl", "边界演示"));
      else if (gi > 0) row.appendChild(el("span", "lbl", ""));
      ids.forEach(function (id) {
        const sc = B.SCENARIOS.filter(function (s) { return s.id === id; })[0];
        if (!sc) return;
        const cls = sc.color === "green" ? "g" : sc.color === "yellow" ? "y" : sc.color === "red" ? "r" : "x";
        const btn = el("button", "sbtn " + cls,
          '<span class="id">' + sc.id + '</span><span class="d"></span>' + sc.name);
        btn.title = "档位 " + sc.tier + "｜" + sc.text;
        btn.onclick = function () { runScenario(sc); };
        row.appendChild(btn);
      });
    });
  }

  function buildRules() {
    const pane = $("#pane-rules");
    pane.innerHTML = "";

    const b1 = el("div", "rule-block");
    b1.appendChild(el("h4", null, "三色口径 <span>颜色只由「请求内容 + 账户权限」决定，与沟通风格无关</span>"));
    ["green", "yellow", "red"].forEach(function (k) {
      const c = CFG.colors[k];
      const row = el("div", null,
        '<div style="display:flex;gap:7px;align-items:center;margin:6px 0 2px"><span class="pill ' + k + '">' + c.label +
        '</span><span style="font-size:10.5px;color:#8d9bb0">' + (k === "green" ? "直接执行，不打断" : k === "yellow" ? "二次确认后执行" : "强确认 / 双人复核 / 拒绝") + '</span></div>' +
        '<div style="font-size:11px;color:#7c8aa5;line-height:1.5">' + c.desc + '</div>');
      b1.appendChild(row);
    });
    pane.appendChild(b1);

    const b2 = el("div", "rule-block");
    b2.appendChild(el("h4", null, "账户权限 <span>由账户实名与认证等级决定，不由用户选择</span>"));
    b2.appendChild(el("div", "note", "当前演示账户：<b>" + CFG.account.label + "</b>（内部权限 " + CFG.account.tier + "，可触达绿 / 黄 / 红）。真实环境由行内账户体系下发；界面只让用户选沟通风格，不暴露权限档位。"));
    let html = '<table class="matrix"><thead><tr><th>工具</th><th>类型</th><th>基础色</th><th>演示可达</th></tr></thead><tbody>';
    Object.keys(CFG.tools).forEach(function (name) {
      const s = CFG.tools[name];
      if (name === "non_bank") return;
      html += "<tr><td>" + s.label + '</td><td class="mono">' + s.scene + '</td><td><span class="pill ' + s.level + '">' + (s.level === "green" ? "绿" : s.level === "yellow" ? "黄" : "红") + '</span></td><td><span class="pill ' + s.level + '">可</span></td></tr>';
    });
    html += "</tbody></table>";
    b2.innerHTML += html;
    b2.style.marginBottom = "0";
    pane.appendChild(b2);

    const b3 = el("div", "rule-block");
    b3.appendChild(el("h4", null, "沟通风格 <span>只改副1 怎么说话，不改流程、颜色、确认次数</span>"));
    const table = el("table", "matrix");
    table.innerHTML = '<thead><tr><th>风格</th><th>说话方式</th><th>同一句「需要补收款人」</th></tr></thead><tbody>' +
      Object.keys(CFG.styles).map(function (k) {
        const st = CFG.styles[k];
        return "<tr" + (k === state.style ? ' style="background:#f5f9ff"' : "") + "><td><b>" + st.name + "</b>" + (k === state.style ? ' <span class="todo">当前</span>' : "") + '</td><td style="font-size:10.6px;color:#7c8aa5">' + st.hint + '</td><td style="font-size:10.6px">' + st.sample + "</td></tr>";
      }).join("") + "</tbody>";
    b3.appendChild(table);
    b3.appendChild(el("div", "note", "三条回复内容一样、办的事一样，只是说法不同：小白版不用专业词，专业版直接给结论。切换风格不影响本轮已办的事。"));
    pane.appendChild(b3);

    const b4 = el("div", "rule-block");
    b4.appendChild(el("h4", null, "配置项 <span>图中未定义的取值，全部标 TODO(rule) 待拍板</span>"));
    const kvs = [
      ["单笔转账上限", fmt(CFG.limits.singleTransferCents) + " 元", true],
      ["反问轮次上限", CFG.clarify.maxRounds + " 轮", true],
      ["副2 驳回上限", CFG.review.maxReject + " 次", true],
      ["同类意图熔断", CFG.loop.maxSameIntent + " 次", true],
      ["非业务域重复上限", CFG.domain.maxNonBank + " 次", true],
      ["红线双人复核", "开启（本人 + 复核席位）", false],
      ["确认有效期", CFG.confirmTtlSeconds + " 秒", false]
    ];
    kvs.forEach(function (kv) {
      b4.appendChild(el("div", "kv", "<span>" + kv[0] + "</span><b>" + kv[1] + (kv[2] ? '<span class="todo">TODO(rule)</span>' : "") + "</b>"));
    });
    b4.appendChild(el("div", "note", "所有阈值均来自 config，不在判断逻辑里硬编码；替换为行内真实配置即可上线灰度。"));
    pane.appendChild(b4);
  }

  /* ---------------- 事件队列 ---------------- */
  let queue = [];
  let pumping = false;
  function push(ev) { queue.push(ev); if (!pumping) pump(); }
  function waitIdle() {
    return new Promise(function (res) {
      const t = setInterval(function () {
        if (!pumping && queue.length === 0) { clearInterval(t); res(); }
      }, 30);
    });
  }
  async function pump() {
    pumping = true;
    while (queue.length) {
      const ev = queue.shift();
      try { await render(ev); } catch (err) { console.error(err); }
    }
    pumping = false;
  }
  async function delay(ms) { if (state.speed === 0) return; await sleep(ms * state.speed); }

  /* ---------------- 渲染 ---------------- */
  function flashBacklane() {
    const b = $("#backlane");
    b.classList.add("hot");
    setTimeout(function () { b.classList.remove("hot"); }, 1200);
  }

  async function render(ev) {
    switch (ev.t) {
      case "session": {
        state.sid = ev.sid;
        setRailStatus("listening", "监听中 · 会话 " + ev.sid + " · 账户 " + CFG.account.label + " · " + (CFG.styles[ev.style] || CFG.styles[state.style]).name);
        addRail("info", "── 新会话 " + ev.sid + " · " + CFG.styles[ev.style || state.style].name + " ──");
        break;
      }
      case "turn": {
        if (state.turns > 0) {
          clearStageMarks();
          resetVerdict();
          addRail("info", "── 同一会话第 " + (state.turns + 1) + " 轮 ──");
        }
        state.turns++;
        state.sid = ev.sid;
        setRailStatus("listening", "监听中 · 会话 " + ev.sid + " · 账户 " + CFG.account.label + " · " + (CFG.styles[ev.style] || CFG.styles[state.style]).name);
        break;
      }
      case "stage": {
        const node = state.stageEls[ev.n];
        if (!node) break;
        node.classList.remove("run", "ok", "fail", "ask", "retry");
        node.classList.add(ev.state);
        if (ev.state === "retry") node.querySelector(".badge").textContent = ev.note || "返回重做";
        if (ev.state === "run") {
          try { node.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
        }
        if (ev.state === "fail") flashBacklane();
        if (ev.state === "retry") { flashBacklane(); }
        await delay(ev.state === "run" ? 380 : 180);
        break;
      }
      case "branch": {
        const node = state.stageEls[ev.n];
        if (node) {
          const chip = node.querySelector('.bchip[data-dir="' + ev.dir + '"]');
          if (chip) chip.classList.add("on");
        }
        if (ev.dir === "no") flashBacklane();
        await delay(240);
        break;
      }
      case "say": { addBubble(ev); await delay(ev.kind === "ask" ? 460 : 320); break; }
      case "log": { addRail(ev.level, ev.text); await delay(60); break; }
      case "contract": { addContract(ev); await delay(40); break; }
      case "decision": { setVerdict(ev); await delay(120); break; }
      case "audit": { addAudit(ev.rec); await delay(30); break; }
      case "metrics": { setMetrics(ev.data); break; }
      case "confirm": { showConfirm(ev.payload); setRailStatus("warn", "等待用户确认 · " + (ev.payload.level === "red" ? "红线强确认 + 双人复核" : "黄线二次确认")); break; }
      case "dual": { showDual(); setRailStatus("warn", "等待复核席位 · 双人复核第二步"); break; }
      case "suspended": { showSuspended(ev.payload); setRailStatus("warn", "任务已挂起 · 等待用户决定（可随时取消）"); break; }
      case "interrupt": {
        const REASON = { "same-intent": "同类意图超限", "reject-limit": "副2 驳回超限", "clarify-limit": "反问轮次超限" };
        setRailStatus("danger", "已熔断 · " + (REASON[ev.reason] || ev.reason));
        toast("副3 熔断：" + ev.detail);
        await delay(200);
        break;
      }
      case "done": { finish(ev.state); break; }
      default: break;
    }
  }

  /* ---------------- 左侧：副3 ---------------- */
  function addRail(level, text) {
    const box = $("#railLog");
    const line = el("div", "ln " + (level || "info"));
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, "0"); };
    line.innerHTML = "<time>" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "</time><span>" + text + "</span>";
    box.appendChild(line);
    while (box.children.length > 400) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  function setRailStatus(kind, text) {
    const box = $("#railStatus");
    box.classList.remove("warn", "danger");
    if (kind === "warn") box.classList.add("warn");
    if (kind === "danger") box.classList.add("danger");
    $("#railStatusText").textContent = text;
  }
  function setMetrics(m) {
    $("#cntIntent").textContent = m.sameIntent;
    $("#cntClarify").textContent = m.clarify;
    $("#cntReject").textContent = m.reject;
    $("#cntRisk").textContent = m.risk;
    if (m.tripped) setRailStatus("danger", "已熔断 · 转人工");
  }

  /* ---------------- 中间：判定 ---------------- */
  const LEVEL_LABEL = { green: "绿 · 低风险", yellow: "黄 · 中风险", red: "红 · 高风险" };
  function setVerdict(ev) {
    const v = $("#verdict");
    v.className = "pill " + ev.level;
    v.textContent = "判定：" + LEVEL_LABEL[ev.level];
    const rules = (ev.rules || []).map(function (r) { return r.rule; });
    $("#verdictRules").textContent = "命中：" + (rules.join(" · ") || "—");
    $("#verdictRules").title = (ev.rules || []).map(function (r) { return r.rule + "：" + r.detail; }).join("\n");
  }
  function resetVerdict() {
    $("#verdict").className = "pill na";
    $("#verdict").textContent = "判定：—";
    $("#verdictRules").textContent = "选择场景或输入一句话开始";
    $("#verdictRules").title = "";
  }

  /* ---------------- 右侧：对话 ---------------- */
  function chat() { return $("#pane-chat"); }
  function scrollChat() { const c = chat(); c.scrollTop = c.scrollHeight; }
  function addBubble(ev) {
    const isUser = ev.role === "user";
    const msg = el("div", "msg " + (isUser ? "user" : "fu1"));
    msg.appendChild(el("div", "av", isUser ? "我" : "副1"));
    const col = el("div", "col");
    const bub = el("div", "bub");
    bub.textContent = ev.text;
    if (ev.kind === "fallback") {
      bub.style.borderColor = "#f6c9c9";
      bub.style.background = "#fff7f7";
    }
    if (ev.meta && ev.meta.chips && ev.meta.chips.length) {
      const chips = el("div", "chips");
      ev.meta.chips.forEach(function (t) {
        const c = el("button", "chip", t);
        c.onclick = function () { if (!state.busy) sendText(t); };
        chips.appendChild(c);
      });
      bub.appendChild(chips);
    }
    col.appendChild(bub);
    if (!isUser) {
      const meta = el("div", "meta");
      meta.textContent = ev.kind === "fallback" ? "副3 触发 · 副1 单条兜底 · 不承接多轮" : "副1 Agent · 唯一用户出口";
      if (ev.kind === "fallback") meta.style.color = "#d63b3b";
      col.appendChild(meta);
    }
    msg.appendChild(col);
    chat().appendChild(msg);
    scrollChat();
  }
  function addSys(text) {
    const msg = el("div", "msg sys");
    msg.appendChild(el("div", "bub", text));
    chat().appendChild(msg);
    scrollChat();
  }
  function addNote(text) { addSys(text); }

  /* ---------------- 确认卡片 ---------------- */
  function showConfirm(p) {
    state.dualPhase = false;
    const red = p.level === "red";
    const card = el("div", "confirm" + (red ? " red" : ""));
    state.activeCard = card;
    const isUserView = state.view === "user";
    const head = el("div", "ch",
      '<span class="lv" style="background:' + (red ? "#d63b3b" : "#d4870a") + '">' + (isUserView ? (red ? "高风险" : "需确认") : (red ? "红 · 强控" : "黄 · 确认")) + "</span>" +
      (isUserView ? "请核对后确认" : "待确认") + " · " + (p.items.length > 1 ? p.items.length + " 项" : p.items[0].biz));
    card.appendChild(head);

    let rows = '<table><tr><td>办什么</td><td>' + p.items.map(function (i) { return i.biz; }).join(" + ") + "</td></tr>";
    if (p.items.length === 1) {
      rows += "<tr><td>对象</td><td>" + p.items[0].object + "</td></tr>";
      rows += "<tr><td>金额</td><td>" + p.items[0].amount + "</td></tr>";
      rows += "<tr><td>能否撤回</td><td>" + (p.items[0].reversible ? "可以撤回" : "不能撤回") + "</td></tr>";
    } else {
      p.items.forEach(function (i, idx) {
        rows += "<tr><td>第 " + (idx + 1) + " 步</td><td>" + i.biz + " · " + i.object + " · " + i.amount + "</td></tr>";
      });
    }
    if (p.direct && p.direct.length) rows += "<tr><td>" + (isUserView ? "已先办" : "已直通") + "</td><td>" + p.direct.join("、") + (isUserView ? "（只读，已先执行）" : "（绿线，已先执行）") + "</td></tr>";
    rows += "<tr><td>后果</td><td>" + p.consequence + "</td></tr></table>";
    card.insertAdjacentHTML("beforeend", rows);

    if (p.dual) {
      card.insertAdjacentHTML("beforeend",
        '<div class="steps"><div class="st now">① ' + (isUserView ? "您确认" : "本人确认") + '</div><div class="st">② ' + (isUserView ? "银行复核" : "复核席位") + "</div></div>");
      card.insertAdjacentHTML("beforeend", '<div class="warnline">' + (isUserView
        ? "这笔操作风险较高：需要您本人确认，并由复核席位二次授权，两步缺一不可。"
        : "红线强控：本人确认 + 复核席位双人复核，两步缺一不可。") + "</div>");
    }
    const acts = el("div", "acts");
    const bNo = el("button", "btn", "先不办");
    const bYes = el("button", "btn primary", "确认执行");
    bNo.onclick = function () { decide("reject", card); };
    bYes.onclick = function () { decide("agree", card); };
    acts.appendChild(bNo); acts.appendChild(bYes);
    card.appendChild(acts);
    chat().appendChild(card);
    scrollChat();

    state.pending = { settled: false };
    if ($("#autoConfirm").checked) {
      const choice = (state.scenario && state.scenario.reject) ? "reject" : "agree";
      setTimeout(function () { if (!state.pending || state.pending.settled) return; decide(choice, card); }, Math.max(700, 1100 * (state.speed || 1)));
    }
  }
  function decide(choice, card) {
    if (!state.pending || state.pending.settled) return;
    state.pending.settled = true;
    if (card) {
      $$(".acts button", card).forEach(function (b) { b.disabled = true; });
      const yes = $(".acts .primary", card);
      if (state.dualPhase && choice === "agree") {
        const steps = $$(".steps .st", card);
        if (steps[1]) { steps[1].classList.remove("now"); steps[1].classList.add("done"); steps[1].textContent = state.view === "user" ? "② 银行复核 ✓" : "② 复核席位 ✓"; }
        if (yes) yes.textContent = "复核通过";
      } else if (yes) {
        yes.textContent = choice === "agree" ? "已确认" : "已拒绝";
      }
      const no = $(".acts .btn:not(.primary)", card);
      if (no && choice === "reject") no.textContent = "已拒绝";
    }
    state.dualPhase = false;
    engine.resolveChoice(choice);
  }
  function showDual() {
    const card = state.activeCard;
    state.pending = { settled: false };
    state.dualPhase = true;
    if (card) {
      const steps = $$(".steps .st", card);
      const uv = state.view === "user";
      if (steps[0]) { steps[0].classList.remove("now"); steps[0].classList.add("done"); steps[0].textContent = uv ? "① 您确认 ✓" : "① 本人确认 ✓"; }
      if (steps[1]) { steps[1].classList.remove("done"); steps[1].classList.add("now"); steps[1].textContent = uv ? "② 银行复核中…" : "② 复核席位（进行中）"; }
      const acts = $$(".acts", card)[0];
      acts.innerHTML = "";
      const bNo = el("button", "btn", "复核不通过");
      const bYes = el("button", "btn primary", "复核通过");
      bNo.onclick = function () { decide("reject", card); };
      bYes.onclick = function () { decide("agree", card); };
      acts.appendChild(bNo); acts.appendChild(bYes);
    }
    if (state.view === "user") {
      const acts = card ? $(".acts", card) : null;
      if (acts) acts.innerHTML = '<div class="waitline">已提交，等待复核席位授权…</div>';
      addSys("复核席位：这是一笔资金操作，正在等待二级复核。");
      setTimeout(function () { if (!state.pending || state.pending.settled) return; decide("agree", card); }, 1700);
      return;
    }
    addSys("复核席位：这是一笔红线资金操作，请二级复核人确认。");
    if ($("#autoConfirm").checked) {
      setTimeout(function () { if (!state.pending || state.pending.settled) return; decide("agree", card); }, Math.max(700, 1000 * (state.speed || 1)));
    }
  }
  function showSuspended(p) {
    const bar = el("div", "waitbar");
    bar.innerHTML = "<span>任务已挂起 · 等待用户决定（不会自动执行）</span><span class='sp'></span>";
    const bStay = el("button", "btn", "保持挂起");
    const bCancel = el("button", "btn primary", "取消本轮");
    bStay.onclick = function () { state.pending.settled = true; engine.resolveChoice("stay"); bar.remove(); };
    bCancel.onclick = function () { state.pending.settled = true; engine.resolveChoice("cancel"); bar.remove(); };
    bar.appendChild(bStay); bar.appendChild(bCancel);
    chat().appendChild(bar); scrollChat();
    state.pending = { settled: false };
    if (state.scenario && state.scenario.reject) {
      setTimeout(function () { if (!state.pending || state.pending.settled) return; state.pending.settled = true; engine.resolveChoice("cancel"); bar.remove(); }, Math.max(700, 900 * (state.speed || 1)));
    }
  }

  /* ---------------- 契约 ---------------- */
  function addContract(ev) {
    const pane = $("#pane-contract");
    const card = el("div", "ct");
    const head = el("div", "h",
      '<span class="k">' + ev.kind + '</span><span>' + ev.from + " → " + ev.to + '</span><span class="sp"></span><span class="ok">✓</span><span class="fold">收起</span>');
    card.appendChild(head);
    const pre = el("pre");
    pre.textContent = JSON.stringify(ev.data, null, 2);
    card.appendChild(pre);
    head.onclick = function () { card.classList.toggle("fold"); $(".fold", head).textContent = card.classList.contains("fold") ? "展开" : "收起"; };
    pane.appendChild(card);
    pane.scrollTop = pane.scrollHeight;
    state.ctCount++;
    $("#ctBadge").textContent = state.ctCount;
    if (state.ctCount === 1) toast("agent 之间只传结构体：见「契约 JSON」");
  }

  /* ---------------- 审计 ---------------- */
  function addAudit(rec) {
    const list = $("#auditList");
    const lv = rec.level === "green" ? "green" : rec.level === "yellow" ? "yellow" : rec.level === "red" ? "red" : "sys";
    const row = el("div", "rec");
    row.innerHTML = '<div class="n">#' + rec.seq + "</div><div><div class=\"a\">" + rec.actor + " · " + rec.action +
      '</div><div class="d">' + rec.detail + '</div><div class="hash">' + rec.hash + " ← " + rec.prev + "</div></div>" +
      '<div class="lv ' + lv + '">' + (lv === "sys" ? "记录" : lv === "green" ? "绿" : lv === "yellow" ? "黄" : "红") + "</div>";
    list.appendChild(row);
    while (list.children.length > 300) list.removeChild(list.firstChild);
    verifyChain(false);
  }
  function verifyChain(toastIt) {
    const rows = $$("#auditList .rec");
    let ok = true, broken = 0;
    const records = [];
    rows.forEach(function (r) {
      const hash = r.querySelector(".hash").textContent.split(" ← ")[0];
      const prev = r.querySelector(".hash").textContent.split(" ← ")[1];
      records.push({ hash: hash, prev: prev });
    });
    for (let i = 0; i < records.length; i++) {
      const expectPrev = i === 0 ? "GENESIS" : records[i - 1].hash;
      if (records[i].prev !== expectPrev || !records[i].hash) { ok = false; broken = i + 1; break; }
    }
    const elx = $("#chainState");
    elx.className = ok ? "ok" : "bad";
    elx.textContent = ok ? "✓ 链完整 · " + records.length + " 条" : "✗ 第 " + broken + " 条断裂";
    if (toastIt) toast(ok ? "审计链校验通过：" + records.length + " 条记录首尾相接" : "审计链在第 " + broken + " 条断裂");
  }

  /* ---------------- 结束 ---------------- */
  const DONE_TEXT = {
    completed: "本轮完成 · 结果由副1 统一返回",
    refused: "本轮终止 · 已回退副1 礼貌拒绝",
    cancelled: "本轮取消 · 没有执行任何操作",
    suspended: "任务挂起 · 可随时取消",
    interrupted: "副3 熔断 · 已转人工",
    clarify: "等待补充信息 · 副1 已反问",
    transferred: "本轮终止 · 非业务域已交回副1"
  };
  function finish(stateText) {
    $$("#pane-chat .confirm").forEach(function (card) {
      if (card.dataset.closed) return;
      card.dataset.closed = "1";
      card.classList.add("done");
      $$(".acts", card).forEach(function (a) { a.remove(); });
      const note = el("div", "donenote", state.view === "user"
        ? (stateText === "completed" ? "✓ 已完成" : "— 已取消，没有执行 —")
        : (stateText === "completed" ? "✓ 已执行 · 结果见下方副1 统一返回" : "— 未执行 · 本轮没有产生资金变动 —"));
      card.appendChild(note);
    });
    setRailStatus(stateText === "interrupted" ? "danger" : "listening", "监听中 · " + (DONE_TEXT[stateText] || stateText));
    addSys("— " + (DONE_TEXT[stateText] || stateText) + " —");
  }

  /* ---------------- 运行控制 ---------------- */
  function clearStageMarks() {
    Object.keys(state.stageEls).forEach(function (n) {
      const node = state.stageEls[n];
      node.classList.remove("run", "ok", "fail", "ask", "retry");
      node.querySelectorAll(".bchip").forEach(function (c) { c.classList.remove("on"); });
    });
  }
  function resetSessionUI() {
    state.turns = 0;
    Object.keys(state.stageEls).forEach(function (n) {
      const node = state.stageEls[n];
      node.classList.remove("run", "ok", "fail", "ask", "retry");
      $$(".bchip", node).forEach(function (c) { c.classList.remove("on"); });
    });
    chat().innerHTML = "";
    $("#pane-contract").innerHTML = "";
    state.ctCount = 0;
    $("#ctBadge").textContent = "0";
    resetVerdict();
    state.activeCard = null;
    state.pending = null;
  }

  async function runScenario(sc) {
    if (state.busy) return;
    state.busy = true; state.scenario = sc;
    setBusyUI(true);
    resetSessionUI();
    addRail("info", "场景 " + sc.id + " · " + sc.name + " · 「" + sc.text + "」");
    let r = await engine.handle(sc.text, { scenario: sc, fresh: true });
    const follow = (sc.followUps || []).slice();
    while (r.state === "clarify" && follow.length) {
      await waitIdle(); await sleep(1000);
      const t = follow.shift();
      addRail("info", "用户补充：" + t);
      r = await engine.handle(t, { scenario: sc, fresh: false });
    }
    if (sc.loop) {
      for (let i = 1; i < sc.loop && r.state !== "interrupted"; i++) {
        await waitIdle(); await sleep(900);
        addRail("info", "用户第 " + (i + 1) + " 次重复同一意图");
        r = await engine.handle(sc.text, { scenario: sc, fresh: false });
      }
    }
    await waitIdle();
    state.busy = false; state.scenario = null;
    setBusyUI(false);
  }

  async function sendText(text) {
    text = String(text || "").trim();
    if (!text || state.busy) return;
    state.busy = true;
    setBusyUI(true);
    const fresh = !engine.sid;
    if (fresh) resetSessionUI();
    addRail("info", "手动输入：「" + B.redact(text) + "」");
    await engine.handle(text, { scenario: null, fresh: fresh });
    await waitIdle();
    state.busy = false;
    setBusyUI(false);
    $("#chatInput").value = "";
    if ($("#phoneInput")) $("#phoneInput").value = "";
  }

  function setBusyUI(b) {
    $$("#sceneRow .sbtn").forEach(function (x) { x.disabled = b; });
    $("#sendBtn").disabled = b;
    $("#chatInput").disabled = b;
    if ($("#phoneSend")) $("#phoneSend").disabled = b;
    if ($("#phoneInput")) $("#phoneInput").disabled = b;
  }

  /* ---------------- 用户类型 / 视角 / 控件 ---------------- */
  function syncStyleUI() {
    const st = CFG.styles[state.style];
    const name = $("#profileName"), hint = $("#profileHint"), btn = $("#profileBtn");
    if (!name) return;
    name.textContent = st.name;
    hint.textContent = st.hint;
    btn.classList.remove("style-plain", "style-standard", "style-pro");
    btn.classList.add("style-" + state.style);
    $$("#obCards .ob-opt").forEach(function (c) { c.classList.toggle("sel", c.dataset.style === state.style); });
  }

  function setStyle(s, silent) {
    if (!CFG.styles[s]) return;
    state.style = s;
    if (engine) engine.setStyle(s);
    syncStyleUI();
    buildRules();
    if (!silent) toast("沟通风格：" + CFG.styles[s].name + "（" + CFG.styles[s].hint + "）");
  }

  function toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.classList.add("on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("on"); }, 2600);
  }

  function updateClock() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, "0"); };
    const elx = $("#phoneTime");
    if (elx) elx.textContent = p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function addWelcome() {
    const pane = chat();
    if (pane.children.length > 0) return;
    const texts = {
      plain: "您好，我是您的银行助手。您直接说想干啥就行，比如查余额、看账单、转账、改手机号、锁卡，我一步步帮您办。",
      standard: "您好，我是您的银行助手。可以直接说：查余额、看账单、转账、改预留手机号、锁卡。",
      pro: "您好。可办理：余额 / 账单查询、转账、手机号变更、卡片锁定。直接输入指令即可。"
    };
    addBubble({
      role: "fu1",
      kind: "text",
      text: texts[state.style] || texts.standard,
      meta: { chips: ["查一下我的余额", "这个月哪块花超了", "帮我把预留手机号改成 13800138000"] }
    });
  }

  function applyView(v) {
    state.view = v === "judge" ? "judge" : "user";
    const app = $("#app");
    app.classList.toggle("user-view", state.view === "user");
    app.classList.toggle("judge-view", state.view === "judge");
    $$("#viewSeg button").forEach(function (b) { b.classList.toggle("on", b.dataset.view === state.view); });
    const pane = $("#pane-chat");
    if (state.view === "user") {
      $("#phoneChat").appendChild(pane);
      pane.classList.add("phone-mode");
      addWelcome();
      if ($("#onboard").classList.contains("hide")) { try { $("#phoneInput").focus(); } catch (e) {} }
    } else {
      $(".side").appendChild(pane);
      pane.classList.remove("phone-mode");
      $$("#tabs button").forEach(function (x) { x.classList.toggle("on", x.dataset.pane === "chat"); });
      $$(".pane").forEach(function (p) { p.classList.remove("on"); });
      pane.classList.add("on");
    }
  }

  function sampleOf(style) {
    if (style === "plain") return "我先跟您核对一下：转 500 元给张三，对吗？";
    if (style === "pro") return "转 500 元 → 张三；请确认。";
    return "请核对：转 500 元给张三，确认后执行。";
  }

  function buildOnboard() {
    const box = $("#obCards");
    box.innerHTML = "";
    [["plain", "🌱"], ["standard", "🙂"], ["pro", "⚡"]].forEach(function (pair) {
      const k = pair[0], st = CFG.styles[k];
      const card = el("div", "ob-opt style-" + k + (state.style === k ? " sel" : ""));
      card.dataset.style = k;
      card.innerHTML = '<div class="tick">✓</div><div class="on-ico">' + pair[1] + "</div>" +
        "<b>" + st.name + "</b><div class=\"bl\">" + st.hint + "</div>" +
        '<div class="cf">同一句话，我会这样说：</div>' +
        '<div class="sample">' + sampleOf(k) + "</div>";
      card.onclick = function () { state.style = k; syncStyleUI(); };
      box.appendChild(card);
    });
  }

  function openOnboard() {
    if (state.busy) { toast("正在执行，稍后再切换用户类型"); return; }
    buildOnboard();
    $("#onboard").classList.remove("hide");
    $("#obEnter").textContent = (engine && engine.sid) ? "确认切换" : "进入";
  }

  function enterApp() {
    engine.setStyle(state.style);
    syncStyleUI();
    buildRules();
    $("#onboard").classList.add("hide");
    applyView(state.view || "user");
    if (engine.sid) addSys("已切换沟通风格：" + CFG.styles[state.style].name + "（" + CFG.styles[state.style].hint + "）");
    try { $("#phoneInput").focus(); } catch (e) {}
  }

  function wire() {
    $$("#viewSeg button").forEach(function (b) { b.onclick = function () { applyView(b.dataset.view); }; });
    $("#profileBtn").onclick = openOnboard;
    $("#phoneProfile").onclick = openOnboard;
    $("#obEnter").onclick = enterApp;
    $("#speed").onchange = function () { state.speed = Number(this.value); toast("节奏：" + this.options[this.selectedIndex].text); };
    $("#autoConfirm").onchange = function () { toast(this.checked ? "自动演示已开启（录屏模式）" : "自动演示已关闭，请手动点确认"); };
    $("#resetBtn").onclick = function () { location.reload(); };
    $("#verifyBtn").onclick = function () { verifyChain(true); };
    $$("#tabs button").forEach(function (b) {
      b.onclick = function () {
        $$("#tabs button").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        $$(".pane").forEach(function (p) { p.classList.remove("on"); });
        $("#pane-" + b.dataset.pane).classList.add("on");
      };
    });
    $("#sendBtn").onclick = function () { sendText($("#chatInput").value); };
    $("#chatInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); sendText(this.value); }
    });
    $("#phoneSend").onclick = function () { sendText($("#phoneInput").value); };
    $("#phoneInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); sendText(this.value); }
    });
  }

  /* ---------------- 启动 ---------------- */
  buildFlow();
  buildScenes();
  buildRules();
  wire();
  buildOnboard();
  const engine = new B.Engine({ onEvent: push });
  window.__engine = engine;
  engine.setStyle(state.style);
  syncStyleUI();
  setRailStatus("listening", "监听中 · 等待第一轮会话");
  updateClock();
  setInterval(updateClock, 30000);

  /* 直达链接：
     ?view=user|judge  视角
     ?style=plain|standard|pro 沟通风格（默认 standard）
     ?scene=S4 / ?text=... 自动跑（会自动跳过首屏选择）
     ?onboard=0 跳过首屏；?speed=1&auto=1 控制节奏与自动确认；?tab=audit 打开页签 */
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("speed") !== null) { state.speed = Number(params.get("speed")); $("#speed").value = String(state.speed); }
    if (params.get("auto") === "0") $("#autoConfirm").checked = false;
    if (params.get("auto") === "1") $("#autoConfirm").checked = true;
    const pf = params.get("style") || params.get("profile") || params.get("tier");
    if (pf && CFG.styles[pf]) { state.style = pf; engine.setStyle(pf); syncStyleUI(); buildRules(); }
    const tab = params.get("tab");
    if (tab) { const btn = document.querySelector('#tabs button[data-pane="' + tab + '"]'); if (btn) btn.click(); }
    const wantScene = params.get("scene");
    const wantText = params.get("text");
    const skip = Boolean(wantScene || wantText) || params.get("onboard") === "0";
    if (skip) $("#onboard").classList.add("hide");
    const view = params.get("view") || (skip ? "judge" : "user");
    applyView(view);
    if (!skip) buildOnboard();
    if (params.get("enter") === "1") {
      setTimeout(function () { enterApp(); }, 300);
    }
    if (wantScene) {
      const target = B.SCENARIOS.filter(function (s) { return s.id.toLowerCase() === String(wantScene).toLowerCase(); })[0];
      if (target) setTimeout(function () { runScenario(target); }, 350);
    } else if (wantText) {
      setTimeout(function () { sendText(wantText); }, 350);
    }
  } catch (e) { console.error(e); }
})();