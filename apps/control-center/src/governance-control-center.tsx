import type { GatewayV2Command, GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type ControlCenterBrowserStorage,
  GOVERNANCE_MUTATION_STORAGE_PREFIX,
} from "./browser-storage.js";
import {
  ActionButton,
  AppLink,
  Banner,
  GovernedActionDialog,
  RiskIndicator,
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
import type { ControlCenterRouteState } from "./app/router.js";

export type GovernanceSurfaceId = "approvals" | "capabilities-adapters" | "authorizations-grants";

type ApprovalSnapshot = Extract<GatewayV2Snapshot, { readonly type: "approval.snapshot" }>;
type CapabilitySnapshot = Extract<GatewayV2Snapshot, { readonly type: "capability.snapshot" }>;
type GrantSnapshot = Extract<GatewayV2Snapshot, { readonly type: "grant.snapshot" }>;
type GovernanceDetailSnapshot = ApprovalSnapshot | CapabilitySnapshot | GrantSnapshot;

type GovernanceAction =
  | { readonly kind: "approval.approve"; readonly snapshot: ApprovalSnapshot }
  | { readonly kind: "approval.deny"; readonly snapshot: ApprovalSnapshot }
  | { readonly kind: "grant.revoke"; readonly snapshot: GrantSnapshot }
  | { readonly kind: "capability.review"; readonly snapshot: CapabilitySnapshot }
  | { readonly kind: "capability.install"; readonly snapshot: CapabilitySnapshot }
  | { readonly kind: "capability.update.approve"; readonly snapshot: CapabilitySnapshot }
  | { readonly kind: "capability.update.deny"; readonly snapshot: CapabilitySnapshot }
  | { readonly kind: "capability.disable"; readonly snapshot: CapabilitySnapshot }
  | { readonly kind: "capability.rollback"; readonly snapshot: CapabilitySnapshot };

interface UseGovernanceControlCenterInput {
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

function mutationMessage(status: MutationStatus | null): MessageId {
  return status ? (`mutation.${status}` as MessageId) : "mutation.none";
}

function detailQuery(
  configuration: ControlCenterRuntimeConfiguration,
  surfaceId: GovernanceSurfaceId,
  objectId: string,
) {
  switch (surfaceId) {
    case "approvals":
      return queryMessage(configuration, "approval.detail", { approvalRequestId: objectId });
    case "capabilities-adapters":
      return queryMessage(configuration, "capability.detail", { capabilityRef: objectId });
    case "authorizations-grants":
      return queryMessage(configuration, "grant.detail", { grantId: objectId });
  }
}

function listQuery(
  configuration: ControlCenterRuntimeConfiguration,
  route: ControlCenterRouteState,
) {
  switch (route.surfaceId) {
    case "approvals":
      return queryMessage(configuration, "approval.list", {
        status: ["pending", "approved", "denied", "expired"].includes(route.status ?? "")
          ? route.status
          : null,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "capabilities-adapters":
      return queryMessage(configuration, "capability.list", {
        lifecycle: [
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
        ].includes(route.status ?? "")
          ? route.status
          : null,
        afterCursor: route.afterCursor,
        limit: 100,
      });
    case "authorizations-grants":
      return queryMessage(configuration, "grant.list", {
        includeRevoked: route.status !== "active",
        afterCursor: route.afterCursor,
        limit: 100,
      });
    default:
      throw new Error("CONTROL_CENTER_GOVERNANCE_SURFACE_INVALID");
  }
}

function actionRisk(action: GovernanceAction): "low" | "medium" | "high" | "critical" {
  switch (action.kind) {
    case "approval.approve":
      return action.snapshot.payload.finalRisk;
    case "approval.deny":
      return "medium";
    case "capability.review":
      return "high";
    case "capability.update.deny":
      return "medium";
    case "capability.update.approve":
      return action.snapshot.payload.updateAssessment?.risk ?? "critical";
    default:
      return "critical";
  }
}

function actionDestructive(action: GovernanceAction): boolean {
  return (
    action.kind === "grant.revoke" ||
    action.kind === "capability.install" ||
    action.kind === "capability.disable" ||
    action.kind === "capability.rollback" ||
    (action.kind === "approval.approve" && action.snapshot.payload.recentAuthenticationRequired)
  );
}

function actionLabel(action: GovernanceAction): MessageId {
  switch (action.kind) {
    case "approval.approve":
      return "approvals.approve";
    case "approval.deny":
      return "approvals.deny";
    case "grant.revoke":
      return "governance.revokeGrant";
    case "capability.review":
      return "governance.reviewCapability";
    case "capability.install":
      return "governance.approveInstallation";
    case "capability.update.approve":
      return "governance.approveUpdate";
    case "capability.update.deny":
      return "governance.denyUpdate";
    case "capability.disable":
      return "governance.disableCapability";
    case "capability.rollback":
      return "governance.rollbackCapability";
  }
}

function actionIdentity(action: GovernanceAction): {
  readonly commandType: string;
  readonly objectRef: string;
  readonly operationKey: string;
  readonly revision: number;
} {
  const snapshot = action.snapshot;
  const objectRef =
    snapshot.type === "approval.snapshot"
      ? snapshot.payload.approvalRequestId
      : snapshot.type === "grant.snapshot"
        ? snapshot.payload.grantId
        : snapshot.payload.capabilityRef;
  const operationKey = `${action.kind}:${objectRef}:${snapshot.payload.revision}`.slice(0, 128);
  const commandType =
    action.kind === "approval.approve" || action.kind === "approval.deny"
      ? "approval.respond"
      : action.kind === "grant.revoke"
        ? "grant.revoke"
        : action.kind === "capability.review"
          ? "capability.review"
          : action.kind === "capability.install"
            ? "capability.install.approve"
            : action.kind === "capability.update.approve" ||
                action.kind === "capability.update.deny"
              ? "capability.update.respond"
              : action.kind === "capability.disable"
                ? "capability.disable"
                : "capability.rollback";
  return { commandType, objectRef, operationKey, revision: snapshot.payload.revision };
}

function detailActions(snapshot: GovernanceDetailSnapshot): readonly GovernanceAction[] {
  if (snapshot.type === "approval.snapshot") {
    return snapshot.payload.status === "pending"
      ? [
          { kind: "approval.approve", snapshot },
          { kind: "approval.deny", snapshot },
        ]
      : [];
  }
  if (snapshot.type === "grant.snapshot") {
    return snapshot.payload.status === "active" ? [{ kind: "grant.revoke", snapshot }] : [];
  }
  switch (snapshot.payload.lifecycle) {
    case "review_required":
      return [{ kind: "capability.review", snapshot }];
    case "installation_proposed":
      return [{ kind: "capability.install", snapshot }];
    case "update_proposed":
      return [
        { kind: "capability.update.approve", snapshot },
        { kind: "capability.update.deny", snapshot },
      ];
    case "active":
      return [
        { kind: "capability.disable", snapshot },
        ...(snapshot.payload.rollbackAvailable
          ? ([{ kind: "capability.rollback", snapshot }] as const)
          : []),
      ];
    default:
      return [];
  }
}

function Values({ values }: { readonly values: readonly string[] }) {
  return <code>{values.length > 0 ? values.join(", ") : "—"}</code>;
}

function Row({ label, value }: { readonly label: ReactNode; readonly value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function GovernanceDetails({
  actions,
  message,
  onAction,
  snapshot,
}: {
  readonly actions: readonly GovernanceAction[];
  readonly message: UseGovernanceControlCenterInput["message"];
  readonly onAction: (action: GovernanceAction) => void;
  readonly snapshot: GovernanceDetailSnapshot | null;
}) {
  if (!snapshot) return <p>{message("governance.selectRecord")}</p>;
  const status =
    snapshot.type === "capability.snapshot" ? snapshot.payload.lifecycle : snapshot.payload.status;
  const commonRows = (
    <>
      <Row label={message("governance.revision")} value={snapshot.payload.revision} />
      <Row label={message("common.status")} value={status} />
    </>
  );
  return (
    <div className="object-details governance-details">
      <dl className="health-grid">
        {commonRows}
        {snapshot.type === "approval.snapshot" ? (
          <>
            <Row
              label={message("governance.semanticHash")}
              value={<code>{snapshot.payload.semanticSnapshotHash}</code>}
            />
            <Row
              label={message("governance.risk")}
              value={
                <RiskIndicator
                  label={message(`risk.${snapshot.payload.finalRisk}` as MessageId)}
                  level={snapshot.payload.finalRisk}
                />
              }
            />
            <Row
              label={message("governance.operation")}
              value={<code>{snapshot.payload.intent.operation}</code>}
            />
            <Row
              label={message("governance.actionKind")}
              value={<code>{snapshot.payload.intent.actionKind}</code>}
            />
            <Row
              label={message("governance.capability")}
              value={
                <code>
                  {snapshot.payload.intent.capabilityRef}@
                  {snapshot.payload.intent.capabilityVersion}
                </code>
              }
            />
            <Row
              label={message("governance.targets")}
              value={<Values values={snapshot.payload.intent.targetRefs} />}
            />
            <Row
              label={message("common.scope")}
              value={<Values values={snapshot.payload.intent.resourceRefs} />}
            />
            <Row
              label={message("governance.dataClassification")}
              value={snapshot.payload.intent.dataClassification}
            />
            <Row
              label={message("governance.disclosure")}
              value={snapshot.payload.intent.disclosure}
            />
            <Row
              label={message("governance.recipients")}
              value={<Values values={snapshot.payload.intent.recipientRefs} />}
            />
            <Row
              label={message("governance.sideEffect")}
              value={snapshot.payload.intent.sideEffect}
            />
            <Row
              label={message("governance.cost")}
              value={snapshot.payload.intent.estimatedCostMicros}
            />
            <Row
              label={message("governance.frequency")}
              value={`${snapshot.payload.intent.frequency.count} / ${snapshot.payload.intent.frequency.intervalMs ?? "once"}`}
            />
            <Row
              label={message("governance.credentialAccessChange")}
              value={String(snapshot.payload.intent.credentialOrAccessChange)}
            />
            <Row
              label={message("governance.reversible")}
              value={String(snapshot.payload.intent.reversible)}
            />
            <Row
              label={message("governance.idempotencyKey")}
              value={<code>{snapshot.payload.intent.idempotencyKey}</code>}
            />
            <Row
              label={message("governance.deterministicFacts")}
              value={<Values values={snapshot.payload.intent.deterministicFactCodes} />}
            />
            <Row
              label={message("governance.modelReason")}
              value={<code>{snapshot.payload.intent.modelReasonCode}</code>}
            />
            <Row
              label={message("governance.requestedAt")}
              value={snapshot.payload.intent.requestedAt}
            />
            <Row label={message("governance.expiresAt")} value={snapshot.payload.expiresAt} />
            <Row
              label={message("governance.recentAuthentication")}
              value={
                snapshot.payload.recentAuthenticationRequired
                  ? (snapshot.payload.recentAuthenticationRef ?? message("common.notConfigured"))
                  : message("governance.notRequired")
              }
            />
            <Row
              label={message("governance.trueResult")}
              value={<code>{snapshot.payload.trueResultRef ?? "—"}</code>}
            />
          </>
        ) : null}
        {snapshot.type === "capability.snapshot" ? (
          <>
            <Row label={message("common.source")} value={snapshot.payload.sourceLocator} />
            <Row
              label={message("governance.sourceIdentity")}
              value={snapshot.payload.sourceIdentity}
            />
            <Row label={message("governance.version")} value={snapshot.payload.version} />
            <Row
              label={message("governance.integrity")}
              value={<code>{snapshot.payload.integrity}</code>}
            />
            <Row
              label={message("governance.signature")}
              value={
                <code>
                  {snapshot.payload.signatureStatus} / {snapshot.payload.signerRef ?? "—"}
                </code>
              }
            />
            <Row
              label={message("governance.operation")}
              value={<Values values={snapshot.payload.operations} />}
            />
            <Row
              label={message("governance.permissions")}
              value={<Values values={snapshot.payload.permissionRefs} />}
            />
            <Row
              label={message("governance.dataClassification")}
              value={<Values values={snapshot.payload.dataClassifications} />}
            />
            <Row
              label={message("governance.networkScopes")}
              value={<Values values={snapshot.payload.networkScopes} />}
            />
            <Row
              label={message("governance.filesystemScopes")}
              value={<Values values={snapshot.payload.filesystemScopes} />}
            />
            <Row
              label={message("governance.secretReferences")}
              value={<Values values={snapshot.payload.secretRefs} />}
            />
            <Row label={message("governance.isolation")} value={snapshot.payload.isolation} />
            <Row label={message("governance.health")} value={snapshot.payload.healthStatus} />
            <Row
              label={message("governance.cost")}
              value={`${snapshot.payload.maxMicrosPerInvocation} ${snapshot.payload.currency}`}
            />
            <Row
              label={message("governance.approvalHistory")}
              value={<Values values={snapshot.payload.approvalRefs} />}
            />
            <Row
              label={message("governance.dependencies")}
              value={<Values values={snapshot.payload.dependencyTaskRefs} />}
            />
            <Row
              label={message("governance.runtimeQualification")}
              value={
                snapshot.payload.runtimeQualification ? (
                  <code>
                    {snapshot.payload.runtimeQualification.platform};{" "}
                    {snapshot.payload.runtimeQualification.runtimeIdentity}; productionSuitable=
                    {String(snapshot.payload.runtimeQualification.productionSuitable)}
                  </code>
                ) : (
                  "—"
                )
              }
            />
            <Row
              label={message("governance.updateAssessment")}
              value={
                snapshot.payload.updateAssessment ? (
                  <code>
                    {snapshot.payload.updateAssessment.fromVersion} →{" "}
                    {snapshot.payload.updateAssessment.toVersion};{" "}
                    {snapshot.payload.updateAssessment.risk};{" "}
                    {snapshot.payload.updateAssessment.expansions.join(", ") || "no expansion"}
                  </code>
                ) : (
                  "—"
                )
              }
            />
            <Row
              label={message("governance.rollback")}
              value={snapshot.payload.rollbackVersion ?? message("governance.notAvailable")}
            />
            <Row
              label={message("governance.lastTransition")}
              value={
                snapshot.payload.lastTransition ? (
                  <code>
                    {snapshot.payload.lastTransition.fromVersion} →{" "}
                    {snapshot.payload.lastTransition.toVersion};{" "}
                    {snapshot.payload.lastTransition.outcome}
                  </code>
                ) : (
                  "—"
                )
              }
            />
            <Row
              label={message("governance.rollbackBoundary")}
              value={
                snapshot.payload.lastTransition ? (
                  <code>
                    externalEffectsRolledBack=
                    {String(snapshot.payload.lastTransition.externalEffectsRolledBack)};{" "}
                    productStateRolledBack=
                    {String(snapshot.payload.lastTransition.productStateRolledBack)}
                  </code>
                ) : (
                  "—"
                )
              }
            />
          </>
        ) : null}
        {snapshot.type === "grant.snapshot" ? (
          <>
            <Row label={message("governance.capability")} value={snapshot.payload.capabilityRef} />
            <Row label={message("governance.version")} value={snapshot.payload.capabilityVersion} />
            <Row
              label={message("governance.operation")}
              value={<Values values={snapshot.payload.operations} />}
            />
            <Row
              label={message("common.scope")}
              value={
                <Values
                  values={[
                    ...snapshot.payload.resourceIdentities,
                    ...snapshot.payload.resourcePrefixes,
                  ]}
                />
              }
            />
            <Row
              label={message("governance.dataClassification")}
              value={snapshot.payload.maxDataClassification}
            />
            <Row label={message("governance.disclosure")} value={snapshot.payload.disclosure} />
            <Row
              label={message("governance.sideEffect")}
              value={<Values values={snapshot.payload.sideEffects} />}
            />
            <Row
              label={message("governance.recipients")}
              value={<Values values={snapshot.payload.recipientRefs} />}
            />
            <Row label={message("governance.expiresAt")} value={snapshot.payload.expiresAt} />
            <Row
              label={message("governance.usage")}
              value={`${snapshot.payload.uses} / ${snapshot.payload.maxUses}`}
            />
            <Row
              label={message("governance.budget")}
              value={`${snapshot.payload.spentCostMicros} / ${snapshot.payload.maxTotalCostMicros}`}
            />
            <Row
              label={message("governance.affectedTasks")}
              value={<Values values={snapshot.payload.affectedTaskRefs} />}
            />
          </>
        ) : null}
      </dl>
      {actions.length > 0 ? (
        <fieldset className="actions governance-actions">
          <legend className="visually-hidden">{message("actions.label")}</legend>
          {actions.map((action) => (
            <ActionButton
              key={action.kind}
              onClick={() => onAction(action)}
              variant={actionDestructive(action) ? "danger" : "primary"}
            >
              {message(actionLabel(action))}
            </ActionButton>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

export function useGovernanceControlCenter({
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
}: UseGovernanceControlCenterInput) {
  const [listSnapshot, setListSnapshot] = useState<GatewayV2Snapshot | null>(null);
  const [detailSnapshot, setDetailSnapshot] = useState<GovernanceDetailSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationStatus, setMutationStatus] = useState<MutationStatus | null>(null);
  const [conflict, setConflict] = useState(false);
  const [action, setAction] = useState<GovernanceAction | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const refresh = useCallback(async () => {
    if (!active || !client || !configuration) return;
    setLoading(true);
    setError(null);
    setListSnapshot(null);
    setDetailSnapshot(null);
    try {
      const collection = await client.query(listQuery(configuration, route));
      setListSnapshot(collection);
      if (route.objectId) {
        const detail = await client.query(
          detailQuery(configuration, route.surfaceId as GovernanceSurfaceId, route.objectId),
        );
        if (
          detail.type !== "approval.snapshot" &&
          detail.type !== "capability.snapshot" &&
          detail.type !== "grant.snapshot"
        ) {
          throw new Error("CONTROL_CENTER_GOVERNANCE_DETAIL_INVALID");
        }
        setDetailSnapshot(detail);
      } else {
        setDetailSnapshot(null);
      }
    } catch (requestError) {
      if (errorStatus(requestError) === 401) {
        setListSnapshot(null);
        setDetailSnapshot(null);
        setAction(null);
        setAcknowledged(false);
        onUnauthorized();
      } else
        setError(
          requestError instanceof Error ? requestError.message : "CONTROL_CENTER_REQUEST_REJECTED",
        );
    } finally {
      setLoading(false);
    }
  }, [active, client, configuration, onUnauthorized, route]);

  useEffect(() => {
    void refreshSignal;
    void refresh();
  }, [refresh, refreshSignal]);

  useEffect(() => {
    if (!active) return;
    const synchronizeTab = (event: StorageEvent) => {
      if (event.key?.startsWith(GOVERNANCE_MUTATION_STORAGE_PREFIX)) void refresh();
    };
    window.addEventListener("storage", synchronizeTab);
    return () => window.removeEventListener("storage", synchronizeTab);
  }, [active, refresh]);

  const executeAction = useCallback(async () => {
    if (!action || !client || !configuration || connection !== "connected") {
      setError("CONTROL_CENTER_OFFLINE");
      return;
    }
    const authorizationRef = configuration.authorizationRef;
    if (!authorizationRef) {
      setError("CONTROL_CENTER_AUTHORIZATION_REQUIRED");
      return;
    }
    const identity = actionIdentity(action);
    const pending = storage.readPendingGovernanceMutation(identity.operationKey);
    const idempotencyKey = pending?.idempotencyKey ?? `governance:${crypto.randomUUID()}`;
    if (
      pending &&
      (pending.commandType !== identity.commandType ||
        pending.objectRef !== identity.objectRef ||
        pending.expectedRevision !== identity.revision)
    ) {
      setError("CONTROL_CENTER_MUTATION_IDENTITY_CONFLICT");
      return;
    }
    storage.savePendingGovernanceMutation({
      operationKey: identity.operationKey,
      idempotencyKey,
      commandType: identity.commandType,
      objectRef: identity.objectRef,
      expectedRevision: identity.revision,
    });
    setMutationStatus("pending");
    setConflict(false);
    setError(null);
    try {
      const risk = actionRisk(action);
      let command: GatewayV2Command;
      switch (action.kind) {
        case "approval.approve":
        case "approval.deny":
          command = commandMessage(
            configuration,
            "approval.respond",
            {
              approvalRequestId: action.snapshot.payload.approvalRequestId,
              expectedRevision: action.snapshot.payload.revision,
              decision: action.kind === "approval.approve" ? "approved" : "denied",
              semanticSnapshotHash: action.snapshot.payload.semanticSnapshotHash,
              editedPayloadRef: null,
              recentAuthenticationRef:
                action.kind === "approval.approve" &&
                action.snapshot.payload.recentAuthenticationRequired
                  ? (configuration.recentAuthenticationRef ?? null)
                  : null,
            },
            { risk, authorizationRef, idempotencyKey },
          );
          break;
        case "grant.revoke":
          command = commandMessage(
            configuration,
            "grant.revoke",
            {
              grantId: action.snapshot.payload.grantId,
              expectedRevision: action.snapshot.payload.revision,
              reasonCode: "owner_revoked_from_control_center",
            },
            { risk, authorizationRef, idempotencyKey },
          );
          break;
        case "capability.review":
          command = commandMessage(
            configuration,
            "capability.review",
            {
              capabilityRef: action.snapshot.payload.capabilityRef,
              expectedRevision: action.snapshot.payload.revision,
            },
            { risk, authorizationRef, idempotencyKey },
          );
          break;
        case "capability.install":
          command = commandMessage(
            configuration,
            "capability.install.approve",
            {
              capabilityRef: action.snapshot.payload.capabilityRef,
              expectedRevision: action.snapshot.payload.revision,
              approvalRef: authorizationRef,
            },
            { risk, authorizationRef, idempotencyKey },
          );
          break;
        case "capability.update.approve":
        case "capability.update.deny":
          command = commandMessage(
            configuration,
            "capability.update.respond",
            {
              capabilityRef: action.snapshot.payload.capabilityRef,
              expectedRevision: action.snapshot.payload.revision,
              decision: action.kind === "capability.update.approve" ? "approved" : "denied",
              approvalRef: action.kind === "capability.update.approve" ? authorizationRef : null,
            },
            { risk, authorizationRef, idempotencyKey },
          );
          break;
        case "capability.disable":
          command = commandMessage(
            configuration,
            "capability.disable",
            {
              capabilityRef: action.snapshot.payload.capabilityRef,
              expectedRevision: action.snapshot.payload.revision,
              reasonCode: "owner_disabled_from_control_center",
            },
            { risk, authorizationRef, idempotencyKey },
          );
          break;
        case "capability.rollback":
          command = commandMessage(
            configuration,
            "capability.rollback",
            {
              capabilityRef: action.snapshot.payload.capabilityRef,
              expectedRevision: action.snapshot.payload.revision,
              reasonCode: "owner_rollback_from_control_center",
            },
            { risk, authorizationRef, idempotencyKey },
          );
          break;
      }
      const result = await client.mutate(command);
      storage.clearPendingGovernanceMutation(identity.operationKey);
      setMutationStatus(result.status);
      setAction(null);
      setAcknowledged(false);
      await refresh();
    } catch (mutationError) {
      const status = errorStatus(mutationError);
      if (status === 401) {
        onUnauthorized();
      } else if (status === 409) {
        storage.clearPendingGovernanceMutation(identity.operationKey);
        setConflict(true);
        setMutationStatus("rejected");
        setAction(null);
        setAcknowledged(false);
        await refresh();
      } else {
        setMutationStatus("rejected");
        setError(
          mutationError instanceof Error
            ? mutationError.message
            : "CONTROL_CENTER_REQUEST_REJECTED",
        );
      }
    }
  }, [action, client, configuration, connection, onUnauthorized, refresh, storage]);

  const itemRefs =
    listSnapshot?.type === "collection.snapshot" ? listSnapshot.payload.itemRefs : [];
  const actions = useMemo(
    () => (detailSnapshot ? detailActions(detailSnapshot) : []),
    [detailSnapshot],
  );

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
            current={reference === route.objectId}
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
        <p className="eyebrow">{message("governance.authoritativeState")}</p>
        <ActionButton onClick={() => void refresh()} variant="secondary">
          {message("common.refresh")}
        </ActionButton>
      </div>
      {error ? (
        <Banner title={message("state.error")} tone="danger">
          <code>{error}</code>
        </Banner>
      ) : null}
      {conflict ? (
        <Banner title={message("governance.conflictTitle")} tone="warning">
          <p>{message("governance.conflictDescription")}</p>
        </Banner>
      ) : null}
      {connection === "offline" ? (
        <Banner title={message("state.offline")} tone="warning">
          <p>{message("governance.offlineNoMutation")}</p>
        </Banner>
      ) : null}
      <StatusRegion className="mutation-status">
        {message("mutation.label")}: {message(mutationMessage(mutationStatus))}
      </StatusRegion>
      {detailSnapshot ? (
        <section aria-labelledby="governance-summary-title">
          <h3 id="governance-summary-title">{message("governance.authoritativeSummary")}</h3>
          <p>
            <code>
              {detailSnapshot.type}:{detailSnapshot.payload.revision}
            </code>
          </p>
        </section>
      ) : (
        <p>{loading ? message("state.loading") : message("governance.selectRecord")}</p>
      )}
      {action ? (
        <GovernedActionDialog
          acknowledged={acknowledged}
          acknowledgementLabel={message("governance.acknowledge")}
          authorizationRef={
            connection === "connected" ? (configuration?.authorizationRef ?? null) : null
          }
          blockerLabels={{
            authorization_required: message("governance.blocker.authorization"),
            recent_authentication_required: message("governance.blocker.recentAuthentication"),
            revision_conflict: message("governance.blocker.revision"),
            explicit_acknowledgement_required: message("governance.blocker.acknowledgement"),
          }}
          cancelLabel={message("common.close")}
          closeLabel={message("common.close")}
          confirmLabel={message(actionLabel(action))}
          currentRevision={action.snapshot.payload.revision}
          destructive={actionDestructive(action)}
          expectedRevision={action.snapshot.payload.revision}
          onAcknowledgementChange={setAcknowledged}
          onCancel={() => {
            setAction(null);
            setAcknowledged(false);
          }}
          onConfirm={() => void executeAction()}
          open
          recentAuthenticationRef={
            connection === "connected" ? (configuration?.recentAuthenticationRef ?? null) : null
          }
          risk={actionRisk(action)}
          riskLabel={message(`risk.${actionRisk(action)}` as MessageId)}
          title={message("governance.actionTitle")}
          unavailableTitle={message("governance.actionUnavailable")}
        >
          <p>{message("governance.actionDescription")}</p>
          <code>{actionIdentity(action).objectRef}</code>
        </GovernedActionDialog>
      ) : null}
    </>
  );

  const details = (
    <GovernanceDetails
      actions={actions}
      message={message}
      onAction={(nextAction) => {
        setAcknowledged(false);
        setAction(nextAction);
      }}
      snapshot={detailSnapshot}
    />
  );

  return { content, details, list };
}
