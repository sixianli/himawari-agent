import { chmodSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const fail = (condition, message) => { if (!condition) throw new Error(message); };
const quietGit = ["-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];

export function sourceCachePath(prefix) {
  return path.join(path.dirname(path.dirname(prefix)), "source-cache.git");
}

export function checkExistingCache(cache) {
  const info = lstatSync(cache);
  fail(info.isDirectory() && !info.isSymbolicLink() && realpathSync(cache) === cache, "P5_SOURCE_CACHE_PATH_UNSAFE");
  fail(info.uid === process.getuid() && (info.mode & 0o022) === 0, "P5_SOURCE_CACHE_OWNER_OR_MODE_UNSAFE");
}

export function fetchBundleIntoCache(cache, bundle, head, run, exists) {
  if (exists) checkExistingCache(cache);
  else {
    run("git", [...quietGit, "init", "--bare", "-q", "--template=", cache], "cache-init");
    chmodSync(cache, 0o755);
  }
  run("git", [...quietGit, "-C", cache, "bundle", "verify", bundle], "cache-bundle-verify");
  run("git", [...quietGit, "-C", cache, "fetch", "-q", "--no-tags", "--no-write-fetch-head", bundle, `HEAD:refs/release/${head}`], "cache-fetch");
  fail(run("git", [...quietGit, "-C", cache, "rev-parse", "--verify", `refs/release/${head}^{commit}`]) === head, "P5_SOURCE_CACHE_HEAD_MISMATCH");
}

export function checkoutFromCache(cache, checkout, head, run) {
  run("git", [...quietGit, "init", "-q", "--template=", checkout], "clone-init");
  run("git", [...quietGit, "-C", checkout, "fetch", "-q", "--no-tags", "--no-write-fetch-head", cache, `refs/release/${head}:refs/heads/release`], "clone-fetch");
  run("git", [...quietGit, "-C", checkout, "checkout", "-q", "--detach", head], "checkout");
}
