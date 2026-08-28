import type { DataClassification, PayloadRef } from "./common.js";

export type WebOperationKind =
  | "web.search_public"
  | "web.open_public"
  | "web.research"
  | "web.session_read"
  | "web.prepare_action"
  | "web.execute_action"
  | "web.reconcile";

export type WebActionOutcome = "confirmed_succeeded" | "confirmed_failed" | "unknown";

export interface WebSearchCandidate {
  readonly url: string;
  readonly title: string;
  readonly summary: string;
  readonly resultRank: number;
  readonly openedResourceId: string | null;
}

export interface WebResourceRecord {
  readonly id: string;
  readonly requestedUrl: string;
  readonly canonicalUrl: string;
  readonly redirectChain: readonly string[];
  readonly origin: string;
  readonly retrievedAt: string;
  readonly statusCode: number;
  readonly contentType: string;
  readonly contentDigest: string;
  readonly dataClassification: DataClassification;
  readonly sessionId: string | null;
  readonly protectedBodyRef: PayloadRef;
  readonly title: string;
  readonly selectedFragmentRefs: readonly string[];
  readonly excludedReasonCodes: readonly string[];
}

export interface WebResearchCitation {
  readonly resourceId: string;
  readonly contentDigest: string;
  readonly fragmentRef: string;
  readonly claimRef: string;
}

export interface WebSessionRecord {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: string;
  readonly agentId: string;
  readonly hostId: string;
  readonly allowedOrigins: readonly string[];
  readonly purpose: string;
  readonly identityLabel: string;
  readonly secretRefs: readonly string[];
  readonly storagePartitionRef: string;
  readonly dataClassification: DataClassification;
  readonly status: "active" | "paused" | "revoked" | "blocked_credentials" | "expired";
  readonly health: "healthy" | "degraded" | "blocked";
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface PreparedWebAction {
  readonly id: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly finalUrl: string;
  readonly origin: string;
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly fieldRefs: readonly string[];
  readonly uploadRefs: readonly string[];
  readonly recipientRefs: readonly string[];
  readonly priceMicros: number | null;
  readonly currency: string | null;
  readonly accountRef: string | null;
  readonly sideEffectFacts: readonly string[];
  readonly reversible: boolean;
  readonly successMarker: string;
  readonly pageVersion: string;
  readonly canonicalHash: string;
  readonly expiresAt: string;
  readonly status: "prepared" | "invalidated" | "executing" | WebActionOutcome;
}

export interface WebExecutionHandle {
  readonly ref: string;
  readonly preparedActionId: string;
  readonly preparedActionHash: string;
  readonly operationId: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly authorizationRef: string;
  readonly recentAuthenticationRef: string;
  readonly authorityFence: number;
  readonly expiresAt: string;
  readonly maxUses: 1;
}

export interface WebOperationRecord {
  readonly id: string;
  readonly kind: WebOperationKind;
  readonly preparedActionId: string | null;
  readonly idempotencyKey: string;
  readonly status: "running" | WebActionOutcome;
  readonly dispatchStartedAt: string | null;
  readonly observationRefs: readonly string[];
  readonly receiptRef: string | null;
  readonly resultRef: string | null;
  readonly reconcileMethod: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebStatePort {
  saveResource(resource: WebResourceRecord): Promise<WebResourceRecord>;
  readResource(resourceId: string): Promise<WebResourceRecord | undefined>;
  saveSession(
    session: WebSessionRecord,
    expectedRevision: number | null,
  ): Promise<WebSessionRecord>;
  readSession(sessionId: string): Promise<WebSessionRecord | undefined>;
  savePreparedAction(
    action: PreparedWebAction,
    expectedRevision: number | null,
  ): Promise<PreparedWebAction>;
  readPreparedAction(actionId: string): Promise<PreparedWebAction | undefined>;
  createOperation(
    operation: WebOperationRecord,
  ): Promise<{ record: WebOperationRecord; replayed: boolean }>;
  saveOperation(operation: WebOperationRecord): Promise<WebOperationRecord>;
  readOperation(operationId: string): Promise<WebOperationRecord | undefined>;
}

export interface PublicWebAdapterPort {
  search(input: {
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly WebSearchCandidate[]>;
  open(input: {
    readonly requestedUrl: string;
    readonly maximumBytes: number;
  }): Promise<Omit<WebResourceRecord, "id" | "retrievedAt" | "dataClassification">>;
}

export interface AuthenticatedWebAdapterPort {
  read(input: {
    readonly session: WebSessionRecord;
    readonly requestedUrl: string;
    readonly maximumBytes: number;
  }): Promise<Omit<WebResourceRecord, "id" | "retrievedAt" | "dataClassification">>;
  prepare(input: {
    readonly session: WebSessionRecord;
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
  }): Promise<{ readonly pageVersion: string }>;
  inspect(input: {
    readonly session: WebSessionRecord;
    readonly action: PreparedWebAction;
  }): Promise<{ readonly pageVersion: string; readonly finalUrl: string }>;
  execute(input: {
    readonly operationId: string;
    readonly session: WebSessionRecord;
    readonly action: PreparedWebAction;
  }): Promise<{
    readonly outcome: WebActionOutcome;
    readonly observationRefs: readonly string[];
    readonly receiptRef: string | null;
    readonly resultRef: string | null;
    readonly reconcileMethod: string | null;
  }>;
  reconcile(input: {
    readonly operation: WebOperationRecord;
    readonly session: WebSessionRecord;
    readonly action: PreparedWebAction;
  }): Promise<{
    readonly outcome: WebActionOutcome;
    readonly observationRefs: readonly string[];
    readonly receiptRef: string | null;
    readonly resultRef: string | null;
    readonly reconcileMethod: string | null;
  }>;
}

export interface WebContentDigestPort {
  digest(canonicalValue: string): string;
}
