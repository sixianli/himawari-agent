import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const mode = process.argv[2];
const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }
  open() {
    return new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
      this.socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const waiting = message.id ? this.pending.get(message.id) : undefined;
        if (waiting) {
          this.pending.delete(message.id);
          if (message.error) waiting.reject(new Error(message.error.message));
          else waiting.resolve(message.result);
          return;
        }
        for (const listener of this.listeners) listener(message);
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  waitFor(match, timeoutMs) {
    return new Promise((resolve, reject) => {
      const listener = (message) => {
        if (!match(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("CDP_EVENT_TIMEOUT"));
      }, timeoutMs);
      this.listeners.add(listener);
    });
  }
}

async function browserEndpoint() {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:9222/json/version");
      return (await response.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("CDP_NOT_READY");
}

const profileExistedBeforeLaunch = existsSync("/tmp/profile");
mkdirSync("/tmp/downloads", { recursive: true });
spawn(
  "chromium",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/profile",
    ...(proxy ? [`--proxy-server=http://${proxy.host}`, "--proxy-bypass-list=site.test"] : []),
    "about:blank",
  ],
  { detached: true, stdio: "ignore" },
).unref();

const cdp = new Cdp(await browserEndpoint());
await cdp.open();
cdp.listeners.add((message) => {
  if (message.method === "Fetch.requestPaused")
    cdp.send("Fetch.continueRequest", { requestId: message.params.requestId }, message.sessionId);
  if (message.method === "Fetch.authRequired")
    cdp.send(
      "Fetch.continueWithAuth",
      {
        requestId: message.params.requestId,
        authChallengeResponse:
          message.params.authChallenge.source === "Proxy" && proxy
            ? {
                response: "ProvideCredentials",
                username: decodeURIComponent(proxy.username),
                password: decodeURIComponent(proxy.password),
              }
            : { response: "CancelAuth" },
      },
      message.sessionId,
    );
});
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send(
  "Fetch.enable",
  { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] },
  sessionId,
);

async function navigate(url) {
  const loaded = cdp
    .waitFor(
      (message) => message.method === "Page.loadEventFired" && message.sessionId === sessionId,
      30_000,
    )
    .catch(() => null);
  const result = await cdp.send("Page.navigate", { url }, sessionId);
  if (result.errorText) return { error: result.errorText };
  await loaded;
  const text = await cdp.send(
    "Runtime.evaluate",
    { expression: "document.title + '|' + document.body.innerText", returnByValue: true },
    sessionId,
  );
  return { text: String(text.result.value).trim() };
}

const result = { profileExistedBeforeLaunch };
if (mode === "full") {
  result.setCookie = await navigate("http://site.test:8080/set");
  result.showCookie = await navigate("http://site.test:8080/show");
  result.approved = await navigate("https://example.com/");
  result.unapproved = await navigate("https://example.org/");
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: "/tmp/downloads",
    eventsEnabled: true,
  });
  const progress = cdp.waitFor(
    (message) => message.method === "Browser.downloadProgress" && message.params.receivedBytes > 0,
    30_000,
  );
  cdp.send("Page.navigate", { url: "http://site.test:8080/download" }, sessionId);
  result.downloadReceivedBytes = (await progress).params.receivedBytes;
} else {
  result.showCookie = await navigate("http://site.test:8080/show");
}
console.log(`result=${JSON.stringify(result)}`);
process.exit(0);
