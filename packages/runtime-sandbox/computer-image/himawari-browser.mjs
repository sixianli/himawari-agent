import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ACTIONS = new Set([
  "open",
  "read",
  "click",
  "type",
  "press",
  "back",
  "screenshot",
  "status",
  "vault_check",
  "vault_fill",
]);
const VAULT_FIELDS = ["username", "password", "code"];
const VAULT_VALUE_LIMIT = 4096;
const TEXT_INPUT_TYPES = new Set(["", "text", "email", "tel", "number", "search", "url"]);
const HIDDEN_MARK = "[hidden]";
const REF_ATTRIBUTE = "data-himawari-ref";
const REF_PATTERN = /^(?:f([1-9][0-9]{0,2}))?e([1-9][0-9]{0,5})$/;
const EGRESS_DENIED_HEADER = "x-himawari-egress-error";
const KEY_PATTERN = /^[A-Za-z0-9+]{1,40}$/;
const BLOCKED_ERRORS = [
  "net::ERR_TUNNEL_CONNECTION_FAILED",
  "net::ERR_PROXY_CONNECTION_FAILED",
  "net::ERR_PROXY_AUTH_UNSUPPORTED",
];

function browserHome() {
  const home = process.env["HOME"];
  if (!home || !path.isAbsolute(home)) throw new BrowserError("BROWSER_HOME_UNAVAILABLE");
  return path.join(home, ".himawari", "browser");
}

function paths() {
  const root = browserHome();
  return {
    root,
    profile: path.join(root, "profile"),
    socket: path.join(root, "control.sock"),
    log: path.join(root, "daemon.log"),
  };
}

class BrowserError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function proxyFromEnvironment(environment) {
  const raw = environment["HTTPS_PROXY"] || environment["https_proxy"] || environment["HTTP_PROXY"];
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "http:") throw new BrowserError("BROWSER_PROXY_UNSUPPORTED");
  const user = decodeURIComponent(url.username);
  const secret = decodeURIComponent(url.password);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(user ? { username: user } : {}),
    ...(secret ? { password: secret } : {}),
  };
}

const CLOSED_PROXY = { server: "http://127.0.0.1:9" };

export function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new BrowserError("BROWSER_INPUT_INVALID");
  const { action } = request;
  if (!ACTIONS.has(action)) throw new BrowserError("BROWSER_INPUT_INVALID", "action");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
    throw new BrowserError("BROWSER_INPUT_INVALID", "timeoutMs");
  if (!Number.isSafeInteger(request.maxTextChars) || request.maxTextChars < 1)
    throw new BrowserError("BROWSER_INPUT_INVALID", "maxTextChars");
  if (action === "open") {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      throw new BrowserError("BROWSER_INPUT_INVALID", "url");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new BrowserError("BROWSER_INPUT_INVALID", "url");
  }
  if ((action === "click" || action === "type") && !REF_PATTERN.test(String(request.ref)))
    throw new BrowserError("BROWSER_INPUT_INVALID", "ref");
  if (action === "type" && typeof request.text !== "string")
    throw new BrowserError("BROWSER_INPUT_INVALID", "text");
  if (action === "type" && request.submit !== undefined && typeof request.submit !== "boolean")
    throw new BrowserError("BROWSER_INPUT_INVALID", "submit");
  if (action === "press" && !KEY_PATTERN.test(String(request.key)))
    throw new BrowserError("BROWSER_INPUT_INVALID", "key");
  if (action === "vault_check" || action === "vault_fill") validateVaultRequest(request);
  return request;
}

function validateVaultRequest(request) {
  const fields = request.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new BrowserError("BROWSER_INPUT_INVALID", "fields");
  const names = Object.keys(fields);
  if (names.length === 0 || names.some((name) => !VAULT_FIELDS.includes(name)))
    throw new BrowserError("BROWSER_INPUT_INVALID", "fields");
  for (const name of names) {
    const match = REF_PATTERN.exec(String(fields[name]));
    if (!match || match[1]) throw new BrowserError("VAULT_FIELD_NOT_ALLOWED", name);
  }
  if (new Set(names.map((name) => fields[name])).size !== names.length)
    throw new BrowserError("BROWSER_INPUT_INVALID", "fields");
  if (request.action === "vault_check") return;
  const values = request.values;
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new BrowserError("BROWSER_INPUT_INVALID", "values");
  const valueNames = Object.keys(values);
  if (
    valueNames.length !== names.length ||
    valueNames.some(
      (name) =>
        !names.includes(name) ||
        typeof values[name] !== "string" ||
        values[name].length === 0 ||
        values[name].length > VAULT_VALUE_LIMIT,
    )
  )
    throw new BrowserError("BROWSER_INPUT_INVALID", "values");
  if (typeof request.origin !== "string" || typeof request.pageVersion !== "string")
    throw new BrowserError("BROWSER_INPUT_INVALID", "expected");
  if (request.submit !== undefined && typeof request.submit !== "boolean")
    throw new BrowserError("BROWSER_INPUT_INVALID", "submit");
}

function secretVariants(value) {
  const variants = new Set([
    value,
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    Buffer.from(value, "utf8").toString("hex"),
    JSON.stringify(value).slice(1, -1),
  ]);
  return [...variants].filter((variant) => variant.length > 0).sort((a, b) => b.length - a.length);
}

export function maskSecrets(text, values) {
  let masked = text;
  for (const value of values)
    for (const variant of secretVariants(value)) masked = masked.split(variant).join(HIDDEN_MARK);
  return masked;
}

function describeVaultTarget(element) {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const visible =
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) > 0 &&
    box.width > 0 &&
    box.height > 0;
  const form = element.form ?? null;
  let formOrigin = location.origin;
  if (form) {
    try {
      formOrigin = new URL(form.action, location.href).origin;
    } catch {
      formOrigin = "";
    }
  }
  return {
    tag: element.tagName,
    type: (element.getAttribute("type") || "").toLowerCase(),
    inDocument: element.getRootNode() === document,
    visible,
    disabled: Boolean(element.disabled || element.readOnly),
    formOrigin,
    formIndex: form ? [...document.forms].indexOf(form) : -1,
  };
}

function snapshotScript({ attribute, prefix }) {
  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "option",
    "switch",
    "textbox",
    "combobox",
    "searchbox",
  ]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD"]);
  for (const old of document.querySelectorAll(`[${attribute}]`)) old.removeAttribute(attribute);
  const lines = [];
  let current = "";
  let counter = 0;
  const flush = () => {
    const text = current.replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
    current = "";
  };
  const hidden = (element) => {
    if (element.getAttribute("aria-hidden") === "true" || element.hidden) return true;
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  };
  const roleOf = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit && INTERACTIVE_ROLES.has(explicit)) return explicit;
    const tag = element.tagName;
    if (tag === "A" && element.hasAttribute("href")) return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (element.isContentEditable && element.getAttribute("contenteditable") !== null)
      return "textbox";
    return null;
  };
  const nameOf = (element) => {
    const label =
      element.getAttribute("aria-label") ||
      element.labels?.[0]?.innerText ||
      (element.tagName === "INPUT" ? "" : element.innerText) ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      element.getAttribute("alt") ||
      (element.tagName === "INPUT" &&
      ["button", "submit", "reset"].includes((element.getAttribute("type") || "").toLowerCase())
        ? element.value
        : "") ||
      "";
    const text = label.replace(/\s+/g, " ").trim();
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
  };
  const stateOf = (element, role) => {
    const parts = [];
    if (role === "textbox" || role === "searchbox" || role === "combobox") {
      const type = (element.getAttribute("type") || "").toLowerCase();
      const value =
        element.tagName === "SELECT"
          ? element.options[element.selectedIndex]?.text || ""
          : element.isContentEditable
            ? element.innerText
            : element.value || "";
      if (type === "password") parts.push(value ? "value hidden" : "empty");
      else parts.push(value ? `value "${value.replace(/\s+/g, " ").slice(0, 100)}"` : "empty");
    }
    if (role === "checkbox" || role === "radio" || role === "switch")
      parts.push(
        element.checked || element.getAttribute("aria-checked") === "true"
          ? "checked"
          : "unchecked",
      );
    if (element.disabled || element.getAttribute("aria-disabled") === "true")
      parts.push("disabled");
    return parts.length ? ` (${parts.join(", ")})` : "";
  };
  const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption)$/;
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += ` ${node.textContent}`;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (SKIP.has(element.tagName.toUpperCase()) || hidden(element)) return;
    const role = roleOf(element);
    if (role) {
      counter += 1;
      const ref = `${prefix}e${counter}`;
      element.setAttribute(attribute, ref);
      current += ` [${ref} ${role} "${nameOf(element)}"${stateOf(element, role)}]`;
      if (element.tagName !== "SELECT") return;
      return;
    }
    if (element.tagName === "IFRAME") {
      current += " [frame]";
      return;
    }
    const block = BLOCK.test(getComputedStyle(element).display) || element.tagName === "BR";
    if (block) flush();
    for (const child of element.childNodes) walk(child);
    if (block) flush();
  };
  if (document.body) walk(document.body);
  flush();
  return lines.join("\n");
}

class BrowserSession {
  #context = null;
  #proxyKey = null;
  #page = null;
  #blocked = new Set();
  #deniedNavigation = null;

  #deny(request) {
    let host;
    try {
      host = new URL(request.url()).host;
    } catch {
      return;
    }
    this.#blocked.add(host);
    const frame = request.frame();
    if (request.isNavigationRequest() && frame.parentFrame() === null)
      this.#deniedNavigation = host;
  }

  #throwIfDenied() {
    const host = this.#deniedNavigation;
    if (host !== null) throw new BrowserError("BROWSER_SITE_NOT_ALLOWED", host);
  }

  async ensure(proxy, files) {
    const effective = proxy ?? CLOSED_PROXY;
    const key = JSON.stringify(effective);
    if (this.#context && this.#proxyKey === key) return;
    await this.close();
    await mkdir(files.profile, { recursive: true, mode: 0o700 });
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
      await rm(path.join(files.profile, name), { force: true });
    const executablePath = process.env["HIMAWARI_BROWSER_EXECUTABLE"] || undefined;
    this.#context = await chromium.launchPersistentContext(files.profile, {
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ...(executablePath ? { executablePath } : {}),
      chromiumSandbox: process.env["HIMAWARI_BROWSER_CHROMIUM_SANDBOX"] === "1",
      proxy: effective,
      args: ["--proxy-bypass-list=<-loopback>", "--disable-dev-shm-usage"],
    });
    this.#proxyKey = key;
    this.#context.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText ?? "";
      if (BLOCKED_ERRORS.some((code) => failure.includes(code))) this.#deny(request);
    });
    this.#context.on("response", (response) => {
      if (response.headers()[EGRESS_DENIED_HEADER]) this.#deny(response.request());
    });
    this.#context.on("page", (page) => {
      this.#page = page;
    });
    const pages = this.#context.pages();
    this.#page = pages[pages.length - 1] ?? (await this.#context.newPage());
  }

  async close() {
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    this.#proxyKey = null;
    if (context) await context.close().catch(() => undefined);
  }

  page() {
    let page = this.#page;
    if (!page || page.isClosed()) {
      const open = this.#context?.pages().filter((candidate) => !candidate.isClosed()) ?? [];
      page = open[open.length - 1] ?? null;
      this.#page = page;
    }
    if (!page) throw new BrowserError("BROWSER_NO_PAGE");
    return page;
  }

  async run(request, proxy, files) {
    validateRequest(request);
    await this.ensure(proxy, files);
    this.#blocked = new Set();
    this.#deniedNavigation = null;
    if (request.action === "open") {
      const page =
        this.#page && !this.#page.isClosed() ? this.#page : await this.#context.newPage();
      this.#page = page;
      await this.#navigate(() =>
        page.goto(request.url, { waitUntil: "domcontentloaded", timeout: request.timeoutMs }),
      );
      return this.#result(request, true);
    }
    if (request.action === "vault_check") {
      const checked = await this.#vaultCheck(request);
      return { ...(await this.#result(request, false)), ...checked };
    }
    if (request.action === "vault_fill") return this.#vaultFill(request);
    if (request.action === "read") return this.#result(request, true);
    if (request.action === "status") return this.#result(request, false);
    if (request.action === "screenshot") {
      const page = this.page();
      const image = await page.screenshot({ type: "png", timeout: request.timeoutMs });
      return {
        ...(await this.#result(request, false)),
        screenshot: { mimeType: "image/png", data: image.toString("base64") },
      };
    }
    if (request.action === "back") {
      const page = this.page();
      await this.#navigate(() =>
        page.goBack({ waitUntil: "domcontentloaded", timeout: request.timeoutMs }),
      );
      return this.#result(request, true);
    }
    if (request.action === "press") {
      const page = this.page();
      await this.#acting(page, request, () => page.keyboard.press(request.key));
      return this.#result(request, true);
    }
    const page = this.page();
    const target = await this.#locate(page, request.ref);
    if (request.action === "click") {
      await this.#acting(page, request, () => target.click({ timeout: request.timeoutMs }));
      return this.#result(request, true);
    }
    const tag = await target.evaluate((element) => element.tagName);
    await this.#acting(page, request, async () => {
      if (tag === "SELECT")
        await target.selectOption({ label: request.text }, { timeout: request.timeoutMs });
      else await target.fill(request.text, { timeout: request.timeoutMs });
      if (request.submit) await target.press("Enter", { timeout: request.timeoutMs });
    });
    return this.#result(request, true);
  }

  async #vaultCheck(request) {
    const page = this.page();
    let origin;
    try {
      const url = new URL(page.url());
      if (url.protocol !== "https:") throw new Error("scheme");
      origin = url.origin;
    } catch {
      throw new BrowserError("VAULT_PAGE_NOT_HTTPS");
    }
    const described = [];
    for (const name of VAULT_FIELDS) {
      const ref = request.fields[name];
      if (ref === undefined) continue;
      const target = await this.#locate(page, ref);
      const facts = await target.evaluate(describeVaultTarget);
      const textual =
        facts.tag === "TEXTAREA" || (facts.tag === "INPUT" && TEXT_INPUT_TYPES.has(facts.type));
      const fits =
        name === "password"
          ? facts.tag === "INPUT" && facts.type === "password"
          : name === "username"
            ? textual && facts.tag === "INPUT"
            : textual || (facts.tag === "INPUT" && facts.type === "password");
      if (!fits) throw new BrowserError("VAULT_FIELD_NOT_ALLOWED", name);
      if (!facts.inDocument || !facts.visible || facts.disabled)
        throw new BrowserError("VAULT_FIELD_NOT_ALLOWED", name);
      if (facts.formOrigin !== origin) throw new BrowserError("VAULT_FORM_ELSEWHERE", name);
      described.push([name, ref, facts.tag, facts.type, facts.formOrigin, facts.formIndex]);
    }
    const pageVersion = createHash("sha256")
      .update(JSON.stringify([page.url(), described]))
      .digest("hex");
    return { origin, pageVersion };
  }

  async #vaultFill(request) {
    const checked = await this.#vaultCheck(request);
    if (checked.origin !== request.origin || checked.pageVersion !== request.pageVersion)
      throw new BrowserError("VAULT_PAGE_CHANGED");
    const page = this.page();
    const before = page.url();
    const values = Object.values(request.values);
    const filled = [];
    const ordered = VAULT_FIELDS.filter((name) => request.fields[name] !== undefined);
    try {
      await this.#acting(page, request, async () => {
        for (const name of ordered) {
          const target = await this.#locate(page, request.fields[name]);
          await target.fill(request.values[name], { timeout: request.timeoutMs });
          filled.push(target);
        }
        if (request.submit) await filled.at(-1).press("Enter", { timeout: request.timeoutMs });
      });
    } catch (error) {
      if (!page.isClosed() && page.url() === before)
        for (const target of filled) await target.fill("").catch(() => undefined);
      throw new BrowserError(
        error instanceof BrowserError ? error.code : "BROWSER_ACTION_FAILED",
        error instanceof BrowserError ? error.detail : firstLine(error),
      );
    }
    const result = await this.#result(request, true);
    return {
      ...result,
      page: {
        url: maskSecrets(result.page.url, values),
        title: maskSecrets(result.page.title, values),
      },
      text: maskSecrets(result.text, values),
      filled: ordered,
    };
  }

  async #locate(page, ref) {
    const match = REF_PATTERN.exec(ref);
    const frameIndex = match?.[1] ? Number(match[1]) : 0;
    const frame = frameIndex === 0 ? page.mainFrame() : page.frames()[frameIndex];
    if (!frame) throw new BrowserError("BROWSER_REF_UNKNOWN", ref);
    const locator = frame.locator(`[${REF_ATTRIBUTE}="${ref}"]`);
    if ((await locator.count()) !== 1) throw new BrowserError("BROWSER_REF_UNKNOWN", ref);
    return locator;
  }

  async #acting(page, request, act) {
    const before = page.url();
    try {
      await act();
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("BROWSER_ACTION_FAILED", firstLine(error));
    }
    const settle = Math.min(request.timeoutMs, 5000);
    await page.waitForLoadState("domcontentloaded", { timeout: settle }).catch(() => undefined);
    const latest = this.page();
    if (latest !== page || latest.url() !== before)
      await latest.waitForLoadState("domcontentloaded", { timeout: settle }).catch(() => undefined);
    this.#throwIfDenied();
  }

  async #navigate(go) {
    try {
      await go();
    } catch (error) {
      this.#throwIfDenied();
      throw new BrowserError("BROWSER_NAVIGATION_FAILED", firstLine(error));
    }
    this.#throwIfDenied();
  }

  async #result(request, withText) {
    const page = this.page();
    const frames = page.frames();
    let text = "";
    if (withText) {
      const parts = [];
      for (const [index, frame] of frames.entries()) {
        const content = await frame
          .evaluate(snapshotScript, {
            attribute: REF_ATTRIBUTE,
            prefix: index === 0 ? "" : `f${index}`,
          })
          .catch(() => "");
        if (content)
          parts.push(index === 0 ? content : `[frame f${index} ${frame.url()}]\n${content}`);
      }
      text = parts.join("\n");
    }
    const truncated = text.length > request.maxTextChars;
    return {
      ok: true,
      page: { url: page.url(), title: await page.title().catch(() => "") },
      ...(withText
        ? { text: truncated ? text.slice(0, request.maxTextChars) : text, truncated }
        : {}),
      blockedHosts: [...this.#blocked].sort(),
    };
  }
}

function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 300);
}

function failure(error) {
  if (error instanceof BrowserError)
    return {
      ok: false,
      error: { code: error.code, ...(error.detail ? { detail: error.detail } : {}) },
    };
  return { ok: false, error: { code: "BROWSER_FAILED", detail: firstLine(error) } };
}

async function daemonAlive(pid) {
  const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  const parts = command.split("\0");
  return parts.includes(fileURLToPath(import.meta.url)) && parts.includes("serve");
}

async function claimDaemon(files) {
  const lock = path.join(files.root, "daemon.pid");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = Number(await readFile(lock, "utf8").catch(() => ""));
      if (
        Number.isSafeInteger(owner) &&
        owner > 0 &&
        owner !== process.pid &&
        (await daemonAlive(owner))
      )
        return false;
      await rm(lock, { force: true });
    }
  }
  return false;
}

async function serve() {
  const files = paths();
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  if (!(await claimDaemon(files))) return;
  await rm(files.socket, { force: true });
  const session = new BrowserSession();
  let queue = Promise.resolve();
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = "";
      queue = queue.then(async () => {
        let response;
        try {
          const message = JSON.parse(line);
          response = await session.run(message.request, message.proxy ?? null, files);
        } catch (error) {
          response = failure(error);
        }
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  });
  const stop = () => {
    server.close();
    void session
      .close()
      .then(() => rm(path.join(files.root, "daemon.pid"), { force: true }))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(files.socket, resolve);
  });
}

function ask(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startDaemon(files) {
  await mkdir(files.root, { recursive: true, mode: 0o700 });
  const log = openSync(files.log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function client() {
  let response;
  try {
    const request = validateRequest(JSON.parse(await readStdin()));
    const files = paths();
    const message = { request, proxy: proxyFromEnvironment(process.env) };
    const deadline = Date.now() + request.timeoutMs;
    let started = false;
    for (;;) {
      try {
        response = await ask(files.socket, message);
        break;
      } catch (error) {
        if (Date.now() >= deadline)
          throw new BrowserError("BROWSER_START_FAILED", firstLine(error));
        if (!started) {
          started = true;
          await startDaemon(files);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } catch (error) {
    response = failure(error);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exitCode = response.ok ? 0 : 1;
}

async function stopDaemon() {
  const files = paths();
  const owner = Number(await readFile(path.join(files.root, "daemon.pid"), "utf8").catch(() => ""));
  if (!Number.isSafeInteger(owner) || owner < 1 || !(await daemonAlive(owner))) return;
  process.kill(owner, "SIGTERM");
  while (await daemonAlive(owner)) await new Promise((resolve) => setTimeout(resolve, 50));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === "serve") await serve();
  else if (process.argv[2] === "stop") await stopDaemon();
  else await client();
}
