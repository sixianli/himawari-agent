import {
  ContractValidationError,
  type InferSchema,
  type Schema,
  array,
  boundedString,
  booleanValue,
  enumeration,
  integer,
  literal,
  machineString,
  nullable,
  object,
  parseJson,
  timestamp,
} from "./validation.js";

export const GATEWAY_V2_SCHEMA_VERSION = "gateway.v2" as const;
export const GATEWAY_V2_MESSAGE_TYPES = [
  "thread.message.submit",
  "thread.checkpoint.request",
  "approval.respond",
  "task.set_state",
  "settings.update",
  "github.monitor.set_state",
  "memory.mutate",
  "session.revoke",
  "grant.revoke",
  "capability.review",
  "capability.install.approve",
  "capability.update.respond",
  "capability.disable",
  "capability.rollback",
  "host.file.prepare",
  "host.file.execute",
  "workspace.stage",
  "workspace.commit",
  "suggestion.respond",
  "reflection.configure",
  "improvement.review",
  "thread.list",
  "thread.timeline",
  "approval.list",
  "task.list",
  "task.detail",
  "inbox.list",
  "inbox.detail",
  "inbox.digest",
  "memory.search",
  "memory.detail",
  "trace.timeline",
  "trace.detail",
  "settings.read",
  "identity.sessions",
  "identity.session_detail",
  "health.status",
  "approval.detail",
  "capability.list",
  "capability.detail",
  "grant.list",
  "grant.detail",
  "host.directory.detail",
  "workspace.detail",
  "workspace.list",
  "suggestion.list",
  "suggestion.detail",
  "reflection.detail",
  "delegation.detail",
  "delegation.list",
  "improvement.list",
  "improvement.detail",
  "collection.snapshot",
  "health.snapshot",
  "approval.snapshot",
  "capability.snapshot",
  "grant.snapshot",
  "host.directory.snapshot",
  "workspace.snapshot",
  "suggestion.snapshot",
  "reflection.snapshot",
  "delegation.snapshot",
  "improvement.snapshot",
  "task.snapshot",
  "inbox.snapshot",
  "digest.snapshot",
  "memory.snapshot",
  "trace.snapshot",
  "settings.snapshot",
  "session.snapshot",
  "stream.event",
] as const;

export type GatewayV2MessageType = (typeof GATEWAY_V2_MESSAGE_TYPES)[number];

const classificationSchema = enumeration(["public", "private", "sensitive", "restricted"]);
const riskSchema = enumeration(["low", "medium", "high", "critical"]);
const actorSchema = object({
  actorType: enumeration(["owner", "client", "scheduler", "external_adapter", "system"]),
  actorId: machineString,
});
const scopeSchema = object({ ownerId: machineString, agentId: machineString });
const authoritySchema = object({
  deploymentId: machineString,
  authorityEpoch: integer(1),
  fencingToken: integer(1),
});

function envelope<const TKind extends string, const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(GATEWAY_V2_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: nullable(machineString),
    dataClassification: classificationSchema,
    risk: riskSchema,
    authorizationRef: nullable(machineString),
    scope: scopeSchema,
    authority: authoritySchema,
    actor: actorSchema,
  } as const;
}

function commandEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("command", type), idempotencyKey: machineString } as const;
}

export const submitThreadMessageCommandSchema = object({
  ...commandEnvelope("thread.message.submit"),
  payload: object({
    threadId: machineString,
    messageId: machineString,
    contentRef: machineString,
    clientCreatedAt: timestamp,
  }),
});

export const requestThreadCheckpointCommandSchema = object({
  ...commandEnvelope("thread.checkpoint.request"),
  payload: object({
    threadId: machineString,
    sourceWatermark: integer(1),
    policyVersion: machineString,
  }),
});

export const respondApprovalV2CommandSchema = object({
  ...commandEnvelope("approval.respond"),
  payload: object({
    approvalRequestId: machineString,
    expectedRevision: integer(1),
    decision: enumeration(["approved", "denied"]),
    semanticSnapshotHash: machineString,
    editedPayloadRef: nullable(machineString),
    recentAuthenticationRef: nullable(machineString),
  }),
});

export const setTaskStateCommandSchema = object({
  ...commandEnvelope("task.set_state"),
  payload: object({
    jobId: machineString,
    expectedRevision: integer(1),
    action: enumeration(["pause", "resume", "revoke"]),
    reasonCode: machineString,
  }),
});

export const updateSettingsCommandSchema = object({
  ...commandEnvelope("settings.update"),
  payload: object({
    expectedRevision: integer(1),
    section: enumeration(["models", "budgets", "attention", "digest", "integration"]),
    settingRef: machineString,
    valueRef: machineString,
  }),
});

const githubRepositoryRefSchema: Schema<string> = {
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      input.length > 256 ||
      [...input].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new ContractValidationError(
        path,
        "expected a 1-256 character repository reference without control characters",
      );
    }
    return input;
  },
};

const githubDisclosureSchema = object({
  confirmationRef: machineString,
  primaryModelRef: machineString,
  repositoryRef: githubRepositoryRefSchema,
  disclosedDataClassifications: array(classificationSchema),
  machineSecretsExcluded: literal(true),
});

const githubMonitorStatePayloadSchema = object({
  monitorId: machineString,
  action: enumeration(["enable", "pause", "revoke"]),
  expectedRevision: integer(0),
  historyPolicy: nullable(enumeration(["retain", "delete"])),
  disclosure: nullable(githubDisclosureSchema),
});

export const setGitHubMonitorStateCommandSchema = object({
  ...commandEnvelope("github.monitor.set_state"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = githubMonitorStatePayloadSchema.parse(input, path);
      if (payload.action === "enable" && payload.disclosure === null) {
        throw new ContractValidationError(`${path}.disclosure`, "is required when enabling");
      }
      if (payload.action !== "enable" && payload.disclosure !== null) {
        throw new ContractValidationError(`${path}.disclosure`, "is only allowed when enabling");
      }
      if (payload.action === "revoke" && payload.historyPolicy === null) {
        throw new ContractValidationError(`${path}.historyPolicy`, "is required when revoking");
      }
      if (payload.action !== "revoke" && payload.historyPolicy !== null) {
        throw new ContractValidationError(`${path}.historyPolicy`, "is only allowed when revoking");
      }
      if (
        payload.action === "enable" &&
        payload.disclosure !== null &&
        payload.disclosure.disclosedDataClassifications.length === 0
      ) {
        throw new ContractValidationError(
          `${path}.disclosure.disclosedDataClassifications`,
          "must contain at least one classification",
        );
      }
      return payload;
    },
  },
});

const memoryMutationPayloadSchema = object({
  memoryId: machineString,
  action: enumeration(["correct", "archive", "delete"]),
  expectedRevision: integer(0),
  contentRef: nullable(machineString),
});

export const mutateMemoryCommandSchema = object({
  ...commandEnvelope("memory.mutate"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = memoryMutationPayloadSchema.parse(input, path);
      if (
        (payload.action === "correct" && payload.contentRef === null) ||
        (payload.action !== "correct" && payload.contentRef !== null)
      ) {
        throw new ContractValidationError(
          `${path}.contentRef`,
          "must be present only for a correction",
        );
      }
      return payload;
    },
  },
});

export const revokeSessionCommandSchema = object({
  ...commandEnvelope("session.revoke"),
  payload: object({
    sessionId: machineString,
    deviceId: machineString,
    expectedRevision: integer(1),
    recentAuthenticationRef: machineString,
    reasonCode: machineString,
  }),
});

export const revokeGrantCommandSchema = object({
  ...commandEnvelope("grant.revoke"),
  payload: object({
    grantId: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
  }),
});

export const reviewCapabilityCommandSchema = object({
  ...commandEnvelope("capability.review"),
  payload: object({ capabilityRef: machineString, expectedRevision: integer(1) }),
});

export const approveCapabilityInstallationCommandSchema = object({
  ...commandEnvelope("capability.install.approve"),
  payload: object({
    capabilityRef: machineString,
    expectedRevision: integer(1),
    approvalRef: machineString,
  }),
});

const capabilityUpdateResponsePayloadSchema = object({
  capabilityRef: machineString,
  expectedRevision: integer(1),
  decision: enumeration(["approved", "denied"]),
  approvalRef: nullable(machineString),
});

export const respondCapabilityUpdateCommandSchema = object({
  ...commandEnvelope("capability.update.respond"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = capabilityUpdateResponsePayloadSchema.parse(input, path);
      if ((payload.decision === "approved") !== (payload.approvalRef !== null)) {
        throw new ContractValidationError(
          `${path}.approvalRef`,
          "must be present exactly when the update is approved",
        );
      }
      return payload;
    },
  },
});

export const disableCapabilityCommandSchema = object({
  ...commandEnvelope("capability.disable"),
  payload: object({
    capabilityRef: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
  }),
});

export const rollbackCapabilityCommandSchema = object({
  ...commandEnvelope("capability.rollback"),
  payload: object({
    capabilityRef: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
  }),
});

const hostFileOperationSchema = enumeration([
  "read",
  "create",
  "update",
  "move",
  "trash",
  "restore",
  "permanent_delete",
]);

export const prepareHostFileCommandSchema = object({
  ...commandEnvelope("host.file.prepare"),
  payload: object({
    grantId: machineString,
    expectedGrantRevision: integer(1),
    operation: hostFileOperationSchema,
    relativePathRef: machineString,
    destinationPathRef: nullable(machineString),
    candidatePayloadRef: nullable(machineString),
    redactedDiffRef: nullable(machineString),
    irreversibleScopeRef: nullable(machineString),
    expiresAt: timestamp,
  }),
});

export const executeHostFileCommandSchema = object({
  ...commandEnvelope("host.file.execute"),
  payload: object({
    operationPlanRef: machineString,
    expectedRevision: integer(1),
    operation: hostFileOperationSchema,
    canonicalHash: machineString,
    recentAuthenticationRef: nullable(machineString),
  }),
});

export const stageWorkspaceCommandSchema = object({
  ...commandEnvelope("workspace.stage"),
  payload: object({
    workspaceSnapshotId: machineString,
    expectedTaskChangeSetRevision: integer(1),
    taskPathRefs: array(machineString),
    validationResultRefs: array(machineString),
    commitMessageRef: machineString,
    expiresAt: timestamp,
  }),
});

export const commitWorkspaceCommandSchema = object({
  ...commandEnvelope("workspace.commit"),
  payload: object({
    commitPreviewId: machineString,
    expectedRevision: integer(1),
    semanticSnapshotHash: machineString,
    recentAuthenticationRef: machineString,
  }),
});

export const respondSuggestionCommandSchema = object({
  ...commandEnvelope("suggestion.respond"),
  payload: object({
    suggestionId: machineString,
    expectedRevision: integer(1),
    decision: enumeration(["approve", "reject"]),
  }),
});

export const configureReflectionCommandSchema = object({
  ...commandEnvelope("reflection.configure"),
  payload: object({
    expectedRevision: integer(0),
    schedule: boundedString(256),
    timezone: boundedString(128),
    dailySuggestionQuota: integer(1, 20),
    maximumContextItems: integer(1, 1000),
    maximumCostMicros: integer(0),
    timeoutMs: integer(1),
    maximumCandidates: integer(1, 20),
    enabled: booleanValue,
  }),
});

export const reviewImprovementCommandSchema = object({
  ...commandEnvelope("improvement.review"),
  payload: object({
    candidateId: machineString,
    expectedRevision: integer(1),
    decision: enumeration(["reject", "request_revision"]),
    reviewEvidenceRef: machineString,
  }),
});

const pagePayload = {
  afterCursor: nullable(machineString),
  limit: integer(1, 500),
} as const;

export const listThreadsQuerySchema = object({
  ...envelope("query", "thread.list"),
  payload: object(pagePayload),
});

export const threadTimelineQuerySchema = object({
  ...envelope("query", "thread.timeline"),
  payload: object({ threadId: machineString, afterSequence: integer(0), limit: integer(1, 1000) }),
});

export const listApprovalsQuerySchema = object({
  ...envelope("query", "approval.list"),
  payload: object({
    status: nullable(enumeration(["pending", "approved", "denied", "expired"])),
    ...pagePayload,
  }),
});

export const listTasksQuerySchema = object({
  ...envelope("query", "task.list"),
  payload: object({
    status: nullable(enumeration(["active", "paused", "revoked"])),
    ...pagePayload,
  }),
});

export const taskDetailQuerySchema = object({
  ...envelope("query", "task.detail"),
  payload: object({ jobId: machineString }),
});

export const listInboxQuerySchema = object({
  ...envelope("query", "inbox.list"),
  payload: object({ unreadOnly: booleanValue, ...pagePayload }),
});

export const inboxDetailQuerySchema = object({
  ...envelope("query", "inbox.detail"),
  payload: object({ inboxItemId: machineString }),
});

export const inboxDigestQuerySchema = object({
  ...envelope("query", "inbox.digest"),
  payload: object({ digestId: nullable(machineString) }),
});

export const searchMemoryQuerySchema = object({
  ...envelope("query", "memory.search"),
  payload: object({
    queryRef: machineString,
    status: nullable(enumeration(["active", "archived", "trashed"])),
    limit: integer(1, 100),
  }),
});

export const memoryDetailQuerySchema = object({
  ...envelope("query", "memory.detail"),
  payload: object({ memoryId: machineString }),
});

export const traceTimelineV2QuerySchema = object({
  ...envelope("query", "trace.timeline"),
  payload: object({
    threadId: nullable(machineString),
    runId: nullable(machineString),
    afterSequence: integer(0),
    limit: integer(1, 1000),
  }),
});

export const traceDetailQuerySchema = object({
  ...envelope("query", "trace.detail"),
  payload: object({ traceEventId: machineString }),
});

export const settingsReadQuerySchema = object({
  ...envelope("query", "settings.read"),
  payload: object({ includeIntegrations: booleanValue }),
});

export const identitySessionsQuerySchema = object({
  ...envelope("query", "identity.sessions"),
  payload: object({ includeRevoked: booleanValue, ...pagePayload }),
});

export const identitySessionDetailQuerySchema = object({
  ...envelope("query", "identity.session_detail"),
  payload: object({ sessionId: machineString }),
});

export const healthStatusQuerySchema = object({
  ...envelope("query", "health.status"),
  payload: object({ includeDependencies: booleanValue }),
});

export const approvalDetailQuerySchema = object({
  ...envelope("query", "approval.detail"),
  payload: object({ approvalRequestId: machineString }),
});

export const capabilityListQuerySchema = object({
  ...envelope("query", "capability.list"),
  payload: object({
    lifecycle: nullable(
      enumeration([
        "discovered",
        "review_required",
        "installation_proposed",
        "installation_approved",
        "active",
        "update_proposed",
        "update_approved",
        "disabled",
        "revoked",
        "uninstalled",
      ]),
    ),
    ...pagePayload,
  }),
});

export const capabilityDetailQuerySchema = object({
  ...envelope("query", "capability.detail"),
  payload: object({ capabilityRef: machineString }),
});

export const grantListQuerySchema = object({
  ...envelope("query", "grant.list"),
  payload: object({ includeRevoked: booleanValue, ...pagePayload }),
});

export const grantDetailQuerySchema = object({
  ...envelope("query", "grant.detail"),
  payload: object({ grantId: machineString }),
});

export const hostDirectoryDetailQuerySchema = object({
  ...envelope("query", "host.directory.detail"),
  payload: object({ grantId: machineString }),
});

export const workspaceDetailQuerySchema = object({
  ...envelope("query", "workspace.detail"),
  payload: object({ workspaceId: machineString }),
});

export const workspaceListQuerySchema = object({
  ...envelope("query", "workspace.list"),
  payload: object({ ...pagePayload }),
});

export const suggestionListQuerySchema = object({
  ...envelope("query", "suggestion.list"),
  payload: object({
    status: nullable(
      enumeration(["candidate", "delivered", "approved", "rejected", "expired", "superseded"]),
    ),
    ...pagePayload,
  }),
});

export const suggestionDetailQuerySchema = object({
  ...envelope("query", "suggestion.detail"),
  payload: object({ suggestionId: machineString }),
});

export const reflectionDetailQuerySchema = object({
  ...envelope("query", "reflection.detail"),
  payload: object({ includeCheckpoints: booleanValue }),
});

export const delegationDetailQuerySchema = object({
  ...envelope("query", "delegation.detail"),
  payload: object({ delegationId: machineString }),
});

export const delegationListQuerySchema = object({
  ...envelope("query", "delegation.list"),
  payload: object({
    status: nullable(
      enumeration(["created", "running", "validating", "completed", "failed", "cancelled"]),
    ),
    ...pagePayload,
  }),
});

export const improvementListQuerySchema = object({
  ...envelope("query", "improvement.list"),
  payload: object({
    status: nullable(
      enumeration([
        "proposed",
        "patching",
        "validating",
        "rejected_by_validation",
        "security_failure",
        "review_required",
        "rejected",
        "revision_requested",
      ]),
    ),
    ...pagePayload,
  }),
});

export const improvementDetailQuerySchema = object({
  ...envelope("query", "improvement.detail"),
  payload: object({ candidateId: machineString }),
});

export const collectionSnapshotSchema = object({
  ...envelope("snapshot", "collection.snapshot"),
  payload: object({
    category: enumeration([
      "threads",
      "messages",
      "approvals",
      "tasks",
      "inbox",
      "memories",
      "trace",
      "sessions",
      "devices",
      "capabilities",
      "grants",
      "workspaces",
      "suggestions",
      "improvements",
      "delegations",
    ]),
    itemRefs: array(machineString),
    nextCursor: nullable(machineString),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

const frequencySnapshotSchema = object({
  count: integer(1),
  intervalMs: nullable(integer(1)),
});

export const approvalSnapshotSchema = object({
  ...envelope("snapshot", "approval.snapshot"),
  payload: object({
    approvalRequestId: machineString,
    revision: integer(1),
    status: enumeration(["pending", "approved", "denied", "expired"]),
    deliveryState: enumeration(["deliverable", "queued_no_ui"]),
    semanticSnapshotHash: machineString,
    finalRisk: riskSchema,
    recentAuthenticationRequired: booleanValue,
    recentAuthenticationRef: nullable(machineString),
    requestedAt: timestamp,
    expiresAt: timestamp,
    decidedAt: nullable(timestamp),
    grantId: nullable(machineString),
    intent: object({
      intentId: machineString,
      threadId: machineString,
      runId: machineString,
      actionKind: enumeration([
        "READ",
        "CREATE_OR_UPDATE",
        "DELETE",
        "COMMUNICATE",
        "PURCHASE_OR_FUNDS",
        "CREDENTIAL_OR_ACCESS",
        "PRODUCTION_OR_RECOVERY",
        "PUBLICATION",
        "LEGAL_COMMITMENT",
        "PHYSICAL_SAFETY",
        "INSTALL_OR_EXECUTE_CODE",
      ]),
      capabilityRef: machineString,
      capabilityVersion: machineString,
      operation: machineString,
      targetRefs: array(machineString),
      resourceRefs: array(boundedString()),
      dataClassification: classificationSchema,
      disclosure: enumeration(["none", "same_owner", "named_recipients", "public"]),
      recipientRefs: array(boundedString(512)),
      sideEffect: enumeration(["none", "reversible", "irreversible"]),
      estimatedCostMicros: integer(0),
      frequency: frequencySnapshotSchema,
      credentialOrAccessChange: booleanValue,
      reversible: booleanValue,
      idempotencyKey: machineString,
      deterministicFactCodes: array(machineString),
      modelReasonCode: machineString,
      requestedAt: timestamp,
      expiresAt: timestamp,
    }),
    trueResultRef: nullable(machineString),
    generatedAt: timestamp,
  }),
});

const runtimeQualificationSnapshotSchema = object({
  platform: enumeration(["darwin", "linux", "other"]),
  runtimeIdentity: boundedString(512),
  productionSuitable: booleanValue,
  reasonCodes: array(machineString),
  checkedAt: timestamp,
});

const updateAssessmentSnapshotSchema = object({
  fromVersion: machineString,
  toVersion: machineString,
  disposition: enumeration(["automatic", "approval_required"]),
  risk: riskSchema,
  sourceIdentityChanged: booleanValue,
  integrityChanged: booleanValue,
  semanticMajorChanged: booleanValue,
  runtimeKindChanged: booleanValue,
  executableIdentityChanged: booleanValue,
  executableCodeChanged: booleanValue,
  expansions: array(boundedString(512)),
  contractions: array(boundedString(512)),
  compatibilityPreserved: booleanValue,
  reasonCodes: array(machineString),
});

export const capabilitySnapshotSchema = object({
  ...envelope("snapshot", "capability.snapshot"),
  payload: object({
    capabilityRef: machineString,
    revision: integer(1),
    lifecycle: enumeration([
      "discovered",
      "review_required",
      "installation_proposed",
      "installation_approved",
      "active",
      "update_proposed",
      "update_approved",
      "disabled",
      "revoked",
      "uninstalled",
    ]),
    displayName: boundedString(512),
    sourceType: enumeration([
      "builtin",
      "tool",
      "skill",
      "package",
      "mcp",
      "program",
      "remote_api",
      "adapter",
    ]),
    sourceLocator: boundedString(),
    sourceIdentity: boundedString(512),
    version: machineString,
    integrity: machineString,
    signatureStatus: enumeration(["verified", "not_applicable", "invalid", "unknown"]),
    signerRef: nullable(machineString),
    operations: array(machineString),
    permissionRefs: array(machineString),
    dataClassifications: array(classificationSchema),
    networkScopes: array(boundedString(512)),
    filesystemScopes: array(boundedString(2048)),
    secretRefs: array(machineString),
    isolation: enumeration(["trusted_process", "worker", "sandbox", "remote"]),
    currency: boundedString(16),
    maxMicrosPerInvocation: integer(0),
    healthStatus: enumeration(["healthy", "degraded", "unhealthy", "unknown"]),
    healthCheckedAt: nullable(timestamp),
    reviewedBy: nullable(machineString),
    reviewedAt: nullable(timestamp),
    approvalRefs: array(machineString),
    dependencyTaskRefs: array(machineString),
    runtimeQualification: nullable(runtimeQualificationSnapshotSchema),
    pendingVersion: nullable(machineString),
    updateAssessment: nullable(updateAssessmentSnapshotSchema),
    rollbackVersion: nullable(machineString),
    rollbackAvailable: booleanValue,
    lastTransition: nullable(
      object({
        fromVersion: machineString,
        toVersion: machineString,
        outcome: enumeration(["activated", "rolled_back", "rejected"]),
        occurredAt: timestamp,
        externalEffectsRolledBack: literal(false),
        productStateRolledBack: literal(false),
      }),
    ),
    generatedAt: timestamp,
  }),
});

export const grantSnapshotSchema = object({
  ...envelope("snapshot", "grant.snapshot"),
  payload: object({
    grantId: machineString,
    revision: integer(1),
    kind: enumeration(["one_time", "long_term"]),
    status: enumeration(["active", "exhausted", "expired", "revoked"]),
    capabilityRef: machineString,
    capabilityVersion: machineString,
    operations: array(machineString),
    exactResourceRef: nullable(boundedString()),
    resourceIdentities: array(boundedString()),
    resourcePrefixes: array(boundedString()),
    maxDataClassification: classificationSchema,
    disclosure: enumeration(["none", "same_owner", "named_recipients", "public"]),
    sideEffects: array(enumeration(["none", "reversible", "irreversible"])),
    recipientRefs: array(boundedString(512)),
    maxCostMicrosPerUse: integer(0),
    maxFrequency: frequencySnapshotSchema,
    validFrom: timestamp,
    expiresAt: timestamp,
    uses: integer(0),
    maxUses: integer(1),
    spentCostMicros: integer(0),
    maxTotalCostMicros: integer(0),
    sourceApprovalRequestId: machineString,
    revokedAt: nullable(timestamp),
    revocationReasonCode: nullable(machineString),
    affectedTaskRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const hostDirectorySnapshotSchema = object({
  ...envelope("snapshot", "host.directory.snapshot"),
  payload: object({
    grantId: machineString,
    revision: integer(1),
    hostId: machineString,
    displayPath: boundedString(4096),
    operations: array(hostFileOperationSchema),
    pathPolicy: literal("same_filesystem_no_links"),
    mountPolicy: literal("fixed_device"),
    disclosure: enumeration(["none", "model", "worker", "external_approved"]),
    expiresAt: timestamp,
    revokedAt: nullable(timestamp),
    preparedOperationRefs: array(machineString),
    trashRecordRefs: array(machineString),
    recoveryRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const workspaceSnapshotV2Schema = object({
  ...envelope("snapshot", "workspace.snapshot"),
  payload: object({
    workspaceId: machineString,
    snapshotId: machineString,
    revision: integer(1),
    hostId: machineString,
    repositoryKind: enumeration(["git", "non_git"]),
    branch: nullable(boundedString(512)),
    head: nullable(machineString),
    upstreamObservation: nullable(boundedString(1024)),
    detached: booleanValue,
    unborn: booleanValue,
    taskChangeSetRevision: integer(1),
    ownerPathRefs: array(machineString),
    taskPathRefs: array(machineString),
    concurrentPathRefs: array(machineString),
    commandProfileRefs: array(machineString),
    commandObservationRefs: array(machineString),
    commitPreviewRef: nullable(machineString),
    recoveryRefs: array(machineString),
    directoryGrantRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const suggestionSnapshotSchema = object({
  ...envelope("snapshot", "suggestion.snapshot"),
  payload: object({
    suggestionId: machineString,
    revision: integer(1),
    status: enumeration([
      "candidate",
      "delivered",
      "approved",
      "rejected",
      "expired",
      "superseded",
    ]),
    kind: machineString,
    titleRef: machineString,
    bodyRef: machineString,
    evidenceRefs: array(machineString),
    sourceWatermark: machineString,
    goalRef: nullable(machineString),
    commitmentRef: nullable(machineString),
    confidencePermille: integer(0, 1000),
    noveltyPermille: integer(0, 1000),
    semanticKey: machineString,
    estimatedCapabilityRefs: array(machineString),
    estimatedDataClassifications: array(classificationSchema),
    estimatedCostMicros: integer(0),
    deliveryRef: nullable(machineString),
    taskRef: nullable(machineString),
    createdAt: timestamp,
    expiresAt: timestamp,
    generatedAt: timestamp,
  }),
});

export const reflectionSnapshotSchema = object({
  ...envelope("snapshot", "reflection.snapshot"),
  payload: object({
    revision: integer(1),
    schedule: boundedString(256),
    timezone: boundedString(128),
    dailySuggestionQuota: integer(1, 20),
    maximumContextItems: integer(1),
    maximumCostMicros: integer(0),
    timeoutMs: integer(1),
    maximumCandidates: integer(1, 20),
    enabled: booleanValue,
    latestInputWatermark: nullable(machineString),
    latestOutcome: nullable(
      enumeration(["running", "no_change", "candidates", "missed", "failed"]),
    ),
    latestErrorCode: nullable(machineString),
    generatedAt: timestamp,
  }),
});

export const delegationSnapshotSchema = object({
  ...envelope("snapshot", "delegation.snapshot"),
  payload: object({
    delegationId: machineString,
    revision: integer(1),
    parentRunId: machineString,
    workerRunId: machineString,
    traceRef: machineString,
    subtaskRef: machineString,
    outputSchemaRef: machineString,
    contextRefs: array(machineString),
    capabilityHandleRefs: array(machineString),
    allowedModelRefs: array(machineString),
    dataClassification: classificationSchema,
    maximumDurationMs: integer(1),
    maximumCostMicros: integer(0),
    maximumProgressEvents: integer(1),
    status: enumeration(["created", "running", "validating", "completed", "failed", "cancelled"]),
    resultRef: nullable(machineString),
    failureReasonCode: nullable(machineString),
    createdAt: timestamp,
    updatedAt: timestamp,
    generatedAt: timestamp,
  }),
});

export const improvementSnapshotSchema = object({
  ...envelope("snapshot", "improvement.snapshot"),
  payload: object({
    candidateId: machineString,
    revision: integer(1),
    baseRevision: machineString,
    baseDigest: machineString,
    observableProblemRef: machineString,
    goalRef: machineString,
    invariantRefs: array(machineString),
    allowedPathRefs: array(machineString),
    patchRef: nullable(machineString),
    patchDigest: nullable(machineString),
    validationRefs: array(machineString),
    comparisonRef: nullable(machineString),
    artifactRef: nullable(machineString),
    artifactDigest: nullable(machineString),
    risk: riskSchema,
    protectedRootFacts: array(machineString),
    status: enumeration([
      "proposed",
      "patching",
      "validating",
      "rejected_by_validation",
      "security_failure",
      "review_required",
      "rejected",
      "revision_requested",
      "expired",
    ]),
    reviewRequired: literal(true),
    expiresAt: timestamp,
    generatedAt: timestamp,
  }),
});

const attentionLevelSchema = enumeration(["SILENT", "INBOX", "DIGEST", "NOTIFY", "INTERRUPT"]);

export const taskSnapshotSchema = object({
  ...envelope("snapshot", "task.snapshot"),
  payload: object({
    jobId: machineString,
    revision: integer(1),
    status: enumeration(["active", "paused", "revoked"]),
    triggerType: machineString,
    timezone: boundedString(128),
    nextRunAt: nullable(timestamp),
    occurrenceRef: nullable(machineString),
    occurrenceStatus: nullable(
      enumeration([
        "queued",
        "running",
        "budget_blocked",
        "capacity_blocked",
        "retry_wait",
        "completed",
        "failed",
        "cancelled",
        "missed",
      ]),
    ),
    runRef: nullable(machineString),
    resultRef: nullable(machineString),
    blockedReasonCode: nullable(machineString),
    maxCostMicros: integer(0),
    spentCostMicros: integer(0),
    requestedAttention: attentionLevelSchema,
    safetyFloor: attentionLevelSchema,
    effectiveAttention: attentionLevelSchema,
    deliveryRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const inboxSnapshotSchema = object({
  ...envelope("snapshot", "inbox.snapshot"),
  payload: object({
    inboxItemId: machineString,
    revision: integer(1),
    unread: booleanValue,
    priority: integer(0, 100),
    attentionLevel: attentionLevelSchema,
    resultRef: machineString,
    sourceRefs: array(machineString),
    duplicateKey: machineString,
    createdAt: timestamp,
    generatedAt: timestamp,
  }),
});

export const digestSnapshotSchema = object({
  ...envelope("snapshot", "digest.snapshot"),
  payload: object({
    digestId: machineString,
    windowStart: timestamp,
    windowEnd: timestamp,
    itemRefs: array(machineString),
    sourceResultRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const memorySnapshotSchema = object({
  ...envelope("snapshot", "memory.snapshot"),
  payload: object({
    memoryId: machineString,
    revision: integer(1),
    status: enumeration(["active", "archived", "trashed", "deletion_pending", "deleted_verified"]),
    contentRef: nullable(machineString),
    dataClassification: classificationSchema,
    sourceThreadId: nullable(machineString),
    sourceRefs: array(machineString),
    inference: booleanValue,
    confidencePermille: integer(0, 1000),
    policyVersion: machineString,
    sensitiveApprovalRef: nullable(machineString),
    providerProjectionStatus: enumeration([
      "not_required",
      "pending",
      "completed",
      "retry_wait",
      "failed_terminal",
      "deleted",
    ]),
    lastUsedAt: nullable(timestamp),
    updatedAt: timestamp,
    generatedAt: timestamp,
  }),
});

export const traceSnapshotSchema = object({
  ...envelope("snapshot", "trace.snapshot"),
  payload: object({
    traceEventId: machineString,
    sequence: integer(1),
    eventType: machineString,
    actorRef: machineString,
    parentEventRef: nullable(machineString),
    causationRef: nullable(machineString),
    threadRef: nullable(machineString),
    runRef: machineString,
    modelRef: nullable(machineString),
    providerRef: nullable(machineString),
    authorizationRef: nullable(machineString),
    capabilityRef: nullable(machineString),
    costMicros: integer(0),
    retryAttempt: integer(0),
    resultRef: nullable(machineString),
    payloadRef: nullable(machineString),
    occurredAt: timestamp,
    generatedAt: timestamp,
  }),
});

const integrationHealthSchema = object({
  integrationRef: machineString,
  status: enumeration(["healthy", "degraded", "blocked_credentials", "not_configured"]),
  secretRefs: array(machineString),
  reasonCode: nullable(machineString),
});

export const settingsSnapshotSchema = object({
  ...envelope("snapshot", "settings.snapshot"),
  payload: object({
    revision: integer(1),
    primaryModelRef: nullable(machineString),
    fallbackModelRef: nullable(machineString),
    globalBudgetMicros: integer(0),
    spentBudgetMicros: integer(0),
    defaultAttention: attentionLevelSchema,
    digestTimezone: boundedString(128),
    digestScheduleRef: nullable(machineString),
    integrations: array(integrationHealthSchema),
    generatedAt: timestamp,
  }),
});

export const sessionSnapshotSchema = object({
  ...envelope("snapshot", "session.snapshot"),
  payload: object({
    sessionId: machineString,
    sessionRevision: integer(1),
    status: enumeration(["active", "revoked"]),
    deviceId: machineString,
    deviceLabel: boundedString(512),
    deviceStatus: enumeration(["active", "revoked"]),
    authenticationRef: machineString,
    firstAuthenticatedAt: timestamp,
    lastActiveAt: timestamp,
    recentAuthenticatedAt: timestamp,
    revokedAt: nullable(timestamp),
    generatedAt: timestamp,
  }),
});

export const healthSnapshotV2Schema = object({
  ...envelope("snapshot", "health.snapshot"),
  payload: object({
    deploymentId: machineString,
    activeHost: machineString,
    authorityEpoch: integer(1),
    live: booleanValue,
    ready: booleanValue,
    status: enumeration(["healthy", "degraded", "not_ready", "not_live"]),
    componentRefs: array(machineString),
    components: array(
      object({
        componentRef: machineString,
        status: enumeration(["healthy", "degraded", "blocked", "unavailable"]),
        reasonCode: nullable(machineString),
      }),
    ),
    operationCheckpoints: array(
      object({
        operationRef: machineString,
        kind: enumeration(["deletion", "migration", "upgrade", "backup", "restore"]),
        phase: machineString,
        revision: integer(1),
        status: enumeration(["pending", "running", "blocked", "completed", "failed"]),
        readbackRef: nullable(machineString),
      }),
    ),
    generatedAt: timestamp,
  }),
});

export const streamEventV2Schema = object({
  ...envelope("event", "stream.event"),
  payload: object({
    cursor: machineString,
    retentionStartCursor: machineString,
    eventId: machineString,
    scopeKind: enumeration(["agent", "thread", "run", "job", "inbox", "memory", "identity"]),
    scopeId: machineString,
    sequence: integer(1),
    occurredAt: timestamp,
    eventType: machineString,
    payloadRef: nullable(machineString),
  }),
});

const schemasByType = {
  "thread.message.submit": submitThreadMessageCommandSchema,
  "thread.checkpoint.request": requestThreadCheckpointCommandSchema,
  "approval.respond": respondApprovalV2CommandSchema,
  "task.set_state": setTaskStateCommandSchema,
  "settings.update": updateSettingsCommandSchema,
  "github.monitor.set_state": setGitHubMonitorStateCommandSchema,
  "memory.mutate": mutateMemoryCommandSchema,
  "session.revoke": revokeSessionCommandSchema,
  "grant.revoke": revokeGrantCommandSchema,
  "capability.review": reviewCapabilityCommandSchema,
  "capability.install.approve": approveCapabilityInstallationCommandSchema,
  "capability.update.respond": respondCapabilityUpdateCommandSchema,
  "capability.disable": disableCapabilityCommandSchema,
  "capability.rollback": rollbackCapabilityCommandSchema,
  "host.file.prepare": prepareHostFileCommandSchema,
  "host.file.execute": executeHostFileCommandSchema,
  "workspace.stage": stageWorkspaceCommandSchema,
  "workspace.commit": commitWorkspaceCommandSchema,
  "suggestion.respond": respondSuggestionCommandSchema,
  "reflection.configure": configureReflectionCommandSchema,
  "improvement.review": reviewImprovementCommandSchema,
  "thread.list": listThreadsQuerySchema,
  "thread.timeline": threadTimelineQuerySchema,
  "approval.list": listApprovalsQuerySchema,
  "task.list": listTasksQuerySchema,
  "task.detail": taskDetailQuerySchema,
  "inbox.list": listInboxQuerySchema,
  "inbox.detail": inboxDetailQuerySchema,
  "inbox.digest": inboxDigestQuerySchema,
  "memory.search": searchMemoryQuerySchema,
  "memory.detail": memoryDetailQuerySchema,
  "trace.timeline": traceTimelineV2QuerySchema,
  "trace.detail": traceDetailQuerySchema,
  "settings.read": settingsReadQuerySchema,
  "identity.sessions": identitySessionsQuerySchema,
  "identity.session_detail": identitySessionDetailQuerySchema,
  "health.status": healthStatusQuerySchema,
  "approval.detail": approvalDetailQuerySchema,
  "capability.list": capabilityListQuerySchema,
  "capability.detail": capabilityDetailQuerySchema,
  "grant.list": grantListQuerySchema,
  "grant.detail": grantDetailQuerySchema,
  "host.directory.detail": hostDirectoryDetailQuerySchema,
  "workspace.detail": workspaceDetailQuerySchema,
  "workspace.list": workspaceListQuerySchema,
  "suggestion.list": suggestionListQuerySchema,
  "suggestion.detail": suggestionDetailQuerySchema,
  "reflection.detail": reflectionDetailQuerySchema,
  "delegation.detail": delegationDetailQuerySchema,
  "delegation.list": delegationListQuerySchema,
  "improvement.list": improvementListQuerySchema,
  "improvement.detail": improvementDetailQuerySchema,
  "collection.snapshot": collectionSnapshotSchema,
  "health.snapshot": healthSnapshotV2Schema,
  "approval.snapshot": approvalSnapshotSchema,
  "capability.snapshot": capabilitySnapshotSchema,
  "grant.snapshot": grantSnapshotSchema,
  "host.directory.snapshot": hostDirectorySnapshotSchema,
  "workspace.snapshot": workspaceSnapshotV2Schema,
  "suggestion.snapshot": suggestionSnapshotSchema,
  "reflection.snapshot": reflectionSnapshotSchema,
  "delegation.snapshot": delegationSnapshotSchema,
  "improvement.snapshot": improvementSnapshotSchema,
  "task.snapshot": taskSnapshotSchema,
  "inbox.snapshot": inboxSnapshotSchema,
  "digest.snapshot": digestSnapshotSchema,
  "memory.snapshot": memorySnapshotSchema,
  "trace.snapshot": traceSnapshotSchema,
  "settings.snapshot": settingsSnapshotSchema,
  "session.snapshot": sessionSnapshotSchema,
  "stream.event": streamEventV2Schema,
} as const satisfies Record<GatewayV2MessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;

export type GatewayV2Message = InferSchema<SchemaByType[keyof SchemaByType]>;
export type GatewayV2Command = Extract<GatewayV2Message, { kind: "command" }>;
export type GatewayV2Query = Extract<GatewayV2Message, { kind: "query" }>;
export type GatewayV2Snapshot = Extract<GatewayV2Message, { kind: "snapshot" }>;
export type GatewayV2Event = Extract<GatewayV2Message, { kind: "event" }>;

function readType(input: unknown): GatewayV2MessageType {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected a Gateway v2 message object");
  }
  return enumeration(GATEWAY_V2_MESSAGE_TYPES).parse(
    (input as { readonly type?: unknown }).type,
    "$.type",
  );
}

function parseGatewayV2Message(input: unknown): GatewayV2Message {
  const parsed = schemasByType[readType(input)].parse(input, "$") as GatewayV2Message;
  if (
    parsed.kind === "command" &&
    (parsed.risk === "high" || parsed.risk === "critical") &&
    parsed.authorizationRef === null
  ) {
    throw new ContractValidationError(
      "$.authorizationRef",
      "high and critical risk commands require an authorization reference",
    );
  }
  if (
    parsed.type === "host.file.prepare" &&
    (parsed.payload.operation === "permanent_delete") !==
      (parsed.payload.irreversibleScopeRef !== null)
  ) {
    throw new ContractValidationError(
      "$.payload.irreversibleScopeRef",
      "only permanent deletion requires an irreversible scope reference",
    );
  }
  if (
    parsed.type === "host.file.prepare" &&
    ["create", "update"].includes(parsed.payload.operation) !==
      (parsed.payload.candidatePayloadRef !== null)
  ) {
    throw new ContractValidationError(
      "$.payload.candidatePayloadRef",
      "only create and update require a candidate payload",
    );
  }
  if (
    parsed.type === "host.file.execute" &&
    parsed.payload.operation === "permanent_delete" &&
    parsed.payload.recentAuthenticationRef === null
  ) {
    throw new ContractValidationError(
      "$.payload.recentAuthenticationRef",
      "permanent deletion requires recent authentication",
    );
  }
  if (parsed.type === "workspace.stage" && parsed.payload.taskPathRefs.length === 0) {
    throw new ContractValidationError(
      "$.payload.taskPathRefs",
      "workspace staging requires at least one task-owned path reference",
    );
  }
  return parsed;
}

export const gatewayV2MessageSchema = Object.freeze({
  schemaVersion: GATEWAY_V2_SCHEMA_VERSION,
  parse(input: unknown): GatewayV2Message {
    return parseGatewayV2Message(input);
  },
  parseJson(json: string): GatewayV2Message {
    return parseJson({ parse: parseGatewayV2Message }, json);
  },
  serialize(message: GatewayV2Message): string {
    return JSON.stringify(parseGatewayV2Message(message));
  },
});
