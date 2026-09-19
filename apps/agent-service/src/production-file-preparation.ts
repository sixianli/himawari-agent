import { createHash } from "node:crypto";
import path from "node:path";
import {
  scanMachineSecrets,
  type CapabilityResourceCeiling,
  type HostDirectoryGrant,
} from "@himawari-agent/application";
import {
  sandboxPreparedFileSchema,
  type SandboxFileTarget,
} from "@himawari-agent/execution-contracts";
import { ConstrainedHostFileSystem } from "@himawari-agent/platform-node";
import { preparePiFileMutation } from "@himawari-agent/runtime-pi";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Runs before reservation: only a frozen snapshot and private candidate files.
 * Admission still checks live authority and the original target version afterward. */
export async function prepareProductionFile(input: {
  readonly grant: HostDirectoryGrant;
  readonly target: SandboxFileTarget;
  readonly tool: "write" | "edit";
  readonly toolCallId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly resourceCeiling: CapabilityResourceCeiling;
  readonly signal?: AbortSignal;
}) {
  const { signal, ...snapshot } = input;
  input = { ...structuredClone(snapshot), ...(signal ? { signal } : {}) };
  signal?.throwIfAborted();
  const platform = new ConstrainedHostFileSystem();
  const identity = await platform.inspect(input.grant, input.target.relativePath);
  if (identity && !input.grant.operations.includes("read"))
    throw new Error("PI_DIRECTORY_OPERATION_DENIED");
  const before = identity
    ? await platform.read(input.grant, input.target.relativePath, 16 * 1024 * 1024, identity)
    : null;
  const expected = input.target.before;
  if (
    expected === null
      ? identity !== undefined
      : !identity ||
        !before ||
        expected.device !== identity.device ||
        expected.inode !== identity.inode ||
        expected.contentDigest !== digest(before)
  )
    throw new Error("SANDBOX_FILE_VERSION_CHANGED");
  if (!input.grant.operations.includes(identity ? "update" : "create"))
    throw new Error("PI_DIRECTORY_OPERATION_DENIED");
  if (before && input.tool === "edit") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(before);
    if (text.includes("\0") || scanMachineSecrets(text).length)
      throw new Error("PI_TEXT_READ_REJECTED");
  }
  const prepared = await preparePiFileMutation({
    tool: input.tool,
    toolCallId: input.toolCallId,
    cwd: input.grant.displayPath,
    targetPath: path.join(input.grant.displayPath, input.target.relativePath),
    parameters: input.parameters,
    before,
    limits: input.resourceCeiling,
    ...(signal ? { signal } : {}),
  });
  const result = Buffer.from(JSON.stringify(prepared.result));
  if (result.length > input.resourceCeiling.maxOutputBytes || result.length > 16 * 1024 * 1024)
    throw new Error("PI_RESULT_OUTPUT_LIMIT");
  if (scanMachineSecrets(result.toString("utf8")).length)
    throw new Error("PI_RESULT_SECRET_REJECTED");
  if (
    (await platform.storageObservation(input.grant)).availableBytes <
    prepared.bytes.length + result.length + 64 * 1024 * 1024
  )
    throw new Error("PI_STORAGE_RESERVE");
  signal?.throwIfAborted();
  // Independent candidates may stage concurrently. No target parent is created here.
  const content = await platform.stagePublication(
    input.grant,
    prepared.bytes,
    identity ? identity.mode & 0o777 : 0o600,
  );
  const resultPublication = await platform.stagePublication(input.grant, result);
  return sandboxPreparedFileSchema.parse({
    schemaVersion: "sandbox-prepared-file.v1",
    content,
    contentDigest: digest(prepared.bytes),
    result: resultPublication,
    resultDigest: digest(result),
  });
}
