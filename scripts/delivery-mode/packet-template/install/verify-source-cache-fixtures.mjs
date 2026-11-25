import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutFromCache, fetchBundleIntoCache, sourceCachePath } from "./source-cache.mjs";

const root = realpathSync(mkdtempSync(path.join(process.env.HIMAWARI_TEST_TEMP_ROOT ?? os.tmpdir(), "source-cache-")));
const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0" };
const run = (command, args, name) => execFileSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...args) => run("git", ["-C", cwd, ...args]);
const results = [];
const check = (name, passed, detail = "") => results.push({ name, passed: Boolean(passed), detail: String(detail) });
const throws = (action) => { try { action(); return ""; } catch (error) { return String(error.message); } };

try {
  const source = path.join(root, "source");
  mkdirSync(source);
  run("git", ["init", "-q", source]);
  const commit = (name, content) => { writeFileSync(path.join(source, name), content); git(source, "add", "-A"); git(source, "commit", "-q", "-m", name); return git(source, "rev-parse", "HEAD"); };
  const first = commit("a.txt", "one\n");
  const second = commit("b.txt", "two\n");
  const third = commit("c.txt", "three\n");
  const fullBundle = path.join(root, "full.bundle");
  const secondBundle = path.join(root, "second.bundle");
  const thirdBundle = path.join(root, "third.bundle");
  const bundle = (target, head, ...exclude) => { git(source, "checkout", "-q", "--detach", head); git(source, "bundle", "create", "-q", target, "HEAD", ...exclude); };
  bundle(fullBundle, first);
  bundle(secondBundle, second, `^${first}`);
  bundle(thirdBundle, third, `^${second}`);
  const cacheFor = (name) => sourceCachePath(path.join(root, name, "releases", "release"));
  check("cache path is a sibling of the releases directory", cacheFor("x") === path.join(root, "x", "source-cache.git"), cacheFor("x"));

  const cache = cacheFor("seed");
  mkdirSync(path.dirname(cache), { recursive: true });
  check("a full bundle seeds an empty cache", throws(() => fetchBundleIntoCache(cache, fullBundle, first, run, existsSync(cache))) === "");
  check("an incremental bundle on the seeded cache adds only the new commit", throws(() => fetchBundleIntoCache(cache, secondBundle, second, run, existsSync(cache))) === "");
  check("the cache holds both release refs", git(cache, "for-each-ref", "--format=%(objectname)", "refs/release").split("\n").sort().join() === [first, second].sort().join());
  const checkout = path.join(root, "checkout");
  checkoutFromCache(cache, checkout, second, run);
  check("the checkout is the exact commit with a clean tree", git(checkout, "rev-parse", "HEAD") === second && git(checkout, "status", "--porcelain", "--untracked-files=all") === "" && readFileSync(path.join(checkout, "b.txt"), "utf8") === "two\n");
  check("the checkout carries its own history and needs no cache afterwards", throws(() => git(checkout, "cat-file", "-e", `${first}^{tree}`)) === "");

  const empty = cacheFor("empty");
  mkdirSync(path.dirname(empty), { recursive: true });
  const missing = throws(() => fetchBundleIntoCache(empty, thirdBundle, third, run, existsSync(empty)));
  check("an incremental bundle on a cache without its base is refused", missing !== "", missing.slice(0, 120));
  check("the refused bundle leaves no release ref", git(empty, "for-each-ref", "refs/release") === "");

  const wrong = cacheFor("wrong");
  mkdirSync(path.dirname(wrong), { recursive: true });
  const mismatch = throws(() => fetchBundleIntoCache(wrong, fullBundle, second, run, existsSync(wrong)));
  check("a bundle whose head is not the frozen commit is refused", mismatch === "P5_SOURCE_CACHE_HEAD_MISMATCH", mismatch.slice(0, 120));

  const unsafe = cacheFor("unsafe");
  mkdirSync(path.dirname(unsafe), { recursive: true });
  fetchBundleIntoCache(unsafe, fullBundle, first, run, false);
  chmodSync(unsafe, 0o777);
  check("a group- or world-writable cache is refused", throws(() => fetchBundleIntoCache(unsafe, fullBundle, first, run, existsSync(unsafe))) === "P5_SOURCE_CACHE_OWNER_OR_MODE_UNSAFE");

  const loose = cacheFor("loose-umask");
  mkdirSync(path.dirname(loose), { recursive: true });
  const previousMask = process.umask(0o002);
  try {
    fetchBundleIntoCache(loose, fullBundle, first, run, false);
  } finally {
    process.umask(previousMask);
  }
  check("a cache created under umask 002 is not group-writable", (statSync(loose).mode & 0o022) === 0);
  check("the next fetch accepts that cache", throws(() => fetchBundleIntoCache(loose, secondBundle, second, run, existsSync(loose))) === "");
} finally {
  rmSync(root, { recursive: true, force: true });
}
const failed = results.filter((item) => !item.passed);
process.stdout.write(JSON.stringify({ passed: failed.length === 0, results }, null, 2) + "\n");
process.exit(failed.length === 0 ? 0 : 1);
