import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  scanMachineSecrets,
  type ClockPort,
  type DurableMemoryService,
  type MemoryExtractionAuditRecord,
  type MemoryProjectionJobStatePort,
  type OwnerProfileService,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type ProductConfiguration,
  type ProductMemoryStatePort,
  type SensitiveMemoryApprovalStatePort,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  containsRestrictedIdentifier,
  createProductionAutomaticMemory,
  protectedMemoryCandidates,
} from "./production-memory-capture.js";

type MemoryId = Parameters<ProductMemoryStatePort["read"]>[0];
type OverviewSnapshot = Extract<GatewayV2Snapshot, { type: "memory.overview.snapshot" }>;

export const PRODUCTION_MEMORY_OPERATIONS = Object.freeze([
  "memory.overview.read",
  "memory.approval.respond",
  "memory.mutate",
] as const);

const singleLine = (text: string) =>
  [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 2000);

export class ProductionMemoryControl {
  private readonly options: {
    readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
    readonly state: ProductMemoryStatePort;
    readonly jobs: Pick<MemoryProjectionJobStatePort, "listByMemory">;
    readonly approvals: SensitiveMemoryApprovalStatePort;
    readonly memory: Pick<DurableMemoryService, "applyProposal" | "correct" | "delete" | "restore">;
    readonly profile?: Pick<OwnerProfileService, "outline">;
    readonly payloads: PayloadStorePort;
    readonly protector: PayloadProtectorPort;
    readonly clock: ClockPort;
    readonly onAudit: (record: MemoryExtractionAuditRecord) => void;
  };

  constructor(options: ProductionMemoryControl["options"]) {
    this.options = options;
  }

  private async readText(ref: string): Promise<string> {
    const payload = await this.options.payloads.get(ref);
    if (!payload || payload.contentType !== "text/plain")
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_PAYLOAD_MISSING");
    const { ownerId, agentId } = this.options.configuration;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.options.protector.unprotect({ ownerId, agentId, payload }),
    );
  }

  private assertOwner(command: GatewayV2Command) {
    const { ownerId, agentId } = this.options.configuration;
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== ownerId ||
      command.scope.agentId !== agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "MEMORY_OWNER_REQUIRED");
  }

  private assertStorable(text: string) {
    if (
      text.trim().length === 0 ||
      scanMachineSecrets(text).length > 0 ||
      containsRestrictedIdentifier(text)
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
  }

  async revision(): Promise<string> {
    const { ownerId, agentId } = this.options.configuration;
    const active = await this.options.state.listActive(ownerId, agentId);
    const pending = await this.options.approvals.listPending(ownerId, null);
    return JSON.stringify([
      active.map(({ id, revision }) => [id, revision]),
      pending.map(({ id }) => id),
    ]);
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "memory.overview.read") throw new Error("MEMORY_OPERATION_NOT_INSTALLED");
    const { ownerId, agentId } = this.options.configuration;
    const active = [...(await this.options.state.listActive(ownerId, agentId))].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    const memories: OverviewSnapshot["payload"]["memories"][number][] = [];
    for (const memory of active) {
      const text = singleLine(await this.readText(memory.contentRef).catch(() => ""));
      if (!text) continue;
      memories.push({
        memoryId: memory.id,
        revision: memory.revision,
        text,
        dataClassification: memory.dataClassification,
        topic: memory.attributes?.sensitiveTopic ?? null,
        inference: memory.inference,
        sourceThreadId: memory.sourceThreadId,
        sourceRefs: memory.sourceRefs.filter((ref) => ref.length <= 512),
        updatedAt: memory.updatedAt,
        supersededBy: memory.attributes?.supersededBy ?? null,
        validTo: memory.attributes?.validTo ?? null,
      });
    }
    const outline = await this.options.profile?.outline({
      ownerId,
      agentId,
      maxClassification: "private",
      now: this.options.clock.now(),
    });
    const lines = (items: readonly { memoryId: string; text: string; updatedAt: string }[]) =>
      items.map(({ memoryId, text, updatedAt }) => ({
        memoryId,
        text: singleLine(text),
        updatedAt,
      }));
    const profile: OverviewSnapshot["payload"]["profile"][number][] = outline
      ? [
          ...(outline.rules.length
            ? [{ kind: "rules" as const, lines: lines(outline.rules) }]
            : []),
          ...outline.sections.flatMap(({ category, lines: items }) =>
            category === "identity" ||
            category === "preference" ||
            category === "relationship" ||
            category === "goal" ||
            category === "project"
              ? [{ kind: category, lines: lines(items) }]
              : [],
          ),
        ]
      : [];
    const candidates = protectedMemoryCandidates(this.options);
    const pending: OverviewSnapshot["payload"]["pending"][number][] = [];
    for (const request of await this.options.approvals.listPending(ownerId, null)) {
      if (request.agentId !== agentId) continue;
      const candidate = await candidates.read(request).catch(() => undefined);
      const text = candidate ? singleLine(candidate.text) : "";
      if (!candidate || !text) continue;
      pending.push({
        requestId: request.id,
        threadId: request.threadId,
        sourceRef: request.sourceRef,
        text,
        topic: candidate.sensitiveTopic ?? "other",
        requestedAt: request.requestedAt,
      });
    }
    return {
      ...query,
      kind: "snapshot",
      type: "memory.overview.snapshot",
      payload: { memories, profile, pending, generatedAt: this.options.clock.now() },
    } as GatewayV2Snapshot;
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    this.assertOwner(command);
    if (command.type === "memory.approval.respond") {
      const { requestId, resolution, editedText } = command.payload;
      if (resolution === "edited") {
        if (editedText === null)
          throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "MEMORY_TEXT_REFUSED");
        this.assertStorable(editedText);
      }
      const resolver = createProductionAutomaticMemory({
        product: this.options.memory,
        approvals: this.options.approvals,
        payloads: this.options.payloads,
        protector: this.options.protector,
        clock: this.options.clock,
        extract: async () => [],
        readSourceText: (ref) => this.readText(ref),
        onAudit: this.options.onAudit,
      });
      const committed = await resolver.resolveSensitive(
        resolution === "edited"
          ? { requestId, resolution, editedText: editedText ?? "" }
          : { requestId, resolution },
      );
      return { resultRef: committed ?? requestId, replayed: false };
    }
    if (command.type === "memory.mutate") {
      const { memoryId, action, expectedRevision, contentRef } = command.payload;
      const current = await this.options.state.read(memoryId as MemoryId);
      const { ownerId, agentId } = this.options.configuration;
      if (!current || current.ownerId !== ownerId || current.agentId !== agentId)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "MEMORY_NOT_FOUND");
      if (current.revision !== expectedRevision)
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MEMORY_REVISION_CHANGED");
      const generationId = (await this.options.jobs.listByMemory(current.id)).at(-1)?.generationId;
      if (!generationId)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.INVALID_OPERATION,
          "MEMORY_GENERATION_MISSING",
        );
      if (action === "correct" && contentRef) {
        this.assertStorable(await this.readText(contentRef));
        const saved = await this.options.memory.correct({
          memoryId: current.id,
          contentRef,
          sourceRef: contentRef,
          generationId,
        });
        return { resultRef: saved.id, replayed: false };
      }
      if (action === "restore") {
        const saved = await this.options.memory.restore(current.id, generationId);
        return { resultRef: saved.id, replayed: false };
      }
      if (action === "delete") {
        const saved = await this.options.memory.delete(current.id, generationId);
        return { resultRef: saved.id, replayed: false };
      }
    }
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "MEMORY_OPERATION_NOT_INSTALLED",
    );
  }
}
