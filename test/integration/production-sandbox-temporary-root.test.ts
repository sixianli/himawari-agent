import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { expect, it, vi } from "vitest";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";

it("[R2-D18] loads sandbox configuration with the formal-entry nested TMPDIR", async () => {
  const temporaryRoot = testTemporaryRoot();
  const minimumRootPadding = "x".repeat(Math.max(0, 10 - Buffer.byteLength(temporaryRoot, "utf8")));
  const nestedTmpdir = await mkdtemp(path.join(temporaryRoot, `hci-${minimumRootPadding}`));
  let scope: Awaited<ReturnType<typeof productionSandboxScope>> | undefined;
  try {
    expect(Buffer.byteLength(nestedTmpdir, "utf8")).toBeGreaterThanOrEqual(21);
    vi.stubEnv("TMPDIR", nestedTmpdir);
    scope = await productionSandboxScope({
      operation: "search",
      mode: "foreground",
      contract: { ref: "network-search", version: "1", kind: "network_only" },
      backendRef: "srt",
      scopeSource: "private_temp",
      directoryOperations: [],
      network: "grant_targets",
    });
    expect(Buffer.byteLength(scope.host.privateRoot, "utf8")).toBeLessThanOrEqual(27);
    expect(scope.services.runtime).toBeDefined();
  } finally {
    vi.unstubAllEnvs();
    if (scope) {
      await scope.close();
      await rm(nestedTmpdir, { recursive: true, force: true });
    }
  }
});
