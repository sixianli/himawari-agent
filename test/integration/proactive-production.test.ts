import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProactiveSeal,
  DEFAULT_REVIEW_PREREVIEW,
  type ModelDescriptor,
  type ModelInvocationEvent,
  ownerRuleRecord,
  type WebPushSendRequest,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  type GatewayV2Command,
  type GatewayV2Query,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  CALENDAR_READONLY_SCOPE,
  createDemoGoogleOAuth,
  createDemoMailReader,
  createGmailReader,
  createGoogleOAuth,
  demoMailboxToken,
  GMAIL_READONLY_SCOPE,
  readGmailAccount,
} from "@himawari-agent/platform-node";
import { MAIL_REFERENCE_EXTRACTION } from "@himawari-agent/prompt-catalog";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
  ScriptedModelPort,
} from "@himawari-agent/testing";
import Fastify from "fastify";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { registerProactiveRoutes } from "../../apps/agent-service/src/production-http-composition.ts";
import {
  createProactivePushSource,
  PROACTIVE_GOOGLE_CALLBACK_PATH,
  PROACTIVE_GOOGLE_START_PATH,
  ProductionProactive,
  type ProductionProactiveOptions,
} from "../../apps/agent-service/src/production-proactive.ts";
import {
  ProductionWebPush,
  WebPushPresence,
} from "../../apps/agent-service/src/production-web-push.ts";
import { launchChromium } from "../fixtures/chromium-launch.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-proactive-production");
const AGENT_ID = createAgentId("agent-proactive-production");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOV_4_10AM_JST = "2026-11-04T01:00:00.000Z";
const ORIGIN = "https://himawari.example";
const MODEL_REF = "proactive-production-model";

const descriptor: ModelDescriptor = {
  ref: MODEL_REF,
  provider: "deterministic",
  model: MODEL_REF,
  version: "1.0.0",
  routingClass: "primary",
  priority: 10,
  disclosure: "trusted_remote",
  capabilities: ["text"],
  allowedDataClassifications: ["public", "private"],
  secretRequirement: null,
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function message(kind: "command" | "query", type: string, payload: unknown) {
  return gatewayV2MessageSchema.parse({
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message-${type}`,
    correlationId: `correlation-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: kind === "command" ? "authorization-01" : null,
    scope,
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: "owner-subject" },
    ...(kind === "command" ? { idempotencyKey: `idempotency-${type}-${Math.random()}` } : {}),
    payload,
  });
}

function fakeGoogle() {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url, method: init.method ?? "GET", body });
    const target = new URL(url);
    if (target.href === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code")
        return form.get("code") === "code-1"
          ? json({
              refresh_token: "refresh-1",
              access_token: "access-1",
              scope: `${GMAIL_READONLY_SCOPE} ${CALENDAR_READONLY_SCOPE}`,
            })
          : json({ error: "invalid_grant" }, 400);
      return json({ access_token: "access-1", expires_in: 3600 });
    }
    if (target.href === "https://oauth2.googleapis.com/revoke") return json({});
    if (new Headers(init.headers).get("authorization") !== "Bearer access-1") return json({}, 401);
    if (target.pathname.endsWith("/profile"))
      return json({ emailAddress: "Andy@Example.com", historyId: "777" });
    if (target.pathname.endsWith("/messages"))
      return json({ messages: [{ id: "invoice" }, { id: "sale" }] });
    if (target.pathname.endsWith("/threads/thread-invoice"))
      return json({
        messages: [
          {
            id: "invoice-earlier",
            threadId: "thread-invoice",
            labelIds: [],
            snippet: "",
            internalDate: String(Date.parse("2026-10-30T00:00:00.000Z")),
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "SMBC <billing@smbc.co.jp>" },
                { name: "Subject", value: "ご請求のお知らせ(前回)" },
              ],
              body: {
                size: 12,
                data: Buffer.from("前回の請求は分割払いです").toString("base64url"),
              },
            },
          },
        ],
      });
    const id = target.pathname.split("/").at(-1);
    const headers = (from: string, subject: string) => [
      { name: "From", value: from },
      { name: "Subject", value: subject },
    ];
    if (id === "invoice")
      return json({
        id,
        threadId: "thread-invoice",
        labelIds: ["INBOX", "CATEGORY_UPDATES"],
        snippet: "ご利用代金 12,000 円を 11/5 までにお支払いください",
        internalDate: String(Date.parse("2026-11-04T00:20:00.000Z")),
        payload: { headers: headers("SMBC <billing@smbc.co.jp>", "ご請求のお知らせ") },
      });
    if (id === "sale")
      return json({
        id,
        threadId: "thread-sale",
        labelIds: ["INBOX", "SPAM"],
        snippet: "今だけ 50% オフ",
        internalDate: String(Date.parse("2026-11-04T00:10:00.000Z")),
        payload: { headers: headers("Shop <news@shop.example>", "セール") },
      });
    return json({}, 404);
  };
  return { calls, fetch };
}

describe("[PG-12] proactive Gmail checks in the running service", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(
    options: {
      readonly demoInbox?: "ja" | "en";
      readonly ruleReview?: ProductionProactiveOptions["ruleReview"];
    } = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-proactive-production-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(NOV_4_10AM_JST);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    closers.push(() => repository.close());
    const ids = new DeterministicIdGenerator();
    const store = repository.proactive();
    const protector = new DeterministicPayloadProtector();
    const payloadStore = repository.payloadStore(OWNER_ID, AGENT_ID);
    const seal = createProactiveSeal({ payloads: payloadStore, protector, ids });
    const written = new Set<string>();
    const writePayload = async (ref: string, content: string) => {
      await payloadStore.put(
        await protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref,
          dataClassification: "private",
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(content),
          createdAt: clock.now(),
        }),
      );
      written.add(ref);
    };
    const readPayload = async (ref: string) => {
      const payload = await payloadStore.get(ref);
      if (!payload) return undefined;
      return new TextDecoder().decode(await protector.unprotect({ payload }));
    };
    const google = fakeGoogle();
    const oauth = options.demoInbox
      ? createDemoGoogleOAuth()
      : createGoogleOAuth({
          clientId: "client-1",
          clientSecret: "test-secret",
          redirectUri: `${ORIGIN}${PROACTIVE_GOOGLE_CALLBACK_PATH}`,
          fetch: google.fetch,
        });
    const outputs = new Map<string, string>();
    let scripted = new ScriptedModelPort([descriptor], []);
    const prompts: string[] = [];
    const referencePrompts: string[] = [];
    const script = (items: readonly Record<string, unknown>[]) => {
      const ref = `output-${outputs.size + 1}`;
      outputs.set(ref, JSON.stringify({ items }));
      const events: ModelInvocationEvent[] = [
        { type: "model.started", invocationId: "scripted", occurredAt: clock.now() },
        {
          type: "model.output",
          invocationId: "scripted",
          sequence: 1,
          payloadRef: ref,
          occurredAt: clock.now(),
        },
        {
          type: "model.completed",
          invocationId: "scripted",
          inputTokens: 300,
          outputTokens: 40,
          costMicros: 400,
          latencyMs: 10,
          occurredAt: clock.now(),
        },
      ];
      scripted = new ScriptedModelPort([descriptor], events);
    };
    const webPushStore = repository.webPush();
    const failures: unknown[] = [];
    const proactive = new ProductionProactive({
      scope,
      configuration: {
        modelRef: MODEL_REF,
        ...(options.demoInbox
          ? { demoInbox: options.demoInbox }
          : { gmail: { clientId: "client-1", clientSecretRef: "google-oauth" } }),
        intervalMs: 900_000,
        perCheckMs: 180_000,
        dailyCostMicros: 1_000_000,
        bodyCharactersPerMail: 16_000,
        bodyCharactersPerBatch: 64_000,
        relatedMailsPerMail: 6,
        relatedCharactersPerMail: 12_000,
        relatedCharactersPerRelatedMail: 2_000,
        relatedRequestsPerCheck: 300,
        wholeThreadMailsPerMail: 50,
        wholeThreadCharactersPerMail: 60_000,
        ruleReplayDays: 30,
        ruleReplayMailsPerOutcome: 300,
        memoryMinimumSimilarity: 0.45,
        reviewBudgetSeconds: 120,
        reviewSecondsPerItem: 5,
        reviewSilentSharePermille: 500,
        reviewPrereview: DEFAULT_REVIEW_PREREVIEW,
        reviewMemoryUnusedDays: 90,
        backoffThreshold: 3,
      },
      timeZone: "Asia/Tokyo",
      store,
      seal,
      oauth,
      reader: options.demoInbox
        ? createDemoMailReader({ now: () => clock.now() })
        : createGmailReader({ oauth, fetch: google.fetch }),
      readAccount: (accessToken) => readGmailAccount({ accessToken, fetch: google.fetch }),
      ledger: repository.decisionLedger(),
      ownerRules: repository.ownerRules(),
      readMemoryText: readPayload,
      model: {
        get model() {
          return scripted;
        },
        modelRef: MODEL_REF,
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        async prepare({ invocationId, prompt }) {
          (prompt.startsWith(MAIL_REFERENCE_EXTRACTION.text) ? referencePrompts : prompts).push(
            prompt,
          );
          const inputRef = `input-${invocationId}`;
          await writePayload(inputRef, prompt);
          for (const [ref, content] of outputs)
            if (!written.has(ref)) await writePayload(ref, content);
          return {
            runId: `proactive:${invocationId}` as never,
            inputRef,
            allowedDisclosureRef: inputRef,
            secretHandleRefs: [],
            release: async () => undefined,
          };
        },
        readOutput: async (ref) => (await readPayload(ref)) ?? "",
        release: async (refs) => {
          for (const ref of refs) await payloadStore.delete(ref);
        },
      },
      estimateCostMicros: () => 1_000,
      feedback: (sentFrom) => webPushStore.listFeedback({ ...scope, sentFrom, limit: 500 }),
      clock,
      ids,
      ...(options.ruleReview ? { ruleReview: options.ruleReview } : {}),
      onFailure: (error) => failures.push(error),
    });
    const sent: WebPushSendRequest[] = [];
    const presence = new WebPushPresence();
    const push = new ProductionWebPush({
      ...scope,
      store: webPushStore,
      sender: {
        publicKey: "public-key",
        send: async (request) => {
          sent.push(request);
          return { kind: "sent" };
        },
      },
      presence,
      reminders: { listDue: async () => [], read: async () => undefined },
      memories: { readMany: async () => [] },
      readMemoryText: async () => undefined,
      listApprovals: async () => [],
      awaitingCount: async () => 0,
      runThread: async () => null,
      threadTitle: async () => null,
      proactive: createProactivePushSource({ scope, store, seal }),
      publicOrigin: ORIGIN,
      timeZone: "Asia/Tokyo",
      now: () => clock.now(),
      onFailure: (error) => failures.push(error),
    });
    await webPushStore.saveSubscription({
      ...scope,
      id: "iphone",
      endpoint: "https://web.push.apple.com/iphone",
      p256dh: "key-iphone",
      auth: "auth-iphone",
      locale: "zh-CN",
      deviceLabel: "iPhone",
      now: clock.now(),
    });
    await webPushStore.writeKinds({ ...scope, kinds: ["reminder"], now: clock.now() });
    const app = Fastify();
    closers.push(() => app.close());
    registerProactiveRoutes(app, proactive, {
      authentication: {
        authenticate: async (input) => {
          if (input.sessionToken !== "owner-session") throw new Error("UNAUTHENTICATED");
          return {
            subjectId: "owner-subject",
            ownerId: OWNER_ID,
            deviceId: "device-1",
            authenticatedAt: clock.now(),
            authenticationRef: "session-1",
          };
        },
      },
      sessionCookieName: "himawari_session",
      ownerId: OWNER_ID,
    });
    const overview = async () => {
      const snapshot = await proactive.query(
        message("query", "proactive.overview.read", {}) as GatewayV2Query,
      );
      gatewayV2MessageSchema.parse(snapshot);
      if (snapshot.type !== "proactive.overview.snapshot") throw new Error("unexpected snapshot");
      return snapshot.payload;
    };
    const command = (type: string, payload: unknown) =>
      proactive.execute(message("command", type, payload) as GatewayV2Command);
    const review = async () => {
      const snapshot = await proactive.query(
        message("query", "proactive.review.read", {}) as GatewayV2Query,
      );
      gatewayV2MessageSchema.parse(snapshot);
      if (snapshot.type !== "proactive.review.snapshot") throw new Error("unexpected snapshot");
      return snapshot.payload;
    };
    return {
      app,
      ledger: repository.decisionLedger(),
      ownerRules: repository.ownerRules(),
      review,
      writePayload,
      clock,
      command,
      failures,
      google,
      overview,
      presence,
      proactive,
      prompts,
      push,
      referencePrompts,
      script,
      seal,
      sent,
      store,
      stateRoot,
      webPushStore,
    };
  }

  const cookie = { cookie: "himawari_session=owner-session" };

  async function connect(h: Awaited<ReturnType<typeof setup>>) {
    const start = await h.app.inject({
      method: "GET",
      url: PROACTIVE_GOOGLE_START_PATH,
      headers: { ...cookie, "sec-fetch-site": "same-origin" },
    });
    expect(start.statusCode).toBe(303);
    const google = new URL(String(start.headers["location"]));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${PROACTIVE_GOOGLE_CALLBACK_PATH}`,
    );
    return google.searchParams.get("state") ?? "";
  }

  it("[PG-12] connects Gmail through Google, checks the inbox and pushes one reminder in the owner's language", async () => {
    const h = await setup();
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: PROACTIVE_GOOGLE_START_PATH,
          headers: { ...cookie, "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await h.app.inject({ method: "GET", url: PROACTIVE_GOOGLE_START_PATH })).statusCode,
    ).toBe(401);
    const forged = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=forged&code=code-1`,
      headers: cookie,
    });
    expect(forged.headers["location"]).toBe("/?settings=apps&gmail=failed");
    expect((await h.overview()).connection.status).toBe("disconnected");

    const state = await connect(h);
    h.script([
      {
        id: "invoice",
        result: "act",
        confidence: "sure",
        todo: "11/5 前付清 SMBC 账单 12,000 円",
        priority: "high",
        dueAt: "2026-11-05T14:59:00.000Z",
        reason: "",
      },
    ]);
    const callback = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1&scope=x`,
      headers: cookie,
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers["location"]).toBe("/?settings=apps&gmail=connected");
    await h.proactive.stop();
    const replay = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1`,
      headers: cookie,
    });
    expect(replay.headers["location"]).toBe("/?settings=apps&gmail=failed");

    const first = await h.overview();
    expect(first.connection).toMatchObject({ status: "connected", account: "andy@example.com" });
    expect(first.enabled).toBe(true);
    expect(first.insights).toMatchObject([
      {
        result: "act",
        summary: "11/5 前付清 SMBC 账单 12,000 円",
        subject: "ご請求のお知らせ",
        priority: "high",
        pushed: true,
      },
    ]);
    expect(first.decisions).toMatchObject([
      { verdict: "pushed", reasonCode: "URGENT", counts: { fetched: 2, skipped: 1, act: 1 } },
    ]);
    expect(h.prompts).toHaveLength(1);
    expect(h.referencePrompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("ご請求のお知らせ");
    expect(h.prompts[0]).not.toContain("セール");
    expect(h.prompts[0]).toContain("前回の請求は分割払いです");

    await h.push.tick();
    await h.push.tick();
    expect(h.sent).toHaveLength(1);
    const notification = JSON.parse(h.sent[0]?.payload ?? "{}").notification;
    expect(notification).toMatchObject({
      title: "邮件里有件事要你处理",
      navigate: `${ORIGIN}/?reminder=${encodeURIComponent(first.insights[0]?.id ?? "")}`,
      lang: "zh-CN",
    });
    expect(notification.body).toContain("11/5 前付清 SMBC 账单");
    expect((await h.overview()).insights[0]?.pushReaction).toBeNull();
    await h.webPushStore.recordReactions({
      ...scope,
      reactions: [{ tag: notification.tag, reaction: "opened", occurredAt: h.clock.now() }],
      now: h.clock.now(),
    });
    expect((await h.overview()).insights[0]).toMatchObject({
      pushed: true,
      pushReaction: "opened",
    });
    expect(
      h.google.calls.filter(
        ({ url, method }) => url.startsWith("https://gmail.googleapis.com/") && method !== "GET",
      ),
    ).toEqual([]);
    expect(h.google.calls.some(({ url }) => url.includes("calendar"))).toBe(false);
    expect(h.google.calls.some(({ url }) => url.includes("/threads/thread-invoice"))).toBe(true);
    expect(h.failures).toEqual([]);
  });

  const smbcRule = {
    type: "mail_must_notify",
    summary: "SMBC 的邮件一律提醒",
    params: { senderDomains: ["smbc.co.jp"] },
  };
  const ignoreInvoice = (h: Awaited<ReturnType<typeof setup>>) =>
    h.script([{ id: "invoice", result: "ignore", confidence: "sure", money: "yes", reason: "" }]);
  const checkInbox = async (h: Awaited<ReturnType<typeof setup>>) => {
    const state = await connect(h);
    await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1&scope=x`,
      headers: cookie,
    });
    await h.proactive.stop();
  };

  it("[P2-3] enforces an owner rule stored in the database on the production mail check", async () => {
    const h = await setup();
    await h.ownerRules.create({
      ...scope,
      ruleId: "owner:smbc",
      parameters: smbcRule,
      source: "chat:thread-1",
      sourceMemoryId: "memory:rule:smbc",
      now: h.clock.now(),
    });
    ignoreInvoice(h);
    await checkInbox(h);
    expect((await h.overview()).insights).toMatchObject([
      { result: "check", subject: "ご請求のお知らせ", pushed: true },
    ]);
    expect(h.failures).toEqual([]);
  });

  it("[P2-3] replays a new rule over past decisions and counts the mail it would have changed", async () => {
    const h = await setup();
    ignoreInvoice(h);
    await checkInbox(h);
    expect((await h.overview()).insights).toMatchObject([{ result: "know", pushed: false }]);
    const rule = ownerRuleRecord({
      ruleId: "owner:smbc",
      revision: 1,
      status: "active",
      source: "test",
      parameters: smbcRule,
    });
    expect(await h.proactive.replayRule(rule)).toMatchObject({
      days: 30,
      mailsChecked: 1,
      mailsHit: 1,
      changed: 1,
      usefulChanged: [],
      truncated: false,
    });
    const elsewhere = ownerRuleRecord({
      ruleId: "owner:elsewhere",
      revision: 1,
      status: "active",
      source: "test",
      parameters: { ...smbcRule, params: { senderDomains: ["isa.go.jp"] } },
    });
    expect(await h.proactive.replayRule(elsewhere)).toMatchObject({
      mailsChecked: 1,
      mailsHit: 0,
      changed: 0,
    });
  });

  it("[PG-12] finishes connecting when the browser holds back the strict session cookie on Google's cross-site return", async () => {
    const h = await setup();
    const state = await connect(h);
    h.script([]);
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const himawari = `http://localhost:${(h.app.server.address() as AddressInfo).port}`;
    const callback = `${himawari}${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1&scope=x`;
    const google = createServer((request, response) => {
      if (request.url === "/continue") response.writeHead(302, { location: callback }).end();
      else
        response
          .writeHead(200, { "content-type": "text/html" })
          .end('<a id="continue" href="/continue">Continue</a>');
    });
    await new Promise<void>((resolve) => google.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => google.close(() => resolve())));
    const browser = await launchChromium(chromium);
    closers.push(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "himawari_session",
        value: "owner-session",
        domain: "localhost",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(google.address() as AddressInfo).port}/`);
    await page.click("#continue");
    await page.waitForURL(`${himawari}/?settings=apps&gmail=connected`, { timeout: 5_000 });
    await h.proactive.stop();
    expect((await h.overview()).connection.status).toBe("connected");
    const signedOut = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1&return=1`,
    });
    expect(signedOut.statusCode).toBe(303);
    expect(signedOut.headers["location"]).toBe("/?settings=apps&gmail=failed");
  }, 20_000);

  it("[PG-12] lets the owner tune, mark done, rate and disconnect, which revokes Google access and forgets the mail", async () => {
    const h = await setup();
    const state = await connect(h);
    h.script([
      {
        id: "invoice",
        result: "act",
        confidence: "sure",
        todo: "付 SMBC 账单",
        priority: "high",
        dueAt: "2026-11-05T14:59:00.000Z",
        reason: "",
      },
    ]);
    await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1`,
      headers: cookie,
    });
    await h.proactive.stop();
    const before = await h.overview();
    const insightId = before.insights[0]?.id ?? "";
    const decisionId = before.decisions[0]?.id ?? "";

    await h.command("proactive.settings.set", {
      enabled: true,
      quietHours: [{ days: [6, 0], start: "22:00", end: "08:00" }],
      importantSenders: ["Teacher@School.example", "@city.shinjuku.lg.jp"],
    });
    await h.command("proactive.insight.respond", { insightId, action: "rate", rating: "useful" });
    await h.command("proactive.decision.rate", { decisionId, rating: "useful" });
    const tuned = await h.overview();
    expect(tuned.quietHours).toEqual([{ days: [0, 6], start: "22:00", end: "08:00" }]);
    expect(tuned.importantSenders).toEqual(["teacher@school.example", "@city.shinjuku.lg.jp"]);
    expect(() =>
      h.command("proactive.settings.set", {
        enabled: true,
        quietHours: [{ days: [6, 0], start: "22:00", end: "08:00" }],
        importantSenders: ["\ud800@school.example"],
      }),
    ).toThrow("importantSenders");
    expect((await h.overview()).importantSenders).toEqual(tuned.importantSenders);
    expect(tuned.insights[0]?.rating).toBe("useful");
    expect(tuned.decisions[0]?.rating).toBe("useful");
    expect(tuned.metrics.hits).toBe(1);

    await h.command("proactive.insight.respond", { insightId, action: "done", rating: null });
    expect((await h.overview()).insights).toEqual([]);
    await h.push.tick();
    expect(h.sent).toEqual([]);
    await expect(
      h.command("proactive.insight.respond", {
        insightId: "missing-insight",
        action: "done",
        rating: null,
      }),
    ).rejects.toThrow("PROACTIVE_RECORD_NOT_FOUND");

    await h.command("proactive.source.manage", { source: "gmail", action: "disconnect" });
    const revoke = h.google.calls.find(({ url }) => url === "https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(revoke?.body).get("token")).toBe("refresh-1");
    const after = await h.overview();
    expect(after.connection).toEqual({ status: "disconnected", account: null, connectedAt: null });
    expect(after.insights).toEqual([]);
    await h.command("proactive.source.manage", { source: "gmail", action: "clear_records" });
    expect((await h.overview()).decisions).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it("[PA-6] shows a backed-off class in the overview and restores it through the command, and rejects restoring what is not backed off", async () => {
    const h = await setup();
    await connectAndCheck(h);
    expect((await h.overview()).backoff).toEqual([]);
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    database
      .prepare(
        `INSERT INTO proactive_push_backoff (
          owner_id, agent_id, class_key, stage, since_at, last_push_at, stage_changed_at,
          step_decision_id, ignored_count, restored_at, updated_at
        ) VALUES (?, ?, 'due:service.example.com', 2, ?, NULL, ?, NULL, 3, NULL, ?)`,
      )
      .run(
        OWNER_ID,
        AGENT_ID,
        "2026-11-03T00:00:00.000Z",
        "2026-11-03T00:00:00.000Z",
        "2026-11-03T00:00:00.000Z",
      );
    database.close();
    expect((await h.overview()).backoff).toEqual([
      {
        classKey: "due:service.example.com",
        domain: "service.example.com",
        stage: 2,
        ignoredCount: 3,
        changedAt: "2026-11-03T00:00:00.000Z",
      },
    ]);
    await expect(
      h.command("proactive.backoff.restore", { classKey: "due:other.example.org" }),
    ).rejects.toThrow("PROACTIVE_RECORD_NOT_FOUND");
    expect((await h.overview()).backoff).toHaveLength(1);
    await h.command("proactive.backoff.restore", { classKey: "due:service.example.com" });
    expect((await h.overview()).backoff).toEqual([]);
    await expect(h.command("proactive.backoff.restore", { classKey: null })).rejects.toThrow(
      "PROACTIVE_RECORD_NOT_FOUND",
    );
    expect(h.failures).toEqual([]);
  });

  async function connectAndCheck(h: Awaited<ReturnType<typeof setup>>) {
    const state = await connect(h);
    h.script([
      { id: "invoice", result: "ignore", confidence: "sure" },
      { id: "sale", result: "ignore", confidence: "sure" },
    ]);
    await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1`,
      headers: cookie,
    });
    await h.proactive.stop();
  }

  const candidate = (
    id: string,
    outcome: "discarded" | "kept" | "pending_approval",
    reasonCode: string,
    contentRef: string | null,
    decidedAt: string,
  ) => ({
    id,
    ...scope,
    kind: "memory_candidate" as const,
    decidedAt,
    outcome,
    reasonCode,
    subjectRef: `subject-${id}`,
    inputs: { memoryIds: [], ruleIds: [] },
    reasonRef: null,
    contentRef,
    costMicros: 0,
    durationMs: 0,
    category: "preference" as const,
    confidencePermille: 500,
    inferred: false,
  });

  it("[P0-6] puts skipped memories and a sample of Gmail decisions on the daily review, folds the rest, and keeps ratings after a reload", async () => {
    const h = await setup();
    await connectAndCheck(h);
    await h.writePayload("memory-text-1", "我最近想吃牛肉");
    const at = h.clock.now();
    await h.ledger.append(
      candidate("skipped-1", "discarded", "transient_ignored", "memory-text-1", at),
    );
    await h.ledger.append(candidate("secret-1", "discarded", "restricted_excluded", null, at));
    await h.ledger.append(candidate("rejected-1", "discarded", "approval_rejected", null, at));
    await h.ledger.append(candidate("kept-1", "kept", "auto_committed", null, at));
    await h.ledger.append({
      ...candidate("merge-1", "kept", "merge", null, at),
      kind: "consolidation",
      outcome: "merge",
      category: null,
      confidencePermille: null,
      inferred: null,
    });
    await h.ledger.append({
      ...candidate("degrade-1", "kept", "degraded", null, at),
      kind: "retrieval_degrade",
      outcome: "degraded",
      category: null,
      confidencePermille: null,
      inferred: null,
    });

    const first = await h.review();
    const keys = first.items.map(({ key }) => key);
    expect(keys).toContain("ledger:skipped-1");
    expect(keys).toContain("ledger:secret-1");
    expect(keys).not.toContain("ledger:rejected-1");
    expect(keys).toContain("ledger:kept-1");
    expect(keys).toContain("ledger:merge-1");
    expect(keys).not.toContain("ledger:degrade-1");
    expect(first.folded.total).toBe(1);
    expect(first.folded.items.map(({ key }) => key)).toEqual(["ledger:degrade-1"]);
    expect(first.items.find(({ key }) => key === "ledger:skipped-1")).toMatchObject({
      text: "我最近想吃牛肉",
      textHidden: false,
      acted: false,
      rating: null,
    });
    expect(first.items.find(({ key }) => key === "ledger:secret-1")).toMatchObject({
      text: "",
      textHidden: true,
      category: "preference",
    });
    const check = first.items.find(({ kind }) => kind === "proactive");
    expect(check).toMatchObject({ outcome: "silent", acted: false, fetched: 2, rating: null });
    expect(first.capacity).toBe(24);
    expect(first.sampled).toBe(first.items.length);
    expect(first.notSampled).toBe(0);

    await h.command("proactive.review.rate", {
      ratings: [
        { key: "ledger:skipped-1", rating: "useful" },
        { key: "ledger:secret-1", rating: "missed" },
        { key: check?.key ?? "", rating: "missed" },
      ],
    });
    const second = await h.review();
    expect(second.items.map(({ key }) => key)).toEqual(keys);
    expect(second.items.find(({ key }) => key === "ledger:skipped-1")?.rating).toBe("useful");
    expect(second.items.find(({ key }) => key === "ledger:secret-1")?.rating).toBe("missed");
    expect(second.items.find(({ key }) => key === check?.key)?.rating).toBe("missed");
    expect((await h.overview()).metrics.missed).toBe(1);

    await h.command("proactive.review.rate", {
      ratings: [{ key: "ledger:skipped-1", rating: null }],
    });
    expect(
      (await h.review()).items.find(({ key }) => key === "ledger:skipped-1")?.rating,
    ).toBeNull();
    expect(h.failures).toEqual([]);
  });

  it("[P0-6] rejects a rating batch that names an unknown record without changing any of the others", async () => {
    const h = await setup();
    await connectAndCheck(h);
    await h.ledger.append(
      candidate("skipped-2", "discarded", "transient_ignored", null, h.clock.now()),
    );
    await expect(
      h.command("proactive.review.rate", {
        ratings: [
          { key: "ledger:skipped-2", rating: "useful" },
          { key: "ledger:no-such-row", rating: "useful" },
        ],
      }),
    ).rejects.toThrow("PROACTIVE_RECORD_NOT_FOUND");
    expect(
      (await h.review()).items.find(({ key }) => key === "ledger:skipped-2")?.rating,
    ).toBeNull();
    await expect(
      h.command("proactive.review.rate", { ratings: [{ key: "other:1", rating: "useful" }] }),
    ).rejects.toThrow("PROACTIVE_REVIEW_KEY_INVALID");
    await expect(
      h.command("proactive.review.rate", { ratings: [{ key: "mail:abc", rating: "unneeded" }] }),
    ).rejects.toThrow("PROACTIVE_REVIEW_KEY_INVALID");
    expect(h.failures).toEqual([]);
  });

  it("[P0-6] shows at most the daily capacity, keeps the same sample on reload, and leaves out old and already-rated rows", async () => {
    const h = await setup();
    await connectAndCheck(h);
    const now = Date.parse(h.clock.now());
    for (let index = 0; index < 30; index += 1)
      await h.ledger.append(
        candidate(
          `bulk-${index}`,
          "discarded",
          "transient_ignored",
          null,
          new Date(now - index * 60_000).toISOString(),
        ),
      );
    await h.ledger.append(
      candidate(
        "old-1",
        "discarded",
        "transient_ignored",
        null,
        new Date(now - 8 * 86_400_000).toISOString(),
      ),
    );
    const first = await h.review();
    expect(first.items.length).toBe(24);
    expect(first.sampled).toBe(24);
    expect(first.notSampled).toBeGreaterThanOrEqual(6);
    expect(first.items.every(({ key }) => key !== "ledger:old-1")).toBe(true);
    expect((await h.review()).items.map(({ key }) => key)).toEqual(
      first.items.map(({ key }) => key),
    );
    const target = first.items[0]?.key ?? "";
    await h.command("proactive.review.rate", { ratings: [{ key: target, rating: "useful" }] });
    const after = await h.review();
    expect(after.items.map(({ key }) => key)).toEqual(first.items.map(({ key }) => key));
    expect(after.notSampled).toBe(first.notSampled);
    h.clock.advance(86_400_000);
    const nextDay = await h.review();
    expect(nextDay.items.length).toBeLessThanOrEqual(24);
    expect(nextDay.items.find(({ key }) => key === target)).toBeUndefined();
    expect(h.failures).toEqual([]);
  });

  it("[P6-demo] runs the real mail check over the fake inbox, with related earlier mail, without any call to Google", async () => {
    const h = await setup({ demoInbox: "ja" });
    await h.proactive.seedDemoInbox();
    expect((await h.overview()).connection).toMatchObject({
      status: "connected",
      account: "demo@himawari.example",
    });
    expect((await h.overview()).enabled).toBe(true);

    await h.proactive.tick();
    expect((await h.overview()).decisions).toMatchObject([{ reasonCode: "NO_NEW_MAIL" }]);
    expect(h.prompts).toEqual([]);
    expect(h.referencePrompts).toEqual([]);

    h.clock.advance(40 * 60_000);
    h.script([
      {
        id: "demo-ja-mockups",
        result: "act",
        confidence: "sure",
        todo: "明後日の正午までに最終モックを共有フォルダへ",
        priority: "high",
        dueAt: "2026-11-06T03:00:00.000Z",
        reason: "",
      },
      {
        id: "demo-ja-delivery",
        result: "act",
        confidence: "sure",
        todo: "今日の15時までに再配達の時間を連絡する",
        priority: "high",
        dueAt: "2026-11-04T06:00:00.000Z",
        reason: "",
      },
    ]);
    await h.proactive.tick();
    const overview = await h.overview();
    expect(
      overview.insights
        .map(({ summary, pushed }) => ({ summary, pushed }))
        .sort((a, b) => a.summary.localeCompare(b.summary)),
    ).toEqual([
      { summary: "今日の15時までに再配達の時間を連絡する", pushed: true },
      { summary: "明後日の正午までに最終モックを共有フォルダへ", pushed: false },
    ]);
    expect(overview.decisions.map(({ counts }) => counts.fetched).sort()).toEqual([0, 2]);
    expect(overview.decisions.find(({ counts }) => counts.fetched === 2)?.counts.act).toBe(2);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("最終モック");
    expect(h.prompts[0]).toContain("16時に変更できないでしょうか");
    expect(h.prompts[0]).toContain("手ぬぐいセット");
    expect(h.prompts[0]).not.toContain("全品20%OFF");
    expect(h.google.calls).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it("[P4-1] rechecks rules whose source memory changed before each mail check, and a failed recheck does not stop the check", async () => {
    const seen: string[] = [];
    let fail = false;
    const h = await setup({
      demoInbox: "ja",
      ruleReview: {
        run: async () => {
          seen.push(`review:${(await h.overview()).decisions.length}`);
          if (fail) throw new Error("RULE_REVIEW_BROKEN");
          return [];
        },
      },
    });
    await h.proactive.seedDemoInbox();
    await h.proactive.tick();
    expect(seen).toEqual(["review:0"]);
    expect((await h.overview()).decisions).toHaveLength(1);
    fail = true;
    h.clock.advance(40 * 60_000);
    await h.proactive.tick();
    expect(seen).toEqual(["review:0", "review:1"]);
    expect((await h.overview()).decisions).toHaveLength(2);
    expect(h.failures.map((error) => (error as Error).message)).toEqual(["RULE_REVIEW_BROKEN"]);
  });

  it("[P6-demo] [reverse] a fake-inbox service cannot be pointed at a real mailbox, and reconnecting only restores the fake inbox", async () => {
    const h = await setup({ demoInbox: "en" });
    await h.proactive.seedDemoInbox();
    const start = await h.app.inject({
      method: "GET",
      url: PROACTIVE_GOOGLE_START_PATH,
      headers: { ...cookie, "sec-fetch-site": "same-origin" },
    });
    expect(start.statusCode).toBe(303);
    expect(start.headers["location"]).toBe("/?settings=apps&gmail=demo");

    const forged = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=forged&code=code-1`,
      headers: cookie,
    });
    expect(forged.headers["location"]).toBe("/?settings=apps&gmail=failed");
    expect((await h.overview()).connection.account).toBe("demo@himawari.example");

    await h.command("proactive.source.manage", { source: "gmail", action: "disconnect" });
    expect((await h.overview()).connection.status).toBe("disconnected");
    await h.app.inject({
      method: "GET",
      url: PROACTIVE_GOOGLE_START_PATH,
      headers: { ...cookie, "sec-fetch-site": "same-origin" },
    });
    expect((await h.overview()).connection).toMatchObject({
      status: "connected",
      account: "demo@himawari.example",
    });
    expect(h.google.calls).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it("[P6-demo] [reverse] a disconnected fake inbox stays disconnected after a restart, and a broken fake connection is replaced, and a real one is never touched", async () => {
    const h = await setup({ demoInbox: "ja" });
    await h.proactive.seedDemoInbox();
    await h.command("proactive.source.manage", { source: "gmail", action: "disconnect" });
    await h.proactive.seedDemoInbox();
    expect((await h.overview()).connection.status).toBe("disconnected");

    await h.app.inject({
      method: "GET",
      url: PROACTIVE_GOOGLE_START_PATH,
      headers: { ...cookie, "sec-fetch-site": "same-origin" },
    });
    expect((await h.overview()).connection.status).toBe("connected");
    const breakConnection = () =>
      h.store.markConnection({
        ...scope,
        source: "gmail",
        status: "needs_reconnect",
        cursor: null,
        now: h.clock.now(),
      });
    await breakConnection();
    expect((await h.overview()).connection.status).toBe("needs_reconnect");
    await h.proactive.seedDemoInbox();
    expect((await h.overview()).connection.status).toBe("connected");
    expect(h.failures).toEqual([]);
  });

  it("[P6-demo] [reverse] never replaces a connection that holds a real Google token, at start or when the user presses connect", async () => {
    const h = await setup({ demoInbox: "ja" });
    const now = h.clock.now();
    const accountRef = await h.seal.seal({ ...scope, text: "andy@example.com", at: now });
    const tokenRef = await h.seal.seal({ ...scope, text: "refresh-real", at: now });
    await h.store.saveConnection({
      ...scope,
      connection: {
        source: "gmail",
        accountRef,
        tokenRef,
        cursor: null,
        status: "connected",
        connectedAt: now,
        updatedAt: now,
      },
    });
    await h.proactive.seedDemoInbox();
    await h.proactive.seedDemoInbox({ restore: true });
    await h.store.writeSettings({
      ...scope,
      ...(await h.store.readSettings(scope)),
      enabled: true,
      now: h.clock.now(),
    });
    await h.proactive.tick();
    await h.app.inject({
      method: "GET",
      url: PROACTIVE_GOOGLE_START_PATH,
      headers: { ...cookie, "sec-fetch-site": "same-origin" },
    });
    expect((await h.overview()).connection).toMatchObject({
      status: "connected",
      account: "andy@example.com",
    });
    expect(await h.seal.open({ ...scope, ref: tokenRef })).toBe("refresh-real");
    await expect(
      h.command("proactive.source.manage", { source: "gmail", action: "disconnect" }),
    ).rejects.toThrow();
    expect(await h.seal.open({ ...scope, ref: tokenRef })).toBe("refresh-real");
    expect(await h.store.readConnection({ ...scope, source: "gmail" })).toMatchObject({
      status: "connected",
      tokenRef,
    });
    expect(h.failures).toEqual([]);
  });

  it("[P6-demo] replaces a fake connection whose language no longer matches the configuration", async () => {
    const h = await setup({ demoInbox: "ja" });
    const now = h.clock.now();
    const accountRef = await h.seal.seal({ ...scope, text: "demo@himawari.example", at: now });
    const tokenRef = await h.seal.seal({
      ...scope,
      text: demoMailboxToken("en", now),
      at: now,
    });
    await h.store.saveConnection({
      ...scope,
      connection: {
        source: "gmail",
        accountRef,
        tokenRef,
        cursor: null,
        status: "connected",
        connectedAt: now,
        updatedAt: now,
      },
    });
    await h.proactive.seedDemoInbox();
    const stored = await h.store.readConnection({ ...scope, source: "gmail" });
    expect(await h.seal.open({ ...scope, ref: stored?.tokenRef ?? "" })).toContain(
      "demo-inbox:v1:ja:",
    );
    expect(h.failures).toEqual([]);
  });

  it("[P6-demo] replaces a fake token with an unreadable date, and releases what it sealed when saving fails", async () => {
    const h = await setup({ demoInbox: "ja" });
    const now = h.clock.now();
    const accountRef = await h.seal.seal({ ...scope, text: "demo@himawari.example", at: now });
    const tokenRef = await h.seal.seal({ ...scope, text: "demo-inbox:v1:ja:not-a-date", at: now });
    await h.store.saveConnection({
      ...scope,
      connection: {
        source: "gmail",
        accountRef,
        tokenRef,
        cursor: null,
        status: "connected",
        connectedAt: now,
        updatedAt: now,
      },
    });
    await h.proactive.seedDemoInbox();
    const stored = await h.store.readConnection({ ...scope, source: "gmail" });
    expect(stored?.tokenRef).not.toBe(tokenRef);
    expect(await h.seal.open({ ...scope, ref: stored?.tokenRef ?? "" })).toContain(
      "demo-inbox:v1:ja:",
    );
    expect(h.failures).toEqual([]);
  });

  it("[P6-demo] [reverse] checks nothing while proactive reminders are off", async () => {
    const h = await setup({ demoInbox: "ja" });
    await h.proactive.seedDemoInbox();
    await h.proactive.seedDemoInbox({ restore: true });
    await h.command("proactive.settings.set", {
      enabled: false,
      quietHours: [],
      importantSenders: [],
    });
    h.script([]);
    await h.proactive.tick();
    expect(h.prompts).toEqual([]);
    expect(h.referencePrompts).toEqual([]);
    expect(h.failures).toEqual([]);
  });
});
