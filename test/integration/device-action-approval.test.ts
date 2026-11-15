import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ApprovalService,
  type DeviceActionIntent,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  GrantService,
} from "@himawari-agent/application";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { expect, it } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.js";
import { OwnerScopeAuthorization } from "../../apps/agent-service/src/owner-scope-authorization.js";
import { productionDeviceActionAuthorization } from "../../apps/agent-service/src/production-device-action-authorization.js";
import { productionToolActionRegistry } from "../../apps/agent-service/src/production-tool-actions.js";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

const DEADLINE = new Date(Date.parse(T1) + 600_000).toISOString();
const DEVICE_ID = "dev_approvalfixture0000000";

async function setup() {
  const resource = await openRepository();
  const { repository } = resource;
  const database = openQualifiedDatabase(path.join(resource.stateRoot, "product.sqlite"));
  database
    .prepare(
      `INSERT INTO thread_messages (
        id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
        classification, committed_at, run_id, message_status
      ) VALUES ('fixture-source', ?, ?, 'thread-capability-invocation', 0, 1, 'owner',
        'payload-capability-invocation-trigger', 'private', ?, ?, 'committed')`,
    )
    .run(OWNER_ID, AGENT_ID, T1, RUN_ID);
  database.close();
  const store = repository.authorizationStore();
  const clock = { now: () => T1 };
  let sequence = 0;
  const ids = { next: (scope: string) => `${scope}:device:${++sequence}` };
  const registry = productionToolActionRegistry();
  const externalContent = new ContextExternalContent({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    state: repository,
    source: repository.runExecutionSource(OWNER_ID, AGENT_ID),
    authority: () => SERVICE_AUTHORITY.lease,
    clock,
  });
  const ownerScope = new OwnerScopeAuthorization({
    externalContent,
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    store,
    audit: repository.auditLedger(),
    state: repository,
    authority: () => SERVICE_AUTHORITY.lease,
    source: repository.runExecutionSource(OWNER_ID, AGENT_ID),
    installedCapabilities: { inspect: async () => undefined },
    registry,
    clock,
    ids,
    intentLifetimeMs: 600_000,
  });
  const authorization = productionDeviceActionAuthorization({ ownerScope, registry });
  const approvals = async () =>
    (await store.listApprovals(OWNER_ID, AGENT_ID)) as readonly GovernedApprovalRequest[];
  const respond = async (
    pending: GovernedApprovalRequest,
    decision: "approved" | "denied",
    recentAuthenticationRef: string | null = null,
  ) => {
    const intent = pending.intentSnapshot as GovernedActionIntent;
    const grant =
      decision === "approved"
        ? new GrantService({ store, clock, ids }).create({
            kind: "one_time",
            intent,
            approvalRequestId: pending.id,
            expiresAt: intent.expiresAt,
            maxUses: 1,
            maxTotalCostMicros: 0,
            scope: {
              capabilityRef: intent.capabilityRef,
              capabilityVersion: intent.capabilityVersion,
              operations: [intent.operation],
              exactResourceRef: intent.resourceRef,
              resourceIdentities: [...intent.resourceRefs],
              resourcePrefixes: [],
              maxDataClassification: intent.dataClassification,
              sideEffects: [intent.sideEffect],
              maxCostMicrosPerUse: 0,
              maxFrequency: intent.frequency,
              disclosure: intent.disclosure,
              recipients: [...intent.recipients],
              credentialOrAccessChange: false,
            },
          })
        : undefined;
    await new ApprovalService({ store, clock }).respond({
      approvalRequestId: pending.id,
      expectedRevision: pending.revision,
      semanticSnapshotHash: pending.semanticSnapshotHash,
      response:
        decision === "approved" && grant
          ? { decision, grant, recentAuthenticationRef }
          : { decision: "denied" },
    } as never);
  };
  return {
    authorization,
    externalContent,
    approvals,
    respond,
    close: async () => {
      await repository.close();
      await rm(resource.stateRoot, { recursive: true, force: true });
    },
  };
}

function intent(overrides: Partial<DeviceActionIntent> = {}): DeviceActionIntent {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    actionId: "action:1",
    runId: RUN_ID,
    toolCallId: "call:device-1",
    deviceId: DEVICE_ID,
    deviceKind: "iphone",
    action: "calendar.event.create",
    schemaVersion: 1,
    arguments: { title: "交周报" },
    actionKind: "CREATE_OR_UPDATE",
    risk: "MEDIUM",
    target: { type: "calendar", ref: "calendar:default" },
    reversible: true,
    ownerPresence: false,
    untrustedOriginAllowed: false,
    readUntrustedContent: false,
    title: { "zh-CN": "添加日程", en: "Add event", ja: "予定を追加" },
    detail: { "zh-CN": "交周报", en: "Weekly report", ja: "週報" },
    dataClassification: "private",
    requestedAt: T1,
    expiresAt: DEADLINE,
    ...overrides,
  } as DeviceActionIntent;
}

it("[ADR-0257] lets an ordinary device action run on the built-in preauthorization and records it", async () => {
  const s = await setup();
  try {
    expect(await s.authorization.authorize(intent())).toEqual({
      decision: "allow",
      ownerPresent: false,
    });
    expect(await s.approvals()).toEqual([expect.objectContaining({ status: "approved" })]);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] asks the owner through the unified approval once outside content is in the run, and runs only after approval", async () => {
  const s = await setup();
  try {
    await s.externalContent.mark(RUN_ID, "perception_read");
    const asked = await s.authorization.authorize(intent());
    const [pending] = await s.approvals();
    expect(asked).toEqual({ decision: "approval", approvalId: pending?.id });
    expect(pending).toMatchObject({
      status: "pending",
      display: { displayTitle: "添加日程" },
      recentAuthenticationRequired: false,
    });
    expect(
      (pending?.intentSnapshot as GovernedActionIntent).targets.map(({ type }) => type),
    ).toEqual(expect.arrayContaining(["device", "device-action", "calendar"]));
    expect(await s.authorization.resolve?.(pending?.id ?? "")).toEqual({ decision: "pending" });
    if (!pending) throw new Error("approval expected");
    await s.respond(pending, "approved");
    expect(await s.authorization.resolve?.(pending.id)).toEqual({
      decision: "allow",
      ownerPresent: false,
    });
  } finally {
    await s.close();
  }
});

it("[ADR-0257] turns an owner denial into a refusal and never lets an unknown approval run", async () => {
  const s = await setup();
  try {
    await s.externalContent.mark(RUN_ID, "perception_read");
    await s.authorization.authorize(intent());
    const [pending] = await s.approvals();
    if (!pending) throw new Error("approval expected");
    await s.respond(pending, "denied");
    expect(await s.authorization.resolve?.(pending.id)).toEqual({
      decision: "deny",
      reasonCode: "owner_denied",
    });
    expect(await s.authorization.resolve?.("approval:not-ours")).toEqual({
      decision: "deny",
      reasonCode: "authorization_denied",
    });
  } finally {
    await s.close();
  }
});

it("[ADR-0257] needs a recent owner authentication for an owner-presence action and reports it once given", async () => {
  const s = await setup();
  try {
    await s.authorization.authorize(intent({ ownerPresence: true, toolCallId: "call:device-2" }));
    const [pending] = await s.approvals();
    expect(pending).toMatchObject({ status: "pending", recentAuthenticationRequired: true });
    if (!pending) throw new Error("approval expected");
    await s.respond(pending, "approved", "recent-auth:1");
    expect(await s.authorization.resolve?.(pending.id)).toEqual({
      decision: "allow",
      ownerPresent: true,
    });
  } finally {
    await s.close();
  }
});

it("[ADR-0257] refuses a device action that reads untrusted content without asking, and asks again once outside content is in the run", async () => {
  const s = await setup();
  try {
    expect(
      await s.authorization.authorize(
        intent({ readUntrustedContent: true, toolCallId: "call:device-3" }),
      ),
    ).toEqual({ decision: "deny", reasonCode: "authorization_denied" });
    expect(await s.approvals()).toHaveLength(0);
    await s.externalContent.mark(RUN_ID, "perception_read");
    expect(await s.authorization.authorize(intent({ toolCallId: "call:device-4" }))).toMatchObject({
      decision: "approval",
    });
    expect(await s.approvals()).toHaveLength(1);
  } finally {
    await s.close();
  }
});
