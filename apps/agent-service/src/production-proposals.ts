import { createHash, randomUUID } from "node:crypto";
import type {
  ClockPort,
  OwnerProposalOrigin,
  OwnerProposalExecutionStatus,
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
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_FULL_READ_SECONDS = 600;
const FULL_READ_TOKEN_CEILING = 1000;
const LEASE_RECOVERY_BATCH = 50;
const PROPOSAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$/u;

export type ProposalErrorCode =
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSALS_FULL"
  | "PROPOSAL_REJECTED"
  | "PROPOSAL_ACCEPTED"
  | "PROPOSAL_EXPIRED"
  | "PROPOSAL_CHANGED"
  | "PROPOSAL_INVALID"
  | "PROPOSAL_TYPE_NOT_ADOPTABLE"
  | "PROPOSAL_SUPERSEDED"
  | "PROPOSAL_WITHDRAWN"
  | "PROPOSAL_FULL_READ_REQUIRED"
  | "PROPOSAL_PRESENCE_REQUIRED"
  | "PROPOSAL_EXECUTING"
  | "PROPOSAL_EXECUTION_FAILED"
  | "PROPOSAL_NOT_UNDOABLE"
  | "PROPOSAL_UNDONE";

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

export type ProposalPremises =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface ProposalActionHandler {
  readonly kind: "action";
  readonly requiresPresence?: boolean;
  verify(input: { readonly proposalId: string; readonly data: unknown }): Promise<ProposalPremises>;
  execute(input: {
    readonly proposalId: string;
    readonly leaseId: string;
    readonly data: unknown;
  }): Promise<{ readonly original: unknown; readonly detail?: string }>;
  readBack(input: {
    readonly proposalId: string;
    readonly data: unknown;
    readonly original: unknown;
  }): Promise<"matches" | "differs">;
  undo(input: {
    readonly proposalId: string;
    readonly data: unknown;
    readonly original: unknown;
  }): Promise<void>;
}

export interface ProposalResponder {
  readonly fullReadToken?: string | null;
  readonly assertPresence?: () => Promise<void>;
}

export interface ProposalExecutionOutcome extends ProposalAdoption {
  readonly execution: OwnerProposalExecutionStatus;
}

function isAction(
  handler: ProposalHandler | ProposalActionHandler,
): handler is ProposalActionHandler {
  return "kind" in handler && handler.kind === "action";
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
  readonly requiresFullRead: boolean;
  readonly requiresPresence: boolean;
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
  readonly leaseSeconds?: number;
  readonly fullReadSeconds?: number;
}

interface StoredExecution {
  readonly original: unknown;
  readonly detail: string | null;
  readonly reason: string | null;
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
  readonly #handlers = new Map<string, ProposalHandler | ProposalActionHandler>();
  readonly #undoing = new Map<string, Promise<{ readonly replayed: boolean }>>();
  readonly #fullReads = new Map<
    string,
    {
      readonly proposalId: string;
      readonly version: number;
      readonly fingerprint: string;
      readonly expiresAt: number;
    }
  >();

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

  register(type: string, handler: ProposalHandler | ProposalActionHandler): void {
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
    readonly externalContentSeen?: boolean;
    readonly requiresFullRead?: boolean;
    readonly requiresPresence?: boolean;
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
    const origin: OwnerProposalOrigin =
      input.externalContentSeen === true ? "external_content" : input.origin;
    const handler = this.#handlers.get(input.type);
    const requiresFullRead =
      input.requiresFullRead === true ||
      (origin === "external_content" && !(handler !== undefined && isAction(handler)));
    const requiresPresence =
      input.requiresPresence ??
      (handler !== undefined && isAction(handler) && handler.requiresPresence === true);
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
        origin,
        threadId: input.threadId,
        sourceRef: input.source?.ref ?? null,
        sourceVersion: input.source?.version ?? null,
        fingerprint: createHash("sha256")
          .update(
            canonicalJson([
              input.type,
              input.summary,
              input.effect,
              origin,
              input.evidence,
              input.data,
            ]),
          )
          .digest("hex"),
        evidenceRef,
        requiresFullRead,
        requiresPresence,
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
    if (outcome === "closed") {
      await drop();
      return;
    }
    if (existing?.evidenceRef && existing.evidenceRef !== evidenceRef)
      await payloads.delete(existing.evidenceRef as never).catch(() => false);
  }

  #refusal(row: StoredOwnerProposal): ProposalError | undefined {
    if (row.status === "rejected") return new ProposalError("PROPOSAL_REJECTED");
    if (row.status === "expired") return new ProposalError("PROPOSAL_EXPIRED");
    if (row.status === "superseded") return new ProposalError("PROPOSAL_SUPERSEDED");
    if (row.status === "withdrawn") return new ProposalError("PROPOSAL_WITHDRAWN");
    return undefined;
  }

  #requireFullRead(
    row: StoredOwnerProposal,
    responder: ProposalResponder | undefined,
  ): string | null {
    if (!row.requiresFullRead) return null;
    const token = responder?.fullReadToken;
    const issued = typeof token === "string" ? this.#fullReads.get(token) : undefined;
    if (
      typeof token !== "string" ||
      !issued ||
      issued.expiresAt <= Date.parse(this.#options.clock.now()) ||
      issued.proposalId !== row.proposalId ||
      issued.version !== row.version ||
      issued.fingerprint !== row.fingerprint
    )
      throw new ProposalError("PROPOSAL_FULL_READ_REQUIRED");
    return token;
  }

  async openFull(
    proposalId: string,
    expected: OwnerProposalVersion,
  ): Promise<{ readonly fullReadToken: string; readonly expiresAt: string }> {
    const row = await this.read(proposalId);
    if (!row) throw new ProposalError("PROPOSAL_NOT_FOUND");
    if (changed(row, expected)) throw new ProposalError("PROPOSAL_CHANGED");
    if (row.status !== "pending")
      throw this.#refusal(row) ?? new ProposalError("PROPOSAL_ACCEPTED");
    const now = Date.parse(this.#options.clock.now());
    for (const [token, issued] of this.#fullReads)
      if (issued.expiresAt <= now) this.#fullReads.delete(token);
    for (const [token, issued] of this.#fullReads)
      if (this.#fullReads.size >= FULL_READ_TOKEN_CEILING) this.#fullReads.delete(token);
      else if (issued.proposalId === proposalId) this.#fullReads.delete(token);
    const fullReadToken = randomUUID().replaceAll("-", "");
    const expiresAt = now + (this.#options.fullReadSeconds ?? DEFAULT_FULL_READ_SECONDS) * 1000;
    this.#fullReads.set(fullReadToken, {
      proposalId,
      version: row.version,
      fingerprint: row.fingerprint,
      expiresAt,
    });
    return Object.freeze({ fullReadToken, expiresAt: new Date(expiresAt).toISOString() });
  }

  async #writeExecution(ref: string, execution: StoredExecution): Promise<void> {
    const body = JSON.stringify(execution);
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

  async #readExecution(ref: string | null): Promise<StoredExecution | undefined> {
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
      return {
        original: parsed["original"],
        detail: text(parsed["detail"]) ? parsed["detail"] : null,
        reason: text(parsed["reason"]) ? parsed["reason"] : null,
      };
    } catch {
      return undefined;
    }
  }

  async #recordExecution(
    proposalId: string,
    execution: StoredExecution,
  ): Promise<string | undefined> {
    const digest = createHash("sha256").update(`${proposalId}\n${randomUUID()}`).digest("hex");
    const ref = `${proposalId}:x${digest.slice(0, 15)}`;
    try {
      await this.#writeExecution(ref, execution);
      return ref;
    } catch {
      return undefined;
    }
  }

  async #verifyAfterExecution(
    row: StoredOwnerProposal,
    handler: ProposalActionHandler,
    data: unknown,
    original: unknown,
  ): Promise<OwnerProposalExecutionStatus> {
    const scope = this.#scope();
    const { store, clock } = this.#options;
    let verdict: OwnerProposalExecutionStatus;
    try {
      verdict =
        (await handler.readBack({ proposalId: row.proposalId, data, original })) === "matches"
          ? "succeeded"
          : "failed";
    } catch {
      verdict = "unknown";
    }
    const moved = await store.moveExecution({
      ...scope,
      proposalId: row.proposalId,
      from: row.execStatus,
      to: verdict,
      leaseId: row.leaseId,
      now: clock.now(),
    });
    return moved?.execStatus ?? verdict;
  }

  async #recover(): Promise<void> {
    const scope = this.#scope();
    const { store, clock } = this.#options;
    const stale = await store
      .listExpiredLeases({ ...scope, now: clock.now(), limit: LEASE_RECOVERY_BATCH })
      .catch(() => []);
    for (const row of stale) {
      const handler = this.#handlers.get(row.type);
      const basis = await this.#readBasis(row.evidenceRef);
      if (!handler || !isAction(handler) || !basis) {
        await store
          .moveExecution({
            ...scope,
            proposalId: row.proposalId,
            from: row.execStatus,
            to: "unknown",
            leaseId: row.leaseId,
            now: clock.now(),
          })
          .catch(() => undefined);
        continue;
      }
      const execution = await this.#readExecution(row.executionRef);
      await this.#verifyAfterExecution(row, handler, basis.data, execution?.original).catch(
        () => undefined,
      );
    }
  }

  async #adoptAction(
    row: StoredOwnerProposal,
    handler: ProposalActionHandler,
    expected: OwnerProposalVersion | undefined,
    responder: ProposalResponder | undefined,
  ): Promise<ProposalExecutionOutcome> {
    const scope = this.#scope();
    const { store, clock } = this.#options;
    const { proposalId } = row;
    const settledError = (latest: StoredOwnerProposal): ProposalError =>
      this.#refusal(latest) ??
      new ProposalError(
        latest.execStatus === "running" || latest.execStatus === "executed_unverified"
          ? "PROPOSAL_EXECUTING"
          : "PROPOSAL_ACCEPTED",
      );
    if (row.status !== "pending") throw settledError(row);
    const token = this.#requireFullRead(row, responder);
    if (row.requiresPresence || handler.requiresPresence === true) {
      if (!responder?.assertPresence) throw new ProposalError("PROPOSAL_PRESENCE_REQUIRED");
      await responder.assertPresence();
    }
    const basis = await this.#readBasis(row.evidenceRef);
    if (!basis) throw new ProposalError("PROPOSAL_NOT_FOUND");
    const premises = await handler.verify({ proposalId, data: basis.data });
    if (!premises.ok) {
      await store
        .decide({
          ...scope,
          proposalId,
          from: "pending",
          to: "superseded",
          now: clock.now(),
          expected: { version: row.version, fingerprint: row.fingerprint },
        })
        .catch(() => undefined);
      throw new ProposalError("PROPOSAL_SUPERSEDED", premises.reason);
    }
    const leaseId = randomUUID().replaceAll("-", "");
    const leaseExpiresAt = new Date(
      Date.parse(clock.now()) + (this.#options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000,
    ).toISOString();
    const claimed = await store.claim({
      ...scope,
      proposalId,
      expected: expected ?? { version: row.version, fingerprint: row.fingerprint },
      leaseId,
      leaseExpiresAt,
      now: clock.now(),
    });
    if (!claimed) {
      const latest = await this.read(proposalId);
      if (!latest) throw new ProposalError("PROPOSAL_NOT_FOUND");
      if (changed(latest, expected)) throw new ProposalError("PROPOSAL_CHANGED");
      throw settledError(latest);
    }
    if (token !== null) this.#fullReads.delete(token);
    let executed: { readonly original: unknown; readonly detail?: string };
    try {
      executed = await handler.execute({ proposalId, leaseId, data: basis.data });
    } catch (error) {
      const ref = await this.#recordExecution(proposalId, {
        original: null,
        detail: null,
        reason: error instanceof Error ? error.message.slice(0, 200) : "EXECUTION_FAILED",
      });
      await store
        .moveExecution({
          ...scope,
          proposalId,
          from: "running",
          to: "failed",
          leaseId,
          ...(ref ? { executionRef: ref } : {}),
          now: clock.now(),
        })
        .catch(() => undefined);
      throw new ProposalError(
        "PROPOSAL_EXECUTION_FAILED",
        error instanceof Error ? error.message.slice(0, 200) : "",
      );
    }
    const ref = await this.#recordExecution(proposalId, {
      original: executed.original,
      detail: executed.detail ?? null,
      reason: null,
    });
    const pending = await store.moveExecution({
      ...scope,
      proposalId,
      from: "running",
      to: "executed_unverified",
      leaseId,
      ...(ref ? { executionRef: ref } : {}),
      now: clock.now(),
    });
    if (!pending) throw new ProposalError("PROPOSAL_EXECUTING");
    if (ref === undefined) {
      const moved = await store
        .moveExecution({
          ...scope,
          proposalId,
          from: "executed_unverified",
          to: "unknown",
          leaseId,
          now: clock.now(),
        })
        .catch(() => undefined);
      return Object.freeze({
        resultRef: proposalId,
        execution: moved?.execStatus ?? "unknown",
        ...(executed.detail ? { detail: executed.detail } : {}),
      });
    }
    const execution = await this.#verifyAfterExecution(
      pending,
      handler,
      basis.data,
      executed.original,
    );
    return Object.freeze({
      resultRef: proposalId,
      execution,
      ...(executed.detail ? { detail: executed.detail } : {}),
    });
  }

  async undo(
    proposalId: string,
    expected?: OwnerProposalVersion,
  ): Promise<{ readonly replayed: boolean }> {
    const queued = (this.#undoing.get(proposalId) ?? Promise.resolve()).catch(() => undefined);
    const running = queued.then(() => this.#undoOnce(proposalId, expected));
    this.#undoing.set(proposalId, running);
    try {
      return await running;
    } finally {
      if (this.#undoing.get(proposalId) === running) this.#undoing.delete(proposalId);
    }
  }

  async #undoOnce(
    proposalId: string,
    expected?: OwnerProposalVersion,
  ): Promise<{ readonly replayed: boolean }> {
    const scope = this.#scope();
    const { store, clock } = this.#options;
    await this.#recover();
    const row = await this.read(proposalId);
    if (!row) throw new ProposalError("PROPOSAL_NOT_FOUND");
    if (changed(row, expected)) throw new ProposalError("PROPOSAL_CHANGED");
    if (row.execStatus === "undone") return Object.freeze({ replayed: true });
    if (row.execStatus !== "succeeded") throw new ProposalError("PROPOSAL_NOT_UNDOABLE");
    const handler = this.#handlers.get(row.type);
    if (!handler || !isAction(handler)) throw new ProposalError("PROPOSAL_NOT_UNDOABLE");
    const basis = await this.#readBasis(row.evidenceRef);
    const execution = await this.#readExecution(row.executionRef);
    if (!basis || !execution) throw new ProposalError("PROPOSAL_NOT_UNDOABLE");
    await handler.undo({ proposalId, data: basis.data, original: execution.original });
    const moved = await store.moveExecution({
      ...scope,
      proposalId,
      from: "succeeded",
      to: "undone",
      leaseId: null,
      now: clock.now(),
    });
    if (!moved) {
      const latest = await this.read(proposalId);
      if (latest?.execStatus === "undone") return Object.freeze({ replayed: true });
      throw new ProposalError("PROPOSAL_NOT_UNDOABLE");
    }
    return Object.freeze({ replayed: false });
  }

  async adopt(
    proposalId: string,
    expected?: OwnerProposalVersion,
    responder?: ProposalResponder,
  ): Promise<ProposalAdoption | ProposalExecutionOutcome> {
    const scope = this.#scope();
    const { store, clock } = this.#options;
    await this.#recover();
    const row = await this.read(proposalId);
    if (!row) throw new ProposalError("PROPOSAL_NOT_FOUND");
    if (changed(row, expected)) throw new ProposalError("PROPOSAL_CHANGED");
    const refused = this.#refusal(row);
    if (refused) throw refused;
    const handler = this.#handlers.get(row.type);
    if (!handler) throw new ProposalError("PROPOSAL_TYPE_NOT_ADOPTABLE", row.type);
    if (isAction(handler)) return this.#adoptAction(row, handler, expected, responder);
    if (row.status === "pending") this.#requireFullRead(row, responder);
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
        const gone = this.#refusal(latest);
        if (gone) throw gone;
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
    throw this.#refusal(row) ?? new ProposalError("PROPOSAL_EXPIRED");
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
    await this.#recover();
    for (const [type, handler] of this.#handlers) {
      if (isAction(handler)) continue;
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
          requiresFullRead: row.requiresFullRead,
          requiresPresence: row.requiresPresence,
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
