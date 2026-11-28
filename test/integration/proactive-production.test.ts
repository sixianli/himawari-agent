import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProactiveSeal,
  DEFAULT_REVIEW_PREREVIEW,
  defineProactiveSources,
  GMAIL_SOURCE,
  type MailInboxPort,
  type ModelDescriptor,
  type ProactiveSource,
  type ProactiveSourceRegistry,
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
  createGmailReader,
  createGoogleOAuth,
  GMAIL_READONLY_SCOPE,
  readGmailAccount,
} from "@himawari-agent/platform-node";
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
              scope: GMAIL_READONLY_SCOPE,
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
      readonly registry?: ProactiveSourceRegistry<ProactiveSource>;
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
    };
    const readPayload = async (ref: string) => {
      const payload = await payloadStore.get(ref);
      if (!payload) return undefined;
      return new TextDecoder().decode(await protector.unprotect({ payload }));
    };
    const google = fakeGoogle();
    const oauth = createGoogleOAuth({
      clientId: "client-1",
      clientSecret: "test-secret",
      redirectUri: `${ORIGIN}${PROACTIVE_GOOGLE_CALLBACK_PATH}`,
      fetch: google.fetch,
    });
    const scripted = new ScriptedModelPort([descriptor], []);
    const prompts: string[] = [];
    const webPushStore = repository.webPush();
    const failures: unknown[] = [];
    const proactive = new ProductionProactive({
      scope,
      configuration: {
        modelRef: MODEL_REF,
        gmail: { clientId: "client-1", clientSecretRef: "google-oauth" },
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
      },
      timeZone: "Asia/Tokyo",
      store,
      seal,
      oauth,
      ...(options.registry ? { registry: options.registry } : {}),
      reader: createGmailReader({ oauth, fetch: google.fetch }),
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
          prompts.push(prompt);
          const inputRef = `input-${invocationId}`;
          await writePayload(inputRef, prompt);
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
    const submitted: Parameters<MailInboxPort["submit"]>[0][] = [];
    proactive.attachInbox({
      submit: async (input) => {
        submitted.push(input);
        return { accepted: true };
      },
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
      readMessage: async () => undefined,
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
      submitted,
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
    const google = new URL(String(start.headers.location));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${PROACTIVE_GOOGLE_CALLBACK_PATH}`,
    );
    return google.searchParams.get("state") ?? "";
  }

  async function storeConnectedGmail(h: Awaited<ReturnType<typeof setup>>) {
    const now = h.clock.now();
    const accountRef = await h.seal.seal({ ...scope, text: "andy@example.com", at: now });
    const tokenRef = await h.seal.seal({ ...scope, text: "refresh-1", at: now });
    await h.store.saveConnection({
      ...scope,
      connection: {
        source: GMAIL_SOURCE.name,
        accountRef,
        tokenRef,
        cursor: null,
        status: "connected",
        connectedAt: now,
        updatedAt: now,
      },
    });
    const settings = await h.store.readSettings(scope);
    await h.store.writeSettings({ ...scope, ...settings, enabled: true, now });
  }

  it("[iOS-7] lists registered sources with their switch and caps, and a source switched off is not checked", async () => {
    const h = await setup();
    await storeConnectedGmail(h);
    const sources = async () => {
      const snapshot = await h.proactive.query(
        message("query", "proactive.sources.read", {}) as GatewayV2Query,
      );
      gatewayV2MessageSchema.parse(snapshot);
      if (snapshot.type !== "proactive.sources.snapshot") throw new Error("unexpected snapshot");
      return snapshot.payload.sources;
    };
    expect(await sources()).toEqual([
      {
        source: "gmail",
        intake: "reader",
        trust: "external",
        enabled: true,
        perDay: {
          limit: 5_000,
          defaultLimit: 5_000,
          minimum: 1,
          maximum: 1_000_000,
          used: 0,
          resetsAt: "2026-11-04T15:00:00.000Z",
          onReach: "hold_until_reset",
        },
        perCheck: {
          limit: 500,
          defaultLimit: 500,
          minimum: 1,
          maximum: 500,
          onReach: "hold_until_next_check",
        },
        dailyLimitReached: false,
        updatedAt: null,
      },
    ]);

    await h.command("proactive.source.settings.set", {
      source: "gmail",
      enabled: false,
      perDay: 40,
      perCheck: 1,
    });
    h.clock.advance(40 * 60_000);
    await h.proactive.tick();
    expect((await h.overview()).decisions).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(await sources()).toMatchObject([
      { enabled: false, perDay: { limit: 40, used: 0 }, perCheck: { limit: 1 } },
    ]);
    const changes = async () =>
      (
        await h.ledger.list({
          ...scope,
          kind: "limit_change",
          since: "2026-11-01T00:00:00.000Z",
          limit: 20,
        })
      )
        .map(({ inputs }) => inputs.limitChange)
        .sort((left, right) => (left?.key ?? "").localeCompare(right?.key ?? ""));
    expect(await changes()).toEqual([
      { key: "proactive.source.gmail.perCheck", from: 500, to: 1 },
      { key: "proactive.source.gmail.perDay", from: 5_000, to: 40 },
    ]);

    await h.command("proactive.source.settings.set", {
      source: "gmail",
      enabled: true,
      perDay: 40,
      perCheck: 1,
    });
    await h.proactive.tick();
    expect((await h.overview()).decisions).toMatchObject([{ counts: { fetched: 1 } }]);
    expect(await sources()).toMatchObject([{ enabled: true, perDay: { used: 1 } }]);
    expect(await changes()).toHaveLength(2);

    await h.command("proactive.source.switch_off", { source: "gmail" });
    expect(await sources()).toMatchObject([
      { enabled: false, perDay: { limit: 40 }, perCheck: { limit: 1 } },
    ]);
    expect(await changes()).toHaveLength(2);
    expect(h.failures).toEqual([]);
  });

  it("[iOS-7][reverse] will not start with a registered reader source that nobody reads", async () => {
    const unread = defineProactiveSources([
      GMAIL_SOURCE,
      { ...GMAIL_SOURCE, name: "test_notes" },
    ] as never) as unknown as ProactiveSourceRegistry<ProactiveSource>;
    await expect(setup({ registry: unread })).rejects.toThrow(
      "PROACTIVE_SOURCE_READER_MISSING test_notes",
    );
  });

  it("[iOS-7][reverse] refuses caps outside the registered range and any source that is not registered", async () => {
    const h = await setup();
    await storeConnectedGmail(h);
    await expect(
      h.command("proactive.source.settings.set", {
        source: "gmail",
        enabled: true,
        perDay: 1_000_001,
        perCheck: 5,
      }),
    ).rejects.toThrow("PROACTIVE_SOURCE_SETTINGS_INVALID");
    await expect(
      h.command("proactive.source.settings.set", {
        source: "test_notes",
        enabled: true,
        perDay: 5,
        perCheck: 5,
      }),
    ).rejects.toThrow("PROACTIVE_SOURCE_SETTINGS_INVALID");
    await expect(
      h.command("proactive.source.manage", { source: "test_notes", action: "disconnect" }),
    ).rejects.toThrow("PROACTIVE_SOURCE_NOT_REGISTERED");
    h.clock.advance(40 * 60_000);
    await h.proactive.tick();
    const decided = (await h.overview()).decisions.length;
    expect(decided).toBeGreaterThan(0);
    await expect(
      h.command("proactive.source.manage", { source: "test_notes", action: "clear_records" }),
    ).rejects.toThrow("PROACTIVE_SOURCE_NOT_REGISTERED");
    expect((await h.overview()).decisions).toHaveLength(decided);
    await expect(
      h.command("proactive.source.switch_off", { source: "test_notes" }),
    ).rejects.toThrow("PROACTIVE_SOURCE_NOT_REGISTERED");
    expect(() =>
      message("command", "proactive.source.switch_off", { source: "gmail", enabled: true }),
    ).toThrow(/unknown field/u);
    expect(
      await h.ledger.list({
        ...scope,
        kind: "limit_change",
        since: "2026-11-01T00:00:00.000Z",
        limit: 20,
      }),
    ).toEqual([]);
    expect((await h.overview()).connection.status).toBe("connected");
    expect(
      await h.proactive.recordEntry({
        source: "gmail",
        entryId: "entry-1",
        summary: "x",
        reason: "",
        link: "",
        result: "act",
        priority: null,
        dueAt: null,
        deliverAt: null,
      }),
    ).toEqual({ kind: "not_recorded", reason: "source_has_reader" });
  });

  it("[PG-12] connects Gmail through Google, checks the inbox and hands the new mail to her without pushing anything itself", async () => {
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
    expect(forged.headers.location).toBe("/?settings=apps&gmail=failed");
    expect((await h.overview()).connection.status).toBe("disconnected");

    const state = await connect(h);
    const callback = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1&scope=x`,
      headers: cookie,
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/?settings=apps&gmail=connected");
    await h.proactive.stop();
    const replay = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1`,
      headers: cookie,
    });
    expect(replay.headers.location).toBe("/?settings=apps&gmail=failed");

    const first = await h.overview();
    expect(first.connection).toMatchObject({ status: "connected", account: "andy@example.com" });
    expect(first.enabled).toBe(true);
    expect(first.insights).toEqual([]);
    expect(first.decisions).toMatchObject([
      {
        verdict: "silent",
        reasonCode: "HANDED_TO_INBOX",
        counts: { fetched: 2, skipped: 1, check: 1 },
      },
    ]);
    expect(h.prompts).toEqual([]);
    expect(h.submitted).toEqual([
      expect.objectContaining({ sourceKind: "mail", sourceRef: "invoice", externalContent: true }),
    ]);
    expect(h.submitted[0]?.summary).toContain("ご請求のお知らせ");
    expect(h.submitted[0]?.summary).not.toContain("セール");

    await h.push.tick();
    await h.push.tick();
    expect(h.sent).toEqual([]);
    expect(
      h.google.calls.filter(
        ({ url, method }) => url.startsWith("https://gmail.googleapis.com/") && method !== "GET",
      ),
    ).toEqual([]);
    expect(h.google.calls.some(({ url }) => url.includes("calendar"))).toBe(false);
    expect(h.failures).toEqual([]);
  });

  const APP_SCHEME = "win.example.himawari";

  async function appStart(h: Awaited<ReturnType<typeof setup>>, deviceId = "device-a") {
    const started = await h.proactive.beginAppAuthorization({
      deviceId,
      callbackScheme: APP_SCHEME,
    });
    const google = new URL(started.authorizationUrl);
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${PROACTIVE_GOOGLE_CALLBACK_PATH}`,
    );
    return google.searchParams.get("state") ?? "";
  }

  async function googleReturns(h: Awaited<ReturnType<typeof setup>>, query: string) {
    return h.app.inject({ method: "GET", url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?${query}` });
  }

  it("[PG-12] the iPhone connects Gmail: Google returns to the server without a web session, the server sends the system sign-in window back to the app, and the app's signed request finishes the connection", async () => {
    const h = await setup();
    const state = await appStart(h);
    const back = await googleReturns(h, `state=${state}&code=code-1&scope=x`);
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe(`${APP_SCHEME}://gmail-authorization?state=${state}`);
    expect(String(back.headers.location)).not.toContain("code-1");
    expect((await h.overview()).connection.status).toBe("disconnected");
    expect(await h.proactive.connection()).toEqual({
      name: "gmail",
      title: "Gmail",
      status: "disconnected",
      account: null,
      connectedAt: null,
      added: false,
    });

    expect(await h.proactive.completeAppAuthorization({ deviceId: "device-a", state })).toBe(
      "connected",
    );
    expect(await h.proactive.connection()).toMatchObject({
      name: "gmail",
      status: "connected",
      account: "andy@example.com",
    });
    await h.proactive.stop();
    expect((await h.overview()).connection).toMatchObject({
      status: "connected",
      account: "andy@example.com",
    });
    expect(await h.proactive.completeAppAuthorization({ deviceId: "device-a", state })).toBe(
      "failed",
    );
    expect(h.failures).toEqual([]);
  });

  it("[PG-12][reverse] another device, a web session, a forged state, a refusal at Google or an expired sign-in never connects Gmail", async () => {
    const h = await setup();
    const stolen = await appStart(h);
    await googleReturns(h, `state=${stolen}&code=code-1`);
    expect(
      await h.proactive.completeAppAuthorization({ deviceId: "device-b", state: stolen }),
    ).toBe("failed");
    const web = await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${stolen}&code=code-1`,
      headers: cookie,
    });
    expect(web.headers.location).toBe(`${APP_SCHEME}://gmail-authorization?state=${stolen}`);
    expect(
      await h.proactive.completeAuthorization({
        owner: "owner-subject:device-1",
        state: stolen,
        code: "code-1",
        error: null,
      }),
    ).toBe("failed");

    const forged = await googleReturns(h, "state=forged-state-value-0000&code=code-1");
    expect(forged.statusCode).toBe(200);
    expect(String(forged.headers["content-type"])).toContain("text/html");
    expect(
      await h.proactive.completeAppAuthorization({
        deviceId: "device-a",
        state: "forged-state-value-0000",
      }),
    ).toBe("failed");

    const refused = await appStart(h);
    await googleReturns(h, `state=${refused}&error=access_denied`);
    expect(
      await h.proactive.completeAppAuthorization({ deviceId: "device-a", state: refused }),
    ).toBe("denied");

    const unanswered = await appStart(h);
    expect(
      await h.proactive.completeAppAuthorization({ deviceId: "device-a", state: unanswered }),
    ).toBe("failed");

    const late = await appStart(h);
    h.clock.advance(11 * 60_000);
    await googleReturns(h, `state=${late}&code=code-1`);
    expect(await h.proactive.completeAppAuthorization({ deviceId: "device-a", state: late })).toBe(
      "failed",
    );

    expect((await h.overview()).connection.status).toBe("disconnected");
    expect(
      h.google.calls.filter(({ url }) => url === "https://oauth2.googleapis.com/token"),
    ).toEqual([]);
  });

  const smbcRule = {
    type: "mail_must_notify",
    summary: "SMBC 的邮件一律提醒",
    params: { senderDomains: ["smbc.co.jp"] },
  };
  const checkInbox = async (h: Awaited<ReturnType<typeof setup>>) => {
    const state = await connect(h);
    await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1&scope=x`,
      headers: cookie,
    });
    await h.proactive.stop();
  };

  it("[P2-3] tells her which of the owner's mail rules a new mail matches, and leaves the decision to her", async () => {
    const h = await setup();
    await h.ownerRules.create({
      ...scope,
      ruleId: "owner:smbc",
      parameters: smbcRule,
      source: "chat:thread-1",
      sourceMemoryId: "memory:rule:smbc",
      now: h.clock.now(),
    });
    await checkInbox(h);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]?.summary).toContain("主人立过的规则命中：SMBC 的邮件一律提醒");
    expect((await h.overview()).insights).toEqual([]);
    await h.push.tick();
    expect(h.sent).toEqual([]);
    expect(h.failures).toEqual([]);
  });

  it("[P2-3][reverse] a mail no rule matches carries no rule line", async () => {
    const h = await setup();
    await h.ownerRules.create({
      ...scope,
      ruleId: "owner:elsewhere",
      parameters: { ...smbcRule, params: { senderDomains: ["isa.go.jp"] } },
      source: "chat:thread-1",
      sourceMemoryId: "memory:rule:elsewhere",
      now: h.clock.now(),
    });
    await checkInbox(h);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]?.summary).not.toContain("主人立过的规则命中");
  });

  it("[PG-12] finishes connecting when the browser holds back the strict session cookie on Google's cross-site return", async () => {
    const h = await setup();
    const state = await connect(h);
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
    expect(signedOut.headers.location).toBe("/?settings=apps&gmail=failed");
  }, 20_000);

  it("[PG-12] lets the owner tune, rate and disconnect, which revokes Google access and forgets the mail", async () => {
    const h = await setup();
    const state = await connect(h);
    await h.app.inject({
      method: "GET",
      url: `${PROACTIVE_GOOGLE_CALLBACK_PATH}?state=${state}&code=code-1`,
      headers: cookie,
    });
    await h.proactive.stop();
    const before = await h.overview();
    const decisionId = before.decisions[0]?.id ?? "";

    await h.command("proactive.settings.set", {
      enabled: true,
      quietHours: [{ days: [6, 0], start: "22:00", end: "08:00" }],
      importantSenders: ["Teacher@School.example", "@city.shinjuku.lg.jp"],
    });
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
    expect(tuned.decisions[0]?.rating).toBe("useful");

    const toggles = () => {
      const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
      const kinds = database
        .prepare(
          "SELECT kind FROM observation_events WHERE kind IN ('proactive_enabled', 'proactive_disabled') ORDER BY sequence",
        )
        .all()
        .map((row) => (row as { kind: string }).kind);
      database.close();
      return kinds;
    };
    const togglesBefore = toggles();
    await h.command("proactive.pause", {});
    await h.command("proactive.pause", {});
    const paused = await h.overview();
    expect(paused.enabled).toBe(false);
    expect(paused.quietHours).toEqual(tuned.quietHours);
    expect(paused.importantSenders).toEqual(tuned.importantSenders);
    expect(toggles()).toEqual([...togglesBefore, "proactive_disabled"]);
    await h.command("proactive.settings.set", {
      enabled: true,
      quietHours: tuned.quietHours,
      importantSenders: tuned.importantSenders,
    });

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

  it("[PA-6] REVERSE: no longer offers any auto reduce-pushes state: the overview has no backoff list and the restore command is refused", async () => {
    const h = await setup();
    await connectAndCheck(h);
    expect(await h.overview()).not.toHaveProperty("backoff");
    await expect(async () =>
      h.command("proactive.backoff.restore", { classKey: null }),
    ).rejects.toThrow();
    expect(h.failures).toEqual([]);
  });

  async function connectAndCheck(h: Awaited<ReturnType<typeof setup>>) {
    const state = await connect(h);
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

  it("[P0-6] puts skipped memories on the daily review, leaves out mail checks that only handed mail to her, folds the rest, and keeps ratings after a reload", async () => {
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
    expect(first.items.find(({ kind }) => kind === "proactive")).toBeUndefined();
    expect(first.capacity).toBe(24);
    expect(first.sampled).toBe(first.items.length);
    expect(first.notSampled).toBe(0);

    await h.command("proactive.review.rate", {
      ratings: [
        { key: "ledger:skipped-1", rating: "useful" },
        { key: "ledger:secret-1", rating: "missed" },
      ],
    });
    const second = await h.review();
    expect(second.items.map(({ key }) => key)).toEqual(keys);
    expect(second.items.find(({ key }) => key === "ledger:skipped-1")?.rating).toBe("useful");
    expect(second.items.find(({ key }) => key === "ledger:secret-1")?.rating).toBe("missed");

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

  it("[P4-1] rechecks rules whose source memory changed before each mail check, and a failed recheck does not stop the check", async () => {
    const seen: string[] = [];
    let fail = false;
    const h = await setup({
      ruleReview: {
        run: async () => {
          seen.push(`review:${(await h.overview()).decisions.length}`);
          if (fail) throw new Error("RULE_REVIEW_BROKEN");
          return [];
        },
      },
    });
    await storeConnectedGmail(h);
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
});
