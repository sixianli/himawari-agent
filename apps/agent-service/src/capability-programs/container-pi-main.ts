import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { piContainerRunnerInputSchema } from "@himawari-agent/execution-contracts";
import { createSandboxedCodingOperations } from "@himawari-agent/platform-node";
import { writeForegroundPiResult } from "./pi-foreground-result.js";

const CONTAINER_COMMAND_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PRIVATE_DIRECTORY = "/tmp";
const WRITE_OPERATIONS = [
  "read",
  "create",
  "update",
  "move",
  "trash",
  "restore",
  "permanent_delete",
] as const;

const [inputJson, ...extra] = process.argv.slice(2);
try {
  if (!inputJson || extra.length) throw new Error("PI_RUNNER_INPUT_INVALID");
  const input = piContainerRunnerInputSchema.parse(JSON.parse(inputJson));
  if (input.expiresAt <= new Date().toISOString()) throw new Error("PI_RUNNER_SCOPE_EXPIRED");
  process.env["PI_OFFLINE"] = "1";
  process.env["PI_CODING_AGENT_DIR"] = path.join(PRIVATE_DIRECTORY, ".pi");
  process.env["PATH"] = CONTAINER_COMMAND_PATH;
  const parameters: unknown = JSON.parse(input.parametersJson);
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    throw new Error("PI_ARGUMENTS_INVALID");
  const args = parameters as Record<string, unknown>;
  const target =
    typeof args["path"] === "string" ? path.resolve(input.workspace, args["path"]) : undefined;
  if (
    target &&
    target !== input.workspace &&
    (!target.startsWith(`${input.workspace}/`) ||
      target
        .split("/")
        .some((part) => part === ".git" || part === ".env" || part.startsWith(".himawari-")))
  )
    throw new Error("PI_PATH_OUTSIDE_SCOPE");
  const root = await lstat(input.workspace);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("PI_WORKSPACE_UNSAFE");
  let verifiedWrite: { path: string; contentDigest: string; byteLength: number } | null = null;
  const operations = await createSandboxedCodingOperations({
    onVerifiedWrite: (proof) => {
      if (verifiedWrite) throw new Error("PI_MULTIPLE_WRITES_UNSUPPORTED");
      verifiedWrite = proof;
    },
    grant: {
      id: input.grantRef,
      revision: input.grantRevision,
      hostId: input.hostId,
      canonicalRootId: `${root.dev}:${root.ino}`,
      displayPath: input.workspace,
      operations: input.access === "write" ? [...WRITE_OPERATIONS] : ["read"],
      authorizationRef: input.authorizationRef,
      expiresAt: input.expiresAt,
      revokedAt: null,
      dataClassification: "private",
      disclosure: "worker",
      pathPolicy: "same_filesystem_no_links",
      mountPolicy: "fixed_device",
    },
    ...(["read", "edit", "write"].includes(input.tool) && target ? { targetPath: target } : {}),
    shell: "/bin/bash",
    privateDirectory: PRIVATE_DIRECTORY,
    commandPath: CONTAINER_COMMAND_PATH,
    maxOutputBytes: input.maxOutputBytes,
  });
  const { executeSandboxedPiCodingTool } = await import("@himawari-agent/runtime-pi");
  let commandExitCode: number | null = null;
  const result = await executeSandboxedPiCodingTool({
    name: input.tool,
    toolCallId: input.toolCallId,
    cwd: input.workspace,
    parameters,
    operations: {
      ...operations,
      async executeCommand(command) {
        const completed = await operations.executeCommand(command);
        commandExitCode = completed.exitCode;
        return completed;
      },
    },
  });
  await writeForegroundPiResult({
    tool: input.tool,
    result,
    commandExitCode,
    verifiedWrite,
    privateDirectory: PRIVATE_DIRECTORY,
    maxOutputBytes: input.maxOutputBytes,
    closing: {},
    source: {
      workspace: input.workspace,
      toolCallId: input.toolCallId,
      directoryGrantRef: input.grantRef,
      directoryGrantRevision: input.grantRevision,
      parameters,
    },
  });
} catch {
  process.stderr.write("PI_RUNNER_EXECUTION_FAILED\n");
  process.exitCode = 1;
}
