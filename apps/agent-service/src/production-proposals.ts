import { createHash, randomUUID } from "node:crypto";
import type {
  ClockPort,
  OwnerProposalOrigin,
  OwnerProposalStorePort,
  OwnerProposalVersion,
  PayloadProtectorPort,
  PayloadStorePort,
  ProductConfiguration,
  StoredOwnerProposal,
} from "@himawari-agent/application";
import { classificationWithIdentifiers } from "@himawari-agent/sensitive-capture";

export const PENDING_PROPOSAL_LIMIT = 20;
export const PENDING_PROPOSAL_TTL_DAYS = 30;
const PENDING_PROPOSAL_CEILING = 200;
const PENDING_PROPOSAL_TTL_CEILING_DAYS = 3650;
const EVIDENCE_SWEEP_BATCH = 100;
const DAY_MS = 86_400_000;
const PROPOSAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$/u;

export type ProposalErrorCode =
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSALS_FULL"
  | "PROPOSAL_REJECTED"
  | "PROPOSAL_ACCEPTED"
  | "PROPOSAL_EXPIRED"
  | "PROPOSAL_CHANGED"
  | "PROPOSAL_INVALID"
  | "PROPOSAL_TYPE_NOT_ADOPTABLE";

export class ProposalError extends Error {
  readonly code: ProposalErrorCode;
  readonly detail: string;
  constructor(code: ProposalErrorCode, detail = "") {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export interface ProposalEvidenceSource {
  readonly kind: string;
  readonly ref: string;
}

export interface ProposalEvidenceFigure {
  readonly name: string;
  readonly value: number;
  readonly definition: string;
}

export interface ProposalEvidence {
  readonly kind: string;
  readonly text: string | null;
  readonly sources: readonly ProposalEvidenceSource[];
  readonly figures: readonly ProposalEvidenceFigure[];
}

export interface ProposalAdoption {
  readonly resultRef: string;
  readonly detail?: unknown;
}

export interface ProposalHandler {
  readonly repeatable?: boolean;
  adopt(input: {
    readonly proposalId: string;
    readonly threadId: string | null;
    readonly data: unknown;
  }): Promise<ProposalAdoption>;
  settled?(): Promise<(data: unknown) => boolean>;
}

export interface ProposalSource {
  readonly ref: string;
  readonly version: string | null;
}

export interface PendingProposal {
  readonly proposalId: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly type: string;
  readonly summary: string;
  readonly effect: string;
  readonly origin: OwnerProposalOrigin;
  readonly adoptable: boolean;
  readonly evidence: readonly ProposalEvidence[];
  readonly proposedAt: string;
  readonly expiresAt: string;
  readonly refusedBefore: number;
}

export interface PendingProposals {
  readonly proposals: readonly PendingProposal[];
  readonly pendingCount: number;
  readonly limit: number;
  readonly expiresAfterDays: number;
}

export interface ProductionProposalBoxOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId"> & {
    readonly runPolicy?: Pick<NonNullable<ProductConfiguration["runPolicy"]>, "ownerProposals">;
  };
  readonly store: OwnerProposalStorePort;
  readonly payloads: PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  readonly clock: ClockPort;
}

interface StoredBasis {
  readonly evidence: readonly ProposalEvidence[];
  readonly data: unknown;
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

export function shownText(value: string, maximum: number): string {
  let kept = "";
  for (const character of value
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .trim()) {
    if (kept.length + character.length > maximum) break;
    kept += character;
  }
  return kept.trim();
}

const TYPE_LENGTH = 64;
const SENTENCE_LENGTH = 200;

function sentence(value: unknown, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    shownText(value, maximum).length > 0
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function changed(row: OwnerProposalVersion, expected: OwnerProposalVersion | undefined): boolean {
  return (
    expected !== undefined &&
    (row.version !== expected.version || row.fingerprint !== expected.fingerprint)
  );
}

function evidenceOf(value: unknown): readonly ProposalEvidence[] {
  if (!Array.isArray(value)) return [];
  const items: ProposalEvidence[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = record["kind"];
    if (!text(kind) || kind.length === 0) continue;
    const sources = Array.isArray(record["sources"]) ? record["sources"] : [];
    const figures = Array.isArray(record["figures"]) ? record["figures"] : [];
    items.push({
      kind,
      text: text(record["text"]) ? record["text"] : null,
      sources: sources.flatMap((source: unknown) => {
        const { kind: sourceKind, ref } = (source ?? {}) as Record<string, unknown>;
        return text(sourceKind) && text(ref) ? [{ kind: sourceKind, ref }] : [];
      }),
      figures: figures.flatMap((figure: unknown) => {
        const { name, value: amount, definition } = (figure ?? {}) as Record<string, unknown>;
        return text(name) && Number.isSafeInteger(amount) && text(definition)
          ? [{ name, value: amount as number, definition }]
          : [];
      }),
    });
  }
  return items;
}

export class ProductionProposalBox {
  readonly #options: ProductionProposalBoxOptions;
  readonly #handlers = new Map<string, ProposalHandler>();

  constructor(options: ProductionProposalBoxOptions) {
    this.#options = options;
    const { limit, ttlDays } = this;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > PENDING_PROPOSAL_CEILING ||
      !Number.isInteger(ttlDays) ||
      ttlDays < 1 ||
      ttlDays > PENDING_PROPOSAL_TTL_CEILING_DAYS
    )
      throw new RangeError("Proposal limit or lifetime is out of range");
  }

  get limit(): number {
    return (
      this.#options.configuration.runPolicy?.ownerProposals?.pendingLimit ?? PENDING_PROPOSAL_LIMIT
    );
  }

  get ttlDays(): number {
    return (
      this.#options.configuration.runPolicy?.ownerProposals?.expiresAfterDays ??
      PENDING_PROPOSAL_TTL_DAYS
    );
  }

  register(type: string, handler: ProposalHandler): void {
    this.#handlers.set(type, handler);
  }

  #scope() {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async #readBasis(ref: string | null): Promise<StoredBasis | undefined> {
    if (ref === null) return undefined;
    try {
      const payload = await this.#options.payloads.get(ref);
      if (!payload) return undefined;
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: false }).decode(
          await this.#options.protector.unprotect({ ...this.#scope(), payload }),
        ),
      ) as Record<string, unknown> | null;
      if (typeof parsed !== "object" || parsed === null) return undefined;
      return { evidence: evidenceOf(parsed["evidence"]), data: parsed["data"] };
    } catch {
      return undefined;
    }
  }

  async #writeBasis(ref: string, basis: StoredBasis): Promise<void> {
    const body = JSON.stringify(basis);
    await this.#options.payloads.put(
      await this.#options.protector.protect({
        ...this.#scope(),
        ref,
        contentType: "application/json",
        dataClassification: classificationWithIdentifiers(body, "private"),
        plaintext: new TextEncoder().encode(body),
        createdAt: this.#options.clock.now(),
      }),
    );
  }

  read(proposalId: string): Promise<StoredOwnerProposal | undefined> {
    if (!PROPOSAL_ID_PATTERN.test(proposalId)) return Promise.resolve(undefined);
    return this.#options.store.read({
      ...this.#scope(),
      proposalId,
      now: this.#options.clock.now(),
    });
  }

  async propose(input: {
    readonly proposalId: string;
    readonly type: string;
    readonly summary: string;
    readonly effect: string;
    readonly origin: OwnerProposalOrigin;
    readonly threadId: string | null;
    readonly evidence: readonly ProposalEvidence[];
    readonly data: unknown;
    readonly source?: ProposalSource;
  }): Promise<void> {
    const scope = this.#scope();
    const { store, payloads } = this.#options;
    const now = this.#options.clock.now();
    const { proposalId } = input;
    if (
      !PROPOSAL_ID_PATTERN.test(proposalId) ||
      !sentence(input.type, TYPE_LENGTH) ||
      shownText(input.type, TYPE_LENGTH) !== input.type ||
      !sentence(input.summary, SENTENCE_LENGTH) ||
      !sentence(input.effect, SENTENCE_LENGTH)
    )
      throw new ProposalError("PROPOSAL_INVALID");
    const existing = await store.read({ ...scope, proposalId, now });
    const digest = createHash("sha256").update(`${proposalId}\n${now}\n${randomUUID()}`);
    const evidenceRef = `${proposalId}:${digest.digest("hex").slice(0, 16)}`;
    const expiresAt = new Date(Date.parse(now) + this.ttlDays * DAY_MS).toISOString();
    const drop = () => payloads.delete(evidenceRef as never).catch(() => false);
    await this.#writeBasis(evidenceRef, { evidence: input.evidence, data: input.data });
    const outcome = await store
      .propose({
        ...scope,
        proposalId,
        type: input.type,
        summary: input.summary,
        effect: input.effect,
        origin: input.origin,
        threadId: input.threadId,
        sourceRef: input.source?.ref ?? null,
        sourceVersion: input.source?.version ?? null,
        fingerprint: createHash("sha256")
          .update(
            canonicalJson([
              input.type,
              input.summary,
              input.effect,
              input.origin,
              input.evidence,
              input.data,
            ]),
          )
          .digest("hex"),
        evidenceRef,
        now,
        expiresAt,
        pendingLimit: this.limit,
      })
      .catch(async (error: unknown) => {
        await drop();
        throw error;
      });
    if (outcome === "limit_reached") {
      await drop();
      throw new ProposalError("PROPOSALS_FULL", String(this.limit));
    }
    if (existing?.evidenceRef && existing.evidenceRef !== evidenceRef)
      await payloads.delete(existing.evidenceRef as never).catch(() => false);
  }

  async adopt(proposalId: string, expected?: OwnerProposalVersion): Promise<ProposalAdoption> {
    const scope = this.#scope();
    const { store, clock } = this.#options;
    const row = await this.read(proposalId);
    if (!row) throw new ProposalError("PROPOSAL_NOT_FOUND");
    if (changed(row, expected)) throw new ProposalError("PROPOSAL_CHANGED");
    if (row.status === "rejected") throw new ProposalError("PROPOSAL_REJECTED");
    if (row.status === "expired") throw new ProposalError("PROPOSAL_EXPIRED");
    const handler = this.#handlers.get(row.type);
    if (!handler) throw new ProposalError("PROPOSAL_TYPE_NOT_ADOPTABLE", row.type);
    let claimed = false;
    let current = row;
    if (row.status === "pending") {
      const taken = await store.decide({
        ...scope,
        proposalId,
        from: "pending",
        to: "accepted",
        now: clock.now(),
        ...(expected ? { expected } : {}),
      });
      if (taken) {
        claimed = true;
        current = taken;
      } else {
        const latest = await this.read(proposalId);
        if (!latest) throw new ProposalError("PROPOSAL_NOT_FOUND");
        if (changed(latest, expected)) throw new ProposalError("PROPOSAL_CHANGED");
        if (latest.status === "rejected") throw new ProposalError("PROPOSAL_REJECTED");
        if (latest.status === "expired") throw new ProposalError("PROPOSAL_EXPIRED");
        current = latest;
      }
    }
    if (!claimed && handler.repeatable !== true) throw new ProposalError("PROPOSAL_ACCEPTED");
    const release = async (): Promise<void> => {
      if (!claimed) return;
      const back = () =>
        store.decide({ ...scope, proposalId, from: "accepted", to: "pending", now: clock.now() });
      await back().catch(() => back().catch(() => undefined));
    };
    const basis = await this.#readBasis(current.evidenceRef);
    if (!basis) {
      await release();
      throw new ProposalError("PROPOSAL_NOT_FOUND");
    }
    try {
      return await handler.adopt({ proposalId, threadId: current.threadId, data: basis.data });
    } catch (error) {
      await release();
      throw error;
    }
  }

  async reject(
    proposalId: string,
    expected?: OwnerProposalVersion,
  ): Promise<{ readonly replayed: boolean }> {
    if (!PROPOSAL_ID_PATTERN.test(proposalId)) throw new ProposalError("PROPOSAL_NOT_FOUND");
    const scope = this.#scope();
    const { store } = this.#options;
    const now = this.#options.clock.now();
    const decide = () =>
      store.decide({
        ...scope,
        proposalId,
        from: "pending",
        to: "rejected",
        now,
        ...(expected ? { expected } : {}),
      });
    const refused = async () => {
      await this.#sweep();
      return Object.freeze({ replayed: false });
    };
    if (await decide()) return refused();
    let row = await store.read({ ...scope, proposalId, now });
    if (row && changed(row, expected)) throw new ProposalError("PROPOSAL_CHANGED");
    if (row?.status === "pending" && (await decide())) return refused();
    row = await store.read({ ...scope, proposalId, now });
    if (!row) throw new ProposalError("PROPOSAL_NOT_FOUND");
    if (changed(row, expected)) throw new ProposalError("PROPOSAL_CHANGED");
    if (row.status === "rejected") return Object.freeze({ replayed: true });
    if (row.status === "accepted") throw new ProposalError("PROPOSAL_ACCEPTED");
    throw new ProposalError("PROPOSAL_EXPIRED");
  }

  async settle(type: string, covered: (data: unknown) => boolean): Promise<void> {
    const scope = this.#scope();
    const { store } = this.#options;
    const now = this.#options.clock.now();
    const waiting = await store
      .listPending({ ...scope, now, limit: PENDING_PROPOSAL_CEILING })
      .catch(() => undefined);
    for (const row of waiting?.proposals ?? []) {
      if (row.type !== type) continue;
      const basis = await this.#readBasis(row.evidenceRef);
      let done = false;
      try {
        done = basis !== undefined && covered(basis.data);
      } catch {
        done = false;
      }
      if (done)
        await store
          .decide({
            ...scope,
            proposalId: row.proposalId,
            from: "pending",
            to: "accepted",
            now,
            expected: { version: row.version, fingerprint: row.fingerprint },
          })
          .catch(() => false);
    }
  }

  async #sweep(): Promise<void> {
    const scope = this.#scope();
    const { store, payloads } = this.#options;
    const settled = await store
      .settledEvidence({ ...scope, now: this.#options.clock.now(), limit: EVIDENCE_SWEEP_BATCH })
      .catch(() => []);
    for (const { proposalId, evidenceRef } of settled) {
      const gone = await payloads
        .delete(evidenceRef as never)
        .then(() => true)
        .catch(() => false);
      if (gone) await store.clearEvidence({ ...scope, proposalId, evidenceRef }).catch(() => false);
    }
  }

  async list(): Promise<PendingProposals> {
    const scope = this.#scope();
    const now = this.#options.clock.now();
    await this.#sweep();
    for (const [type, handler] of this.#handlers) {
      const covered = await handler.settled?.().catch(() => undefined);
      if (covered) await this.settle(type, covered);
    }
    const listed = await this.#options.store.listPending({
      ...scope,
      now,
      limit: PENDING_PROPOSAL_CEILING,
    });
    const proposals: PendingProposal[] = [];
    for (const row of listed.proposals) {
      const basis = await this.#readBasis(row.evidenceRef);
      proposals.push(
        Object.freeze({
          proposalId: row.proposalId,
          version: row.version,
          fingerprint: row.fingerprint,
          type: row.type,
          summary: row.summary,
          effect: row.effect,
          origin: row.origin,
          adoptable: this.#handlers.has(row.type),
          evidence: basis?.evidence ?? [],
          proposedAt: row.proposedAt,
          expiresAt: row.expiresAt,
          refusedBefore: row.rejectCount,
        }),
      );
    }
    return Object.freeze({
      proposals: Object.freeze(proposals),
      pendingCount: listed.pendingCount,
      limit: this.limit,
      expiresAfterDays: this.ttlDays,
    });
  }
}
