import { createHash } from "node:crypto";
import path from "node:path";
import { scanMachineSecrets } from "@himawari-agent/application";
import type { SandboxScope } from "@himawari-agent/execution-contracts";
import { ConstrainedHostFileSystem } from "./constrained-file-system.js";
import { createDirectoryMoveJournal } from "./directory-move.js";
import { createPiFilePublicationJournal } from "./pi-file-publication.js";
import { exportPiOutputFile } from "./pi-output-export.js";
import { createSandboxedCodingOperations } from "./sandboxed-coding-operations.js";
import { createWorkspaceCopyPublication } from "./workspace-copy-publication.js";

export interface PiHostPublicationInput {
  readonly hostId: string;
  readonly tool: string;
  readonly executionMode: "foreground" | "background" | "service";
  readonly scope: SandboxScope;
  readonly workspace: string;
  readonly privateDirectory: string;
  readonly commandPath: string;
  readonly maxOutputBytes: number;
  readonly parametersJson: string;
}

export interface PiPublicationOutput {
  readonly output: string;
  readonly exitCode: number;
}

export function isPiHostPublication(input: {
  readonly tool: string;
  readonly scope: Pick<SandboxScope, "preparedFile">;
}): boolean {
  return (
    input.tool === "save_copy" ||
    input.tool === "move_directory" ||
    (["write", "edit"].includes(input.tool) && input.scope.preparedFile !== undefined)
  );
}

export async function formatForegroundPiResult(input: {
  readonly tool: string;
  readonly result: {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly details?: unknown;
    readonly isError: boolean;
  };
  readonly commandExitCode: number | null;
  readonly verifiedWrite: unknown;
  readonly privateDirectory: string;
  readonly maxOutputBytes: number;
  readonly closing: Readonly<Record<string, unknown>>;
  readonly source: Readonly<Record<string, unknown>>;
}): Promise<PiPublicationOutput> {
  const details =
    input.result.details && typeof input.result.details === "object"
      ? ({ ...input.result.details } as Record<string, unknown>)
      : {};
  const fullPath = details["fullOutputPath"];
  delete details["fullOutputPath"];
  const fullOutput =
    typeof fullPath === "string"
      ? await exportPiOutputFile(fullPath, input.privateDirectory, input.maxOutputBytes)
      : null;
  const content = input.result.content.map((part) =>
    part.type === "text" && typeof fullPath === "string" && typeof part.text === "string"
      ? { ...part, text: part.text.replaceAll(fullPath, "本次受保护结果的 fullOutput 字段") }
      : part,
  );
  const output = JSON.stringify({
    schemaVersion: "pi-result.v1",
    tool: input.tool,
    content,
    details,
    fullOutput,
    isError: input.result.isError,
    commandExitCode: input.commandExitCode,
    verifiedWrite: input.verifiedWrite,
    ...input.closing,
    source: input.source,
  });
  if (scanMachineSecrets(output).length) throw new Error("PI_RESULT_SECRET_REJECTED");
  if (Buffer.byteLength(output) > input.maxOutputBytes) throw new Error("PI_RESULT_OUTPUT_LIMIT");
  return {
    output,
    exitCode: !input.result.isError
      ? 0
      : input.commandExitCode && input.commandExitCode > 0 && input.commandExitCode < 256
        ? input.commandExitCode
        : 1,
  };
}

function bounded(output: string, maxOutputBytes: number) {
  if (Buffer.byteLength(output) > maxOutputBytes || scanMachineSecrets(output).length)
    throw new Error("PI_RESULT_OUTPUT_LIMIT");
  return output;
}

export async function publishPreparedPiOperation(
  input: PiHostPublicationInput,
): Promise<PiPublicationOutput> {
  if (!isPiHostPublication(input)) throw new Error("PI_HOST_PUBLICATION_UNSUPPORTED");
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
  if (input.scope.fileTarget && !["read", "write", "edit"].includes(input.tool))
    throw new Error("PI_FIXED_FILE_CONTRACT_INVALID");
  const source = {
    workspace: input.workspace,
    toolCallId: input.scope.toolCallId,
    directoryGrantRef: input.scope.directoryGrant.ref,
    directoryGrantRevision: input.scope.directoryGrant.revision,
    parameters,
  };
  if (input.tool === "save_copy") {
    const copySave = input.scope.copySave;
    if (
      input.executionMode !== "foreground" ||
      !copySave ||
      args["operationId"] !== copySave.operationId ||
      args["expectedHash"] !== copySave.canonicalHash ||
      Object.keys(args).some((key) => !["operationId", "expectedHash"].includes(key))
    )
      throw new Error("COPY_SAVE_INPUT_CHANGED");
    const journal = await createWorkspaceCopyPublication(input);
    let conflict = false;
    const verifiedCopySave = await journal.execute().catch(async (error) => {
      const proof = await journal.conflicted(error);
      conflict = true;
      return proof;
    });
    const output = JSON.stringify({
      schemaVersion: "pi-result.v1",
      tool: input.tool,
      isError: conflict,
      ...(conflict
        ? {
            fileConflict: {
              operationId: copySave.operationId,
              canonicalHash: copySave.canonicalHash,
            },
          }
        : {}),
      content: [
        {
          type: "text",
          text: conflict
            ? "原文件或依赖已变化；尚未开始保存，副本保留。"
            : "本次副本改动已逐文件保存并核验。",
        },
      ],
      verifiedCopySave,
      fileCommitClosed: true,
      source,
    });
    return { output: bounded(output, input.maxOutputBytes), exitCode: conflict ? 1 : 0 };
  }
  if (input.tool === "move_directory") {
    const move = input.scope.directoryMove;
    if (
      !move ||
      input.executionMode !== "foreground" ||
      typeof args["path"] !== "string" ||
      typeof args["destination"] !== "string" ||
      path.resolve(input.workspace, args["path"]) !==
        path.join(input.workspace, move.sourceRelativePath) ||
      path.resolve(input.workspace, args["destination"]) !==
        path.join(input.workspace, move.destinationRelativePath)
    )
      throw new Error("HOST_DIRECTORY_MOVE_SCOPE_CHANGED");
    const verifiedMove = await createDirectoryMoveJournal(input).execute();
    const output = JSON.stringify({
      schemaVersion: "pi-result.v1",
      tool: input.tool,
      content: [{ type: "text", text: "目录已移动。后续操作需要重新解析目标位置。" }],
      isError: false,
      verifiedMove,
      fileCommitClosed: true,
      source,
    });
    return { output: bounded(output, input.maxOutputBytes), exitCode: 0 };
  }
  const prepared = input.scope.preparedFile;
  const fileTarget = input.scope.fileTarget;
  if (!prepared || !target || !fileTarget) throw new Error("PI_PREPARED_TARGET_REQUIRED");
  const publication = createPiFilePublicationJournal(input);
  let verifiedWrite: { path: string; contentDigest: string; byteLength: number } | null = null;
  let verificationStarted = false;
  let publicationAttempted = false;
  const grant = {
    id: input.scope.directoryGrant.ref,
    revision: input.scope.directoryGrant.revision,
    hostId: input.hostId,
    canonicalRootId: input.scope.directoryGrant.canonicalRootId,
    displayPath: input.workspace,
    operations: input.scope.directoryGrant.operations,
    authorizationRef: input.scope.directoryGrant.authorizationRef,
    expiresAt: input.scope.expiresAt,
    revokedAt: null,
    dataClassification: "private" as const,
    disclosure: "worker" as const,
    pathPolicy: "same_filesystem_no_links" as const,
    mountPolicy: "fixed_device" as const,
  };
  try {
    const operations = await createSandboxedCodingOperations({
      onCommitStarting: async () => {
        publicationAttempted = true;
        await publication.commitStarting();
      },
      onPreparedWrite: publication.prepared,
      onVerifiedWrite: async (proof) => {
        if (verificationStarted) throw new Error("PI_MULTIPLE_WRITES_UNSUPPORTED");
        verificationStarted = true;
        await publication.verified(proof);
        verifiedWrite = proof;
      },
      grant,
      targetPath: target,
      expectedTarget: fileTarget,
      preparedFile: prepared,
      shell: path.join(input.commandPath, "bash"),
      privateDirectory: input.privateDirectory,
      commandPath: input.commandPath,
      maxOutputBytes: input.maxOutputBytes,
    });
    const platform = new ConstrainedHostFileSystem();
    const bytes = await platform.readPublication(grant, prepared.content);
    const resultBytes = await platform.readPublication(grant, prepared.result);
    if (
      createHash("sha256").update(bytes).digest("hex") !== prepared.contentDigest ||
      createHash("sha256").update(resultBytes).digest("hex") !== prepared.resultDigest ||
      resultBytes.length > input.maxOutputBytes
    )
      throw new Error("PI_PREPARED_CONTENT_CHANGED");
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resultBytes));
    if (
      !result ||
      result.isError !== false ||
      !Array.isArray(result.content) ||
      result.content.some(
        (part: { type?: unknown; text?: unknown }) =>
          part.type !== "text" || typeof part.text !== "string",
      )
    )
      throw new Error("PI_PREPARED_RESULT_INVALID");
    await operations.writeFile(target, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return await formatForegroundPiResult({
      tool: input.tool,
      result: result as {
        content: { type: "text"; text: string }[];
        details?: unknown;
        isError: boolean;
      },
      commandExitCode: null,
      verifiedWrite,
      privateDirectory: input.privateDirectory,
      maxOutputBytes: input.maxOutputBytes,
      closing: { fileCommitClosed: true },
      source,
    });
  } catch (error) {
    if (
      fileTarget.missingParents ||
      publicationAttempted ||
      !(error instanceof Error) ||
      ![
        "PI_FILE_VERSION_CHANGED",
        "HOST_FILE_IDENTITY_CHANGED",
        "HOST_FILE_CONTENT_CHANGED",
        "HOST_FILE_TARGET_EXISTS",
      ].includes(error.message)
    )
      throw error;
    const fileConflict = await publication.conflicted();
    const output = JSON.stringify({
      schemaVersion: "pi-result.v1",
      tool: input.tool,
      isError: true,
      fileConflict,
      fileCommitClosed: true,
      content: [
        {
          type: "text",
          text: "目标文件已变化，候选保留，尚未开始发布。请读取最新内容并通过原权限流程重新生成。",
        },
      ],
      source,
    });
    return { output: bounded(output, input.maxOutputBytes), exitCode: 1 };
  }
}
