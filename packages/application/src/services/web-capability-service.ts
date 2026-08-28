import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type AuthenticatedWebAdapterPort,
  type PreparedWebAction,
  type PublicWebAdapterPort,
  type WebContentDigestPort,
  type WebExecutionHandle,
  type WebOperationRecord,
  type WebResearchCitation,
  type WebResourceRecord,
  type WebSearchCandidate,
  type WebSessionRecord,
  type WebStatePort,
} from "../ports/index.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

const MAX_PUBLIC_RESOURCE_BYTES = 2 * 1024 * 1024;

export class WebCapabilityService {
  readonly #state: WebStatePort;
  readonly #publicAdapter: PublicWebAdapterPort;
  readonly #authenticatedAdapter: AuthenticatedWebAdapterPort;
  readonly #digest: WebContentDigestPort;
  readonly #clock: ClockPort;
  readonly #ids: IdGeneratorPort;
  readonly #hostId: string;

  constructor(input: {
    readonly state: WebStatePort;
    readonly publicAdapter: PublicWebAdapterPort;
    readonly authenticatedAdapter: AuthenticatedWebAdapterPort;
    readonly digest: WebContentDigestPort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
    readonly hostId: string;
  }) {
    this.#state = input.state;
    this.#publicAdapter = input.publicAdapter;
    this.#authenticatedAdapter = input.authenticatedAdapter;
    this.#digest = input.digest;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#hostId = input.hostId;
  }

  async searchPublic(input: {
    readonly query: string;
    readonly limit: number;
    readonly authorized: boolean;
  }): Promise<readonly WebSearchCandidate[]> {
    if (
      !input.authorized ||
      input.query.trim().length === 0 ||
      input.limit < 1 ||
      input.limit > 20
    ) {
      this.#reject("Public Web search is not authorized or is unbounded");
    }
    return this.#publicAdapter.search({ query: input.query.trim(), limit: input.limit });
  }

  async openPublic(input: {
    readonly requestedUrl: string;
    readonly authorized: boolean;
  }): Promise<WebResourceRecord> {
    if (!input.authorized) this.#reject("Public Web open is not authorized");
    requireSafeWebUrl(input.requestedUrl);
    const observed = await this.#publicAdapter.open({
      requestedUrl: input.requestedUrl,
      maximumBytes: MAX_PUBLIC_RESOURCE_BYTES,
    });
    requireSafeWebUrl(observed.canonicalUrl);
    observed.redirectChain.forEach(requireSafeWebUrl);
    const record = Object.freeze({
      ...observed,
      id: this.#ids.next("web-resource"),
      retrievedAt: this.#clock.now(),
      dataClassification: "public" as const,
    });
    return this.#state.saveResource(record);
  }

  async buildResearchCitations(
    claims: readonly {
      readonly claimRef: string;
      readonly resourceId: string;
      readonly fragmentRef: string;
    }[],
  ): Promise<readonly WebResearchCitation[]> {
    const citations: WebResearchCitation[] = [];
    for (const claim of claims) {
      const resource = await this.#state.readResource(claim.resourceId);
      if (!resource || !resource.selectedFragmentRefs.includes(claim.fragmentRef)) {
        this.#reject("Research claim does not reference an opened resource fragment");
      }
      citations.push(
        Object.freeze({
          resourceId: resource.id,
          contentDigest: resource.contentDigest,
          fragmentRef: claim.fragmentRef,
          claimRef: claim.claimRef,
        }),
      );
    }
    return Object.freeze(citations);
  }

  async establishSession(input: {
    readonly ownerId: string;
    readonly agentId: string;
    readonly allowedOrigins: readonly string[];
    readonly purpose: string;
    readonly identityLabel: string;
    readonly secretRefs: readonly string[];
    readonly storagePartitionRef: string;
    readonly dataClassification: WebSessionRecord["dataClassification"];
    readonly expiresAt: string;
  }): Promise<WebSessionRecord> {
    if (
      input.allowedOrigins.length === 0 ||
      input.secretRefs.length === 0 ||
      input.purpose.trim().length === 0 ||
      input.expiresAt <= this.#clock.now()
    ) {
      this.#reject("Authenticated Web session metadata is incomplete");
    }
    const allowedOrigins = Object.freeze(
      [...new Set(input.allowedOrigins.map((origin) => exactOrigin(origin)))].sort(),
    );
    return this.#state.saveSession(
      Object.freeze({
        id: this.#ids.next("web-session"),
        revision: 1,
        ownerId: input.ownerId,
        agentId: input.agentId,
        hostId: this.#hostId,
        allowedOrigins,
        purpose: input.purpose.trim(),
        identityLabel: input.identityLabel.trim(),
        secretRefs: Object.freeze([...new Set(input.secretRefs)].sort()),
        storagePartitionRef: input.storagePartitionRef,
        dataClassification: input.dataClassification,
        status: "active",
        health: "healthy",
        createdAt: this.#clock.now(),
        lastUsedAt: null,
        expiresAt: input.expiresAt,
        revokedAt: null,
      }),
      null,
    );
  }

  async sessionRead(input: {
    readonly sessionId: string;
    readonly requestedUrl: string;
    readonly authorized: boolean;
  }): Promise<WebResourceRecord> {
    if (!input.authorized) this.#reject("Authenticated Web read is not authorized");
    const session = await this.#usableSession(input.sessionId);
    const origin = exactOrigin(input.requestedUrl);
    if (!session.allowedOrigins.includes(origin))
      this.#reject("Authenticated Web read crossed origin scope");
    const observed = await this.#authenticatedAdapter.read({
      session,
      requestedUrl: input.requestedUrl,
      maximumBytes: MAX_PUBLIC_RESOURCE_BYTES,
    });
    if (
      observed.origin !== origin ||
      observed.sessionId !== session.id ||
      !session.allowedOrigins.includes(exactOrigin(observed.canonicalUrl))
    ) {
      this.#reject("Authenticated Web adapter returned an out-of-scope resource");
    }
    return this.#state.saveResource(
      Object.freeze({
        ...observed,
        id: this.#ids.next("web-resource"),
        retrievedAt: this.#clock.now(),
        dataClassification: session.dataClassification,
      }),
    );
  }

  async setSessionState(input: {
    readonly sessionId: string;
    readonly expectedRevision: number;
    readonly action: "pause" | "resume" | "revoke";
  }): Promise<WebSessionRecord> {
    const current = await this.#requiredSession(input.sessionId);
    if (current.revision !== input.expectedRevision) this.#conflict("Web session revision changed");
    if (current.status === "revoked") return current;
    const status =
      input.action === "revoke" ? "revoked" : input.action === "pause" ? "paused" : "active";
    return this.#state.saveSession(
      Object.freeze({
        ...current,
        revision: current.revision + 1,
        status,
        health: status === "active" ? "healthy" : "blocked",
        revokedAt: status === "revoked" ? this.#clock.now() : current.revokedAt,
      }),
      current.revision,
    );
  }

  async blockSessionsAfterAuthorityTransfer(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      const current = await this.#requiredSession(sessionId);
      if (current.hostId === this.#hostId && current.status === "blocked_credentials") continue;
      await this.#state.saveSession(
        Object.freeze({
          ...current,
          revision: current.revision + 1,
          status: "blocked_credentials",
          health: "blocked",
        }),
        current.revision,
      );
    }
  }

  async prepareAction(input: {
    readonly sessionId: string;
    readonly finalUrl: string;
    readonly method: PreparedWebAction["method"];
    readonly fieldRefs: readonly string[];
    readonly uploadRefs: readonly string[];
    readonly recipientRefs: readonly string[];
    readonly priceMicros: number | null;
    readonly currency: string | null;
    readonly accountRef: string | null;
    readonly sideEffectFacts: readonly string[];
    readonly reversible: boolean;
    readonly successMarker: string;
    readonly expiresAt: string;
  }): Promise<PreparedWebAction> {
    const session = await this.#usableSession(input.sessionId);
    const origin = exactOrigin(input.finalUrl);
    if (!session.allowedOrigins.includes(origin))
      this.#reject("Prepared action crossed origin scope");
    if (input.expiresAt <= this.#clock.now() || input.sideEffectFacts.length === 0) {
      this.#reject("Prepared action is expired or lacks side-effect facts");
    }
    const observed = await this.#authenticatedAdapter.prepare({ session, ...input });
    const basis = {
      sessionId: session.id,
      sessionRevision: session.revision,
      finalUrl: input.finalUrl,
      origin,
      method: input.method,
      fieldRefs: [...input.fieldRefs].sort(),
      uploadRefs: [...input.uploadRefs].sort(),
      recipientRefs: [...input.recipientRefs].sort(),
      priceMicros: input.priceMicros,
      currency: input.currency,
      accountRef: input.accountRef,
      sideEffectFacts: [...input.sideEffectFacts].sort(),
      reversible: input.reversible,
      successMarker: input.successMarker,
      pageVersion: observed.pageVersion,
      expiresAt: input.expiresAt,
    } as const;
    const action = Object.freeze({
      id: this.#ids.next("prepared-web-action"),
      revision: 1,
      ...basis,
      canonicalHash: this.#digest.digest(canonicalJson(basis)),
      status: "prepared" as const,
    });
    return this.#state.savePreparedAction(action, null);
  }

  async executeAction(input: {
    readonly handle: WebExecutionHandle;
    readonly idempotencyKey: string;
    readonly authorityFence: number;
  }): Promise<WebOperationRecord> {
    const now = this.#clock.now();
    const existing = await this.#state.readOperation(input.handle.operationId);
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) {
        this.#conflict("Web operation identity was reused with different input");
      }
      return existing;
    }
    const action = await this.#requiredAction(input.handle.preparedActionId);
    const session = await this.#usableSession(input.handle.sessionId);
    if (
      input.handle.maxUses !== 1 ||
      input.handle.expiresAt <= now ||
      input.handle.authorityFence !== input.authorityFence ||
      input.handle.preparedActionHash !== action.canonicalHash ||
      input.handle.operationId.length === 0 ||
      input.handle.origin !== action.origin ||
      input.handle.sessionId !== action.sessionId ||
      action.status !== "prepared" ||
      action.expiresAt <= now ||
      session.revision !== action.sessionRevision
    ) {
      this.#reject("Web execution Handle or prepared snapshot is stale or out of scope");
    }
    const inspected = await this.#authenticatedAdapter.inspect({ session, action });
    if (inspected.pageVersion !== action.pageVersion || inspected.finalUrl !== action.finalUrl) {
      await this.#state.savePreparedAction(
        Object.freeze({ ...action, revision: action.revision + 1, status: "invalidated" }),
        action.revision,
      );
      this.#conflict("Prepared Web page changed before execute");
    }

    const operation: WebOperationRecord = Object.freeze({
      id: input.handle.operationId,
      kind: "web.execute_action",
      preparedActionId: action.id,
      idempotencyKey: input.idempotencyKey,
      status: "running",
      dispatchStartedAt: null,
      observationRefs: Object.freeze([]),
      receiptRef: null,
      resultRef: null,
      reconcileMethod: null,
      createdAt: now,
      updatedAt: now,
    });
    const admitted = await this.#state.createOperation(operation);
    if (admitted.replayed) return admitted.record;
    const dispatching = Object.freeze({ ...operation, dispatchStartedAt: this.#clock.now() });
    await this.#state.saveOperation(dispatching);
    await this.#state.savePreparedAction(
      Object.freeze({ ...action, revision: action.revision + 1, status: "executing" }),
      action.revision,
    );
    try {
      const result = await this.#authenticatedAdapter.execute({
        operationId: operation.id,
        session,
        action,
      });
      return this.#commitOutcome(dispatching, result);
    } catch {
      return this.#commitOutcome(dispatching, {
        outcome: "unknown",
        observationRefs: ["dispatch_interrupted"],
        receiptRef: null,
        resultRef: null,
        reconcileMethod: "web.reconcile",
      });
    }
  }

  async reconcile(operationId: string): Promise<WebOperationRecord> {
    const operation = await this.#state.readOperation(operationId);
    if (!operation || operation.status !== "unknown" || !operation.preparedActionId) {
      this.#reject("Only unknown Web operations can be reconciled");
    }
    const action = await this.#requiredAction(operation.preparedActionId);
    const session = await this.#requiredSession(action.sessionId);
    const result = await this.#authenticatedAdapter.reconcile({ operation, session, action });
    return this.#commitOutcome(operation, result);
  }

  async #commitOutcome(
    operation: WebOperationRecord,
    result: Awaited<ReturnType<AuthenticatedWebAdapterPort["execute"]>>,
  ): Promise<WebOperationRecord> {
    if (result.outcome === "confirmed_succeeded" && !result.receiptRef && !result.resultRef) {
      this.#reject("Confirmed Web success requires stable readback evidence");
    }
    const updated = Object.freeze({
      ...operation,
      status: result.outcome,
      observationRefs: Object.freeze([...result.observationRefs]),
      receiptRef: result.receiptRef,
      resultRef: result.resultRef,
      reconcileMethod: result.reconcileMethod,
      updatedAt: this.#clock.now(),
    });
    await this.#state.saveOperation(updated);
    if (operation.preparedActionId) {
      const action = await this.#requiredAction(operation.preparedActionId);
      await this.#state.savePreparedAction(
        Object.freeze({ ...action, revision: action.revision + 1, status: result.outcome }),
        action.revision,
      );
    }
    return updated;
  }

  async #usableSession(sessionId: string): Promise<WebSessionRecord> {
    const session = await this.#requiredSession(sessionId);
    if (
      session.hostId !== this.#hostId ||
      session.status !== "active" ||
      session.health !== "healthy" ||
      session.expiresAt <= this.#clock.now()
    ) {
      this.#reject("Authenticated Web session is unavailable on this host");
    }
    return session;
  }

  async #requiredSession(sessionId: string): Promise<WebSessionRecord> {
    const session = await this.#state.readSession(sessionId);
    if (!session) throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Web session missing");
    return session;
  }

  async #requiredAction(actionId: string): Promise<PreparedWebAction> {
    const action = await this.#state.readPreparedAction(actionId);
    if (!action)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Prepared Web action missing");
    return action;
  }

  #reject(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, message);
  }

  #conflict(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, message);
  }
}

function requireSafeWebUrl(value: string): void {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "Unsafe Web URL");
  }
}

function exactOrigin(value: string): string {
  requireSafeWebUrl(value);
  return new URL(value).origin;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
