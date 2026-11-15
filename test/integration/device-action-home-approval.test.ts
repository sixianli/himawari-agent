import { DEVICE_ACTION_RECORD_STATES, ToolActionRegistry } from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerScopeAuthorization } from "../../apps/agent-service/src/owner-scope-authorization.ts";
import { productionDeviceActionAuthorization } from "../../apps/agent-service/src/production-device-action-authorization.ts";
import { ProductionPerceptionTools } from "../../apps/agent-service/src/production-perception-tools.ts";
import { PRODUCTION_TOOL_ACTION_ROWS } from "../../apps/agent-service/src/production-tool-actions.ts";
import {
  agentId,
  authorityLease,
  type Harness,
  harness,
  ownerId,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";
import { devicePost, perceptionScope } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

function seedUserRun(h: Harness, runId: string) {
  const when = h.clock.now();
  const handle = openQualifiedDatabase(h.repository.databasePath);
  try {
    handle
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
        VALUES ('thread-home-approval', ?, ?, 1, 'open', ?, ?)`,
      )
      .run(ownerId, agentId, when, when);
    handle
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
          encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
        ) VALUES ('payload-home-approval', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:home',
          'fixture', 'fixture-key', 'active', ?, 'application/octet-stream')`,
      )
      .run(ownerId, agentId, when);
    handle
      .prepare(
        `INSERT INTO triggers (
          id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
          payload_ref, source_proof_ref, occurred_at
        ) VALUES ('trigger-home-approval', ?, ?, 'thread-home-approval', 'key-home-approval',
          'user_message', 'message-home-approval', 'payload-home-approval', 'proof', ?)`,
      )
      .run(ownerId, agentId, when);
    handle
      .prepare(
        `INSERT INTO runs (
          id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'thread-home-approval', ?, 'trigger-home-approval', 2, 'running', ?, ?)`,
      )
      .run(runId, ownerId, agentId, h.webAuthentication.sessionId, when, when);
    handle
      .prepare(
        `INSERT INTO thread_messages (
          id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
          classification, committed_at, run_id, message_status
        ) VALUES ('message-home-approval', ?, ?, 'thread-home-approval', 0, 1, 'owner',
          'payload-home-approval', 'private', ?, ?, 'committed')`,
      )
      .run(ownerId, agentId, when, runId);
  } finally {
    handle.close();
  }
}

async function setup(h: Harness) {
  const registry = new ToolActionRegistry(PRODUCTION_TOOL_ACTION_ROWS);
  let sequence = 0;
  const ownerScope = new OwnerScopeAuthorization({
    externalContent: h.externalContent,
    configuration: { ownerId, agentId },
    store: h.repository.authorizationStore(),
    audit: h.repository.auditLedger(),
    state: h.repository,
    authority: () => authorityLease as never,
    source: h.repository.runExecutionSource(ownerId, agentId),
    installedCapabilities: { inspect: async () => undefined },
    registry,
    clock: { now: () => h.clock.now() },
    ids: { next: (scope: string) => `${scope}:home:${++sequence}` },
    intentLifetimeMs: 600_000,
  });
  h.actions.authorization.current = productionDeviceActionAuthorization({ ownerScope, registry });
  const tools = new ProductionPerceptionTools({
    scope: perceptionScope,
    store: h.repository.perception(),
    devices: (scope) => h.repository.pairedDevices().listDevices(scope),
    readText: h.readText,
    configuration: () => h.perceptionConfiguration.current,
    ...h.actions.tools,
    timeZone: "Asia/Tokyo",
    now: () => h.clock.now(),
  });
  return async (runId: string, args: Record<string, unknown>, toolCallId: string) =>
    tools.run(
      {
        runId: createRunId(runId),
        toolCallId,
        capabilityRef: "device.action",
        capabilityHandleRef: null,
        arguments: args as never,
        dataClassification: "private",
      },
      {
        authorize: async () => undefined,
        markExternalContent: () => h.externalContent.mark(createRunId(runId), "perception_read"),
      },
    );
}

interface HomeBody {
  readonly items: readonly {
    readonly key: string;
    readonly actions: readonly { readonly action: string; readonly binding: string | null }[];
  }[];
}

async function homeItems(h: Harness, client: PairedClient) {
  const response = await send(
    h,
    signedRequest(h, client, { method: "GET", path: "/api/device/v1/home?locale=zh-CN" }),
  );
  return (response.json() as HomeBody).items;
}

let requests = 0;
async function tap(h: Harness, client: PairedClient, key: string, action: string) {
  const item = (await homeItems(h, client)).find((entry) => entry.key === key);
  const binding = item?.actions.find((entry) => entry.action === action)?.binding;
  requests += 1;
  return send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/home/act",
      body: JSON.stringify({ key, action, binding, requestId: `home-device-${requests}` }),
    }),
  );
}

const states = async (h: Harness) =>
  (
    await h.repository.deviceActions().list({
      ...perceptionScope,
      deviceId: null,
      states: DEVICE_ACTION_RECORD_STATES,
      limit: 100,
    })
  ).map(({ state }) => state);

async function askedAction(h: Harness, client: PairedClient) {
  await devicePost(h, client, "actions/supported", { actions: ["alarm.set"] });
  seedUserRun(h, "run-1");
  await h.externalContent.mark(createRunId("run-1"), "perception_read");
  const run = await setup(h);
  const first = (await run(
    "run-1",
    { action: "alarm.set", arguments: { time: "2026-11-13T07:00" } },
    "call:1",
  )) as {
    value: Record<string, unknown>;
  };
  expect(first.value).toMatchObject({ state: "waiting_owner" });
  const [pending] = await h.repository
    .authorizationStore()
    .listApprovals(ownerId, agentId, { status: "pending" });
  return pending;
}

describe("设备动作的审批从首页点", () => {
  it("点同意：同一个审批命令放行，动作进队列", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const pending = await askedAction(h, client);
    expect(await states(h)).toEqual(["waiting_owner"]);
    const key = `approval:${pending?.id}`;
    expect((await homeItems(h, client)).map((item) => item.key)).toContain(key);
    const response = await tap(h, client, key, "approved");
    expect(response.statusCode, response.body).toBe(200);
    expect(await states(h)).toEqual(["queued"]);
    expect((await homeItems(h, client)).map((item) => item.key)).not.toContain(key);
    await h.repository.close();
  });

  it("点不同意：动作被拒，不进队列", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const pending = await askedAction(h, client);
    const response = await tap(h, client, `approval:${pending?.id}`, "denied");
    expect(response.statusCode, response.body).toBe(200);
    expect(await states(h)).toEqual(["rejected"]);
    await h.repository.close();
  });
});
