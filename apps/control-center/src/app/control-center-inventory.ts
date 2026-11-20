export const CONTROL_CENTER_ACCEPTANCE_IDS = [
  "S3-A01",
  "S3-A02",
  "S3-A03",
  "S3-A04",
  "S3-A05",
] as const;

export const CONTROL_CENTER_REQUIRED_UI_STATES = [
  "empty",
  "loading",
  "error",
  "degraded",
  "offline",
] as const;

export type ControlCenterAcceptanceId = (typeof CONTROL_CENTER_ACCEPTANCE_IDS)[number];
export type ControlCenterUiState = (typeof CONTROL_CENTER_REQUIRED_UI_STATES)[number];
export type ControlCenterContractStatus = "frozen" | "partial" | "missing";
export type ControlCenterIntegrationPolicy = "allowed" | "baseline_only" | "blocked";

export interface ControlCenterSurfaceInventoryEntry {
  readonly id:
    | "threads"
    | "approvals"
    | "tasks"
    | "inbox-digest"
    | "memory"
    | "capabilities-adapters"
    | "authorizations-grants"
    | "host-workspaces"
    | "suggestions"
    | "reflection"
    | "workers"
    | "improvements"
    | "trace"
    | "settings"
    | "sessions-devices"
    | "health-deployment";
  readonly route: string;
  readonly stableObjects: readonly string[];
  readonly queries: readonly string[];
  readonly mutations: readonly string[];
  readonly mutationsOfferedWhenInstalled?: true;
  readonly revisionControl: readonly string[];
  readonly authorization: {
    readonly ownerAgentScope: true;
    readonly recentAuthentication: "not_applicable" | "required_for_high_risk" | "contract_missing";
  };
  readonly requiredUiStates: readonly ControlCenterUiState[];
  readonly acceptanceIds: readonly ControlCenterAcceptanceId[];
  readonly contractStatus: ControlCenterContractStatus;
  readonly integrationPolicy: ControlCenterIntegrationPolicy;
  readonly blockers: readonly string[];
  readonly baselineEvidence: readonly string[];
}

/** Contract coverage alone does not prove that a deployment installed its handlers. */
export function isSurfaceInstalled(
  surface: ControlCenterSurfaceInventoryEntry,
  installedGatewayV2Operations: readonly string[],
  healthDependenciesAvailable = false,
): boolean {
  if (surface.id === "health-deployment") return healthDependenciesAvailable;
  // Conversations use the separately composed Thread v3 gateway.
  const operations = surface.mutationsOfferedWhenInstalled
    ? surface.queries
    : [...surface.queries, ...surface.mutations];
  return (
    surface.id === "threads" ||
    (operations.length > 0 &&
      operations.every((operation) => installedGatewayV2Operations.includes(operation)))
  );
}

const ALL_STATES = CONTROL_CENTER_REQUIRED_UI_STATES;

export const CONTROL_CENTER_SURFACE_INVENTORY = [
  {
    id: "threads",
    route: "/threads",
    stableObjects: ["Thread", "Message", "Turn", "Run", "Checkpoint"],
    queries: [
      "thread.list",
      "thread.detail",
      "thread.search",
      "thread.lineage",
      "thread.checkpoint",
      "thread.deletion_impact",
    ],
    mutations: [
      "thread.create",
      "thread.message.submit",
      "thread.rename",
      "thread.pin",
      "thread.archive",
      "thread.restore",
      "thread.fork",
      "thread.set_answer_locale",
      "thread.trash",
      "thread.delete_permanently",
      "thread.task.resolve",
      "run.cancel",
    ],
    revisionControl: ["Thread.revision", "idempotencyKey", "Run.sequence"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A02", "S3-A03", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: [
      "test/integration/qualification/evidence/s1-task15-control-center.json",
      "test/integration/qualification/evidence/s2-task10-thread-deletion-coordination.json",
    ],
  },
  {
    id: "approvals",
    route: "/approvals",
    stableObjects: ["ActionIntent", "ApprovalRequest", "AuthorizationDecision"],
    queries: ["approval.list", "approval.detail"],
    mutations: ["approval.respond"],
    revisionControl: ["ApprovalRequest.revision", "semanticSnapshotHash", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: [
      "test/integration/qualification/evidence/s1-task15-control-center.json",
      "test/integration/qualification/evidence/s4-task11-governance-control-center.json",
    ],
  },
  {
    id: "tasks",
    route: "/tasks",
    stableObjects: ["ScheduledJob", "TaskOccurrence", "Run", "Result", "BudgetReservation"],
    queries: [],
    mutations: ["github.monitor.set_state"],
    revisionControl: ["Task.revision", "githubMonitor.expectedRevision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A04", "S3-A05"],
    contractStatus: "missing",
    integrationPolicy: "blocked",
    blockers: ["没有实现者的操作已在 P1-4 删出约定，要做这个页面时重新定约定"],
    baselineEvidence: [
      "test/integration/qualification/evidence/s1-task15-control-center.json",
      "test/integration/qualification/evidence/s1-task22-github-read-only-monitor.json",
    ],
  },
  {
    id: "inbox-digest",
    route: "/inbox",
    stableObjects: ["InboxItem", "Digest", "Result", "AttentionDecision"],
    queries: [],
    mutations: [],
    revisionControl: ["InboxItem.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "not_applicable",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A04", "S3-A05"],
    contractStatus: "missing",
    integrationPolicy: "blocked",
    blockers: ["没有实现者的操作已在 P1-4 删出约定，要做这个页面时重新定约定"],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
  {
    id: "memory",
    route: "/memory",
    stableObjects: ["Memory", "MemoryVersion", "SourceProof"],
    queries: ["memory.overview.read"],
    mutations: ["memory.mutate"],
    revisionControl: ["Memory.revision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
  {
    id: "capabilities-adapters",
    route: "/capabilities",
    stableObjects: ["CapabilityDefinition", "CapabilityVersion", "Adapter", "InstallProposal"],
    queries: ["capability.list", "capability.detail"],
    mutations: [
      "capability.review",
      "capability.install.approve",
      "capability.update.respond",
      "capability.disable",
      "capability.rollback",
    ],
    mutationsOfferedWhenInstalled: true,
    revisionControl: ["CapabilityRegistryRecord.revision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: [
      "test/integration/governance-control-center.test.ts",
      "test/integration/qualification/evidence/s4-task11-governance-control-center.json",
    ],
  },
  {
    id: "authorizations-grants",
    route: "/authorizations",
    stableObjects: ["ActionIntent", "AuthorizationDecision", "CapabilityGrant"],
    queries: ["grant.list", "grant.detail"],
    mutations: ["grant.revoke"],
    revisionControl: ["CapabilityGrant.revision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: [
      "test/integration/governance-control-center.test.ts",
      "test/integration/qualification/evidence/s4-task11-governance-control-center.json",
    ],
  },
  {
    id: "host-workspaces",
    route: "/workspaces",
    stableObjects: [
      "HostDirectoryGrant",
      "FileOperation",
      "WorkspaceSnapshot",
      "CommandObservation",
      "CommitPreview",
    ],
    queries: ["workspace.list", "workspace.detail", "host.directory.detail"],
    mutations: ["host.file.prepare", "host.file.execute", "workspace.stage", "workspace.commit"],
    revisionControl: [
      "HostDirectoryGrant.revision",
      "WorkspaceSnapshot.taskChangeSetRevision",
      "CommitPreview.canonicalHash",
      "idempotencyKey",
    ],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: [
      "test/integration/qualification/evidence/s6-tasks1-12-host-workspace-local-implementation.json",
    ],
  },
  {
    id: "suggestions",
    route: "/suggestions",
    stableObjects: ["SuggestionCandidate", "Evidence", "TaskDraft", "InboxDelivery"],
    queries: ["suggestion.list", "suggestion.detail"],
    mutations: ["suggestion.respond"],
    revisionControl: ["SuggestionCandidate.revision", "semanticKey", "idempotencyKey"],
    authorization: { ownerAgentScope: true, recentAuthentication: "not_applicable" },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A04", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: ["packages/application/test/autonomy-services.unit.test.ts"],
  },
  {
    id: "reflection",
    route: "/reflection",
    stableObjects: ["ReflectionDefinition", "ReflectionCheckpoint", "InputWatermark"],
    queries: ["reflection.detail"],
    mutations: ["reflection.configure"],
    revisionControl: ["ReflectionDefinition.revision", "checkpoint.id", "inputWatermark"],
    authorization: { ownerAgentScope: true, recentAuthentication: "not_applicable" },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A04", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: ["packages/application/test/autonomy-services.unit.test.ts"],
  },
  {
    id: "workers",
    route: "/workers",
    stableObjects: ["Delegation", "WorkerRun", "WorkerResult", "CapabilityHandle"],
    queries: ["delegation.list", "delegation.detail"],
    mutations: [],
    revisionControl: ["Delegation.revision", "WorkerRunId", "Trace.sequence"],
    authorization: { ownerAgentScope: true, recentAuthentication: "not_applicable" },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: ["apps/execution-worker/test/production-execution-worker.unit.test.ts"],
  },
  {
    id: "improvements",
    route: "/improvements",
    stableObjects: ["ImprovementCandidate", "CandidateWorkspace", "Validation", "Comparison"],
    queries: ["improvement.list", "improvement.detail"],
    mutations: ["improvement.review"],
    revisionControl: ["ImprovementCandidate.revision", "baseDigest", "artifactDigest"],
    authorization: { ownerAgentScope: true, recentAuthentication: "not_applicable" },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A04", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: ["packages/application/test/autonomy-services.unit.test.ts"],
  },
  {
    id: "trace",
    route: "/trace",
    stableObjects: ["TraceEvent", "Run", "ActionIntent", "AuthorizationDecision", "Result"],
    queries: [],
    mutations: [],
    revisionControl: ["TraceEvent.sequence"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "not_applicable",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "missing",
    integrationPolicy: "blocked",
    blockers: ["没有实现者的操作已在 P1-4 删出约定，要做这个页面时重新定约定"],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
  {
    id: "settings",
    route: "/settings",
    stableObjects: ["ModelPolicy", "BudgetPolicy", "AttentionPolicy", "IntegrationSetting"],
    queries: [],
    mutations: [],
    revisionControl: ["Settings.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A02", "S3-A04", "S3-A05"],
    contractStatus: "missing",
    integrationPolicy: "blocked",
    blockers: ["没有实现者的操作已在 P1-4 删出约定，要做这个页面时重新定约定"],
    baselineEvidence: [],
  },
  {
    id: "sessions-devices",
    route: "/sessions",
    stableObjects: ["Session", "Device", "AuthenticationEvent"],
    queries: [],
    mutations: [],
    revisionControl: ["Session.revision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: [
      "test/integration/qualification/evidence/s1-task15-control-center.json",
      "test/integration/qualification/evidence/s1-task27-browser-identity-public-path.json",
    ],
  },
  {
    id: "health-deployment",
    route: "/health",
    stableObjects: ["Deployment", "AuthorityLease", "ComponentHealth", "OperationCheckpoint"],
    queries: [],
    mutations: [],
    revisionControl: ["authorityEpoch", "fencingToken", "OperationCheckpoint.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "frozen",
    integrationPolicy: "allowed",
    blockers: [],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
] as const satisfies readonly ControlCenterSurfaceInventoryEntry[];

export const CONTROL_CENTER_INTEGRATION_READY_SURFACE_IDS = CONTROL_CENTER_SURFACE_INVENTORY.filter(
  (surface) => surface.integrationPolicy === "allowed",
).map((surface) => surface.id);
