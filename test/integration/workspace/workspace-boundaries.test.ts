import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  allowedInternalDependencies,
  isBrowserImportAllowed,
  isExactExternalVersion,
  isInternalDependencyAllowed,
  isNodeImportAllowed,
  piDependencyOwner,
} from "../../../scripts/boundary-policy.mjs";

const workspaceNames = new Set(allowedInternalDependencies.keys());

describe("workspace dependency negative probes", () => {
  for (const source of workspaceNames) {
    for (const target of workspaceNames) {
      if (source === target || allowedInternalDependencies.get(source)?.has(target)) continue;

      it(`rejects ${source} -> ${target}`, () => {
        expect(isInternalDependencyAllowed(source, target)).toBe(false);
      });
    }
  }
});

describe("runtime-specific import negative probes", () => {
  it.each([
    "@himawari-agent/domain",
    "@himawari-agent/application",
    "@himawari-agent/gateway-contracts",
    "@himawari-agent/execution-contracts",
    "@himawari-agent/control-center",
  ])("rejects node: imports from %s", (workspace) => {
    expect(isNodeImportAllowed(workspace)).toBe(false);
  });

  it("allows node: imports from a Node adapter", () => {
    expect(isNodeImportAllowed("@himawari-agent/platform-node")).toBe(true);
  });

  it.each(["fastify", "better-sqlite3", "node:fs", "@himawari-agent/application"])(
    "rejects %s from the browser-only workspace",
    (specifier) => {
      expect(
        isBrowserImportAllowed("@himawari-agent/control-center", specifier, workspaceNames),
      ).toBe(false);
    },
  );

  it.each(["react", "react-dom/client", "react-intl", "@himawari-agent/gateway-contracts"])(
    "allows %s in the browser-only workspace",
    (specifier) => {
      expect(
        isBrowserImportAllowed("@himawari-agent/control-center", specifier, workspaceNames),
      ).toBe(true);
    },
  );

  it("keeps Pi dependencies owned by runtime-pi", () => {
    expect(piDependencyOwner).toBe("@himawari-agent/runtime-pi");
    expect([...workspaceNames].filter((name) => name === piDependencyOwner)).toHaveLength(1);
  });
});

describe("committed manifest and lock constraints", () => {
  it.each(["^1.2.3", "~1.2.3", "latest", "file:../pi-mono", "../pi-mono", "1.2"])(
    "rejects non-exact external version %s",
    (version) => {
      expect(isExactExternalVersion(version)).toBe(false);
    },
  );

  it("pins every direct external dependency and every internal dependency to 0.0.0", async () => {
    const manifests = ["package.json"];
    for (const group of ["apps", "packages"]) {
      for (const entry of await readdir(group, { withFileTypes: true })) {
        if (entry.isDirectory()) manifests.push(path.join(group, entry.name, "package.json"));
      }
    }

    for (const manifestPath of manifests) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const dependencies = {
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
        ...(manifest.optionalDependencies ?? {}),
        ...(manifest.peerDependencies ?? {}),
      };
      for (const [name, version] of Object.entries(dependencies)) {
        if (workspaceNames.has(name)) {
          expect(version, `${manifestPath}: ${name}`).toBe("0.0.0");
        } else {
          expect(isExactExternalVersion(String(version)), `${manifestPath}: ${name}`).toBe(true);
        }
      }
    }
  });

  it("contains no local pi-mono or file/link dependency locator", async () => {
    const lockfile = await readFile("package-lock.json", "utf8");
    expect(lockfile).not.toContain("../pi-mono");
    expect(lockfile).not.toContain('"file:');
    expect(lockfile).not.toContain('"link:');
  });
});
