import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

describe("[I-91] ci/toolchain-lock.json install-script reviews match package-lock.json", () => {
  const lock = read("package-lock.json").packages;
  const reviewed = read("ci/toolchain-lock.json").nativeDependencies;

  it("every reviewed entry points at a locked package with the same version and install script", () => {
    for (const entry of reviewed) {
      const locked = lock[entry.path];
      expect(locked, `stale review entry: ${entry.path}`).toBeTruthy();
      expect(locked.version, entry.path).toBe(entry.version);
      expect(locked.hasInstallScript, entry.path).toBe(true);
    }
  });

  it("every locked package with an install script has a review entry", () => {
    const reviewedPaths = new Set(reviewed.map((entry) => entry.path));
    for (const [path, locked] of Object.entries(lock)) {
      if (locked.hasInstallScript)
        expect(reviewedPaths.has(path), `unreviewed: ${path}`).toBe(true);
    }
  });
});
