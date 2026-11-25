import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type PayloadProtectorPort,
  PORT_ERROR_CODES,
  ProductThreadGatewayAdapter,
  ThreadCommandService,
  ThreadQueryService,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunId,
  createSessionId,
  type ProductAuthorityFence,
} from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { THREAD_GATEWAY_SCHEMA_VERSION } from "@himawari-agent/gateway-contracts";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.ts";
import { OwnerScopeAuthorization } from "../../apps/agent-service/src/owner-scope-authorization.ts";
import { ProductionMainThread } from "../../apps/agent-service/src/production-main-thread.ts";
import {
  OfferOptionsInputError,
  ProductionMessageOptions,
} from "../../apps/agent-service/src/production-message-options.ts";
import { productionToolActionRegistry } from "../../apps/agent-service/src/production-tool-actions.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-options");
const AGENT_ID = createAgentId("agent-options");
const DEPLOYMENT_ID = createDeploymentId("deployment-options");
const LEASE_ID = createAuthorityLeaseId("lease-options");
const START = "2026-11-25T00:00:00.000Z";
const authority: ProductAuthorityFence = {
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 1,
  fencingToken: 1,
};
const phone = {
  subjectId: "owner",
  ownerId: OWNER_ID,
  deviceId: "device-phone",
  authenticatedAt: START,
  authenticationRef: "auth-phone",
  sessionId: "session-phone",
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];

async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-options-"));
  directories.push(stateRoot);
  await mkdir(path.join(stateRoot, "data"));
  const file = path.join(stateRoot, "data", "product.sqlite");
  await copyMigratedDatabase(file);
  const database = openQualifiedDatabase(file);
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments
      (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
      VALUES (?, ?, ?, 0, 'active', 1, 1)`,
    )
    .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases
      (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch, fencing_token,
        acquired_at, expires_at)
      VALUES (?, ?, ?, ?, 'holder-options', 1, 1, ?, '2026-11-26T00:00:00.000Z')`,
    )
    .run(LEASE_ID, OWNER_ID, AGENT_ID, DEPLOYMENT_ID, START);
  database.close();
  const now = () => START;
  const repository = await SqliteProductStateRepository.open({
    stateRoot,
    databasePath: file,
    minimumFreeBytes: 0,
    now,
  });
  closers.push(() => repository.close());
  const protector: PayloadProtectorPort = createReferenceAdapterSet().payloadProtector;
  const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
  const threads = repository.threadRepository();
  const commands = new ThreadCommandService({
    repository: threads,
    clock: { now },
    authority: () => authority,
  });
  const mainThread = new ProductionMainThread({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    threads,
    commands,
    payloads,
    protector,
    clock: { now },
  });
  const lease = () => ({ leaseId: LEASE_ID, fencingToken: 1 });
  const registry = productionToolActionRegistry();
  const options = new ProductionMessageOptions({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    state: repository,
    authority: lease,
    registry,
    threads,
    commands,
    payloads,
    protector,
    clock: { now },
  });
  let sequence = 0;
  const externalContent = new ContextExternalContent({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    state: repository,
    source: repository.runExecutionSource(OWNER_ID, AGENT_ID),
    authority: lease,
    clock: { now },
  });
  const ownerScope = new OwnerScopeAuthorization({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    externalContent,
    optionGrants: options,
    store: repository.authorizationStore(),
    audit: repository.auditLedger(),
    state: repository,
    authority: lease,
    source: repository.runExecutionSource(OWNER_ID, AGENT_ID),
    installedCapabilities: { inspect: async () => undefined },
    registry,
    clock: { now },
    ids: { next: (scope: string) => `${scope}:options:${++sequence}` },
    intentLifetimeMs: 600_000,
  });
  const adapter = new ProductThreadGatewayAdapter({
    messageOptions: options,
    repository: threads,
    checkpoints: repository.threadDistillationState(),
    commands,
    queries: new ThreadQueryService(threads),
    forks: {} as never,
    deletion: {} as never,
    clock: { now },
  });
  const query = <T>(sql: string, ...parameters: unknown[]) => {
    const handle = openQualifiedDatabase(file);
    try {
      return handle.prepare(sql).all(...parameters) as T[];
    } finally {
      handle.close();
    }
  };
  const write = async (ref: string, content: string) => {
    await payloads.put(
      await protector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref,
        contentType: "text/plain",
        dataClassification: "private",
        plaintext: new TextEncoder().encode(content),
        createdAt: now(),
      }),
    );
  };
  const text = async (ref: string) => {
    const payload = await payloads.get(ref as never);
    if (!payload) return undefined;
    return new TextDecoder().decode(
      await protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload }),
    );
  };
  const main = await mainThread.ensure();
  const revision = async () => (await threads.read(OWNER_ID, AGENT_ID, main))?.revision ?? 0;
  let said = 0;
  const ownerSays = async (words: string) => {
    said += 1;
    await write(`owner-words-${said}`, words);
    await commands.admitOwnerMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: main,
      expectedThreadRevision: await revision(),
      sessionId: createSessionId("session-phone"),
      idempotencyKey: `owner-${said}`,
      contentRef: `owner-words-${said}` as never,
      sourceProofRef: "device:phone",
      dataClassification: "private",
      resultRef: `owner-words-${said}` as never,
      runId: createRunId(`run:owner-${said}`),
    });
    return createRunId(`run:owner-${said}`);
  };
  const answer = async (runId: ReturnType<typeof createRunId>, words: string) => {
    const turn = query<{ id: string }>("SELECT id FROM turns WHERE run_id = ?", runId)[0];
    if (!turn) throw new Error("turn missing");
    await write(`answer:${runId}`, words);
    await commands.commitAssistantMessage({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      threadId: main,
      expectedThreadRevision: await revision(),
      turnId: turn.id as never,
      runId,
      idempotencyKey: `answer:${runId}`,
      contentRef: `answer:${runId}` as never,
      dataClassification: "private",
      resultRef: `answer:${runId}` as never,
    });
  };
  const offer = (runId: ReturnType<typeof createRunId>, listed: unknown, call = "call-1") =>
    options.offer({
      runId,
      toolCallId: call,
      capabilityRef: "owner.options.offer",
      capabilityHandleRef: null,
      arguments: { options: listed } as never,
      dataClassification: "private",
      context: { threadId: main } as never,
    }) as Promise<{ setId: string; options: { optionId: string; label: string }[] }>;
  const detail = async () => {
    const result = await adapter.query({
      authentication: phone,
      query: {
        schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
        kind: "query",
        type: "thread.detail",
        messageId: "detail-1",
        correlationId: "correlation-1",
        causationId: null,
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        authority,
        actor: { actorType: "owner", actorId: OWNER_ID },
        payload: { threadId: main, afterSequence: 0, limit: 100 },
      } as never,
    });
    return (result.payload as unknown as { messages: Record<string, unknown>[] }).messages;
  };
  let commandNumber = 0;
  const choose = async (messageId: string, setId: string, optionId: string, key?: string) => {
    commandNumber += 1;
    return adapter.execute({
      authentication: phone,
      command: {
        schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
        kind: "command",
        type: "thread.option.choose",
        messageId: `choose-${commandNumber}`,
        correlationId: `correlation-choose-${commandNumber}`,
        causationId: null,
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        authority,
        actor: { actorType: "owner", actorId: OWNER_ID },
        idempotencyKey: key ?? `device-${commandNumber}`,
        payload: { threadId: main, messageId, setId, optionId },
      } as never,
    });
  };
  const agentMessage = async (runId: string) => {
    const message = (await detail()).find(
      (item) => item["runId"] === runId && item["role"] === "agent",
    );
    if (!message) throw new Error("answer missing");
    return message as { messageId: string; options: { items: Record<string, unknown>[] } | null };
  };
  const rule = registry.forTool("rule_set");
  if (!rule) throw new Error("rule_set row missing");
  const authorize = (runId: string, text: string, call = "call-rule") =>
    ownerScope.authorize(
      {
        runId: createRunId(runId),
        toolCallId: call,
        capabilityRef: rule.capabilityRef as string,
        capabilityHandleRef: null,
        arguments: { text },
        dataClassification: "private",
        context: { threadId: main } as never,
      },
      rule,
      async (_key, value) => value,
    );
  const chose = (runId: string, args: Record<string, unknown>, tool = "rule_set") =>
    options.ownerChose(
      {
        runId: createRunId(runId),
        toolCallId: "call-chose",
        capabilityRef: rule.capabilityRef as string,
        capabilityHandleRef: null,
        arguments: args as never,
        dataClassification: "private",
        context: { threadId: main } as never,
      },
      tool,
    );
  return {
    chose,
    externalContent,
    main,
    ownerSays,
    answer,
    offer,
    detail,
    choose,
    agentMessage,
    authorize,
    text,
    query,
  };
}

describe("options under her messages", () => {
  useSqliteContractExecution("direct");
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("[OPTIONS-1] shows her next steps under her answer and sends a plain option as the owner's words", async () => {
    const f: Fixture = await fixture();
    const run = await f.ownerSays("新 iPhone 什么时候发售");
    const offered = await f.offer(run, [
      { label: "查哪家最便宜" },
      { label: "发售前一天提醒我", reason: "你说过想第一时间买" },
    ]);
    await f.answer(run, "9 月 19 日发售。");
    const message = await f.agentMessage(run);
    expect(message.options?.items).toEqual([
      { optionId: "o1", label: "查哪家最便宜", reason: null, action: null, state: "open" },
      {
        optionId: "o2",
        label: "发售前一天提醒我",
        reason: "你说过想第一时间买",
        action: null,
        state: "open",
      },
      { optionId: "dismiss", label: "不用了", reason: null, action: null, state: "open" },
    ]);
    const result = await f.choose(message.messageId, offered.setId, "o1");
    expect(result.kind).toBe("result");
    const chosen = (await f.detail()).filter((item) => item["chosenFrom"] !== null);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toMatchObject({
      role: "owner",
      chosenFrom: { setId: offered.setId, optionId: "o1" },
    });
    expect(await f.text(chosen[0]?.["contentRef"] as string)).toBe("查哪家最便宜");
    expect(f.query("SELECT 1 FROM runs WHERE id LIKE 'run:option:%'")).toHaveLength(1);
    expect((await f.agentMessage(run)).options?.items.map(({ state }) => state)).toEqual([
      "open",
      "open",
      "open",
    ]);
  });

  it("[OPTIONS-2] gives no options when she offers none", async () => {
    const f = await fixture();
    const run = await f.ownerSays("好的谢谢");
    await f.answer(run, "不客气。");
    expect((await f.agentMessage(run)).options).toBeNull();
    expect((await f.detail()).every((item) => item["chosenFrom"] === null)).toBe(true);
  });

  it("[OPTIONS-3] labels an action from its real arguments, runs it once for two taps, and lets exactly those arguments through", async () => {
    const f = await fixture();
    const run = await f.ownerSays("工作日晚上别推送了");
    const offered = await f.offer(run, [
      {
        label: "好的",
        action: { tool: "rule_set", arguments: { text: "工作日晚上十点后不推送" } },
      },
    ]);
    await f.answer(run, "要我立这条规则吗？");
    const message = await f.agentMessage(run);
    expect(message.options?.items[0]).toMatchObject({
      label: "立规则: 工作日晚上十点后不推送",
      action: { tool: "rule_set" },
      state: "open",
    });
    expect((await f.choose(message.messageId, offered.setId, "o1", "tap-1")).kind).toBe("result");
    expect((await f.choose(message.messageId, offered.setId, "o1", "tap-2")).kind).toBe("result");
    const runs = f.query<{ id: string }>("SELECT id FROM runs WHERE id LIKE 'run:option:%'");
    expect(runs).toHaveLength(1);
    const chosenRun = runs[0]?.id as string;
    expect((await f.agentMessage(run)).options?.items[0]?.["state"]).toBe("chosen");
    await f.externalContent.mark(createRunId(chosenRun), "mail_read");
    const changed = await f.authorize(chosenRun, "工作日晚上九点后不推送", "call-changed");
    expect(changed.decision).not.toBe("ALLOW");
    const exact = await f.authorize(chosenRun, "工作日晚上十点后不推送", "call-exact");
    expect(exact.decision).toBe("ALLOW");
    const again = await f.authorize(chosenRun, "工作日晚上十点后不推送", "call-again");
    expect(again.decision).not.toBe("ALLOW");
  });

  it("[OPTIONS-4] greys out an action once the owner typed something else, and refuses a late tap", async () => {
    const f = await fixture();
    const run = await f.ownerSays("帮我立条规则");
    const offered = await f.offer(run, [
      { label: "x", action: { tool: "rule_set", arguments: { text: "周末不推送" } } },
      { label: "再想想" },
    ]);
    await f.answer(run, "这样可以吗？");
    await f.ownerSays("算了，换个话题");
    const message = await f.agentMessage(run);
    expect(message.options?.items.map(({ state }) => state)).toEqual(["stale", "open", "open"]);
    const late = await f.choose(message.messageId, offered.setId, "o1");
    expect(late.kind).toBe("conflict");
    expect(f.query("SELECT 1 FROM runs WHERE id LIKE 'run:option:%'")).toEqual([]);
  });

  it("[OPTIONS-6] refuses options that name a read-only or unknown tool", async () => {
    const f = await fixture();
    const run = await f.ownerSays("你好");
    await expect(
      f.offer(run, [{ label: "x", action: { tool: "mail_read", arguments: { threadId: "t" } } }]),
    ).rejects.toBeInstanceOf(OfferOptionsInputError);
    await expect(
      f.offer(run, [{ label: "x", action: { tool: "nope", arguments: {} } }]),
    ).rejects.toBeInstanceOf(OfferOptionsInputError);
    await expect(f.offer(run, [])).rejects.toBeInstanceOf(OfferOptionsInputError);
  });

  it("[OPTIONS-7] rejects a tap on a set that is not under that message", async () => {
    const f = await fixture();
    const run = await f.ownerSays("你好");
    await f.answer(run, "你好呀");
    const message = await f.agentMessage(run);
    await expect(f.choose(message.messageId, "set:missing", "o1")).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_FOUND,
    });
  });

  it("[OPTIONS-8] counts a rule as the owner's own only in the run the tap started and only with the arguments shown", async () => {
    const f = await fixture();
    const run = await f.ownerSays("入管局的邮件别漏了");
    const shown = { quote: "入管局的邮件别漏了", inferred: true, type: "mail_must_notify" };
    const offered = await f.offer(run, [
      { label: "立规则", action: { tool: "rule_set", arguments: shown } },
    ]);
    await f.answer(run, "要我以后一律提醒你入管局的邮件吗？");
    expect(await f.chose(run, shown)).toBe(false);
    const message = await f.agentMessage(run);
    await f.choose(message.messageId, offered.setId, "o1");
    const chosenRun = f.query<{ id: string }>("SELECT id FROM runs WHERE id LIKE 'run:option:%'")[0]
      ?.id as string;
    expect(await f.chose(chosenRun, shown)).toBe(true);
    expect(await f.chose(chosenRun, { ...shown, type: "soft" })).toBe(false);
    expect(await f.chose(chosenRun, shown, "reminder_set")).toBe(false);
    expect(await f.chose(run, shown)).toBe(false);
  });
});
