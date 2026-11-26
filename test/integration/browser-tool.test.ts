import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  ApprovalService,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  GrantService,
  type RuntimeToolInvocation,
} from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.js";
import { OwnerAllowances } from "../../apps/agent-service/src/owner-allowances.js";
import { OwnerScopeAuthorization } from "../../apps/agent-service/src/owner-scope-authorization.js";
import {
  BROWSER_CAPABILITY_REF,
  BROWSER_SITE_TARGET,
  type BrowserComputer,
  type BrowserComputerExecInput,
  type BrowserComputerExecResult,
  BrowserToolError,
  ProductionBrowserTools,
} from "../../apps/agent-service/src/production-browser-tools.js";
import { productionToolActionRegistry } from "../../apps/agent-service/src/production-tool-actions.js";
import { openNetworkEgress } from "../../packages/runtime-sandbox/src/network-egress.ts";
import { PREINSTALLED_CHROMIUM } from "../fixtures/chromium-launch.ts";
import { repositoryRoot } from "../fixtures/product-path-harness.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  RUN_ID,
  SERVICE_AUTHORITY,
} from "../fixtures/sqlite-capability-invocation-fixture.js";

const PROGRAM = path.join(
  repositoryRoot,
  "packages/runtime-sandbox/computer-image/himawari-browser.mjs",
);
const CALL_MS = 90_000;
const RESERVE_MS = 5_000;

function chromiumEnv(): Record<string, string> {
  const browsers = {
    PLAYWRIGHT_BROWSERS_PATH:
      process.env["PLAYWRIGHT_BROWSERS_PATH"] || path.join(homedir(), ".cache", "ms-playwright"),
  };
  const configured = process.env["HIMAWARI_CHROMIUM_PATH"];
  const managed = chromium.executablePath();
  const executable =
    configured ||
    (existsSync(managed)
      ? managed
      : existsSync(PREINSTALLED_CHROMIUM)
        ? PREINSTALLED_CHROMIUM
        : "");
  return executable ? { ...browsers, HIMAWARI_BROWSER_EXECUTABLE: executable } : browsers;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

class ComputerOnThisMachine implements BrowserComputer {
  readonly calls: BrowserComputerExecInput[] = [];
  readonly home: string;
  readonly #port: number;
  readonly #token = "a".repeat(64);

  constructor(home: string, port: number) {
    this.home = home;
    this.#port = port;
  }

  run(argv: readonly string[], stdin: Uint8Array, deadlineAt: string) {
    const proxy = `http://job:${this.#token}@127.0.0.1:${this.#port}`;
    return new Promise<BrowserComputerExecResult>((resolve, reject) => {
      const child = spawn(process.execPath, [PROGRAM, ...argv], {
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: this.home,
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          ...chromiumEnv(),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), Date.parse(deadlineAt) - Date.now());
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          truncated: false,
        });
      });
      child.stdin.end(stdin);
    });
  }

  async exec(input: BrowserComputerExecInput): Promise<BrowserComputerExecResult> {
    this.calls.push(input);
    const egress =
      input.allowedDomains.length > 0
        ? await openNetworkEgress(input.allowedDomains, async () => {}, {
            host: "127.0.0.1",
            port: this.#port,
            token: this.#token,
          })
        : null;
    try {
      const result = await this.run(
        input.argv.slice(1),
        input.stdin ?? new Uint8Array(),
        input.deadlineAt,
      );
      if (result.stdout.byteLength > input.maxOutputBytes)
        return {
          ...result,
          stdout: result.stdout.subarray(0, input.maxOutputBytes),
          truncated: true,
        };
      return result;
    } finally {
      await egress?.close();
    }
  }
}

let resource: Awaited<ReturnType<typeof openRepository>>;
let computer: ComputerOnThisMachine;
let ownerScope: OwnerScopeAuthorization;
let allowances: OwnerAllowances;
let externalContent: ContextExternalContent;
let tools: ProductionBrowserTools;
let home = "";
let sequence = 0;
const registry = productionToolActionRegistry();
const frozen = new Map<string, unknown>();
const row = registry.forCapability(BROWSER_CAPABILITY_REF);

beforeAll(async () => {
  resource = await openRepository();
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
    .run(OWNER_ID, AGENT_ID, new Date().toISOString(), RUN_ID);
  database.close();
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: (scope: string) => `${scope}:browser:${++sequence}` };
  const store = repository.authorizationStore();
  externalContent = new ContextExternalContent({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    state: repository,
    source: repository.runExecutionSource(OWNER_ID, AGENT_ID),
    authority: () => SERVICE_AUTHORITY.lease,
    clock,
  });
  allowances = new OwnerAllowances({
    configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
    state: repository,
    store,
    authority: () => SERVICE_AUTHORITY.lease,
    clock,
  });
  ownerScope = new OwnerScopeAuthorization({
    externalContent,
    allowances,
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
  home = await mkdtemp(path.join(testTemporaryRoot(), "browser-home-"));
  computer = new ComputerOnThisMachine(home, await freePort());
  tools = new ProductionBrowserTools({
    ownerId: OWNER_ID,
    computer,
    maxOutputBytes: 8 * 1024 * 1024,
    maxTextChars: 20_000,
    responseReserveMs: RESERVE_MS,
    acceptsImages: (modelRef) => modelRef === "model-with-images",
    now: () => Date.now(),
  });
}, CALL_MS);

afterAll(async () => {
  await computer?.run(["stop"], new Uint8Array(), new Date(Date.now() + CALL_MS).toISOString());
  await resource?.repository.close();
  if (resource) await rm(resource.stateRoot, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
}, CALL_MS);

function call(
  toolCallId: string,
  args: Record<string, unknown>,
  modelRef = "model-text-only",
): RuntimeToolInvocation {
  return {
    runId: createRunId(RUN_ID),
    toolCallId,
    capabilityRef: BROWSER_CAPABILITY_REF,
    capabilityHandleRef: null,
    arguments: args as RuntimeToolInvocation["arguments"],
    dataClassification: "private",
    executionDeadlineAt: new Date(Date.now() + CALL_MS).toISOString(),
    context: { threadId: "thread-capability-invocation", modelRef } as never,
  };
}

class Stopped extends Error {
  readonly decision: string;
  constructor(decision: string) {
    super(decision);
    this.decision = decision;
  }
}

async function use(invocation: RuntimeToolInvocation) {
  if (!row) throw new Error("browser row missing");
  return tools.run(invocation, {
    authorizeSites: async (sites, display) => {
      const decision = await ownerScope.authorize(
        invocation,
        row,
        async (key, value) => {
          if (!frozen.has(key)) frozen.set(key, value);
          return frozen.get(key);
        },
        undefined,
        { targets: sites.map((ref) => ({ type: BROWSER_SITE_TARGET, ref })), display },
      );
      if (decision.decision !== "ALLOW") throw new Stopped(JSON.stringify(decision).slice(0, 300));
    },
    markExternalContent: async () => {
      await externalContent.mark(invocation.runId, "browser_page");
    },
  });
}

async function pending(): Promise<GovernedApprovalRequest> {
  const all = (await resource.repository
    .authorizationStore()
    .listApprovals(OWNER_ID, AGENT_ID)) as readonly GovernedApprovalRequest[];
  const waiting = all.filter(({ status }) => status === "pending");
  expect(waiting).toHaveLength(1);
  return waiting[0] as GovernedApprovalRequest;
}

async function respond(approval: GovernedApprovalRequest, decision: "approved" | "denied") {
  const store = resource.repository.authorizationStore();
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: (scope: string) => `${scope}:respond:${++sequence}` };
  const intent = approval.intentSnapshot as GovernedActionIntent;
  const grant =
    decision === "approved"
      ? new GrantService({ store, clock, ids }).create({
          kind: "one_time",
          intent,
          approvalRequestId: approval.id,
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
    approvalRequestId: approval.id,
    expectedRevision: approval.revision,
    semanticSnapshotHash: approval.semanticSnapshotHash,
    response: grant ? { decision, grant, recentAuthenticationRef: null } : { decision: "denied" },
  } as never);
}

async function approveThenUse(
  invocation: RuntimeToolInvocation,
  allowFor?: "this_task" | "always",
) {
  await expect(use(invocation)).rejects.toBeInstanceOf(Stopped);
  const approval = await pending();
  await respond(approval, "approved");
  if (allowFor) await allowances.set({ approvalRequestId: approval.id, allowFor, days: null });
  return use(invocation);
}

function refOf(text: string, pattern: RegExp): string {
  for (const line of text.split("\n"))
    for (const match of line.matchAll(/\[((?:f\d+)?e\d+) ([a-z]+) "([^"]*)"/gu))
      if (pattern.test(`${match[2]} ${match[3]}`)) return match[1] as string;
  throw new Error(`no element matching ${pattern} in:\n${text.slice(0, 2000)}`);
}

describe("browser tool in the owner's own computer", () => {
  it(
    "asks the owner before the first visit to a site and opens nothing when the owner says no",
    async () => {
      const before = computer.calls.length;
      await expect(
        use(call("call:denied", { action: "open", url: "https://example.org/" })),
      ).rejects.toBeInstanceOf(Stopped);
      const approval = await pending();
      expect(approval.display).toMatchObject({ displayTitle: "用浏览器访问 example.org" });
      expect(
        (approval.intentSnapshot as GovernedActionIntent).targets.filter(
          ({ type }) => type === BROWSER_SITE_TARGET,
        ),
      ).toEqual([{ type: BROWSER_SITE_TARGET, ref: "example.org" }]);
      await respond(approval, "denied");
      await expect(
        use(call("call:denied", { action: "open", url: "https://example.org/" })),
      ).rejects.toBeInstanceOf(Stopped);
      expect(computer.calls.length).toBe(before);
    },
    CALL_MS,
  );

  it(
    "searches a real site after the owner allows it, and keeps the site's cookies on the owner's disk across a restart",
    async () => {
      const opened = await approveThenUse(
        call("call:wiki-open", { action: "open", url: "https://en.wikipedia.org/wiki/Main_Page" }),
        "always",
      );
      const page = opened.value as { page: { url: string }; text: string; blockedHosts: string[] };
      expect(page.page.url).toBe("https://en.wikipedia.org/wiki/Main_Page");
      expect(computer.calls.at(-1)?.allowedDomains).toEqual([
        "en.wikipedia.org:443",
        "en.wikipedia.org:80",
      ]);
      expect(page.blockedHosts).not.toContain("en.wikipedia.org");
      const search = refOf(page.text, /^(searchbox|textbox) .*search/iu);
      const typed = await approveThenUse(
        call("call:wiki-type", {
          action: "type",
          ref: search,
          text: "Helianthus annuus",
          submit: true,
        }),
        "this_task",
      );
      const article = typed.value as { page: { url: string; title: string }; text: string };
      expect(article.page.url).toMatch(/^https:\/\/en\.wikipedia\.org\//u);
      expect(article.text).toMatch(/sunflower/iu);
      expect((await externalContent.read(RUN_ID)).map(({ origin }) => origin)).toContain(
        "browser_page",
      );
      const read = await use(call("call:wiki-read", { action: "read" }));
      expect(computer.calls.at(-1)?.allowedDomains).toEqual([]);
      expect((read.value as { text: string }).text).toMatch(/sunflower/iu);
      await computer.run(["stop"], new Uint8Array(), new Date(Date.now() + CALL_MS).toISOString());
      const cookies = openQualifiedDatabase(
        path.join(home, ".himawari/browser/profile/Default/Cookies"),
      );
      const hosts = cookies.prepare("SELECT DISTINCT host_key FROM cookies").pluck().all();
      cookies.close();
      expect(hosts).toEqual(expect.arrayContaining([".wikipedia.org"]));
      const again = await use(call("call:wiki-after-restart", { action: "read" }));
      expect((again.value as { page: { url: string } }).page.url).toBe("about:blank");
      expect(await readdir(path.join(home, ".himawari/browser/profile"))).toContain("Default");
    },
    CALL_MS * 6,
  );

  it(
    "refuses a link to a site the owner has not allowed: the proxy blocks it and the tool says which site",
    async () => {
      await approveThenUse(
        call("call:example-open", { action: "open", url: "https://example.com/" }),
        "this_task",
      );
      const read = await use(call("call:example-read", { action: "read" }));
      const link = refOf((read.value as { text: string }).text, /^link /u);
      const clicked = use(call("call:example-click", { action: "click", ref: link }));
      await expect(clicked).rejects.toBeInstanceOf(BrowserToolError);
      await clicked.catch((error: BrowserToolError) => {
        expect(error.code).toBe("BROWSER_SITE_NOT_ALLOWED");
        expect(error.note).toMatch(/iana\.org/u);
      });
      expect(computer.calls.at(-1)?.allowedDomains).toEqual(["example.com:443", "example.com:80"]);
    },
    CALL_MS * 4,
  );

  it(
    "hands the screenshot to a model that can see images and only a note to one that cannot",
    async () => {
      const seen = await use(
        call("call:shot-image", { action: "screenshot" }, "model-with-images"),
      );
      expect(seen.images?.[0]?.mimeType).toBe("image/png");
      expect(
        Buffer.from(seen.images?.[0]?.data ?? "", "base64")
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      expect(computer.calls.at(-1)?.allowedDomains).toEqual([]);
      const blind = await use(call("call:shot-text", { action: "screenshot" }));
      expect(blind.images).toBeUndefined();
      expect(blind.value).toMatchObject({ note: expect.stringContaining("read") });
    },
    CALL_MS * 2,
  );

  it("rejects arguments that do not belong to the action without touching the computer", async () => {
    const before = computer.calls.length;
    for (const args of [
      { action: "open", url: "file:///etc/passwd" },
      { action: "open", url: "https://example.com/", hosts: ["not a host"] },
      { action: "click" },
      { action: "read", url: "https://example.com/" },
      { action: "delete" },
    ])
      await expect(use(call(`call:invalid:${JSON.stringify(args)}`, args))).rejects.toMatchObject({
        code: "BROWSER_INPUT_INVALID",
      });
    expect(computer.calls.length).toBe(before);
  });
});
