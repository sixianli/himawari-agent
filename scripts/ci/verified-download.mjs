import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export const retryBudgetMs = 15 * 60_000;
const firstDelayMs = 10_000;
const longestDelayMs = 300_000;
const digestPattern = /^[a-f0-9]{64}$/;

export const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const cacheEnvironmentKey = "HIMAWARI_CI_CACHE_DIR";
const cacheMaxAgeMs = 30 * 24 * 3_600_000;
const temporaryMaxAgeMs = 24 * 3_600_000;
const cacheMaxBytes = 1024 ** 3;

export function explicitCacheDirectory(env = process.env) {
  const directory = env[cacheEnvironmentKey];
  return directory && isAbsolute(directory) ? directory : null;
}

export function runnerCacheDirectory(env = process.env) {
  const explicit = explicitCacheDirectory(env);
  if (explicit) return explicit;
  if (env.GITHUB_ACTIONS !== "true" || !env.HOME || !isAbsolute(env.HOME)) return null;
  return join(env.HOME, ".cache", "himawari-ci", "downloads");
}

export function cacheRead(directory, sha256) {
  if (!directory || !digestPattern.test(sha256)) return null;
  const path = join(directory, sha256);
  let status;
  try {
    status = lstatSync(path);
  } catch {
    return null;
  }
  if (!status.isFile()) {
    rmSync(path, { recursive: true, force: true });
    return null;
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (sha256Of(bytes) !== sha256) {
    rmSync(path, { force: true });
    return null;
  }
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {}
  return bytes;
}

export function cacheWrite(directory, sha256, bytes, report = console.error) {
  if (!directory || !digestPattern.test(sha256) || sha256Of(bytes) !== sha256) return false;
  const temporary = join(directory, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o644 });
    renameSync(temporary, join(directory, sha256));
    return true;
  } catch (error) {
    report(`工具缓存写入失败，继续使用本次下载: ${error.message}`);
    return false;
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {}
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function retryDelayMs(attempt, { retryAfterMs = null, random = Math.random } = {}) {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, longestDelayMs);
  const base = Math.min(firstDelayMs * 2 ** (attempt - 1), longestDelayMs);
  return Math.round(base * (0.5 + random()));
}

export function retryableStatus(status) {
  return status >= 500 || status === 408 || status === 429;
}

export function nextRetryDelay(
  attempt,
  waitedMs,
  { retryAfterMs = null, random, budgetMs = retryBudgetMs },
) {
  const delay = retryDelayMs(attempt, { retryAfterMs, random });
  return waitedMs + delay > budgetMs ? null : delay;
}

function networkFailure(error) {
  const cause = error.cause;
  return [error.message, cause?.code, cause?.message].filter(Boolean).join(": ");
}

export async function downloadVerified(
  expected,
  {
    fetch: fetchImplementation = fetch,
    wait = (_attempt, delay) => new Promise((resolveWait) => setTimeout(resolveWait, delay)),
    cacheDirectory = null,
    budgetMs = retryBudgetMs,
    random = Math.random,
    report = console.error,
  } = {},
) {
  const cached = cacheRead(cacheDirectory, expected.sha256);
  if (cached) return cached;
  const host = new URL(expected.url).hostname;
  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    let reason;
    let retryable;
    let retryAfterMs = null;
    let bytes = null;
    try {
      const response = await fetchImplementation(expected.url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) {
        bytes = Buffer.from(await response.arrayBuffer());
      } else {
        reason = `HTTP ${response.status}`;
        retryable = retryableStatus(response.status);
        retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"));
      }
    } catch (error) {
      reason = networkFailure(error);
      retryable = true;
    }
    if (bytes) {
      if (sha256Of(bytes) !== expected.sha256)
        throw new Error(`下载摘要不匹配: ${expected.filename ?? expected.url}`);
      cacheWrite(cacheDirectory, expected.sha256, bytes, report);
      return bytes;
    }
    const summary = `${expected.filename} 来自 ${host}，第 ${attempt} 次 (${reason})`;
    const delay = retryable
      ? nextRetryDelay(attempt, waited, { retryAfterMs, random, budgetMs })
      : null;
    if (delay === null) throw new Error(`工具下载失败: ${summary}`);
    report(`工具下载重试: ${summary}，${Math.round(delay / 1000)} 秒后重试`);
    waited += delay;
    await wait(attempt, delay);
  }
}

export function pruneCache(
  directory,
  { now = Date.now(), maxBytes = cacheMaxBytes, report = console.error } = {},
) {
  if (!directory) return;
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const entries = [];
  for (const name of names) {
    const path = join(directory, name);
    let status;
    try {
      status = lstatSync(path);
    } catch {
      continue;
    }
    const age = now - status.mtimeMs;
    const temporary = name.startsWith(".tmp-");
    const entry = digestPattern.test(name) && status.isFile();
    if (
      (temporary && age > temporaryMaxAgeMs) ||
      (!temporary && !entry) ||
      (entry && age > cacheMaxAgeMs)
    ) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (entry) entries.push({ name, path, size: status.size, time: status.mtimeMs });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries.sort((a, b) => a.time - b.time)) {
    if (total <= maxBytes) break;
    rmSync(entry.path, { force: true });
    total -= entry.size;
    report(`工具缓存超过上限，已删除最久未用的条目: ${entry.name}`);
  }
}
