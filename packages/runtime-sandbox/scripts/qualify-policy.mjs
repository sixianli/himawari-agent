// Fixed synthetic-data policy probe; not a Worker entry or host qualification issuer.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../../..");
if (process.argv[2] !== "--child") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-srt-probe-")));
  const privateDirectory = path.join(root, "private");
  await mkdir(privateDirectory);
  const child = spawn(process.execPath, [script, "--child", root], {
    cwd: root,
    shell: false,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
      HOME: privateDirectory,
      TMPDIR: privateDirectory,
      CLAUDE_CODE_TMPDIR: privateDirectory,
    },
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 45_000,
    killSignal: "SIGKILL",
  });
  const result = await new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1, signal: "spawn_failed" }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) {
    process.stderr.write(`Probe interrupted; retain test directory for inspection: ${root}\n`);
  } else {
    await rm(root, { recursive: true, force: true });
  }
  process.exitCode = result.code ?? 1;
} else {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const { compileSandboxPolicy, inspectSrtDependencies } = await import(
    pathToFileURL(
      path.join(
        repository,
        "dist/node-runtime/node_modules/@himawari-agent/runtime-sandbox/dist/index.js",
      ),
    ).href
  );
  const root = process.argv[3];
  const workspace = path.join(root, "workspace");
  const privateDirectory = path.join(root, "private");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "visible.txt"), "synthetic-visible");
  await writeFile(path.join(workspace, ".env"), "synthetic-secret");
  await writeFile(path.join(root, "outside.txt"), "synthetic-outside");
  await symlink(path.join(root, "outside.txt"), path.join(workspace, "escape"));
  const dependencies = await inspectSrtDependencies();
  if (
    !dependencies.platformSupported ||
    dependencies.errors.length ||
    dependencies.warnings.length
  ) {
    process.stdout.write(`${JSON.stringify({ dependencies, policyProbePassed: false })}\n`);
    process.exitCode = 1;
  } else {
    const compiled = await compileSandboxPolicy({
      workspace,
      privateDirectory,
      writable: true,
      protectedPaths: [path.join(workspace, ".env")],
      readOnlyToolchainPaths: await Promise.all(
        ["/bin", "/usr/bin", "/usr/lib", "/System", "/dev"].map((entry) => realpath(entry)),
      ),
      allowedDomains: [],
    });
    process.chdir(workspace);
    try {
      await SandboxManager.initialize(JSON.parse(compiled.policyJson), undefined, false);
      // No model-controlled command, network credentials, external writes or background children.
      const command = [
        'test "$(cat visible.txt)" = synthetic-visible && echo visible-ok',
        "if cat .env >/dev/null 2>&1; then echo secret-leaked; else echo secret-denied; fi",
        "if cat ../outside.txt >/dev/null 2>&1; then echo outside-leaked; else echo outside-denied; fi",
        "if cat escape >/dev/null 2>&1; then echo symlink-leaked; else echo symlink-denied; fi",
        'printf synthetic-write > created.txt && test "$(cat created.txt)" = synthetic-write && echo write-ok',
        `proxy_userinfo="\${HTTPS_PROXY%@*}"; proxy_token="\${proxy_userinfo##*:}"; proxy_auth=$(printf 'srt:%s' "$proxy_token" | /usr/bin/base64); { printf 'CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\nProxy-Authorization: Basic %s\\r\\n\\r\\n' "$proxy_auth"; /bin/sleep 0.5; } | /usr/bin/nc -n -w 2 127.0.0.1 "\${HTTPS_PROXY##*:}" > "$TMPDIR/network-headers"; if /usr/bin/grep -qi "X-Proxy-Error: blocked-by-allowlist" "$TMPDIR/network-headers"; then echo network-denied; else echo network-proof-missing; fi`,
      ].join("; ");
      const launch = await SandboxManager.wrapWithSandboxArgv(command, "/bin/bash");
      const result = await new Promise((resolve, reject) => {
        const child = spawn(launch.argv[0], launch.argv.slice(1), {
          env: launch.env,
          cwd: workspace,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
          killSignal: "SIGKILL",
        });
        let output = "";
        let error = "";
        child.stdout.on("data", (data) => {
          output += data;
          if (output.length > 8192) child.kill("SIGKILL");
        });
        child.stderr.on("data", (data) => {
          error += data;
          if (error.length > 8192) child.kill("SIGKILL");
        });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal, output, error }));
      });
      const expected = [
        "visible-ok",
        "secret-denied",
        "outside-denied",
        "symlink-denied",
        "write-ok",
        "network-denied",
      ];
      const passed =
        result.code === 0 &&
        result.signal === null &&
        result.error === "" &&
        result.output.trim().split("\n").join(",") === expected.join(",");
      process.stdout.write(
        `${JSON.stringify({
          version: compiled.version,
          platform: process.platform,
          policyDigest: compiled.policyDigest,
          policyProbePassed: passed,
          observations: result,
          productionSuitable: false,
          missingGuarantees: dependencies.missingGuarantees,
        })}\n`,
      );
      process.exitCode = passed ? 0 : 1;
    } finally {
      SandboxManager.cleanupAfterCommand();
      await SandboxManager.reset();
    }
  }
}
