#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_DIR = dirname(fileURLToPath(import.meta.url));
export const GATEWAY_LOCK_PATH = join(GATEWAY_DIR, "gateway-lock.json");
export const GATEWAY_CONFIG_PATH = join(GATEWAY_DIR, "gateway.json");
export const GATEWAY_FEED_URL = "https://usemagpie.ai/api/latest";
export const GATEWAY_PLATFORMS = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];
export const PLACEHOLDER = "proxy-injected";
export const CLIENT_KEY = "magpie-himawari-review";
export const GATEWAY_PROVIDER_ID = "magpie";
export const WORKBUDDY_ENDPOINT = "https://www.workbuddy.ai";
export const WORKBUDDY_DESKTOP_FILE = join(
  ".local",
  "share",
  "CodeBuddyExtension",
  "Data",
  "Public",
  "auth",
  "workbuddy-desktop-ai.info",
);
export const DESKTOP_SIGN_IN_METHOD = "WorkBuddy AI desktop's sign-in";
export const GATEWAY_KEPT_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readGatewayLock(path = GATEWAY_LOCK_PATH) {
  return readJson(path);
}

export const ROUTING_VALUES = ["order", "smart", "rotate", "usage", "pace", "weight", "fast"];
export const STAYS_VALUES = ["auto", "session", "turn", "off", "strict"];
export const PROVIDER_KINDS = ["plugin", "preset", "custom"];

const nonNegative = (value) => Number.isFinite(value) && value >= 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export function gatewayConfigProblems(config, requiredModels = []) {
  const problems = [];
  if (!config || typeof config !== "object") return ["config"];
  if (!ROUTING_VALUES.includes(config.routing)) problems.push("routing");
  if (!STAYS_VALUES.includes(config.stays)) problems.push("stays");
  if (!(Number.isFinite(config.creditFloor) && config.creditFloor > 0))
    problems.push("creditFloor");
  if (!(Number.isFinite(config.defaultCreditsPerUsd) && config.defaultCreditsPerUsd > 0))
    problems.push("defaultCreditsPerUsd");
  const providers = Array.isArray(config.providers) ? config.providers : [];
  if (providers.length === 0) problems.push("providers");
  const ids = providers.map((provider) => provider?.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !id))
    problems.push("providers.id");
  for (const provider of providers) {
    if (!PROVIDER_KINDS.includes(provider?.kind)) problems.push(`providers.${provider?.id}.kind`);
    if (
      provider?.kind === "custom" &&
      !(typeof provider.url === "string" && Array.isArray(provider.models))
    )
      problems.push(`providers.${provider.id}.custom`);
  }
  const creditProvider = providers.find((provider) => provider?.id === config.creditProvider);
  if (!(creditProvider?.kind === "plugin" && creditProvider.signIn))
    problems.push("creditProvider");
  const models = config.models && typeof config.models === "object" ? config.models : {};
  for (const model of requiredModels)
    if (!Object.hasOwn(models, model)) problems.push(`models.${model}`);
  for (const [model, entry] of Object.entries(models)) {
    const members = Array.isArray(entry?.members) ? entry.members : [];
    if (
      members.length === 0 ||
      members.some(
        (member) =>
          typeof member !== "string" ||
          !ids.includes(member.split("/")[0]) ||
          !member.includes("/"),
      )
    )
      problems.push(`models.${model}.members`);
    if (
      typeof entry?.name !== "string" ||
      !positiveInteger(entry?.context) ||
      !positiveInteger(entry?.output)
    )
      problems.push(`models.${model}.limits`);
    if (!["input", "output", "cache_read"].every((key) => nonNegative(entry?.cost?.[key])))
      problems.push(`models.${model}.cost`);
  }
  return problems;
}

export function readGatewayConfig(path = GATEWAY_CONFIG_PATH, requiredModels = []) {
  const config = readJson(path);
  const problems = gatewayConfigProblems(config, requiredModels);
  if (problems.length > 0) throw new Error(`GATEWAY_CONFIG_INVALID ${problems.join(",")}`);
  return config;
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "darwin" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !cpu) throw new Error(`GATEWAY_PLATFORM_UNSUPPORTED ${platform}-${arch}`);
  return `${os}-${cpu}`;
}

export function lockFromRelease({ feed, plugin }) {
  const assets = {};
  for (const key of GATEWAY_PLATFORMS) {
    const asset = feed?.assets?.[`magpie-cli-${key}`];
    if (!asset?.url || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? ""))
      throw new Error(`GATEWAY_FEED_INCOMPLETE magpie-cli-${key}`);
    assets[key] = { url: asset.url, sha256: asset.sha256 };
  }
  if (!/^\d+\.\d+\.\d+$/.test(feed?.version ?? ""))
    throw new Error("GATEWAY_FEED_INCOMPLETE version");
  if (!plugin?.name || !plugin.version || !/^sha512-/.test(plugin.integrity ?? ""))
    throw new Error("GATEWAY_PLUGIN_INCOMPLETE");
  return {
    magpie: { version: feed.version, assets },
    plugin: { name: plugin.name, version: plugin.version, integrity: plugin.integrity },
  };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function npmIntegrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

export function gatewayInstallDir(lock) {
  const digest = createHash("sha256").update(JSON.stringify(lock)).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", `himawari-magpie-${lock.magpie.version}-${digest}`);
}

function curlDownload(url, target) {
  const result = spawnSync("curl", ["-fsSL", "--retry", "2", "-o", target, url], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`GATEWAY_DOWNLOAD_FAILED ${url} ${result.stderr.trim()}`);
}

function npmPack(spec, destination) {
  const result = spawnSync(
    "npm",
    ["pack", spec, "--pack-destination", destination, "--json", "--silent"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`GATEWAY_PLUGIN_DOWNLOAD_FAILED ${spec}`);
  const [packed] = JSON.parse(result.stdout);
  return join(destination, packed.filename);
}

function extractTarball(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", destination], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`GATEWAY_PLUGIN_EXTRACT_FAILED ${result.stderr.trim()}`);
}

export function installGateway({
  lock = readGatewayLock(),
  prefix = gatewayInstallDir(lock),
  platform = platformKey(),
  download = curlDownload,
  pack = npmPack,
} = {}) {
  const asset = lock.magpie.assets[platform];
  if (!asset) throw new Error(`GATEWAY_PLATFORM_UNSUPPORTED ${platform}`);
  mkdirSync(prefix, { recursive: true });
  const binary = join(prefix, "magpie");
  if (!existsSync(binary) || sha256File(binary) !== asset.sha256) {
    rmSync(binary, { force: true });
    const partial = `${binary}.download`;
    rmSync(partial, { force: true });
    download(asset.url, partial);
    const got = sha256File(partial);
    if (got !== asset.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`GATEWAY_INTEGRITY_MISMATCH magpie expected=${asset.sha256} got=${got}`);
    }
    chmodSync(partial, 0o555);
    renameSync(partial, binary);
  }
  const pluginRoot = join(prefix, "plugin");
  const pluginDir = join(pluginRoot, "package");
  const marker = join(prefix, "plugin.integrity");
  const installedIntegrity = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (
    installedIntegrity !== lock.plugin.integrity ||
    !existsSync(join(pluginDir, "package.json"))
  ) {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(marker, { force: true });
    const packDir = join(prefix, "pack");
    rmSync(packDir, { recursive: true, force: true });
    mkdirSync(packDir, { recursive: true });
    const tarball = pack(`${lock.plugin.name}@${lock.plugin.version}`, packDir);
    const got = npmIntegrity(tarball);
    if (got !== lock.plugin.integrity) {
      rmSync(packDir, { recursive: true, force: true });
      throw new Error(
        `GATEWAY_INTEGRITY_MISMATCH plugin expected=${lock.plugin.integrity} got=${got}`,
      );
    }
    extractTarball(tarball, pluginRoot);
    rmSync(packDir, { recursive: true, force: true });
    writeFileSync(marker, `${lock.plugin.integrity}\n`);
  }
  const cacheDir = join(prefix, "cache");
  mkdirSync(cacheDir, { recursive: true });
  return { binary, binarySha256: asset.sha256, pluginDir, cacheDir, version: lock.magpie.version };
}

export function binaryProblem(install) {
  if (!existsSync(install.binary)) return `GATEWAY_BINARY_CHANGED missing ${install.binary}`;
  const got = sha256File(install.binary);
  return got === install.binarySha256 ? null : `GATEWAY_BINARY_CHANGED ${got}`;
}

export function gatewayEnv({ root, cacheDir, port, env = process.env }) {
  const kept = Object.fromEntries(
    GATEWAY_KEPT_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
  return {
    ...kept,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: cacheDir,
    DO_NOT_TRACK: "1",
    MAGPIE_NO_STATS: "1",
    NODE_USE_ENV_PROXY: "1",
    ...(port ? { MAGPIE_ADDR: `127.0.0.1:${port}` } : {}),
  };
}

export function magpie(binary, args, env, { input } = {}) {
  const result = spawnSync(binary, args, {
    env,
    encoding: "utf8",
    input: input ?? "",
    timeout: 180000,
    maxBuffer: 1 << 26,
  });
  if (result.status !== 0) {
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | ");
    throw new Error(`GATEWAY_COMMAND_FAILED magpie ${args.join(" ")}: ${text}`);
  }
  return result.stdout;
}

export function groupId(model) {
  return model.split("/").pop();
}

export function groupName(model) {
  return `review-${groupId(model)}`;
}

export function groupArgs(config, model, { dropProviders = [], members } = {}) {
  const entry = config.models[model];
  if (!entry) throw new Error(`GATEWAY_MODEL_UNKNOWN ${model}`);
  const list = (members ?? entry.members).filter(
    (member) => !dropProviders.includes(member.split("/")[0]),
  );
  if (list.length === 0) throw new Error(`GATEWAY_NO_MEMBERS ${model}`);
  return [
    "group",
    "add",
    groupName(model),
    `models=${list.join(",")}`,
    `routing=${config.routing}`,
    `stays=${config.stays}`,
  ];
}

export function desktopSignIn({ uid, now = Date.now(), days = 30 }) {
  return {
    auth: {
      accessToken: PLACEHOLDER,
      refreshToken: "",
      expiresAt: now + days * 24 * 3600 * 1000,
      domain: new URL(WORKBUDDY_ENDPOINT).host,
      tokenType: "Bearer",
    },
    account: { uid, nickname: uid },
  };
}

export function creditsLeft(quotas, provider) {
  const entry = (Array.isArray(quotas) ? quotas : []).find((item) => item?.provider === provider);
  const windows = Array.isArray(entry?.windows) ? entry.windows : [];
  const window =
    windows.find((item) => item?.name === "Total credits") ??
    (windows.length === 1 && windows[0]?.unit === "credits" ? windows[0] : undefined);
  if (!window) return null;
  const { limit, remaining, amount } = window;
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit < 0) return null;
  if (remaining < 0 || remaining > 100) return null;
  const left = (limit * remaining) / 100;
  if (amount !== undefined && !(Number.isFinite(amount) && Math.abs(limit - amount - left) <= 0.5))
    return null;
  return left;
}

export function creditsPerUsd(records, provider, fallback) {
  const ratios = records
    .filter((record) => record.gateway === "magpie" && record.cost > 0)
    .filter((record) => {
      const used = Object.keys(record.providers ?? {});
      return used.length === 1 && used[0] === provider;
    })
    .map((record) => record.providers[provider].credits / record.cost)
    .filter((ratio) => Number.isFinite(ratio) && ratio >= 0);
  return Math.max(fallback, ...ratios);
}

export function creditReserve({ records, models, costLimitUsd, provider, fallback }) {
  return models.length * costLimitUsd * creditsPerUsd(records, provider, fallback);
}

export function floorDecision({ left, reserve, floor }) {
  if (left === null || left === undefined) return { use: false, reason: "credits-unknown" };
  if (![left, reserve, floor].every(Number.isFinite))
    return { use: false, reason: "floor-invalid" };
  if (left - reserve < floor)
    return {
      use: false,
      reason: `credits-low left=${left.toFixed(2)} reserve=${reserve.toFixed(2)} floor=${floor}`,
    };
  return { use: true, reason: null };
}

export function priceOf(config, model) {
  return config.models[model]?.cost ?? null;
}

const tokens = (value) => (value === undefined ? 0 : nonNegative(value) ? value : Number.NaN);
const required = (value) => (nonNegative(value) ? value : Number.NaN);

export function summarizeGatewayUsage(lines, config) {
  const known = new Set(config.providers.map((provider) => provider.id));
  const byModel = new Map();
  let unreadable = 0;
  for (const line of lines) {
    if (!line || typeof line !== "object") {
      unreadable += 1;
      continue;
    }
    const requested = typeof line.req === "string" ? line.req : "";
    if (!requested.startsWith("group/")) continue;
    const model = Object.keys(config.models).find((name) => groupName(name) === requested.slice(6));
    if (!model) continue;
    const provider = known.has(line.provider) ? line.provider : line.provider ? "unknown" : "none";
    if (!byModel.has(model)) byModel.set(model, new Map());
    const slots = byModel.get(model);
    if (!slots.has(provider)) slots.set(provider, { requests: 0, failed: 0 });
    const slot = slots.get(provider);
    slot.requests += 1;
    const answered = line.status >= 200 && line.status < 300;
    if (!answered) slot.failed += 1;
    const count = answered ? required : tokens;
    if (!known.has(provider)) {
      if (provider !== "none" || answered) unreadable += 1;
    } else if (provider === config.creditProvider) {
      const credits = count(line.credits);
      if (Number.isNaN(credits)) unreadable += 1;
      else slot.credits = (slot.credits ?? 0) + credits;
    } else {
      const price = priceOf(config, model);
      const usd =
        (count(line.in) * price.input +
          (count(line.out) + tokens(line.reasoning)) * price.output +
          tokens(line.cache_read) * price.cache_read) /
        1e6;
      if (Number.isNaN(usd)) unreadable += 1;
      else slot.usd = (slot.usd ?? 0) + usd;
    }
  }
  const summary = Object.fromEntries(
    [...byModel].map(([model, slots]) => [model, Object.fromEntries(slots)]),
  );
  return { byModel: summary, unreadable };
}

export function readGatewayUsage(root) {
  const path = join(root, "config", "magpie", "usage.jsonl");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = [];
  for (const entry of text.split("\n")) {
    if (!entry.trim()) continue;
    try {
      lines.push(JSON.parse(entry));
    } catch {
      return null;
    }
  }
  return lines;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

export function getJson(url, timeoutMs = 5000) {
  return new Promise((resolveGet) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolveGet({ status: response.statusCode, json: JSON.parse(body) });
        } catch {
          resolveGet({ status: response.statusCode, json: null });
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolveGet({ status: 0, json: null }));
  });
}

export function postJson(url, payload, timeoutMs = 60000) {
  return new Promise((resolvePost) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      url,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${CLIENT_KEY}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolvePost({ status: response.statusCode, headers: response.headers, text }),
        );
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolvePost({ status: 0, headers: {}, text: "" }));
    request.end(body);
  });
}

async function waitForGateway(port, child, failed, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || failed()) return false;
    const { status } = await getJson(`http://127.0.0.1:${port}/v1/models`, 2000);
    if (status === 200) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

export function workbuddyAccountUid(env = process.env) {
  const result = spawnSync(
    "curl",
    [
      "-fsS",
      "-m",
      "30",
      `${WORKBUDDY_ENDPOINT}/v2/plugin/accounts`,
      "-H",
      `Authorization: Bearer ${PLACEHOLDER}`,
      "-H",
      `X-Domain: ${new URL(WORKBUDDY_ENDPOINT).host}`,
      "-H",
      "Accept: application/json",
    ],
    { encoding: "utf8", env },
  );
  if (result.status !== 0) return null;
  try {
    const body = JSON.parse(result.stdout);
    const accounts = body?.data?.accounts ?? body?.accounts ?? [];
    const personal = accounts.filter((item) => typeof item?.uid === "string" && item.uid);
    const pick = personal.find((item) => item.lastLogin) ?? personal[0];
    return pick?.uid ?? null;
  } catch {
    return null;
  }
}

const runningGateways = new Set();

function killGateway(child) {
  runningGateways.delete(child);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

export function stopAllGateways() {
  for (const child of [...runningGateways]) killGateway(child);
}

export function runningGatewayCount() {
  return runningGateways.size;
}

export async function startGateway({
  install,
  config,
  root,
  models,
  providers,
  dropProviders = [],
  members,
  log = () => {},
}) {
  for (const dir of ["home", "config", "data", "state"])
    mkdirSync(join(root, dir), { recursive: true });
  const port = await freePort();
  const env = gatewayEnv({ root, cacheDir: install.cacheDir, port });
  for (const provider of providers) {
    if (provider.kind === "plugin")
      magpie(install.binary, ["plugin", "add", install.pluginDir], env);
    else if (provider.kind === "preset") {
      magpie(install.binary, ["provider", "add", provider.id, PLACEHOLDER], env);
      if (provider.url)
        magpie(install.binary, ["provider", "set", provider.id, `url=${provider.url}`], env);
    } else if (provider.kind === "custom") {
      magpie(
        install.binary,
        [
          "provider",
          "add",
          provider.id,
          `url=${provider.url}`,
          "key=probe",
          `models=${provider.models.join(",")}`,
        ],
        env,
      );
    }
    if (provider.signIn) {
      const file = join(root, "home", WORKBUDDY_DESKTOP_FILE);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(desktopSignIn({ uid: provider.signIn.uid })), {
        mode: 0o600,
      });
      magpie(install.binary, ["plugin", "login", provider.id, DESKTOP_SIGN_IN_METHOD], env);
    }
  }
  const quota = (provider) => {
    try {
      return creditsLeft(
        JSON.parse(magpie(install.binary, ["quota", provider, "--json"], env)),
        provider,
      );
    } catch {
      return null;
    }
  };
  const addGroups = (drop) => {
    for (const model of models)
      magpie(
        install.binary,
        groupArgs(config, model, { dropProviders: drop, members: members?.[model] }),
        env,
      );
  };
  let child = null;
  const serve = async () => {
    child = spawn(install.binary, ["serve"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    runningGateways.add(child);
    let stderr = "";
    let spawnError = null;
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    if (!(await waitForGateway(port, child, () => spawnError !== null))) {
      stop();
      throw new Error(
        `GATEWAY_START_FAILED ${spawnError ?? stderr.trim().split("\n").slice(-2).join(" | ")}`,
      );
    }
    log(`GATEWAY_LISTENING 127.0.0.1:${port} magpie=${install.version}`);
  };
  const stop = () => {
    if (!child) return;
    killGateway(child);
    child = null;
  };
  return {
    port,
    env,
    baseURL: `http://127.0.0.1:${port}/v1`,
    quota,
    addGroups: (drop = dropProviders) => addGroups(drop),
    serve,
    stop,
    child: () => child,
    usage: () => readGatewayUsage(root),
  };
}

async function upgrade() {
  const feedText = spawnSync("curl", ["-fsSL", GATEWAY_FEED_URL], { encoding: "utf8" });
  if (feedText.status !== 0) throw new Error(`GATEWAY_FEED_FAILED ${feedText.stderr.trim()}`);
  const current = existsSync(GATEWAY_LOCK_PATH) ? readGatewayLock() : null;
  const name = current?.plugin?.name ?? "@magpie-community/opencode-workbuddy-auth";
  const view = spawnSync("npm", ["view", name, "version", "dist.integrity", "--json"], {
    encoding: "utf8",
  });
  if (view.status !== 0) throw new Error(`GATEWAY_PLUGIN_VIEW_FAILED ${name}`);
  const info = JSON.parse(view.stdout);
  const lock = lockFromRelease({
    feed: JSON.parse(feedText.stdout),
    plugin: { name, version: info.version, integrity: info["dist.integrity"] },
  });
  writeFileSync(GATEWAY_LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`GATEWAY_LOCK magpie=${lock.magpie.version} plugin=${lock.plugin.version}`);
}

function warmPluginRuntime(install) {
  const root = mkdtempSync(join(tmpdir(), "himawari-magpie-warm-"));
  try {
    for (const dir of ["home", "config", "data", "state"])
      mkdirSync(join(root, dir), { recursive: true });
    magpie(
      install.binary,
      ["plugin", "add", install.pluginDir],
      gatewayEnv({ root, cacheDir: install.cacheDir }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === "upgrade") return upgrade();
  if (command === "install") {
    const install = installGateway();
    warmPluginRuntime(install);
    console.log(`GATEWAY_INSTALLED ${install.binary} magpie=${install.version}`);
    return;
  }
  throw new Error("usage: gateway.mjs install | upgrade");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
