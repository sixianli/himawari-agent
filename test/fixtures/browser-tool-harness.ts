import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import { afterAll, beforeAll, expect } from "vitest";
import { ContextExternalContent } from "../../apps/agent-service/src/context-external-content.js";
import { OwnerAllowances } from "../../apps/agent-service/src/owner-allowances.js";
import { OwnerScopeAuthorization } from "../../apps/agent-service/src/owner-scope-authorization.js";
import {
  BROWSER_CAPABILITY_REF,
  BROWSER_SITE_TARGET,
  type BrowserComputer,
  type BrowserComputerExecInput,
  type BrowserComputerExecResult,
  ProductionBrowserTools,
} from "../../apps/agent-service/src/production-browser-tools.js";
import { productionToolActionRegistry } from "../../apps/agent-service/src/production-tool-actions.js";
import { openNetworkEgress } from "../../packages/runtime-sandbox/src/network-egress.ts";
import { PREINSTALLED_CHROMIUM } from "./chromium-launch.ts";
import { repositoryRoot } from "./product-path-harness.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openRepository,
  RUN_ID,
  SERVICE_AUTHORITY,
} from "./sqlite-capability-invocation-fixture.js";

const PROGRAM = path.join(
  repositoryRoot,
  "packages/runtime-sandbox/computer-image/himawari-browser.mjs",
);
export const CALL_MS = 90_000;
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

export class ComputerOnThisMachine implements BrowserComputer {
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

export let resource: Awaited<ReturnType<typeof openRepository>>;
export let computer: ComputerOnThisMachine;
export let ownerScope: OwnerScopeAuthorization;
export let allowances: OwnerAllowances;
export let externalContent: ContextExternalContent;
export let tools: ProductionBrowserTools;
export let home = "";
let sequence = 0;
const registry = productionToolActionRegistry();
const frozen = new Map<string, unknown>();
const row = registry.forCapability(BROWSER_CAPABILITY_REF);

export function installBrowserToolHarness(): void {
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
      readLocale: async () =>
        (
          await resource.repository
            .ownerPreferences()
            .read({ ownerId: OWNER_ID, agentId: AGENT_ID })
        ).locale,
    });
  }, CALL_MS);

  afterAll(async () => {
    await computer?.run(["stop"], new Uint8Array(), new Date(Date.now() + CALL_MS).toISOString());
    await resource?.repository.close();
    if (resource) await rm(resource.stateRoot, { recursive: true, force: true });
    if (home) await rm(home, { recursive: true, force: true });
  }, CALL_MS);
}

export function call(
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

export class Stopped extends Error {
  readonly decision: string;
  constructor(decision: string) {
    super(decision);
    this.decision = decision;
  }
}

export async function use(invocation: RuntimeToolInvocation) {
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

export async function pending(): Promise<GovernedApprovalRequest> {
  const all = (await resource.repository
    .authorizationStore()
    .listApprovals(OWNER_ID, AGENT_ID)) as readonly GovernedApprovalRequest[];
  const waiting = all.filter(({ status }) => status === "pending");
  expect(waiting).toHaveLength(1);
  return waiting[0] as GovernedApprovalRequest;
}

export async function respond(approval: GovernedApprovalRequest, decision: "approved" | "denied") {
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

export async function approveThenUse(
  invocation: RuntimeToolInvocation,
  allowFor?: "this_task" | "always",
) {
  await expect(use(invocation)).rejects.toBeInstanceOf(Stopped);
  const approval = await pending();
  await respond(approval, "approved");
  if (allowFor) await allowances.set({ approvalRequestId: approval.id, allowFor, days: null });
  return use(invocation);
}

export function refOf(text: string, pattern: RegExp): string {
  for (const line of text.split("\n"))
    for (const match of line.matchAll(/\[((?:f\d+)?e\d+) ([a-z]+) "([^"]*)"/gu))
      if (pattern.test(`${match[2]} ${match[3]}`)) return match[1] as string;
  throw new Error(`no element matching ${pattern} in:\n${text.slice(0, 2000)}`);
}
