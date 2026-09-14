import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { DataClassification } from "../ports/common.js";
import type { PayloadProtectorPort, PayloadStorePort } from "../ports/observability.js";
import type { RunPayloadArtifactPort } from "../ports/run-payload-artifacts.js";
import type {
  RuntimeHistoryPort,
  RuntimeHistoryReference,
  RuntimeHistoryState,
} from "../ports/runtime-history.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

const rank = { public: 0, private: 1, sensitive: 2, restricted: 3 };
interface Dependencies {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly artifacts: RunPayloadArtifactPort;
  readonly payloads: Pick<PayloadStorePort, "get">;
  readonly protector: PayloadProtectorPort;
}
function reference(value: unknown): value is RuntimeHistoryReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    ["runId", "operationKey", "payloadRef"].every(
      (key) => typeof item[key] === "string" && item[key].length > 0,
    ) &&
    typeof item["dataClassification"] === "string" &&
    Object.hasOwn(rank, item["dataClassification"])
  );
}
export function isRuntimeHistoryReference(value: unknown): value is RuntimeHistoryReference {
  return reference(value);
}

/** Persist native messages separately from presentation traces, without rewriting their fields. */
export class RuntimeHistoryService implements RuntimeHistoryPort {
  private readonly known = new Map<string, RuntimeHistoryReference>();
  private readonly dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }

  async save(input: {
    readonly runId: RunId;
    readonly dataClassification: DataClassification;
    readonly coveredRunIds?: readonly RunId[];
    readonly messages: readonly unknown[];
  }): Promise<RuntimeHistoryReference> {
    const entries: RuntimeHistoryReference[] = [];
    for (const message of input.messages) {
      const serialized = JSON.stringify(message);
      if (serialized === undefined) throw new Error("RUNTIME_HISTORY_MESSAGE_INVALID");
      const key = `${input.dataClassification}:${serialized}`;
      let ref = this.known.get(key);
      if (!ref) {
        ref = await this.write(input.runId, input.dataClassification, "message", message);
        this.remember(key, ref);
      }
      entries.push(ref);
    }
    return this.write(input.runId, input.dataClassification, "snapshot", {
      version: "pi-history.v1",
      entries,
      coveredRunIds: [...new Set([...(input.coveredRunIds ?? []), input.runId])],
    });
  }

  async load(
    ref: RuntimeHistoryReference,
    classification: DataClassification,
  ): Promise<RuntimeHistoryState> {
    if (!reference(ref) || !ref.operationKey.startsWith("snapshot:"))
      throw new Error("RUNTIME_HISTORY_REFERENCE_INVALID");
    const manifest = (await this.read(ref, classification)) as {
      version?: unknown;
      entries?: unknown;
      coveredRunIds?: unknown;
    };
    if (
      !manifest ||
      manifest.version !== "pi-history.v1" ||
      !Array.isArray(manifest.entries) ||
      !manifest.entries.every(reference) ||
      !Array.isArray(manifest.coveredRunIds) ||
      !manifest.coveredRunIds.every((id) => typeof id === "string" && id.length > 0)
    )
      throw new Error("RUNTIME_HISTORY_SNAPSHOT_INVALID");
    const messages: unknown[] = [];
    for (const item of manifest.entries) {
      if (!item.operationKey.startsWith("message:"))
        throw new Error("RUNTIME_HISTORY_MESSAGE_REFERENCE_INVALID");
      const message = await this.read(item, classification);
      this.remember(`${item.dataClassification}:${JSON.stringify(message)}`, item);
      messages.push(message);
    }
    return { messages, coveredRunIds: manifest.coveredRunIds as RunId[] };
  }

  private remember(key: string, ref: RuntimeHistoryReference): void {
    if (this.known.size >= 2048) this.known.clear();
    this.known.set(key, ref);
  }

  private async write(
    runId: RunId,
    dataClassification: DataClassification,
    kind: "message" | "snapshot",
    value: unknown,
  ): Promise<RuntimeHistoryReference> {
    const ref = this.dependencies.ids.next("runtime-history");
    const payload = await this.dependencies.protector.protect({
      ownerId: this.dependencies.ownerId,
      agentId: this.dependencies.agentId,
      ref,
      dataClassification,
      contentType: "application/json",
      plaintext: new TextEncoder().encode(JSON.stringify(value)),
      createdAt: this.dependencies.clock.now(),
    });
    // Message content is immutable and deduplicated. Snapshots have fresh identities:
    // returning to an earlier context must still advance the canonical snapshot order.
    const operationKey =
      kind === "message"
        ? `${kind}:${dataClassification}:${payload.contentDigest}`
        : `${kind}:${ref}`;
    const saved = await this.dependencies.artifacts.commit({
      runId,
      purpose: "runtime_history",
      operationKey,
      payload,
    });
    return { runId, operationKey, payloadRef: saved.ref, dataClassification };
  }

  private async read(
    ref: RuntimeHistoryReference,
    classification: DataClassification,
  ): Promise<unknown> {
    if (rank[ref.dataClassification] > rank[classification])
      throw new Error("RUNTIME_HISTORY_CLASSIFICATION_DENIED");
    const artifact = await this.dependencies.artifacts.lookup({
      runId: ref.runId,
      purpose: "runtime_history",
      operationKey: ref.operationKey,
    });
    if (
      !artifact ||
      artifact.ownerId !== this.dependencies.ownerId ||
      artifact.agentId !== this.dependencies.agentId ||
      artifact.payloadRef !== ref.payloadRef ||
      artifact.dataClassification !== ref.dataClassification
    )
      throw new Error("RUNTIME_HISTORY_SCOPE_INVALID");
    const payload = await this.dependencies.payloads.get(ref.payloadRef);
    if (
      !payload ||
      payload.contentDigest !== artifact.contentDigest ||
      payload.dataClassification !== artifact.dataClassification ||
      payload.contentType !== "application/json"
    )
      throw new Error("RUNTIME_HISTORY_PAYLOAD_INVALID");
    const bytes = await this.dependencies.protector.unprotect({
      ownerId: this.dependencies.ownerId,
      agentId: this.dependencies.agentId,
      payload,
    });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  }
}
