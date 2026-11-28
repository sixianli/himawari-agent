import { spawn } from "node:child_process";
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
  type AppCodeComputer,
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

const DEADLINE = new Date(Date.now() + 600_000).toISOString();
const CLIENT = { id: "Iv1.github-app", secret: "fixture" };
const { secret } = CLIENT;
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };

const execs: { readonly ownerId: string; readonly allowedDomains: readonly string[] }[] = [];
const localComputer: AppCodeComputer = {
  exec: (input) =>
    new Promise((resolve, reject) => {
      execs.push({ ownerId: input.ownerId, allowedDomains: input.allowedDomains });
      const [command, ...rest] = input.argv;
      const child = spawn(command ?? "", rest, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        Date.parse(input.deadlineAt) - Date.now(),
      );
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 124,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
          truncated: false,
        });
      });
      child.stdin.end(Buffer.from(input.stdin));
    }),
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  execs.splice(0);
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup(options: { readonly computer?: boolean } = {}) {
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
    const answer = await fetch(started?.kind === "browser" ? started.authorizationUrl : "", {
      redirect: "manual",
    });
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
    apps: new ProductionAppTools({
      connections,
      ...(options.computer === false
        ? {}
        : { code: { computer: localComputer, ownerId: OWNER_ID } }),
    }),
    ownerScope,
    externalContent,
    toolActions: registry,
    clock,
  });
  await tools.listAuthorized(RUN_ID, []);
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
  const run = (toolCallId: string, code: string) => call(toolCallId, { action: "run", code });
  return { app, tools, call, run, approvals, answer, advance, execs, marks };
}

const parsed = (result: { readonly modelContent: string }) =>
  JSON.parse(result.modelContent) as Record<string, unknown>;

const CHAIN = [
  "const me = await apps.github.get_me({});",
  'const first = await apps.github.create_issue({ title: "Fix login for " + me });',
  'const second = await apps.github.create_issue({ title: "Fix logout for " + me });',
  'console.log("made", first, second);',
  "return { me, issues: [first, second] };",
].join("\n");

it("[CODE-1] runs model-written code in the computer with no network, stops at each call that asks, and after each yes replays without repeating earlier calls", async () => {
  const s = await setup();
  const job = s.run("call:code-chain", CHAIN);

  const first = await s.tools.execute(job);
  expect(first.outcome).toBe("awaiting_approval");
  expect(s.app.calls).toEqual(["get_me"]);
  const [card] = await s.approvals();
  expect(card?.display?.displayTitle).toBe("GitHub · create_issue");
  expect(card?.display?.bodyPreview).toContain("Fix login for andy");
  await s.answer(card, true);
  s.advance(1_000);

  const second = await s.tools.execute(job);
  expect(second.outcome).toBe("awaiting_approval");
  expect(s.app.calls).toEqual(["get_me", "create_issue:Fix login for andy"]);
  const pending = (await s.approvals()).filter(({ status }) => status === "pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]?.id).not.toBe(card?.id);
  expect(pending[0]?.display?.bodyPreview).toContain("Fix logout for andy");
  await s.answer(pending[0], true);
  s.advance(1_000);

  const done = await s.tools.execute(job);
  expect(done.outcome).toBe("succeeded");
  expect(parsed(done)).toMatchObject({
    value: { me: "andy", issues: ["issue #7", "issue #7"] },
    logs: ["made issue #7 issue #7"],
    calls: [
      { app: "github", tool: "get_me", isError: false },
      { app: "github", tool: "create_issue", isError: false },
      { app: "github", tool: "create_issue", isError: false },
    ],
  });
  expect(s.app.calls).toEqual([
    "get_me",
    "create_issue:Fix login for andy",
    "create_issue:Fix logout for andy",
  ]);
  expect(await s.marks()).toEqual(["app_action"]);
  expect(await s.tools.execute(job)).toEqual(done);
  expect(s.app.calls).toHaveLength(3);
  expect(
    s.execs.every(
      ({ ownerId, allowedDomains }) => ownerId === OWNER_ID && allowedDomains.length === 0,
    ),
  ).toBe(true);
});

it("[CODE-2][reverse] a no from the owner ends the code at that step, sends nothing after it and does not repeat what was already done", async () => {
  const s = await setup();
  const job = s.run("call:code-denied", CHAIN);
  await s.tools.execute(job);
  await s.answer((await s.approvals())[0], true);
  s.advance(1_000);
  await s.tools.execute(job);
  const pending = (await s.approvals()).find(({ status }) => status === "pending");
  await s.answer(pending, false);
  s.advance(1_000);
  const ended = await s.tools.execute(job);
  expect(ended.outcome).not.toBe("succeeded");
  expect(ended.outcome).not.toBe("awaiting_approval");
  expect(s.app.calls).toEqual(["get_me", "create_issue:Fix login for andy"]);
});

it("[CODE-3][reverse] code that calls with different arguments on replay is stopped, and a call to an app that asks never goes out without a yes", async () => {
  const s = await setup();
  const random = await s.tools.execute(
    s.run(
      "call:code-random",
      "await apps.github.get_me({ nonce: Math.random() }); return await apps.github.get_me({});",
    ),
  );
  expect(random.errorCode).toBe("APP_CODE_NOT_REPEATABLE");
  expect(s.app.calls).toEqual(["get_me"]);

  const notes = await s.tools.execute(
    s.run("call:code-notes", "return await apps.notes.get_me({});"),
  );
  expect(notes.outcome).toBe("awaiting_approval");
  expect(s.app.calls).toEqual(["get_me"]);
});

it("[CODE-4] the code sees app errors as exceptions it can catch, its own errors come back to the model, and bad input never runs", async () => {
  const s = await setup();
  const caught = await s.tools.execute(
    s.run(
      "call:code-caught",
      "try { await apps.github.delete_repo({}); } catch (error) { return String(error.message); }",
    ),
  );
  expect(caught.outcome).toBe("succeeded");
  expect(String(parsed(caught)["value"])).toContain("APP_ACTION_UNKNOWN");
  expect(parsed(caught)["calls"]).toEqual([{ app: "github", tool: "delete_repo", isError: true }]);

  const thrown = await s.tools.execute(s.run("call:code-throws", "throw new Error('boom');"));
  expect(thrown.outcome).toBe("succeeded");
  expect(parsed(thrown)).toMatchObject({ error: "Error: boom", calls: [] });

  const syntax = await s.tools.execute(s.run("call:code-syntax", "return (;"));
  expect(String(parsed(syntax)["error"])).toContain("SyntaxError");

  const bad = await Promise.all(
    [
      { action: "run" },
      { action: "run", code: "" },
      { action: "run", code: "return 1;", app: "github" },
      { action: "call", app: "github", tool: "get_me", code: "return 1;" },
    ].map((args, index) => s.tools.execute(s.call(`call:code-bad:${index}`, args))),
  );
  expect(bad.map(({ errorCode }) => errorCode)).toEqual([
    "APP_ACTION_INVALID",
    "APP_ACTION_INVALID",
    "APP_ACTION_INVALID",
    "APP_ACTION_INVALID",
  ]);
  expect(s.app.calls).toEqual([]);
});

it("[CODE-5] describe gives each tool's code signature from the server's own schema, and without a computer run is refused while call still works", async () => {
  const s = await setup({ computer: false });
  const described = await s.tools.execute(
    s.call("call:describe-create", { action: "describe", app: "github", tool: "create_issue" }),
  );
  expect(parsed(described)).toMatchObject({
    apps: [
      { tools: [{ code: "apps.github.create_issue(input: { title: string }): Promise<string>" }] },
    ],
  });
  const refused = await s.tools.execute(s.run("call:code-off", "return 1;"));
  expect(refused.errorCode).toBe("APP_CODE_UNAVAILABLE");
  const direct = await s.tools.execute(
    s.call("call:direct", { action: "call", app: "github", tool: "get_me" }),
  );
  expect(direct.outcome).toBe("succeeded");
  expect(s.execs).toEqual([]);
});
