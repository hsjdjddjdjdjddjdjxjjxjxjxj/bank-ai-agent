const fs = require("fs");
const path = require("path");
const dir = __dirname;
eval(fs.readFileSync(path.join(dir, "engine.js"), "utf8"));
const B = globalThis.BankEngine;
const { Engine, SCENARIOS } = B;

function run(sc) {
  return new Promise((resolve) => {
    const events = [];
    const engine = new Engine({ onEvent: (ev) => {
      events.push(ev);
      if (ev.t === "confirm") setTimeout(() => engine.resolveChoice(sc.reject ? "reject" : "agree"), 0);
      if (ev.t === "dual") setTimeout(() => engine.resolveChoice("agree"), 0);
      if (ev.t === "suspended") setTimeout(() => engine.resolveChoice("cancel"), 0);
      if (ev.t === "done") setTimeout(() => resolve({ sc, events, state: ev.state, engine }), 0);
    }});
    engine.handle(sc.text, { tier: sc.tier, scenario: sc, fresh: true }).catch((e) => resolve({ sc, events, state: "ERROR:" + e.message, engine }));
    setTimeout(() => resolve({ sc, events, state: "TIMEOUT", engine }), 5000);
  });
}

(async () => {
  const results = [];
  for (const sc of SCENARIOS) {
    if (sc.loop) {
      const engine = new Engine({ onEvent: () => {} });
      let last = null, n = 0;
      for (let i = 0; i < sc.loop; i++) {
        const evs = [];
        engine.onEvent = (ev) => {
          evs.push(ev);
          if (ev.t === "confirm") setTimeout(() => engine.resolveChoice("agree"), 0);
          if (ev.t === "dual") setTimeout(() => engine.resolveChoice("agree"), 0);
          if (ev.t === "suspended") setTimeout(() => engine.resolveChoice("cancel"), 0);
        };
        const r = await engine.handle(sc.text, { tier: sc.tier, scenario: sc, fresh: i === 0 });
        n++;
        last = { state: r.state, evs };
        if (r.state === "interrupted") break;
      }
      results.push({ id: sc.id, state: last.state, runs: n });
      console.log(sc.id, "->", last.state, "runs:", n);
      continue;
    }
    const r = await run(sc);
    const stages = r.events.filter(e => e.t === "stage" && e.state === "run").map(e => e.n);
    const rejects = r.events.filter(e => e.t === "stage" && e.state === "retry").length;
    const confirms = r.events.filter(e => e.t === "confirm").length;
    const branches = r.events.filter(e => e.t === "branch").map(e => e.n + ":" + e.dir);
    const userTexts = r.events.filter(e => e.t === "say" && e.role === "fu1").map(e => e.text);
    results.push({ id: sc.id, state: r.state, stages: stages, rejects: rejects, confirms: confirms, branches: branches, lastSaid: userTexts[userTexts.length - 1] });
    console.log("\n=== " + sc.id + " " + sc.name + " -> " + r.state);
    console.log("  stages:", stages.join("→"), "| conf:", confirms, "| rejects:", rejects, "| branches:", branches.join(","));
    console.log("  final:", (userTexts[userTexts.length - 1] || "").replace(/\n/g, " / ").slice(0, 180));
  }
  fs.writeFileSync(path.join(dir, "engine-test-result.json"), JSON.stringify(results, null, 2));
  const bad = results.filter(r => r.state === "ERROR" || r.state === "TIMEOUT");
  console.log("\nFAILED:", bad.length ? bad.map(b => b.id + " " + b.state).join(", ") : "none");
})();