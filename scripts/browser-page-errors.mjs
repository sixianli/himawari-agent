import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const directPageErrorListener =
  /\.(?:on|once|addListener|prependListener|prependOnceListener)\(\s*["']pageerror["']/u;

const webkitBlockedFetchMessage = /^\/(?<host>[^/\s]+)\/\S* due to access control checks\.$/u;

function blockedSameOriginFetch(page, message) {
  const host = webkitBlockedFetchMessage.exec(message)?.groups?.host;
  if (!host) return false;
  try {
    const url = new URL(page.url());
    return url.port !== "" && url.host === host;
  } catch {
    return false;
  }
}

export function watchPageErrors(page, onError) {
  let replacing;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) replacing = request;
  });
  page.on("requestfailed", (request) => {
    if (request === replacing) replacing = undefined;
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) replacing = undefined;
  });
  page.on("pageerror", (error) => {
    if (replacing && blockedSameOriginFetch(page, error.message)) return;
    onError(error);
  });
}

export function collectPageErrors(page, errors = []) {
  watchPageErrors(page, (error) => errors.push(error.message));
  return errors;
}

export function expectedOfflineTransportError(message, baseUrl, paths) {
  if (!message.endsWith(" due to access control checks.")) return false;
  const host = new URL(baseUrl).host;
  return paths.some(
    (path) => message.startsWith(`/${host}${path} `) || message.startsWith(`/${host}${path}?`),
  );
}

export async function findDirectPageErrorListeners(root, allowed) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const offenders = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:mjs|js|ts)$/u.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (allowed.has(relative)) continue;
    if (directPageErrorListener.test(await readFile(file, "utf8"))) offenders.push(relative);
  }
  return offenders.sort();
}

export async function findUnwatchedBrowserLaunches(root, allowed) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const offenders = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:mjs|js|ts)$/u.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (allowed.has(relative)) continue;
    const source = await readFile(file, "utf8");
    if (
      /\.launch(?:PersistentContext|Server)?\s*\(/u.test(source) &&
      !/\b(?:watchPageErrors|collectPageErrors)\s*\(/u.test(source)
    )
      offenders.push(relative);
  }
  return offenders.sort();
}
