import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import {
  type PiRunnerInput,
  type SandboxFileTarget,
  sandboxScopeSchema,
} from "@himawari-agent/execution-contracts";
import {
  ConstrainedHostFileSystem,
  createPiFilePublicationJournal,
  hasVerifiedPiFileConflict,
  verifyPiWriteEvidence,
} from "@himawari-agent/platform-node";
import { compileSandboxPolicy, prepareSandboxJobHost } from "@himawari-agent/runtime-sandbox";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { prepareProductionFile } from "../../apps/agent-service/src/production-file-preparation.ts";
import {
  piPreparationDiagnosticArguments,
  trackPiPreparationDiagnostics,
} from "../fixtures/pi-preparation-diagnostics.ts";

trackPiPreparationDiagnostics(import.meta.url);

const roots: string[] = [];
const preparations: Record<string, unknown>[] = [];
afterEach(async (context) => {
  if (context.task.result?.state === "fail") {
    const retainedRoots: string[] = [];
    const diagnostic = { preparations: [...preparations], retainedRoots };
    Object.assign(context.task.meta, { runtimePreparation: diagnostic });
    const output = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
    if (output) {
      const directory = path.join(output, `prepared-file-runner-${context.task.id}`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const root of roots) {
        const destination = path.join(directory, path.basename(root));
        await cp(root, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: async (entry) => !(await lstat(entry)).isSocket(),
        });
        retainedRoots.push(destination);
      }
      await writeFile(
        path.join(directory, "preparation.json"),
        JSON.stringify(diagnostic, null, 2),
        {
          mode: 0o600,
        },
      );
    }
  }
  preparations.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
let runtimeRoot = fileURLToPath(new URL("../../dist/node-runtime", import.meta.url));
let installation: string | undefined;
beforeAll(async () => {
  const { HIMAWARI_TEST_ARTIFACT: artifact, HIMAWARI_TEST_CONTEXT: context } = process.env;
  if (!artifact && !context) return;
  if (!artifact || !context) throw new Error("PREPARED_RUNNER_ARTIFACT_CONTEXT_REQUIRED");
  installation = await mkdtemp(path.join(testTemporaryRoot(), "prepared-runner-install-"));
  const installed = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../scripts/install-node-runtime.mjs", import.meta.url)),
      "--prefix",
      installation,
      "--artifact",
      artifact,
      "--context",
      context,
    ],
    {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  if (installed.status !== 0) throw new Error(`PREPARED_RUNNER_INSTALL_FAILED:${installed.stderr}`);
  runtimeRoot = path.join(installation, "lib/himawari-agent");
}, 240_000);
afterAll(async () => {
  if (installation) await rm(installation, { recursive: true, force: true });
});
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Exercise the installed preparation module as well as the commit runner. */
async function prepareFromRuntime(
  input: Parameters<typeof prepareProductionFile>[0],
): ReturnType<typeof prepareProductionFile> {
  const moduleUrl = pathToFileURL(
    path.join(
      runtimeRoot,
      "node_modules/@himawari-agent/agent-service/dist/production-file-preparation.js",
    ),
  ).href;
  const startedAt = Date.now();
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [
      ...piPreparationDiagnosticArguments(),
      "--input-type=module",
      "--eval",
      `
    import { readFileSync, writeSync } from "node:fs";
    const stage = (name) => writeSync(2, JSON.stringify({ event: "prepared-runtime.stage", stage: name, at: Date.now(), uptimeMs: process.uptime() * 1000 }) + "\\n");
    stage("process_started");
    const { prepareProductionFile } = await import(process.argv[1]);
    stage("module_imported");
    const input = JSON.parse(readFileSync(0, "utf8"));
    stage("prepare_started");
    const candidate = await prepareProductionFile(input);
    stage("prepare_finished");
    process.stdout.write(JSON.stringify(candidate));
  `,
      moduleUrl,
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  preparations.push({
    startedAt,
    elapsedMs: performance.now() - started,
    runtimeRoot,
    tool: input.tool,
    status: result.status,
    signal: result.signal,
    error: result.error
      ? { message: result.error.message, code: "code" in result.error ? result.error.code : null }
      : null,
    stderr: result.stderr,
    stages: result.stderr
      .split("\n")
      .filter((line) => line.startsWith('{"event":"prepared-runtime.stage"'))
      .map((line) => JSON.parse(line)),
  });
  if (result.status !== 0)
    throw new Error(`PREPARED_RUNTIME_FAILED:${result.error?.message || result.stderr}`);
  return JSON.parse(result.stdout);
}
async function setup(tool: "write" | "edit", relativePath = "file.txt") {
  const root = await realpath(await mkdtemp(path.join(testTemporaryRoot(), "prepared-runner-")));
  roots.push(root);
  const workspace = path.join(root, "workspace"),
    privateDirectory = path.join(root, "job");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(privateDirectory, { mode: 0o700 });
  const filename = path.join(workspace, relativePath);
  if (tool === "edit") {
    await writeFile(filename, "before\n");
    await chmod(filename, 0o640);
  }
  const platform = new ConstrainedHostFileSystem();
  const rootIdentity = await platform.inspectRoot(workspace);
  const grant: HostDirectoryGrant = {
    id: "directory",
    revision: 1,
    hostId: "host",
    canonicalRootId: `${rootIdentity.device}:${rootIdentity.inode}`,
    displayPath: workspace,
    operations: ["read", "create", "update"],
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "grant",
    expiresAt: "2999-01-01T00:00:00.000Z",
    revokedAt: null,
  };
  const previous = await platform.inspect(grant, relativePath);
  const target: SandboxFileTarget = {
    schemaVersion: "sandbox-file-target.v1",
    relativePath,
    lineage: [{ device: rootIdentity.device, inode: rootIdentity.inode }],
    before: previous
      ? { device: previous.device, inode: previous.inode, contentDigest: hash("before\n") }
      : null,
    ...(relativePath.includes("/") ? { missingParents: 1 } : {}),
  };
  const parameters =
    tool === "edit"
      ? { path: relativePath, edits: [{ oldText: "before", newText: "candidate" }] }
      : { path: relativePath, content: "candidate\n" };
  const preparedFile = await prepareFromRuntime({
    grant,
    target,
    tool,
    toolCallId: "call",
    parameters,
    resourceCeiling: {
      maxWallTimeMs: 10000,
      maxCpuTimeMs: 10000,
      maxMemoryBytes: 268435456,
      maxOutputBytes: 65536,
      maxProgressEvents: 10,
    },
  });
  const scope = sandboxScopeSchema.parse({
    schemaVersion: "sandbox-scope.v1",
    ownerId: "owner",
    agentId: "agent",
    threadId: "thread",
    runId: "run",
    toolCallId: "call",
    parentToolCallId: null,
    parentRequestId: "run",
    hostId: "host",
    handleRef: "handle",
    inputRef: "input",
    operation: tool,
    authorizationRef: "grant",
    modelRef: "model",
    profileRef: "authorized-project.v1",
    directoryGrant: {
      ref: grant.id,
      revision: 1,
      canonicalRootId: grant.canonicalRootId,
      authorizationRef: "grant",
      operations: grant.operations,
    },
    networkAuthorizationRef: null,
    expiresAt: grant.expiresAt,
    fileTarget: target,
    preparedFile,
  });
  const input: PiRunnerInput = {
    schemaVersion: "pi-runner.v1",
    workerInstanceId: "worker",
    tool,
    scope,
    workspace,
    runtimeRoot,
    privateDirectory,
    maxOutputBytes: 65536,
    parametersJson: JSON.stringify(parameters),
    executionMode: "foreground",
  };
  return { grant, input, filename, platform, preparedFile };
}
/** Real built runner process and filesystem; SQLite admission and SRT isolation
 * are verified separately. This launch is not a platform qualification claim. */
async function run(input: PiRunnerInput) {
  if (process.env["HIMAWARI_FIXED_RUNNER_SANDBOX"] === "1") {
    const policy = {
      workspace: input.workspace,
      writable: true,
      privateDirectory: input.privateDirectory,
      readOnlyToolchainPaths: [
        ...new Set(
          await Promise.all(
            [
              runtimeRoot,
              process.execPath,
              "/bin",
              "/usr/bin",
              "/usr/lib",
              ...(process.platform === "darwin"
                ? ["/System"]
                : [
                    "/lib",
                    "/lib64",
                    "/proc",
                    "/dev",
                    path.resolve(
                      path.dirname(
                        createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"),
                      ),
                      "../vendor/seccomp",
                    ),
                  ]),
            ].map((filename) => realpath(filename)),
          ),
        ),
      ],
      protectedPaths: [],
      allowedDomains: [],
    };
    const compiled = await compileSandboxPolicy(policy);
    const host = prepareSandboxJobHost({
      jobId: "fixed-runner-test",
      attemptId: "attempt",
      policy,
      policyDigest: compiled.policyDigest,
      executable: process.execPath,
      args: [
        path.join(
          runtimeRoot,
          "node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js",
        ),
        "host",
        "worker",
      ],
      stdinBase64: Buffer.from(JSON.stringify(input)).toString("base64"),
      deadlineAt: new Date(Date.now() + 30000).toISOString(),
      maxOutputBytes: 65536,
      cleanupTimeoutMs: 5000,
      resourceLimits: { maxCpuTimeMs: 10000, maxMemoryBytes: 268435456 },
    });
    try {
      await host.ready;
      host.start();
      const result = await host.result;
      return {
        code: result.exitCode,
        out: Buffer.from(result.stdout).toString(),
        err: Buffer.from(result.stderr).toString(),
        taskStarted: result.taskStarted,
        taskProcessExited: result.taskProcessExited,
        reason: result.reason,
      };
    } finally {
      host.cancel();
      await host.result;
    }
  }
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const program = path.join(
      runtimeRoot,
      "node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js",
    );
    const child = spawn(process.execPath, [program, "host", "worker"], {
      cwd: input.workspace,
      env: { ...process.env, HOME: input.privateDirectory, TMPDIR: input.privateDirectory },
      stdio: "pipe",
    });
    let out = "",
      err = "";
    child.stdout.on("data", (bytes) => {
      out += bytes;
    });
    child.stderr.on("data", (bytes) => {
      err += bytes;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("prepared files through the installed runner", () => {
  it.each(["write", "edit"] as const)(
    "publishes prepared %s once and recovers the same effect",
    async (tool) => {
      const f = await setup(tool);
      const inode = f.preparedFile.content.identity.inode;
      if (tool === "edit") expect(await readFile(f.filename, "utf8")).toBe("before\n");
      else await expect(readFile(f.filename)).rejects.toMatchObject({ code: "ENOENT" });
      const result = await run(f.input);
      expect(result, result.err).toMatchObject({ code: 0, err: "" });
      const output = JSON.parse(result.out);
      expect(output).toMatchObject({
        isError: false,
        verifiedWrite: { contentDigest: hash("candidate\n") },
      });
      if (tool === "edit") expect(output.details.diff).toContain("candidate");
      expect(await readFile(f.filename, "utf8")).toBe("candidate\n");
      expect(String((await stat(f.filename)).ino)).toBe(inode);
      expect((await stat(f.filename)).mode & 0o777).toBe(tool === "edit" ? 0o640 : 0o600);
      await writeFile(f.filename, "later user edit");
      expect(await createPiFilePublicationJournal(f.input).recover(f.grant)).toMatchObject({
        contentDigest: hash("candidate\n"),
      });
      expect((await run(f.input)).code).toBe(1);
      expect(await readFile(f.filename, "utf8")).toBe("later user edit");
    },
  );
  it("runs the installed no-overwrite directory program and verifies the original inode", async () => {
    const f = await setup("write");
    const workspace = f.input.workspace;
    await mkdir(path.join(workspace, "reports"));
    await writeFile(path.join(workspace, "reports/note.txt"), "retained");
    const root = await stat(workspace),
      source = await stat(path.join(workspace, "reports"));
    const rootIdentity = { device: String(root.dev), inode: String(root.ino) };
    const sourceIdentity = { device: String(source.dev), inode: String(source.ino) };
    const { fileTarget: _file, preparedFile: _prepared, ...base } = f.input.scope;
    const scope = sandboxScopeSchema.parse({
      ...base,
      operation: "move_directory",
      directoryGrant: { ...base.directoryGrant, operations: ["read", "move"] },
      directoryMove: {
        schemaVersion: "sandbox-directory-move.v1",
        sourceRelativePath: "reports",
        destinationRelativePath: "archive",
        sourceIdentity,
        sourceLineage: [rootIdentity, sourceIdentity],
        destinationLineage: [rootIdentity],
      },
    });
    const parameters = { path: "reports", destination: "archive" };
    const input: PiRunnerInput = {
      ...f.input,
      tool: "move_directory",
      scope,
      parametersJson: JSON.stringify(parameters),
    };
    const result = await run(input);
    expect(result, result.err).toMatchObject({ code: 0, err: "" });
    const verification = {
      bytes: Buffer.from(result.out),
      parameters,
      scope,
      workspace,
      plan: {
        operation: "move_directory",
        identity: { toolCallId: scope.toolCallId },
        operationContract: {
          ref: "pi-coding-tool",
          version: "4",
          kind: "verified_effect" as const,
          verifierRef: "host-directory-move",
          verifierVersion: "1",
          targetRef: "pi-input:source-destination",
        },
      },
    };
    expect(verifyPiWriteEvidence(verification)).toBe("published");
    const changed = JSON.parse(result.out);
    changed.verifiedMove.inode = "999999";
    expect(() =>
      verifyPiWriteEvidence({ ...verification, bytes: Buffer.from(JSON.stringify(changed)) }),
    ).toThrow("PI_WRITE_EVIDENCE_INVALID");
    expect((await stat(path.join(workspace, "archive"))).ino).toBe(source.ino);
    expect(await readFile(path.join(workspace, "archive/note.txt"), "utf8")).toBe("retained");
    await expect(stat(path.join(workspace, "reports"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run(input)).code).toBe(1);
    expect(await readFile(path.join(workspace, "archive/note.txt"), "utf8")).toBe("retained");
  });

  it("never certifies no effect once the publication syscall was durably armed", async () => {
    const f = await setup("edit");
    const journal = createPiFilePublicationJournal(f.input);
    await journal.commitStarting();
    await expect(journal.conflicted()).rejects.toThrow();
    expect(await journal.recoverConflict()).toBeUndefined();
    expect(await readFile(f.filename, "utf8")).toBe("before\n");
  });
  it("cannot publish again after an immutable conflict receipt", async () => {
    const f = await setup("edit");
    const journal = createPiFilePublicationJournal(f.input);
    await journal.conflicted();
    await expect(journal.commitStarting()).rejects.toThrow();
    expect(await journal.recoverConflict()).toMatchObject({ phase: "before_publish" });
    expect(await readFile(f.filename, "utf8")).toBe("before\n");
  });

  it("creates missing parents only when committing and retains the actual published inode", async () => {
    const f = await setup("write", "new/file.txt");
    await expect(stat(path.dirname(f.filename))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run(f.input)).toMatchObject({ code: 0, err: "" });
    expect(await readFile(f.filename, "utf8")).toBe("candidate\n");
    expect(String((await stat(f.filename)).ino)).toBe(f.preparedFile.content.identity.inode);
  });
  it.each(["content", "result", "target", "mode", "expired"] as const)(
    "blocks %s changes without losing the candidate or overwriting the target",
    async (changed) => {
      const f = await setup("edit");
      if (changed === "content" || changed === "result")
        await writeFile(f.preparedFile[changed].identity.canonicalPath, "tampered");
      if (changed === "target") await writeFile(f.filename, "external edit");
      if (changed === "mode") await chmod(f.filename, 0o600);
      const input =
        changed === "expired"
          ? { ...f.input, scope: { ...f.input.scope, expiresAt: "2000-01-01T00:00:00.000Z" } }
          : f.input;
      const result = await run(input);
      expect(result.code).toBe(1);
      if (changed === "target") {
        const proof = JSON.parse(result.out);
        expect(proof).toMatchObject({
          isError: true,
          fileConflict: { phase: "before_publish", reasonCode: "FILE_VERSION_CONFLICT" },
        });
        const verified = hasVerifiedPiFileConflict({
          bytes: Buffer.from(result.out),
          parameters: JSON.parse(input.parametersJson),
          scope: input.scope,
          plan: {
            operation: input.tool,
            identity: { toolCallId: input.scope.toolCallId },
            operationContract: {
              ref: "pi-coding-tool",
              version: "3",
              kind: "verified_effect",
              verifierRef: "pi-atomic-write",
              verifierVersion: "1",
              targetRef: "pi-input:path",
            },
          },
          workspace: input.workspace,
        });
        expect(verified).toBe(true);
        expect(await createPiFilePublicationJournal(input).recoverConflict()).toEqual(
          proof.fileConflict,
        );
      }
      if (changed === "mode") expect((await stat(f.filename)).mode & 0o777).toBe(0o600);
      expect(await readFile(f.filename, "utf8")).toBe(
        changed === "target" ? "external edit" : "before\n",
      );
      expect(await readFile(f.preparedFile.content.identity.canonicalPath, "utf8")).toBe(
        changed === "content" ? "tampered" : "candidate\n",
      );
    },
  );
});
