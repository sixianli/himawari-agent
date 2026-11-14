import {
  actionIntentFingerprint,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
} from "@himawari-agent/application";
import { createIdempotencyKey, createRunId } from "@himawari-agent/domain";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(removeDeviceHarnessDirectories);

const scope = { ownerId, agentId };
const RUN_ID = "run-device-home";
const THREAD_ID = "thread-device-home";
let sequence = 0;

function seedRun(h: Harness) {
  const when = h.clock.now();
  const handle = openQualifiedDatabase(h.repository.databasePath);
  try {
    handle
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'open', ?, ?)`,
      )
      .run(THREAD_ID, ownerId, agentId, when, when);
    handle
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
          encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
        ) VALUES ('payload-trigger', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:trigger',
          'fixture', 'fixture-key', 'active', ?, 'application/octet-stream')`,
      )
      .run(ownerId, agentId, when);
    handle
      .prepare(
        `INSERT INTO triggers (
          id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
          payload_ref, source_proof_ref, occurred_at
        ) VALUES ('trigger-home', ?, ?, ?, 'key-home', 'user_message', 'home', 'payload-trigger',
          'proof', ?)`,
      )
      .run(ownerId, agentId, THREAD_ID, when);
    handle
      .prepare(
        `INSERT INTO runs (
          id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'session', 'trigger-home', 2, 'running', ?, ?)`,
      )
      .run(RUN_ID, ownerId, agentId, THREAD_ID, when, when);
  } finally {
    handle.close();
  }
}

async function createApproval(
  h: Harness,
  id: string,
  options: { readonly recentAuthenticationRequired?: boolean } = {},
) {
  const at = (minutes: number) =>
    new Date(Date.parse(h.clock.now()) + minutes * 60_000).toISOString();
  const intent: GovernedActionIntent = {
    id: `intent-${id}`,
    ...scope,
    runId: createRunId(RUN_ID),
    capabilityRef: "capability-home",
    operation: "read",
    resourceRef: "resource-home",
    dataClassification: "private",
    sideEffect: "none",
    estimatedCostMicros: 0,
    frequency: { count: 1, intervalMs: null },
    idempotencyKey: createIdempotencyKey(`intent-${id}`),
    reversible: true,
    requestedAt: at(-5),
    contractVersion: "authorization.v2",
    threadId: THREAD_ID,
    capabilityVersion: "1.0.0",
    actionKind: "READ",
    targets: [{ type: "workspace", ref: "resource-home" }],
    resourceRefs: ["resource-home"],
    disclosure: "none",
    recipients: [],
    credentialOrAccessChange: false,
    expiresAt: at(900),
    modelClassification: { actionKind: "READ", suggestedRisk: "LOW", reasonCode: "fixture" },
    deterministicFacts: [],
    finalRisk: "LOW",
  } as GovernedActionIntent;
  const approval: GovernedApprovalRequest = {
    id,
    revision: 1,
    ...scope,
    runId: createRunId(RUN_ID),
    intentId: intent.id,
    intentSnapshot: intent,
    semanticSnapshotHash: actionIntentFingerprint(intent),
    status: "pending",
    deliveryState: "deliverable",
    requestedAt: at(-5),
    expiresAt: at(600),
    decidedAt: null,
    grantId: null,
    recentAuthenticationRequired: options.recentAuthenticationRequired ?? false,
    recentAuthenticationRef: null,
    finalRisk: "LOW",
  };
  return h.repository.authorizationStore().createApproval(approval);
}

interface HomeBody {
  readonly items: readonly {
    readonly key: string;
    readonly actions: readonly {
      readonly action: string;
      readonly ownerPresence: boolean;
      readonly binding: string | null;
    }[];
  }[];
  readonly awaitingCount: number;
  readonly revision: string;
}

async function readHome(h: Harness, client: PairedClient, locale = "en") {
  return send(
    h,
    signedRequest(h, client, { method: "GET", path: `/api/device/v1/home?locale=${locale}` }),
  );
}

async function act(
  h: Harness,
  client: PairedClient,
  body: Record<string, unknown>,
  options: { readonly confirm?: { readonly nonce: string } } = {},
) {
  sequence += 1;
  return send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/home/act",
      body: JSON.stringify({ requestId: `home-request-${sequence}`, ...body }),
      ...(options.confirm
        ? { confirmKey: client.confirmKeys.privateKey, nonce: options.confirm.nonce }
        : {}),
    }),
  );
}

async function challenge(h: Harness, client: PairedClient) {
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/approvals/challenge",
      body: "{}",
    }),
  );
  return response.json() as { challenge: string };
}

async function homeActions(h: Harness, client: PairedClient, key: string) {
  const body = (await readHome(h, client)).json() as HomeBody;
  return body.items.find((item) => item.key === key)?.actions ?? [];
}

describe("首页设备入口：读首页和点首页动作", () => {
  it("GET home 直接给条目列表、件数和版本号，动作带绑定串", async () => {
    const h = await harness();
    seedRun(h);
    const client = await pairAndConfirm(h);
    const empty = (await readHome(h, client)).json() as HomeBody;
    expect(empty.items).toEqual([]);
    expect(empty.awaitingCount).toBe(0);

    await createApproval(h, "approval-home-read");
    const response = await readHome(h, client, "zh-CN");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as HomeBody;
    expect(body.awaitingCount).toBe(1);
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.items.map(({ key }) => key)).toEqual(["approval:approval-home-read"]);
    expect(body.items[0]?.actions.map(({ action }) => action)).toEqual(["approved", "denied"]);
    for (const entry of body.items[0]?.actions ?? [])
      expect(entry.binding).toMatch(/^b1\.[A-Za-z0-9_-]+$/u);
    await h.repository.close();
  });

  it("GET home 要签名，语言必须是支持的三种之一，不接别的参数", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const unsigned = await h.app.inject({
      method: "GET",
      url: "/api/device/v1/home?locale=en",
      headers: { host: new URL(h.origin).host },
    });
    expect(unsigned.statusCode).toBe(401);
    expect((await readHome(h, client, "fr")).statusCode).toBe(400);
    const extra = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/home?locale=en&limit=1" }),
    );
    expect(extra.statusCode).toBe(400);
    const missing = await send(
      h,
      signedRequest(h, client, { method: "GET", path: "/api/device/v1/home" }),
    );
    expect(missing.statusCode).toBe(400);
    await h.repository.close();
  });

  it("点“不同意”：转给审批命令执行，条目收走，审计记成首页动作", async () => {
    const h = await harness();
    seedRun(h);
    const client = await pairAndConfirm(h);
    await createApproval(h, "approval-home-deny");
    const denied = (await homeActions(h, client, "approval:approval-home-deny")).find(
      ({ action }) => action === "denied",
    );
    const response = await act(h, client, {
      key: "approval:approval-home-deny",
      action: "denied",
      binding: denied?.binding,
    });
    expect(response.statusCode, response.body).toBe(200);
    const after = (await readHome(h, client)).json() as HomeBody;
    expect(after.items).toEqual([]);
    const trail = (await h.repository.auditLedger().listByAgent(agentId as never, null))
      .filter(({ action }) => action === "device.home.act")
      .map(({ outcome }) => outcome)
      .sort();
    expect(trail).toEqual(["accepted", "completed"]);
    await h.repository.close();
  });

  it("同一个请求编号重发只生效一次", async () => {
    const h = await harness();
    seedRun(h);
    const client = await pairAndConfirm(h);
    await createApproval(h, "approval-home-replay");
    const approved = (await homeActions(h, client, "approval:approval-home-replay")).find(
      ({ action }) => action === "approved",
    );
    const body = {
      requestId: "home-request-replay",
      key: "approval:approval-home-replay",
      action: "approved",
      binding: approved?.binding,
    };
    const first = await act(h, client, body);
    expect(first.statusCode, first.body).toBe(200);
    const second = await act(h, client, body);
    expect([200, 409]).toContain(second.statusCode);
    const approvals = await h.repository
      .authorizationStore()
      .listApprovals(ownerId, agentId, { status: "approved" });
    expect(approvals.map(({ id }) => id)).toEqual(["approval-home-replay"]);
    await h.repository.close();
  });

  it("绑定串对不上就拒绝：别的条目的、乱写的、条目已不在的、动作没提供的、已在别处答过的", async () => {
    const h = await harness();
    seedRun(h);
    const client = await pairAndConfirm(h);
    await createApproval(h, "approval-home-a");
    await createApproval(h, "approval-home-b");
    const a = await homeActions(h, client, "approval:approval-home-a");
    const b = await homeActions(h, client, "approval:approval-home-b");
    const approveA = a.find(({ action }) => action === "approved")?.binding;
    const approveB = b.find(({ action }) => action === "approved")?.binding;
    const denyA = a.find(({ action }) => action === "denied")?.binding;

    const crossItem = await act(h, client, {
      key: "approval:approval-home-a",
      action: "approved",
      binding: approveB,
    });
    expect(crossItem.statusCode).toBe(409);
    expect(crossItem.json()).toEqual({ error: { code: "DEVICE_HOME_ACTION_STALE" } });

    const wrongDirection = await act(h, client, {
      key: "approval:approval-home-a",
      action: "approved",
      binding: denyA,
    });
    expect(wrongDirection.statusCode).toBe(409);

    const garbage = await act(h, client, {
      key: "approval:approval-home-a",
      action: "approved",
      binding: "b1.not-a-binding",
    });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json()).toEqual({ error: { code: "DEVICE_HOME_ACTION_INVALID" } });

    const unknownAction = await act(h, client, {
      key: "approval:approval-home-a",
      action: "mute",
      binding: approveA,
    });
    expect(unknownAction.statusCode).toBe(400);

    const unknownItem = await act(h, client, {
      key: "approval:approval-home-missing",
      action: "approved",
      binding: approveA,
    });
    expect(unknownItem.statusCode).toBe(409);

    const missing = await act(h, client, { key: "approval:approval-home-a", action: "approved" });
    expect(missing.statusCode).toBe(400);
    const extra = await act(h, client, {
      key: "approval:approval-home-a",
      action: "approved",
      binding: approveA,
      confirm: true,
    });
    expect(extra.statusCode).toBe(400);

    const created = await h.repository.authorizationStore().getApproval("approval-home-a");
    await h.repository.authorizationStore().resolveApproval({
      approvalRequestId: "approval-home-a",
      expectedRevision: created?.revision ?? 0,
      semanticSnapshotHash: created?.semanticSnapshotHash ?? "",
      resolution: "denied",
      decidedAt: h.clock.now(),
      grant: null,
    });
    const changed = await act(h, client, {
      key: "approval:approval-home-a",
      action: "approved",
      binding: approveA,
    });
    expect(changed.statusCode).toBe(409);
    expect(
      (
        await h.repository
          .authorizationStore()
          .listApprovals(ownerId, agentId, { status: "approved" })
      ).length,
    ).toBe(0);
    await h.repository.close();
  });

  it("要本人在场的审批：没有确认签名被拒，用挑战值加确认签名才执行", async () => {
    const h = await harness();
    seedRun(h);
    const client = await pairAndConfirm(h);
    await createApproval(h, "approval-home-present", { recentAuthenticationRequired: true });
    const approve = (await homeActions(h, client, "approval:approval-home-present")).find(
      ({ action }) => action === "approved",
    );
    expect(approve?.ownerPresence).toBe(true);
    const body = {
      key: "approval:approval-home-present",
      action: "approved",
      binding: approve?.binding,
    };
    const unconfirmed = await act(h, client, body);
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json()).toEqual({ error: { code: "DEVICE_GATEWAY_CONFIRM_REQUIRED" } });
    expect(
      (
        await h.repository
          .authorizationStore()
          .listApprovals(ownerId, agentId, { status: "approved" })
      ).length,
    ).toBe(0);
    const issued = await challenge(h, client);
    const confirmed = await act(h, client, body, { confirm: { nonce: issued.challenge } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await h.repository.close();
  });
});
