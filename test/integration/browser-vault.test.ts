import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  type RuntimeToolInvocation,
  type VaultCodeRequestRecord,
  VaultService,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { NodeVaultCrypto } from "@himawari-agent/platform-node";
import { totpCode, VaultTestPhone } from "@himawari-agent/testing";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CAPABILITY_REF,
  BrowserToolError,
  ProductionBrowserTools,
} from "../../apps/agent-service/src/production-browser-tools.js";
import { ComputerOnThisMachine, freePort } from "../fixtures/browser-computer.ts";

const CALL_MS = 90_000;
const SITE = "https://the-internet.herokuapp.com";
const SEED = "JBSWY3DPEHPK3PXP";
const OWNER_ID = createOwnerId("owner-browser-vault");
const AGENT_ID = createAgentId("agent-browser-vault");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const DEVICE = "device-vault-phone-0001";

let stateRoot = "";
let home = "";
let repository: SqliteProductStateRepository;
let computer: ComputerOnThisMachine;
let service: VaultService;
let tools: ProductionBrowserTools;
let phone: VaultTestPhone;
let loginId = "";
let demoPassword = "";
let elsewhereId = "";
let sequence = 0;
const approvals: string[] = [];
const codeRequests: VaultCodeRequestRecord[] = [];
let answer: (request: VaultCodeRequestRecord) => void = () => undefined;
let decide: "approve" | "deny" = "approve";

beforeAll(async () => {
  stateRoot = await mkdtemp(path.join(testTemporaryRoot(), "browser-vault-state-"));
  const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database.close();
  repository = await SqliteProductStateRepository.open({
    stateRoot,
    minimumFreeBytes: 0,
    now: () => new Date().toISOString(),
  });
  phone = new VaultTestPhone();
  service = new VaultService({
    store: repository.vault(),
    crypto: new NodeVaultCrypto(),
    notifier: {
      approvalNeeded: async (input) => {
        approvals.push(input.requestId);
        queueMicrotask(() => void settleApproval(input.requestId));
      },
      codeNeeded: async (input) => {
        const request = service.pendingCodes(scope).find(({ id }) => id === input.requestId);
        if (!request) throw new Error("code request missing");
        codeRequests.push(request);
        queueMicrotask(() => answer(request));
      },
    },
    now: () => new Date(),
  });
  const elsewhere = phone.add({
    name: "别的银行",
    kind: "login",
    origins: ["https://bank.example.com"],
    values: { password: "x" },
  });
  await service.applyDeviceChange(scope, elsewhere.change);
  elsewhereId = elsewhere.id;
  home = await mkdtemp(path.join(testTemporaryRoot(), "browser-vault-home-"));
  computer = new ComputerOnThisMachine(home, await freePort());
  tools = new ProductionBrowserTools({
    ownerId: OWNER_ID,
    computer,
    maxOutputBytes: 8 * 1024 * 1024,
    maxTextChars: 20_000,
    responseReserveMs: 5_000,
    acceptsImages: () => false,
    now: () => Date.now(),
    vault: { scope, service },
  });
}, CALL_MS);

afterAll(async () => {
  await computer?.run(["stop"], new Uint8Array(), new Date(Date.now() + CALL_MS).toISOString());
  await repository?.close();
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
}, CALL_MS);

async function settleApproval(requestId: string): Promise<void> {
  const snapshot = await service.snapshot(scope);
  const request = snapshot.pending.find(({ id }) => id === requestId);
  if (!request) return;
  if (decide === "deny") {
    await service.deny(scope, { requestId, nonce: request.nonce });
    return;
  }
  await service.approve(
    scope,
    { deviceId: DEVICE, confirmed: true },
    await phone.approval({ request, deviceId: DEVICE }),
  );
}

function call(args: Record<string, unknown>): RuntimeToolInvocation {
  return {
    runId: createRunId("run-browser-vault"),
    toolCallId: `call:${++sequence}`,
    capabilityRef: BROWSER_CAPABILITY_REF,
    capabilityHandleRef: null,
    arguments: args as RuntimeToolInvocation["arguments"],
    dataClassification: "private",
    executionDeadlineAt: new Date(Date.now() + CALL_MS).toISOString(),
    context: { threadId: "thread-browser-vault", modelRef: "model-text-only" } as never,
  };
}

const hooks = {
  authorizeSites: async () => undefined,
  markExternalContent: async () => undefined,
};

async function use(args: Record<string, unknown>) {
  return (await tools.run(call(args), hooks)).value as {
    page: { url: string; title: string };
    text: string;
    filled?: string[];
  };
}

function textboxRefs(text: string): string[] {
  return [...text.matchAll(/\[(e\d+) textbox "[^"]*"/gu)].map((match) => match[1] as string);
}

async function rejection(promise: Promise<unknown>): Promise<BrowserToolError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BrowserToolError);
  return error as BrowserToolError;
}

async function usage() {
  return (await service.usage(scope, loginId)).map(({ outcome }) => outcome);
}

describe("browser signs in from the vault after one Face ID approval", () => {
  it(
    "fills username and password from the vault, submits, and never shows them to the model",
    async () => {
      const opened = await use({ action: "open", url: `${SITE}/login` });
      const [username, password] = textboxRefs(opened.text);
      expect(username && password).toBeTruthy();
      const published = /Enter (\S+) for the username and (\S+) for the password/u.exec(
        opened.text,
      );
      if (!published)
        throw new Error(`the demo site no longer publishes its login:\n${opened.text}`);
      demoPassword = published[2] as string;
      const login = phone.add({
        name: "the-internet",
        kind: "login",
        origins: [SITE],
        values: { username: published[1] as string, password: published[2] as string, totp: SEED },
      });
      await service.applyDeviceChange(scope, login.change);
      loginId = login.id;
      const before = approvals.length;
      const signed = await use({
        action: "sign_in",
        item: loginId,
        fields: { username, password },
        submit: true,
        purpose: "登录测试站",
      });
      expect(approvals.length).toBe(before + 1);
      expect(signed.page.url).toBe(`${SITE}/secure`);
      expect(signed.text).toMatch(/You logged into a secure area/u);
      expect(signed.filled).toEqual(["username", "password"]);
      expect(JSON.stringify(signed)).not.toContain(demoPassword);
      expect(await usage()).toContain("filled");
    },
    CALL_MS * 2,
  );

  it(
    "fills the two-step code the phone computed on a later page without asking again",
    async () => {
      const opened = await use({ action: "open", url: `${SITE}/inputs` });
      const field = textboxRefs(opened.text)[0];
      const before = approvals.length;
      const filled = await use({
        action: "sign_in",
        item: loginId,
        fields: { code: field },
        purpose: "填两步验证码",
      });
      expect(approvals.length).toBe(before);
      expect(filled.filled).toEqual(["code"]);
      expect(filled.text).toContain('value "[hidden]"');
      const now = Math.floor(Date.now() / 1000);
      for (const at of [now - 30, now, now + 30])
        expect(filled.text).not.toContain(totpCode(SEED, at));
    },
    CALL_MS * 2,
  );

  it(
    "refuses a field that is not a password box without asking the owner",
    async () => {
      const opened = await use({ action: "read" });
      const field = textboxRefs(opened.text)[0];
      const before = approvals.length;
      const error = await rejection(
        tools.run(
          call({
            action: "sign_in",
            item: loginId,
            fields: { password: field },
            purpose: "填密码",
          }),
          hooks,
        ),
      );
      expect(error.code).toBe("VAULT_FIELD_NOT_ALLOWED");
      expect(approvals.length).toBe(before);
    },
    CALL_MS,
  );

  it(
    "refuses an item whose site is not this page without asking the owner",
    async () => {
      const opened = await use({ action: "open", url: `${SITE}/login` });
      const password = textboxRefs(opened.text)[1];
      const before = approvals.length;
      const error = await rejection(
        tools.run(
          call({
            action: "sign_in",
            item: elsewhereId,
            fields: { password },
            purpose: "登录",
          }),
          hooks,
        ),
      );
      expect(error.code).toBe("VAULT_ORIGIN_NOT_ALLOWED");
      expect(approvals.length).toBe(before);
    },
    CALL_MS,
  );

  it(
    "fills nothing when the owner declines on the phone",
    async () => {
      const opened = await use({ action: "open", url: `${SITE}/login` });
      const [username, password] = textboxRefs(opened.text);
      decide = "deny";
      try {
        const error = await rejection(
          tools.run(
            call({
              action: "sign_in",
              item: loginId,
              fields: { username, password },
              submit: true,
              purpose: "登录测试站",
            }),
            hooks,
          ),
        );
        expect(error.code).toBe("VAULT_DENIED");
      } finally {
        decide = "approve";
      }
      const after = await use({ action: "read" });
      expect(after.page.url).toBe(`${SITE}/login`);
      expect(after.text).toMatch(new RegExp(`\\[${username} textbox "[^"]*" \\(empty\\)\\]`, "u"));
    },
    CALL_MS,
  );
});

describe("browser asks the owner for a code the vault does not hold", () => {
  it(
    "pushes the request to the phone and types what the owner entered",
    async () => {
      const opened = await use({ action: "open", url: `${SITE}/inputs` });
      const field = textboxRefs(opened.text)[0] as string;
      answer = (request) => service.answerCode(scope, { requestId: request.id, code: "482 910" });
      const filled = await use({
        action: "ask_code",
        ref: field,
        purpose: "测试站发到你手机的短信验证码",
      });
      const request = codeRequests.at(-1);
      expect(request).toMatchObject({ origin: SITE, purpose: "测试站发到你手机的短信验证码" });
      expect(filled.filled).toEqual(["code"]);
      expect(filled.text).toContain(`[${field} textbox "" (value "[hidden]")]`);
      expect(filled.text).not.toContain("482910");
      expect(service.pendingCodes(scope)).toEqual([]);
    },
    CALL_MS,
  );

  it(
    "types nothing when the owner declines",
    async () => {
      const opened = await use({ action: "open", url: `${SITE}/inputs` });
      const field = textboxRefs(opened.text)[0] as string;
      answer = (request) => service.declineCode(scope, { requestId: request.id });
      const error = await rejection(
        tools.run(call({ action: "ask_code", ref: field, purpose: "短信验证码" }), hooks),
      );
      expect(error.code).toBe("VAULT_CODE_DECLINED");
      const after = await use({ action: "read" });
      expect(after.text).toContain(`[${field} textbox "" (empty)]`);
    },
    CALL_MS,
  );

  it("refuses a code that is not letters and digits", async () => {
    let pending: VaultCodeRequestRecord | undefined;
    answer = () => undefined;
    const waiting = service.requestCode({ ...scope, origin: SITE, purpose: "验证码" });
    await vi.waitFor(() => {
      pending = service.pendingCodes(scope)[0];
      expect(pending).toBeDefined();
    });
    const id = (pending as VaultCodeRequestRecord).id;
    expect(() => service.answerCode(scope, { requestId: id, code: "12<script>" })).toThrow(
      expect.objectContaining({ code: "VAULT_INPUT_INVALID" }),
    );
    expect(() =>
      service.answerCode(
        { ownerId: createOwnerId("someone-else"), agentId: AGENT_ID },
        { requestId: id, code: "123456" },
      ),
    ).toThrow(expect.objectContaining({ code: "VAULT_REQUEST_CLOSED" }));
    service.declineCode(scope, { requestId: id });
    await expect(waiting).resolves.toEqual({ kind: "declined" });
  });
});
