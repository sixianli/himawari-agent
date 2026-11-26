import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ApprovalService,
  createProactiveSeal,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  GrantService,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { ProductionAppConnections } from "@himawari-agent/platform-node";
import { DeterministicIdGenerator, DeterministicPayloadProtector } from "@himawari-agent/testing";
import { afterEach, expect, it } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.js";
import { OwnerScopeAuthorization } from "../../apps/agent-service/src/owner-scope-authorization.js";
import {
  APP_ACTION_CAPABILITY_REF,
  APP_ACTION_EXTERNAL_ORIGIN,
  ProductionAppTools,
} from "../../apps/agent-service/src/production-app-tools.js";
import { ProductionRuntimeTools } from "../../apps/agent-service/src/production-runtime-tools.js";
import { productionToolActionRegistry } from "../../apps/agent-service/src/production-tool-actions.js";
import { runtimeToolFixture } from "../../apps/agent-service/test/runtime-tools.fixture.js";
import { loopbackMcpApp } from "../fixtures/loopback-mcp-app.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  RUN_ID,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

const DEADLINE = new Date(Date.parse(T1) + 600_000).toISOString();
const CLIENT = { id: "Iv1.github-app", secret: "fixture" };
const { secret } = CLIENT;
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup() {
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
  const { repository } = resource;
  closers.push(async () => {
    await repository.close();
    await rm(resource.stateRoot, { recursive: true, force: true });
  });
  const app = loopbackMcpApp(CLIENT);
  await app.start();
  closers.push(() => app.stop());
  let now = T1;
  const clock = { now: () => now };
  const advance = (milliseconds: number) => {
    now = new Date(Date.parse(now) + milliseconds).toISOString();
  };
  const definition = (name: string, title: string, trustsReadOnlyLabels: boolean) => ({
    name,
    title,
    serverUrl: `${app.origin}/mcp`,
    clientId: CLIENT.id,
    clientSecret: secret,
    trustsReadOnlyLabels,
  });
  const connections = new ProductionAppConnections({
    scope,
    store: repository.appConnections(),
    seal: createProactiveSeal({
      payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: new DeterministicPayloadProtector(),
      ids: new DeterministicIdGenerator(),
    }),
    definitions: [
      definition("github", "GitHub", true),
      definition("notes", "Notes", false),
      definition("drive", "Drive", true),
    ],
    publicOrigin: "https://himawari.example",
    now: () => clock.now(),
  });
  const connect = async (name: string) => {
    const started = await connections.begin({
      deviceId: "device-a",
      connection: name,
      callbackScheme: "win.example.himawari",
    });
    const answer = await fetch(started?.authorizationUrl ?? "", { redirect: "manual" });
    const back = new URL(answer.headers.get("location") ?? "");
    connections.callback({
      state: back.searchParams.get("state"),
      code: back.searchParams.get("code"),
      error: back.searchParams.get("error"),
      iss: back.searchParams.get("iss"),
    });
    expect(
      await connections.complete({
        deviceId: "device-a",
        state: back.searchParams.get("state") ?? "",
      }),
    ).toBe("connected");
  };
  await connect("github");
  await connect("notes");

  const registry = productionToolActionRegistry();
  const store = repository.authorizationStore();
  let sequence = 0;
  const ids = { next: (prefix: string) => `${prefix}:app-action:${++sequence}` };
  const source = repository.runExecutionSource(OWNER_ID, AGENT_ID);
  const externalContent = new ContextExternalContent({
    configuration: scope,
    state: repository,
    source,
    authority: () => SERVICE_AUTHORITY.lease,
    clock,
  });
  const ownerScope = new OwnerScopeAuthorization({
    externalContent,
    configuration: scope,
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
  });
  const f = runtimeToolFixture();
  const tools = new ProductionRuntimeTools({
    ...f.options,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    assertRunActive: async () => undefined,
    apps: new ProductionAppTools({ connections }),
    ownerScope,
    externalContent,
    toolActions: registry,
    clock,
  });
  const offered = await tools.listAuthorized(RUN_ID, []);
  const call = (toolCallId: string, args: RuntimeToolInvocation["arguments"]) =>
    ({
      runId: RUN_ID,
      toolCallId,
      capabilityRef: APP_ACTION_CAPABILITY_REF,
      capabilityHandleRef: null,
      arguments: args,
      dataClassification: "private",
      executionDeadlineAt: DEADLINE,
    }) satisfies RuntimeToolInvocation;
  const approvals = async () =>
    (await store.listApprovals(OWNER_ID, AGENT_ID)) as readonly GovernedApprovalRequest[];
  const marks = async () => (await externalContent.read(RUN_ID)).map(({ origin }) => origin).sort();
  const answer = async (pending: GovernedApprovalRequest | undefined, approved: boolean) => {
    if (!pending) throw new Error("approval expected");
    const intent = pending.intentSnapshot as GovernedActionIntent;
    const response = approved
      ? {
          decision: "approved" as const,
          recentAuthenticationRef: null,
          grant: new GrantService({ store, clock, ids }).create({
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
          }),
        }
      : { decision: "denied" as const };
    await new ApprovalService({ store, clock }).respond({
      approvalRequestId: pending.id,
      expectedRevision: pending.revision,
      semanticSnapshotHash: pending.semanticSnapshotHash,
      response,
    });
  };
  return { app, tools, offered, call, approvals, marks, answer, advance, connections };
}

const parsed = (result: { readonly modelContent: string }) =>
  JSON.parse(result.modelContent) as Record<string, unknown>;

it("[APP-1] offers one fixed app_action tool, lists connected apps and their tools, and uses an officially read-only tool without asking", async () => {
  const s = await setup();
  const tool = s.offered.find(({ name }) => name === "app_action");
  expect(tool && "parameters" in tool ? tool.parameters : undefined).toMatchObject({
    required: ["action"],
  });
  expect(JSON.stringify(tool)).not.toContain("create_issue");

  const described = await s.tools.execute(s.call("call:describe", { action: "describe" }));
  expect(described.outcome).toBe("succeeded");
  expect(parsed(described)["apps"]).toEqual([
    { app: "drive", title: "Drive", status: "disconnected" },
    {
      app: "github",
      title: "GitHub",
      status: "connected",
      tools: [
        { name: "create_issue", description: "Open an issue", asksOwner: true },
        { name: "get_me", description: "Who is signed in", asksOwner: false },
      ],
    },
    {
      app: "notes",
      title: "Notes",
      status: "connected",
      tools: [
        { name: "create_issue", description: "Open an issue", asksOwner: true },
        { name: "get_me", description: "Who is signed in", asksOwner: true },
      ],
    },
  ]);
  const detail = await s.tools.execute(
    s.call("call:detail", { action: "describe", app: "github", tool: "create_issue" }),
  );
  expect(parsed(detail)["apps"]).toMatchObject([
    {
      app: "github",
      tools: [
        {
          name: "create_issue",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
      ],
    },
  ]);

  const read = await s.tools.execute(
    s.call("call:read", { action: "call", app: "github", tool: "get_me" }),
  );
  expect(read.outcome).toBe("succeeded");
  expect(parsed(read)).toMatchObject({
    app: "github",
    tool: "get_me",
    isError: false,
    content: [{ type: "text", text: "andy" }],
  });
  expect(s.app.calls).toEqual(["get_me"]);
  expect(await s.approvals()).toEqual([]);
  expect(await s.marks()).toEqual([APP_ACTION_EXTERNAL_ORIGIN]);
});

it("[APP-2] asks the owner before a tool that is not officially read-only, runs it once after a yes, and shows the app and tool on the card", async () => {
  const s = await setup();
  const create = s.call("call:create", {
    action: "call",
    app: "github",
    tool: "create_issue",
    arguments: { title: "Fix login" },
  });
  const waiting = await s.tools.execute(create);
  expect(waiting.outcome).toBe("awaiting_approval");
  expect(s.app.calls).toEqual([]);
  const [pending] = await s.approvals();
  expect(pending).toMatchObject({
    status: "pending",
    display: { displayTitle: "GitHub · create_issue" },
  });
  expect(pending?.display?.bodyPreview).toContain("Fix login");
  expect((pending?.intentSnapshot as GovernedActionIntent).targets).toEqual(
    expect.arrayContaining([
      { type: "app", ref: "github" },
      { type: "app-tool", ref: "create_issue" },
    ]),
  );
  await s.answer(pending, true);
  s.advance(1_000);
  const done = await s.tools.execute(create);
  expect(done.outcome).toBe("succeeded");
  expect(parsed(done)).toMatchObject({ content: [{ type: "text", text: "issue #7" }] });
  expect(await s.tools.execute(create)).toEqual(done);
  expect(s.app.calls).toEqual(["create_issue:Fix login"]);
});

it("[APP-3][reverse] an app added without trusted labels asks even for a read, a no from the owner sends nothing, and unknown or unconnected apps and bad input never reach the app", async () => {
  const s = await setup();
  const read = s.call("call:notes-read", { action: "call", app: "notes", tool: "get_me" });
  expect((await s.tools.execute(read)).outcome).toBe("awaiting_approval");
  const [pending] = await s.approvals();
  expect(pending?.display?.displayTitle).toBe("Notes · get_me");
  await s.answer(pending, false);
  s.advance(1_000);
  expect((await s.tools.execute(read)).outcome).not.toBe("succeeded");

  const failures = await Promise.all(
    [
      { action: "call", app: "github", tool: "delete_repo" },
      { action: "call", app: "dropbox", tool: "get_me" },
      { action: "call", app: "drive", tool: "get_me" },
      { action: "call", app: "github" },
      { action: "run", app: "github", tool: "get_me" },
      { action: "call", app: "github", tool: "get_me", arguments: [] },
      { action: "describe", extra: true },
    ].map((args, index) => s.tools.execute(s.call(`call:bad:${index}`, args))),
  );
  expect(failures.map((result) => [result.outcome, result.errorCode])).toEqual([
    ["failed", "APP_ACTION_UNKNOWN"],
    ["failed", "APP_ACTION_UNKNOWN"],
    ["failed", "APP_ACTION_NOT_CONNECTED"],
    ["failed", "APP_ACTION_INVALID"],
    ["failed", "APP_ACTION_INVALID"],
    ["failed", "APP_ACTION_INVALID"],
    ["failed", "APP_ACTION_INVALID"],
  ]);
  expect(s.app.calls).toEqual([]);
  expect(await s.connections.disconnect("github")).toBe(true);
  const gone = await s.tools.execute(
    s.call("call:after-disconnect", { action: "call", app: "github", tool: "get_me" }),
  );
  expect(gone.errorCode).toBe("APP_ACTION_NOT_CONNECTED");
  expect(s.app.calls).toEqual([]);
});
