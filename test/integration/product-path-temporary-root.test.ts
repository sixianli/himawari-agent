import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productPathTemporaryPrefix } from "../fixtures/product-path-harness.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe("product path temporary root", () => {
  it("preserves the default directory and original prefix", async () => {
    vi.stubEnv("HIMAWARI_TEST_TEMP_ROOT", undefined);
    expect(productPathTemporaryPrefix()).toBe("/tmp/hma-pp-");
  });

  it("creates the installation directory under the explicit short root", async () => {
    const parent = process.env["HIMAWARI_TEST_TEMP_ROOT"] ?? (await realpath("/tmp"));
    vi.stubEnv("HIMAWARI_TEST_TEMP_ROOT", parent);
    const root = await realpath(await mkdtemp(productPathTemporaryPrefix()));
    roots.push(root);
    expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root)).toMatch(/^pp-.{6}$/);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects an oversized socket path before creating an installation", async () => {
    const container = await realpath(await mkdtemp(path.join(tmpdir(), "length-")));
    roots.push(container);
    const parent = path.join(container, "界".repeat(30));
    await mkdir(parent);
    vi.stubEnv("HIMAWARI_TEST_TEMP_ROOT", parent);
    expect(() => productPathTemporaryPrefix()).toThrow(/socket.*bytes/);
    expect(await readdir(parent)).toEqual([]);
  });
});
