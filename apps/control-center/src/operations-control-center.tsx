import type { GatewayV2Command, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { ControlCenterRouteState } from "./app/router.js";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";
import {
  ActionButton,
  AppLink,
  Banner,
  GovernedActionDialog,
  SemanticList,
  StatusRegion,
} from "./components/index.js";
import type {
  ControlCenterRuntimeConfiguration,
  GatewayClient,
  MutationStatus,
} from "./gateway-client.js";
import type { MessageId } from "./i18n/message-ids.js";
import { commandMessage, queryMessage } from "./messages.js";

export type OperationsSurfaceId =
  | "tasks"
  | "inbox-digest"
  | "memory"
  | "trace"
  | "settings"
  | "sessions-devices"
  | "health-deployment"
  | "host-workspaces"
  | "suggestions"
  | "reflection"
  | "workers"
  | "improvements";

type DetailSnapshot = Extract<
  GatewayV2Snapshot,
  {
    readonly type:
      | "task.snapshot"
      | "inbox.snapshot"
      | "memory.snapshot"
      | "trace.snapshot"
      | "session.snapshot"
      | "workspace.snapshot"
      | "suggestion.snapshot"
      | "delegation.snapshot"
      | "improvement.snapshot";
  }
>;
type DirectSnapshot = Extract<
  GatewayV2Snapshot,
  {
    readonly type:
      | "digest.snapshot"
      | "settings.snapshot"
      | "health.snapshot"
      | "reflection.snapshot";
  }
>;

type OperationAction =
  | {
      readonly kind: "task.pause" | "task.resume" | "task.revoke";
      readonly snapshot: Extract<DetailSnapshot, { readonly type: "task.snapshot" }>;
    }
  | {
      readonly kind: "memory.correct" | "memory.archive" | "memory.delete";
      readonly snapshot: Extract<DetailSnapshot, { readonly type: "memory.snapshot" }>;
    }
  | {
      readonly kind: "session.revoke";
      readonly snapshot: Extract<DetailSnapshot, { readonly type: "session.snapshot" }>;
    }
  | {
      readonly kind: "suggestion.approve" | "suggestion.reject";
      readonly snapshot: Extract<DetailSnapshot, { readonly type: "suggestion.snapshot" }>;
    }
  | {
      readonly kind: "improvement.reject" | "improvement.request_revision";
      readonly snapshot: Extract<DetailSnapshot, { readonly type: "improvement.snapshot" }>;
    };

interface UseOperationsControlCenterInput {
  readonly active: boolean;
  readonly client: GatewayClient | undefined;
  readonly configuration: ControlCenterRuntimeConfiguration | undefined;
  readonly connection: "connecting" | "connected" | "offline";
  readonly message: (
    id: MessageId,
    values?: Record<string, string | number | boolean | Date>,
  ) => string;
  readonly navigate: (route: ControlCenterRouteState, replace?: boolean) => void;
  readonly onUnauthorized: () => void;
  readonly refreshSignal: number;
  readonly route: ControlCenterRouteState;
  readonly storage: ControlCenterBrowserStorage;
}

function errorStatus(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error
    ? Number((error as { readonly status?: unknown }).status)
    : null;
}

function listQuery(
  configuration: ControlCenterRuntimeConfiguration,
  route: ControlCenterRouteState,
) {
  switch (route.surfaceId) {
    case "tasks":
      return queryMessage(configuration, "task.list", {
        status: ["active", "paused", "revoked"].includes(route.status ?? "") ? route.status : null,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "inbox-digest":
      return queryMessage(configuration, "inbox.list", {
        unreadOnly: route.status === "unread",
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "memory":
      return queryMessage(configuration, "memory.search", {
        queryRef: "query:recent",
        status: ["active", "archived", "trashed"].includes(route.status ?? "")
          ? route.status
          : null,
        limit: 100,
      });
    case "trace":
      return queryMessage(configuration, "trace.timeline", {
        threadId: null,
        runId: null,
        afterSequence: 0,
        limit: 200,
      });
    case "sessions-devices":
      return queryMessage(configuration, "identity.sessions", {
        includeRevoked: true,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "host-workspaces":
      return queryMessage(configuration, "workspace.list", {
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "suggestions":
      return queryMessage(configuration, "suggestion.list", {
        status: null,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "workers":
      return queryMessage(configuration, "delegation.list", {
        status: null,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "improvements":
      return queryMessage(configuration, "improvement.list", {
        status: null,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    default:
      return null;
  }
}

function detailQuery(
  configuration: ControlCenterRuntimeConfiguration,
  surfaceId: OperationsSurfaceId,
  objectId: string,
) {
  switch (surfaceId) {
    case "tasks":
      return queryMessage(configuration, "task.detail", { jobId: objectId });
    case "inbox-digest":
      return queryMessage(configuration, "inbox.detail", { inboxItemId: objectId });
    case "memory":
      return queryMessage(configuration, "memory.detail", { memoryId: objectId });
    case "trace":
      return queryMessage(configuration, "trace.detail", { traceEventId: objectId });
    case "sessions-devices":
      return queryMessage(configuration, "identity.session_detail", { sessionId: objectId });
    case "host-workspaces":
      return queryMessage(configuration, "workspace.detail", { workspaceId: objectId });
    case "suggestions":
      return queryMessage(configuration, "suggestion.detail", { suggestionId: objectId });
    case "workers":
      return queryMessage(configuration, "delegation.detail", { delegationId: objectId });
    case "improvements":
      return queryMessage(configuration, "improvement.detail", { candidateId: objectId });
    default:
      return null;
  }
}

function directQuery(
  configuration: ControlCenterRuntimeConfiguration,
  surfaceId: OperationsSurfaceId,
) {
  switch (surfaceId) {
    case "inbox-digest":
      return queryMessage(configuration, "inbox.digest", { digestId: null });
    case "settings":
      return queryMessage(configuration, "settings.read", { includeIntegrations: true });
    case "health-deployment":
      return queryMessage(configuration, "health.status", { includeDependencies: true });
    case "reflection":
      return queryMessage(configuration, "reflection.detail", { includeCheckpoints: true });
    default:
      return null;
  }
}

function listCategory(surfaceId: OperationsSurfaceId): string {
  return surfaceId === "inbox-digest"
    ? "inbox"
    : surfaceId === "sessions-devices"
      ? "sessions"
      : surfaceId === "memory"
        ? "memories"
        : surfaceId === "host-workspaces"
          ? "workspaces"
          : surfaceId === "workers"
            ? "delegations"
            : surfaceId;
}

function Row({ label, value }: { readonly label: ReactNode; readonly value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Refs({ values }: { readonly values: readonly string[] }) {
  return <code>{values.length > 0 ? values.join(", ") : "—"}</code>;
}

function DetailRows({
  message,
  snapshot,
}: {
  readonly message: UseOperationsControlCenterInput["message"];
  readonly snapshot: DetailSnapshot;
}) {
  switch (snapshot.type) {
    case "task.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.jobId}</code>} />
          <Row label={message("governance.revision")} value={p.revision} />
          <Row label={message("common.status")} value={p.status} />
          <Row label={message("operations.trigger")} value={p.triggerType} />
          <Row label={message("operations.timezone")} value={<code>{p.timezone}</code>} />
          <Row label={message("operations.nextRun")} value={p.nextRunAt ?? "—"} />
          <Row
            label={message("operations.occurrence")}
            value={`${p.occurrenceRef ?? "—"} / ${p.occurrenceStatus ?? "—"}`}
          />
          <Row label={message("operations.run")} value={<code>{p.runRef ?? "—"}</code>} />
          <Row label={message("operations.result")} value={<code>{p.resultRef ?? "—"}</code>} />
          <Row
            label={message("operations.blockedReason")}
            value={<code>{p.blockedReasonCode ?? "—"}</code>}
          />
          <Row
            label={message("operations.budget")}
            value={`${p.spentCostMicros} / ${p.maxCostMicros}`}
          />
          <Row
            label={message("operations.attention")}
            value={`${p.requestedAttention} → ${p.effectiveAttention}`}
          />
          <Row label={message("operations.safetyFloor")} value={p.safetyFloor} />
          <Row label={message("operations.delivery")} value={<Refs values={p.deliveryRefs} />} />
        </dl>
      );
    }
    case "inbox.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.inboxItemId}</code>} />
          <Row label={message("operations.unread")} value={String(p.unread)} />
          <Row label={message("operations.priority")} value={p.priority} />
          <Row label={message("operations.attention")} value={p.attentionLevel} />
          <Row label={message("operations.result")} value={<code>{p.resultRef}</code>} />
          <Row label={message("operations.sources")} value={<Refs values={p.sourceRefs} />} />
        </dl>
      );
    }
    case "memory.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.memoryId}</code>} />
          <Row label={message("governance.revision")} value={p.revision} />
          <Row label={message("common.status")} value={p.status} />
          <Row label={message("operations.classification")} value={p.dataClassification} />
          <Row label={message("operations.sources")} value={<Refs values={p.sourceRefs} />} />
          <Row label={message("operations.confidence")} value={`${p.confidencePermille}‰`} />
          <Row label={message("operations.policy")} value={<code>{p.policyVersion}</code>} />
          <Row label={message("operations.projection")} value={p.providerProjectionStatus} />
          <Row
            label={message("operations.sensitiveApproval")}
            value={<code>{p.sensitiveApprovalRef ?? "—"}</code>}
          />
          <Row label={message("common.time")} value={p.updatedAt} />
        </dl>
      );
    }
    case "trace.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.traceEventId}</code>} />
          <Row label={message("operations.event")} value={`${p.sequence}: ${p.eventType}`} />
          <Row label={message("operations.actor")} value={<code>{p.actorRef}</code>} />
          <Row
            label={message("operations.causation")}
            value={<code>{`${p.parentEventRef ?? "—"} / ${p.causationRef ?? "—"}`}</code>}
          />
          <Row label={message("operations.run")} value={<code>{p.runRef}</code>} />
          <Row
            label={message("operations.modelProvider")}
            value={<code>{`${p.modelRef ?? "—"} / ${p.providerRef ?? "—"}`}</code>}
          />
          <Row
            label={message("operations.authorization")}
            value={<code>{p.authorizationRef ?? "—"}</code>}
          />
          <Row
            label={message("operations.capability")}
            value={<code>{p.capabilityRef ?? "—"}</code>}
          />
          <Row label={message("operations.retry")} value={p.retryAttempt} />
          <Row label={message("operations.result")} value={<code>{p.resultRef ?? "—"}</code>} />
        </dl>
      );
    }
    case "session.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.sessionId}</code>} />
          <Row label={message("governance.revision")} value={p.sessionRevision} />
          <Row label={message("common.status")} value={p.status} />
          <Row
            label={message("operations.device")}
            value={`${p.deviceLabel} / ${p.deviceId} / ${p.deviceStatus}`}
          />
          <Row
            label={message("operations.authentication")}
            value={<code>{p.authenticationRef}</code>}
          />
          <Row label={message("operations.lastActivity")} value={p.lastActiveAt} />
        </dl>
      );
    }
    case "workspace.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.workspaceId}</code>} />
          <Row
            label={message("hostWorkspaces.repository")}
            value={<code>{`${p.repositoryKind} / ${p.branch ?? "—"} / ${p.head ?? "—"}`}</code>}
          />
          <Row
            label={message("hostWorkspaces.ownership")}
            value={
              <code>{`owner=${p.ownerPathRefs.join(",") || "—"}; task=${p.taskPathRefs.join(",") || "—"}; concurrent=${p.concurrentPathRefs.join(",") || "—"}`}</code>
            }
          />
          <Row
            label={message("hostWorkspaces.commandProfiles")}
            value={<Refs values={p.commandProfileRefs} />}
          />
          <Row
            label={message("hostWorkspaces.commandObservations")}
            value={<Refs values={p.commandObservationRefs} />}
          />
          <Row
            label={message("hostWorkspaces.commitPreview")}
            value={<code>{p.commitPreviewRef ?? "—"}</code>}
          />
          <Row
            label={message("hostWorkspaces.recovery")}
            value={<Refs values={p.recoveryRefs} />}
          />
          <Row
            label={message("hostWorkspaces.directoryGrants")}
            value={<Refs values={p.directoryGrantRefs} />}
          />
        </dl>
      );
    }
    case "suggestion.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.suggestionId}</code>} />
          <Row label={message("governance.revision")} value={p.revision} />
          <Row label={message("common.status")} value={p.status} />
          <Row label={message("operations.event")} value={<code>{p.kind}</code>} />
          <Row
            label={message("common.details")}
            value={<code>{`${p.titleRef} / ${p.bodyRef}`}</code>}
          />
          <Row label={message("common.source")} value={<code>{p.sourceWatermark}</code>} />
          <Row label={message("operations.sources")} value={<Refs values={p.evidenceRefs} />} />
          <Row
            label={message("common.scope")}
            value={<code>{`${p.goalRef ?? "—"} / ${p.commitmentRef ?? "—"}`}</code>}
          />
          <Row label={message("operations.dedupe")} value={<code>{p.semanticKey}</code>} />
          <Row label={message("operations.confidence")} value={`${p.confidencePermille}‰`} />
          <Row label={message("operations.novelty")} value={`${p.noveltyPermille}‰`} />
          <Row
            label={message("operations.capability")}
            value={<Refs values={p.estimatedCapabilityRefs} />}
          />
          <Row
            label={message("operations.classification")}
            value={<Refs values={p.estimatedDataClassifications} />}
          />
          <Row label={message("operations.budget")} value={p.estimatedCostMicros} />
          <Row label={message("operations.delivery")} value={<code>{p.deliveryRef ?? "—"}</code>} />
          <Row label={message("operations.result")} value={<code>{p.taskRef ?? "—"}</code>} />
          <Row label={message("common.time")} value={`${p.createdAt} — ${p.expiresAt}`} />
        </dl>
      );
    }
    case "delegation.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.delegationId}</code>} />
          <Row label={message("governance.revision")} value={p.revision} />
          <Row label={message("common.status")} value={p.status} />
          <Row
            label={message("operations.run")}
            value={<code>{`${p.parentRunId} → ${p.workerRunId}`}</code>}
          />
          <Row
            label={message("common.source")}
            value={<code>{`${p.traceRef} / ${p.subtaskRef}`}</code>}
          />
          <Row
            label={message("operations.outputSchema")}
            value={<code>{p.outputSchemaRef}</code>}
          />
          <Row label={message("common.scope")} value={<Refs values={p.contextRefs} />} />
          <Row
            label={message("operations.capability")}
            value={<Refs values={p.capabilityHandleRefs} />}
          />
          <Row
            label={message("operations.modelProvider")}
            value={<Refs values={p.allowedModelRefs} />}
          />
          <Row
            label={message("operations.budget")}
            value={`${p.maximumCostMicros} / ${p.maximumDurationMs}ms`}
          />
          <Row label={message("operations.classification")} value={p.dataClassification} />
          <Row label={message("operations.candidateLimit")} value={p.maximumProgressEvents} />
          <Row label={message("operations.result")} value={<code>{p.resultRef ?? "—"}</code>} />
          <Row label={message("common.error")} value={<code>{p.failureReasonCode ?? "—"}</code>} />
        </dl>
      );
    }
    case "improvement.snapshot": {
      const p = snapshot.payload;
      return (
        <dl className="health-grid">
          <Row label={message("common.selectedRecord")} value={<code>{p.candidateId}</code>} />
          <Row label={message("governance.revision")} value={p.revision} />
          <Row label={message("common.status")} value={p.status} />
          <Row
            label={message("common.source")}
            value={<code>{`${p.baseRevision} / ${p.baseDigest}`}</code>}
          />
          <Row
            label={message("common.details")}
            value={<code>{`${p.observableProblemRef} / ${p.goalRef}`}</code>}
          />
          <Row label={message("operations.sources")} value={<Refs values={p.invariantRefs} />} />
          <Row label={message("common.scope")} value={<Refs values={p.allowedPathRefs} />} />
          <Row
            label={message("operations.result")}
            value={
              <code>{`${p.patchRef ?? "—"} (${p.patchDigest ?? "—"}) / ${p.artifactRef ?? "—"} (${p.artifactDigest ?? "—"})`}</code>
            }
          />
          <Row
            label={message("operations.checkpoints")}
            value={<Refs values={p.validationRefs} />}
          />
          <Row
            label={message("operations.safetyFloor")}
            value={<Refs values={p.protectedRootFacts} />}
          />
          <Row
            label={message("operations.comparison")}
            value={<code>{p.comparisonRef ?? "—"}</code>}
          />
          <Row label={message("operations.risk")} value={p.risk} />
          <Row label={message("operations.authorization")} value={String(p.reviewRequired)} />
          <Row label={message("common.time")} value={p.expiresAt} />
        </dl>
      );
    }
  }
}

function DirectRows({
  message,
  snapshot,
}: {
  readonly message: UseOperationsControlCenterInput["message"];
  readonly snapshot: DirectSnapshot;
}) {
  if (snapshot.type === "digest.snapshot") {
    return (
      <dl className="health-grid">
        <Row
          label={message("common.selectedRecord")}
          value={<code>{snapshot.payload.digestId}</code>}
        />
        <Row
          label={message("operations.digestWindow")}
          value={`${snapshot.payload.windowStart} — ${snapshot.payload.windowEnd}`}
        />
        <Row
          label={message("operations.sources")}
          value={<Refs values={snapshot.payload.sourceResultRefs} />}
        />
        <Row
          label={message("common.currentRecords")}
          value={<Refs values={snapshot.payload.itemRefs} />}
        />
      </dl>
    );
  }
  if (snapshot.type === "settings.snapshot") {
    return (
      <dl className="health-grid">
        <Row label={message("governance.revision")} value={snapshot.payload.revision} />
        <Row
          label={message("settings.modelsBudgets")}
          value={
            <code>{`${snapshot.payload.primaryModelRef ?? "—"} / ${snapshot.payload.fallbackModelRef ?? "—"}`}</code>
          }
        />
        <Row
          label={message("operations.budget")}
          value={`${snapshot.payload.spentBudgetMicros} / ${snapshot.payload.globalBudgetMicros}`}
        />
        <Row
          label={message("settings.attentionDigest")}
          value={`${snapshot.payload.defaultAttention} / ${snapshot.payload.digestTimezone} / ${snapshot.payload.digestScheduleRef ?? "—"}`}
        />
        <Row
          label={message("settings.integrations")}
          value={
            <Refs
              values={snapshot.payload.integrations.map(
                ({ integrationRef, status, secretRefs }) =>
                  `${integrationRef}:${status}:${secretRefs.join("+")}`,
              )}
            />
          }
        />
      </dl>
    );
  }
  if (snapshot.type === "reflection.snapshot") {
    return (
      <dl className="health-grid">
        <Row label={message("governance.revision")} value={snapshot.payload.revision} />
        <Row
          label={message("operations.timezone")}
          value={<code>{snapshot.payload.timezone}</code>}
        />
        <Row
          label={message("operations.trigger")}
          value={<code>{snapshot.payload.schedule}</code>}
        />
        <Row
          label={message("operations.budget")}
          value={`${snapshot.payload.maximumCostMicros} / ${snapshot.payload.timeoutMs}ms`}
        />
        <Row label={message("operations.quota")} value={snapshot.payload.dailySuggestionQuota} />
        <Row
          label={message("operations.contextLimit")}
          value={snapshot.payload.maximumContextItems}
        />
        <Row
          label={message("operations.candidateLimit")}
          value={snapshot.payload.maximumCandidates}
        />
        <Row label={message("common.status")} value={String(snapshot.payload.enabled)} />
        <Row
          label={message("common.source")}
          value={<code>{snapshot.payload.latestInputWatermark ?? "—"}</code>}
        />
        <Row
          label={message("operations.result")}
          value={<code>{snapshot.payload.latestOutcome ?? "—"}</code>}
        />
        <Row
          label={message("common.error")}
          value={<code>{snapshot.payload.latestErrorCode ?? "—"}</code>}
        />
      </dl>
    );
  }
  return (
    <>
      <dl className="health-grid">
        <Row label={message("health.service")} value={String(snapshot.payload.live)} />
        <Row label={message("health.admission")} value={String(snapshot.payload.ready)} />
        <Row label={message("health.state")} value={snapshot.payload.status} />
        <Row label={message("health.host")} value={snapshot.payload.activeHost} />
      </dl>
      <h3>{message("operations.components")}</h3>
      <SemanticList
        empty={message("common.noRecords")}
        getId={(component) => component.componentRef}
        items={snapshot.payload.components}
        label={message("operations.components")}
        renderItem={(component) => (
          <code>{`${component.componentRef}: ${component.status}${component.reasonCode ? ` / ${component.reasonCode}` : ""}`}</code>
        )}
      />
      <h3>{message("operations.checkpoints")}</h3>
      <SemanticList
        empty={message("common.noRecords")}
        getId={(checkpoint) => checkpoint.operationRef}
        items={snapshot.payload.operationCheckpoints}
        label={message("operations.checkpoints")}
        renderItem={(checkpoint) => (
          <code>{`${checkpoint.operationRef}: ${checkpoint.kind} / ${checkpoint.phase} / ${checkpoint.status} / ${message("operations.readback")}: ${checkpoint.readbackRef ?? "—"}`}</code>
        )}
      />
    </>
  );
}

function actionIdentity(action: OperationAction) {
  const snapshot = action.snapshot;
  const objectRef =
    snapshot.type === "task.snapshot"
      ? snapshot.payload.jobId
      : snapshot.type === "memory.snapshot"
        ? snapshot.payload.memoryId
        : snapshot.type === "session.snapshot"
          ? snapshot.payload.sessionId
          : snapshot.type === "suggestion.snapshot"
            ? snapshot.payload.suggestionId
            : snapshot.payload.candidateId;
  const revision =
    snapshot.type === "session.snapshot"
      ? snapshot.payload.sessionRevision
      : snapshot.payload.revision;
  return {
    objectRef,
    revision,
    operationKey: `operation:${action.kind}:${objectRef}:${revision}`.slice(0, 128),
    commandType:
      snapshot.type === "task.snapshot"
        ? "task.set_state"
        : snapshot.type === "memory.snapshot"
          ? "memory.mutate"
          : snapshot.type === "session.snapshot"
            ? "session.revoke"
            : snapshot.type === "suggestion.snapshot"
              ? "suggestion.respond"
              : "improvement.review",
  };
}

function actionLabel(action: OperationAction): MessageId {
  switch (action.kind) {
    case "task.pause":
      return "tasks.pause";
    case "task.resume":
      return "tasks.resume";
    case "task.revoke":
      return "tasks.cancel";
    case "memory.correct":
      return "memory.correct";
    case "memory.archive":
      return "memory.archive";
    case "memory.delete":
      return "memory.delete";
    case "session.revoke":
      return "sessions.revoke";
    case "suggestion.approve":
      return "suggestions.approve";
    case "suggestion.reject":
      return "suggestions.reject";
    case "improvement.reject":
      return "improvements.reject";
    case "improvement.request_revision":
      return "improvements.requestRevision";
  }
}

export function useOperationsControlCenter(input: UseOperationsControlCenterInput) {
  const {
    active,
    client,
    configuration,
    connection,
    message,
    navigate,
    onUnauthorized,
    refreshSignal,
    route,
    storage,
  } = input;
  const surfaceId = route.surfaceId as OperationsSurfaceId;
  const [listSnapshot, setListSnapshot] =
    useState<Extract<GatewayV2Snapshot, { readonly type: "collection.snapshot" }>>();
  const [detail, setDetail] = useState<DetailSnapshot>();
  const [direct, setDirect] = useState<DirectSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [conflict, setConflict] = useState(false);
  const [action, setAction] = useState<OperationAction | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [correction, setCorrection] = useState("");
  const [reflectionDraft, setReflectionDraft] = useState<{
    schedule: string;
    timezone: string;
    dailySuggestionQuota: number;
    maximumContextItems: number;
    maximumCostMicros: number;
    timeoutMs: number;
    maximumCandidates: number;
    enabled: boolean;
  }>();

  const selectedId = route.objectId ?? "";
  const refresh = useCallback(async () => {
    if (!active || !client || !configuration) return;
    setLoading(true);
    setError(null);
    try {
      const lq = listQuery(configuration, route);
      const dq = selectedId ? detailQuery(configuration, surfaceId, selectedId) : null;
      const directQ = directQuery(configuration, surfaceId);
      const [list, currentDetail, currentDirect] = await Promise.all([
        lq ? client.query(lq) : Promise.resolve(null),
        dq ? client.query(dq) : Promise.resolve(null),
        directQ ? client.query(directQ) : Promise.resolve(null),
      ]);
      setListSnapshot(list?.type === "collection.snapshot" ? list : undefined);
      setDetail(
        currentDetail &&
          [
            "task.snapshot",
            "inbox.snapshot",
            "memory.snapshot",
            "trace.snapshot",
            "session.snapshot",
            "workspace.snapshot",
            "suggestion.snapshot",
            "delegation.snapshot",
            "improvement.snapshot",
          ].includes(currentDetail.type)
          ? (currentDetail as DetailSnapshot)
          : undefined,
      );
      setDirect(
        currentDirect &&
          [
            "digest.snapshot",
            "settings.snapshot",
            "health.snapshot",
            "reflection.snapshot",
          ].includes(currentDirect.type)
          ? (currentDirect as DirectSnapshot)
          : undefined,
      );
      setConflict(false);
      if (currentDirect?.type === "reflection.snapshot") {
        const p = currentDirect.payload;
        setReflectionDraft({
          schedule: p.schedule,
          timezone: p.timezone,
          dailySuggestionQuota: p.dailySuggestionQuota,
          maximumContextItems: p.maximumContextItems,
          maximumCostMicros: p.maximumCostMicros,
          timeoutMs: p.timeoutMs,
          maximumCandidates: p.maximumCandidates,
          enabled: p.enabled,
        });
      }
    } catch (caught) {
      if (errorStatus(caught) === 401) {
        setListSnapshot(undefined);
        setDetail(undefined);
        setDirect(undefined);
        setError("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
        onUnauthorized();
      } else setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    } finally {
      setLoading(false);
    }
  }, [active, client, configuration, onUnauthorized, route, selectedId, surfaceId]);

  useEffect(() => {
    void refreshSignal;
    void refresh();
  }, [refresh, refreshSignal]);

  useEffect(() => {
    if (!active) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key?.includes("Mutation.")) void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [active, refresh]);

  const actions = useMemo<readonly OperationAction[]>(() => {
    if (!detail) return [];
    if (detail.type === "task.snapshot") {
      if (detail.payload.status === "revoked") return [];
      return [
        {
          kind: detail.payload.status === "paused" ? "task.resume" : "task.pause",
          snapshot: detail,
        },
        { kind: "task.revoke", snapshot: detail },
      ];
    }
    if (detail.type === "memory.snapshot") {
      if (detail.payload.status === "deleted_verified") return [];
      return [
        { kind: "memory.correct", snapshot: detail },
        { kind: "memory.archive", snapshot: detail },
        { kind: "memory.delete", snapshot: detail },
      ];
    }
    if (detail.type === "session.snapshot" && detail.payload.status === "active") {
      return [{ kind: "session.revoke", snapshot: detail }];
    }
    if (
      detail.type === "suggestion.snapshot" &&
      ["candidate", "delivered"].includes(detail.payload.status)
    ) {
      return [
        { kind: "suggestion.approve", snapshot: detail },
        { kind: "suggestion.reject", snapshot: detail },
      ];
    }
    if (detail.type === "improvement.snapshot" && detail.payload.status === "review_required") {
      return [
        { kind: "improvement.reject", snapshot: detail },
        { kind: "improvement.request_revision", snapshot: detail },
      ];
    }
    return [];
  }, [detail]);

  const executeAction = useCallback(async () => {
    if (!action || !client || !configuration) return;
    const identity = actionIdentity(action);
    const existing = storage.readPendingGovernanceMutation(identity.operationKey);
    const idempotencyKey = existing?.idempotencyKey ?? `operation:${crypto.randomUUID()}`;
    storage.savePendingGovernanceMutation({
      ...identity,
      idempotencyKey,
      expectedRevision: identity.revision,
    });
    setMutationStatus("pending");
    try {
      let payload: unknown;
      let risk: "high" | "critical" = "high";
      if (action.snapshot.type === "task.snapshot") {
        payload = {
          jobId: action.snapshot.payload.jobId,
          expectedRevision: action.snapshot.payload.revision,
          action: action.kind.replace("task.", ""),
          reasonCode: "owner-requested",
        };
        if (action.kind === "task.revoke") risk = "critical";
      } else if (action.snapshot.type === "memory.snapshot") {
        const memoryAction = action.kind.replace("memory.", "");
        const contentRef =
          action.kind === "memory.correct"
            ? await client.protectText(
                correction,
                action.snapshot.payload.dataClassification,
                `payload:${idempotencyKey}`,
              )
            : null;
        payload = {
          memoryId: action.snapshot.payload.memoryId,
          expectedRevision: action.snapshot.payload.revision,
          action: memoryAction,
          contentRef,
        };
        if (action.kind === "memory.delete") risk = "critical";
      } else if (action.snapshot.type === "session.snapshot") {
        payload = {
          sessionId: action.snapshot.payload.sessionId,
          deviceId: action.snapshot.payload.deviceId,
          expectedRevision: action.snapshot.payload.sessionRevision,
          recentAuthenticationRef: configuration.recentAuthenticationRef,
          reasonCode: "owner-requested",
        };
        risk = "critical";
      } else if (action.snapshot.type === "suggestion.snapshot") {
        payload = {
          suggestionId: action.snapshot.payload.suggestionId,
          expectedRevision: action.snapshot.payload.revision,
          decision: action.kind.replace("suggestion.", ""),
        };
      } else {
        payload = {
          candidateId: action.snapshot.payload.candidateId,
          expectedRevision: action.snapshot.payload.revision,
          decision: action.kind.replace("improvement.", ""),
          reviewEvidenceRef: "review:owner-requested",
        };
      }
      const result = await client.mutate(
        commandMessage(configuration, identity.commandType as GatewayV2Command["type"], payload, {
          risk,
          ...(configuration.authorizationRef
            ? { authorizationRef: configuration.authorizationRef }
            : {}),
          idempotencyKey,
        }),
      );
      setMutationStatus(result.status);
      storage.clearPendingGovernanceMutation(identity.operationKey);
      setAction(null);
      setAcknowledged(false);
      setCorrection("");
      await refresh();
    } catch (caught) {
      if (errorStatus(caught) === 409) {
        storage.clearPendingGovernanceMutation(identity.operationKey);
        setConflict(true);
        setAction(null);
        await refresh();
      } else if (errorStatus(caught) === 401) {
        setListSnapshot(undefined);
        setDetail(undefined);
        setDirect(undefined);
        setError("CONTROL_CENTER_REAUTHENTICATION_REQUIRED");
        onUnauthorized();
      } else setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    }
  }, [action, client, configuration, correction, onUnauthorized, refresh, storage]);

  const configureReflection = useCallback(async () => {
    if (
      !client ||
      !configuration ||
      !direct ||
      direct.type !== "reflection.snapshot" ||
      !reflectionDraft
    ) {
      return;
    }
    setMutationStatus("pending");
    try {
      const result = await client.mutate(
        commandMessage(
          configuration,
          "reflection.configure",
          {
            expectedRevision: direct.payload.revision,
            ...reflectionDraft,
          },
          {
            risk: "medium",
            ...(configuration.authorizationRef
              ? { authorizationRef: configuration.authorizationRef }
              : {}),
            idempotencyKey: `reflection:${crypto.randomUUID()}`,
          },
        ),
      );
      setMutationStatus(result.status);
      await refresh();
    } catch (caught) {
      if (errorStatus(caught) === 401) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : "CONTROL_CENTER_REQUEST_REJECTED");
    }
  }, [client, configuration, direct, onUnauthorized, reflectionDraft, refresh]);

  const itemRefs =
    listSnapshot?.payload.category === listCategory(surfaceId) ? listSnapshot.payload.itemRefs : [];
  const list = (
    <>
      <p>{message("objects.count", { count: itemRefs.length })}</p>
      <SemanticList
        empty={loading ? message("state.loading") : message("common.noRecords")}
        getId={(reference) => reference}
        items={itemRefs}
        label={message("common.currentRecords")}
        renderItem={(reference) => (
          <AppLink
            current={reference === selectedId}
            href={`#${encodeURIComponent(reference)}`}
            onClick={(event) => {
              event.preventDefault();
              navigate({ ...route, objectId: reference, view: "details" });
            }}
          >
            <code>{reference}</code>
          </AppLink>
        )}
      />
    </>
  );

  const content = (
    <>
      <div className="panel-heading">
        <p className="eyebrow">{message("operations.authoritativeState")}</p>
        <ActionButton onClick={() => void refresh()} variant="secondary">
          {message("common.refresh")}
        </ActionButton>
      </div>
      {connection === "offline" ? (
        <Banner title={message("state.offline")} tone="warning">
          {message("operations.offlineNoMutation")}
        </Banner>
      ) : null}
      {error ? (
        <Banner title={message("error.currentUnavailable")} tone="danger">
          <code>{error}</code>
        </Banner>
      ) : null}
      {conflict ? (
        <Banner title={message("operations.conflictTitle")} tone="warning">
          {message("operations.conflictDescription")}
        </Banner>
      ) : null}
      <StatusRegion>
        {message("mutation.label")}:{" "}
        {message(mutationStatus ? (`mutation.${mutationStatus}` as MessageId) : "mutation.none")}
      </StatusRegion>
      {direct ? <DirectRows message={message} snapshot={direct} /> : null}
      {direct?.type === "reflection.snapshot" && reflectionDraft ? (
        <fieldset className="actions">
          <label>
            <span>{message("operations.trigger")}</span>
            <input
              value={reflectionDraft.schedule}
              onChange={(event) =>
                setReflectionDraft({ ...reflectionDraft, schedule: event.target.value })
              }
            />
          </label>
          <label>
            <span>{message("operations.timezone")}</span>
            <input
              value={reflectionDraft.timezone}
              onChange={(event) =>
                setReflectionDraft({ ...reflectionDraft, timezone: event.target.value })
              }
            />
          </label>
          <label>
            <span>{message("operations.budget")}</span>
            <input
              min={0}
              type="number"
              value={reflectionDraft.maximumCostMicros}
              onChange={(event) =>
                setReflectionDraft({
                  ...reflectionDraft,
                  maximumCostMicros: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <span>{message("operations.quota")}</span>
            <input
              max={20}
              min={1}
              type="number"
              value={reflectionDraft.dailySuggestionQuota}
              onChange={(event) =>
                setReflectionDraft({
                  ...reflectionDraft,
                  dailySuggestionQuota: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <span>{message("operations.contextLimit")}</span>
            <input
              min={1}
              type="number"
              value={reflectionDraft.maximumContextItems}
              onChange={(event) =>
                setReflectionDraft({
                  ...reflectionDraft,
                  maximumContextItems: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <span>{message("operations.timeout")}</span>
            <input
              min={1}
              type="number"
              value={reflectionDraft.timeoutMs}
              onChange={(event) =>
                setReflectionDraft({ ...reflectionDraft, timeoutMs: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>{message("operations.candidateLimit")}</span>
            <input
              max={20}
              min={1}
              type="number"
              value={reflectionDraft.maximumCandidates}
              onChange={(event) =>
                setReflectionDraft({
                  ...reflectionDraft,
                  maximumCandidates: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <span>{message("common.status")}</span>
            <input
              checked={reflectionDraft.enabled}
              type="checkbox"
              onChange={(event) =>
                setReflectionDraft({ ...reflectionDraft, enabled: event.target.checked })
              }
            />
          </label>
          <ActionButton
            disabled={connection === "offline"}
            onClick={() => void configureReflection()}
            variant="secondary"
          >
            {message("reflection.configure")}
          </ActionButton>
        </fieldset>
      ) : null}
    </>
  );

  const details = detail ? (
    <>
      <DetailRows message={message} snapshot={detail} />
      {detail.type === "memory.snapshot" ? (
        <label>
          <span>{message("memory.correction")}</span>
          <textarea onChange={(event) => setCorrection(event.target.value)} value={correction} />
        </label>
      ) : null}
      <fieldset className="actions">
        <legend className="visually-hidden">{message("actions.label")}</legend>
        {actions.map((candidate) => (
          <ActionButton
            key={candidate.kind}
            disabled={
              connection === "offline" ||
              (candidate.kind === "memory.correct" && correction.length === 0)
            }
            onClick={() => {
              setAcknowledged(false);
              setAction(candidate);
            }}
            variant={
              candidate.kind.endsWith("delete") || candidate.kind.endsWith("revoke")
                ? "danger"
                : "secondary"
            }
          >
            {message(actionLabel(candidate))}
          </ActionButton>
        ))}
      </fieldset>
    </>
  ) : (
    <p>{message("operations.selectRecord")}</p>
  );

  const currentIdentity = action ? actionIdentity(action) : null;
  const destructive =
    action?.kind.endsWith("delete") ||
    action?.kind.endsWith("revoke") ||
    action?.kind === "improvement.reject" ||
    false;
  const needsRecentAuthentication = action?.kind === "session.revoke" || destructive;
  return {
    content: (
      <>
        {content}
        <GovernedActionDialog
          acknowledged={acknowledged}
          acknowledgementLabel={message("governed.acknowledgement")}
          blockerLabels={{
            authorization_required: message("governed.authorizationRequired"),
            recent_authentication_required: message("governed.recentAuthenticationRequired"),
            revision_conflict: message("governed.revisionConflict"),
            explicit_acknowledgement_required: message("governed.acknowledgementRequired"),
          }}
          cancelLabel={message("governed.cancel")}
          closeLabel={message("common.close")}
          currentRevision={currentIdentity?.revision ?? 1}
          destructive={destructive}
          expectedRevision={currentIdentity?.revision ?? 1}
          authorizationRef={configuration?.authorizationRef ?? null}
          recentAuthenticationRef={
            !needsRecentAuthentication
              ? "not-required"
              : (configuration?.recentAuthenticationRef ?? null)
          }
          onAcknowledgementChange={setAcknowledged}
          onCancel={() => setAction(null)}
          onConfirm={() => void executeAction()}
          open={action !== null}
          risk={destructive ? "critical" : "high"}
          riskLabel={message(destructive ? "risk.critical" : "risk.high")}
          title={action ? message(actionLabel(action)) : message("actions.label")}
          unavailableTitle={message("governed.unavailable")}
          confirmLabel={message("governed.confirm")}
        >
          <code>{currentIdentity?.objectRef ?? "—"}</code>
        </GovernedActionDialog>
      </>
    ),
    details,
    list,
  };
}
