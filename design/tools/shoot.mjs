#!/usr/bin/env node
// Booot design screenshot harness. Zero dependencies (Node 22+, system Chrome).
//
//   node design/tools/shoot.mjs                 # default scenes → /tmp/booot-shots
//   node design/tools/shoot.mjs --out DIR --scenes scenes.json --only planner
//
// Starts `python3 -m http.server 8000` in the repo root if nothing is
// listening (port 8000 is in the tile CORS allowlist), drives headless Chrome
// over the DevTools protocol, and writes one PNG per `shot` step.
//
// Scene format (JSON array):
//   { "name": "planner", "path": "/", "viewport": [1440, 900], "steps": [
//       {"wait": 4000}, {"click": "#tripsHomeNewBtn"}, {"type": ["#onboardingName", "Zion"]},
//       {"eval": "document.body.dataset.x = 1"}, {"hover": "#addRouteBtn"},
//       {"mapClick": [-200, 0]}, {"mapDblClick": [-40, 90]}, {"shot": "03-planner"} ] }

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]);
  return acc;
}, []));
const BASE = args.base || "http://localhost:8000";
const OUT = resolve(args.out || join(tmpdir(), "booot-shots"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_SCENES = [
  { name: "specimen", path: "/design/specimen.html", viewport: [1280, 900], steps: [{ wait: 1500 }, { shot: "specimen" }, { eval: "document.getElementById('sketch').scrollIntoView()" }, { wait: 1200 }, { shot: "specimen-sketch" }] },
  { name: "planner", path: "/", viewport: [1440, 900], steps: [
    { wait: 5000 }, { shot: "01-trips-home" },
    { click: "#tripsHomeNewBtn" }, { wait: 600 }, { shot: "02-onboarding" },
    { type: ["#onboardingName", "Zion Traverse"] }, { type: ["#onboardingLocation", "Zion National Park, UT"] },
    { click: "#onboardingSubmit" }, { wait: 1500 }, { shot: "03-planner" },
    { click: "#addRouteBtn" }, { wait: 600 }, { shot: "04-drawing" },
    { mapClick: [-200, 0] }, { mapClick: [-120, 60] }, { mapDblClick: [-40, 90] }, { wait: 1500 }, { shot: "05-route" },
    { click: "#layersBtn" }, { wait: 600 }, { shot: "06-layers" },
  ] },
  { name: "mobile", path: "/", viewport: [390, 844], steps: [{ wait: 5000 }, { shot: "07-mobile-home" }] },
];

async function up(url) { try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } }

async function main() {
  mkdirSync(OUT, { recursive: true });
  let scenes = args.scenes ? JSON.parse(readFileSync(args.scenes, "utf8")) : DEFAULT_SCENES;
  if (args.only) scenes = scenes.filter((s) => String(args.only).split(",").includes(s.name));

  let server;
  if (!(await up(BASE))) {
    server = spawn("python3", ["-m", "http.server", "8000"], { cwd: REPO, stdio: "ignore" });
    for (let i = 0; i < 30 && !(await up(BASE)); i++) await sleep(200);
  }

  const profile = mkdtempSync(join(tmpdir(), "booot-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio",
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });

  const cleanup = () => { chrome.kill(); server?.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  try {
    let targets;
    for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; } catch {} await sleep(200); }
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map(); const listeners = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      else if (msg.method) listeners.forEach((l) => l(msg));
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
    const once = (method, ms = 30000) => new Promise((res) => { const t = setTimeout(res, ms); listeners.push(function l(m) { if (m.method === method) { clearTimeout(t); listeners.splice(listeners.indexOf(l), 1); res(m); } }); });
    const evalJS = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    const errors = [];
    listeners.push((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.split("\n")[0]); if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text.slice(0, 160)); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

    const mapPoint = async ([dx, dy]) => { const r = await evalJS(`(() => { const b = document.getElementById('map').getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })()`); return [r[0] + dx, r[1] + dy]; };
    const mouse = async (x, y, clickCount = 1) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (let c = 1; c <= clickCount; c++) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: c });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: c });
      }
      await sleep(400);
    };

    for (const scene of scenes) {
      const [w, h] = scene.viewport || [1440, 900];
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
      const loaded = once("Page.loadEventFired");
      await send("Page.navigate", { url: BASE + (scene.path || "/") });
      await loaded;
      for (const step of scene.steps) {
        try {
          if (step.wait) await sleep(step.wait);
          else if (step.click) { await evalJS(`document.querySelector(${JSON.stringify(step.click)}).click()`); await sleep(400); }
          else if (step.hover) { const [x, y] = await evalJS(`(() => { const b = document.querySelector(${JSON.stringify(step.hover)}).getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })()`); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await sleep(400); }
          else if (step.type) { const [sel, text] = step.type; await evalJS(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); })()`); }
          else if (step.eval) await evalJS(step.eval);
          else if (step.mapClick) await mouse(...(await mapPoint(step.mapClick)));
          else if (step.mapDblClick) await mouse(...(await mapPoint(step.mapDblClick)), 2);
          else if (step.shot) {
            const { data } = await send("Page.captureScreenshot", { format: "png" });
            const file = join(OUT, `${step.shot}.png`);
            writeFileSync(file, Buffer.from(data, "base64"));
            console.log("shot", file);
          }
        } catch (e) { console.log(`step failed in ${scene.name}:`, JSON.stringify(step), "-", e.message); }
      }
    }
    if (errors.length) console.log("page errors:\n  " + [...new Set(errors)].join("\n  "));
    ws.close();
  } finally { cleanup(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
