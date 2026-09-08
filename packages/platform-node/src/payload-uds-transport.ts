import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PAYLOAD_BROKER_V1_SCHEMA_VERSION,
  type PayloadBrokerHandshakeAccepted,
  type PayloadBrokerHandshakeRequest,
  type PayloadBrokerInputReadRequest,
  type PayloadBrokerInputReadResult,
  type PayloadBrokerMessage,
  type PayloadBrokerOutputWriteAccepted,
  type PayloadBrokerOutputWriteRequest,
  type PayloadBrokerSandboxJobRequest,
  type PayloadBrokerSandboxJobResult,
  payloadBrokerV1MessageSchema,
} from "@himawari-agent/execution-contracts";
import {
  AuthenticatedUdsClient,
  type AuthenticatedUdsCredential,
  AuthenticatedUdsServer,
  AuthenticatedUdsTransportError,
} from "./authenticated-uds-transport.js";

const SANDBOX_JOB_PATH = "/payload/v1/sandbox/job";
const HANDSHAKE_PATH = "/payload/v1/handshake";
const INPUT_READ_PATH = "/payload/v1/input/read";
const OUTPUT_WRITE_PATH = "/payload/v1/output/write";
const JSON_CONTENT_TYPE = "application/json";

export const PAYLOAD_UDS_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: "PAYLOAD_UDS_AUTHENTICATION_FAILED",
  BODY_TOO_LARGE: "PAYLOAD_UDS_BODY_TOO_LARGE",
  CONTENT_TYPE_UNSUPPORTED: "PAYLOAD_UDS_CONTENT_TYPE_UNSUPPORTED",
  DEADLINE_EXCEEDED: "PAYLOAD_UDS_DEADLINE_EXCEEDED",
  HANDLER_FAILED: "PAYLOAD_UDS_HANDLER_FAILED",
  HANDSHAKE_REQUIRED: "PAYLOAD_UDS_HANDSHAKE_REQUIRED",
  INSTANCE_REJECTED: "PAYLOAD_UDS_INSTANCE_REJECTED",
  INVALID_REQUEST: "PAYLOAD_UDS_INVALID_REQUEST",
  INVALID_RESPONSE: "PAYLOAD_UDS_INVALID_RESPONSE",
  RESPONSE_IDENTITY_MISMATCH: "PAYLOAD_UDS_RESPONSE_IDENTITY_MISMATCH",
  PAYLOAD_TOO_LARGE: "PAYLOAD_UDS_PAYLOAD_TOO_LARGE",
  REQUEST_FAILED: "PAYLOAD_UDS_REQUEST_FAILED",
  SOCKET_EXISTS: "PAYLOAD_UDS_SOCKET_EXISTS",
  SOCKET_REPLACED: "PAYLOAD_UDS_SOCKET_REPLACED",
  TRANSPORT_UNAVAILABLE: "PAYLOAD_UDS_TRANSPORT_UNAVAILABLE",
} as const);

type PayloadUdsErrorCode = (typeof PAYLOAD_UDS_ERROR_CODES)[keyof typeof PAYLOAD_UDS_ERROR_CODES];

const COMMON_UDS_ERROR_CODES = {
  AUTHENTICATION_FAILED: PAYLOAD_UDS_ERROR_CODES.AUTHENTICATION_FAILED,
  BODY_TOO_LARGE: PAYLOAD_UDS_ERROR_CODES.BODY_TOO_LARGE,
  DEADLINE_EXCEEDED: PAYLOAD_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
  INSTANCE_REJECTED: PAYLOAD_UDS_ERROR_CODES.INSTANCE_REJECTED,
  REQUEST_FAILED: PAYLOAD_UDS_ERROR_CODES.REQUEST_FAILED,
  SOCKET_EXISTS: PAYLOAD_UDS_ERROR_CODES.SOCKET_EXISTS,
  SOCKET_REPLACED: PAYLOAD_UDS_ERROR_CODES.SOCKET_REPLACED,
  TRANSPORT_UNAVAILABLE: PAYLOAD_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE,
} as const;

export class PayloadUdsError extends AuthenticatedUdsTransportError {
  declare readonly code: PayloadUdsErrorCode;

  constructor(code: PayloadUdsErrorCode, statusCode: number, cause?: unknown) {
    super(code, statusCode, cause);
    this.name = "PayloadUdsError";
  }
}

export interface PayloadUdsCredential extends AuthenticatedUdsCredential {}

export interface PayloadBrokerWorkerIdentity {
  readonly workerInstanceId: string;
  readonly workerBootId: string;
}

export interface PayloadBrokerInvocationIdentity extends PayloadBrokerWorkerIdentity {
  readonly handleRef: string;
  readonly invocationId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export interface PayloadBrokerOutputReceipt {
  readonly outputRef: string;
  readonly replayed: boolean;
}

export interface PayloadBrokerTrustedHandler {
  sandboxJob?(
    request: PayloadBrokerSandboxJobRequest,
  ): Promise<Pick<PayloadBrokerSandboxJobResult["payload"], "record" | "applied">>;
  readInput(request: PayloadBrokerInputReadRequest): Promise<Uint8Array>;
  writeOutput(
    request: PayloadBrokerOutputWriteRequest,
    plaintext: Uint8Array,
    contentType: string,
  ): Promise<PayloadBrokerOutputReceipt>;
}

export interface PayloadUdsServerOptions {
  readonly runtimeDirectory: string;
  readonly socketName?: string;
  readonly credential: PayloadUdsCredential;
  readonly agentServiceInstanceId: string;
  readonly agentServiceBootId: string;
  readonly allowedWorkerIdentities: readonly PayloadBrokerWorkerIdentity[];
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly maximumBodyBytes: number;
  readonly maximumPayloadBytes: number;
  readonly requestTimeoutMs: number;
  readonly handler: PayloadBrokerTrustedHandler;
}

export interface PayloadUdsClientOptions {
  readonly socketPath: string;
  readonly credential: PayloadUdsCredential;
  readonly agentServiceInstanceId: string;
  readonly agentServiceBootId: string;
  readonly workerInstanceId: string;
  readonly workerBootId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly maximumBodyBytes: number;
  readonly maximumPayloadBytes: number;
  readonly requestTimeoutMs: number;
  readonly nextId: (scope: string) => string;
}

function responseEnvelope(
  request: PayloadBrokerMessage,
  type:
    | "payload.sandbox.job.result"
    | "payload.handshake.accepted"
    | "payload.input.read.result"
    | "payload.output.write.accepted",
) {
  return {
    schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
    kind: "response" as const,
    type,
    messageId: request.messageId,
    correlationId: request.correlationId,
    causationId: request.messageId,
  };
}

function requestEnvelope(
  type: "payload.handshake" | "payload.input.read" | "payload.output.write" | "payload.sandbox.job",
  messageId: string,
) {
  return {
    schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
    kind: "request" as const,
    type,
    messageId,
    correlationId: messageId,
    causationId: null,
    idempotencyKey: `${messageId}:idempotency`,
  };
}

function payloadIdentity(input: PayloadBrokerInvocationIdentity): PayloadBrokerInvocationIdentity {
  return {
    handleRef: input.handleRef,
    invocationId: input.invocationId,
    workerInstanceId: input.workerInstanceId,
    workerBootId: input.workerBootId,
    authorityEpoch: input.authorityEpoch,
    fencingToken: input.fencingToken,
  };
}

function errorFrom(error: unknown, fallback: PayloadUdsErrorCode): PayloadUdsError {
  if (error instanceof PayloadUdsError) return error;
  if (error instanceof AuthenticatedUdsTransportError) {
    return new PayloadUdsError(error.code as PayloadUdsErrorCode, error.statusCode, error);
  }
  return new PayloadUdsError(fallback, 400, error);
}

function sendJson(
  response: ServerResponse,
  message: PayloadBrokerMessage,
  maximumBodyBytes: number,
): void {
  const body = Buffer.from(payloadBrokerV1MessageSchema.serialize(message));
  if (body.byteLength > maximumBodyBytes) {
    throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.BODY_TOO_LARGE, 413);
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": JSON_CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function parseJsonResponse(body: Buffer, contentType: string | undefined): PayloadBrokerMessage {
  if (contentType?.split(";", 1)[0] !== JSON_CONTENT_TYPE) {
    throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
  }
  try {
    return payloadBrokerV1MessageSchema.parse(JSON.parse(body.toString("utf8")) as unknown);
  } catch (error) {
    throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502, error);
  }
}

export class PayloadUdsServer {
  readonly socketPath: string;
  private readonly options: PayloadUdsServerOptions;
  private readonly uds: AuthenticatedUdsServer;
  private readonly handshakenWorkers = new Set<string>();

  constructor(options: PayloadUdsServerOptions) {
    if (!Number.isSafeInteger(options.authorityEpoch) || options.authorityEpoch < 1) {
      throw new TypeError("Payload UDS authority epoch must be a positive integer");
    }
    if (!Number.isSafeInteger(options.fencingToken) || options.fencingToken < 1) {
      throw new TypeError("Payload UDS fencing token must be a positive integer");
    }
    if (
      !Number.isSafeInteger(options.maximumPayloadBytes) ||
      options.maximumPayloadBytes < 1 ||
      options.maximumPayloadBytes > options.maximumBodyBytes
    ) {
      throw new TypeError("Payload UDS maximum payload bytes must fit inside the body limit");
    }
    if (options.allowedWorkerIdentities.length === 0) {
      throw new TypeError("Payload UDS requires an allowed Worker identity");
    }
    this.options = options;
    this.uds = new AuthenticatedUdsServer({
      runtimeDirectory: options.runtimeDirectory,
      socketName: options.socketName ?? "payload.sock",
      credential: options.credential,
      allowedPeerInstanceIds: options.allowedWorkerIdentities.map(
        ({ workerInstanceId }) => workerInstanceId,
      ),
      peerInstanceHeader: "x-himawari-worker-instance",
      maximumBodyBytes: options.maximumBodyBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      errorCodes: COMMON_UDS_ERROR_CODES,
      onRequest: (request, response, body) => this.handle(request, response, body),
    });
    this.socketPath = this.uds.socketPath;
  }

  async start(): Promise<void> {
    try {
      await this.uds.start();
    } catch (error) {
      throw errorFrom(error, PAYLOAD_UDS_ERROR_CODES.REQUEST_FAILED);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.uds.stop();
      this.handshakenWorkers.clear();
    } catch (error) {
      throw errorFrom(error, PAYLOAD_UDS_ERROR_CODES.REQUEST_FAILED);
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://payload.local");
      if (request.method !== "POST") {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.headers["content-type"]?.split(";", 1)[0] !== JSON_CONTENT_TYPE) {
        throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED, 415);
      }
      let message: PayloadBrokerMessage;
      try {
        message = payloadBrokerV1MessageSchema.parse(JSON.parse(body.toString("utf8")) as unknown);
      } catch (error) {
        throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_REQUEST, 400, error);
      }
      if (url.pathname === HANDSHAKE_PATH && message.type === "payload.handshake") {
        this.handleHandshake(message, request);
        sendJson(response, this.handshakeResponse(message), this.options.maximumBodyBytes);
        return;
      }
      if (url.pathname === SANDBOX_JOB_PATH && message.type === "payload.sandbox.job") {
        this.assertOperationIdentity(message, request);
        if (!this.options.handler.sandboxJob)
          throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED, 503);
        const result = await this.options.handler.sandboxJob(message);
        if (response.headersSent || response.writableEnded || response.destroyed) return;
        sendJson(
          response,
          payloadBrokerV1MessageSchema.parse({
            ...responseEnvelope(message, "payload.sandbox.job.result"),
            payload: {
              ...payloadIdentity(message.payload),
              agentServiceInstanceId: this.options.agentServiceInstanceId,
              agentServiceBootId: this.options.agentServiceBootId,
              ...result,
            },
          }),
          this.options.maximumBodyBytes,
        );
        return;
      }
      if (url.pathname === INPUT_READ_PATH && message.type === "payload.input.read") {
        this.assertOperationIdentity(message, request);
        const bytes = await this.readInput(message);
        if (response.headersSent || response.writableEnded || response.destroyed) return;
        const result = {
          ...responseEnvelope(message, "payload.input.read.result"),
          payload: {
            ...message.payload,
            agentServiceInstanceId: this.options.agentServiceInstanceId,
            agentServiceBootId: this.options.agentServiceBootId,
            bytesBase64: Buffer.from(bytes).toString("base64"),
          },
        };
        sendJson(
          response,
          payloadBrokerV1MessageSchema.parse(result),
          this.options.maximumBodyBytes,
        );
        return;
      }
      if (url.pathname === OUTPUT_WRITE_PATH && message.type === "payload.output.write") {
        this.assertOperationIdentity(message, request);
        const result = await this.writeOutput(message);
        if (response.headersSent || response.writableEnded || response.destroyed) return;
        sendJson(
          response,
          payloadBrokerV1MessageSchema.parse(result),
          this.options.maximumBodyBytes,
        );
        return;
      }
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
    } catch (error) {
      if (response.headersSent || response.writableEnded || response.destroyed) return;
      throw errorFrom(error, PAYLOAD_UDS_ERROR_CODES.REQUEST_FAILED);
    }
  }

  private handleHandshake(
    request: PayloadBrokerHandshakeRequest,
    httpRequest: IncomingMessage,
  ): void {
    const peerInstanceId = httpRequest.headers["x-himawari-worker-instance"];
    const worker = this.options.allowedWorkerIdentities.find(
      (candidate) =>
        candidate.workerInstanceId === request.payload.workerInstanceId &&
        candidate.workerBootId === request.payload.workerBootId,
    );
    if (
      typeof peerInstanceId !== "string" ||
      peerInstanceId !== request.payload.workerInstanceId ||
      !worker ||
      request.payload.agentServiceInstanceId !== this.options.agentServiceInstanceId ||
      request.payload.agentServiceBootId !== this.options.agentServiceBootId ||
      request.payload.authorityEpoch !== this.options.authorityEpoch ||
      request.payload.fencingToken !== this.options.fencingToken
    ) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INSTANCE_REJECTED, 403);
    }
    this.handshakenWorkers.add(this.workerKey(worker));
  }

  private handshakeResponse(
    request: PayloadBrokerHandshakeRequest,
  ): PayloadBrokerHandshakeAccepted {
    const message = {
      ...responseEnvelope(request, "payload.handshake.accepted"),
      payload: {
        agentServiceInstanceId: this.options.agentServiceInstanceId,
        agentServiceBootId: this.options.agentServiceBootId,
        workerInstanceId: request.payload.workerInstanceId,
        workerBootId: request.payload.workerBootId,
        authorityEpoch: this.options.authorityEpoch,
        fencingToken: this.options.fencingToken,
        acceptedAt: new Date().toISOString(),
      },
    };
    return payloadBrokerV1MessageSchema.parse(message) as PayloadBrokerHandshakeAccepted;
  }

  private assertOperationIdentity(
    request:
      | PayloadBrokerInputReadRequest
      | PayloadBrokerOutputWriteRequest
      | PayloadBrokerSandboxJobRequest,
    httpRequest: IncomingMessage,
  ): void {
    const worker = this.options.allowedWorkerIdentities.find(
      (candidate) =>
        candidate.workerInstanceId === request.payload.workerInstanceId &&
        candidate.workerBootId === request.payload.workerBootId,
    );
    if (
      typeof httpRequest.headers["x-himawari-worker-instance"] !== "string" ||
      httpRequest.headers["x-himawari-worker-instance"] !== request.payload.workerInstanceId ||
      !worker ||
      !this.handshakenWorkers.has(this.workerKey(worker)) ||
      request.payload.authorityEpoch !== this.options.authorityEpoch ||
      request.payload.fencingToken !== this.options.fencingToken
    ) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.HANDSHAKE_REQUIRED, 401);
    }
  }

  private async readInput(request: PayloadBrokerInputReadRequest): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await this.options.handler.readInput(request);
    } catch (error) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED, 500, error);
    }
    if (bytes.byteLength > this.options.maximumPayloadBytes) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.PAYLOAD_TOO_LARGE, 413);
    }
    return new Uint8Array(bytes);
  }

  private async writeOutput(
    request: PayloadBrokerOutputWriteRequest,
  ): Promise<PayloadBrokerOutputWriteAccepted> {
    const plaintext = Buffer.from(request.payload.bytesBase64, "base64");
    if (plaintext.byteLength > this.options.maximumPayloadBytes) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.PAYLOAD_TOO_LARGE, 413);
    }
    let receipt: PayloadBrokerOutputReceipt;
    try {
      receipt = await this.options.handler.writeOutput(
        request,
        new Uint8Array(plaintext),
        request.payload.contentType,
      );
    } catch (error) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED, 500, error);
    }
    const message = {
      ...responseEnvelope(request, "payload.output.write.accepted"),
      payload: {
        handleRef: request.payload.handleRef,
        invocationId: request.payload.invocationId,
        workerInstanceId: request.payload.workerInstanceId,
        workerBootId: request.payload.workerBootId,
        authorityEpoch: request.payload.authorityEpoch,
        fencingToken: request.payload.fencingToken,
        agentServiceInstanceId: this.options.agentServiceInstanceId,
        agentServiceBootId: this.options.agentServiceBootId,
        outputRef: receipt.outputRef,
        replayed: receipt.replayed,
      },
    };
    try {
      return payloadBrokerV1MessageSchema.parse(message) as PayloadBrokerOutputWriteAccepted;
    } catch (error) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED, 500, error);
    }
  }

  private workerKey(worker: PayloadBrokerWorkerIdentity): string {
    return `${worker.workerInstanceId}\u0000${worker.workerBootId}`;
  }
}

export class PayloadUdsClient {
  readonly adapterIdentity = "payload-broker-v1-http-json-over-uds";
  readonly schemaVersion = PAYLOAD_BROKER_V1_SCHEMA_VERSION;
  private readonly options: PayloadUdsClientOptions;
  private readonly uds: AuthenticatedUdsClient;
  private connected = false;

  constructor(options: PayloadUdsClientOptions) {
    if (!Number.isSafeInteger(options.authorityEpoch) || options.authorityEpoch < 1) {
      throw new TypeError("Payload UDS authority epoch must be a positive integer");
    }
    if (!Number.isSafeInteger(options.fencingToken) || options.fencingToken < 1) {
      throw new TypeError("Payload UDS fencing token must be a positive integer");
    }
    if (
      !Number.isSafeInteger(options.maximumPayloadBytes) ||
      options.maximumPayloadBytes < 1 ||
      options.maximumPayloadBytes > options.maximumBodyBytes
    ) {
      throw new TypeError("Payload UDS maximum payload bytes must fit inside the body limit");
    }
    this.options = options;
    this.uds = new AuthenticatedUdsClient({
      socketPath: options.socketPath,
      credential: options.credential,
      peerInstanceId: options.workerInstanceId,
      peerInstanceHeader: "x-himawari-worker-instance",
      maximumBodyBytes: options.maximumBodyBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      errorCodes: COMMON_UDS_ERROR_CODES,
    });
  }

  isReady(): boolean {
    return this.connected;
  }

  async connect(): Promise<PayloadBrokerHandshakeAccepted> {
    const message = {
      ...requestEnvelope("payload.handshake", this.options.nextId("payload-handshake")),
      payload: {
        agentServiceInstanceId: this.options.agentServiceInstanceId,
        agentServiceBootId: this.options.agentServiceBootId,
        workerInstanceId: this.options.workerInstanceId,
        workerBootId: this.options.workerBootId,
        authorityEpoch: this.options.authorityEpoch,
        fencingToken: this.options.fencingToken,
        requestedAt: new Date().toISOString(),
      },
    };
    const parsed = payloadBrokerV1MessageSchema.parse(message);
    const response = await this.send(HANDSHAKE_PATH, parsed);
    if (response.statusCode !== 200) this.throwRemote(response.body, response.statusCode);
    const accepted = parseJsonResponse(response.body, response.contentType);
    this.assertResponseEnvelope(accepted, parsed);
    if (accepted.type !== "payload.handshake.accepted") {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    }
    this.assertHandshakeIdentity(accepted);
    this.connected = true;
    return accepted;
  }

  async readInput(identity: PayloadBrokerInvocationIdentity): Promise<Uint8Array> {
    this.assertConnected();
    this.assertClientIdentity(identity);
    const request = payloadBrokerV1MessageSchema.parse({
      ...requestEnvelope("payload.input.read", this.options.nextId("payload-input-read")),
      payload: payloadIdentity(identity),
    });
    const response = await this.send(INPUT_READ_PATH, request);
    if (response.statusCode !== 200) this.throwRemote(response.body, response.statusCode);
    const result = parseJsonResponse(response.body, response.contentType);
    this.assertResponseEnvelope(result, request);
    if (result.type !== "payload.input.read.result") {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    }
    this.assertResponseIdentity(result, identity);
    const bytes = Buffer.from(result.payload.bytesBase64, "base64");
    if (
      bytes.byteLength > this.options.maximumPayloadBytes ||
      bytes.toString("base64") !== result.payload.bytesBase64
    ) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    }
    return new Uint8Array(bytes);
  }

  async sandboxJob(
    identity: PayloadBrokerInvocationIdentity,
    job: PayloadBrokerSandboxJobRequest["payload"]["identity"],
    observation: PayloadBrokerSandboxJobRequest["payload"]["observation"] = null,
  ): Promise<Pick<PayloadBrokerSandboxJobResult["payload"], "record" | "applied">> {
    this.assertConnected();
    this.assertClientIdentity(identity);
    const request = payloadBrokerV1MessageSchema.parse({
      ...requestEnvelope("payload.sandbox.job", this.options.nextId("sandbox-job")),
      payload: { ...payloadIdentity(identity), identity: job, observation },
    });
    const response = await this.send(SANDBOX_JOB_PATH, request);
    if (response.statusCode !== 200) this.throwRemote(response.body, response.statusCode);
    const result = parseJsonResponse(response.body, response.contentType);
    this.assertResponseEnvelope(result, request);
    if (result.type !== "payload.sandbox.job.result")
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    this.assertResponseIdentity(result, identity);
    if (
      request.type !== "payload.sandbox.job" ||
      JSON.stringify(result.payload.record.plan.identity) !==
        JSON.stringify(request.payload.identity)
    )
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH, 502);
    const requested = request.payload.observation;
    const returned = result.payload.record.observation;
    if (
      (!requested && result.payload.applied) ||
      (requested &&
        (returned.sequence < requested.sequence ||
          ((result.payload.applied || returned.sequence === requested.sequence) &&
            JSON.stringify(returned) !== JSON.stringify(requested))))
    )
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    return { record: result.payload.record, applied: result.payload.applied };
  }

  async writeOutput(
    identity: PayloadBrokerInvocationIdentity,
    plaintext: Uint8Array,
    contentType: string,
  ): Promise<PayloadBrokerOutputReceipt> {
    this.assertConnected();
    this.assertClientIdentity(identity);
    if (plaintext.byteLength > this.options.maximumPayloadBytes) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.PAYLOAD_TOO_LARGE, 413);
    }
    const request = payloadBrokerV1MessageSchema.parse({
      ...requestEnvelope("payload.output.write", this.options.nextId("payload-output-write")),
      payload: {
        ...payloadIdentity(identity),
        bytesBase64: Buffer.from(plaintext).toString("base64"),
        contentType,
      },
    });
    const response = await this.send(OUTPUT_WRITE_PATH, request);
    if (response.statusCode !== 200) this.throwRemote(response.body, response.statusCode);
    const accepted = parseJsonResponse(response.body, response.contentType);
    this.assertResponseEnvelope(accepted, request);
    if (accepted.type !== "payload.output.write.accepted") {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    }
    this.assertResponseIdentity(accepted, identity);
    return { outputRef: accepted.payload.outputRef, replayed: accepted.payload.replayed };
  }

  disconnect(): void {
    this.connected = false;
  }

  private async send(path: string, message: PayloadBrokerMessage) {
    const body = Buffer.from(payloadBrokerV1MessageSchema.serialize(message));
    if (body.byteLength > this.options.maximumBodyBytes) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.BODY_TOO_LARGE, 413);
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
        throw new PayloadUdsError(error.code as PayloadUdsErrorCode, error.statusCode, error);
      }
      throw error;
    }
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.HANDSHAKE_REQUIRED, 401);
    }
  }

  private assertClientIdentity(identity: PayloadBrokerInvocationIdentity): void {
    if (
      identity.workerInstanceId !== this.options.workerInstanceId ||
      identity.workerBootId !== this.options.workerBootId ||
      identity.authorityEpoch !== this.options.authorityEpoch ||
      identity.fencingToken !== this.options.fencingToken
    ) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH, 400);
    }
  }

  private assertHandshakeIdentity(response: PayloadBrokerHandshakeAccepted): void {
    if (
      response.payload.agentServiceInstanceId !== this.options.agentServiceInstanceId ||
      response.payload.agentServiceBootId !== this.options.agentServiceBootId ||
      response.payload.workerInstanceId !== this.options.workerInstanceId ||
      response.payload.workerBootId !== this.options.workerBootId ||
      response.payload.authorityEpoch !== this.options.authorityEpoch ||
      response.payload.fencingToken !== this.options.fencingToken
    ) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH, 502);
    }
  }

  private assertResponseIdentity(
    response:
      | PayloadBrokerInputReadResult
      | PayloadBrokerOutputWriteAccepted
      | PayloadBrokerSandboxJobResult,
    identity: PayloadBrokerInvocationIdentity,
  ): void {
    if (
      response.payload.agentServiceInstanceId !== this.options.agentServiceInstanceId ||
      response.payload.agentServiceBootId !== this.options.agentServiceBootId ||
      response.payload.handleRef !== identity.handleRef ||
      response.payload.invocationId !== identity.invocationId ||
      response.payload.workerInstanceId !== identity.workerInstanceId ||
      response.payload.workerBootId !== identity.workerBootId ||
      response.payload.authorityEpoch !== identity.authorityEpoch ||
      response.payload.fencingToken !== identity.fencingToken
    ) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH, 502);
    }
  }

  private assertResponseEnvelope(
    response: PayloadBrokerMessage,
    request: PayloadBrokerMessage,
  ): void {
    if (
      response.kind !== "response" ||
      request.kind !== "request" ||
      response.correlationId !== request.correlationId ||
      response.causationId !== request.messageId
    ) {
      throw new PayloadUdsError(PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH, 502);
    }
  }

  private throwRemote(body: Buffer, statusCode: number): never {
    let code: PayloadUdsErrorCode = PAYLOAD_UDS_ERROR_CODES.REQUEST_FAILED;
    try {
      const parsed = JSON.parse(body.toString("utf8")) as {
        readonly error?: { readonly code?: unknown };
      };
      if (
        typeof parsed.error?.code === "string" &&
        Object.values(PAYLOAD_UDS_ERROR_CODES).includes(parsed.error.code as PayloadUdsErrorCode)
      ) {
        code = parsed.error.code as PayloadUdsErrorCode;
      }
    } catch {
      code = PAYLOAD_UDS_ERROR_CODES.INVALID_RESPONSE;
    }
    throw new PayloadUdsError(code, statusCode);
  }
}
