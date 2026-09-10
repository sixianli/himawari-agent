import { createHash } from "node:crypto";
import path from "node:path";
import {
  PI_RUNNER_CONTRACT,
  PI_WRITE_VERIFIER,
  type SandboxExecutionPlanV2,
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
  };
  readonly workspace?: string;
}): void {
  const reject = () => {
    throw new Error("PI_WRITE_EVIDENCE_INVALID");
  };
  const contract = input.plan.operationContract;
  if (
    contract.kind !== "verified_effect" ||
    contract.ref !== PI_RUNNER_CONTRACT.ref ||
    contract.version !== PI_RUNNER_CONTRACT.version ||
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
    (result.isError !== undefined && result.isError !== false) ||
    !result.source ||
    !result.verifiedWrite ||
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
}
