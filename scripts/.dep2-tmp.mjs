import { spawn } from "node:child_process";
import { webkit } from "playwright";
const repo = "/home/user/himawari-agent";
const m = await import(repo + "/scripts/qualify-control-center-browser.mjs");
const server = spawn(process.execPath, ["test/e2e/fixtures/control-center-browser-server.mjs"], { cwd: repo, env: { ...process.env, HIMAWARI_BROWSER_FIXTURE_PORT: "0", HIMAWARI_BROWSER_STATIC_ROOT: repo + "/apps/control-center/dist" }, stdio: ["ignore", "pipe", "inherit"] });
const baseUrl = await new Promise((r) => { let o = ""; server.stdout.on("data", (c) => { o += c; const x = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(o); if (x) r(x[1]); }); });
const b = await webkit.launch(); let ok = 0, fail = 0;
for (let i = 0; i < Number(process.argv[2]); i++) {
  const c = await b.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 800 } }); const p = await c.newPage();
  const log = []; const t0 = Date.now();
  p.on("request", (r) => { if (r.isNavigationRequest() || r.url().includes("config")) log.push(`${Date.now()-t0} req ${new URL(r.url()).pathname}`); });
  p.on("requestfailed", (r) => log.push(`${Date.now()-t0} failed ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  p.on("requestfinished", (r) => { if (r.url().includes("config")) log.push(`${Date.now()-t0} finished ${new URL(r.url()).pathname}`); });
  try { const mode = process.argv[3];
    if (mode === "route") await p.route("**/api/control-center/v1/config", async (route) => { const response = await route.fetch(); await route.fulfill({ response, json: await response.json() }); });
    if (mode === "continue") await p.route("**/api/control-center/v1/config", (route) => route.continue());
    for (const r of ["/tasks","/inbox","/capabilities","/authorizations","/workspaces","/suggestions","/reflection","/workers","/improvements","/trace","/sessions"]) { await p.goto(baseUrl + r); await p.getByText("找不到这个页面", { exact: true }).waitFor(); }
    ok++; } catch (e) { fail++; console.log("FAIL", String(e.message).split("\n")[0]); console.log(log.slice(-14).join("\n")); }
  await c.close();
}
console.log({ ok, fail }); await b.close(); server.kill();
