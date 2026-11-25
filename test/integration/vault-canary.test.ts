import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeToolInvocation, VaultReleaseOutcome } from "@himawari-agent/application";
import { TOOL_VAULT_LIST } from "@himawari-agent/prompt-catalog";
import {
  findVaultCanary,
  type VaultPhonePendingRequest,
  VaultTestPhone,
  vaultCanaryForms,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applePushVaultApprovalPayload } from "../../apps/agent-service/src/production-apple-push.ts";
import {
  ProductionVaultTools,
  vaultToolDescriptors,
} from "../../apps/agent-service/src/production-vault-tools.ts";
import {
  agentId,
  type Harness,
  harness,
  ownerId,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";

const scope = { ownerId, agentId };
const PASSWORD = `Vault-Canary-Pw-${randomBytes(4).toString("hex")}`;
const API_KEY = `vault-canary-key-${randomBytes(4).toString("hex")}`;
const USERNAME = "vault-canary-user-31c8";
const SEED = "VAULTCANARYSEEDQK7";
const CANARIES = [PASSWORD, API_KEY, USERNAME, SEED];

afterEach(async () => {
  await removeDeviceHarnessDirectories();
});

function leaks(where: string, haystack: string | Uint8Array): string[] {
  return CANARIES.flatMap((canary) => {
    const form = findVaultCanary(haystack, canary);
    return form === undefined ? [] : [`${where}: ${form}`];
  });
}

async function stateFiles(root: string): Promise<{ name: string; bytes: Buffer }[]> {
  const files: { name: string; bytes: Buffer }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.push({ name: path.relative(root, full), bytes: await readFile(full) });
  }
  return files;
}

async function post(
  h: Harness,
  client: PairedClient,
  route: string,
  body: unknown,
  confirmed = false,
) {
  const nonce = confirmed
    ? (
        (
          await send(
            h,
            signedRequest(h, client, {
              method: "POST",
              path: "/api/device/v1/approvals/challenge",
              body: "{}",
            }),
          )
        ).json() as { challenge: string }
      ).challenge
    : undefined;
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: `/api/device/v1/${route}`,
      body: JSON.stringify(body),
      ...(nonce === undefined ? {} : { confirmKey: client.confirmKeys.privateKey, nonce }),
    }),
  );
  return response;
}

function invocation(): RuntimeToolInvocation {
  return {
    runId: "run-canary",
    toolCallId: "call-1",
    capabilityRef: "vault.list",
    capabilityHandleRef: null,
    arguments: {},
  } as unknown as RuntimeToolInvocation;
}

describe("[vault-canary] a stored value never shows up outside the release", () => {
  it("the canary scanner finds a value in every encoding it claims to cover", () => {
    for (const form of vaultCanaryForms(PASSWORD))
      expect(findVaultCanary(`prefix ${form} suffix`, PASSWORD), form).toBe(form);
    expect(
      findVaultCanary(Buffer.from(`x${Buffer.from(PASSWORD).toString("base64")}y`), PASSWORD),
    ).toBeDefined();
    expect(findVaultCanary("nothing here", PASSWORD)).toBeUndefined();
  });

  it("a tool that returned the value would be caught", async () => {
    const leaky = new ProductionVaultTools({
      scope,
      list: async () => [
        { id: "vi_AAAAAAAAAAAAAAAAAAAAAA", name: PASSWORD, kind: "login", sites: [] },
      ],
    });
    expect(leaks("tool", JSON.stringify(await leaky.run(invocation())))).not.toEqual([]);
  });

  it("upload, list, approve and release leave no copy in the database, responses, tool results or push", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const phone = new VaultTestPhone();
    const found: string[] = [];
    const login = phone.add({
      name: "招商银行网银",
      kind: "login",
      origins: ["https://bank.example.com"],
      values: { username: USERNAME, password: PASSWORD, totp: SEED },
    });
    const change1 = await post(h, client, "vault/change", login.change);
    expect(change1.statusCode).toBe(200);
    found.push(
      ...leaks("upload request", JSON.stringify(login.change)),
      ...leaks("upload response", change1.body),
    );
    const api = phone.add({
      name: "天气 API",
      kind: "api_key",
      origins: ["https://api.weather.example"],
      values: { api_key: API_KEY },
    });
    expect((await post(h, client, "vault/change", api.change)).statusCode).toBe(200);

    const tools = new ProductionVaultTools({ scope, list: (s) => h.vault.listForModel(s) });
    found.push(...leaks("tool result", JSON.stringify(await tools.run(invocation()))));
    found.push(
      ...leaks("tool definition", JSON.stringify(vaultToolDescriptors())),
      ...leaks("tool text", TOOL_VAULT_LIST.text),
    );

    const releasing = h.vault.requestRelease({
      ...scope,
      runId: "run-canary",
      itemIds: [login.id],
      origin: "https://bank.example.com",
      pageVersion: "page-1",
      purpose: "登录",
      background: false,
    });
    await vi.waitFor(() => expect(h.vaultNotified).toHaveLength(1), { timeout: 10_000 });
    const listed = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/vault" }),
    );
    found.push(...leaks("phone snapshot", listed.body));
    const request = (listed.json() as { pending: VaultPhonePendingRequest[] })
      .pending[0] as VaultPhonePendingRequest;
    found.push(
      ...leaks(
        "push payload",
        applePushVaultApprovalPayload({ title: "t", body: "b", requestId: request.id }),
      ),
    );
    const approved = await post(
      h,
      client,
      "vault/approve",
      await phone.approval({ request, deviceId: client.deviceId }),
      true,
    );
    expect(approved.statusCode).toBe(200);
    found.push(...leaks("approve response", approved.body));
    const outcome = (await releasing) as Extract<VaultReleaseOutcome, { kind: "approved" }>;
    expect(outcome.secrets.items[0]?.fields.get("password")?.toString("utf8")).toBe(PASSWORD);
    await h.vault.recordFill(scope, outcome.secrets, "filled");
    outcome.secrets.wipe();
    const usage = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/vault/usage" }),
    );
    found.push(...leaks("usage", usage.body));
    found.push(...leaks("warnings", JSON.stringify(h.warnings)));

    await h.repository.close();
    const files = await stateFiles(h.stateRoot);
    expect(files.some((file) => findVaultCanary(file.bytes, "招商银行网银") !== undefined)).toBe(
      true,
    );
    for (const file of files) found.push(...leaks(`state ${file.name}`, file.bytes));
    expect(found).toEqual([]);
  });
});
