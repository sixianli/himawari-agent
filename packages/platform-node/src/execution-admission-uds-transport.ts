import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
  type ExecutionAdmissionHandshakeAccepted,
  type ExecutionAdmissionPeerBinding,
  type ExecutionAdmissionProjection,
  type ExecutionAdmissionReceiptIdentity,
  type ExecutionAdmissionV1Request,
  type ExecutionAdmissionV1Response,
  type ExecutionAdmissionWorkExecuteAccepted,
  type ExecutionAdmissionWorkExecuteRequest,
  type ExecutionV2Request,
  executionAdmissionV1MessageSchema,
  executionV2MessageSchema,
  type ResourceCeiling,
  type SecretReferenceV2,
} from "@himawari-agent/execution-contracts";
import {
  AuthenticatedUdsClient,
  type AuthenticatedUdsCredential,
  AuthenticatedUdsServer,
  AuthenticatedUdsTransportError,
} from "./authenticated-uds-transport.js";

const HANDSHAKE_PATH = "/admission/v1/handshake";
const WORK_EXECUTE_PATH = "/admission/v1/work/execute";
const JSON_CONTENT_TYPE = "application/json";

export const EXECUTION_ADMISSION_UDS_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: "EXECUTION_ADMISSION_UDS_AUTHENTICATION_FAILED",
  BODY_TOO_LARGE: "EXECUTION_ADMISSION_UDS_BODY_TOO_LARGE",
  CONTENT_TYPE_UNSUPPORTED: "EXECUTION_ADMISSION_UDS_CONTENT_TYPE_UNSUPPORTED",
  DEADLINE_EXCEEDED: "EXECUTION_ADMISSION_UDS_DEADLINE_EXCEEDED",
  HANDLER_FAILED: "EXECUTION_ADMISSION_UDS_HANDLER_FAILED",
  HANDSHAKE_REQUIRED: "EXECUTION_ADMISSION_UDS_HANDSHAKE_REQUIRED",
  INSTANCE_REJECTED: "EXECUTION_ADMISSION_UDS_INSTANCE_REJECTED",
  INVALID_REQUEST: "EXECUTION_ADMISSION_UDS_INVALID_REQUEST",
  INVALID_RESPONSE: "EXECUTION_ADMISSION_UDS_INVALID_RESPONSE",
  RESPONSE_IDENTITY_MISMATCH: "EXECUTION_ADMISSION_UDS_RESPONSE_IDENTITY_MISMATCH",
  REQUEST_FAILED: "EXECUTION_ADMISSION_UDS_REQUEST_FAILED",
  SOCKET_EXISTS: "EXECUTION_ADMISSION_UDS_SOCKET_EXISTS",
  SOCKET_REPLACED: "EXECUTION_ADMISSION_UDS_SOCKET_REPLACED",
  TRANSPORT_UNAVAILABLE: "EXECUTION_ADMISSION_UDS_TRANSPORT_UNAVAILABLE",
} as const);

export type ExecutionAdmissionUdsErrorCode =
  (typeof EXECUTION_ADMISSION_UDS_ERROR_CODES)[keyof typeof EXECUTION_ADMISSION_UDS_ERROR_CODES];

export class ExecutionAdmissionUdsError extends AuthenticatedUdsTransportError {
  declare readonly code: ExecutionAdmissionUdsErrorCode;

  constructor(code: ExecutionAdmissionUdsErrorCode, statusCode: number, cause?: unknown) {
    super(code, statusCode, cause);
    this.name = "ExecutionAdmissionUdsError";
  }
}

export interface ExecutionAdmissionCredential extends AuthenticatedUdsCredential {}

export type ExecutionAdmissionHandlerResult =
  | {
      readonly disposition: "consumed";
      readonly receipt: ExecutionAdmissionReceiptIdentity;
      readonly projection: ExecutionAdmissionProjection;
      readonly reasonCode: null;
    }
  | {
      readonly disposition: "replayed";
      readonly receipt: ExecutionAdmissionReceiptIdentity;
      readonly projection: null;
      readonly reasonCode: null;
    }
  | {
      readonly disposition: "unknown";
      readonly receipt: ExecutionAdmissionReceiptIdentity;
      readonly projection: null;
      readonly reasonCode: string;
    };

export interface ExecutionAdmissionTrustedHandler {
  admit(request: ExecutionAdmissionWorkExecuteRequest): Promise<ExecutionAdmissionHandlerResult>;
}

export interface ExecutionAdmissionUdsServerOptions {
  readonly runtimeDirectory: string;
  readonly socketName?: string;
  readonly credential: ExecutionAdmissionCredential;
  /** Binding obtained from the already authenticated positive Worker handshake. */
  readonly trustedPeerBinding: () => ExecutionAdmissionPeerBinding;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly now: () => string;
  readonly nextId: (scope: string) => string;
  readonly handler: ExecutionAdmissionTrustedHandler;
}

export interface ExecutionAdmissionUdsClientOptions {
  readonly socketPath: string;
  readonly credential: ExecutionAdmissionCredential;
  /** The Worker's previously accepted Agent/Worker/authority binding. */
  readonly peerBinding: ExecutionAdmissionPeerBinding;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly nextId: (scope: string) => string;
  readonly now: () => string;
}

function samePeer(
  left: ExecutionAdmissionPeerBinding,
  right: ExecutionAdmissionPeerBinding,
): boolean {
  return (
    left.agentServiceInstanceId === right.agentServiceInstanceId &&
    left.agentServiceBootId === right.agentServiceBootId &&
    left.workerInstanceId === right.workerInstanceId &&
    left.workerBootId === right.workerBootId &&
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken
  );
}

function peerKey(peer: ExecutionAdmissionPeerBinding): string {
  return [
    peer.agentServiceInstanceId,
    peer.agentServiceBootId,
    peer.workerInstanceId,
    peer.workerBootId,
    peer.deploymentId,
    peer.authorityEpoch,
    peer.fencingToken,
  ].join("\u0000");
}

function assertPeerShape(peer: ExecutionAdmissionPeerBinding): void {
  const values = [
    peer.agentServiceInstanceId,
    peer.agentServiceBootId,
    peer.workerInstanceId,
    peer.workerBootId,
    peer.deploymentId,
  ];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("Execution admission peer identity is invalid");
  }
  if (
    !Number.isSafeInteger(peer.authorityEpoch) ||
    peer.authorityEpoch < 1 ||
    !Number.isSafeInteger(peer.fencingToken) ||
    peer.fencingToken < 1
  ) {
    throw new TypeError("Execution admission authority binding is invalid");
  }
}

function errorFrom(
  error: unknown,
  fallback: ExecutionAdmissionUdsErrorCode,
): ExecutionAdmissionUdsError {
  if (error instanceof ExecutionAdmissionUdsError) return error;
  if (error instanceof AuthenticatedUdsTransportError) {
    const known = Object.values(EXECUTION_ADMISSION_UDS_ERROR_CODES).includes(
      error.code as ExecutionAdmissionUdsErrorCode,
    );
    return new ExecutionAdmissionUdsError(
      known ? (error.code as ExecutionAdmissionUdsErrorCode) : fallback,
      error.statusCode,
      error,
    );
  }
  return new ExecutionAdmissionUdsError(fallback, 400, error);
}

function responseEnvelope(
  request: ExecutionAdmissionV1Request,
  type: "admission.handshake.accepted" | "admission.work.execute.accepted",
  messageId: string,
) {
  return {
    schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
    kind: "response" as const,
    type,
    messageId,
    correlationId: request.correlationId,
    causationId: request.messageId,
  };
}

function requestEnvelope(
  type: "admission.handshake" | "admission.work.execute",
  messageId: string,
  correlationId: string,
  causationId: string | null,
  idempotencyKey: string,
) {
  return {
    schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
    kind: "request" as const,
    type,
    messageId,
    correlationId,
    causationId,
    idempotencyKey,
  };
}

type WorkExecuteRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;
type WorkDelegateRequest = Extract<ExecutionV2Request, { type: "work.delegate" }>;

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSecretReferences(
  left: readonly SecretReferenceV2[],
  right: readonly SecretReferenceV2[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.secretRef === right[index]?.secretRef &&
        value.secretVersion === right[index]?.secretVersion &&
        value.purpose === right[index]?.purpose,
    )
  );
}

function sameResourceCeiling(left: ResourceCeiling, right: ResourceCeiling): boolean {
  return (
    left.maxWallTimeMs === right.maxWallTimeMs &&
    left.maxCpuTimeMs === right.maxCpuTimeMs &&
    left.maxMemoryBytes === right.maxMemoryBytes &&
    left.maxOutputBytes === right.maxOutputBytes &&
    left.maxProgressEvents === right.maxProgressEvents
  );
}

function sameScope(left: WorkExecuteRequest["scope"], right: WorkExecuteRequest["scope"]): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken &&
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.workerRunId === right.workerRunId
  );
}

function sameExecuteSemantics(left: WorkExecuteRequest, right: WorkExecuteRequest): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.type === right.type &&
    left.messageId === right.messageId &&
    left.correlationId === right.correlationId &&
    left.causationId === right.causationId &&
    left.dataClassification === right.dataClassification &&
    left.risk === right.risk &&
    left.authorizationRef === right.authorizationRef &&
    sameScope(left.scope, right.scope) &&
    left.idempotencyKey === right.idempotencyKey &&
    left.payload.capabilityId === right.payload.capabilityId &&
    left.payload.capabilityVersion === right.payload.capabilityVersion &&
    left.payload.operation === right.payload.operation &&
    left.payload.inputRef === right.payload.inputRef &&
    left.payload.capabilityHandleRef === right.payload.capabilityHandleRef &&
    sameStringArray(left.payload.delegatedContextRefs, right.payload.delegatedContextRefs) &&
    sameSecretReferences(left.payload.secretRefs, right.payload.secretRefs) &&
    sameResourceCeiling(left.payload.resourceCeiling, right.payload.resourceCeiling) &&
    left.payload.requestedAt === right.payload.requestedAt &&
    left.payload.deadlineAt === right.payload.deadlineAt
  );
}

function sameHandleAuthorizationRef(
  handleAuthorizationRef: string,
  projectedAuthorizationRef: string | null,
): boolean {
  // A low-risk request may omit an authorizationRef; the durable Handle still
  // carries its authoritative non-null authorization reference.
  return projectedAuthorizationRef === null
    ? handleAuthorizationRef.length > 0
    : handleAuthorizationRef === projectedAuthorizationRef;
}

function sameDelegateProjection(
  projection: ExecutionAdmissionProjection,
  execute: WorkExecuteRequest,
  receipt: ExecutionAdmissionReceiptIdentity,
): boolean {
  const delegate: WorkDelegateRequest = projection.delegate;
  const projectedExecute = projection.execute;
  const handle = delegate.payload.handle;
  const ownerId = execute.scope.ownerId;
  const agentId = execute.scope.agentId;
  const runId = execute.scope.runId;
  if (ownerId === null || agentId === null || runId === null) return false;
  return (
    delegate.schemaVersion === execute.schemaVersion &&
    delegate.kind === "request" &&
    delegate.type === "work.delegate" &&
    delegate.correlationId === execute.correlationId &&
    delegate.causationId === execute.messageId &&
    delegate.dataClassification === projectedExecute.dataClassification &&
    delegate.risk === projectedExecute.risk &&
    delegate.authorizationRef === projectedExecute.authorizationRef &&
    sameScope(delegate.scope, projectedExecute.scope) &&
    delegate.idempotencyKey === `${receipt.idempotencyKey}:delegate` &&
    delegate.payload.requestedAt === projectedExecute.payload.requestedAt &&
    handle.ref === receipt.handleRef &&
    handle.ownerId === ownerId &&
    handle.agentId === agentId &&
    handle.runId === runId &&
    handle.capabilityRef === projectedExecute.payload.capabilityId &&
    handle.capabilityVersion === projectedExecute.payload.capabilityVersion &&
    sameHandleAuthorizationRef(handle.authorizationRef, projectedExecute.authorizationRef) &&
    sameStringArray(handle.operations, [projectedExecute.payload.operation]) &&
    sameStringArray(handle.inputRefs, [projectedExecute.payload.inputRef]) &&
    sameStringArray(handle.delegatedContextRefs, projectedExecute.payload.delegatedContextRefs) &&
    sameSecretReferences(handle.secretRefs, projectedExecute.payload.secretRefs) &&
    handle.maxDataClassification === projectedExecute.dataClassification &&
    handle.operation === projectedExecute.payload.operation &&
    handle.authorityFence === projectedExecute.scope.fencingToken &&
    (handle.authorizationType === "policy" || handle.authorizationType === "grant")
  );
}

function parseJsonRequest(
  body: Buffer,
): ExecutionAdmissionV1Request | ExecutionAdmissionV1Response {
  try {
    return executionAdmissionV1MessageSchema.parse(JSON.parse(body.toString("utf8")) as unknown);
  } catch (error) {
    throw new ExecutionAdmissionUdsError(
      EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_REQUEST,
      400,
      error,
    );
  }
}

function sendJson(
  response: ServerResponse,
  message: ExecutionAdmissionV1Request | ExecutionAdmissionV1Response,
  limit: number,
): void {
  const body = Buffer.from(executionAdmissionV1MessageSchema.serialize(message));
  if (body.byteLength > limit) {
    throw new ExecutionAdmissionUdsError(EXECUTION_ADMISSION_UDS_ERROR_CODES.BODY_TOO_LARGE, 413);
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": JSON_CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export class ExecutionAdmissionUdsServer {
  readonly socketPath: string;
  private readonly options: ExecutionAdmissionUdsServerOptions;
  private readonly uds: AuthenticatedUdsServer;
  private readonly handshakenPeers = new Set<string>();

  constructor(options: ExecutionAdmissionUdsServerOptions) {
    const peer = options.trustedPeerBinding();
    assertPeerShape(peer);
    this.options = options;
    this.uds = new AuthenticatedUdsServer({
      runtimeDirectory: options.runtimeDirectory,
      socketName: options.socketName ?? "execution-admission.sock",
      credential: options.credential,
      allowedPeerInstanceIds: [peer.workerInstanceId],
      peerInstanceHeader: "x-himawari-worker-instance",
      maximumBodyBytes: options.maximumBodyBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      errorCodes: {
        AUTHENTICATION_FAILED: EXECUTION_ADMISSION_UDS_ERROR_CODES.AUTHENTICATION_FAILED,
        BODY_TOO_LARGE: EXECUTION_ADMISSION_UDS_ERROR_CODES.BODY_TOO_LARGE,
        DEADLINE_EXCEEDED: EXECUTION_ADMISSION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
        INSTANCE_REJECTED: EXECUTION_ADMISSION_UDS_ERROR_CODES.INSTANCE_REJECTED,
        REQUEST_FAILED: EXECUTION_ADMISSION_UDS_ERROR_CODES.REQUEST_FAILED,
        SOCKET_EXISTS: EXECUTION_ADMISSION_UDS_ERROR_CODES.SOCKET_EXISTS,
        SOCKET_REPLACED: EXECUTION_ADMISSION_UDS_ERROR_CODES.SOCKET_REPLACED,
        TRANSPORT_UNAVAILABLE: EXECUTION_ADMISSION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      },
      onRequest: (request, response, body) => this.handle(request, response, body),
    });
    this.socketPath = this.uds.socketPath;
  }

  async start(): Promise<void> {
    try {
      await this.uds.start();
    } catch (error) {
      throw errorFrom(error, EXECUTION_ADMISSION_UDS_ERROR_CODES.REQUEST_FAILED);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.uds.stop();
      this.handshakenPeers.clear();
    } catch (error) {
      throw errorFrom(error, EXECUTION_ADMISSION_UDS_ERROR_CODES.REQUEST_FAILED);
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://execution-admission.local");
    if (request.method !== "POST") {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0] !== JSON_CONTENT_TYPE) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED,
        415,
      );
    }
    const message = parseJsonRequest(body);
    const trustedPeer = this.options.trustedPeerBinding();
    assertPeerShape(trustedPeer);
    if (url.pathname === HANDSHAKE_PATH && message.type === "admission.handshake") {
      this.assertPeerRequest(message.payload.peer, trustedPeer, request);
      this.handshakenPeers.add(peerKey(trustedPeer));
      const accepted = executionAdmissionV1MessageSchema.parse({
        ...responseEnvelope(
          message,
          "admission.handshake.accepted",
          this.options.nextId("execution-admission-handshake-accepted"),
        ),
        payload: {
          peer: trustedPeer,
          ready: true,
          acceptedAt: this.options.now(),
        },
      });
      sendJson(response, accepted, this.options.maximumBodyBytes);
      return;
    }
    if (url.pathname === WORK_EXECUTE_PATH && message.type === "admission.work.execute") {
      this.assertPeerRequest(message.payload.peer, trustedPeer, request);
      if (!this.handshakenPeers.has(peerKey(trustedPeer))) {
        throw new ExecutionAdmissionUdsError(
          EXECUTION_ADMISSION_UDS_ERROR_CODES.HANDSHAKE_REQUIRED,
          401,
        );
      }
      let result: ExecutionAdmissionHandlerResult;
      try {
        result = await this.options.handler.admit(message);
      } catch (error) {
        if (error instanceof ExecutionAdmissionUdsError) throw error;
        throw new ExecutionAdmissionUdsError(
          EXECUTION_ADMISSION_UDS_ERROR_CODES.HANDLER_FAILED,
          500,
          error,
        );
      }
      if (response.headersSent || response.writableEnded || response.destroyed) return;
      const currentPeer = this.options.trustedPeerBinding();
      assertPeerShape(currentPeer);
      if (!samePeer(currentPeer, trustedPeer)) {
        this.handshakenPeers.delete(peerKey(trustedPeer));
        result = {
          disposition: "unknown",
          receipt: result.receipt,
          projection: null,
          reasonCode: "PEER_BINDING_CHANGED_AFTER_ADMISSION",
        };
      }
      try {
        const accepted = executionAdmissionV1MessageSchema.parse({
          ...responseEnvelope(
            message,
            "admission.work.execute.accepted",
            this.options.nextId("execution-admission-response"),
          ),
          payload: {
            requestMessageId: message.payload.execute.messageId,
            // Keep the original session binding so the caller can correlate an
            // unknown result after the trusted binding changed mid-flight.
            peer: trustedPeer,
            ...result,
          },
        });
        sendJson(response, accepted, this.options.maximumBodyBytes);
      } catch (error) {
        if (error instanceof ExecutionAdmissionUdsError) throw error;
        throw new ExecutionAdmissionUdsError(
          EXECUTION_ADMISSION_UDS_ERROR_CODES.HANDLER_FAILED,
          500,
          error,
        );
      }
      return;
    }
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
  }

  private assertPeerRequest(
    requestPeer: ExecutionAdmissionPeerBinding,
    trustedPeer: ExecutionAdmissionPeerBinding,
    request: IncomingMessage,
  ): void {
    const header = request.headers["x-himawari-worker-instance"];
    if (
      typeof header !== "string" ||
      header !== trustedPeer.workerInstanceId ||
      !samePeer(requestPeer, trustedPeer)
    ) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.INSTANCE_REJECTED,
        403,
      );
    }
  }
}

export class ExecutionAdmissionUdsClient {
  readonly adapterIdentity = "execution-admission-v1-http-json-over-uds";
  readonly schemaVersion = EXECUTION_ADMISSION_V1_SCHEMA_VERSION;
  private readonly options: ExecutionAdmissionUdsClientOptions;
  private readonly uds: AuthenticatedUdsClient;
  private connected = false;

  constructor(options: ExecutionAdmissionUdsClientOptions) {
    assertPeerShape(options.peerBinding);
    this.options = options;
    this.uds = new AuthenticatedUdsClient({
      socketPath: options.socketPath,
      credential: options.credential,
      peerInstanceId: options.peerBinding.workerInstanceId,
      peerInstanceHeader: "x-himawari-worker-instance",
      maximumBodyBytes: options.maximumBodyBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      errorCodes: {
        BODY_TOO_LARGE: EXECUTION_ADMISSION_UDS_ERROR_CODES.BODY_TOO_LARGE,
        DEADLINE_EXCEEDED: EXECUTION_ADMISSION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
        INSTANCE_REJECTED: EXECUTION_ADMISSION_UDS_ERROR_CODES.INSTANCE_REJECTED,
        TRANSPORT_UNAVAILABLE: EXECUTION_ADMISSION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      },
    });
  }

  isReady(): boolean {
    return this.connected;
  }

  async connect(): Promise<ExecutionAdmissionHandshakeAccepted> {
    const message = executionAdmissionV1MessageSchema.parse({
      ...requestEnvelope(
        "admission.handshake",
        this.options.nextId("execution-admission-handshake"),
        this.options.nextId("execution-admission-correlation"),
        null,
        this.options.nextId("execution-admission-handshake-idempotency"),
      ),
      payload: { peer: this.options.peerBinding, requestedAt: this.options.now() },
    });
    if (message.type !== "admission.handshake") throw new TypeError("Invalid admission handshake");
    try {
      const response = await this.send(HANDSHAKE_PATH, message);
      if (response.statusCode !== 200) this.throwRemote(response.body, response.statusCode);
      const accepted = this.parseResponse(response.body, response.contentType);
      this.assertResponseEnvelope(accepted, message);
      if (accepted.type !== "admission.handshake.accepted") {
        throw new ExecutionAdmissionUdsError(
          EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_RESPONSE,
          502,
        );
      }
      if (!samePeer(accepted.payload.peer, this.options.peerBinding) || !accepted.payload.ready) {
        throw new ExecutionAdmissionUdsError(
          EXECUTION_ADMISSION_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
          502,
        );
      }
      this.connected = true;
      return accepted;
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }

  async admit(
    execute: Extract<ExecutionV2Request, { type: "work.execute" }>,
  ): Promise<ExecutionAdmissionWorkExecuteAccepted["payload"]> {
    if (!this.connected) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.HANDSHAKE_REQUIRED,
        401,
      );
    }
    try {
      const parsedExecute = executionV2MessageSchema.parse(execute);
      if (parsedExecute.kind !== "request" || parsedExecute.type !== "work.execute") {
        throw new ExecutionAdmissionUdsError(
          EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_REQUEST,
          400,
        );
      }
      const message = executionAdmissionV1MessageSchema.parse({
        ...requestEnvelope(
          "admission.work.execute",
          this.options.nextId("execution-admission-request"),
          parsedExecute.correlationId,
          parsedExecute.messageId,
          this.options.nextId("execution-admission-idempotency"),
        ),
        payload: { peer: this.options.peerBinding, execute: parsedExecute },
      });
      if (message.type !== "admission.work.execute")
        throw new TypeError("Invalid admission request");
      const response = await this.send(WORK_EXECUTE_PATH, message);
      if (response.statusCode !== 200) this.throwRemote(response.body, response.statusCode);
      const accepted = this.parseResponse(response.body, response.contentType);
      this.assertResponseEnvelope(accepted, message);
      if (accepted.type !== "admission.work.execute.accepted") {
        throw new ExecutionAdmissionUdsError(
          EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_RESPONSE,
          502,
        );
      }
      this.assertAdmissionIdentity(accepted, parsedExecute);
      if (
        accepted.payload.disposition === "unknown" &&
        accepted.payload.reasonCode === "PEER_BINDING_CHANGED_AFTER_ADMISSION"
      ) {
        this.connected = false;
      }
      return accepted.payload;
    } catch (error) {
      this.connected = false;
      throw error;
    }
  }

  disconnect(): void {
    this.connected = false;
  }

  private async send(path: string, message: ExecutionAdmissionV1Request) {
    const body = Buffer.from(executionAdmissionV1MessageSchema.serialize(message));
    if (body.byteLength > this.options.maximumBodyBytes) {
      throw new ExecutionAdmissionUdsError(EXECUTION_ADMISSION_UDS_ERROR_CODES.BODY_TOO_LARGE, 413);
    }
    try {
      return await this.uds.request({
        method: "POST",
        path,
        body,
        contentType: JSON_CONTENT_TYPE,
      });
    } catch (error) {
      this.connected = false;
      if (error instanceof AuthenticatedUdsTransportError) {
        throw new ExecutionAdmissionUdsError(
          error.code as ExecutionAdmissionUdsErrorCode,
          error.statusCode,
          error,
        );
      }
      throw error;
    }
  }

  private parseResponse(
    body: Buffer,
    contentType: string | undefined,
  ): ExecutionAdmissionV1Response {
    if (contentType?.split(";", 1)[0] !== JSON_CONTENT_TYPE) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_RESPONSE,
        502,
      );
    }
    try {
      return executionAdmissionV1MessageSchema.parse(
        JSON.parse(body.toString("utf8")) as unknown,
      ) as ExecutionAdmissionHandshakeAccepted | ExecutionAdmissionWorkExecuteAccepted;
    } catch (error) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_RESPONSE,
        502,
        error,
      );
    }
  }

  private assertResponseEnvelope(
    response: ExecutionAdmissionV1Response,
    request: ExecutionAdmissionV1Request,
  ): void {
    if (
      response.kind !== "response" ||
      request.kind !== "request" ||
      response.correlationId !== request.correlationId ||
      response.causationId !== request.messageId
    ) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
        502,
      );
    }
  }

  private assertAdmissionIdentity(
    response: ExecutionAdmissionWorkExecuteAccepted,
    execute: Extract<ExecutionV2Request, { type: "work.execute" }>,
  ): void {
    const expectedScope = execute.scope;
    const receipt = response.payload.receipt;
    const scopeMatches =
      receipt.ownerId === expectedScope.ownerId &&
      receipt.agentId === expectedScope.agentId &&
      receipt.runId === expectedScope.runId &&
      receipt.workerRunId === expectedScope.workerRunId;
    if (
      response.payload.requestMessageId !== execute.messageId ||
      !samePeer(response.payload.peer, this.options.peerBinding) ||
      response.payload.peer.deploymentId !== expectedScope.deploymentId ||
      response.payload.peer.authorityEpoch !== expectedScope.authorityEpoch ||
      response.payload.peer.fencingToken !== expectedScope.fencingToken ||
      receipt.invocationId !== execute.messageId ||
      receipt.handleRef !== execute.payload.capabilityHandleRef ||
      receipt.idempotencyKey !== execute.idempotencyKey ||
      !scopeMatches
    ) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
        502,
      );
    }
    if (response.payload.disposition !== "consumed") return;
    const projection = response.payload.projection;
    if (
      !sameExecuteSemantics(projection.execute, execute) ||
      !sameScope(projection.execute.scope, execute.scope) ||
      projection.execute.messageId !== receipt.invocationId ||
      projection.execute.idempotencyKey !== receipt.idempotencyKey ||
      projection.execute.payload.capabilityHandleRef !== receipt.handleRef ||
      !sameDelegateProjection(projection, execute, receipt)
    ) {
      throw new ExecutionAdmissionUdsError(
        EXECUTION_ADMISSION_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
        502,
      );
    }
  }

  private throwRemote(body: Buffer, statusCode: number): never {
    let code: ExecutionAdmissionUdsErrorCode = EXECUTION_ADMISSION_UDS_ERROR_CODES.REQUEST_FAILED;
    try {
      const parsed = JSON.parse(body.toString("utf8")) as {
        readonly error?: { readonly code?: unknown };
      };
      if (
        typeof parsed.error?.code === "string" &&
        Object.values(EXECUTION_ADMISSION_UDS_ERROR_CODES).includes(
          parsed.error.code as ExecutionAdmissionUdsErrorCode,
        )
      ) {
        code = parsed.error.code as ExecutionAdmissionUdsErrorCode;
      }
    } catch {
      code = EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_RESPONSE;
    }
    throw new ExecutionAdmissionUdsError(code, statusCode);
  }
}
