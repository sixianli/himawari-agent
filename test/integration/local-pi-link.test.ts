import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLocalPi, linkLocalPi, unlinkLocalPi } from "../../scripts/local-pi-state.mjs";

const temporaryRoots: string[] = [];

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(localVersion = "0.84.2") {
  const workspace = await mkdtemp(join(tmpdir(), "himawari-local-pi-"));
  temporaryRoots.push(workspace);
  const root = join(workspace, "himawari-agent");
  const localRoot = join(workspace, "pi-mono");
  const installed = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  await writeJson(join(root, "packages/runtime-pi/package.json"), {
    dependencies: { "@earendil-works/pi-coding-agent": "0.84.2" },
  });
  await writeJson(join(root, "package-lock.json"), { lockfileVersion: 3 });
  await writeJson(join(installed, "package.json"), {
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
    source: "published",
  });
  await writeJson(join(localRoot, "packages/coding-agent/package.json"), {
    name: "@earendil-works/pi-coding-agent",
    version: localVersion,
  });
  for (const artifact of [
    "packages/coding-agent/dist/index.js",
    "packages/coding-agent/dist/index.d.ts",
    "packages/agent/dist/index.js",
    "packages/ai/dist/index.js",
    "packages/client/dist/index.js",
    "packages/protocol/dist/index.js",
    "packages/tui/dist/index.js",
  ]) {
    const path = join(localRoot, artifact);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "export {};\n");
  }
  return { root, localRoot, installed };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("local Pi source link mode", () => {
  it("changes only developer-local installation state and restores the published package", async () => {
    const { root, localRoot, installed } = await fixture();
    const manifestBefore = await readFile(join(root, "packages/runtime-pi/package.json"), "utf8");
    const lockBefore = await readFile(join(root, "package-lock.json"), "utf8");

    const linked = await linkLocalPi(root);

    expect(linked).toMatchObject({ ready: true, mode: "local", localVersion: "0.84.2" });
    expect(await realpath(installed)).toBe(
      await realpath(join(localRoot, "packages/coding-agent")),
    );
    expect(await readFile(join(root, "packages/runtime-pi/package.json"), "utf8")).toBe(
      manifestBefore,
    );
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe(lockBefore);

    const restored = await unlinkLocalPi(root);

    expect(restored.mode).toBe("published");
    expect(JSON.parse(await readFile(join(installed, "package.json"), "utf8"))).toMatchObject({
      version: "0.84.2",
      source: "published",
    });
    expect(await readFile(join(root, "packages/runtime-pi/package.json"), "utf8")).toBe(
      manifestBefore,
    );
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe(lockBefore);
  });

  it("rejects a sibling checkout whose package version differs from the published pin", async () => {
    const { root } = await fixture("0.85.0");

    await expect(inspectLocalPi(root)).rejects.toThrow("LOCAL_PI_VERSION_MISMATCH");
  });
});
