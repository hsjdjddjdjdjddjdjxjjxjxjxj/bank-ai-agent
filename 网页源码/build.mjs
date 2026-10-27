import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const parent = path.resolve(here, "..");
// 开发态：源码在 bankagent/演示源码，产物进 bankagent/交付；
// 交付态：源码在 交付/网页源码，产物进 交付 根（即上一级）。
const outDir = existsSync(path.join(parent, "交付")) ? path.join(parent, "交付") : parent;
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const tpl = readFileSync(path.join(here, "index.template.html"), "utf8");
const css = readFileSync(path.join(here, "styles.css"), "utf8");
const engine = readFileSync(path.join(here, "engine.js"), "utf8");
const ui = readFileSync(path.join(here, "ui.js"), "utf8");
const html = tpl.replace("/*__CSS__*/", () => css).replace("/*__ENGINE__*/", () => engine).replace("/*__UI__*/", () => ui);
const out = path.join(outDir, "银行智能体_演示.html");
writeFileSync(out, html, "utf8");
console.log("built", out, html.length, "chars");
