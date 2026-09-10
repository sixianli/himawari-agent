// Explicit installed-runtime qualification. Only synthetic public queries; no keys.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
if (process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1" || process.platform !== "linux")
  throw new Error("PUBLIC_SEARCH_PROBE_OPT_IN_REQUIRED");
const runtime = await realpath(process.env.HIMAWARI_PROBE_RUNTIME);
const scratch = await realpath(process.env.HIMAWARI_PROBE_SCRATCH);
assert(scratch.startsWith("/data/himawari-r8-"));
const root = await mkdtemp(path.join(scratch, "w-"));
const { prepareJobPolicy, prepareSandboxJobHost } = await import(
  path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist/index.js")
);
const { readJobHostFinalEvidence, readLinuxNamespaceState } = await import(
  path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-control-client.js")
);
const runner = path.join(
  runtime,
  "node_modules/@himawari-agent/agent-service/dist/capability-programs/web-search-main.js",
);
const evidence = [];
try {
  for (const scenario of ["public-query", "invalid-query", "network-denied"]) {
    const base = path.join(root, String(evidence.length));
    const workspace = path.join(base, "w"),
      privateRoot = path.join(base, "j"),
      control = path.join(base, "c");
    await Promise.all(
      [workspace, privateRoot, control].map((p) => mkdir(p, { recursive: true, mode: 0o700 })),
    );
    const { policy, compiled } = await prepareJobPolicy({
      workspace,
      privateRoot,
      jobId: scenario,
      writable: false,
      protectedPaths: [],
      readOnlyToolchainPaths: await Promise.all(
        [runtime, "/usr/bin", "/usr/lib", "/lib64", "/dev", "/proc", "/etc/ssl", "/etc/hosts"].map(
          (p) => realpath(p),
        ),
      ),
      allowedDomains: scenario === "network-denied" ? [] : ["mcp.exa.ai:443"],
    });
    const host = await prepareSandboxJobHost(
      {
        jobId: scenario,
        attemptId: "attempt-1",
        policy,
        policyDigest: compiled.policyDigest,
        executable: path.join(runtime, "pi-tools/bin/node"),
        args: [runner],
        stdinBase64: Buffer.from(
          JSON.stringify({
            query:
              scenario === "invalid-query"
                ? ""
                : "Japan Meteorological Agency Tokyo weather forecast",
            limit: 3,
          }),
        ).toString("base64"),
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
        maxOutputBytes: 131072,
        cleanupTimeoutMs: 1000,
      },
      control,
    );
    await host.ready;
    host.start();
    const result = await host.result;
    const final = await readJobHostFinalEvidence(host.controlBinding);
    assert(final.linuxNamespace);
    const namespaceState = await readLinuxNamespaceState(final.linuxNamespace);
    assert.equal(namespaceState, "released");
    assert.equal(result.network.closed, true);
    const output = Buffer.from(result.stdout).toString("utf8");
    if (scenario === "public-query") {
      assert.equal(result.exitCode, 0, Buffer.from(result.stderr).toString());
      const parsed = JSON.parse(output);
      assert(parsed.results.length > 0);
      assert.equal(parsed.pagesOpened, false);
      assert(
        parsed.results.every(
          (x) => x.openedResourceId === null && new URL(x.url).protocol.startsWith("http"),
        ),
      );
      evidence.push({
        scenario,
        passed: true,
        namespaceState,
        network: result.network,
        retrievedAt: parsed.retrievedAt,
        results: parsed.results,
      });
    } else {
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.network.connected, 0);
      evidence.push({ scenario, passed: true, namespaceState, network: result.network });
    }
  }
  console.log(
    JSON.stringify({
      passed: true,
      installedRuntime: runtime,
      runnerDigest: createHash("sha256")
        .update(await readFile(runner))
        .digest("hex"),
      evidence,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
