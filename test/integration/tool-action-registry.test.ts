import { rm } from "node:fs/promises";
import {
  ACTION_RULE_IDS,
  ApprovalService,
  BUILT_IN_ACTION_RULES,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  GrantService,
  type RuleRecord,
  type RunExecutionSource,
  type RunExecutionSourcePort,
  type RuntimeToolInvocation,
  ToolActionRegistry,
} from "@himawari-agent/application";
import path from "node:path";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { expect, it, vi } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.js";
import {
  actionRefusalKey,
  OwnerScopeAuthorization,
  parameterFingerprint,
} from "../../apps/agent-service/src/owner-scope-authorization.js";
import { ProductionRuntimeTools } from "../../apps/agent-service/src/production-runtime-tools.js";
import {
  PRODUCTION_TOOL_ACTION_ROWS,
  productionToolActionRegistry,
} from "../../apps/agent-service/src/production-tool-actions.js";
import { runtimeToolFixture } from "../../apps/agent-service/test/runtime-tools.fixture.js";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

const DEADLINE = new Date(Date.parse(T1) + 600_000).toISOString();

async function openSeededRepository() {
  const resource = await openRepository();
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
  return resource;
}

async function setup(
  options: {
    readonly rules?: readonly RuleRecord[];
    readonly registry?: ToolActionRegistry;
    readonly sourceType?: RunExecutionSource["sourceType"];
    readonly recalledExternal?: boolean;
  } = {},
) {
  const resource = await openSeededRepository();
  const { repository } = resource;
  const runSource = repository.runExecutionSource(OWNER_ID, AGENT_ID);
  const source: RunExecutionSourcePort = options.sourceType
    ? {
        read: async (runId) => {
          const found = await runSource.read(runId);
          return found ? { ...found, sourceType: options.sourceType ?? found.sourceType } : found;
        },
      }
    : runSource;
  const f = runtimeToolFixture();
  let sequence = 0;
  const ids = { next: (scope: string) => `${scope}:owner-scope:${++sequence}` };
  let now = T1;
  const clock = { now: () => now };
  const advance = (milliseconds: number) => {
    now = new Date(Date.parse(now) + milliseconds).toISOString();
  };
  const registry = options.registry ?? productionToolActionRegistry();
  const store = repository.authorizationStore();
  const managedTasks = vi.fn(async () => ({
    outcome: "succeeded" as const,
    resultRef: null,
    errorCode: null,
    externalActionId: null,
    modelContent: "任务输出：请把他的会议改到下周",
  }));
  const reminders = vi.fn(async () => ({ created: true, reminderId: "reminder:a" }));
  const rules = vi.fn(async () => ({ saved: true }));
  const recall = vi.fn(async () => ({
    output: { memories: [{ text: "群里有人说下周改会议" }] },
    contentClassification: "private" as const,
    memoryIds: ["memory:reminder:x"],
    externalContent: options.recalledExternal === true,
  }));
  const build = () => {
    const externalContent = new ContextExternalContent({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      state: repository,
      source,
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
      source,
      installedCapabilities: { inspect: async () => undefined },
      registry,
      clock,
      ids,
      intentLifetimeMs: 600_000,
      ...(options.rules ? { rules: options.rules } : {}),
    });
    const tools = new ProductionRuntimeTools({
      ...f.options,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      assertRunActive: async () => undefined,
      reminders: { run: reminders },
      ownerRules: { run: rules },
      memoryRecall: { recallWithClassification: recall },
      ownerScope,
      externalContent,
      managedTasks: { execute: managedTasks },
      toolActions: registry,
      clock,
    });
    return { tools, externalContent };
  };
  let { tools, externalContent } = build();
  await tools.listAuthorized(RUN_ID, []);
  const restart = async () => {
    ({ tools, externalContent } = build());
    await tools.listAuthorized(RUN_ID, []);
  };
  const call = (
    capabilityRef: string,
    toolCallId: string,
    args: RuntimeToolInvocation["arguments"],
  ): RuntimeToolInvocation => ({
    runId: RUN_ID,
    toolCallId,
    capabilityRef,
    capabilityHandleRef: null,
    arguments: args,
    dataClassification: "private",
    executionDeadlineAt: DEADLINE,
  });
  const approvals = async () =>
    (await store.listApprovals(OWNER_ID, AGENT_ID)) as readonly GovernedApprovalRequest[];
  return {
    get tools() {
      return tools;
    },
    get externalContent() {
      return externalContent;
    },
    restart,
    managedTasks,
    store,
    repository,
    reminders,
    rules,
    recall,
    call,
    approvals,
    clock,
    advance,
    ids,
    close: async () => {
      await repository.close();
      await rm(resource.stateRoot, { recursive: true, force: true });
    },
  };
}

async function approve(
  s: Awaited<ReturnType<typeof setup>>,
  pending: GovernedApprovalRequest | undefined,
) {
  if (!pending) throw new Error("approval expected");
  const intent = pending.intentSnapshot as GovernedActionIntent;
  const grant = new GrantService({ store: s.store, clock: s.clock, ids: s.ids }).create({
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
  });
  await new ApprovalService({ store: s.store, clock: s.clock }).respond({
    approvalRequestId: pending.id,
    expectedRevision: pending.revision,
    semanticSnapshotHash: pending.semanticSnapshotHash,
    response: { decision: "approved", grant, recentAuthenticationRef: null },
  });
}

it("[ADR-0257] sets a reminder and a rule through the permission engine, preauthorized by the built-in action rule and recorded", async () => {
  const s = await setup();
  try {
    const set = s.call("reminder.set", "call:set", { text: "交周报", due: "2026-11-13T15:00" });
    expect((await s.tools.preflight(set)).allowed).toBe(true);
    const first = await s.tools.execute(set);
    expect(first).toMatchObject({ outcome: "succeeded", errorCode: null });
    expect(await s.tools.execute(set)).toEqual(first);
    expect(s.reminders).toHaveBeenCalledTimes(1);
    const [approval] = await s.approvals();
    expect(await s.approvals()).toHaveLength(1);
    expect(approval).toMatchObject({
      status: "approved",
      finalRisk: "MEDIUM",
      recentAuthenticationRequired: false,
      policyAuthorization: {
        key: `action-rule:${ACTION_RULE_IDS.preauthorizeOwnerData}`,
        revision: 1,
      },
    });
    const snapshot = approval?.intentSnapshot as GovernedActionIntent;
    expect(snapshot).toMatchObject({
      capabilityRef: "reminder.set",
      operation: "set",
      actionKind: "CREATE_OR_UPDATE",
      disclosure: "none",
      recipients: [],
      threadId: "thread-capability-invocation",
    });
    expect(snapshot.deterministicFacts).toEqual([
      { code: "run_source_user_message", minimumRisk: "LOW", source: "runtime" },
    ]);
    expect((await s.store.listGrants(OWNER_ID, AGENT_ID)).map(({ kind }) => kind)).toEqual([
      "one_time",
    ]);
    const audit = await s.repository.auditLedger().listByAgent(AGENT_ID, null);
    expect(audit.map(({ action }) => action)).toContain("authorization.action_rule.preauthorized");

    const rule = s.call("rule.set", "call:rule", { text: "以后账单邮件都提醒我" });
    expect(await s.tools.execute(rule)).toMatchObject({ outcome: "succeeded" });
    expect(s.rules).toHaveBeenCalledTimes(1);
    const ruleApproval = (await s.approvals()).find(
      ({ intentSnapshot }) => intentSnapshot.capabilityRef === "rule.set",
    );
    expect(
      (ruleApproval?.intentSnapshot as GovernedActionIntent).deterministicFacts.map(
        ({ code }) => code,
      ),
    ).toEqual(["run_source_user_message", "standing_rule_change"]);
    expect(ruleApproval?.finalRisk).toBe("MEDIUM");

    const list = s.call("reminder.list", "call:list", {});
    expect(await s.tools.execute(list)).toMatchObject({ outcome: "succeeded" });
    expect(await s.approvals()).toHaveLength(2);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] waits for the owner when no rule preauthorizes the action, and runs once after the owner approves", async () => {
  const s = await setup({ rules: [] });
  try {
    const set = s.call("reminder.set", "call:ask", { text: "交周报", due: "2026-11-13T15:00" });
    const waiting = await s.tools.execute(set);
    expect(waiting).toMatchObject({ outcome: "awaiting_approval" });
    s.advance(5_000);
    expect(await s.tools.execute(set)).toEqual(waiting);
    expect(s.reminders).not.toHaveBeenCalled();
    const [pending] = await s.approvals();
    expect(await s.approvals()).toHaveLength(1);
    expect(pending).toMatchObject({ status: "pending", recentAuthenticationRequired: false });
    expect(pending?.policyAuthorization).toBeUndefined();
    await approve(s, pending);
    s.advance(5_000);
    const done = await s.tools.execute(set);
    expect(done).toMatchObject({ outcome: "succeeded" });
    s.advance(5_000);
    expect(await s.tools.execute(set)).toEqual(done);
    expect(s.reminders).toHaveBeenCalledTimes(1);
    expect(await s.approvals()).toHaveLength(1);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] two identical calls at the same moment share one approval and run once", async () => {
  const s = await setup();
  try {
    const set = s.call("reminder.set", "call:twice", { text: "交周报", due: "2026-11-13T15:00" });
    const [left, right] = await Promise.all([s.tools.execute(set), s.tools.execute(set)]);
    expect(left).toMatchObject({ outcome: "succeeded" });
    expect(right).toEqual(left);
    expect(s.reminders).toHaveBeenCalledTimes(1);
    expect(await s.approvals()).toHaveLength(1);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] a new revision of the built-in rule keeps the owner's switch: still on stays on, switched off stays off", async () => {
  const revised = { ...(BUILT_IN_ACTION_RULES[0] as RuleRecord), revision: 2 };
  const s = await setup({ rules: [revised] });
  try {
    const key = `action-rule:${ACTION_RULE_IDS.preauthorizeOwnerData}`;
    const write = (value: { enabled: boolean; ruleRevision: number }, revision: number | null) =>
      s.repository.commitStateAndEvents({
        command: {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          commandType: "authorization.action_rule.set",
          idempotencyKey: `seed:${JSON.stringify(value)}` as never,
          commandFingerprint: JSON.stringify(value),
          authority: SERVICE_AUTHORITY.lease,
        },
        state: { key, expectedRevision: revision, value: { ...value, actorId: OWNER_ID } },
        events: [],
        resultRef: key,
        committedAt: T1,
      });
    await write({ enabled: true, ruleRevision: 1 }, null);
    const first = s.call("reminder.set", "call:r2", { text: "交周报", due: "2026-11-13T15:00" });
    expect(await s.tools.execute(first)).toMatchObject({ outcome: "succeeded" });
    const renewed = await s.repository.readScopedState(OWNER_ID, AGENT_ID, key);
    expect(renewed?.value).toMatchObject({ enabled: true, ruleRevision: 2 });
    const [approval] = await s.approvals();
    expect(approval?.policyAuthorization).toEqual({ key, revision: renewed?.revision });
    await write({ enabled: false, ruleRevision: 1 }, renewed?.revision ?? null);
    const second = s.call("reminder.set", "call:r2-off", {
      text: "交月报",
      due: "2026-11-14T15:00",
    });
    expect(await s.tools.execute(second)).toMatchObject({ outcome: "awaiting_approval" });
    expect(s.reminders).toHaveBeenCalledTimes(1);
    const off = await s.repository.readScopedState(OWNER_ID, AGENT_ID, key);
    expect(off?.value).toMatchObject({ enabled: false, ruleRevision: 1 });
  } finally {
    await s.close();
  }
});

it("[ADR-0257] asks the owner again once the standing authorization behind the rule is switched off", async () => {
  const s = await setup();
  try {
    const key = `action-rule:${ACTION_RULE_IDS.preauthorizeOwnerData}`;
    const first = s.call("reminder.set", "call:on", { text: "交周报", due: "2026-11-13T15:00" });
    expect(await s.tools.execute(first)).toMatchObject({ outcome: "succeeded" });
    const recorded = await s.repository.readScopedState(OWNER_ID, AGENT_ID, key);
    expect(recorded?.value).toMatchObject({ enabled: true, ruleRevision: 1 });
    await s.repository.commitStateAndEvents({
      command: {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        commandType: "authorization.action_rule.set",
        idempotencyKey: "switch-off" as never,
        commandFingerprint: "switch-off",
        authority: SERVICE_AUTHORITY.lease,
      },
      state: {
        key,
        expectedRevision: recorded?.revision ?? null,
        value: { enabled: false, ruleRevision: 1, actorId: OWNER_ID },
      },
      events: [],
      resultRef: key,
      committedAt: T1,
    });
    const second = s.call("reminder.set", "call:off", { text: "交月报", due: "2026-11-14T15:00" });
    expect(await s.tools.execute(second)).toMatchObject({ outcome: "awaiting_approval" });
    expect(s.reminders).toHaveBeenCalledTimes(1);
    const pending = (await s.approvals()).filter(({ status }) => status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.policyAuthorization).toBeUndefined();
  } finally {
    await s.close();
  }
});

it("[ADR-0257] does nothing and asks nobody when an action rule refuses", async () => {
  const preauthorize = BUILT_IN_ACTION_RULES[0] as RuleRecord;
  const refuse: RuleRecord = {
    ...preauthorize,
    id: "action_test_refuse",
    outcome: "refuse",
    expression: 'action_kind == "CREATE_OR_UPDATE"',
    examples: [],
  };
  const s = await setup({ rules: [preauthorize, refuse] });
  try {
    const result = await s.tools.execute(
      s.call("reminder.cancel", "call:refused", { reminderId: "reminder:a" }),
    );
    expect(result).toMatchObject({
      outcome: "failed",
      errorCode: "action_rule_refused",
      dispatchState: "not_sent",
    });
    expect(result.modelContent).toContain("操作未执行");
    expect(s.reminders).not.toHaveBeenCalled();
    expect(await s.approvals()).toHaveLength(0);
    const audit = await s.repository.auditLedger().listByAgent(AGENT_ID, null);
    expect(audit.map(({ action }) => action)).toContain("authorization.action_rule.refused");
  } finally {
    await s.close();
  }
});

it("[ADR-0257] refuses a built-in tool whose capability is missing from the built-in list", async () => {
  const row = PRODUCTION_TOOL_ACTION_ROWS.find(({ tool }) => tool === "reminder_set");
  if (!row) throw new Error("row expected");
  const resource = await openSeededRepository();
  try {
    const authorization = new OwnerScopeAuthorization({
      configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
      store: resource.repository.authorizationStore(),
      audit: resource.repository.auditLedger(),
      state: resource.repository,
      authority: () => SERVICE_AUTHORITY.lease,
      source: resource.repository.runExecutionSource(OWNER_ID, AGENT_ID),
      installedCapabilities: { inspect: async () => undefined },
      registry: new ToolActionRegistry(
        PRODUCTION_TOOL_ACTION_ROWS.filter(({ tool }) => tool !== "reminder_set"),
      ),
      clock: { now: () => T1 },
      ids: { next: (scope) => `${scope}:1` },
      intentLifetimeMs: 600_000,
    });
    const decision = await authorization.authorize(
      {
        runId: RUN_ID,
        toolCallId: "call:missing",
        capabilityRef: "reminder.set",
        capabilityHandleRef: null,
        arguments: { text: "x", due: "2026-11-13T15:00" },
        dataClassification: "private",
        executionDeadlineAt: DEADLINE,
      },
      row,
      async (_key, value) => value,
    );
    expect(decision).toMatchObject({ decision: "DENY", reasonCode: "capability_not_registered" });
  } finally {
    await resource.repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  }
});

it("[ADR-0257] asks the owner before setting a reminder once a task's output is in the conversation, and keeps asking after a restart", async () => {
  const s = await setup();
  try {
    const output = s.call("execution.task.output", "call:output", { taskId: "task:a" });
    expect(await s.tools.execute(output)).toMatchObject({ outcome: "succeeded" });
    expect(await s.externalContent.read(RUN_ID)).toEqual([
      expect.objectContaining({ origin: "execution_task_output", firstRunId: RUN_ID }),
    ]);
    const set = s.call("reminder.set", "call:after-output", {
      text: "改会议",
      due: "2026-11-13T15:00",
    });
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "awaiting_approval" });
    expect(s.reminders).not.toHaveBeenCalled();
    const [pending] = await s.approvals();
    expect(pending).toMatchObject({
      status: "pending",
      display: {
        askedBecause: {
          kind: "rule",
          ruleId: ACTION_RULE_IDS.askAfterExternalContent,
          ruleText: expect.stringContaining("execution_task_output"),
        },
      },
    });
    expect(pending?.policyAuthorization).toBeUndefined();
    expect(
      (pending?.intentSnapshot as GovernedActionIntent).deterministicFacts.map(({ code }) => code),
    ).toEqual(["context_external_content", "run_source_user_message"]);

    await s.restart();
    const again = s.call("reminder.set", "call:after-restart", {
      text: "改会议",
      due: "2026-11-13T16:00",
    });
    expect(await s.tools.execute(again)).toMatchObject({ outcome: "awaiting_approval" });
    expect(s.reminders).not.toHaveBeenCalled();
    expect((await s.approvals()).filter(({ status }) => status === "pending")).toHaveLength(2);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] keeps reading the owner's own data without marking the conversation, so later reminders stay preauthorized", async () => {
  const s = await setup();
  try {
    expect(await s.tools.execute(s.call("reminder.list", "call:list", {}))).toMatchObject({
      outcome: "succeeded",
    });
    expect(await s.externalContent.read(RUN_ID)).toEqual([]);
    const set = s.call("reminder.set", "call:own", { text: "交周报", due: "2026-11-13T15:00" });
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "succeeded" });
    expect(s.reminders).toHaveBeenCalledTimes(2);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] refuses a scheduled run's reminder once external content is in context, records what it wanted, and creates no approval", async () => {
  const s = await setup({ sourceType: "schedule" });
  try {
    await s.tools.execute(s.call("execution.task.output", "call:output", { taskId: "task:a" }));
    const args = { due: "2026-11-13T15:00", text: "付款" };
    const set = s.call("reminder.set", "call:background", args);
    expect(await s.tools.execute(set)).toMatchObject({
      outcome: "failed",
      errorCode: "action_rule_refused",
      dispatchState: "not_sent",
    });
    expect(s.reminders).not.toHaveBeenCalled();
    expect(await s.approvals()).toEqual([]);
    const audit = (await s.repository.auditLedger().listByAgent(AGENT_ID, null)).find(
      ({ action }) => action === "authorization.action_rule.refused",
    );
    expect(audit?.targetRef).toMatch(/^action-refusal:owner-scope:/);
    const refusal = await s.repository.readScopedState(OWNER_ID, AGENT_ID, audit?.targetRef ?? "");
    expect(refusal?.value).toMatchObject({
      ruleId: ACTION_RULE_IDS.refuseBackgroundAfterExternalContent,
      runSource: "schedule",
      tool: "reminder_set",
      capabilityRef: "reminder.set",
      parameterFingerprint: parameterFingerprint({ text: "付款", due: "2026-11-13T15:00" }),
      externalSources: ["execution_task_output"],
    });
    expect(audit?.targetRef).toBe(actionRefusalKey(String(refusal?.value["intentId"])));
  } finally {
    await s.close();
  }
});

it("[ADR-0257] lets a scheduled run set a reminder when nothing external is in context", async () => {
  const s = await setup({ sourceType: "schedule" });
  try {
    const set = s.call("reminder.set", "call:schedule", {
      text: "交周报",
      due: "2026-11-13T15:00",
    });
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "succeeded" });
    expect(s.reminders).toHaveBeenCalledTimes(1);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] treats an external-event run as external content even before any tool reads anything", async () => {
  const s = await setup({ sourceType: "external_event" });
  try {
    const set = s.call("reminder.set", "call:event", { text: "付款", due: "2026-11-13T15:00" });
    expect(await s.tools.execute(set)).toMatchObject({
      outcome: "failed",
      errorCode: "action_rule_refused",
    });
    expect(await s.externalContent.read(RUN_ID)).toEqual([
      expect.objectContaining({ origin: "external_event" }),
    ]);
  } finally {
    await s.close();
  }
});

it("[ADR-0257] stops the run's own task through the exit without asking, even after external content", async () => {
  const s = await setup();
  try {
    await s.tools.execute(s.call("execution.task.output", "call:output", { taskId: "task:a" }));
    const cancel = s.call("execution.task.cancel", "call:cancel", { taskId: "task:a" });
    expect(await s.tools.execute(cancel)).toMatchObject({ outcome: "succeeded" });
    expect(s.managedTasks).toHaveBeenCalledTimes(2);
    const approval = (await s.approvals()).find(
      ({ intentSnapshot }) => intentSnapshot.capabilityRef === "execution.task.cancel",
    );
    expect(approval).toMatchObject({
      status: "approved",
      policyAuthorization: { key: `action-rule:${ACTION_RULE_IDS.preauthorizeOwnTaskCancel}` },
    });
  } finally {
    await s.close();
  }
});

it("[ADR-0257] asks the owner before stopping a task when no built-in rule preauthorizes it", async () => {
  const s = await setup({
    rules: BUILT_IN_ACTION_RULES.filter(
      ({ id }) => id !== ACTION_RULE_IDS.preauthorizeOwnTaskCancel,
    ),
  });
  try {
    const cancel = s.call("execution.task.cancel", "call:cancel-ask", { taskId: "task:a" });
    expect(await s.tools.execute(cancel)).toMatchObject({ outcome: "awaiting_approval" });
    expect(s.managedTasks).not.toHaveBeenCalled();
  } finally {
    await s.close();
  }
});

it("[ADR-0257] hands the conversation's external sources to the reminder it sets after the owner approves", async () => {
  const s = await setup();
  try {
    await s.tools.execute(s.call("execution.task.output", "call:output", { taskId: "task:a" }));
    const set = s.call("reminder.set", "call:approved", {
      text: "改会议",
      due: "2026-11-13T15:00",
    });
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "awaiting_approval" });
    await approve(s, (await s.approvals())[0]);
    s.advance(5_000);
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "succeeded" });
    expect(s.reminders).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "call:approved" }),
      {
        externalOrigins: ["execution_task_output"],
      },
    );
  } finally {
    await s.close();
  }
});

it("[ADR-0257] gives the owner's own reminders no external sources when nothing external was read", async () => {
  const s = await setup();
  try {
    const set = s.call("reminder.set", "call:own", { text: "交周报", due: "2026-11-13T15:00" });
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "succeeded" });
    expect(s.reminders).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "call:own" }),
      {},
    );
  } finally {
    await s.close();
  }
});

it("[ADR-0257] counts a recalled memory written from external content as external, so the next reminder asks", async () => {
  const s = await setup({ recalledExternal: true });
  try {
    const recalled = s.call("memory.recall", "call:recall", { query: "会议", limit: 3 });
    expect(await s.tools.execute(recalled)).toMatchObject({ outcome: "succeeded" });
    expect(await s.externalContent.read(RUN_ID)).toEqual([
      expect.objectContaining({ origin: "recalled_external_record" }),
    ]);
    const set = s.call("reminder.set", "call:after-recall", {
      text: "改会议",
      due: "2026-11-13T15:00",
    });
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "awaiting_approval" });
    expect(s.reminders).not.toHaveBeenCalled();
  } finally {
    await s.close();
  }
});

it("[ADR-0257] leaves the conversation unmarked when recalled memories carry no external source", async () => {
  const s = await setup({ recalledExternal: false });
  try {
    const recalled = s.call("memory.recall", "call:recall", { query: "会议", limit: 3 });
    expect(await s.tools.execute(recalled)).toMatchObject({ outcome: "succeeded" });
    expect(await s.externalContent.read(RUN_ID)).toEqual([]);
    const set = s.call("reminder.set", "call:after-recall", {
      text: "交周报",
      due: "2026-11-13T15:00",
    });
    expect(await s.tools.execute(set)).toMatchObject({ outcome: "succeeded" });
  } finally {
    await s.close();
  }
});
