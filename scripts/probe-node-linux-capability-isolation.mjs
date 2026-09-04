#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const QUALIFICATION_ROOT = "/data/himawari-qualification-20260904";
const HERMES_NODE_ROOT = "/data/hermes/node/";
const SANDBOX_PRLIMIT = "/usr/bin/prlimit";
const SANDBOX_PROBE = "/usr/bin/fork-probe";
const NOW = "2026-09-05T00:00:00.000Z";
const NORMAL_CEILING = Object.freeze({
  maxWallTimeMs: 5_000,
  maxCpuTimeMs: 2_000,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxOutputBytes: 4_096,
  maxProgressEvents: 8,
});
const CANCEL_CEILING = Object.freeze({
  ...NORMAL_CEILING,
  maxWallTimeMs: 5_000,
});
const TIMEOUT_CEILING = Object.freeze({
  ...NORMAL_CEILING,
  maxWallTimeMs: 1_000,
});

const ARGUMENT_NAMES = Object.freeze([
  "node",
  "isolation",
  "bwrap",
  "prlimit",
  "runtime-root",
  "sandbox-prlimit",
  "sandbox-probe",
  "work-root",
]);

function fail(code) {
  throw new Error(code);
}

function parseArguments(argv) {
  if (argv.length !== ARGUMENT_NAMES.length * 2) fail("INVALID_ARGUMENT_COUNT");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!ARGUMENT_NAMES.includes(name) || values.has(name)) fail("INVALID_ARGUMENTS");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail("INVALID_ARGUMENTS");
    values.set(name, value);
  }
  return Object.freeze(Object.fromEntries(ARGUMENT_NAMES.map((name) => [name, values.get(name)])));
}

function isWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function absolutePath(value, code) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) fail(code);
  return value;
}

function hostPath(value, name) {
  const absolute = absolutePath(value, `INVALID_${name.toUpperCase().replaceAll("-", "_")}`);
  if (!isWithin(QUALIFICATION_ROOT, absolute)) fail(`OUTSIDE_QUALIFICATION_ROOT:${name}`);
  return absolute;
}

function sandboxPath(value, expected, name) {
  if (value !== expected) fail(`INVALID_${name.toUpperCase().replaceAll("-", "_")}`);
  return value;
}

async function requireRegularFile(file, name) {
  const info = await lstat(file).catch(() => fail(`MISSING_${name.toUpperCase()}`));
  if (!info.isFile() || info.isSymbolicLink()) fail(`UNSAFE_${name.toUpperCase()}`);
}

async function requireDirectory(directory, name) {
  const info = await lstat(directory).catch(() => fail(`MISSING_${name.toUpperCase()}`));
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`UNSAFE_${name.toUpperCase()}`);
}

async function requireNodeIdentity(nodePath) {
  if (!nodePath.startsWith(HERMES_NODE_ROOT)) fail("NODE_PATH_NOT_HERMES");
  const [requested, running] = await Promise.all([realpath(nodePath), realpath(process.execPath)]);
  if (requested !== running) fail("NODE_PATH_DOES_NOT_MATCH_PROCESS");
  if (!process.versions.node.startsWith("26.")) fail("NODE26_REQUIRED");
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function manifest(runtimeArgv, artifactDigest) {
  return {
    manifestVersion: "capability.v2",
    ref: "node-isolation-probe",
    displayName: "Node isolation probe",
    version: "1.0.0",
    source: { type: "program", locator: "artifact:node-isolation-probe:1.0.0" },
    sourceIdentity: "qualification:node-isolation-probe",
    integrity: artifactDigest,
    artifact: {
      digest: artifactDigest,
      signatureStatus: "not_applicable",
      signerRef: null,
      rollbackArtifactRef: null,
    },
    operations: ["execute"],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["public"],
      network: [],
      filesystem: ["workspace:node-probe"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "unknown", checkedAt: null },
    reviewedBy: null,
    reviewedAt: null,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: runtimeArgv,
      environmentKeys: [],
      workdirRef: "workspace:node-probe",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: ["workspace:node-probe"],
    },
  };
}

function binding(options) {
  return {
    capabilityRef: "node-isolation-probe",
    capabilityVersion: "1.0.0",
    artifactDigest: options.artifactDigest,
    runtimeRoot: options.runtimeRoot,
    command: options.sandboxProbe,
    workdirRef: "workspace:node-probe",
    sandboxWorkdir: "/workspace",
    environment: {},
    availableExecutables: [SANDBOX_PROBE],
    resourceLimitExecutable: {
      sandboxPath: options.sandboxPrlimit,
      sha256: options.prlimitSha256,
    },
    filesystem: [
      {
        scopeRef: "workspace:node-probe",
        hostPath: options.workspace,
        sandboxPath: "/workspace",
        access: "read_write",
      },
    ],
    maximumResourceCeiling: NORMAL_CEILING,
    mcpServerIdentity: null,
    mcpServerName: null,
    mcpServerVersion: null,
    mcpOperationMap: {},
  };
}

function makeBackend(isolation, options, processBinding) {
  return new isolation.LinuxBubblewrapIsolationBackend({
    bindings: {
      resolveProcess: async () => processBinding,
      resolveEndpoint: async () => undefined,
    },
    clock: { now: () => NOW },
    platform: "linux",
    bwrapPath: options.bwrap,
    prlimitPath: options.prlimit,
  });
}

function summarizeResult(result) {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutBytes: result.stdout.byteLength,
    stderrBytes: result.stderr.byteLength,
    stdoutSha256: digest(result.stdout),
    stderrSha256: digest(result.stderr),
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
  };
}

async function waitForReady(marker, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const content = await readFile(marker, "utf8");
      if (content === "payload-fd-ready\n") return;
      fail("INVALID_READY_MARKER");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        await delay(20);
        continue;
      }
      throw error;
    }
  }
  fail("PAYLOAD_READY_TIMEOUT");
}

async function assertFifoWriterOpen(reader) {
  const buffer = Buffer.alloc(128);
  try {
    const { bytesRead } = await reader.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) fail("FIFO_WRITER_CLOSED_BEFORE_READY");
    fail("FIFO_PAYLOAD_WROTE_BEFORE_TERMINATION");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EAGAIN", "EWOULDBLOCK"].includes(error.code)
    ) {
      return;
    }
    throw error;
  }
}

async function waitForFifoEof(reader, timeoutMs = 2_000) {
  const startedAt = Date.now();
  const buffer = Buffer.alloc(128);
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { bytesRead } = await reader.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) return;
      fail("FIFO_PAYLOAD_WROTE_UNEXPECTED_BYTES");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EAGAIN", "EWOULDBLOCK"].includes(error.code)
      ) {
        await delay(20);
        continue;
      }
      throw error;
    }
  }
  fail("FIFO_WRITER_NOT_CLOSED");
}

async function awaitWithin(promise, timeoutMs, timeoutCode) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutCode)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function createFifo(workspace, name) {
  const fifo = path.join(workspace, name);
  const marker = path.join(workspace, `${name}.ready`);
  await execFile("/usr/bin/mkfifo", [fifo], { timeout: 2_000 });
  await chmod(fifo, 0o600);
  return { fifo, marker };
}

async function runHeldProcess(isolation, options, workspace, ceiling, action) {
  const { fifo, marker } = await createFifo(workspace, action);
  const reader = await open(fifo, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let controller;
  let runPromise;
  let runFinished = false;
  try {
    const holdManifest = manifest(
      [options.sandboxProbe, "--hold-fd", `/workspace/${action}`, `/workspace/${action}.ready`],
      options.artifactDigest,
    );
    const holdBinding = binding({
      ...options,
      workspace,
      prlimitSha256: options.prlimitSha256,
    });
    const backend = makeBackend(isolation, options, holdBinding);
    const launch = await backend.createLaunch(holdManifest, ceiling);
    controller = new AbortController();
    runPromise = isolation.runSandboxedProcess(launch, null, controller.signal);
    await waitForReady(marker, ceiling.maxWallTimeMs - 100);
    await assertFifoWriterOpen(reader);
    if (action === "cancelled-fifo") controller.abort();
    const result = await awaitWithin(runPromise, 5_000, "SANDBOX_TERMINATION_TIMEOUT");
    runFinished = true;
    await waitForFifoEof(reader);
    if (action === "timedout-fifo" && !result.timedOut) fail("TIMEOUT_NOT_REPORTED");
    if (action === "cancelled-fifo" && result.timedOut) fail("CANCEL_REPORTED_AS_TIMEOUT");
    return summarizeResult(result);
  } finally {
    if (!runFinished && runPromise && controller) {
      controller.abort();
      await awaitWithin(runPromise, 5_000, "SANDBOX_CLEANUP_TIMEOUT");
      await waitForFifoEof(reader);
    }
    await reader.close();
    await unlink(marker).catch(() => undefined);
    await unlink(fifo).catch(() => undefined);
  }
}

function requireReason(qualification, expected) {
  if (qualification.productionSuitable || !qualification.reasonCodes.includes(expected)) {
    fail(`QUALIFICATION_NEGATIVE_CASE_FAILED:${expected}`);
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const nodePath = absolutePath(arguments_.node, "INVALID_NODE");
  const options = Object.freeze({
    node: nodePath,
    isolation: hostPath(arguments_.isolation, "isolation"),
    bwrap: hostPath(arguments_.bwrap, "bwrap"),
    prlimit: hostPath(arguments_.prlimit, "prlimit"),
    runtimeRoot: hostPath(arguments_["runtime-root"], "runtime-root"),
    sandboxPrlimit: sandboxPath(arguments_["sandbox-prlimit"], SANDBOX_PRLIMIT, "sandbox-prlimit"),
    sandboxProbe: sandboxPath(arguments_["sandbox-probe"], SANDBOX_PROBE, "sandbox-probe"),
    workRoot: hostPath(arguments_["work-root"], "work-root"),
  });
  await requireNodeIdentity(options.node);
  await requireRegularFile(options.isolation, "isolation");
  await requireRegularFile(options.bwrap, "bwrap");
  await requireRegularFile(options.prlimit, "prlimit");
  await requireDirectory(options.runtimeRoot, "runtime_root");
  if (
    path.resolve(options.workRoot) === QUALIFICATION_ROOT ||
    !isWithin(QUALIFICATION_ROOT, options.workRoot)
  ) {
    fail("INVALID_WORK_ROOT");
  }
  await lstat(options.workRoot)
    .then(() => fail("WORK_ROOT_ALREADY_EXISTS"))
    .catch((error) => {
      if (error instanceof Error && error.message === "WORK_ROOT_ALREADY_EXISTS") throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  await mkdir(options.workRoot, { mode: 0o700 });
  await chmod(options.workRoot, 0o700);
  const workspace = path.join(options.workRoot, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  await chmod(workspace, 0o700);

  let isolation;
  try {
    isolation = await import(pathToFileURL(options.isolation).href);
  } catch {
    fail("ISOLATION_SOURCE_IMPORT_FAILED");
  }
  if (
    typeof isolation.LinuxBubblewrapIsolationBackend !== "function" ||
    typeof isolation.runSandboxedProcess !== "function"
  ) {
    fail("ISOLATION_EXPORTS_MISSING");
  }

  const prlimitSha256 = digest(await readFile(path.join(options.runtimeRoot, "usr/bin/prlimit")));
  const artifactDigest = digest(
    await readFile(path.join(options.runtimeRoot, "usr/bin/fork-probe")),
  );
  const baseOptions = { ...options, workspace, prlimitSha256, artifactDigest };
  const baseBinding = binding(baseOptions);
  const backend = makeBackend(isolation, baseOptions, baseBinding);
  const normalManifest = manifest([options.sandboxProbe, "--assert-nproc"], artifactDigest);
  const qualification = await backend.qualify(normalManifest);
  if (!qualification.productionSuitable) {
    console.error(
      JSON.stringify({
        node: process.version,
        backendQualification: {
          productionSuitable: qualification.productionSuitable,
          runtimeIdentity: qualification.runtimeIdentity,
          reasonCodes: qualification.reasonCodes,
        },
        evidenceTier: "node26-diagnostic-only",
      }),
    );
    fail("QUALIFICATION_NOT_READY");
  }
  const cachedQualification = await backend.qualify(normalManifest);
  if (JSON.stringify(qualification) !== JSON.stringify(cachedQualification))
    fail("QUALIFICATION_CACHE_CHANGED");
  const normalLaunch = await backend.createLaunch(normalManifest, NORMAL_CEILING);
  const normalResult = await isolation.runSandboxedProcess(normalLaunch, null);
  if (normalResult.exitCode !== 0 || normalResult.signal !== null || normalResult.timedOut) {
    fail("NORMAL_SANDBOX_RUN_FAILED");
  }

  const tamperedBinding = binding({
    ...baseOptions,
    prlimitSha256: `sha256:${"b".repeat(64)}`,
  });
  const tamperedQualification = await makeBackend(isolation, baseOptions, tamperedBinding).qualify(
    normalManifest,
  );
  requireReason(
    tamperedQualification,
    isolation.CAPABILITY_ISOLATION_ERROR_CODES.RUNTIME_ROOT_UNSAFE,
  );

  const mountedHelperBinding = {
    ...baseBinding,
    resourceLimitExecutable: {
      ...baseBinding.resourceLimitExecutable,
      sandboxPath: "/workspace/prlimit",
    },
  };
  const mountedHelperQualification = await makeBackend(
    isolation,
    baseOptions,
    mountedHelperBinding,
  ).qualify(normalManifest);
  requireReason(
    mountedHelperQualification,
    isolation.CAPABILITY_ISOLATION_ERROR_CODES.PROCESS_BINDING_MISMATCH,
  );

  const cancelled = await runHeldProcess(
    isolation,
    baseOptions,
    workspace,
    CANCEL_CEILING,
    "cancelled-fifo",
  );
  const timedOut = await runHeldProcess(
    isolation,
    baseOptions,
    workspace,
    TIMEOUT_CEILING,
    "timedout-fifo",
  );

  console.log(
    JSON.stringify(
      {
        node: process.version,
        backendQualification: {
          productionSuitable: qualification.productionSuitable,
          runtimeIdentity: qualification.runtimeIdentity,
          reasonCodes: qualification.reasonCodes,
        },
        manifest: {
          synthetic: true,
          source: "qualification-only",
          artifactDigest,
        },
        normalLaunch: {
          command: normalLaunch.command,
          args: normalLaunch.args,
        },
        normal: summarizeResult(normalResult),
        negativeCases: {
          tamperedHelper: tamperedQualification.reasonCodes,
          mountedHelper: mountedHelperQualification.reasonCodes,
        },
        cancelled,
        timedOut,
        evidenceTier: "node26-diagnostic-only",
      },
      null,
      2,
    ),
  );
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (scriptPath === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "NODE_ISOLATION_PROBE_FAILED");
    process.exitCode = 1;
  });
}
