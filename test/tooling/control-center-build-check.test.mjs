import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

const run = promisify(execFile);
const checkScript = path.join(repositoryRoot, "scripts/check-control-center-build.mjs");
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function distribution(extraAssets = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-build-check-"));
  roots.push(root);
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "index.html"),
    '<!doctype html><link rel="stylesheet" href="/assets/index-a.css"><script type="module" src="/assets/index-a.js"></script>',
  );
  const incompressible = `export const seed = "${randomBytes(160 * 1024).toString("base64")}";`;
  const assets = {
    "index-a.js": incompressible,
    "en-a.js": incompressible,
    "ja-a.js": "export default {};",
    "index-a.css": "body{margin:0}",
    ...extraAssets,
  };
  for (const [name, content] of Object.entries(assets)) {
    await writeFile(path.join(root, "assets", name), content);
  }
  return root;
}

async function check(root) {
  try {
    const { stdout } = await run(process.execPath, [checkScript, "--output-root", root]);
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code, result: JSON.parse(error.stdout) };
  }
}

it("[UI-1] passes a browser build of any size and only reports its compressed size", async () => {
  const { exitCode, result } = await check(await distribution());
  expect(exitCode).toBe(0);
  expect(result.status).toBe("passed");
  expect(result.sizes.totalGzipBytes).toBeGreaterThan(192 * 1024);
  expect(result.sizes.entryGzipBytes).toBeGreaterThan(150 * 1024);
  expect(result).not.toHaveProperty("budgets");
});

it("[UI-1] still refuses a build that ships source maps", async () => {
  const { exitCode, result } = await check(await distribution({ "index-a.js.map": "{}" }));
  expect(exitCode).toBe(1);
  expect(result.errors).toEqual(["source maps emitted: index-a.js.map"]);
});
