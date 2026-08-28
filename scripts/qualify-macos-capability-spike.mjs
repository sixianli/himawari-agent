import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function schemeString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function localServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("reachable");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local-server-address-missing");
  return { server, port: address.port };
}

async function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function main() {
  const checkedAt = new Date().toISOString();
  if (process.platform !== "darwin") {
    process.stdout.write(
      `${JSON.stringify({
        qualificationVersion: "macos-sandbox-exec-spike.v1",
        platform: process.platform,
        executed: false,
        productionSuitable: false,
        reasonCodes: ["MACOS_PLATFORM_REQUIRED"],
        checkedAt,
      })}\n`,
    );
    return;
  }
  try {
    await access(SANDBOX_EXEC);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        qualificationVersion: "macos-sandbox-exec-spike.v1",
        platform: process.platform,
        executed: false,
        productionSuitable: false,
        reasonCodes: ["SANDBOX_EXEC_UNAVAILABLE"],
        checkedAt,
      })}\n`,
    );
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-macos-sandbox-spike-"));
  const canonicalRoot = await realpath(root);
  const allowed = path.join(canonicalRoot, "allowed.txt");
  const denied = path.join(canonicalRoot, "denied.txt");
  let server;
  try {
    await writeFile(allowed, "allowed\n", { mode: 0o600 });
    await writeFile(denied, "denied\n", { mode: 0o600 });
    const policy = [
      "(version 1)",
      "(deny default)",
      '(import "system.sb")',
      "(allow process*)",
      `(allow file-read* (literal ${schemeString(allowed)}))`,
    ].join("\n");
    const allowedProbe = await execFileAsync(SANDBOX_EXEC, ["-p", policy, "/bin/cat", allowed], {
      timeout: 2_000,
    }).then(
      ({ stdout }) => stdout === "allowed\n",
      () => false,
    );
    const deniedProbe = await execFileAsync(SANDBOX_EXEC, ["-p", policy, "/bin/cat", denied], {
      timeout: 2_000,
    }).then(
      () => false,
      () => true,
    );

    const local = await localServer();
    server = local.server;
    const networkDenied = await execFileAsync(
      SANDBOX_EXEC,
      [
        "-p",
        policy,
        "/usr/bin/curl",
        "--fail",
        "--max-time",
        "1",
        `http://127.0.0.1:${String(local.port)}/`,
      ],
      { timeout: 2_000 },
    ).then(
      () => false,
      () => true,
    );

    const child = spawn(
      SANDBOX_EXEC,
      ["-p", policy, "/bin/sh", "-c", "while :; do /bin/sleep 1; done"],
      { detached: true, stdio: "ignore" },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    let terminationSucceeded = await waitForExit(child, 1_000);
    if (!terminationSucceeded && child.pid) {
      process.kill(-child.pid, "SIGKILL");
      terminationSucceeded = await waitForExit(child, 1_000);
    }

    const reasonCodes = [
      ...(!allowedProbe ? ["FILESYSTEM_ALLOW_PROBE_FAILED"] : []),
      ...(!deniedProbe ? ["FILESYSTEM_DENY_PROBE_FAILED"] : []),
      ...(!networkDenied ? ["NETWORK_DENY_PROBE_FAILED"] : []),
      ...(!terminationSucceeded ? ["TERMINATION_PROBE_FAILED"] : []),
      "PRIVATE_UNSTABLE_INTERFACE_NOT_PRODUCTION_BOUNDARY",
      "SIGNED_APP_SANDBOX_XPC_HELPER_REQUIRED",
    ];
    process.stdout.write(
      `${JSON.stringify({
        qualificationVersion: "macos-sandbox-exec-spike.v1",
        platform: process.platform,
        executed: true,
        filesystemAllowEnforced: allowedProbe,
        filesystemDenyEnforced: deniedProbe,
        networkDenyEnforced: networkDenied,
        terminationEnforced: terminationSucceeded,
        productionSuitable: false,
        reasonCodes,
        checkedAt,
      })}\n`,
    );
  } finally {
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    await rm(root, { recursive: true, force: true });
  }
}

await main();
