import { createHash } from "node:crypto";
import path from "node:path";
import {
  DIRECTORY_MOVE_VERIFIER,
  PI_DIRECTORY_MOVE_CONTRACT,
  PI_FIXED_FILE_CONTRACT,
  PI_PREPARED_FILE_CONTRACT,
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
  type SandboxDirectoryMove,
  type SandboxExecutionPlanV2,
  type SandboxFileTarget,
  type SandboxPreparedFile,
  type SandboxScope,
} from "@himawari-agent/execution-contracts";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
/** Validate the installed runner's actual read-back proof against the original
 * admitted input and scope. This authenticates retained evidence, never replays I/O. */
export function verifyPiWriteEvidence(input: {
  readonly bytes: Uint8Array;
  readonly parameters: unknown;
  readonly plan: Pick<SandboxExecutionPlanV2, "operationContract" | "operation"> & {
    readonly identity: Pick<SandboxExecutionPlanV2["identity"], "toolCallId">;
  };
  readonly scope: {
    readonly directoryGrant: Pick<SandboxScope["directoryGrant"], "ref" | "revision">;
    readonly directoryMove?: SandboxDirectoryMove;
    readonly preparedFile?: SandboxPreparedFile;
    readonly fileTarget?: SandboxFileTarget;
  };
  readonly workspace?: string;
}): "published" | "conflict" {
  const reject = () => {
    throw new Error("PI_WRITE_EVIDENCE_INVALID");
  };
  const contract = input.plan.operationContract;
  if (
    contract.ref === PI_DIRECTORY_MOVE_CONTRACT.ref &&
    contract.version === PI_DIRECTORY_MOVE_CONTRACT.version
  ) {
    const expected = input.scope.directoryMove;
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
    const parameters = input.parameters as { path?: unknown; destination?: unknown };
    if (
      contract.kind !== "verified_effect" ||
      contract.verifierRef !== DIRECTORY_MOVE_VERIFIER.ref ||
      contract.verifierVersion !== DIRECTORY_MOVE_VERIFIER.version ||
      contract.targetRef !== DIRECTORY_MOVE_VERIFIER.targetRef ||
      input.plan.operation !== "move_directory" ||
      !expected ||
      !result ||
      result.schemaVersion !== "pi-result.v1" ||
      result.tool !== "move_directory" ||
      result.isError !== false ||
      !result.source ||
      result.source.toolCallId !== input.plan.identity.toolCallId ||
      result.source.directoryGrantRef !== input.scope.directoryGrant.ref ||
      result.source.directoryGrantRevision !== input.scope.directoryGrant.revision ||
      hash(result.source.parameters) !== hash(input.parameters) ||
      typeof result.source.workspace !== "string" ||
      !path.isAbsolute(result.source.workspace) ||
      path.normalize(result.source.workspace) !== result.source.workspace ||
      (input.workspace !== undefined && result.source.workspace !== input.workspace) ||
      typeof parameters?.path !== "string" ||
      typeof parameters.destination !== "string" ||
      path.resolve(result.source.workspace, parameters.path) !==
        path.join(result.source.workspace, expected.sourceRelativePath) ||
      path.resolve(result.source.workspace, parameters.destination) !==
        path.join(result.source.workspace, expected.destinationRelativePath) ||
      hash(result.verifiedMove) !==
        hash({
          sourceRelativePath: expected.sourceRelativePath,
          destinationRelativePath: expected.destinationRelativePath,
          ...expected.sourceIdentity,
        })
    )
      reject();
    return "published";
  }
  if (
    contract.kind !== "verified_effect" ||
    contract.ref !== PI_RUNNER_CONTRACT.ref ||
    ![
      PI_RUNNER_CONTRACT.version,
      PI_FIXED_FILE_CONTRACT.version,
      PI_PREPARED_FILE_CONTRACT.version,
    ].some((version) => version === contract.version) ||
    contract.verifierRef !== PI_WRITE_VERIFIER.ref ||
    contract.verifierVersion !== PI_WRITE_VERIFIER.version ||
    contract.targetRef !== PI_WRITE_VERIFIER.targetRef ||
    !["write", "edit"].includes(input.plan.operation)
  )
    reject();
  const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  if (
    !result ||
    typeof result !== "object" ||
    result.schemaVersion !== "pi-result.v1" ||
    result.tool !== input.plan.operation ||
    !result.source ||
    hash(result.source.parameters) !== hash(input.parameters)
  )
    reject();
  const source = result.source,
    proof = result.verifiedWrite;
  if (
    source.toolCallId !== input.plan.identity.toolCallId ||
    source.directoryGrantRef !== input.scope.directoryGrant.ref ||
    source.directoryGrantRevision !== input.scope.directoryGrant.revision ||
    typeof source.workspace !== "string" ||
    !path.isAbsolute(source.workspace) ||
    path.normalize(source.workspace) !== source.workspace ||
    (input.workspace !== undefined && source.workspace !== input.workspace)
  )
    reject();
  if (result.fileConflict !== undefined) {
    if (
      contract.version !== PI_PREPARED_FILE_CONTRACT.version ||
      !input.scope.preparedFile ||
      !input.scope.fileTarget ||
      input.scope.fileTarget.missingParents ||
      result.isError !== true ||
      result.verifiedWrite != null ||
      hash(result.fileConflict) !==
        hash({
          reasonCode: "FILE_VERSION_CONFLICT",
          phase: "before_publish",
          target: input.scope.fileTarget,
          candidateDigest: input.scope.preparedFile.contentDigest,
        })
    )
      reject();
    return "conflict";
  }
  if (!proof || (result.isError !== undefined && result.isError !== false)) reject();
  const parameters = input.parameters as Record<string, unknown>;
  if (
    !parameters ||
    typeof parameters["path"] !== "string" ||
    typeof proof.path !== "string" ||
    proof.path !== path.resolve(source.workspace, parameters["path"]) ||
    !proof.path.startsWith(`${source.workspace}/`) ||
    typeof proof.contentDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.contentDigest) ||
    !Number.isSafeInteger(proof.byteLength) ||
    proof.byteLength < 0 ||
    proof.byteLength > 16 * 1024 * 1024
  )
    reject();
  if (input.plan.operation === "write") {
    if (typeof parameters["content"] !== "string") reject();
    const bytes = Buffer.from(parameters["content"] as string);
    if (
      bytes.length !== proof.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== proof.contentDigest
    )
      reject();
  }
  return "published";
}

export function hasVerifiedPiFileConflict(
  input: Parameters<typeof verifyPiWriteEvidence>[0],
): boolean {
  try {
    return verifyPiWriteEvidence(input) === "conflict";
  } catch {
    return false;
  }
}
