import { readFile } from "node:fs/promises";
import {
  ApprovalService,
  actionIntentFingerprint,
  type GovernedActionIntent,
  GrantService,
  type PermissionAllowDecision,
} from "@himawari-agent/application";
import { createIdempotencyKey } from "@himawari-agent/domain";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import { afterEach, expect, it } from "vitest";
import { executeProductionCodingRequest } from "../../apps/agent-service/src/production-coding-workflow.js";
import { createProductionFileReadServices } from "../../apps/agent-service/src/production-file-read-services.js";
import type { FileReadExecutionContext } from "../../apps/agent-service/src/production-file-read-workflow.js";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.js";
import {
  AGENT_ID,
  OWNER_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(operation: "read" | "write" = "read") {
  const f = await productionSandboxScope(
    {
      operation,
      mode: "foreground",
      contract: { ref: operation, version: "1", kind: "command" },
      backendRef: "srt",
      scopeSource: "grant_targets",
      directoryOperations: ["read", "create", "update"],
      network: "disabled",
    },
    undefined,
    { seedRuntimeIntent: false },
  );
  cleanups.push(f.close);
  const config = parseProductConfiguration(
    JSON.parse(
      await readFile(
        new URL("./fixtures/file-summary/configuration.json", import.meta.url),
        "utf8",
      ),
    ),
    T1,
  );
  if (!config.runPolicy) throw new Error("missing run policy");
  const clock = { now: () => T1 };
  let seq = 0;
  const ids = { next: (prefix: string) => `${prefix}:scope:${++seq}` };
  const services = createProductionFileReadServices({
    configuration: {
      ...config,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      modelDescriptors: [f.model],
      runPolicy: {
        ...config.runPolicy,
        coding: {
          hostId: f.host.binding.hostId,
          workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
          grantId: f.fileBinding.grant.id,
          capabilityRef: f.input.capabilityRef,
          capabilityVersion: f.input.capabilityVersion,
          maximumBytes: 4096,
          enabledTools: [operation],
        },
      },
    },
    repository: f.repository,
    authority: () => SERVICE_AUTHORITY,
    clock,
    ids,
  });
  const store = f.repository.authorizationStore();
  const grants = new GrantService({ store, clock, ids });
  const approvals = new ApprovalService({ store, clock });
  const approve = async (action: GovernedActionIntent, kind: "one_time" | "long_term") => {
    const approval = await store.findApprovalByIntent(action.id);
    if (!approval) throw new Error("expected real pending approval");
    const grant = grants.create({
      kind,
      intent: action,
      approvalRequestId: approval.id,
      expiresAt: T2,
      maxUses: 3,
      maxTotalCostMicros: 0,
      scope: {
        capabilityRef: action.capabilityRef,
        capabilityVersion: action.capabilityVersion,
        operations: [action.operation],
        exactResourceRef: action.resourceRef,
        resourceIdentities: action.resourceRefs,
        resourcePrefixes: [],
        maxDataClassification: action.dataClassification,
        sideEffects: [action.sideEffect],
        disclosure: action.disclosure,
        recipients: action.recipients,
        credentialOrAccessChange: false,
        maxCostMicrosPerUse: 0,
        maxFrequency: action.frequency,
      },
    });
    await approvals.respond({
      approvalRequestId: approval.id,
      expectedRevision: approval.revision,
      semanticSnapshotHash: actionIntentFingerprint(action),
      response: { decision: "approved", grant, recentAuthenticationRef: null },
    });
    return grant;
  };
  const action = (
    id: string,
    changes: Partial<GovernedActionIntent> = {},
  ): GovernedActionIntent => ({
    ...f.intent,
    id,
    idempotencyKey: createIdempotencyKey(id),
    resourceRef: "file:note",
    resourceRefs: ["file:note"],
    disclosure: "none",
    recipients: [],
    ...changes,
  });
  const consume = async (
    permission: PermissionAllowDecision,
    intent: GovernedActionIntent,
    inputRef = "scope-input",
  ) => {
    const handle = await services.issue({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: intent.runId,
      authorityFence: SERVICE_AUTHORITY.product.fencingToken,
      capabilityRef: intent.capabilityRef,
      capabilityVersion: intent.capabilityVersion,
      operation: intent.operation,
      permission,
      inputRefs: [inputRef],
      delegatedContextRefs: [],
      secretRefs: [],
      maxUses: 1,
      maxTotalCostMicros: 0,
      expiresAt: T2,
    });
    const request = {
      ...f.input,
      receiptRef: `receipt:${intent.id}`,
      handleRef: handle.ref,
      authorizationRef: permission.basis.ref,
      invocationId: `invocation:${intent.id}`,
      idempotencyKey: intent.id,
      inputRef,
      delegatedContextRefs: [],
      requestedAt: T1,
      consumedAt: T1,
    };
    const port = f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID);
    expect(await port.consume(request)).toMatchObject({ replayed: false });
    expect(await port.consume(request)).toMatchObject({ replayed: true });
    return handle;
  };
  const db = openQualifiedDatabase(`${f.f.resource.stateRoot}/product.sqlite`);
  cleanups.push(async () => {
    db.close();
  });
  return { ...f, services, store, approve, action, consume, db };
}

it("reuses a safe read scope for a new intent but asks again when risk rises", async () => {
  const f = await fixture();
  const source = f.action("safe-source");
  expect(await f.services.authorize(source)).toMatchObject({ decision: "ASK" });
  const grant = await f.approve(source, "long_term");
  const next = f.action("safe-new-content", {
    targets: [...source.targets, { type: "input-digest", ref: "new-read-input" }],
  });
  const allowed = await f.services.authorize(next);
  expect(allowed).toMatchObject({
    decision: "ALLOW",
    basis: { ref: grant.id },
    authorizationReservation: { id: `authorization-reservation:${next.id}` },
  });
  if (allowed.decision !== "ALLOW")
    throw new Error("positive control did not reach grant reservation");
  await f.consume(allowed, next);
  expect(
    (await f.store.listGrants(OWNER_ID, AGENT_ID)).find(({ id }) => id === grant.id),
  ).toMatchObject({ uses: 1 });
  const high = f.action("high-new-content", {
    finalRisk: "HIGH",
    modelClassification: {
      actionKind: "READ",
      suggestedRisk: "HIGH",
      reasonCode: "sensitive-target-context",
    },
  });
  expect(await f.services.authorize(high)).toMatchObject({ decision: "ASK" });
  if (!f.store.reserveAuthorization) throw new Error("missing reservation port");
  await expect(
    f.store.reserveAuthorization({ grantId: grant.id, intent: high, now: T1 }),
  ).rejects.toThrow();
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM authorization_reservations WHERE id=?")
      .get(`authorization-reservation:${high.id}`),
  ).toEqual({ count: 0 });
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM authorization_usage WHERE grant_id=?")
      .get(grant.id),
  ).toEqual({ count: 1 });
});

it("does not reuse a safe scope for a different resource, version, recipient, cost or action kind", async () => {
  const f = await fixture();
  const source = f.action("bounded-source");
  expect(await f.services.authorize(source)).toMatchObject({ decision: "ASK" });
  const grant = await f.approve(source, "long_term");
  const changes: Partial<GovernedActionIntent>[] = [
    { resourceRef: "file:other", resourceRefs: ["file:other"] },
    { capabilityVersion: "2.0.0" },
    { disclosure: "named_recipients", recipients: ["model:other"] },
    { estimatedCostMicros: 1 },
    {
      actionKind: "CREATE_OR_UPDATE",
      finalRisk: "HIGH",
      modelClassification: {
        actionKind: "CREATE_OR_UPDATE",
        suggestedRisk: "HIGH",
        reasonCode: "change",
      },
    },
  ];
  for (const [index, change] of changes.entries()) {
    const action = f.action(`outside-scope:${index}`, change);
    expect(await f.services.authorize(action), `scope case ${index}`).toMatchObject({
      decision: index === 1 ? "DENY" : "ASK",
    });
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS count FROM authorization_reservations WHERE id=?")
        .get(`authorization-reservation:${action.id}`),
    ).toEqual({ count: 0 });
  }
  expect(
    (await f.store.listGrants(OWNER_ID, AGENT_ID)).find(({ id }) => id === grant.id),
  ).toMatchObject({ uses: 0 });
});

it("binds a real coding approval to exact content and keeps changed content unapproved", async () => {
  const f = await fixture("write");
  const phases: string[] = [];
  const run = async (toolCallId: string, content: string) => {
    const call = {
      ...f.call,
      toolCallId,
      capabilityRef: `${f.input.capabilityRef}.write`,
      capabilityHandleRef: null,
      arguments: { path: "note.txt", content },
    };
    const values = new Map<string, unknown>();
    const refs = new Map<string, string>();
    const ctx: FileReadExecutionContext = {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      now: () => T1,
      authorityFence: () => SERVICE_AUTHORITY.product.fencingToken,
      workerInstanceId: () => SERVICE_AUTHORITY.workerInstanceId,
      assertActive: async () => {},
      load: async (key) => values.get(key),
      save: async (key, value) => {
        const existing = refs.get(key);
        if (existing) return { ref: existing, value: values.get(key) };
        const artifact = await f.persist(`${toolCallId}:${key}`, value);
        refs.set(key, artifact.ref);
        values.set(key, value);
        return { ref: artifact.ref, value };
      },
      // Controlled Worker boundary: consume the real Handle, never claim a file write.
      phase: async (handle, _phase, inputRef) => {
        const request = {
          ...f.input,
          receiptRef: `receipt:${toolCallId}`,
          handleRef: handle.ref,
          authorizationRef: handle.authorizationRef,
          invocationId: `invocation:${toolCallId}`,
          idempotencyKey: toolCallId,
          inputRef,
          delegatedContextRefs: [],
          requestedAt: T1,
          consumedAt: T1,
        };
        const port = f.repository.capabilityInvocationReceiptPort(OWNER_ID, AGENT_ID);
        expect(await port.consume(request)).toMatchObject({ replayed: false });
        expect(await port.consume(request)).toMatchObject({ replayed: true });
        phases.push(toolCallId);
        return {
          outcome: "succeeded",
          resultRef: "controlled-result",
          modelContent: "controlled Worker result",
          errorCode: null,
          externalActionId: null,
        };
      },
    };
    return {
      call,
      ctx,
      result: await executeProductionCodingRequest(call, "write", f.services, ctx),
    };
  };
  const first = await run("original", "first content");
  expect(first.result.outcome).toBe("awaiting_approval");
  const pending = await f.store.listApprovals(OWNER_ID, AGENT_ID);
  const original = pending.find(
    ({ intentSnapshot }) =>
      intentSnapshot.operation === "write" && intentSnapshot.id !== f.intent.id,
  );
  if (!original) throw new Error("missing coding approval");
  const grant = await f.approve(original.intentSnapshot as GovernedActionIntent, "one_time");
  expect(
    (await executeProductionCodingRequest(first.call, "write", f.services, first.ctx)).outcome,
  ).toBe("succeeded");
  expect((await run("changed", "second content")).result.outcome).toBe("awaiting_approval");
  expect(
    (
      await executeProductionCodingRequest(
        { ...first.call, arguments: { path: "note.txt", content: "changed within same call" } },
        "write",
        f.services,
        first.ctx,
      )
    ).errorCode,
  ).toBe("CODING_CONTEXT_CHANGED");
  const next = (await f.store.listApprovals(OWNER_ID, AGENT_ID)).find(
    ({ status }) => status === "pending",
  );
  expect(next).toBeDefined();
  expect(next?.intentId).not.toBe(original.intentId);
  expect(next?.semanticSnapshotHash).not.toBe(original.semanticSnapshotHash);
  expect(phases).toEqual(["original"]);
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM capability_handles WHERE authorization_ref=?")
      .get(grant.id),
  ).toEqual({ count: 1 });
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS count FROM authorization_usage WHERE grant_id=?")
      .get(grant.id),
  ).toEqual({ count: 1 });
  expect(
    (await f.store.listGrants(OWNER_ID, AGENT_ID)).find(({ id }) => id === grant.id),
  ).toMatchObject({ uses: 1, maxUses: 1 });
});
