import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceEntryPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const packageManifestPath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("agent-service production package entry", () => {
  it("does not expose test-only composition or production testing dependency", async () => {
    const [sourceEntry, manifestText] = await Promise.all([
      readFile(sourceEntryPath, "utf8"),
      readFile(packageManifestPath, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };

    expect(sourceEntry).not.toContain("./local-composition-root.js");
    expect(sourceEntry).not.toContain("@himawari-agent/testing");
    expect(manifest.dependencies?.["@himawari-agent/testing"]).toBeUndefined();
    expect(manifest.devDependencies?.["@himawari-agent/testing"]).toBe("0.0.0");
  });
});
