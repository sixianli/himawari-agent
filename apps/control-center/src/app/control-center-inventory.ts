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
    | "trace"
    | "settings"
    | "sessions-devices"
    | "health-deployment";
  readonly route: string;
  readonly sourceSpec: string;
  readonly stableObjects: readonly string[];
  readonly queries: readonly string[];
  readonly mutations: readonly string[];
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

const CONTROL_CENTER_SPEC = "docs/execution/specs/2026-08-26-control-center-experience-design.md";
const THREAD_SPEC = "docs/execution/specs/2026-08-26-owner-thread-conversation-design.md";
const AUTHORIZATION_SPEC =
  "docs/execution/specs/2026-08-26-authorization-capability-governance-design.md";
const PROACTIVITY_SPEC =
  "docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md";
const FOUNDATION_SPEC = "docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md";
const PRODUCTION_SPEC =
  "docs/execution/specs/2026-08-26-production-qualification-upgrade-design.md";

const ALL_STATES = CONTROL_CENTER_REQUIRED_UI_STATES;

export const CONTROL_CENTER_SURFACE_INVENTORY = [
  {
    id: "threads",
    route: "/threads",
    sourceSpec: THREAD_SPEC,
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
    sourceSpec: AUTHORIZATION_SPEC,
    stableObjects: ["ActionIntent", "ApprovalRequest", "AuthorizationDecision"],
    queries: ["approval.list"],
    mutations: ["approval.respond"],
    revisionControl: ["semanticSnapshotHash", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A05"],
    contractStatus: "partial",
    integrationPolicy: "baseline_only",
    blockers: [
      "approval_detail_snapshot_missing",
      "approval_revision_and_recent_auth_readback_missing",
    ],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
  {
    id: "tasks",
    route: "/tasks",
    sourceSpec: PROACTIVITY_SPEC,
    stableObjects: ["ScheduledJob", "TaskOccurrence", "Run", "Result", "BudgetReservation"],
    queries: ["task.list"],
    mutations: ["task.set_state", "github.monitor.set_state"],
    revisionControl: ["githubMonitor.expectedRevision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A04", "S3-A05"],
    contractStatus: "partial",
    integrationPolicy: "baseline_only",
    blockers: ["task_detail_snapshot_missing", "task_mutation_revision_missing"],
    baselineEvidence: [
      "test/integration/qualification/evidence/s1-task15-control-center.json",
      "test/integration/qualification/evidence/s1-task22-github-read-only-monitor.json",
    ],
  },
  {
    id: "inbox-digest",
    route: "/inbox",
    sourceSpec: PROACTIVITY_SPEC,
    stableObjects: ["InboxItem", "Digest", "Result", "AttentionDecision"],
    queries: ["inbox.list"],
    mutations: [],
    revisionControl: ["InboxItem.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "not_applicable",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A04", "S3-A05"],
    contractStatus: "partial",
    integrationPolicy: "baseline_only",
    blockers: ["digest_query_missing", "attention_preference_mutation_missing"],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
  {
    id: "memory",
    route: "/memory",
    sourceSpec: FOUNDATION_SPEC,
    stableObjects: ["Memory", "MemoryVersion", "MemoryProjection", "SourceProof"],
    queries: ["memory.search"],
    mutations: ["memory.mutate"],
    revisionControl: ["Memory.revision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "partial",
    integrationPolicy: "baseline_only",
    blockers: ["memory_detail_snapshot_missing", "sensitive_memory_approval_readback_missing"],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
  {
    id: "capabilities-adapters",
    route: "/capabilities",
    sourceSpec: AUTHORIZATION_SPEC,
    stableObjects: ["CapabilityDefinition", "CapabilityVersion", "Adapter", "InstallProposal"],
    queries: [],
    mutations: [],
    revisionControl: ["CapabilityVersion.integrity", "Adapter.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A05"],
    contractStatus: "missing",
    integrationPolicy: "blocked",
    blockers: ["capability_and_adapter_gateway_contracts_missing"],
    baselineEvidence: [],
  },
  {
    id: "authorizations-grants",
    route: "/authorizations",
    sourceSpec: AUTHORIZATION_SPEC,
    stableObjects: ["ActionIntent", "AuthorizationDecision", "CapabilityGrant"],
    queries: [],
    mutations: [],
    revisionControl: ["ActionIntent.semanticSnapshotHash", "CapabilityGrant.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A05"],
    contractStatus: "missing",
    integrationPolicy: "blocked",
    blockers: ["authorization_and_grant_gateway_contracts_missing"],
    baselineEvidence: [],
  },
  {
    id: "trace",
    route: "/trace",
    sourceSpec: FOUNDATION_SPEC,
    stableObjects: ["TraceEvent", "Run", "ActionIntent", "AuthorizationDecision", "Result"],
    queries: ["trace.timeline"],
    mutations: [],
    revisionControl: ["TraceEvent.sequence"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "not_applicable",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "partial",
    integrationPolicy: "baseline_only",
    blockers: ["trace_causal_detail_snapshot_missing"],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
  {
    id: "settings",
    route: "/settings",
    sourceSpec: CONTROL_CENTER_SPEC,
    stableObjects: ["ModelPolicy", "BudgetPolicy", "AttentionPolicy", "IntegrationSetting"],
    queries: [],
    mutations: [],
    revisionControl: ["Settings.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A02", "S3-A04", "S3-A05"],
    contractStatus: "missing",
    integrationPolicy: "blocked",
    blockers: ["settings_gateway_contracts_missing"],
    baselineEvidence: [],
  },
  {
    id: "sessions-devices",
    route: "/sessions",
    sourceSpec: FOUNDATION_SPEC,
    stableObjects: ["Session", "Device", "AuthenticationEvent"],
    queries: ["identity.sessions"],
    mutations: ["session.revoke"],
    revisionControl: ["Session.revision", "idempotencyKey"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "required_for_high_risk",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "partial",
    integrationPolicy: "baseline_only",
    blockers: ["device_detail_snapshot_missing", "session_revoke_event_readback_missing"],
    baselineEvidence: [
      "test/integration/qualification/evidence/s1-task15-control-center.json",
      "test/integration/qualification/evidence/s1-task27-browser-identity-public-path.json",
    ],
  },
  {
    id: "health-deployment",
    route: "/health",
    sourceSpec: PRODUCTION_SPEC,
    stableObjects: ["Deployment", "AuthorityLease", "ComponentHealth", "OperationCheckpoint"],
    queries: ["health.status"],
    mutations: [],
    revisionControl: ["authorityEpoch", "fencingToken", "OperationCheckpoint.revision"],
    authorization: {
      ownerAgentScope: true,
      recentAuthentication: "contract_missing",
    },
    requiredUiStates: ALL_STATES,
    acceptanceIds: ["S3-A01", "S3-A03", "S3-A05"],
    contractStatus: "partial",
    integrationPolicy: "baseline_only",
    blockers: ["deployment_detail_snapshot_missing", "long_operation_checkpoint_contract_missing"],
    baselineEvidence: ["test/integration/qualification/evidence/s1-task15-control-center.json"],
  },
] as const satisfies readonly ControlCenterSurfaceInventoryEntry[];

export const CONTROL_CENTER_INTEGRATION_READY_SURFACE_IDS = CONTROL_CENTER_SURFACE_INVENTORY.filter(
  (surface) => surface.integrationPolicy === "allowed",
).map((surface) => surface.id);
