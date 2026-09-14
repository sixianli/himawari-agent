// Explicit opt-in; public registry reads and installs only in an owned scratch tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

if (process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1") throw new Error("LIVE_PROBE_OPT_IN_REQUIRED");
assert.ok(["darwin", "linux"].includes(process.platform));
const runtime = await realpath(process.env.HIMAWARI_PROBE_RUNTIME ?? "dist/node-runtime");
const moduleRoot = path.join(runtime, "node_modules/@himawari-agent/runtime-sandbox/dist");
const { compileSandboxPolicy, prepareSandboxJobHost } = await import(
  pathToFileURL(path.join(moduleRoot, "index.js"))
);
const node = await realpath(process.execPath);
const npm = await realpath(path.join(path.dirname(node), "npm"));
const npmRoot = path.dirname(path.dirname(npm));
const scratchParent =
  process.platform === "linux" ? await realpath(process.env.HIMAWARI_PROBE_SCRATCH) : "/tmp";
if (process.platform === "linux" && !scratchParent.startsWith("/data/himawari-r8-"))
  throw new Error("LINUX_PROBE_REQUIRES_OWNED_DATA_DIRECTORY");
if (process.platform === "linux" && (await lstat(scratchParent)).uid !== process.getuid())
  throw new Error("LINUX_PROBE_DIRECTORY_OWNER_MISMATCH");
const root = await realpath(await mkdtemp(path.join(scratchParent, "r8-use-")));
const certificate =
  process.platform === "darwin"
    ? "/private/etc/ssl/cert.pem"
    : "/etc/ssl/certs/ca-certificates.crt";
const hostNetNamespace = process.platform === "linux" ? await readlink("/proc/self/ns/net") : null;
const netProof =
  process.platform === "linux"
    ? `console.log("netns="+require("node:fs").readlinkSync("/proc/self/ns/net"));`
    : "";
await writeFile(path.join(root, "host-secret"), "synthetic-r8-secret-must-not-read", {
  mode: 0o600,
});
const evidence = [];
try {
  for (const scenario of [
    "plain-http",
    "download",
    "socks-download",
    "install",
    "redirect-denied",
    "cpu",
    "memory",
    "cancel",
    "proxy-variables-removed",
    "host-secret-denied",
  ]) {
    const base = path.join(root, String(evidence.length));
    for (const name of ["workspace", "private", "control"])
      await mkdir(path.join(base, name), { recursive: true, mode: 0o700 });
    const policy = {
      workspace: path.join(base, "workspace"),
      privateDirectory: path.join(base, "private"),
      writable: true,
      allowedDomains:
        scenario === "redirect-denied"
          ? ["httpbin.org:443"]
          : scenario === "plain-http"
            ? ["registry.npmjs.org:80"]
            : ["registry.npmjs.org:443"],
      protectedPaths: [],
      readOnlyToolchainPaths: await Promise.all(
        [
          "/usr/bin",
          "/bin",
          "/usr/lib",
          "/dev",
          ...(process.platform === "darwin"
            ? ["/System", "/private/etc/ssl/openssl.cnf", certificate, "/private/etc/hosts"]
            : [
                "/lib",
                "/lib64",
                "/proc",
                "/etc/ssl",
                "/etc/hosts",
                path.join(runtime, "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp"),
              ]),
          path.dirname(node),
          npmRoot,
        ].map((entry) => realpath(entry)),
      ),
    };
    const compiled = await compileSandboxPolicy(policy);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const curl = `/usr/bin/curl --silent --show-error --fail --max-time 15 --cacert ${quote(certificate)} --noproxy ''`;
    const download = `${curl} ${scenario === "socks-download" ? `--proxy "socks5h://\${ALL_PROXY#http://}"` : ""} https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz -o package.tgz`;
    const tunnel = `const net=require('node:net');const p=new URL(process.env.HTTPS_PROXY);const s=net.connect(Number(p.port),p.hostname);s.on('error',e=>console.log(e.code));s.on('connect',()=>s.write('CONNECT registry.npmjs.org:443 HTTP/1.1\\r\\nHost: registry.npmjs.org:443\\r\\nProxy-Authorization: Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64')+'\\r\\n\\r\\n'));s.on('data',b=>{if(b.toString().includes('200 Connection Established'))console.log('tunnel-established')});setTimeout(()=>process.exit(),12000)`;
    const commands = {
      "host-secret-denied": `/bin/cat ${quote(path.join(root, "host-secret"))}`,
      "plain-http": `${curl} --include http://registry.npmjs.org/is-number/7.0.0`,
      download,
      "socks-download": download,
      install: `${quote(node)} ${quote(npm)} install is-number@7.0.0 --ignore-scripts --no-audit --no-fund --fetch-retries=0 --registry=https://registry.npmjs.org --cache="$TMPDIR/cache"`,
      "redirect-denied": `${curl} -D redirect.headers -L 'https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com'; cat redirect.headers`,
      cpu: `${quote(node)} -e 'const end=Date.now()+5000;while(Date.now()<end){}'`,
      memory: `${quote(node)} -e 'const b=Buffer.alloc(80*1024*1024,1);setTimeout(()=>console.log(b.length),5000)'`,
      cancel: `${quote(node)} -e ${quote(tunnel)}`,
      "proxy-variables-removed": `${quote(node)} -e '${netProof}for(const k of Object.keys(process.env))if(k.toLowerCase().includes("proxy"))delete process.env[k];const s=require("node:net").connect(443,"1.1.1.1");s.on("error",e=>console.log(e.code));s.on("connect",()=>{console.log("bypass");s.destroy()})'`,
    };
    const host = prepareSandboxJobHost(
      {
        jobId: scenario,
        attemptId: "attempt",
        policy,
        policyDigest: compiled.policyDigest,
        executable: "/bin/bash",
        args: ["-c", commands[scenario]],
        deadlineAt: new Date(Date.now() + 25000).toISOString(),
        maxOutputBytes: 8192,
        cleanupTimeoutMs: 2000,
        resourceLimits: {
          maxCpuTimeMs: scenario === "cpu" ? 100 : 15000,
          maxMemoryBytes: scenario === "memory" ? 32 * 1024 * 1024 : 512 * 1024 * 1024,
        },
      },
      path.join(base, "control"),
    );
    try {
      await host.ready;
      host.start();
      if (scenario === "cancel") {
        const until = Date.now() + 10000;
        while (
          Date.now() < until &&
          !Buffer.from(host.readOutput(0, 8192).bytes).toString().includes("tunnel-established")
        )
          await delay(50);
        host.cancel();
      }
      const result = await host.result;
      const { readJobHostFinalEvidence, readLinuxNamespaceState } = await import(
        pathToFileURL(path.join(moduleRoot, "job-host-control-client.js"))
      );
      const final = await readJobHostFinalEvidence(host.controlBinding);
      const namespaceState = final.linuxNamespace
        ? await readLinuxNamespaceState(final.linuxNamespace)
        : null;
      const output = Buffer.from(host.readOutput(0, 8192).bytes).toString();
      const hostSecretPresent =
        scenario === "host-secret-denied" &&
        (await readFile(path.join(root, "host-secret"), "utf8")) ===
          "synthetic-r8-secret-must-not-read";
      let artifactSha256 = null;
      let passed = result.taskProcessExited && result.network?.closed;
      if (scenario === "plain-http") {
        passed &&=
          result.exitCode === 0 &&
          result.network.connected > 0 &&
          /^HTTP\/1\.[01] [23][0-9]{2}/.test(output);
      } else if (scenario === "download" || scenario === "socks-download") {
        const data = await readFile(path.join(base, "workspace/package.tgz")).catch(() => null);
        artifactSha256 = data ? createHash("sha256").update(data).digest("hex") : null;
        passed &&= result.exitCode === 0 && data?.length > 1000 && result.network.connected > 0;
      } else if (scenario === "install") {
        const manifest = await readFile(
          path.join(base, "workspace/node_modules/is-number/package.json"),
          "utf8",
        )
          .then(JSON.parse)
          .catch(() => null);
        passed &&=
          result.exitCode === 0 && manifest?.version === "7.0.0" && result.network.connected > 0;
      } else if (scenario === "cpu" || scenario === "memory")
        passed &&= result.reason === "resource_limit" && result.resources?.samples > 0;
      else if (scenario === "cancel")
        passed &&=
          result.reason === "cancelled" &&
          output.includes("tunnel-established") &&
          result.network.connected > 0;
      else if (scenario === "host-secret-denied")
        passed &&=
          result.exitCode !== 0 &&
          (/Permission denied|Operation not permitted/.test(output) ||
            (process.platform === "linux" &&
              final.linuxNamespace &&
              output.includes("No such file or directory"))) &&
          hostSecretPresent &&
          !output.includes("synthetic-r8-secret-must-not-read");
      else if (scenario === "proxy-variables-removed")
        passed &&=
          output.trim() === "EPERM" ||
          (process.platform === "linux" &&
            final.linuxNamespace &&
            /^netns=(net:\[\d+\])$/m.exec(output)?.[1] !== hostNetNamespace &&
            /^netns=net:\[\d+\]$/m.test(output) &&
            output.includes("ENETUNREACH"));
      else passed &&= output.includes("blocked-by-allowlist") && result.network.connected > 0;
      evidence.push({
        scenario,
        policyDigest: compiled.policyDigest,
        passed: Boolean(passed),
        reason: result.reason,
        exitCode: result.exitCode,
        resources: result.resources,
        network: result.network,
        output: output.replace(
          /^(set-cookie|cookie|authorization|proxy-authorization):[^\r\n]*/gim,
          "$1: [redacted]",
        ),
        artifactSha256,
        ...(scenario === "host-secret-denied" ? { hostSecretPresent } : {}),
        taskTreeCleanup: result.taskTreeCleanup,
        linuxNamespace: final.linuxNamespace,
        namespaceState,
        hostNetNamespace,
      });
    } finally {
      host.cancel();
      await host.result;
    }
  }
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        osRelease: release(),
        architecture: process.arch,
        node: process.version,
        srt: "0.0.75",
        runtime,
        runnerDigest: createHash("sha256")
          .update(await readFile(path.join(moduleRoot, "job-host-main.js")))
          .digest("hex"),
        productionSuitable: false,
        evidence,
        passed: evidence.every((x) => x.passed),
      },
      null,
      2,
    ),
  );
  process.exitCode = evidence.every((x) => x.passed) ? 0 : 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
