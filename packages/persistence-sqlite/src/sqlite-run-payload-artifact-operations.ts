import type {
  PayloadRecord,
  RunPayloadArtifact,
  RunPayloadArtifactCommitResult,
  RunPayloadArtifactPurpose,
} from "@himawari-agent/application";
import type { ProductAuthorityFence, RunId } from "@himawari-agent/domain";
import { createAuthorityLeaseId, createDeploymentId, createRunId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

interface ArtifactRow {
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: RunId;
  readonly purpose: RunPayloadArtifactPurpose;
  readonly operationKey: string;
  readonly payloadRef: string;
  readonly contentDigest: string;
  readonly contentType: string;
  readonly dataClassification: RunPayloadArtifact["dataClassification"];
  readonly createdAt: string;
}

interface AuthorityInput {
  readonly product: ProductAuthorityFence;
  readonly leaseId: string;
  readonly leaseFencingToken: number;
}

interface OperationInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: RunId;
  readonly purpose: RunPayloadArtifactPurpose;
  readonly operationKey: string;
  readonly authority: AuthorityInput;
  readonly now: string;
}

interface CommitInput extends OperationInput {
  readonly payload: PayloadRecord;
}

const RUN_PAYLOAD_ARTIFACT_PURPOSES: readonly RunPayloadArtifactPurpose[] = [
  "trace",
  "context",
  "final_answer",
  "worker_result",
];

const RUN_PAYLOAD_EXECUTION_STATUSES = [
  "accepted",
  "building_context",
  "running",
  "awaiting_approval",
  "reconciling_external_result",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty text`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function dateText(value: unknown, label: string): string {
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${label} must be an ISO time`);
  return result;
}

function purpose(value: unknown): RunPayloadArtifactPurpose {
  if (
    typeof value !== "string" ||
    !RUN_PAYLOAD_ARTIFACT_PURPOSES.some((candidate) => candidate === value)
  ) {
    throw new TypeError("purpose is not supported");
  }
  return value as RunPayloadArtifactPurpose;
}

function classification(value: unknown): RunPayloadArtifact["dataClassification"] {
  if (
    value !== "public" &&
    value !== "private" &&
    value !== "sensitive" &&
    value !== "restricted"
  ) {
    throw new TypeError("payload classification is not supported");
  }
  return value;
}

function payload(value: unknown): PayloadRecord {
  const input = record(value, "payload");
  const storage = input["storage"];
  if (
    storage !== undefined &&
    (!storage ||
      typeof storage !== "object" ||
      Array.isArray(storage) ||
      (storage as { readonly kind?: unknown }).kind !== "inline")
  ) {
    throw new TypeError("Run-owned Payload artifacts require inline protected Payloads");
  }
  const encryption = record(input["encryption"], "payload.encryption");
  const ciphertext = input["ciphertext"];
  if (!(ciphertext instanceof Uint8Array)) throw new TypeError("payload.ciphertext must be bytes");
  return {
    ref: text(input["ref"], "payload.ref"),
    dataClassification: classification(input["dataClassification"]),
    contentType: text(input["contentType"], "payload.contentType"),
    ciphertext: new Uint8Array(ciphertext),
    encryption: {
      algorithm: text(encryption["algorithm"], "payload.encryption.algorithm"),
      keyRef: text(encryption["keyRef"], "payload.encryption.keyRef"),
      ...(typeof encryption["kekVersion"] === "string"
        ? { kekVersion: encryption["kekVersion"] }
        : {}),
      ...(typeof encryption["dekVersion"] === "string"
        ? { dekVersion: encryption["dekVersion"] }
        : {}),
      ...(typeof encryption["nonce"] === "string" ? { nonce: encryption["nonce"] } : {}),
      ...(typeof encryption["authenticationTag"] === "string"
        ? { authenticationTag: encryption["authenticationTag"] }
        : {}),
      ...(typeof encryption["wrappedDek"] === "string"
        ? { wrappedDek: encryption["wrappedDek"] }
        : {}),
      ...(typeof encryption["wrapNonce"] === "string"
        ? { wrapNonce: encryption["wrapNonce"] }
        : {}),
      ...(typeof encryption["wrapAuthenticationTag"] === "string"
        ? { wrapAuthenticationTag: encryption["wrapAuthenticationTag"] }
        : {}),
      ...(typeof encryption["aadDigest"] === "string"
        ? { aadDigest: encryption["aadDigest"] }
        : {}),
      ...(typeof encryption["ciphertextDigest"] === "string"
        ? { ciphertextDigest: encryption["ciphertextDigest"] }
        : {}),
    },
    contentDigest: text(input["contentDigest"], "payload.contentDigest"),
    createdAt: dateText(input["createdAt"], "payload.createdAt"),
    ...(storage === undefined ? { storage: { kind: "inline" as const } } : {}),
  };
}

function artifactFromRow(row: ArtifactRow): RunPayloadArtifact {
  return Object.freeze({
    ownerId: row.ownerId as RunPayloadArtifact["ownerId"],
    agentId: row.agentId as RunPayloadArtifact["agentId"],
    runId: row.runId as RunPayloadArtifact["runId"],
    purpose: row.purpose,
    operationKey: row.operationKey,
    payloadRef: row.payloadRef,
    contentDigest: row.contentDigest,
    contentType: row.contentType,
    dataClassification: row.dataClassification,
    createdAt: row.createdAt,
  });
}

export class SqliteRunPayloadArtifactOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(
    operation: string,
    value: unknown,
  ): RunPayloadArtifact | RunPayloadArtifactCommitResult | undefined {
    let input: Record<string, unknown>;
    let parsed: OperationInput;
    try {
      input = record(value, "Run Payload artifact operation");
      parsed = this.operationInput(input);
    } catch (error) {
      return this.fail(
        "PORT_INVALID_OPERATION",
        error instanceof Error ? error.message : "Invalid Run Payload artifact operation",
      );
    }
    if (operation === "runPayloadArtifact.lookup") return this.lookup(parsed);
    if (operation === "runPayloadArtifact.commit") {
      let protectedPayload: PayloadRecord;
      try {
        protectedPayload = payload(input["payload"]);
      } catch (error) {
        return this.fail(
          "PORT_INVALID_OPERATION",
          error instanceof Error ? error.message : "Invalid protected Payload",
        );
      }
      return this.commit({ ...parsed, payload: protectedPayload });
    }
    return this.fail("PORT_INVALID_OPERATION", "Unknown Run Payload artifact operation");
  }

  private operationInput(input: Record<string, unknown>): OperationInput {
    const rawAuthority = record(input["authority"], "authority");
    const rawProduct = record(rawAuthority["product"], "authority.product");
    return {
      ownerId: text(input["ownerId"], "ownerId"),
      agentId: text(input["agentId"], "agentId"),
      runId: createRunId(text(input["runId"], "runId")),
      purpose: purpose(input["purpose"]),
      operationKey: text(input["operationKey"], "operationKey"),
      authority: {
        product: {
          deploymentId: createDeploymentId(
            text(rawProduct["deploymentId"], "authority.product.deploymentId"),
          ),
          authorityEpoch: safeInteger(
            rawProduct["authorityEpoch"],
            "authority.product.authorityEpoch",
          ),
          fencingToken: safeInteger(rawProduct["fencingToken"], "authority.product.fencingToken"),
        },
        leaseId: createAuthorityLeaseId(text(rawAuthority["leaseId"], "authority.leaseId")),
        leaseFencingToken: safeInteger(
          rawAuthority["leaseFencingToken"],
          "authority.leaseFencingToken",
        ),
      },
      now: dateText(input["now"], "now"),
    };
  }

  private lookup(input: OperationInput): RunPayloadArtifact | undefined {
    this.assertAuthority(input);
    this.assertRun(input, false);
    const row = this.readArtifact(input);
    if (!row) return undefined;
    this.assertArtifactPayload(input, row);
    return artifactFromRow(row);
  }

  private commit(input: CommitInput): RunPayloadArtifactCommitResult {
    const protectedPayload = input.payload;
    this.assertDiskHeadroom();
    return this.database
      .transaction(() => {
        this.assertAuthority(input);
        this.assertRun(input, false);
        const existing = this.readArtifact(input);
        if (existing) {
          this.assertArtifactPayload(input, existing);
          if (!this.sameIdentity(existing, protectedPayload)) {
            return this.fail(
              "PORT_CONFLICT",
              "Run Payload artifact operation identity conflicts with its existing receipt",
              { runId: input.runId, purpose: input.purpose, operationKey: input.operationKey },
            );
          }
          return {
            ref: existing.payloadRef,
            replayed: true,
            artifact: artifactFromRow(existing),
          };
        }

        this.assertRun(input, true);
        this.insertOrValidatePayload(input, protectedPayload);
        const artifact = Object.freeze({
          ownerId: input.ownerId as RunPayloadArtifact["ownerId"],
          agentId: input.agentId as RunPayloadArtifact["agentId"],
          runId: input.runId,
          purpose: input.purpose,
          operationKey: input.operationKey,
          payloadRef: protectedPayload.ref,
          contentDigest: protectedPayload.contentDigest,
          contentType: protectedPayload.contentType,
          dataClassification: protectedPayload.dataClassification,
          createdAt: protectedPayload.createdAt,
        });
        this.database
          .prepare(
            `INSERT INTO run_payload_artifacts (
              owner_id, agent_id, run_id, purpose, operation_key, payload_ref,
              content_digest, content_type, classification, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.ownerId,
            input.agentId,
            input.runId,
            input.purpose,
            input.operationKey,
            protectedPayload.ref,
            protectedPayload.contentDigest,
            protectedPayload.contentType,
            protectedPayload.dataClassification,
            protectedPayload.createdAt,
          );
        return { ref: protectedPayload.ref, replayed: false, artifact };
      })
      .immediate();
  }

  private assertAuthority(input: OperationInput): void {
    const row = this.database
      .prepare(
        `SELECT 1 FROM authority_leases lease
        JOIN deployments deployment ON deployment.id = lease.deployment_id
          AND deployment.owner_id = lease.owner_id AND deployment.agent_id = lease.agent_id
        WHERE lease.id = ? AND lease.owner_id = ? AND lease.agent_id = ?
          AND lease.released_at IS NULL AND lease.expires_at > ?
          AND lease.fencing_token = ? AND deployment.id = ?
          AND deployment.status = 'active'
          AND deployment.authority_epoch = ? AND deployment.fencing_token = ?
          AND lease.authority_epoch = deployment.authority_epoch
          AND lease.fencing_token = deployment.fencing_token`,
      )
      .get(
        input.authority.leaseId,
        input.ownerId,
        input.agentId,
        input.now,
        input.authority.leaseFencingToken,
        input.authority.product.deploymentId,
        input.authority.product.authorityEpoch,
        input.authority.product.fencingToken,
      );
    if (!row) {
      this.fail("PORT_NOT_AUTHORITATIVE", "Run Payload artifact authority is not current", {
        runId: input.runId,
        deploymentId: input.authority.product.deploymentId,
        leaseId: input.authority.leaseId,
      });
    }
  }

  private assertRun(input: OperationInput, forWrite: boolean): void {
    const row = this.database
      .prepare(
        `SELECT status FROM runs
        WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(input.runId, input.ownerId, input.agentId) as { readonly status: string } | undefined;
    if (!row) {
      this.fail("PORT_INVALID_OPERATION", "Run Payload artifact Run is outside the bound scope", {
        runId: input.runId,
      });
    }
    if (
      forWrite &&
      input.purpose !== "trace" &&
      !RUN_PAYLOAD_EXECUTION_STATUSES.some((status) => status === row.status)
    ) {
      this.fail(
        "PORT_INVALID_OPERATION",
        "Only terminal Trace artifacts may be written after a Run reaches a terminal status",
        { runId: input.runId, purpose: input.purpose, status: row.status },
      );
    }
  }

  private readArtifact(input: OperationInput): ArtifactRow | undefined {
    return this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, run_id AS runId,
          purpose, operation_key AS operationKey, payload_ref AS payloadRef,
          content_digest AS contentDigest, content_type AS contentType,
          classification AS dataClassification, created_at AS createdAt
        FROM run_payload_artifacts
        WHERE owner_id = ? AND agent_id = ? AND run_id = ?
          AND purpose = ? AND operation_key = ?`,
      )
      .get(input.ownerId, input.agentId, input.runId, input.purpose, input.operationKey) as
      | ArtifactRow
      | undefined;
  }

  private assertArtifactPayload(input: OperationInput, artifact: ArtifactRow): void {
    const row = this.database
      .prepare(
        `SELECT 1 FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?
          AND lifecycle_state = 'active'`,
      )
      .get(artifact.payloadRef, input.ownerId, input.agentId);
    if (!row) {
      this.fail("PORT_INVALID_OPERATION", "Run Payload artifact references a missing Payload", {
        runId: input.runId,
        payloadRef: artifact.payloadRef,
      });
    }
  }

  private sameIdentity(artifact: ArtifactRow, protectedPayload: PayloadRecord): boolean {
    return (
      artifact.contentDigest === protectedPayload.contentDigest &&
      artifact.contentType === protectedPayload.contentType &&
      artifact.dataClassification === protectedPayload.dataClassification
    );
  }

  private insertOrValidatePayload(input: OperationInput, protectedPayload: PayloadRecord): void {
    const existing = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, classification,
          content_digest AS contentDigest, content_type AS contentType,
          lifecycle_state AS lifecycleState
        FROM payloads WHERE ref = ?`,
      )
      .get(protectedPayload.ref) as
      | {
          readonly ownerId: string;
          readonly agentId: string;
          readonly classification: RunPayloadArtifact["dataClassification"];
          readonly contentDigest: string;
          readonly contentType: string | null;
          readonly lifecycleState: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.ownerId !== input.ownerId ||
        existing.agentId !== input.agentId ||
        existing.lifecycleState !== "active" ||
        !this.samePayloadIdentity(existing, protectedPayload)
      ) {
        this.fail("PORT_CONFLICT", "Payload reference conflicts with existing content", {
          payloadRef: protectedPayload.ref,
        });
      }
      return;
    }

    this.database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          ciphertext_path, content_digest, encryption_algorithm, key_ref,
          lifecycle_state, created_at, content_type, encryption_metadata_json
        ) VALUES (?, ?, ?, ?, 'sqlite_blob', ?, NULL, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        protectedPayload.ref,
        input.ownerId,
        input.agentId,
        protectedPayload.dataClassification,
        protectedPayload.ciphertext,
        protectedPayload.contentDigest,
        protectedPayload.encryption.algorithm,
        protectedPayload.encryption.keyRef,
        protectedPayload.createdAt,
        protectedPayload.contentType,
        JSON.stringify(protectedPayload.encryption),
      );
  }

  private samePayloadIdentity(
    existing: {
      readonly classification: RunPayloadArtifact["dataClassification"];
      readonly contentDigest: string;
      readonly contentType: string | null;
    },
    protectedPayload: PayloadRecord,
  ): boolean {
    return (
      existing.contentDigest === protectedPayload.contentDigest &&
      existing.contentType === protectedPayload.contentType &&
      existing.classification === protectedPayload.dataClassification
    );
  }
}
