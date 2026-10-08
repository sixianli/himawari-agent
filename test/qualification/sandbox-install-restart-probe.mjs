import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildProbeIdentityConfiguration,
  createProbeHttpClient,
  initializeProbeAccount,
} from "./sandbox-install-restart-http.mjs";
import {
  runInstalledAgent,
  startLocalModelServer,
  writeNonproductionCodingSnapshot,
} from "./sandbox-install-restart-model.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const assertionIds = [
  "original_started",
  "old_pair_exited",
  "new_pair_same_state",
  "cleanup_unknown_occupied",
  "conflict_queued_not_admitted",
  "conflict_cancelled",
  "original_not_replayed",
  "trusted_release",
  "new_admission",
  "owned_cleanup",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let probeDeadline = Infinity;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const requireFact = (condition, reason) => {
  if (!condition) throw new Error(reason);
};

function argumentsOf(values) {
  const result = {};
  const allowed = new Set([
    "--runtime",
    "--scratch",
    "--output",
    "--audit-script",
    "--artifact",
    "--context",
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index],
      value = values[index + 1];
    requireFact(
      allowed.has(key) && value && !result[key.slice(2)] && path.isAbsolute(value),
      "R2_L6_ARGUMENT_INVALID",
    );
    result[key.slice(2)] = value;
  }
  requireFact(Object.keys(result).length === allowed.size, "R2_L6_ARGUMENT_MISSING");
  return result;
}

async function processIdentity(pid) {
  const root = `/proc/${pid}`;
  const encoded = await readFile(`${root}/stat`, "utf8");
  const fields = encoded
    .slice(encoded.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return {
    pid,
    uid: (await stat(root)).uid,
    startTime: fields[19],
    state: fields[0],
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
    sessionId: Number(fields[3]),
    executable: await realpath(`${root}/exe`),
    args: (await readFile(`${root}/cmdline`, "utf8")).split("\0").filter(Boolean),
  };
}

async function waitFor(reason, operation, milliseconds = 60_000) {
  const deadline = Math.min(probeDeadline, Date.now() + milliseconds);
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await pause(25);
  }
  throw new Error(reason);
}

function execute(command, args, environment) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: environment,
        maxBuffer: 4 * 1024 * 1024,
        timeout: Math.max(1, Math.min(60_000, probeDeadline - Date.now())),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`R2_L6_COMMAND_FAILED:${path.basename(command)}:${error.code}:${stderr}`),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function startController(output) {
  const child = spawn(
    "/usr/bin/python3",
    ["-I", path.join(path.dirname(scriptPath), "sandbox-install-restart-controller.py")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  const events = [];
  let terminalError;
  let sequence = 0,
    readyResolve,
    readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const failPending = (error) => {
    terminalError = error;
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const terminated = new Promise((resolve) =>
    child.once("close", () => {
      failPending(terminalError ?? new Error("R2_L6_CONTROLLER_NOT_RUNNING"));
      resolve();
    }),
  );
  child.once("error", failPending);
  child.stdin.on("error", failPending);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failPending(new Error("R2_L6_CONTROLLER_RESPONSE_INVALID"));
      child.stdin.end();
      return;
    }
    events.push(message);
    if (message.id === null) {
      if (message.status === "ok") readyResolve(message.result);
      else readyReject(new Error(JSON.stringify(message)));
      return;
    }
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (!request) return;
    if (message.status === "ok") request.resolve(message.result);
    else
      request.reject(
        Object.assign(new Error(`R2_L6_CONTROLLER:${JSON.stringify(message)}`), {
          controllerResult: message.result,
        }),
      );
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.once("exit", (code) => {
    const error = new Error(`R2_L6_CONTROLLER_EXIT:${code}:${stderr}`);
    terminalError = error;
  });
  let metadata;
  try {
    metadata = await ready;
  } catch (error) {
    child.stdin.end();
    await terminated;
    await writeFile(
      path.join(output, "controller.json"),
      JSON.stringify({ events, stderr }, null, 2),
      { mode: 0o600 },
    );
    throw error;
  }
  return {
    metadata,
    events,
    send(command, fields = {}) {
      if (terminalError || child.exitCode !== null || child.signalCode !== null)
        return Promise.reject(terminalError ?? new Error("R2_L6_CONTROLLER_NOT_RUNNING"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`, (error) => {
          if (error) failPending(error);
        });
      });
    },
    async close(timeoutMs) {
      let closeError;
      try {
        if (!terminalError) await this.send("close", { timeoutMs });
      } catch (error) {
        closeError = error;
      } finally {
        child.stdin.end();
        await terminated;
      }
      await writeFile(
        path.join(output, "controller.json"),
        JSON.stringify({ metadata, events, stderr }, null, 2),
        { mode: 0o600 },
      );
      if (closeError) throw closeError;
      requireFact(child.exitCode === 0, "R2_L6_CONTROLLER_FAILED_EXIT");
    },
  };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function markerSnapshot(filename) {
  const info = await stat(filename, { bigint: true });
  requireFact(info.isFile() && info.uid === BigInt(process.getuid()), "R2_L6_MARKER_UNSAFE");
  return {
    sha256: digest(await readFile(filename)),
    device: String(info.dev),
    inode: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}

async function ownedProcessReadback(identities) {
  const rows = [];
  for (const name of (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry))) {
    const pid = Number(name);
    const root = `/proc/${pid}`;
    if ((await stat(root).catch(() => null))?.uid !== process.getuid()) continue;
    const encoded = await readFile(`${root}/stat`, "utf8").catch(() => null);
    if (!encoded) continue;
    const fields = encoded
      .slice(encoded.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (["Z", "X"].includes(fields[0])) continue;
    rows.push({
      pid,
      startTime: fields[19],
      state: fields[0],
      parentPid: Number(fields[1]),
      processGroupId: Number(fields[2]),
    });
  }
  const selected = new Map(
    rows
      .filter((row) =>
        identities.some(
          (identity) => row.pid === identity.pid && row.startTime === identity.startTime,
        ),
      )
      .map((row) => [row.pid, row]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (!selected.has(row.pid) && selected.has(row.parentPid)) {
        selected.set(row.pid, row);
        changed = true;
      }
  }
  return [...selected.values()].filter((row) => row.pid !== process.pid);
}

async function runProbe(input) {
  requireFact(process.platform === "linux", "R2_L6_LINUX_REQUIRED");
  const scratch = await realpath(input.scratch);
  const info = await lstat(scratch);
  requireFact(
    scratch === input.scratch &&
      Buffer.byteLength(scratch) === 10 &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === 0o700,
    "R2_L6_SCRATCH_UNSAFE",
  );
  const runtimeRoot = await realpath(input.runtime);
  requireFact((await lstat(runtimeRoot)).isDirectory(), "R2_L6_RUNTIME_INVALID");
  const stateRoot = path.join(scratch, "s"),
    jobsRoot = path.join(scratch, "j"),
    workspace = path.join(scratch, "w"),
    secretDirectory = path.join(scratch, "k");
  const configurationPath = path.join(scratch, "c.json"),
    snapshotPath = path.join(scratch, "q.json");
  const staticRoot = path.join(scratch, "web"),
    auditDirectory = path.join(scratch, "audit");
  for (const writablePath of [
    input.output,
    stateRoot,
    jobsRoot,
    workspace,
    secretDirectory,
    configurationPath,
    snapshotPath,
    staticRoot,
    auditDirectory,
  ]) {
    const resolved =
      writablePath === input.output ? await realpath(writablePath) : path.resolve(writablePath);
    requireFact(
      resolved !== runtimeRoot &&
        !resolved.startsWith(`${runtimeRoot}/`) &&
        !runtimeRoot.startsWith(`${resolved}/`),
      "R2_L6_WRITABLE_PATH_OVERLAPS_RUNTIME",
    );
  }
  await mkdir(input.output, { recursive: true, mode: 0o700 });
  const cli = path.resolve(runtimeRoot, "../../bin/himawari");
  const environment = {
    ...process.env,
    NODE_PATH: "",
    NODE_OPTIONS: "",
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: scratch,
    HIMAWARI_TEST_TEMP_ROOT: scratch,
  };
  const report = {
    schemaVersion: "r2-l6-installed-recovery.v1",
    nonProduction: true,
    productionQualificationIssued: false,
    installedRuntime: runtimeRoot,
    startedAt: new Date().toISOString(),
    input: {
      artifactSha256: digest(await readFile(input.artifact)),
      contextSha256: digest(await readFile(input.context)),
      scratch,
      runtimeRoot,
      stateRoot,
    },
    assertions: assertionIds.map((id) => ({ id, passed: false })),
    cleanup: { completed: false, ownedProcessesRemaining: [] },
    passed: false,
  };
  const passed = (id) => {
    report.assertions.find((entry) => entry.id === id).passed = true;
  };
  probeDeadline = Date.now() + 540000;
  const requestAbort = new AbortController();
  const requestTimer = setTimeout(() => requestAbort.abort(), 540000);
  const ownedIdentities = [await processIdentity(process.pid)];
  const taskIdentities = [];
  let controller, model, account, client, platform;
  const httpEvidence = [],
    commands = [],
    pairs = [],
    audits = [],
    hostIdentities = new Set();
  const save = (name, value) =>
    writeFile(path.join(input.output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
  const admin = async (label, args) => {
    const result = await execute(cli, args, environment);
    commands.push({ label, args, stdout: result.stdout, stderr: result.stderr });
    return JSON.parse(result.stdout);
  };
  try {
    platform = await import(
      pathToFileURL(
        path.join(runtimeRoot, "node_modules/@himawari-agent/platform-node/dist/index.js"),
      ).href
    );
    const bash = path.join(runtimeRoot, "pi-tools/bin/bash");
    const bashInfo = await lstat(bash);
    requireFact(
      bashInfo.isFile() &&
        !bashInfo.isSymbolicLink() &&
        (bashInfo.mode & 0o111) !== 0 &&
        (await realpath(bash)) === bash,
      "R2_L6_BASH_INVALID",
    );
    report.runtimeDigestBefore = await platform.digestSandboxRuntime(runtimeRoot);
    report.jobHostDigest = digest(
      await readFile(
        path.join(
          runtimeRoot,
          "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-main.js",
        ),
      ),
    );
    report.agentServiceMainDigest = digest(
      await readFile(
        path.join(runtimeRoot, "node_modules/@himawari-agent/agent-service/dist/main.js"),
      ),
    );
    report.bashDigest = digest(await readFile(bash));
    const bashCheck = await execute(bash, ["-c", "printf r2-l6-bash-ok"], environment);
    requireFact(bashCheck.stdout === "r2-l6-bash-ok", "R2_L6_BASH_NOT_EXECUTABLE");
    report.toolPreparation = {
      installed: bash,
      installedSha256: report.bashDigest,
      method: "existing-host-tool-read-only",
    };
    controller = await startController(input.output);
    report.controller = {
      executable: controller.metadata.sysExecutable,
      isolated: controller.metadata.isolated,
      version: controller.metadata.sysVersion,
      pidfdOpen: controller.metadata.pidfdOpen,
      pidfdSendSignal: controller.metadata.pidfdSendSignal,
    };
    for (const directory of [jobsRoot, workspace, secretDirectory])
      await mkdir(directory, { mode: 0o700 });
    await mkdir(staticRoot, { mode: 0o700 });
    await writeFile(
      path.join(staticRoot, "index.html"),
      "<!doctype html><html lang=zh-CN><title>R2-L6</title></html>",
    );
    const ownerId = "r2-l6-owner",
      agentId = "r2-l6-agent",
      deploymentId = "r2-l6-deployment",
      hostId = "r2-l6-host",
      grantId = "r2-l6-workspace",
      workerInstanceId = `execution-worker:${deploymentId}`;
    const labels = {
      original: `R2-L6原作业-${randomUUID()}`,
      conflict: `R2-L6冲突作业-${randomUUID()}`,
      admitted: `R2-L6释放后作业-${randomUUID()}`,
    };
    const markerContent = `r2-l6-${randomUUID()}`;
    model = await startLocalModelServer({
      modelScript: ({ lastUserText, toolResults, hasTools, body }) => {
        if (body.stream !== true) return { kind: "text", text: '{"facts":[]}' };
        if (!hasTools || toolResults.length) return { kind: "text", text: "R2-L6工具恢复检查完成" };
        const original = lastUserText.includes(labels.original);
        requireFact(
          original ||
            lastUserText.includes(labels.conflict) ||
            lastUserText.includes(labels.admitted),
          "R2_L6_UNEXPECTED_MODEL_PROMPT",
        );
        return {
          kind: "tool",
          name: "bash",
          arguments: {
            command: original
              ? `set -C; printf '%s' '${markerContent}' > "$HOME/r2-l6-marker" || exit 91; printf 'r2-l6-started'; /bin/sleep 120; printf 'r2-l6-finished'`
              : "printf 'r2-l6-new-request'; /bin/sleep 2",
            timeout: 240,
          },
        };
      },
    });
    const qualification = await writeNonproductionCodingSnapshot({
      snapshotPath,
      runtimeRoot,
      workspace,
      jobsRoot,
      protectedPaths: [stateRoot, path.join(workspace, ".env")],
      hostId,
      workerInstanceId,
      ownerId,
    });
    requireFact(
      qualification.binding.runtimeDigest === report.runtimeDigestBefore,
      "R2_L6_QUALIFICATION_RUNTIME_MISMATCH",
    );
    report.qualification = {
      nonProduction: true,
      evidenceDigest: qualification.evidenceDigest,
      snapshotSha256: qualification.sha256,
      runtimeDigest: qualification.binding.runtimeDigest,
      maxWallTimeMs: qualification.binding.maximumResourceCeiling.maxWallTimeMs,
      signerRef: qualification.snapshot.capabilities[0].manifest.artifact.signerRef,
    };
    await save("nonproduction-qualification", qualification.snapshot);
    const port = await unusedPort(),
      origin = `http://127.0.0.1:${port}`;
    const descriptor = {
      ref: "model-primary",
      role: "primary",
      provider: "vercel-ai-gateway",
      model: "deepseek/deepseek-v4.1-flash",
      version: "v1",
      allowedDataClassifications: ["public", "private"],
      disclosure: "trusted_remote",
      secretRef: "vercel-ai-gateway-api-key",
      capabilities: ["text", "tools"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      priority: 1,
      name: "R2-L6 local fixture",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 2048,
      providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
    };
    const configuration = buildProbeIdentityConfiguration({
      origin,
      configuration: {
        schemaVersion: "himawari.configuration.v1",
        deploymentId,
        ownerId,
        agentId,
        stateRoot,
        runtimeDirectory: path.join(stateRoot, "runtime"),
        cacheDirectory: path.join(stateRoot, "cache"),
        http: {
          listenHost: "127.0.0.1",
          listenPort: port,
          staticRoot,
          sessionCookieName: "himawari_session",
          maximumBodyBytes: 256 * 1024,
          maximumStaticAssetBytes: 8 * 1024 * 1024,
          heartbeatMilliseconds: 5000,
        },
        modelDescriptors: [
          descriptor,
          {
            ref: "model-embedding",
            role: "embedding",
            provider: "vercel-ai-gateway",
            model: "alibaba/qwen3-embedding-8b",
            version: "v1",
            allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
            disclosure: "trusted_remote",
            secretRef: "vercel-ai-gateway-api-key",
            capabilities: ["embedding"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            dimensions: 4096,
          },
        ],
        memory: {
          adapter: "mem0-oss",
          version: "3.3.1",
          storagePath: path.join(stateRoot, "data/memory"),
          dimensions: 4096,
        },
        repositoryAllowlistRefs: [],
        secretReferences: [
          { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
          { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
          {
            ref: "vercel-ai-gateway-api-key",
            version: "v1",
            purpose: "model-provider-auth",
            scope: "agent",
          },
          {
            ref: "worker-process-token",
            version: "v1",
            purpose: "worker-auth",
            scope: "local-services",
          },
        ],
        budgets: {
          globalCostMicros: 1000000,
          perRunCostMicros: 100000,
          perClassificationCostMicros: {
            public: 100000,
            private: 100000,
            sensitive: 0,
            restricted: 0,
          },
        },
        concurrency: { totalRuns: 4, foregroundReserved: 1, perCategory: { foreground: 2 } },
        deadlines: { runMs: 900000, workerRequestMs: 300000, providerRequestMs: 120000 },
        capabilityDeployment: {
          snapshotPath: qualification.snapshotPath,
          sha256: qualification.sha256,
        },
        runPolicy: {
          version: "product-path-v1",
          systemInstruction: "请用中文回答。文件工具使用工作目录内的相对路径。",
          memoryLimit: 5,
          maxSelectedMemories: 0,
          maxMemoryClassification: "private",
          coding: {
            hostId,
            workerInstanceId,
            grantId,
            capabilityRef: "himawari.pi-coding",
            capabilityVersion: "1.0.0",
            maximumBytes: 49152,
            enabledTools: ["bash"],
          },
          timeZone: "Asia/Tokyo",
        },
      },
      identityPolicy: {
        sessionIdleMilliseconds: 86400000,
        sessionAbsoluteMilliseconds: 604800000,
        recentAuthentication: { maximumAgeMilliseconds: 900000, clockSkewMilliseconds: 30000 },
        csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1800000 },
      },
    });
    for (const [name, value] of [
      ["payload-kek.v1", "22".repeat(32)],
      ["identity-csrf.v1", "11".repeat(32)],
      ["vercel-ai-gateway-api-key.v1", "local-provider-fixture"],
    ])
      await writeFile(path.join(secretDirectory, name), value, { mode: 0o600, flag: "wx" });
    await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });
    account = await initializeProbeAccount({
      cli,
      runtimeRoot,
      configurationPath,
      stateRoot,
      secretDirectory,
      temporaryRoot: scratch,
      environment,
      commandTimeoutMs: 60000,
      evidence: httpEvidence,
    });
    await admin("capabilities-register", [
      "capabilities",
      "register",
      "--config",
      configurationPath,
      "--confirm",
      qualification.sha256,
    ]);
    await admin("workspace-grant", [
      "workspace",
      "grant",
      "--config",
      configurationPath,
      "--directory",
      workspace,
      "--host-id",
      hostId,
      "--id",
      grantId,
      "--expires-at",
      new Date(Date.now() + 86400000).toISOString(),
      "--confirm",
      workspace,
    ]);
    const tokenPath = path.join(stateRoot, "runtime/worker-token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        tokenRef: "worker-process-token",
        tokenValue: randomBytes(16).toString("hex"),
      }),
      { mode: 0o600, flag: "wx" },
    );
    const layout = await platform.initializeStateRoot(stateRoot);
    const databasePath = path.join(stateRoot, "data/product.sqlite");
    await mkdir(auditDirectory, { mode: 0o700 });
    const auditScript = path.join(auditDirectory, "workspace-lifecycle-audit.mjs");
    await copyFile(input["audit-script"], auditScript, constants.COPYFILE_EXCL);
    await symlink(
      path.join(runtimeRoot, "node_modules"),
      path.join(auditDirectory, "node_modules"),
    );
    report.auditScriptSha256 = digest(await readFile(auditScript));
    const audit = async (section) => {
      const result = await execute(
        process.execPath,
        [
          auditScript,
          "--database",
          databasePath,
          "--owner",
          ownerId,
          "--agent",
          agentId,
          "--section",
          section,
        ],
        environment,
      );
      const value = JSON.parse(result.stdout);
      audits.push({ observedAt: new Date().toISOString(), ...value });
      return value.rows;
    };
    const databaseIdentity = async () => {
      const metadata = await stat(databasePath);
      return { path: databasePath, device: String(metadata.dev), inode: String(metadata.ino) };
    };
    const services = async (generation) => {
      const serviceArgs = [
        "--config",
        configurationPath,
        "--worker-token-file",
        tokenPath,
        "--profile",
        "production",
      ];
      const childEnvironment = {
        ...environment,
        R2_L6_RUNTIME_ROOT: runtimeRoot,
        R2_L6_SECRET_DIRECTORY: secretDirectory,
        R2_L6_MODEL_URL: model.modelURL,
      };
      const pair = {
        generation,
        worker: { stdout: "", stderr: "" },
        agent: { stdout: "", stderr: "" },
      };
      pairs.push(pair);
      for (const kind of ["worker", "agent"]) {
        const args =
          kind === "worker"
            ? [
                "--no-global-search-paths",
                path.join(
                  runtimeRoot,
                  "node_modules/@himawari-agent/execution-worker/dist/main.js",
                ),
                ...serviceArgs,
              ]
            : ["--no-global-search-paths", scriptPath, "--agent", ...serviceArgs];
        const child = spawn(process.execPath, args, {
          cwd: scratch,
          env: childEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        pair[kind].pid = child.pid;
        child.stdout.on("data", (chunk) => {
          pair[kind].stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          pair[kind].stderr += chunk.toString();
        });
        child.on("error", (error) => {
          pair[kind].spawnError = String(error);
        });
        child.on("exit", (code, signal) => {
          pair[kind].exitCode = code;
          pair[kind].exitSignal = signal;
        });
        const identity = await processIdentity(child.pid);
        ownedIdentities.push(identity);
        requireFact(identity.parentPid === process.pid, "R2_L6_SERVICE_PARENT_CHANGED");
        pair[kind].identity = await controller.send("register", {
          role: `${generation === 1 ? "old" : "new"}${kind === "agent" ? "Agent" : "Worker"}`,
          identity,
        });
      }
      await waitFor("R2_L6_PAIR_READY_TIMEOUT", async () => {
        requireFact(
          pair.agent.exitCode === undefined && pair.worker.exitCode === undefined,
          `R2_L6_PAIR_EXITED:${generation}`,
        );
        const ready = (kind, component) =>
          pair[kind].stdout.split("\n").some((line) => {
            try {
              const event = JSON.parse(line);
              return event.event === "service.ready" && event.component === component;
            } catch {
              return false;
            }
          });
        return ready("agent", "agent-service") && ready("worker", "execution-worker");
      });
      const agentBoot = await platform.readAgentServiceBootBinding(layout),
        workerBoot = await platform.readWorkerServiceBootBinding(layout);
      requireFact(
        agentBoot.workerBootId === workerBoot.workerBootId &&
          agentBoot.workerInstanceId === workerBoot.workerInstanceId,
        "R2_L6_PAIR_BINDING_MISMATCH",
      );
      pair.agent.bootId = agentBoot.agentServiceBootId;
      pair.worker.bootId = workerBoot.workerBootId;
      pair.binding = { agentBoot, workerBoot };
      pair.database = await databaseIdentity();
      return pair;
    };
    const oldPair = await services(1);
    report.oldPair = oldPair;
    client = await createProbeHttpClient({
      runtimeRoot,
      origin,
      sessionCookieName: configuration.http.sessionCookieName,
      requestTimeoutMs: 60000,
      evidence: httpEvidence,
      signal: requestAbort.signal,
    });
    await account.login(client);
    const submit = async (content) => {
      const thread = await client.createThread();
      return client.submitRun({ threadId: thread.threadId, content });
    };
    const original = await submit(labels.original);
    report.originalRun = original;
    let originalRow, originalRaw, markerPath, startedWitness;
    const diagnose = async (runId) =>
      admin("diagnose-run", [
        "diagnose",
        "run",
        "--config",
        configurationPath,
        "--secret-dir",
        secretDirectory,
        "--run",
        runId,
      ]);
    await waitFor("R2_L6_ORIGINAL_START_TIMEOUT", async () => {
      await client.approvePendingRun(original.runId);
      const rows = await audit("executions");
      originalRow = rows.find(
        (row) => row.runId === original.runId && row.supervision === "controlled",
      );
      if (!originalRow) return false;
      markerPath = path.join(jobsRoot, originalRow.jobId, "r2-l6-marker");
      if (!(await lstat(markerPath).catch(() => null))) return false;
      const diagnostic = await diagnose(original.runId);
      const running = diagnostic.diagnostics
        .map((entry) => entry.content?.observation)
        .filter(
          (entry) =>
            entry?.jobId === originalRow.jobId &&
            entry.phase === "running" &&
            entry.taskStarted &&
            entry.processStartToken,
        )
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (!running) return false;
      const witnessCandidates = (await readdir(jobsRoot)).filter((entry) =>
        entry.startsWith("control-"),
      );
      for (const directory of witnessCandidates) {
        const filename = path.join(jobsRoot, directory, "started.json");
        const metadata = await lstat(filename).catch(() => null);
        if (
          !metadata?.isFile() ||
          metadata.uid !== process.getuid() ||
          (metadata.mode & 0o777) !== 0o600
        )
          continue;
        const bytes = await readFile(filename);
        const body = JSON.parse(JSON.parse(bytes.toString()).body);
        if (
          body.jobId === originalRow.jobId &&
          body.processStartToken === running.processStartToken
        ) {
          startedWitness = { path: filename, sha256: digest(bytes), jobId: body.jobId };
          break;
        }
      }
      if (!startedWitness) return false;
      originalRaw = running;
      return true;
    });
    requireFact(
      originalRow.activeClaims > 0 && !originalRow.releaseReceiptPresent,
      "R2_L6_ORIGINAL_OCCUPANCY_MISSING",
    );
    report.markers = { before: await markerSnapshot(markerPath) };
    report.marker = {
      path: markerPath,
      expectedContent: markerContent,
      retainedContent: "original-marker.bin",
    };
    await copyFile(
      markerPath,
      path.join(input.output, "original-marker.bin"),
      constants.COPYFILE_EXCL,
    );
    requireFact(
      report.markers.before.sha256 === digest(markerContent),
      "R2_L6_MARKER_CONTENT_MISMATCH",
    );
    const hostIdentity = await processIdentity(originalRaw.processId);
    requireFact(
      hostIdentity.startTime === originalRaw.processStartToken &&
        hostIdentity.parentPid === oldPair.worker.pid,
      "R2_L6_HOST_IDENTITY_MISMATCH",
    );
    report.originalHost = {
      raw: originalRaw,
      identity: await controller.send("register", { role: "originalHost", identity: hostIdentity }),
      startedWitness,
    };
    hostIdentities.add(originalRaw.processIdentityRef);
    ownedIdentities.push(...(await ownedProcessReadback(ownedIdentities)));
    const originalQueue = (await audit("queue")).find((row) => row.runId === original.runId);
    const latestDiagnostic = await diagnose(original.runId);
    const latestRaw = latestDiagnostic.diagnostics
      .map((entry) => entry.content?.observation)
      .filter(
        (entry) =>
          entry?.jobId === originalRow.jobId &&
          entry.phase === "running" &&
          entry.taskStarted &&
          entry.processStartToken === originalRaw.processStartToken,
      )
      .sort((a, b) => b.sequence - a.sequence)[0];
    requireFact(
      latestRaw && latestRaw.processIdentityRef === originalRaw.processIdentityRef,
      "R2_L6_FRESH_HOST_EVIDENCE_MISSING",
    );
    originalRaw = latestRaw;
    requireFact(
      originalRaw.linuxNamespace && originalRaw.taskProcessGroup,
      "R2_L6_TASK_TREE_IDENTITY_MISSING",
    );
    taskIdentities.push(originalRaw);
    const taskTree = await ownedProcessReadback([hostIdentity]);
    const bashIdentities = [];
    for (const process of taskTree) {
      const identity = await processIdentity(process.pid);
      if (
        path.basename(identity.executable) === "bash" &&
        identity.args.some((argument) => argument.includes(markerContent))
      )
        bashIdentities.push(identity);
    }
    requireFact(bashIdentities.length === 1, "R2_L6_ORIGINAL_BASH_IDENTITY_AMBIGUOUS");
    report.originalBash = await controller.send("registerOriginalTask", {
      identity: bashIdentities[0],
      marker: {
        path: markerPath,
        expectedContent: markerContent,
        ...report.markers.before,
      },
    });
    const remainingDeadlineMs = Date.parse(originalQueue?.deadlineAt) - Date.now();
    report.fault = {
      observedAt: originalRaw.observedAt,
      deadlineAt: originalQueue?.deadlineAt,
      preflight: {
        remainingDeadlineMs,
        observationAgeMs: Date.now() - Date.parse(originalRaw.observedAt),
        measurementPoint: "before-controller-request",
        checkedAt: new Date().toISOString(),
        observationAgeGate: "disabled-by-reply-06",
      },
    };
    requireFact(remainingDeadlineMs >= 1500, "R2_L6_FREEZE_GATE_MISSED");
    const frozen = await controller.send("freeze", {
      observedAtMs: Date.parse(originalRaw.observedAt),
      deadlineAtMs: Date.parse(originalQueue.deadlineAt),
    });
    report.fault = {
      ...report.fault,
      preflight: {
        ...report.fault.preflight,
        directProcesses: {
          measurementPoint: frozen.preflight.measurementPoint,
          processes: frozen.preflight.processes,
          taskTree: frozen.preflight.taskTree,
          passed: true,
        },
        directMarker: frozen.preflight.marker,
      },
      freezeDurationMs: frozen.elapsedMs,
      freezeConfirmedAtMs: frozen.checkedAtMs,
      remainingDeadlineMs: frozen.remainingDeadlineMs,
      remainingDeadlineBeforeFirstSignalMs: frozen.remainingDeadlineBeforeFirstSignalMs,
      remainingDeadlineMeasurementPoint: "both-processes-state-T",
      observationAgeMs: frozen.observationAgeMs,
      observationAgeGate: "disabled-by-reply-06",
      observationAgeMeasurementPoint: "before-first-SIGSTOP",
      observationAgeAtConfirmationMs: frozen.observationAgeAtConfirmationMs,
      startedWitness,
    };
    requireFact(frozen.elapsedMs <= 250, "R2_L6_FREEZE_TOO_SLOW");
    const frozenProductStartedAt = new Date().toISOString();
    const frozenExecution = (await audit("executions")).find(
      (row) => row.jobId === originalRow.jobId,
    );
    const frozenDiagnostic = await diagnose(original.runId);
    const baselineOperations = new Set(
      latestDiagnostic.diagnostics.map((entry) => entry.operationKey),
    );
    const jobObservations = frozenDiagnostic.diagnostics.filter(
      (entry) => entry.content?.observation?.jobId === originalRow.jobId,
    );
    const newNonrunningObservations = jobObservations
      .filter(
        (entry) =>
          !baselineOperations.has(entry.operationKey) &&
          entry.content.observation.phase !== "running",
      )
      .map((entry) => ({ operationKey: entry.operationKey, ...entry.content.observation }));
    const finalPresent = jobObservations.some(
      (entry) => entry.content.observation.phase === "finished",
    );
    const finalWitnessPath = path.join(path.dirname(startedWitness.path), "final.json");
    const finalWitness = await lstat(finalWitnessPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    report.fault.preflight.frozenProduct = {
      measurementPoint: "after-SIGSTOP-confirmation-before-SIGKILL",
      startedAt: frozenProductStartedAt,
      checkedAt: new Date().toISOString(),
      execution: frozenExecution,
      finalPresent,
      finalEvidenceSource: "product-diagnostics-phase-finished",
      finalWitness: { path: finalWitnessPath, present: finalWitness !== null },
      newNonrunningObservations,
      diagnosticFile: "frozen-diagnostics.json",
      passed: false,
    };
    await save("frozen-diagnostics", frozenDiagnostic);
    requireFact(
      frozenExecution?.preparation === "bound" &&
        frozenExecution.supervision === "controlled" &&
        frozenExecution.activeClaims > 0 &&
        !frozenExecution.releaseReceiptPresent &&
        frozenExecution.stopRequestedAt === null &&
        (frozenExecution.result === null || frozenExecution.result === "unknown") &&
        !finalPresent &&
        finalWitness === null &&
        newNonrunningObservations.length === 0 &&
        !frozenDiagnostic.diagnostics.some((entry) => entry.errorCode) &&
        jobObservations.length > 0,
      "R2_L6_FROZEN_PRODUCT_STATE_CHANGED",
    );
    report.fault.preflight.frozenProduct.passed = true;
    passed("original_started");
    const ended = await controller.send("killOldPair");
    oldPair.agent.exited = ended.events.some((event) => event.role === "oldAgent" && event.exited);
    oldPair.worker.exited = ended.events.some(
      (event) => event.role === "oldWorker" && event.exited,
    );
    requireFact(oldPair.agent.exited && oldPair.worker.exited, "R2_L6_OLD_PAIR_ALIVE");
    passed("old_pair_exited");
    const authoritySourcePath = path.join(
      runtimeRoot,
      "node_modules/@himawari-agent/agent-service/dist/service-main.js",
    );
    const authoritySource = await readFile(authoritySourcePath);
    const leaseConstants = [
      ...authoritySource.toString().matchAll(/const AUTHORITY_LEASE_DURATION_MS = ([0-9_]+);/g),
    ];
    requireFact(
      leaseConstants.length === 1 && Number(leaseConstants[0][1].replaceAll("_", "")) === 30000,
      "R2_L6_AGENT_LEASE_CONTRACT_CHANGED",
    );
    const leaseDurationMs = Number(leaseConstants[0][1].replaceAll("_", ""));
    const leaseWaitUtcMs = Date.now();
    const leaseWaitMonotonicNs = process.hrtime.bigint();
    report.restartPreflight = {
      method: "fixed-agent-lease-expiry-upper-bound",
      scope: "exited-old-Agent-no-other-state-writer",
      clockPremise: "UTC-does-not-regress-from-last-renewal-through-new-claim",
      source: { path: authoritySourcePath, sha256: digest(authoritySource) },
      oldLeaseId: oldPair.binding.agentBoot.authorityLeaseId,
      leaseDurationMs,
      startedAt: new Date(leaseWaitUtcMs).toISOString(),
      passed: false,
    };
    await waitFor("R2_L6_OLD_AGENT_LEASE_EXPIRY_TIMEOUT", async () => {
      const elapsedMonotonicMs = Number(process.hrtime.bigint() - leaseWaitMonotonicNs) / 1e6;
      const elapsedUtcMs = Date.now() - leaseWaitUtcMs;
      Object.assign(report.restartPreflight, {
        elapsedMonotonicMs,
        elapsedUtcMs,
        checkedAt: new Date().toISOString(),
      });
      return elapsedMonotonicMs >= leaseDurationMs && elapsedUtcMs >= leaseDurationMs;
    });
    report.restartPreflight.passed = true;
    const newPair = await services(2);
    report.newPair = newPair;
    requireFact(
      newPair.agent.pid !== oldPair.agent.pid &&
        newPair.worker.pid !== oldPair.worker.pid &&
        newPair.agent.bootId !== oldPair.agent.bootId &&
        newPair.worker.bootId !== oldPair.worker.bootId &&
        JSON.stringify(newPair.database) === JSON.stringify(oldPair.database),
      "R2_L6_RESTART_IDENTITY_REUSED",
    );
    passed("new_pair_same_state");
    await client.refreshConfiguration();
    const unknown = await waitFor("R2_L6_UNKNOWN_OCCUPANCY_MISSING", async () =>
      (await audit("executions")).find(
        (row) =>
          row.jobId === originalRow.jobId &&
          row.supervision === "lost" &&
          row.cleanup === "unknown" &&
          row.activeClaims > 0 &&
          !row.releaseReceiptPresent,
      ),
    );
    report.afterRestart = { original: unknown };
    passed("cleanup_unknown_occupied");
    const conflict = await submit(labels.conflict);
    report.conflictRun = conflict;
    const queued = await waitFor("R2_L6_CONFLICT_NOT_QUEUED", async () => {
      await client.approvePendingRun(conflict.runId);
      return (await audit("queue")).find(
        (row) =>
          row.runId === conflict.runId &&
          row.status === "queued" &&
          !row.admissionPresent &&
          !row.invocationReceiptPresent,
      );
    });
    report.afterRestart.conflict = queued;
    report.markers.afterRestart = await markerSnapshot(markerPath);
    requireFact(
      JSON.stringify(report.markers.afterRestart) === JSON.stringify(report.markers.before),
      "R2_L6_ORIGINAL_REPLAYED",
    );
    requireFact(
      (await audit("executions")).filter((row) => row.runId === original.runId).length === 1 &&
        !(await audit("executions")).some((row) => row.runId === conflict.runId),
      "R2_L6_DUPLICATE_ADMISSION",
    );
    passed("conflict_queued_not_admitted");
    await client.cancelRun(conflict.runId);
    report.cancelledConflict = await waitFor("R2_L6_CONFLICT_CANCEL_MISSING", async () =>
      (await audit("queue")).find(
        (row) =>
          row.runId === conflict.runId &&
          row.status === "cancelled" &&
          !row.admissionPresent &&
          !row.invocationReceiptPresent,
      ),
    );
    passed("conflict_cancelled");
    await controller.send("continueHost");
    await client.cancelRun(original.runId);
    const released = await waitFor("R2_L6_TRUSTED_RELEASE_MISSING", async () =>
      (await audit("executions")).find(
        (row) =>
          row.jobId === originalRow.jobId &&
          row.supervision === "released" &&
          row.releaseReceiptPresent &&
          row.activeClaims === 0 &&
          row.activeBarriers === 0,
      ),
    );
    report.afterRelease = { original: released };
    const control = await import(
      pathToFileURL(
        path.join(
          runtimeRoot,
          "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-control-client.js",
        ),
      ).href
    );
    report.afterRelease.namespace = await control.readLinuxNamespaceState(
      originalRaw.linuxNamespace,
    );
    requireFact(report.afterRelease.namespace === "released", "R2_L6_ORIGINAL_NAMESPACE_REMAINS");
    report.markers.afterRelease = await markerSnapshot(markerPath);
    requireFact(
      JSON.stringify(report.markers.afterRelease) === JSON.stringify(report.markers.before),
      "R2_L6_MARKER_CHANGED_AFTER_RELEASE",
    );
    const finalDiagnostic = await diagnose(original.runId);
    for (const entry of finalDiagnostic.diagnostics) {
      const raw = entry.content?.observation;
      if (raw?.jobId === originalRow.jobId && raw.taskStarted)
        hostIdentities.add(raw.processIdentityRef);
    }
    report.originalHostStartCount = hostIdentities.size;
    requireFact(hostIdentities.size === 1, "R2_L6_HOST_REPLAYED");
    passed("original_not_replayed");
    passed("trusted_release");
    const admitted = await submit(labels.admitted);
    report.newRun = admitted;
    report.afterRelease.newRequest = await waitFor("R2_L6_NEW_ADMISSION_MISSING", async () => {
      await client.approvePendingRun(admitted.runId);
      return (await audit("queue")).find(
        (row) =>
          row.runId === admitted.runId &&
          row.status === "admitted" &&
          row.admissionPresent &&
          row.invocationReceiptPresent,
      );
    });
    passed("new_admission");
    await client.cancelRun(admitted.runId);
    report.afterRelease.newRequestRelease = await waitFor(
      "R2_L6_NEW_REQUEST_RELEASE_MISSING",
      async () =>
        (await audit("executions")).find(
          (row) =>
            row.runId === admitted.runId &&
            ((row.supervision === "released" && row.releaseReceiptPresent) ||
              (row.preparation === "reserved" && row.reservationReleaseReceiptPresent)) &&
            row.activeClaims === 0 &&
            row.activeBarriers === 0,
        ),
    );
    const newDiagnostic = await diagnose(admitted.runId);
    for (const entry of newDiagnostic.diagnostics) {
      const raw = entry.content?.observation;
      if (
        raw?.taskStarted &&
        raw.linuxNamespace &&
        raw.taskProcessGroup &&
        !taskIdentities.some((identity) => identity.processIdentityRef === raw.processIdentityRef)
      )
        taskIdentities.push(raw);
    }
    await save("new-request-diagnostics", newDiagnostic);
    await save("audits", audits);
    await save("final-diagnostics", finalDiagnostic);
  } catch (error) {
    if (error.controllerResult)
      report.fault = { ...report.fault, controllerFailure: error.controllerResult };
    report.failure = {
      reason: String(error),
      phase: report.assertions.find((entry) => !entry.passed)?.id ?? "unknown",
    };
  } finally {
    const cleanupStartedAtMonotonicNs = process.hrtime.bigint();
    const cleanupRemainingMs = () =>
      Math.max(
        1,
        30000 - Math.ceil(Number(process.hrtime.bigint() - cleanupStartedAtMonotonicNs) / 1e6),
      );
    ownedIdentities.push(...(await ownedProcessReadback(ownedIdentities)));
    if (controller) {
      try {
        const cleanup = await controller.send("cleanup", { timeoutMs: cleanupRemainingMs() });
        report.cleanup = {
          ...cleanup,
          ownedProcessesRemaining: cleanup.processesRemaining,
          completed: false,
        };
      } catch (error) {
        report.cleanup.error = String(error);
      }
      await controller.close(cleanupRemainingMs()).catch((error) => {
        report.cleanup.controllerCloseError = String(error);
      });
    }
    if (model) {
      await save("model-requests", model.requests);
      await model.close();
    }
    const remaining = await ownedProcessReadback(ownedIdentities);
    report.cleanup.ownedProcessesRemaining = [
      ...report.cleanup.ownedProcessesRemaining,
      ...remaining,
    ];
    report.cleanup.initialOwnedProcessesRemaining = report.cleanup.ownedProcessesRemaining;
    report.cleanup.taskTrees = [];
    report.cleanup.readbacks = [];
    try {
      const control = await import(
        pathToFileURL(
          path.join(
            runtimeRoot,
            "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-control-client.js",
          ),
        ).href
      );
      await waitFor(
        "R2_L6_OWNED_CLEANUP_TIMEOUT",
        async () => {
          const taskTrees = [];
          for (const identity of taskIdentities)
            taskTrees.push({
              processIdentityRef: identity.processIdentityRef,
              namespace: await control.readLinuxNamespaceState(identity.linuxNamespace),
              hostGroup: await control.readLinuxHostGroup(identity.processId),
              taskGroup: await control.readLinuxHostGroup(identity.taskProcessGroup.processGroupId),
            });
          report.cleanup.taskTrees = taskTrees;
          report.cleanup.taskTreesReleased = taskTrees.every(
            (state) =>
              state.namespace === "released" &&
              state.hostGroup.length === 0 &&
              state.taskGroup.length === 0,
          );
          report.cleanup.ownedProcessesRemaining = await ownedProcessReadback(ownedIdentities);
          report.cleanup.ownedProcessReadbackAt = new Date().toISOString();
          report.cleanup.readbacks.push({
            checkedAt: report.cleanup.ownedProcessReadbackAt,
            taskTrees,
            ownedProcessesRemaining: report.cleanup.ownedProcessesRemaining,
          });
          return (
            report.cleanup.ownedProcessesRemaining.length === 0 && report.cleanup.taskTreesReleased
          );
        },
        cleanupRemainingMs(),
      );
    } catch (error) {
      report.cleanup.taskTreeError = String(error);
      report.cleanup.taskTreesReleased = false;
    }
    report.cleanup.completed =
      controller !== undefined &&
      report.cleanup.ownedProcessesRemaining.length === 0 &&
      report.cleanup.taskTreesReleased &&
      !report.cleanup.error &&
      !report.cleanup.controllerCloseError;
    if (report.cleanup.completed) passed("owned_cleanup");
    account?.clearCredentials();
    try {
      requireFact(platform !== undefined, "R2_L6_RUNTIME_DIGEST_UNAVAILABLE");
      report.runtimeDigestAfter = await platform.digestSandboxRuntime(runtimeRoot);
      requireFact(
        report.runtimeDigestBefore === report.runtimeDigestAfter,
        "R2_L6_RUNTIME_CHANGED",
      );
    } catch (error) {
      report.runtimeIntegrityFailure = String(error);
      report.failure ??= { reason: String(error), phase: "runtime_integrity" };
    }
    for (const pair of pairs)
      for (const kind of ["agent", "worker"]) {
        await writeFile(
          path.join(input.output, `${kind}-${pair.generation}.stdout`),
          pair[kind].stdout,
          { mode: 0o600 },
        );
        await writeFile(
          path.join(input.output, `${kind}-${pair.generation}.stderr`),
          pair[kind].stderr,
          { mode: 0o600 },
        );
      }
    await save("http", httpEvidence);
    await save("commands", commands);
    await save("audits", audits);
    clearTimeout(requestTimer);
    report.finishedAt = new Date().toISOString();
    report.passed =
      !report.failure &&
      report.assertions.every((entry) => entry.passed) &&
      report.cleanup.completed;
    await save("report", report);
  }
  return report.passed ? 0 : 1;
}

if (process.argv[2] === "--agent") {
  process.exitCode = await runInstalledAgent({
    runtimeRoot: process.env.R2_L6_RUNTIME_ROOT,
    secretDirectory: process.env.R2_L6_SECRET_DIRECTORY,
    modelURL: process.env.R2_L6_MODEL_URL,
    serviceArgs: process.argv.slice(3),
  });
} else {
  process.exitCode = await runProbe(argumentsOf(process.argv.slice(2)));
}
