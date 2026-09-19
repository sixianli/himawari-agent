import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import {
  sandboxScopeSchema,
  type PiRunnerInput,
  type SandboxFileTarget,
} from "@himawari-agent/execution-contracts";
import {
  ConstrainedHostFileSystem,
  createPiFilePublicationJournal,
} from "@himawari-agent/platform-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { prepareProductionFile } from "../../apps/agent-service/src/production-file-preparation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
let runtimeRoot = fileURLToPath(new URL("../../dist/node-runtime", import.meta.url));
let installation: string | undefined;
beforeAll(async () => {
  const { HIMAWARI_TEST_ARTIFACT: artifact, HIMAWARI_TEST_CONTEXT: context } = process.env;
  if (!artifact && !context) return; // Narrow development check uses the explicit local build.
  if (!artifact || !context) throw new Error("PREPARED_RUNNER_ARTIFACT_CONTEXT_REQUIRED");
  installation = await mkdtemp(path.join(tmpdir(), "prepared-runner-install-"));
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
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { readFileSync } from "node:fs";
    const { prepareProductionFile } = await import(process.argv[1]);
    const candidate = await prepareProductionFile(JSON.parse(readFileSync(0, "utf8")));
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
  if (result.status !== 0)
    throw new Error(`PREPARED_RUNTIME_FAILED:${result.stderr || result.error?.message}`);
  return JSON.parse(result.stdout);
}
async function setup(tool: "write" | "edit", relativePath = "file.txt") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "prepared-runner-")));
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
function run(input: PiRunnerInput) {
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
      expect((await run(input)).code).toBe(1);
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
