import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  GitHubIntegrationStatePort,
  GitHubRepositoryMonitor,
  GitHubWebhookReceiptRecord,
} from "@himawari-agent/application";
import type { BackgroundOccurrence, JobId } from "@himawari-agent/domain";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 60;

export const DEFAULT_GITHUB_EVENT_KEYS = Object.freeze([
  "github:event:push",
  "github:event:pull_request:opened",
  "github:event:pull_request:synchronize",
  "github:event:pull_request:closed",
  "github:event:release:published",
  "github:event:release:created",
  "github:event:workflow_run:completed:failure",
] as const);

export type GitHubWebhookRejectionCode =
  | "GITHUB_BODY_TOO_LARGE"
  | "GITHUB_CONTENT_TYPE_REJECTED"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_SIGNATURE_REJECTED"
  | "GITHUB_MALFORMED_PAYLOAD"
  | "GITHUB_INSTALLATION_REJECTED"
  | "GITHUB_REPOSITORY_REJECTED"
  | "GITHUB_EVENT_REJECTED"
  | "GITHUB_DELIVERY_SCOPE_REJECTED"
  | "GITHUB_CREDENTIAL_REVOKED"
  | "GITHUB_ADMISSION_FAILED";

export class GitHubWebhookError extends Error {
  readonly code: GitHubWebhookRejectionCode;
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

  constructor(
    code: GitHubWebhookRejectionCode,
    message: string,
    status: GitHubWebhookError["status"],
  ) {
    super(message);
    this.name = "GitHubWebhookError";
    this.code = code;
    this.status = status;
  }
}

export interface GitHubWebhookSecretSource {
  resolve(secretRef: string): Promise<Uint8Array | string>;
}

export interface ProtectedWebhookPayloadSink {
  put(input: {
    readonly ref: string;
    readonly ownerId: GitHubRepositoryMonitor["ownerId"];
    readonly agentId: GitHubRepositoryMonitor["agentId"];
    readonly classification: "public" | "private" | "sensitive" | "restricted";
    readonly contentType: "application/json";
    readonly plaintext: Uint8Array;
    readonly createdAt: string;
  }): Promise<void>;
}

/** A small fixed-window limiter keeps the webhook route bounded before parsing. */
export class GitHubWebhookRateLimiter {
  private readonly buckets = new Map<string, { windowStartedAt: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(input: { readonly limit?: number; readonly windowMs?: number } = {}) {
    this.limit = input.limit ?? DEFAULT_RATE_LIMIT;
    this.windowMs = input.windowMs ?? DEFAULT_RATE_WINDOW_MS;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) {
      throw new RangeError("GitHub webhook rate limit must be positive");
    }
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs < 1) {
      throw new RangeError("GitHub webhook rate window must be positive");
    }
  }

  allow(key: string, nowMs: number): boolean {
    const current = this.buckets.get(key);
    if (!current || nowMs - current.windowStartedAt >= this.windowMs) {
      this.buckets.set(key, { windowStartedAt: nowMs, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  clear(): void {
    this.buckets.clear();
  }
}

export interface GitHubWebhookAdmissionInput {
  readonly monitorId: JobId;
  readonly installationRef: string;
  readonly providerDeliveryId: string;
  readonly eventName: string;
  readonly signature: string;
  readonly contentType: string;
  readonly rawBody: Uint8Array;
  readonly rateKey: string;
}

export interface GitHubWebhookAdmissionResult {
  readonly outcome: "accepted" | "replayed";
  readonly receipt: GitHubWebhookReceiptRecord;
  readonly occurrence: BackgroundOccurrence;
}

export interface GitHubWebhookAdmissionDependencies {
  readonly state: GitHubIntegrationStatePort;
  readonly secrets: GitHubWebhookSecretSource;
  readonly payloads: ProtectedWebhookPayloadSink;
  readonly now: () => string;
  readonly nowMs?: () => number;
  readonly createOccurrence: (input: {
    readonly monitor: GitHubRepositoryMonitor;
    readonly providerDeliveryId: string;
    readonly eventName: string;
    readonly action: string | null;
    readonly payloadRef: string;
    readonly receivedAt: string;
  }) => BackgroundOccurrence;
  readonly rateLimiter?: GitHubWebhookRateLimiter;
  readonly maxBodyBytes?: number;
}

interface GitHubPayload {
  readonly action?: unknown;
  readonly installation?: { readonly id?: unknown };
  readonly repository?: { readonly id?: unknown };
  readonly pull_request?: { readonly merged?: unknown };
  readonly workflow_run?: { readonly conclusion?: unknown };
}

export class GitHubWebhookAdmissionService {
  private readonly dependencies: GitHubWebhookAdmissionDependencies;

  constructor(dependencies: GitHubWebhookAdmissionDependencies) {
    this.dependencies = dependencies;
  }

  async admit(input: GitHubWebhookAdmissionInput): Promise<GitHubWebhookAdmissionResult> {
    const body = new Uint8Array(input.rawBody);
    const maxBodyBytes = this.dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (body.byteLength > maxBodyBytes) {
      throw new GitHubWebhookError(
        "GITHUB_BODY_TOO_LARGE",
        `GitHub webhook body exceeds ${maxBodyBytes} bytes`,
        413,
      );
    }
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(input.contentType.trim())) {
      throw new GitHubWebhookError(
        "GITHUB_CONTENT_TYPE_REJECTED",
        "GitHub webhook content type must be application/json",
        400,
      );
    }
    const nowMs = this.dependencies.nowMs?.() ?? Date.now();
    if (!(this.dependencies.rateLimiter ?? defaultRateLimiter).allow(input.rateKey, nowMs)) {
      throw new GitHubWebhookError(
        "GITHUB_RATE_LIMITED",
        "GitHub webhook rate limit exceeded",
        429,
      );
    }

    const installation = await this.dependencies.state.readInstallation(input.installationRef);
    if (!installation) {
      throw new GitHubWebhookError(
        "GITHUB_INSTALLATION_REJECTED",
        "GitHub installation is not registered",
        404,
      );
    }
    if (installation.status !== "active") {
      throw new GitHubWebhookError(
        "GITHUB_CREDENTIAL_REVOKED",
        "GitHub installation credential is revoked",
        403,
      );
    }
    const secret = await this.dependencies.secrets.resolve(installation.secretRef).catch(() => {
      throw new GitHubWebhookError(
        "GITHUB_CREDENTIAL_REVOKED",
        "GitHub webhook secret could not be resolved",
        403,
      );
    });
    if (!verifySignature(body, input.signature, secret)) {
      throw new GitHubWebhookError(
        "GITHUB_SIGNATURE_REJECTED",
        "GitHub webhook signature rejected",
        401,
      );
    }

    const payload = parsePayload(body);
    const monitor = await this.dependencies.state.readMonitor(input.monitorId);
    if (
      !monitor ||
      monitor.installationRef !== input.installationRef ||
      monitor.status !== "active"
    ) {
      throw new GitHubWebhookError(
        "GITHUB_REPOSITORY_REJECTED",
        "GitHub repository monitor is not active for this installation",
        403,
      );
    }
    const providerInstallationId = stringValue(payload.installation?.id);
    if (!providerInstallationId || providerInstallationId !== installation.providerInstallationId) {
      throw new GitHubWebhookError(
        "GITHUB_INSTALLATION_REJECTED",
        "GitHub webhook installation does not match the registered App installation",
        403,
      );
    }
    const providerRepositoryId = stringValue(payload.repository?.id);
    if (!providerRepositoryId || providerRepositoryId !== monitor.repositoryRef) {
      throw new GitHubWebhookError(
        "GITHUB_REPOSITORY_REJECTED",
        "GitHub webhook repository is outside the monitor allowlist",
        403,
      );
    }
    const action = optionalString(payload.action);
    if (!isEnabledEvent(monitor, input.eventName, action, payload)) {
      throw new GitHubWebhookError(
        "GITHUB_EVENT_REJECTED",
        "GitHub event or action is disabled for this monitor",
        403,
      );
    }
    if (input.providerDeliveryId.length === 0 || input.providerDeliveryId.length > 256) {
      throw new GitHubWebhookError(
        "GITHUB_DELIVERY_SCOPE_REJECTED",
        "GitHub provider delivery ID is invalid",
        400,
      );
    }

    const existing = await this.dependencies.state.findReceipt(input.providerDeliveryId);
    if (existing) {
      if (
        existing.installationRef !== input.installationRef ||
        existing.repositoryRef !== monitor.repositoryRef ||
        existing.eventName !== input.eventName
      ) {
        throw new GitHubWebhookError(
          "GITHUB_DELIVERY_SCOPE_REJECTED",
          "GitHub delivery ID was replayed outside its original scope",
          409,
        );
      }
      if (!existing.occurrenceId) {
        throw new GitHubWebhookError(
          "GITHUB_ADMISSION_FAILED",
          "GitHub delivery exists without a normalized occurrence",
          500,
        );
      }
      const occurrence = await this.dependencies.state.readOccurrence(existing.occurrenceId);
      if (!occurrence) {
        throw new GitHubWebhookError(
          "GITHUB_ADMISSION_FAILED",
          "GitHub delivery points to a missing occurrence",
          500,
        );
      }
      return { outcome: "replayed", receipt: existing, occurrence };
    }

    const payloadRef = `payload:github:webhook:${createHash("sha256")
      .update(input.providerDeliveryId)
      .digest("hex")}`;
    await putProtectedPayload(this.dependencies.payloads, {
      ref: payloadRef,
      ownerId: monitor.ownerId,
      agentId: monitor.agentId,
      classification: "private",
      contentType: "application/json",
      plaintext: body,
      createdAt: this.dependencies.now(),
    });
    const occurrence = this.dependencies.createOccurrence({
      monitor,
      providerDeliveryId: input.providerDeliveryId,
      eventName: input.eventName,
      action,
      payloadRef,
      receivedAt: this.dependencies.now(),
    });
    const receipt: GitHubWebhookReceiptRecord = {
      id: `github-receipt-${createHash("sha256")
        .update(`${input.installationRef}:${input.providerDeliveryId}`)
        .digest("hex")
        .slice(0, 48)}` as GitHubWebhookReceiptRecord["id"],
      ownerId: monitor.ownerId,
      agentId: monitor.agentId,
      providerDeliveryId: input.providerDeliveryId,
      installationRef: input.installationRef,
      repositoryRef: monitor.repositoryRef,
      eventName: input.eventName,
      action,
      payloadRef,
      status: "received",
      occurrenceId: null,
      receivedAt: this.dependencies.now(),
    };
    const admitted = await this.dependencies.state.admitWebhook({ receipt, occurrence });
    return {
      outcome: admitted.replayed ? "replayed" : "accepted",
      receipt: admitted.receipt,
      occurrence: admitted.occurrence,
    };
  }
}

const defaultRateLimiter = new GitHubWebhookRateLimiter();

function verifySignature(body: Uint8Array, header: string, secret: Uint8Array | string): boolean {
  if (!/^sha256=[0-9a-f]{64}$/i.test(header.trim())) return false;
  const expected = createHmac("sha256", typeof secret === "string" ? Buffer.from(secret) : secret)
    .update(body)
    .digest();
  const received = Buffer.from(header.trim().slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function parsePayload(body: Uint8Array): GitHubPayload {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed as GitHubPayload;
  } catch {
    throw new GitHubWebhookError(
      "GITHUB_MALFORMED_PAYLOAD",
      "GitHub webhook JSON is malformed",
      400,
    );
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isEnabledEvent(
  monitor: GitHubRepositoryMonitor,
  eventName: string,
  action: string | null,
  payload: GitHubPayload,
): boolean {
  const keys = new Set(monitor.enabledEventRefs);
  const candidates = [`github:event:${eventName}`];
  if (action) candidates.push(`github:event:${eventName}:${action}`);
  if (
    eventName === "pull_request" &&
    action === "closed" &&
    payload.pull_request?.merged === true
  ) {
    candidates.push("github:event:pull_request:merged");
  }
  if (
    eventName === "workflow_run" &&
    action === "completed" &&
    payload.workflow_run?.conclusion === "failure"
  ) {
    candidates.push("github:event:workflow_run:completed:failure");
  }
  return candidates.some((candidate) => keys.has(candidate) || keys.has("github:event:all"));
}

async function putProtectedPayload(
  sink: ProtectedWebhookPayloadSink,
  input: Parameters<ProtectedWebhookPayloadSink["put"]>[0],
): Promise<void> {
  await sink.put(input);
}
