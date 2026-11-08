import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { downloadArtifact } from "../../scripts/ci/install-tools.mjs";
import {
  cacheEnvironment,
  cacheRead,
  cacheWrite,
  downloadVerified,
  parseRetryAfter,
  pruneCache,
  retryDelayMs,
  runnerCacheDirectory,
  sha256Of,
} from "../../scripts/ci/verified-download.mjs";
import { curlDownload, installGateway } from "../../scripts/model-review/gateway.mjs";

const directories = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "himawari-verified-download-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  while (directories.length) rmSync(directories.pop(), { recursive: true, force: true });
});

const bytes = Buffer.from("published artifact");
const expected = {
  filename: "tool.tar.gz",
  url: "https://github.com/example/tool/releases/download/v1/tool.tar.gz",
  sha256: sha256Of(bytes),
};
const noWait = async () => {};
const quiet = () => {};
const offline = () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
    });
  };
  return { calls, fetch };
};
const answering = (...outcomes) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const outcome = outcomes[Math.min(calls.length, outcomes.length) - 1];
    return new Response(outcome.body ?? null, { status: outcome.status, headers: outcome.headers });
  };
  return { calls, fetch };
};
const options = (cacheDirectory, extra = {}) => ({
  cacheDirectory,
  wait: noWait,
  report: quiet,
  random: () => 0.5,
  ...extra,
});

describe("verified download cache", () => {
  it("serves a cached file without touching the network, even when the network is down", async () => {
    const cache = temporary();
    expect(cacheWrite(cache, expected.sha256, bytes, quiet)).toBe(true);
    const network = offline();
    const result = await downloadVerified(expected, options(cache, { fetch: network.fetch }));
    expect(result).toEqual(bytes);
    expect(network.calls).toEqual([]);
  });

  it("downloads on a miss, stores the file under its digest, and leaves no partial file behind", async () => {
    const cache = temporary();
    const network = answering({ status: 200, body: bytes });
    await downloadVerified(expected, options(cache, { fetch: network.fetch }));
    expect(readdirSync(cache)).toEqual([expected.sha256]);
    expect(readFileSync(join(cache, expected.sha256))).toEqual(bytes);
    const second = offline();
    await downloadVerified(expected, options(cache, { fetch: second.fetch }));
    expect(second.calls).toEqual([]);
  });

  it("rejects a poisoned cache entry, deletes it and refuses to use it when the network cannot help", async () => {
    const cache = temporary();
    writeFileSync(join(cache, expected.sha256), "poisoned");
    const network = answering({ status: 504 });
    await expect(
      downloadVerified(expected, options(cache, { fetch: network.fetch, budgetMs: 0 })),
    ).rejects.toThrow("工具下载失败");
    expect(existsSync(join(cache, expected.sha256))).toBe(false);
  });

  it("replaces a poisoned cache entry with the verified download", async () => {
    const cache = temporary();
    writeFileSync(join(cache, expected.sha256), "poisoned");
    const network = answering({ status: 200, body: bytes });
    expect(await downloadVerified(expected, options(cache, { fetch: network.fetch }))).toEqual(
      bytes,
    );
    expect(readFileSync(join(cache, expected.sha256))).toEqual(bytes);
  });

  it("never caches a download whose digest differs, and leaves the cache directory empty", async () => {
    const cache = temporary();
    const network = answering({ status: 200, body: "tampered" });
    await expect(
      downloadVerified(expected, options(cache, { fetch: network.fetch })),
    ).rejects.toThrow("下载摘要不匹配");
    expect(network.calls).toHaveLength(1);
    expect(readdirSync(cache)).toEqual([]);
  });

  it("leaves nothing in the cache when the download fails", async () => {
    const cache = temporary();
    const network = offline();
    await expect(
      downloadVerified(expected, options(cache, { fetch: network.fetch, budgetMs: 0 })),
    ).rejects.toThrow("工具下载失败");
    expect(readdirSync(cache)).toEqual([]);
  });

  it("refuses a cache entry that is a symlink", () => {
    const cache = temporary();
    const elsewhere = join(temporary(), "real");
    writeFileSync(elsewhere, bytes);
    symlinkSync(elsewhere, join(cache, expected.sha256));
    expect(cacheRead(cache, expected.sha256)).toBeNull();
    expect(existsSync(join(cache, expected.sha256))).toBe(false);
    expect(readFileSync(elsewhere)).toEqual(bytes);
  });

  it("only reads entries named by a full digest", () => {
    const cache = temporary();
    writeFileSync(join(cache, "tool.tar.gz"), bytes);
    expect(cacheRead(cache, "tool.tar.gz")).toBeNull();
    expect(cacheRead(cache, expected.sha256)).toBeNull();
    expect(cacheRead(null, expected.sha256)).toBeNull();
  });

  it("does not fail the download when the cache cannot be written", async () => {
    const parent = temporary();
    const blocked = join(parent, "file");
    writeFileSync(blocked, "not a directory");
    const network = answering({ status: 200, body: bytes });
    expect(await downloadVerified(expected, options(blocked, { fetch: network.fetch }))).toEqual(
      bytes,
    );
  });

  it("refuses to store bytes that do not match the digest", () => {
    const cache = temporary();
    expect(cacheWrite(cache, expected.sha256, Buffer.from("other"), quiet)).toBe(false);
    expect(readdirSync(cache)).toEqual([]);
  });

  it("copies a cached file into the job workspace for downloadArtifact", async () => {
    const cache = temporary();
    cacheWrite(cache, expected.sha256, bytes, quiet);
    const workspace = temporary();
    const network = offline();
    const path = await downloadArtifact(expected, workspace, {
      cacheDirectory: cache,
      fetch: network.fetch,
    });
    expect(readFileSync(path)).toEqual(bytes);
    expect(network.calls).toEqual([]);
    writeFileSync(path, "changed in the workspace");
    expect(readFileSync(join(cache, expected.sha256))).toEqual(bytes);
  });
});

describe("download retries", () => {
  it("waits as long as the server asks through Retry-After", async () => {
    const waits = [];
    const network = answering(
      { status: 503, headers: { "retry-after": "7" } },
      { status: 200, body: bytes },
    );
    await downloadVerified(expected, {
      ...options(null, { fetch: network.fetch }),
      wait: async (_attempt, delay) => waits.push(delay),
    });
    expect(waits).toEqual([7000]);
  });

  it("stops at the budget instead of waiting for ever", async () => {
    const waits = [];
    const network = answering({ status: 504 });
    await expect(
      downloadVerified(expected, {
        ...options(null, { fetch: network.fetch }),
        wait: async (_attempt, delay) => waits.push(delay),
      }),
    ).rejects.toThrow(/github\.com.*HTTP 504/);
    expect(waits.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(900_000);
    expect(waits.length).toBeGreaterThanOrEqual(5);
  });

  it("does not retry a missing file", async () => {
    const network = answering({ status: 404 });
    await expect(
      downloadVerified(expected, options(null, { fetch: network.fetch })),
    ).rejects.toThrow("HTTP 404");
    expect(network.calls).toHaveLength(1);
  });

  it("never waits less than a second even when the server says Retry-After 0", async () => {
    const waits = [];
    const network = answering(
      { status: 503, headers: { "retry-after": "0" } },
      { status: 200, body: bytes },
    );
    await downloadVerified(expected, {
      ...options(null, { fetch: network.fetch }),
      wait: async (_attempt, delay) => waits.push(delay),
    });
    expect(waits).toEqual([1000]);
    expect(
      retryDelayMs(1, { retryAfterMs: parseRetryAfter("Thu, 01 Jan 1970 00:00:00 GMT") }),
    ).toBe(1000);
  });

  it("spreads delays with jitter and caps them", () => {
    expect(retryDelayMs(1, { random: () => 0 })).toBe(5000);
    expect(retryDelayMs(1, { random: () => 0.999 })).toBeLessThanOrEqual(15000);
    expect(retryDelayMs(20, { random: () => 0.5 })).toBe(300000);
    expect(retryDelayMs(1, { retryAfterMs: 999_000 })).toBe(300000);
    expect(parseRetryAfter("12")).toBe(12000);
    expect(parseRetryAfter("not a date")).toBeNull();
  });
});

describe("cache directory choice and pruning", () => {
  it("uses the explicit directory, else the runner home only on GitHub Actions", () => {
    expect(runnerCacheDirectory({ HIMAWARI_CI_CACHE_DIR: "/data/cache" })).toBe("/data/cache");
    expect(runnerCacheDirectory({ HIMAWARI_CI_CACHE_DIR: "relative" })).toBeNull();
    expect(runnerCacheDirectory({ GITHUB_ACTIONS: "true", HOME: "/srv/gh-runner/home" })).toBe(
      "/srv/gh-runner/home/.cache/himawari-ci/downloads",
    );
    expect(runnerCacheDirectory({ HOME: "/Users/andy" })).toBeNull();
    expect(runnerCacheDirectory({ GITHUB_ACTIONS: "true" })).toBeNull();
  });

  it("refuses to read a cache entry larger than the limit", () => {
    const cache = temporary();
    cacheWrite(cache, expected.sha256, bytes, quiet);
    expect(cacheRead(cache, expected.sha256, { maxBytes: 5 })).toBeNull();
    expect(existsSync(join(cache, expected.sha256))).toBe(false);
  });

  it("passes the cache directory to the check subprocess and the CLI sets it", () => {
    expect(cacheEnvironment({ GITHUB_ACTIONS: "true", HOME: "/srv/gh-runner/home" })).toEqual({
      HIMAWARI_CI_CACHE_DIR: "/srv/gh-runner/home/.cache/himawari-ci/downloads",
    });
    expect(cacheEnvironment({ HOME: "/Users/andy" })).toEqual({});
    const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    expect(read("../../scripts/ci/run.mjs")).toContain("...cacheEnvironment(process.env)");
    expect(read("../../scripts/ci/install-tools.mjs")).toContain(
      "process.env[cacheEnvironmentKey] = cacheDirectory",
    );
  });

  const age = (path, days) => {
    const time = new Date(Date.now() - days * 86_400_000);
    utimesSync(path, time, time);
  };

  it("removes stale temporary files and unused entries but keeps recent ones", () => {
    const cache = temporary();
    const fresh = sha256Of("fresh");
    const stale = sha256Of("stale");
    writeFileSync(join(cache, fresh), "fresh");
    writeFileSync(join(cache, stale), "stale");
    writeFileSync(join(cache, ".tmp-1-old"), "x");
    writeFileSync(join(cache, ".tmp-2-new"), "x");
    writeFileSync(join(cache, "stray.txt"), "x");
    age(join(cache, stale), 31);
    age(join(cache, ".tmp-1-old"), 2);
    pruneCache(cache, { report: quiet });
    expect(readdirSync(cache).sort()).toEqual([".tmp-2-new", fresh].sort());
  });

  it("evicts the least recently used entries when over the size cap", () => {
    const cache = temporary();
    const names = ["a", "b", "c"].map((text) => sha256Of(text));
    names.forEach((name, index) => {
      writeFileSync(join(cache, name), "x".repeat(100));
      age(join(cache, name), 3 - index);
    });
    pruneCache(cache, { maxBytes: 200, report: quiet });
    expect(readdirSync(cache).sort()).toEqual([names[1], names[2]].sort());
  });
});

describe("Magpie download", () => {
  const spawnScript = (...results) => {
    const calls = [];
    const spawn = (_command, args) => {
      calls.push(args);
      const result = results[Math.min(calls.length, results.length) - 1];
      if (result.write) writeFileSync(args[args.indexOf("-o") + 1], result.write);
      return { status: result.exit ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    };
    return { calls, spawn };
  };

  it("retries a 504 with backoff and then succeeds", () => {
    const target = join(temporary(), "magpie");
    const script = spawnScript(
      { stdout: "HTTP/2 504\r\n\r\n504" },
      { stdout: "HTTP/2 504\r\nretry-after: 9\r\n\r\n504" },
      { stdout: "HTTP/2 200\r\n\r\n200", write: "binary" },
    );
    const sleeps = [];
    curlDownload("https://github.com/x/magpie", target, {
      spawn: script.spawn,
      sleep: (delay) => sleeps.push(delay),
      random: () => 0.5,
    });
    expect(readFileSync(target, "utf8")).toBe("binary");
    expect(sleeps).toEqual([10000, 9000]);
  });

  it("retries when curl fails after already reporting a 2xx status", () => {
    const target = join(temporary(), "magpie");
    const script = spawnScript(
      { exit: 28, stdout: "HTTP/2 200\r\n\r\n200", stderr: "timed out" },
      { stdout: "HTTP/2 200\r\n\r\n200", write: "binary" },
    );
    const sleeps = [];
    curlDownload("https://github.com/x/magpie", target, {
      spawn: script.spawn,
      sleep: (delay) => sleeps.push(delay),
      random: () => 0.5,
    });
    expect(sleeps).toEqual([10000]);
  });

  it("fails at once when curl is not installed", () => {
    const script = {
      spawn: () => ({
        status: null,
        error: Object.assign(new Error("spawn curl ENOENT"), { code: "ENOENT" }),
      }),
    };
    const sleeps = [];
    expect(() =>
      curlDownload("https://github.com/x/magpie", join(temporary(), "m"), {
        spawn: script.spawn,
        sleep: (delay) => sleeps.push(delay),
      }),
    ).toThrow("GATEWAY_DOWNLOAD_FAILED");
    expect(sleeps).toEqual([]);
  });

  it("does not retry a 404 and leaves no file", () => {
    const target = join(temporary(), "magpie");
    const script = spawnScript({ stdout: "HTTP/2 404\r\n\r\n404", write: "not found" });
    expect(() =>
      curlDownload("https://github.com/x/magpie", target, {
        spawn: script.spawn,
        sleep: () => {},
      }),
    ).toThrow("GATEWAY_DOWNLOAD_FAILED");
    expect(script.calls).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  });

  it("gives up when the budget is spent", () => {
    const target = join(temporary(), "magpie");
    const script = spawnScript({ stdout: "HTTP/2 504\r\n\r\n504" });
    const sleeps = [];
    expect(() =>
      curlDownload("https://github.com/x/magpie", target, {
        spawn: script.spawn,
        sleep: (delay) => sleeps.push(delay),
        random: () => 0.5,
      }),
    ).toThrow(/GATEWAY_DOWNLOAD_FAILED.*HTTP 504/);
    expect(sleeps.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(900_000);
    expect(sleeps.length).toBeGreaterThanOrEqual(5);
  });

  const fixture = () => {
    const root = temporary();
    const good = Buffer.from("magpie binary");
    const source = join(root, "plugin-src", "package");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "package.json"), '{"name":"@x/plugin","version":"1.0.0"}');
    const tarball = join(root, "plugin.tgz");
    expect(
      spawnSync("tar", ["-czf", tarball, "-C", join(root, "plugin-src"), "package"]).status,
    ).toBe(0);
    const integrity = `sha512-${spawnSync("sh", ["-c", `openssl dgst -sha512 -binary ${tarball} | base64 -w0`], { encoding: "utf8" }).stdout}`;
    const lock = {
      magpie: { version: "0.1.9", assets: { "linux-amd64": { url: "u", sha256: sha256Of(good) } } },
      plugin: { name: "@x/plugin", version: "1.0.0", integrity },
    };
    const pack = (_spec, destination) => {
      const copy = join(destination, "p.tgz");
      writeFileSync(copy, readFileSync(tarball));
      return copy;
    };
    return { root, good, lock, pack };
  };

  it("installs from the cache without downloading, and stores a verified download for next time", () => {
    const { root, good, lock, pack } = fixture();
    const cache = join(root, "cache");
    let downloads = 0;
    const download = (_url, target) => {
      downloads += 1;
      writeFileSync(target, good);
    };
    const first = installGateway({
      lock,
      prefix: join(root, "one"),
      platform: "linux-amd64",
      download,
      pack,
      cacheDirectory: cache,
    });
    expect(downloads).toBe(1);
    expect(readdirSync(cache)).toEqual([sha256Of(good)]);
    expect(readFileSync(first.binary)).toEqual(good);
    installGateway({
      lock,
      prefix: join(root, "two"),
      platform: "linux-amd64",
      download: () => {
        throw new Error("network used");
      },
      pack,
      cacheDirectory: cache,
    });
    expect(downloads).toBe(1);
  });

  it("does not use a poisoned cache entry and does not cache a tampered download", () => {
    const { root, good, lock, pack } = fixture();
    const cache = join(root, "cache");
    mkdirSync(cache);
    writeFileSync(join(cache, sha256Of(good)), "poisoned");
    expect(() =>
      installGateway({
        lock,
        prefix: join(root, "one"),
        platform: "linux-amd64",
        download: (_url, target) => writeFileSync(target, "tampered"),
        pack,
        cacheDirectory: cache,
      }),
    ).toThrow("GATEWAY_INTEGRITY_MISMATCH magpie");
    expect(readdirSync(cache)).toEqual([]);
    expect(existsSync(join(root, "one", "magpie"))).toBe(false);
  });
});
