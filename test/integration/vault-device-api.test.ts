import { randomBytes } from "node:crypto";
import type { VaultReleaseOutcome } from "@himawari-agent/application";
import { type VaultPhonePendingRequest, VaultTestPhone } from "@himawari-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  web,
} from "../fixtures/device-api-harness.ts";

const bankPw = `pw-${randomBytes(6).toString("hex")}`;
const scope = { ownerId, agentId };
const BANK = "https://bank.example.com";

afterEach(async () => {
  await removeDeviceHarnessDirectories();
});

async function post(
  h: Harness,
  client: PairedClient,
  path: string,
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
      path: `/api/device/v1/${path}`,
      body: JSON.stringify(body),
      ...(nonce === undefined ? {} : { confirmKey: client.confirmKeys.privateKey, nonce }),
    }),
  );
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function snapshot(h: Harness, client: PairedClient) {
  const response = await send(
    h,
    signedRequest(h, client, { method: "GET", path: "/api/device/v1/vault" }),
  );
  expect(response.statusCode).toBe(200);
  return response.json() as {
    manifest: { version: number; signature: string } | null;
    items: { id: string; name: string; origins: string[]; wrappedKey: string }[];
    pending: VaultPhonePendingRequest[];
  };
}

async function requestWithItem(h: Harness, client: PairedClient, phone: VaultTestPhone) {
  const added = phone.add({
    name: "招商银行网银",
    kind: "login",
    origins: [BANK],
    values: { username: "andy", password: bankPw },
  });
  expect((await post(h, client, "vault/change", added.change)).status).toBe(200);
  const outcome = h.vault.requestRelease({
    ...scope,
    runId: "run-vault",
    itemIds: [added.id],
    origin: BANK,
    pageVersion: "page-1",
    purpose: "登录查余额",
    background: false,
  });
  await vi.waitFor(() => expect(h.vaultNotified).toHaveLength(1), { timeout: 10_000 });
  const pending = (await snapshot(h, client)).pending;
  expect(pending).toHaveLength(1);
  return { outcome, request: pending[0] as VaultPhonePendingRequest, itemId: added.id };
}

describe("[vault-approval] device API", () => {
  it("lists what the phone uploaded and verifies the manifest the server returns", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const phone = new VaultTestPhone();
    const added = phone.add({
      name: "API",
      kind: "api_key",
      origins: ["https://api.example.com"],
      values: { api_key: "k" },
    });
    expect((await post(h, client, "vault/change", added.change)).status).toBe(200);
    const listed = await snapshot(h, client);
    expect(listed.items.map((item) => item.id)).toEqual([added.id]);
    expect(
      phone.manifestSignatureValid(
        listed.manifest?.version ?? 0,
        listed.items as never,
        listed.manifest?.signature ?? "",
      ),
    ).toBe(true);
    const renamed = listed.items.map((item) => ({ ...item, name: "改过的名字" }));
    expect(
      phone.manifestSignatureValid(
        listed.manifest?.version ?? 0,
        renamed as never,
        listed.manifest?.signature ?? "",
      ),
    ).toBe(false);
    await h.repository.close();
  });

  it("an approval signed only by the device key is refused; with the Face ID key it releases", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const phone = new VaultTestPhone();
    const { outcome, request } = await requestWithItem(h, client, phone);
    const body = await phone.approval({ request, deviceId: client.deviceId });
    const unconfirmed = await post(h, client, "vault/approve", body);
    expect(unconfirmed.status).toBe(401);
    expect(unconfirmed.body).toMatchObject({ error: { code: "VAULT_CONFIRMATION_REQUIRED" } });
    const confirmed = await post(h, client, "vault/approve", body, true);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const result = (await outcome) as Extract<VaultReleaseOutcome, { kind: "approved" }>;
    expect(result.secrets.items[0]?.fields.get("password")?.toString("utf8")).toBe(bankPw);
    result.secrets.wipe();
    const replayed = await post(h, client, "vault/approve", body, true);
    expect(replayed.status).toBe(410);
    await h.repository.close();
  });
});

describe("[vault-approval] verification codes the owner types on the phone", () => {
  it("lists the waiting request and hands the typed code to the task, once", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const waiting = h.vault.requestCode({
      ...scope,
      origin: BANK,
      purpose: "招商银行发到你手机的短信验证码",
    });
    await vi.waitFor(() => expect(h.vaultNotified).toHaveLength(1), { timeout: 10_000 });
    const listed = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/vault/codes" }),
    );
    expect(listed.statusCode).toBe(200);
    const requests = (listed.json() as { requests: { id: string; origin: string }[] }).requests;
    expect(requests).toMatchObject([{ origin: BANK, purpose: "招商银行发到你手机的短信验证码" }]);
    const id = requests[0]?.id as string;
    const answered = await post(h, client, "vault/codes/answer", {
      requestId: id,
      code: "48-29 10",
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect(waiting).resolves.toEqual({ kind: "answered", code: "482910" });
    const again = await post(h, client, "vault/codes/answer", { requestId: id, code: "111111" });
    expect(again.status).toBe(410);
    const empty = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/vault/codes" }),
    );
    expect((empty.json() as { requests: unknown[] }).requests).toEqual([]);
    await h.repository.close();
  });

  it("declining ends the wait without a code", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const waiting = h.vault.requestCode({ ...scope, origin: BANK, purpose: "邮件验证码" });
    await vi.waitFor(() => expect(h.vaultNotified).toHaveLength(1), { timeout: 10_000 });
    const id = h.vaultNotified[0] as string;
    expect((await post(h, client, "vault/codes/decline", { requestId: id })).status).toBe(200);
    await expect(waiting).resolves.toEqual({ kind: "declined" });
    await h.repository.close();
  });
});

describe("[vault-recovery] device API", () => {
  it("a revoked phone can no longer approve", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const other = await pairAndConfirm(h, "Andy 的新 iPhone");
    const phone = new VaultTestPhone();
    const { outcome, request } = await requestWithItem(h, client, phone);
    const body = await phone.approval({ request, deviceId: client.deviceId });
    expect(
      (await web(h, "revoke", { deviceId: client.deviceId, expectedRevision: client.revision }))
        .status,
    ).toBe(200);
    const refused = await post(h, client, "vault/approve", body, true);
    expect(refused.status).toBe(403);
    const fromOther = await post(h, other, "vault/approve", body, true);
    expect(fromOther.status).toBe(409);
    expect(fromOther.body).toMatchObject({ error: { code: "VAULT_REQUEST_MISMATCH" } });
    await post(h, other, "vault/deny", { requestId: request.id, nonce: request.nonce });
    expect((await outcome).kind).toBe("denied");
    await h.repository.close();
  });
});
