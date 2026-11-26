#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const defaultConfig = path.resolve(import.meta.dirname, "cloudflare-public-paths.json");
const apiBase = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
const probeAttempts = Number(process.env.HIMAWARI_PUBLIC_PATHS_PROBE_ATTEMPTS ?? 12);
const probeDelayMs = Number(process.env.HIMAWARI_PUBLIC_PATHS_PROBE_DELAY_MS ?? 5000);

class SyncFailure extends Error {
  constructor(code, detail) {
    super(`${code} ${detail}`);
    this.code = code;
  }
}

function fail(code, detail) {
  throw new SyncFailure(code, detail);
}

function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function normalizePath(value) {
  return value.toLowerCase().replace(/\/\*$/, "").replace(/\/+$/, "");
}

function readConfig(file) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!/^[0-9a-f]{32}$/.test(config.accountId ?? "")) fail("CONFIG_INVALID", "accountId");
  if (!/^[a-z0-9.-]+$/.test(config.hostname ?? "")) fail("CONFIG_INVALID", "hostname");
  for (const key of ["applicationName", "policyName"]) {
    if (typeof config[key] !== "string" || config[key].length === 0) fail("CONFIG_INVALID", key);
  }
  if (!isStringList(config.paths)) fail("CONFIG_INVALID", "paths");
  if (!isStringList(config.retireApplications ?? [])) fail("CONFIG_INVALID", "retireApplications");
  const seen = new Set();
  for (const entry of config.paths) {
    if (!entry.startsWith("/") || /[?#*\s]/.test(entry)) fail("CONFIG_INVALID_PATH", entry);
    const normalized = normalizePath(entry);
    if (normalized === "") fail("CONFIG_PATH_OPENS_WHOLE_SITE", entry);
    if (seen.has(normalized)) fail("CONFIG_DUPLICATE_PATH", entry);
    seen.add(normalized);
  }
  if (config.retireApplications?.includes(config.applicationName)) {
    fail("CONFIG_INVALID", "retireApplications names the managed application");
  }
  const stillGatedPath = config.stillGatedPath ?? "/";
  if (typeof stillGatedPath !== "string" || !stillGatedPath.startsWith("/")) {
    fail("CONFIG_INVALID", "stillGatedPath");
  }
  return { ...config, retireApplications: config.retireApplications ?? [], stillGatedPath };
}

function splitUri(uri) {
  const slash = uri.indexOf("/");
  const host = (slash === -1 ? uri : uri.slice(0, slash)).toLowerCase();
  const rest = slash === -1 ? "" : uri.slice(slash);
  return { host, path: normalizePath(rest) };
}

function destinationsOf(app) {
  if (Array.isArray(app.destinations) && app.destinations.length > 0) {
    return app.destinations
      .filter((item) => item.type === "public" && item.uri)
      .map((item) => item.uri);
  }
  if (Array.isArray(app.self_hosted_domains) && app.self_hosted_domains.length > 0) {
    return app.self_hosted_domains;
  }
  return app.domain ? [app.domain] : [];
}

function overlaps(left, right) {
  if (left.host !== right.host || left.path === "" || right.path === "") return false;
  return (
    left.path === right.path ||
    left.path.startsWith(`${right.path}/`) ||
    right.path.startsWith(`${left.path}/`)
  );
}

function client(token) {
  async function call(method, route, body) {
    const response = await fetch(`${apiBase}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true) {
      fail(
        "CLOUDFLARE_API",
        `${method} ${route} ${response.status} ${JSON.stringify(payload?.errors ?? [])}`,
      );
    }
    return payload;
  }
  async function listAll(route) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const payload = await call("GET", `${route}?page=${page}&per_page=50`);
      items.push(...(payload.result ?? []));
      const totalPages = payload.result_info?.total_pages ?? 1;
      if (page >= totalPages) return items;
    }
  }
  return { call, listAll };
}

function isEveryoneBypass(policy) {
  const include = policy.include ?? [];
  return (
    policy.decision === "bypass" &&
    include.length === 1 &&
    Object.keys(include[0]).join() === "everyone" &&
    (policy.exclude ?? []).length === 0 &&
    (policy.require ?? []).length === 0
  );
}

async function blockedByAccess(url) {
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  await response.body?.cancel();
  return {
    status: response.status,
    blocked:
      response.status >= 300 && response.status < 400 && /cloudflareaccess\.com/i.test(location),
  };
}

async function probe(config) {
  const base = process.env.HIMAWARI_PUBLIC_PATHS_PROBE_BASE ?? `https://${config.hostname}`;
  const results = {};
  for (const entry of config.paths) {
    let last;
    for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
      last = await blockedByAccess(`${base}${entry}`);
      if (!last.blocked) break;
      if (attempt < probeAttempts)
        await new Promise((resolve) => setTimeout(resolve, probeDelayMs));
    }
    if (last.blocked) fail("PATH_STILL_GATED", entry);
    results[entry] = last.status;
  }
  const gated = await blockedByAccess(`${base}${config.stillGatedPath}`);
  if (!gated.blocked)
    fail("GATE_OPEN", `${config.stillGatedPath} answered ${gated.status} without the Access login`);
  results[config.stillGatedPath] = `${gated.status} gated`;
  return results;
}

async function sync({ configFile, planOnly }) {
  const token = process.env.CLOUDFLARE_ACCESS_TOKEN;
  if (!token) fail("TOKEN_MISSING", "CLOUDFLARE_ACCESS_TOKEN");
  const config = readConfig(configFile);
  const { call, listAll } = client(token);
  const account = `/accounts/${config.accountId}/access`;
  const desired = config.paths.map((entry) => `${config.hostname}${entry}`);
  const desiredParts = desired.map(splitUri);

  const apps = await listAll(`${account}/apps`);
  const managed = apps.filter((app) => app.name === config.applicationName);
  if (managed.length > 1) fail("DUPLICATE_APPLICATION", config.applicationName);
  const retiring = apps.filter((app) => config.retireApplications.includes(app.name));
  for (const app of retiring) {
    const foreign = destinationsOf(app).filter((uri) => splitUri(uri).host !== config.hostname);
    if (foreign.length > 0) fail("RETIRE_OUTSIDE_HOST", `${app.name}: ${foreign.join(", ")}`);
  }
  const conflicts = [];
  for (const app of apps) {
    if (app.name === config.applicationName || config.retireApplications.includes(app.name))
      continue;
    for (const uri of destinationsOf(app)) {
      if (desiredParts.some((part) => overlaps(part, splitUri(uri))))
        conflicts.push(`${app.name} -> ${uri}`);
    }
  }
  if (conflicts.length > 0) fail("CONFLICTING_APPLICATION", conflicts.join("; "));

  const plan = {
    managed: managed.length === 1 ? "update" : desired.length > 0 ? "create" : "none",
    destinations: desired,
    retire: retiring.map((app) => app.name),
  };
  if (planOnly) {
    console.log(`PUBLIC_PATHS_PLAN ${JSON.stringify(plan)}`);
    return;
  }

  for (const app of retiring) {
    await call("DELETE", `${account}/apps/${app.id}`);
    console.log(`PUBLIC_PATHS_RETIRED ${app.name}`);
  }

  if (desired.length === 0) {
    if (managed.length === 1) await call("DELETE", `${account}/apps/${managed[0].id}`);
    console.log(
      `PUBLIC_PATHS_OK ${JSON.stringify({ ...plan, managed: managed.length === 1 ? "deleted" : "none" })}`,
    );
    return;
  }

  const policies = await listAll(`${account}/policies`);
  const named = policies.filter((policy) => policy.name === config.policyName);
  if (named.length > 1) fail("DUPLICATE_POLICY", config.policyName);
  let policy = named[0];
  if (policy && !isEveryoneBypass(policy)) fail("POLICY_UNEXPECTED", config.policyName);
  if (!policy) {
    policy = (
      await call("POST", `${account}/policies`, {
        name: config.policyName,
        decision: "bypass",
        include: [{ everyone: {} }],
      })
    ).result;
  }

  const body = {
    name: config.applicationName,
    type: "self_hosted",
    domain: desired[0],
    destinations: desired.map((uri) => ({ type: "public", uri })),
    policies: [{ id: policy.id, precedence: 1 }],
    app_launcher_visible: false,
  };
  const saved =
    managed.length === 1
      ? (await call("PUT", `${account}/apps/${managed[0].id}`, body)).result
      : (await call("POST", `${account}/apps`, body)).result;

  const readBack = (await call("GET", `${account}/apps/${saved.id}`)).result;
  const actual = destinationsOf(readBack)
    .map((uri) => uri.toLowerCase())
    .sort();
  const expected = desired.map((uri) => uri.toLowerCase()).sort();
  if (actual.join("\n") !== expected.join("\n")) {
    fail("READBACK_MISMATCH", `expected ${expected.join(", ")} got ${actual.join(", ")}`);
  }
  const attached = (readBack.policies ?? []).map((item) =>
    typeof item === "string" ? item : item.id,
  );
  if (attached.length !== 1 || attached[0] !== policy.id) fail("READBACK_MISMATCH", "policies");

  const probes = await probe(config);
  console.log(`PUBLIC_PATHS_OK ${JSON.stringify({ ...plan, probes })}`);
}

const args = process.argv.slice(2);
const planOnly = args.includes("--plan");
const configArgument = args.find((arg) => !arg.startsWith("--"));
try {
  await sync({
    configFile: configArgument ? path.resolve(configArgument) : defaultConfig,
    planOnly,
  });
} catch (error) {
  if (error instanceof SyncFailure) {
    console.log(`PUBLIC_PATHS_FAILED ${error.message}`);
    process.exit(1);
  }
  throw error;
}
