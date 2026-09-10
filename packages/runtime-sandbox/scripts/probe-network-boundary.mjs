// Bounded synthetic-data counterexample probe. Never issues a qualification.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeRoot = await realpath(process.env.HIMAWARI_PROBE_RUNTIME ?? "dist/node-runtime");
const sandboxModuleRoot = path.join(
  runtimeRoot,
  "node_modules/@himawari-agent/runtime-sandbox/dist",
);
const { compileSandboxPolicy, prepareSandboxJobHost } = await import(
  pathToFileURL(path.join(sandboxModuleRoot, "index.js"))
);

if (process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1") throw new Error("LIVE_PROBE_OPT_IN_REQUIRED");
if (!["darwin", "linux"].includes(process.platform)) throw new Error("UNSUPPORTED_PROBE_PLATFORM");
const hostname = "127.0.0.1.sslip.io";
const addresses = await lookup(hostname, { all: true });
if (!addresses.length || addresses.some((entry) => entry.address !== "127.0.0.1"))
  throw new Error("SYNTHETIC_LOOPBACK_TARGET_UNAVAILABLE");
// macOS Unix socket paths are limited to 104 bytes, including control suffixes.
const scratchParent =
  process.platform === "linux" ? await realpath(process.env.HIMAWARI_PROBE_SCRATCH) : "/tmp";
if (process.platform === "linux" && !scratchParent.startsWith("/data/himawari-r8-"))
  throw new Error("LINUX_PROBE_REQUIRES_OWNED_DATA_DIRECTORY");
if (process.platform === "linux" && (await lstat(scratchParent)).uid !== process.getuid())
  throw new Error("LINUX_PROBE_DIRECTORY_OWNER_MISMATCH");
const root = await realpath(await mkdtemp(path.join(scratchParent, "r8-")));
const hits = [];
const server = createServer((request, response) => {
  hits.push(request.url);
  response.end("himawari-r8-synthetic-loopback");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const hostNetNamespace = process.platform === "linux" ? await readlink("/proc/self/ns/net") : null;
const netProof =
  process.platform === "linux"
    ? `console.log("netns="+require("node:fs").readlinkSync("/proc/self/ns/net"));`
    : "";
const evidence = [];
try {
  for (const scenario of [
    "offline-http",
    "direct-loopback",
    "direct-dns",
    "allowed-dns-loopback-http",
    "allowed-dns-loopback-socks",
    "allowed-wrong-port",
    "allowed-metadata",
  ]) {
    const base = path.join(root, String(evidence.length));
    for (const directory of ["workspace", "private", "control"])
      await mkdir(path.join(base, directory), { recursive: true, mode: 0o700 });
    const policy = {
      workspace: path.join(base, "workspace"),
      privateDirectory: path.join(base, "private"),
      writable: false,
      allowedDomains: scenario.startsWith("allowed-") ? [`${hostname}:${port}`] : [],
      protectedPaths: [],
      readOnlyToolchainPaths: await Promise.all(
        [
          "/usr/bin",
          "/bin",
          "/usr/lib",
          "/dev",
          ...(process.platform === "darwin"
            ? ["/System", "/private/etc/ssl/openssl.cnf"]
            : [
                "/lib",
                "/lib64",
                "/proc",
                "/etc/ssl",
                path.join(runtimeRoot, "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp"),
              ]),
          path.dirname(await realpath(process.execPath)),
        ].map((entry) => realpath(entry)),
      ),
    };
    const compiled = await compileSandboxPolicy(policy);
    const endpoint =
      scenario === "allowed-metadata"
        ? "http://169.254.169.254/latest/meta-data/"
        : `http://${hostname}:${scenario === "allowed-wrong-port" ? (port === 65535 ? port - 1 : port + 1) : port}/${scenario}`;
    const command =
      scenario === "direct-dns"
        ? `${JSON.stringify(await realpath(process.execPath))} -e '${netProof}const s=require("node:dgram").createSocket("udp4");s.on("error",e=>{console.log(e.code);s.close()});s.send(Buffer.from([0,1,0,0,0,0,0,0,0,0,0,0]),53,"1.1.1.1",e=>{console.log(e?.code ?? "sent");s.close()})'`
        : scenario === "direct-loopback"
          ? `${JSON.stringify(await realpath(process.execPath))} -e '${netProof}const s=require("node:net").connect(${port},"127.0.0.1");s.on("error",e=>console.log(e.code));s.on("connect",()=>{console.log("connected");s.destroy()})'`
          : scenario.endsWith("socks")
            ? `/usr/bin/curl --silent --show-error --max-time 4 --noproxy '' --proxy "socks5h://\${ALL_PROXY#http://}" ${JSON.stringify(endpoint)}`
            : `/usr/bin/curl --silent --show-error --include --max-time 4 --noproxy '' ${JSON.stringify(endpoint)}`;
    const before = hits.length;
    const host = prepareSandboxJobHost(
      {
        jobId: scenario,
        attemptId: "attempt",
        policy,
        policyDigest: compiled.policyDigest,
        executable: "/bin/bash",
        args: ["-c", command],
        deadlineAt: new Date(Date.now() + 10000).toISOString(),
        maxOutputBytes: 4096,
        cleanupTimeoutMs: 2000,
        resourceLimits: { maxCpuTimeMs: 4000, maxMemoryBytes: 536870912 },
      },
      path.join(base, "control"),
    );
    try {
      await host.ready;
      host.start();
      const result = await host.result;
      const { readJobHostFinalEvidence, readLinuxNamespaceState } = await import(
        pathToFileURL(path.join(sandboxModuleRoot, "job-host-control-client.js"))
      );
      const final = await readJobHostFinalEvidence(host.controlBinding);
      const namespaceState = final.linuxNamespace
        ? await readLinuxNamespaceState(final.linuxNamespace)
        : null;
      const output = Buffer.from(host.readOutput(0, 4096).bytes).toString();
      evidence.push({
        scenario,
        policyDigest: compiled.policyDigest,
        reason: result.reason,
        taskProcessExited: result.taskProcessExited,
        taskTreeCleanup: result.taskTreeCleanup,
        output,
        network: result.network,
        serverRequests: hits.slice(before),
        linuxNamespace: final.linuxNamespace,
        namespaceState,
        hostNetNamespace,
        denialObserved:
          (/blocked-by-allowlist|EPERM|EACCES/.test(output) ||
            result.network?.deniedAddresses > 0 ||
            (process.platform === "linux" &&
              final.linuxNamespace &&
              /^netns=(net:\[\d+\])$/m.exec(output)?.[1] !== hostNetNamespace &&
              /^netns=net:\[\d+\]$/m.test(output) &&
              ((scenario === "direct-loopback" && output.includes("ECONNREFUSED")) ||
                (scenario === "direct-dns" && output.includes("ENETUNREACH"))))) &&
          hits.length === before,
        loopbackReached: hits.length > before && output.includes("himawari-r8-synthetic-loopback"),
      });
    } finally {
      host.cancel();
      await host.result;
    }
  }
  const counterexample = evidence.some(
    (entry) => entry.scenario.startsWith("allowed-") && entry.loopbackReached,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        platform: process.platform,
        osRelease: release(),
        architecture: process.arch,
        node: process.version,
        srt: "0.0.75",
        artifact: process.env.HIMAWARI_PROBE_RUNTIME ? "runtime-path-probe" : "source-build",
        runtimeRoot,
        productionSuitable: false,
        jobHostDigest: createHash("sha256")
          .update(await readFile(path.join(sandboxModuleRoot, "job-host-main.js")))
          .digest("hex"),
        hostname,
        addresses,
        evidence,
        ssrfCounterexampleConfirmed: counterexample,
      },
      null,
      2,
    )}\n`,
  );
  // Require positive denial evidence for every scenario, not just no requests.
  process.exitCode = counterexample
    ? 1
    : evidence.every((entry) => entry.denialObserved && entry.network?.closed)
      ? 0
      : 2;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
