import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { release } from "node:os";
import path from "node:path";
import type { SandboxExecutionPlan } from "@himawari-agent/application";
import { digestSandboxRuntime } from "@himawari-agent/platform-node";

/** Controlled test qualification only. Live file identities/digests are real;
 * this fixture does not issue an installation or production qualification. */
export async function macSandboxDeployment(
  root: string,
  plan: SandboxExecutionPlan,
  now: string,
  v2 = false,
  platform: "darwin" | "linux" = "darwin",
  revokeNetwork = false,
) {
  const base = await realpath(root);
  const workspace = path.join(base, "live-workspace");
  const runtimeRoot = path.join(base, "live-runtime");
  const privateRoot = path.join(base, "live-private");
  await Promise.all(
    [workspace, runtimeRoot, privateRoot].map((directory) => mkdir(directory, { mode: 0o700 })),
  );
  await writeFile(path.join(workspace, "approved.txt"), "allowed", { mode: 0o600 });
  await writeFile(path.join(workspace, ".env"), "synthetic-secret", { mode: 0o600 });
  await writeFile(path.join(base, "outside.txt"), "synthetic-outside", { mode: 0o600 });
  const runner = path.join(runtimeRoot, "runner.sh");
  const proxyClient =
    platform === "linux"
      ? `/usr/bin/socat - TCP:127.0.0.1:"\${HTTPS_PROXY##*:}",connect-timeout=2`
      : `/usr/bin/nc -n -w 2 127.0.0.1 "\${HTTPS_PROXY##*:}"`;
  await writeFile(
    runner,
    `set -eu
stage=input
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "probe-failed:%s:%s" "$stage" "$code"; fi' EXIT
value=$(/bin/cat)
test "$value" = synthetic-input
stage=read
test "$(/bin/cat approved.txt)" = allowed
stage=secret
if /bin/cat .env >/dev/null 2>&1; then exit 11; fi
stage=outside
if /bin/cat ../outside.txt >/dev/null 2>&1; then exit 12; fi
stage=write
if (printf forbidden > forbidden.txt) 2>/dev/null; then exit 13; fi
stage=network
proxy_userinfo="\${HTTPS_PROXY%@*}"; proxy_token="\${proxy_userinfo##*:}"; proxy_auth=$(printf 'srt:%s' "$proxy_token" | /usr/bin/base64); { printf 'CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\nProxy-Authorization: Basic %s\\r\\n\\r\\n' "$proxy_auth"; /bin/sleep 0.5; } | ${proxyClient} > "$TMPDIR/network-headers"
stage=network-proof
if ! /usr/bin/grep -qi 'X-Proxy-Error: blocked-by-allowlist' "$TMPDIR/network-headers"; then /bin/cat "$TMPDIR/network-headers"; exit 19; fi
printf 'run\\n' >> "$TMPDIR/runs"
/bin/sleep 0.2
printf '{"probe":"passed"}'
`,
    { mode: 0o600 },
  );
  if (revokeNetwork) {
    await writeFile(
      runner,
      `set -eu
/bin/cat >/dev/null
proxy_userinfo="\${HTTPS_PROXY%@*}"; proxy_token="\${proxy_userinfo##*:}"
proxy_auth=$(printf 'srt:%s' "$proxy_token" | /usr/bin/base64)
{ printf 'CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org:443\\r\\nProxy-Authorization: Basic %s\\r\\n\\r\\n' "$proxy_auth"; /bin/sleep 25; } | ${proxyClient} > "$TMPDIR/network-headers" &
for i in $(/usr/bin/seq 1 100); do
  if /usr/bin/grep -q '200 Connection' "$TMPDIR/network-headers"; then
    printf 'run\\n' >> "$TMPDIR/runs"
    printf 'established' > "$TMPDIR/network-established"
    wait
    exit 0
  fi
  /bin/sleep 0.05
done
exit 21
`,
      { mode: 0o600 },
    );
  }
  const executable = await realpath("/bin/bash");
  const fileHash = async (filename: string) =>
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const keys = generateKeyPairSync("ed25519");
  const runnerBytes = await readFile(runner);
  const signature = sign(null, runnerBytes, keys.privateKey);
  if (!verify(null, runnerBytes, keys.publicKey, signature))
    throw new Error("TEST_SIGNATURE_FAILED");
  const signerRef = `test-signer:${createHash("sha256")
    .update(keys.publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const artifactDigest = `sha256:${await fileHash(runner)}`;
  const metadata = await stat(workspace);
  const v2Declaration = v2
    ? {
        supportedExecutions: [
          { schemaVersion: "sandbox-execution.v2" as const, mode: "foreground" as const },
        ],
        operationBindings: [
          {
            operation: plan.operation,
            mode: "foreground" as const,
            contract: { ref: "fixed-read", version: "1", kind: "fixed_read" as const },
            backendRef: "srt",
            scopeSource: "file_workflow" as const,
            directoryOperations: ["read" as const],
            network: revokeNetwork ? ("grant_targets" as const) : ("disabled" as const),
          },
        ],
      }
    : {};
  const binding = {
    ...v2Declaration,
    schemaVersion: "sandbox-host-binding.v1" as const,
    capabilityRef: plan.capabilityRef,
    capabilityVersion: plan.capabilityVersion,
    artifactDigest,
    hostId: plan.identity.hostId,
    profileRef: plan.binding.profileRef,
    runtimeRoot,
    runtimeDigest: await digestSandboxRuntime(runtimeRoot),
    executable: { path: executable, sha256: await fileHash(executable) },
    runner: { path: runner, sha256: await fileHash(runner) },
    privateRoot,
    roots: [
      {
        canonicalRootId: "root-fixture",
        canonicalPath: workspace,
        device: String(metadata.dev),
        inode: String(metadata.ino),
      },
    ],
    readOnlyToolchainPaths: await Promise.all(
      [
        ...(process.env["HIMAWARI_QUALIFY_INSTALLED_RUNTIME"]
          ? [process.env["HIMAWARI_QUALIFY_INSTALLED_RUNTIME"]]
          : []),
        "/bin",
        "/usr/bin",
        "/usr/lib",
        ...(platform === "darwin"
          ? ["/System"]
          : [
              "/lib",
              "/lib64",
              "/proc",
              path.resolve(
                path.dirname(
                  createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"),
                ),
                "../vendor/seccomp",
              ),
            ]),
        "/dev",
      ].map((entry) => realpath(entry)),
    ),
    protectedPaths: [path.join(workspace, ".env")],
    allowedDomains: revokeNetwork ? ["registry.npmjs.org:443"] : [],
    maximumResourceCeiling: plan.resourceCeiling,
  };
  const sandbox = {
    ...(v2Declaration.supportedExecutions
      ? { supportedExecutions: v2Declaration.supportedExecutions }
      : {}),
    schemaVersion: "sandbox-runtime-qualification.v1",
    qualificationRef: plan.binding.qualificationRef,
    hostId: binding.hostId,
    profileRef: binding.profileRef,
    srtVersion: "0.0.75",
    platform,
    architecture: process.arch,
    osRelease: release(),
    runtimeDigest: binding.runtimeDigest,
    runnerDigest: binding.runner.sha256,
    evidenceDigest: createHash("sha256")
      .update("controlled-test-qualification-not-production")
      .digest("hex"),
    resourceMode: "observe_and_stop",
    terminationMode: platform === "darwin" ? "best_effort" : "verified_tree",
    guarantees: [
      "filesystem_default_deny",
      "network_allowlist",
      "clean_environment",
      "bounded_output",
      "wall_clock_stop",
      "resource_observation",
      "durable_start_admission",
      "unknown_quarantine",
      "restart_reconciliation",
      ...(platform === "darwin"
        ? ["best_effort_stop"]
        : ["task_tree_termination", "worker_crash_cleanup"]),
    ],
    limitations: platform === "darwin" ? ["detached_descendants_may_survive_stop"] : [],
  };
  const manifest = {
    manifestVersion: "capability.v2",
    ref: plan.capabilityRef,
    displayName: "Controlled Mac sandbox probe",
    version: plan.capabilityVersion,
    source: { type: "program", locator: "artifact:controlled-probe" },
    sourceIdentity: "test:probe",
    integrity: artifactDigest,
    artifact: {
      digest: artifactDigest,
      signatureStatus: "verified",
      signerRef,
      rollbackArtifactRef: null,
    },
    operations: [plan.operation],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["private"],
      network: [],
      filesystem: ["workspace:probe"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: now },
    reviewedBy: "test:fixture",
    reviewedAt: now,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: [executable, runner],
      environmentKeys: [],
      workdirRef: "workspace:probe",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: ["workspace:probe"],
    },
  };
  const snapshot = {
    schemaVersion: "capability-deployment.v1",
    capabilities: [
      {
        manifest,
        binding: { kind: "sandbox", value: binding },
        qualification: {
          qualificationVersion: "capability-runtime-qualification.v1",
          platform,
          runtimeIdentity: "srt:0.0.75",
          productionSuitable: true,
          artifactDigest,
          enforcement: {
            filesystem: true,
            network: true,
            processes: true,
            secrets: true,
            resourceCeilings: false,
            termination: platform === "linux",
          },
          reasonCodes: [],
          checkedAt: now,
          sandbox,
        },
      },
    ],
  };
  const snapshotPath = path.join(base, "live-deployment.json");
  const bytes = JSON.stringify(snapshot);
  await writeFile(snapshotPath, bytes, { mode: 0o600 });
  return {
    binding,
    sandbox,
    workspace,
    privateRoot,
    capabilityDeployment: {
      snapshotPath,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    },
  };
}
