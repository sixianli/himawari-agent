import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import {
  DEVICE_ACTION_RECORD_STATES,
  DEVICE_ACTION_REGISTRATIONS,
  DEVICE_ACTION_REGISTRY,
  DEVICE_ACTION_RESULT_MAXIMUM_BYTES,
  type DeviceActionAuthorizationPort,
  type DeviceActionIntent,
  type DeviceActionRegistration,
  DeviceActionRegistry,
  type DeviceActionResolution,
  PERCEPTION_CONFIGURATION_DEFAULTS,
} from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import {
  buildPortableExport,
  LATEST_MIGRATION_SEQUENCE,
  openQualifiedDatabase,
  type PortableFiles,
  parsePortable,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import {
  TOOL_RESULT_DEVICE_ACTION_REASON_APPROVAL_NOT_CONNECTED,
  TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_LOST_RECORD,
  TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_POLICY,
  TOOL_RESULT_DEVICE_ACTION_REASON_NOT_DELIVERED,
  TOOL_RESULT_DEVICE_ACTION_REASON_PRESENCE_UNPROVEN,
  TOOL_RESULT_DEVICE_ACTION_REASON_REPORT_MISSING,
  TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN,
  TOOL_RESULT_DEVICE_ACTION_UNKNOWN,
  TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_CHANGE,
  TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_READ,
  TOOL_RESULT_DEVICE_ACTION_USAGE_CONTACT_SEARCH,
  TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER,
} from "@himawari-agent/prompt-catalog";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionDeviceActions } from "../../apps/agent-service/src/production-device-actions.ts";
import {
  PerceptionToolError,
  ProductionPerceptionTools,
  perceptionToolDescriptors,
} from "../../apps/agent-service/src/production-perception-tools.ts";
import { validateDeviceActionArguments } from "../../packages/application/src/services/device-action-registry.ts";
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
import {
  addRun,
  connectDevice,
  deviceGet,
  devicePost,
  perceptionScope,
} from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

const EVENT_START = Date.parse("2026-11-13T06:00:00.000Z");

function ownerAllows(ownerPresent: boolean): DeviceActionAuthorizationPort {
  return { authorize: async () => ({ decision: "allow", ownerPresent }) };
}

function ownerIsAsked(seen: DeviceActionIntent[] = []): DeviceActionAuthorizationPort {
  return {
    authorize: async (intent) => {
      seen.push(intent);
      return { decision: "approval", approvalId: `approval-${seen.length}` };
    },
  };
}

function setup(h: Harness) {
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
  let calls = 0;
  const act = async (runId: string, args: Record<string, unknown>, toolCallId?: string) =>
    (
      (await tools.run(
        {
          runId: createRunId(runId),
          toolCallId: toolCallId ?? `call:${++calls}`,
          capabilityRef: "device.action",
          capabilityHandleRef: null,
          arguments: args as never,
          dataClassification: "private",
        },
        {
          authorize: async () => undefined,
          markExternalContent: () => h.externalContent.mark(createRunId(runId), "perception_read"),
        },
      )) as { value: Record<string, unknown> }
    ).value;
  return { tools, act };
}

function rows(h: Harness) {
  return h.repository.deviceActions().list({
    ...perceptionScope,
    deviceId: null,
    states: DEVICE_ACTION_RECORD_STATES,
    limit: 100,
  });
}

async function ledger(h: Harness) {
  const entries = await h.repository.decisionLedger().list({
    ...perceptionScope,
    kind: "device_action",
    since: "1970-01-01T00:00:00.000Z",
    limit: 100,
  });
  return entries.map(({ outcome, reasonCode, subjectRef }) => ({
    outcome,
    reasonCode,
    subjectRef,
  }));
}

async function until(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

async function supports(h: Harness, client: PairedClient, actions: readonly string[]) {
  const result = await devicePost(h, client, "actions/supported", { actions });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body["actions"] as string[];
}

let syncs = 0;
async function mirror(
  h: Harness,
  client: PairedClient,
  kind: string,
  items: readonly { externalId: string; data: Record<string, unknown> }[],
) {
  const result = await devicePost(h, client, "mirror", {
    kind,
    mode: "delta",
    syncId: `sync-${String(++syncs).padStart(16, "0")}`,
    final: true,
    items: items.map((item) => ({ ...item, version: 1 })),
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function confirmablePost(
  h: Harness,
  client: PairedClient,
  path: string,
  body: Record<string, unknown>,
  confirmed: boolean,
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
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

async function changePolicy(
  h: Harness,
  client: PairedClient,
  body: Record<string, unknown>,
  confirmed: boolean,
) {
  return confirmablePost(h, client, "actions/policy", body, confirmed);
}

function noWaiting(h: Harness) {
  h.perceptionConfiguration.current = {
    ...PERCEPTION_CONFIGURATION_DEFAULTS,
    actionWaitSeconds: 0,
  };
}

const LAMP = {
  externalId: "lamp-1",
  data: { name: "落地灯", category: "light", room: "客厅" },
};
const LOCK = {
  externalId: "lock-1",
  data: { name: "大门锁", category: "lock", room: "玄关" },
};
const ODD = {
  externalId: "odd-1",
  data: { name: "新设备", category: "mystery_box" },
};
const DENTIST = {
  externalId: "evt-1",
  data: {
    title: "牙医复诊",
    startsAtMs: EVENT_START,
    endsAtMs: EVENT_START + 3_600_000,
    allDay: false,
  },
};

describe("[iOS-9A] device_action describe is computed from the registry, the devices and their policy", () => {
  it("lists per device only registered actions the device reported and the owner left on, sorted by name", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const before = (await act("run-1", { action: "describe" })) as {
      devices: { actions: string[] }[];
      actions: unknown[];
    };
    expect(before.devices.map(({ actions }) => actions)).toEqual([[]]);
    expect(before.actions).toEqual([]);
    expect(
      await supports(h, client, [
        "device_reminder.create",
        "lights.explode",
        "home.read",
        "alarm.set",
      ]),
    ).toEqual(["alarm.set", "device_reminder.create", "home.read"]);
    const described = (await act("run-1", { action: "describe" })) as {
      devices: { device: string; actions: string[] }[];
      actions: {
        name: string;
        confirm: boolean;
        parameters: Record<string, unknown>;
      }[];
    };
    expect(described.devices).toMatchObject([
      {
        device: client.deviceId,
        actions: ["alarm.set", "device_reminder.create", "home.read"],
      },
    ]);
    expect(described.actions.map(({ name, confirm }) => [name, confirm])).toEqual([
      ["alarm.set", true],
      ["device_reminder.create", true],
      ["home.read", false],
    ]);
    expect(described.actions.map((entry) => "usage" in entry)).toEqual([false, true, true]);
    expect(described.actions[1]).toMatchObject({
      usage: TOOL_RESULT_DEVICE_ACTION_USAGE_DEVICE_REMINDER.text,
    });
    expect(described.actions[2]?.parameters).toEqual({
      accessoryId: { type: "string", required: false, maxLength: 256 },
      room: { type: "string", required: false, maxLength: 120 },
    });
    const changed = await changePolicy(
      h,
      client,
      { expectedRevision: 0, blockedActions: ["device_reminder.create"] },
      true,
    );
    expect(changed.status).toBe(200);
    const after = (await act("run-1", { action: "describe" })) as {
      devices: { actions: string[] }[];
      actions: { name: string }[];
    };
    expect(after.devices[0]?.actions).toEqual(["alarm.set", "home.read"]);
    expect(after.actions.map(({ name }) => name)).toEqual(["alarm.set", "home.read"]);
    await h.repository.close();
  });

  it("[reverse] an action name outside the registry is refused and leaves no record", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["home.read", "calendar.delete"]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const refused = await act("run-1", {
      action: "lights.explode",
      arguments: {},
    });
    expect(refused).toMatchObject({
      done: false,
      note: TOOL_RESULT_DEVICE_ACTION_UNKNOWN.text,
    });
    const device = (await h.repository.pairedDevices().listDevices(perceptionScope))[0];
    if (!device) throw new Error("device missing");
    expect(
      await h.actions.service.request({
        runId: "run-1",
        toolCallId: "direct",
        dataClassification: "private",
        device,
        action: "lights.explode",
        arguments: {},
      }),
    ).toEqual({ kind: "invalid", note: null });
    await expect(
      act("run-1", {
        action: "home.read",
        arguments: { room: "客厅", everything: true },
      }),
    ).rejects.toBeInstanceOf(PerceptionToolError);
    const guessed = act("run-1", {
      action: "calendar.delete",
      arguments: { eventId: "guess" },
    });
    await expect(guessed).rejects.toMatchObject({
      code: "DEVICE_ACTION_INPUT_INVALID",
      note: TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN.text,
    });
    expect(await rows(h)).toEqual([]);
    await h.repository.close();
  });

  it("a newly registered action runs end to end without any change to the pipeline, and the tool definitions keep their bytes", async () => {
    const plain = JSON.stringify(perceptionToolDescriptors());
    const h = await harness({
      actionRegistry: new DeviceActionRegistry([
        ...DEVICE_ACTION_REGISTRATIONS,
        {
          name: "test.echo",
          schemaVersion: 1,
          deviceKinds: ["iphone"],
          parameters: {
            word: { type: "string", required: true, maxLength: 20 },
          },
          target: null,
          actionKind: "READ",
          escalation: null,
          ownerPresence: () => false,
          recipients: null,
          resultOrigin: "owner",
          readBack: "none",
          snapshotBefore: false,
          reversible: true,
          title: { "zh-CN": "回声", en: "Echo", ja: "エコー" },
          confirmLabel: { "zh-CN": "回声", en: "Echo", ja: "エコー" },
          declineLabel: { "zh-CN": "不用", en: "No", ja: "いいえ" },
          detail: (args) => ({
            "zh-CN": `回声：${args["word"]}`,
            en: `Echo: ${args["word"]}`,
            ja: `エコー：${args["word"]}`,
          }),
        },
      ]),
    });
    const client = await pairAndConfirm(h);
    expect(await supports(h, client, ["test.echo"])).toEqual(["test.echo"]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const described = (await act("run-1", { action: "describe" })) as {
      actions: { name: string }[];
    };
    expect(described.actions.map(({ name }) => name)).toEqual(["test.echo"]);
    const device = await connectDevice(h, client, (delivery) => ({
      outcome: "succeeded",
      readBack: false,
      evidence: { heard: (delivery["arguments"] as { word: string }).word },
    }));
    const result = await act("run-1", {
      action: "test.echo",
      arguments: { word: "你好" },
    });
    expect(result).toMatchObject({
      done: true,
      state: "succeeded",
      evidence: { heard: "你好" },
    });
    expect(device.claimed[0]).toMatchObject({
      action: "test.echo",
      detail: { en: "Echo: 你好" },
    });
    expect(JSON.stringify(perceptionToolDescriptors())).toBe(plain);
    await device.close();
    await h.repository.close();
  });
});

describe("[iOS-9A] an action goes from the model to the device and its result comes back", () => {
  it("delivers a read action over the open stream, records every step and reports the device's evidence", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["home.read"]);
    await mirror(h, client, "home_accessory", [LAMP]);
    const device = await connectDevice(h, client, () => ({
      outcome: "succeeded",
      readBack: false,
      evidence: { on: true, level: 40 },
    }));
    const signalsBefore = device.frames.filter((frame) => frame.includes("device.actions")).length;
    const { act } = setup(h);
    await addRun(h, "run-1");
    const result = await act("run-1", {
      action: "home.read",
      arguments: { accessoryId: "lamp-1" },
    });
    expect(result).toMatchObject({
      done: true,
      state: "succeeded",
      device: client.deviceId,
      evidence: { on: true, level: 40 },
    });
    expect(device.frames.filter((frame) => frame.includes("device.actions")).length).toBe(
      signalsBefore + 1,
    );
    expect(device.claimed).toHaveLength(1);
    expect(device.claimed[0]).toMatchObject({
      mode: "perform",
      action: "home.read",
      schemaVersion: 1,
      arguments: { accessoryId: "lamp-1" },
      ownerPresence: false,
      readBack: "none",
      risk: "LOW",
      confirmLabel: { "zh-CN": "读取", en: "Read", ja: "読み取る" },
      detail: {
        "zh-CN": "读取家居状态：落地灯",
        en: "Read home state: 落地灯",
        ja: "家の状態を読む：落地灯",
      },
    });
    expect(device.reports).toEqual([
      { status: 200, body: { state: "succeeded", replayed: false } },
    ]);
    const [record] = await rows(h);
    expect(record).toMatchObject({
      state: "succeeded",
      actionKind: "READ",
      risk: "LOW",
      reasonCode: null,
      runId: "run-1",
    });
    expect((await ledger(h)).map(({ outcome }) => outcome).sort()).toEqual([
      "delivered",
      "queued",
      "succeeded",
    ]);
    expect((await deviceGet(h, client, "actions")).body).toEqual({
      actions: [],
    });
    const replay = await devicePost(h, client, "actions/result", {
      id: record?.id,
      outcome: "failed",
      readBack: false,
      reason: "second thoughts",
    });
    expect(replay.body).toEqual({ state: "succeeded", replayed: true });
    await device.close();
    await h.repository.close();
  });

  it("[reverse] until approval is connected, every action that is not a low-risk read is refused with the reason and never reaches the device", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.create", "home.control", "device_reminder.create"]);
    await mirror(h, client, "home_accessory", [LAMP]);
    const device = await connectDevice(h, client, () => ({
      outcome: "succeeded",
      readBack: true,
    }));
    const { act } = setup(h);
    await addRun(h, "run-1");
    const attempts = [
      {
        action: "calendar.create",
        arguments: {
          title: "复诊",
          start: "2026-11-13T15:00",
          end: "2026-11-13T16:00",
        },
      },
      {
        action: "home.control",
        arguments: { accessoryId: "lamp-1", on: true },
      },
      { action: "device_reminder.create", arguments: { title: "买牛奶" } },
    ];
    for (const attempt of attempts) {
      const result = await act("run-1", attempt);
      expect(result).toMatchObject({
        done: false,
        state: "rejected",
        reason: TOOL_RESULT_DEVICE_ACTION_REASON_APPROVAL_NOT_CONNECTED.text,
      });
    }
    expect(TOOL_RESULT_DEVICE_ACTION_REASON_APPROVAL_NOT_CONNECTED.text).toContain("审批还没接上");
    expect((await rows(h)).map(({ state, reasonCode }) => [state, reasonCode])).toEqual(
      attempts.map(() => ["rejected", "approval_not_connected"]),
    );
    await device.close();
    expect(device.claimed).toEqual([]);
    expect(h.actions.openRequests).toEqual([]);
    await h.repository.close();
  });

  it("[reverse] a device cannot report another device's action, an undelivered action, or success without reading back", async () => {
    const h = await harness();
    const first = await pairAndConfirm(h);
    const second = await pairAndConfirm(h);
    await supports(h, first, ["device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const queued = await act("run-1", {
      action: "device_reminder.create",
      device: first.deviceId,
      arguments: { title: "买牛奶" },
    });
    expect(queued).toMatchObject({ done: false, state: "queued" });
    expect(h.actions.openRequests.map(({ deviceId }) => deviceId)).toEqual([first.deviceId]);
    const [record] = await rows(h);
    const report = (client: PairedClient, body: Record<string, unknown>) =>
      devicePost(h, client, "actions/result", { id: record?.id, ...body });
    expect((await report(first, { outcome: "failed", readBack: false })).body).toEqual({
      code: "DEVICE_ACTION_NOT_DELIVERED",
    });
    expect((await devicePost(h, second, "actions/claim", {})).body).toEqual({
      actions: [],
    });
    const claimed = await devicePost(h, first, "actions/claim", {});
    expect(claimed.body["actions"]).toMatchObject([{ id: record?.id, mode: "perform" }]);
    expect((await report(second, { outcome: "succeeded", readBack: true })).status).toBe(404);
    expect((await report(first, { outcome: "succeeded", readBack: false })).status).toBe(400);
    expect((await report(first, { outcome: "done", readBack: true })).status).toBe(400);
    const failed = await report(first, {
      outcome: "failed",
      readBack: false,
      reason: "提醒事项的权限被关了",
    });
    expect(failed.body).toEqual({ state: "failed", replayed: false });
    const again = await act(
      "run-1",
      {
        action: "device_reminder.create",
        device: first.deviceId,
        arguments: { title: "买牛奶" },
      },
      "call:1",
    );
    expect(again).toMatchObject({
      done: false,
      state: "failed",
      reason: "提醒事项的权限被关了",
    });
    await h.repository.close();
  });
});

describe("[iOS-9A] an action whose result is unknown is never done twice", () => {
  it("[reverse] asking again while the result is unknown adds no action and the device is only asked to read back", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const device = await connectDevice(h, client);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const request = {
      action: "device_reminder.create",
      arguments: { title: "买牛奶", list: "家" },
    };
    const first = await act("run-1", request);
    expect(first).toMatchObject({ done: false, state: "queued" });
    await until(() => device.claimed.length === 1);
    expect(device.claimed[0]).toMatchObject({ mode: "perform" });
    const duplicate = await act("run-1", request);
    expect(duplicate).toMatchObject({ done: false, state: "queued" });
    expect(await rows(h)).toHaveLength(1);
    h.clock.advance(601_000);
    const second = await act("run-1", request);
    expect(second).toMatchObject({
      done: false,
      state: "result_unknown",
      reason: TOOL_RESULT_DEVICE_ACTION_REASON_REPORT_MISSING.text,
    });
    const recorded = await rows(h);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      state: "result_unknown",
      reasonCode: "report_missing",
    });
    await until(() => device.claimed.length >= 2);
    expect(device.claimed[1]).toMatchObject({
      id: device.claimed[0]?.["id"],
      mode: "verify",
    });
    expect(device.claimed.filter(({ mode }) => mode === "perform")).toHaveLength(1);
    const id = recorded[0]?.id;
    const blind = await devicePost(h, client, "actions/result", {
      id,
      outcome: "failed",
      readBack: false,
      reason: "没看",
    });
    expect([blind.status, blind.body]).toEqual([409, { code: "DEVICE_ACTION_VERIFY_ONLY" }]);
    const verified = await devicePost(h, client, "actions/result", {
      id,
      outcome: "succeeded",
      readBack: true,
      evidence: { reminderId: "r-9" },
    });
    expect(verified.body).toEqual({ state: "succeeded", replayed: false });
    expect(await act("run-1", request, "call:1")).toMatchObject({
      done: true,
      state: "succeeded",
      evidence: { reminderId: "r-9" },
    });
    expect((await ledger(h)).map(({ outcome }) => outcome).sort()).toEqual([
      "delivered",
      "queued",
      "result_unknown",
      "succeeded",
    ]);
    await device.close();
    await h.repository.close();
  });

  it("a reinstalled device gets its delivered actions back for reading only, and an action that never arrived expires", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create", "alarm.set"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    await act("run-1", {
      action: "device_reminder.create",
      arguments: { title: "交房租" },
    });
    const claimed = await devicePost(h, client, "actions/claim", {});
    expect(claimed.body["actions"]).toHaveLength(1);
    h.clock.advance(1000);
    await act("run-1", {
      action: "alarm.set",
      arguments: { time: "2026-11-13T07:00" },
    });
    const reopened = await devicePost(h, client, "actions/open", {});
    expect(reopened.body["actions"]).toMatchObject([
      { action: "device_reminder.create", mode: "verify" },
    ]);
    const open = (await deviceGet(h, client, "actions")).body["actions"] as Record<
      string,
      unknown
    >[];
    expect(
      open.map(({ state, reasonCode, reason, detail, risk, ownerPresence }) => ({
        state,
        reasonCode,
        reason,
        detail: (detail as Record<string, string>)["zh-CN"],
        risk,
        ownerPresence,
      })),
    ).toEqual([
      {
        state: "result_unknown",
        reasonCode: "device_lost_record",
        reason: TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_LOST_RECORD.text,
        detail: "在“提醒事项”里新建：交房租",
        risk: "MEDIUM",
        ownerPresence: false,
      },
      {
        state: "queued",
        reasonCode: null,
        reason: null,
        detail: "设闹钟：2026-11-13 07:00",
        risk: "MEDIUM",
        ownerPresence: false,
      },
    ]);
    h.clock.advance(601_000);
    expect((await devicePost(h, client, "actions/claim", {})).body["actions"]).toMatchObject([
      { action: "device_reminder.create", mode: "verify" },
    ]);
    const expired = (await rows(h)).find(({ action }) => action === "alarm.set");
    expect(expired).toMatchObject({
      state: "expired",
      reasonCode: "not_delivered_in_time",
      deliveredAt: null,
    });
    expect(
      await act(
        "run-1",
        { action: "alarm.set", arguments: { time: "2026-11-13T07:00" } },
        "call:2",
      ),
    ).toMatchObject({
      done: false,
      state: "expired",
      reason: TOOL_RESULT_DEVICE_ACTION_REASON_NOT_DELIVERED.text,
    });
    await h.repository.close();
  });
});

describe("[iOS-9A] review round 1: the same action is recognised however it is asked again", () => {
  it("[reverse] listing the same phone numbers in another order while the result is unknown does not send the action again", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["contact.update"]);
    await mirror(h, client, "contact", [{ externalId: "c-1", data: { name: "林一" } }]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const device = await connectDevice(h, client);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const update = (phones: string[]) =>
      act("run-1", {
        action: "contact.update",
        arguments: { contactId: "c-1", phones },
      });
    await update(["+81 90 1111 2222", "+81 3 3333 4444"]);
    await until(() => device.claimed.length === 1);
    h.clock.advance(601_000);
    expect(await update(["+81 3 3333 4444", "+81 90 1111 2222"])).toMatchObject({
      done: false,
      state: "result_unknown",
    });
    await until(() => device.claimed.length >= 2);
    expect(await rows(h)).toHaveLength(1);
    expect(device.claimed.filter(({ mode }) => mode === "perform")).toHaveLength(1);
    await device.close();
    await h.repository.close();
  });

  it("[reverse] fields the iPhone cannot write are not offered, and one occurrence of a repeating event is named as such", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, [
      "calendar.create",
      "calendar.update",
      "calendar.delete",
      "contact.update",
    ]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    h.actions.authorization.current = ownerAllows(true);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const described = (await act("run-1", { action: "describe" })) as {
      actions: { name: string; parameters: Record<string, unknown> }[];
    };
    const fields = Object.fromEntries(
      described.actions.map(({ name, parameters }) => [name, Object.keys(parameters)]),
    );
    expect(fields["calendar.create"]).not.toContain("attendees");
    expect(fields["calendar.update"]).not.toContain("attendees");
    expect(fields["contact.update"]).not.toContain("notes");
    expect(fields["calendar.delete"]).toContain("occurrenceStart");
    await expect(
      act("run-1", {
        action: "calendar.create",
        arguments: {
          title: "周会",
          start: "2026-11-13T15:00",
          end: "2026-11-13T16:00",
          attendees: ["lin@example.com"],
        },
      }),
    ).rejects.toMatchObject({ code: "DEVICE_ACTION_INPUT_INVALID" });
    expect(await rows(h)).toHaveLength(0);
    await act("run-1", {
      action: "calendar.delete",
      arguments: { eventId: "evt-1", occurrenceStart: "2026-11-20T15:00" },
    });
    const [single] = (await deviceGet(h, client, "actions")).body["actions"] as {
      detail: Record<string, string>;
    }[];
    expect(single?.detail).toEqual({
      "zh-CN": "删除日程“牙医复诊”：2026-11-20 15:00（只删这一次）",
      en: 'Delete event "牙医复诊": 2026-11-20 15:00 (this occurrence only)',
      ja: "予定「牙医复诊」を削除：2026-11-20 15:00（この回だけ）",
    });
    await h.repository.close();
  });

  it("replaying the same tool call returns the original record even after its target left the mirror", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.complete"]);
    await mirror(h, client, "reminder", [
      { externalId: "rem-1", data: { title: "交房租", completed: false } },
    ]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const request = {
      action: "device_reminder.complete",
      arguments: { reminderId: "rem-1" },
    };
    expect(await act("run-1", request, "call:fixed")).toMatchObject({
      state: "queued",
    });
    const removed = await devicePost(h, client, "mirror", {
      kind: "reminder",
      mode: "delta",
      syncId: "sync-remove-000000001",
      final: true,
      items: [{ externalId: "rem-1", version: 2, deleted: true }],
    });
    expect(removed.status).toBe(200);
    expect(await act("run-1", request, "call:fixed")).toMatchObject({
      state: "queued",
    });
    await expect(act("run-1", request, "call:other")).rejects.toMatchObject({
      note: TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN.text,
    });
    expect(await rows(h)).toHaveLength(1);
    await h.repository.close();
  });

  it("[reverse] an action that could not be recorded leaves no stored arguments behind", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    const device = (await h.repository.pairedDevices().listDevices(perceptionScope))[0];
    if (!device) throw new Error("device missing");
    await web(h, "revoke", {
      deviceId: client.deviceId,
      expectedRevision: device.revision,
    });
    await addRun(h, "run-1");
    await expect(
      h.actions.service.request({
        runId: "run-1",
        toolCallId: "stale-device",
        dataClassification: "private",
        device,
        action: "device_reminder.create",
        arguments: { title: "买牛奶" },
      }),
    ).rejects.toThrow();
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    try {
      expect(
        database.prepare("SELECT ref FROM payloads WHERE ref LIKE 'device-action:%'").all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
    expect(await rows(h)).toEqual([]);
    await h.repository.close();
  });
});

describe("[iOS-9A] review round 2: replays, failed reports and reopening stay bounded and honest", () => {
  it("replaying the same tool call while the result is unknown asks the device to read back again, and a different action under that call is refused", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create", "alarm.set"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const device = await connectDevice(h, client);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const request = {
      action: "device_reminder.create",
      arguments: { title: "买牛奶" },
    };
    await act("run-1", request, "call:fixed");
    await until(() => device.claimed.length === 1);
    h.clock.advance(601_000);
    expect(await act("run-1", request, "call:fixed")).toMatchObject({
      state: "result_unknown",
    });
    await until(() => device.claimed.length >= 2);
    expect(device.claimed[1]).toMatchObject({
      id: device.claimed[0]?.["id"],
      mode: "verify",
    });
    await expect(
      act("run-1", { action: "alarm.set", arguments: { time: "2026-11-13T07:00" } }, "call:fixed"),
    ).rejects.toMatchObject({ code: "DEVICE_ACTION_INPUT_INVALID" });
    expect(await rows(h)).toHaveLength(1);
    await device.close();
    await h.repository.close();
  });

  it("[reverse] a report that could not be recorded leaves no stored result behind", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    await act("run-1", {
      action: "device_reminder.create",
      arguments: { title: "买牛奶" },
    });
    expect((await devicePost(h, client, "actions/claim", {})).body["actions"]).toHaveLength(1);
    const [record] = await rows(h);
    const secondRoot = path.join(h.stateRoot, "full-disk-view");
    await mkdir(secondRoot);
    const full = await SqliteProductStateRepository.open({
      stateRoot: secondRoot,
      databasePath: path.join(h.stateRoot, "product.sqlite"),
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
      now: () => h.clock.now(),
    });
    const onFullDisk = createProductionDeviceActions({
      scope: perceptionScope,
      store: full.deviceActions(),
      perception: h.repository.perception(),
      devices: (scope) => h.repository.pairedDevices().listDevices(scope),
      ledger: h.repository.decisionLedger(),
      payloads: h.repository.payloadStore(ownerId, agentId),
      protector: h.protector,
      delivery: h.actions.hub,
      configuration: () => h.perceptionConfiguration.current,
      timeZone: "Asia/Tokyo",
      now: () => h.clock.now(),
    });
    await expect(
      onFullDisk.service.report(client.deviceId, {
        id: record?.id,
        outcome: "failed",
        readBack: false,
        reason: "提醒事项的权限被关了",
      }),
    ).rejects.toMatchObject({ details: { reason: "disk_headroom" } });
    await full.close();
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    try {
      expect(
        database
          .prepare("SELECT ref FROM payloads WHERE ref LIKE 'device-action:%:result:%'")
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
    expect((await rows(h))[0]).toMatchObject({
      state: "delivered",
      resultRef: null,
    });
    await h.repository.close();
  });

  it("[reverse] a reinstalled device gets back at most one batch of delivered actions per call", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    for (const title of ["买牛奶", "交房租", "取快递"]) {
      await act("run-1", {
        action: "device_reminder.create",
        arguments: { title },
      });
      h.clock.advance(1000);
    }
    expect((await devicePost(h, client, "actions/claim", {})).body["actions"]).toHaveLength(3);
    h.perceptionConfiguration.current = {
      ...PERCEPTION_CONFIGURATION_DEFAULTS,
      actionWaitSeconds: 0,
      actionClaimBatch: 2,
    };
    const first = await devicePost(h, client, "actions/open", {});
    expect((first.body["actions"] as { mode: string }[]).map(({ mode }) => mode)).toEqual([
      "verify",
      "verify",
    ]);
    expect((await rows(h)).map(({ state }) => state)).toEqual([
      "result_unknown",
      "result_unknown",
      "delivered",
    ]);
    expect((await ledger(h)).filter(({ outcome }) => outcome === "result_unknown")).toHaveLength(2);
    await h.repository.close();
  });
});

describe("[iOS-9A] review round 3: actions nobody can verify do not block the queue", () => {
  it("[reverse] new work and not-yet-checked actions are handed out before actions the device already said it cannot verify", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    h.perceptionConfiguration.current = {
      ...PERCEPTION_CONFIGURATION_DEFAULTS,
      actionWaitSeconds: 0,
      actionClaimBatch: 2,
    };
    const { act } = setup(h);
    await addRun(h, "run-1");
    const create = (title: string) =>
      act("run-1", { action: "device_reminder.create", arguments: { title } });
    const claim = async () =>
      (
        (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
          id: string;
          mode: string;
          detail: Record<string, string>;
        }[]
      ).map(({ id, mode, detail }) => ({ id, mode, title: detail["zh-CN"] }));
    for (const title of ["甲", "乙", "丙"]) {
      await create(title);
      h.clock.advance(1000);
    }
    expect((await claim()).map(({ title }) => title)).toEqual([
      "在“提醒事项”里新建：甲",
      "在“提醒事项”里新建：乙",
    ]);
    expect((await claim()).map(({ title }) => title)).toEqual(["在“提醒事项”里新建：丙"]);
    h.clock.advance(601_000);
    const firstCheck = await claim();
    expect(firstCheck.map(({ mode, title }) => [mode, title])).toEqual([
      ["verify", "在“提醒事项”里新建：甲"],
      ["verify", "在“提醒事项”里新建：乙"],
    ]);
    h.clock.advance(1000);
    for (const { id } of firstCheck)
      expect(
        (
          await devicePost(h, client, "actions/result", {
            id,
            outcome: "result_unknown",
            readBack: true,
          })
        ).body,
      ).toEqual({ state: "result_unknown", replayed: true });
    await create("丁");
    expect((await claim()).map(({ mode, title }) => [mode, title])).toEqual([
      ["perform", "在“提醒事项”里新建：丁"],
      ["verify", "在“提醒事项”里新建：丙"],
    ]);
    expect((await rows(h)).filter(({ state }) => state === "result_unknown")).toHaveLength(3);
    await h.repository.close();
  });
});

describe("[iOS-9A] actions that need the owner in person", () => {
  it("[undo] offers an undo only when the device reported what it changed, and queues the reverse action", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.update", "device_reminder.create"]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    h.actions.authorization.current = ownerAllows(true);
    const views = async () =>
      (
        (await deviceGet(h, client, "actions?finishedSince=1970-01-01T00:00:00.000Z")).body[
          "actions"
        ] as { id: string; action: string; undo: string }[]
      ).map(({ id, action, undo }) => ({ id, action, undo }));
    const finish = async (evidence: Record<string, unknown>) => {
      const claimed = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
        id: string;
      }[];
      const id = claimed[0]?.id;
      expect(
        (
          await devicePost(h, client, "actions/result", {
            id,
            outcome: "succeeded",
            readBack: true,
            evidence,
          })
        ).body,
      ).toEqual({ state: "succeeded", replayed: false });
      return id as string;
    };
    await act("run-1", {
      action: "calendar.update",
      arguments: { eventId: "evt-1", title: "新标题" },
    });
    const changed = await finish({ before: { title: "牙医复诊" } });
    h.clock.advance(1000);
    await act("run-1", {
      action: "device_reminder.create",
      arguments: { title: "买牛奶" },
    });
    const reminder = await finish({ reminderId: "r-1" });
    expect(await views()).toEqual(
      expect.arrayContaining([
        { id: changed, action: "calendar.update", undo: "available" },
        { id: reminder, action: "device_reminder.create", undo: "none" },
      ]),
    );
    expect((await devicePost(h, client, "actions/undo", { id: reminder })).status).toBe(409);
    expect(
      (
        await devicePost(h, client, "actions/undo", {
          id: "dact_" + "0".repeat(32),
        })
      ).status,
    ).toBe(404);
    const undone = await confirmablePost(h, client, "actions/undo", { id: changed }, true);
    expect(undone.body).toMatchObject({ state: "queued" });
    expect((await views()).find(({ id }) => id === changed)?.undo).toBe("pending");
    const claimed = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
      arguments: Record<string, unknown>;
    }[];
    expect(claimed).toMatchObject([
      { arguments: { eventId: "evt-1", title: "牙医复诊" }, mode: "perform" },
    ]);
    const reverse = (await rows(h)).find(({ state }) => state === "delivered");
    await devicePost(h, client, "actions/result", {
      id: reverse?.id,
      outcome: "succeeded",
      readBack: true,
      evidence: {},
    });
    expect((await views()).find(({ id }) => id === changed)?.undo).toBe("done");
    await h.repository.close();
  });

  it("[undo] never offers an undo when the device kept no before-image, and hands an undo to the owner's approval", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.update", "calendar.delete"]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    h.actions.authorization.current = ownerAllows(true);
    await act("run-1", {
      action: "calendar.update",
      arguments: { eventId: "evt-1", title: "新标题" },
    });
    const claimed = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
      id: string;
    }[];
    await devicePost(h, client, "actions/result", {
      id: claimed[0]?.id,
      outcome: "succeeded",
      readBack: true,
      evidence: {},
    });
    expect(await devicePost(h, client, "actions/undo", { id: claimed[0]?.id })).toMatchObject({
      status: 409,
    });
    const seen: DeviceActionIntent[] = [];
    h.clock.advance(1000);
    await addRun(h, "run-2");
    h.actions.authorization.current = ownerAllows(true);
    await act("run-2", {
      action: "calendar.update",
      arguments: { eventId: "evt-1", title: "再改" },
    });
    const second = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
      id: string;
    }[];
    await devicePost(h, client, "actions/result", {
      id: second[0]?.id,
      outcome: "succeeded",
      readBack: true,
      evidence: { before: { title: "新标题" } },
    });
    h.actions.authorization.current = ownerIsAsked(seen);
    h.clock.advance(1000);
    const undone = await confirmablePost(
      h,
      client,
      "actions/undo",
      { id: second[0]?.id as string },
      true,
    );
    expect(undone.body).toMatchObject({ state: "waiting_owner" });
    expect(seen).toMatchObject([
      {
        action: "calendar.update",
        arguments: { title: "新标题" },
      },
    ]);
    await h.repository.close();
  });

  it("[undo] only an undo confirmed with the confirmation key counts as the owner clicking it", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.update"]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    h.actions.authorization.current = ownerAllows(true);
    const targets: string[] = [];
    for (const title of ["新标题", "再改"]) {
      h.clock.advance(1000);
      await act(
        "run-1",
        {
          action: "calendar.update",
          arguments: { eventId: "evt-1", title },
        },
        `call:${targets.length}`,
      );
      const claimed = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
        id: string;
      }[];
      await devicePost(h, client, "actions/result", {
        id: claimed[0]?.id,
        outcome: "succeeded",
        readBack: true,
        evidence: { before: { title: "牙医复诊" } },
      });
      targets.push(claimed[0]?.id as string);
    }
    await h.externalContent.mark(createRunId("run-1"), "perception_read");
    const seen: DeviceActionIntent[] = [];
    h.actions.authorization.current = ownerIsAsked(seen);
    await confirmablePost(h, client, "actions/undo", { id: targets[0] as string }, false);
    await confirmablePost(h, client, "actions/undo", { id: targets[1] as string }, true);
    expect(seen.map(({ toolCallId }) => toolCallId.endsWith(":owner"))).toEqual([false, true]);
    await h.repository.close();
  });

  it("[undo] an unconfirmed undo that was refused does not block the same action's confirmed undo", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.update"]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    h.actions.authorization.current = ownerAllows(true);
    await act("run-1", {
      action: "calendar.update",
      arguments: { eventId: "evt-1", title: "新标题" },
    });
    const claimed = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
      id: string;
    }[];
    const id = claimed[0]?.id as string;
    await devicePost(h, client, "actions/result", {
      id,
      outcome: "succeeded",
      readBack: true,
      evidence: { before: { title: "牙医复诊" } },
    });
    await h.externalContent.mark(createRunId("run-1"), "perception_read");
    h.actions.authorization.current = {
      authorize: async (intent) =>
        !intent.toolCallId.endsWith(":owner")
          ? { decision: "deny", reasonCode: "authorization_denied" }
          : { decision: "approval", approvalId: "approval-owner" },
    };
    await confirmablePost(h, client, "actions/undo", { id }, false);
    const confirmed = await confirmablePost(h, client, "actions/undo", { id }, true);
    expect(confirmed.body).not.toMatchObject({ state: "rejected" });
    expect(confirmed.status).toBe(200);
    await h.repository.close();
  });

  it("[undo] a failed reverse action is not retried, a second device cannot undo, and an action that did not succeed cannot be undone", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const other = await pairAndConfirm(h);
    await supports(h, client, ["calendar.update"]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    h.actions.authorization.current = ownerAllows(true);
    await act("run-1", {
      action: "calendar.update",
      arguments: { eventId: "evt-1", title: "新" },
    });
    const claimed = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
      id: string;
    }[];
    const id = claimed[0]?.id as string;
    expect((await devicePost(h, client, "actions/undo", { id })).status).toBe(409);
    await devicePost(h, client, "actions/result", {
      id,
      outcome: "succeeded",
      readBack: true,
      evidence: { before: { title: "牙医复诊" } },
    });
    expect((await devicePost(h, other, "actions/undo", { id })).status).toBe(404);
    expect((await devicePost(h, client, "actions/undo", { id })).body).toMatchObject({
      state: "queued",
    });
    const reverse = (await devicePost(h, client, "actions/claim", {})).body["actions"] as {
      id: string;
    }[];
    await devicePost(h, client, "actions/result", {
      id: reverse[0]?.id,
      outcome: "failed",
      readBack: false,
    });
    const before = (await rows(h)).length;
    const again = await devicePost(h, client, "actions/undo", { id });
    expect(again.body).toEqual({ id: reverse[0]?.id, state: "failed" });
    expect((await rows(h)).length).toBe(before);
    expect((await devicePost(h, client, "actions/claim", {})).body["actions"]).toEqual([]);
    await h.repository.close();
  });

  it("[undo] derives the reverse action only from what the device reported", () => {
    const plan = (
      action: string,
      args: Record<string, unknown>,
      evidence: Record<string, unknown>,
    ) => DEVICE_ACTION_REGISTRY.get(action)?.undo?.(args, evidence) ?? null;
    expect(plan("calendar.create", { title: "x" }, { eventId: "evt-9" })).toEqual({
      action: "calendar.delete",
      arguments: { eventId: "evt-9" },
    });
    expect(plan("calendar.create", { title: "x" }, {})).toBeNull();
    const before = {
      title: "牙医复诊",
      start: "2026-11-13T15:00",
      end: "2026-11-13T16:00",
      allDay: false,
    };
    expect(plan("calendar.delete", { eventId: "evt-1" }, { before })).toEqual({
      action: "calendar.create",
      arguments: before,
    });
    const create = DEVICE_ACTION_REGISTRY.get("calendar.create");
    expect(create && validateDeviceActionArguments(create.parameters, before)).toBeDefined();
    expect(
      create && validateDeviceActionArguments(create.parameters, { ...before, location: "" }),
    ).toBeUndefined();
    expect(
      plan(
        "calendar.delete",
        { eventId: "evt-1", occurrenceStart: "2026-11-13T15:00" },
        { before },
      ),
    ).toBeNull();
    expect(plan("calendar.delete", { eventId: "evt-1" }, {})).toBeNull();
    expect(
      plan(
        "calendar.update",
        { eventId: "evt-1", title: "新", location: "东京" },
        { before: { title: "旧" } },
      ),
    ).toBeNull();
    expect(
      plan(
        "calendar.update",
        { eventId: "evt-1", occurrenceStart: "2026-11-13T15:00", title: "新" },
        { before: { title: "旧", notes: "无关" } },
      ),
    ).toEqual({
      action: "calendar.update",
      arguments: {
        eventId: "evt-1",
        occurrenceStart: "2026-11-13T15:00",
        title: "旧",
      },
    });
    expect(
      plan(
        "contact.update",
        { contactId: "c-1", organization: "新公司" },
        { before: { organization: "旧公司" } },
      ),
    ).toEqual({
      action: "contact.update",
      arguments: { contactId: "c-1", organization: "旧公司" },
    });
    expect(plan("alarm.set", { time: "2026-11-13T07:00" }, { alarmId: "a-1" })).toBeNull();
    expect(plan("home.control", { accessoryId: "lamp-1" }, { before: { on: false } })).toBeNull();
  });

  it("[approval] moves a waiting action on once the unified approval is answered, and rejects it when the owner says no", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.delete"]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    await addRun(h, "run-2");
    const answers = new Map<string, DeviceActionResolution>();
    h.actions.authorization.current = {
      authorize: async (intent) => ({
        decision: "approval",
        approvalId: `approval:${intent.runId}`,
      }),
      resolve: async (approvalId) => answers.get(approvalId) ?? { decision: "pending" },
    };
    const request = {
      action: "calendar.delete",
      arguments: { eventId: "evt-1" },
    };
    expect(await act("run-1", request)).toMatchObject({
      state: "waiting_owner",
    });
    await h.actions.service.reconcile();
    expect((await rows(h)).map(({ state }) => state)).toEqual(["waiting_owner"]);
    answers.set("approval:run-1", {
      decision: "deny",
      reasonCode: "owner_denied",
    });
    await h.actions.service.reconcile();
    expect((await rows(h)).map(({ state }) => state)).toEqual(["rejected"]);
    h.clock.advance(1000);
    expect(await act("run-2", request)).toMatchObject({
      state: "waiting_owner",
    });
    answers.set("approval:run-2", { decision: "allow", ownerPresent: true });
    await h.actions.service.reconcile();
    expect((await rows(h)).map(({ state }) => state).sort()).toEqual(["queued", "rejected"]);
    await h.repository.close();
  });

  it("[approval] reconciles the answered approval even when more than a batch of earlier actions still wait", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.delete"]);
    const total = 101;
    await mirror(
      h,
      client,
      "calendar_event",
      Array.from({ length: total }, (_, index) => ({
        ...DENTIST,
        externalId: `evt-${index}`,
      })),
    );
    const { act } = setup(h);
    const answers = new Map<string, DeviceActionResolution>();
    h.actions.authorization.current = {
      authorize: async (intent) => ({
        decision: "approval",
        approvalId: `approval:${intent.runId}`,
      }),
      resolve: async (approvalId) => answers.get(approvalId) ?? { decision: "pending" },
    };
    for (let index = 0; index < total; index += 1) {
      await addRun(h, `run-${index}`);
      h.clock.advance(10);
      await act(`run-${index}`, {
        action: "calendar.delete",
        arguments: { eventId: `evt-${index}` },
      });
    }
    answers.set(`approval:run-${total - 1}`, {
      decision: "allow",
      ownerPresent: true,
    });
    await h.actions.service.reconcile(`approval:run-${total - 1}`);
    const answered = await h.repository.deviceActions().list({
      ...perceptionScope,
      deviceId: null,
      states: DEVICE_ACTION_RECORD_STATES,
      limit: 1,
      approvalId: `approval:run-${total - 1}`,
    });
    expect(answered.map(({ state }) => state)).toEqual(["queued"]);
    const waiting = await h.repository.deviceActions().list({
      ...perceptionScope,
      deviceId: null,
      states: ["waiting_owner"],
      limit: 500,
    });
    expect(waiting).toHaveLength(total - 1);
    await h.repository.close();
  });

  it("[reverse] is not carried out while the device is offline or the owner's presence is unproven", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.delete"]);
    await mirror(h, client, "calendar_event", [DENTIST]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const request = {
      action: "calendar.delete",
      arguments: { eventId: "evt-1" },
    };
    h.actions.authorization.current = ownerAllows(false);
    expect(await act("run-1", request)).toMatchObject({
      done: false,
      state: "rejected",
      reason: TOOL_RESULT_DEVICE_ACTION_REASON_PRESENCE_UNPROVEN.text,
    });
    const seen: DeviceActionIntent[] = [];
    h.clock.advance(1000);
    h.actions.authorization.current = ownerIsAsked(seen);
    expect(await act("run-1", request)).toMatchObject({
      done: false,
      state: "waiting_owner",
    });
    expect(seen[0]).toMatchObject({
      action: "calendar.delete",
      actionKind: "DELETE",
      risk: "HIGH",
      ownerPresence: true,
      target: { type: "calendar_event", ref: "evt-1" },
    });
    const waiting = (await rows(h)).find(({ state }) => state === "waiting_owner");
    if (!waiting) throw new Error("waiting action missing");
    expect(waiting).toMatchObject({
      approvalId: "approval-1",
      ownerPresence: true,
    });
    expect(
      await h.actions.service.decide({
        actionId: waiting.id,
        approved: true,
        ownerPresent: false,
      }),
    ).toBe("rejected");
    h.clock.advance(1000);
    expect(await act("run-1", request)).toMatchObject({
      state: "waiting_owner",
    });
    const second = (await rows(h)).find(({ state }) => state === "waiting_owner");
    if (!second) throw new Error("second waiting action missing");
    expect(
      await h.actions.service.decide({
        actionId: second.id,
        approved: true,
        ownerPresent: true,
      }),
    ).toBe("queued");
    expect(h.actions.openRequests.map(({ id }) => id)).toEqual([second.id]);
    const cut = h.clock.now();
    const view = (await deviceGet(h, client, "actions")).body["actions"] as Record<
      string,
      unknown
    >[];
    expect(view).toMatchObject([
      {
        id: second.id,
        action: "calendar.delete",
        runId: "run-1",
        threadId: null,
        state: "queued",
        risk: "HIGH",
        ownerPresence: true,
        detail: { "zh-CN": "删除日程“牙医复诊”：2026-11-13 15:00–16:00" },
        confirmLabel: { "zh-CN": "删掉", en: "Delete", ja: "削除" },
        declineLabel: { "zh-CN": "不删", en: "Don't delete", ja: "削除しない" },
      },
    ]);
    h.clock.advance(121_000);
    expect((await devicePost(h, client, "actions/claim", {})).body).toEqual({
      actions: [],
    });
    expect(
      (await rows(h)).map(({ state, reasonCode, deliveredAt }) => [state, reasonCode, deliveredAt]),
    ).toEqual([
      ["rejected", "owner_presence_unproven", null],
      ["rejected", "owner_presence_unproven", null],
      ["expired", "not_delivered_in_time", null],
    ]);
    const since = async (value: string) =>
      (
        (await deviceGet(h, client, `actions?finishedSince=${encodeURIComponent(value)}`)).body[
          "actions"
        ] as { id: string; state: string }[]
      ).map(({ id, state }) => [id, state]);
    expect(await since(cut)).toEqual([[second.id, "expired"]]);
    expect((await since("1970-01-01T00:00:00.000Z")).map(([, state]) => state)).toEqual([
      "rejected",
      "rejected",
      "expired",
    ]);
    expect((await deviceGet(h, client, "actions")).body).toEqual({
      actions: [],
    });
    for (const bad of [
      "actions?finishedSince=yesterday",
      "actions?finishedSince=2026-13-45T99:99:99.999Z",
      "actions?all=1",
    ])
      expect((await deviceGet(h, client, bad)).status).toBe(400);
    await h.repository.close();
  });

  it("treats locks and accessories of an unknown kind as physical safety, and ordinary lights as routine", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["home.control"]);
    await mirror(h, client, "home_accessory", [LAMP, LOCK, ODD]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const control = (accessoryId: string, change: Record<string, unknown>) =>
      act("run-1", {
        action: "home.control",
        arguments: { accessoryId, ...change },
      });
    expect(await control("lamp-1", { on: true })).toMatchObject({
      state: "queued",
    });
    h.clock.advance(1000);
    expect(await control("lock-1", { locked: false })).toMatchObject({
      state: "rejected",
    });
    h.clock.advance(1000);
    expect(await control("odd-1", { on: true })).toMatchObject({
      state: "rejected",
    });
    expect(
      (await rows(h)).map(({ actionKind, risk, ownerPresence, state }) => ({
        actionKind,
        risk,
        ownerPresence,
        state,
      })),
    ).toEqual([
      {
        actionKind: "CREATE_OR_UPDATE",
        risk: "MEDIUM",
        ownerPresence: false,
        state: "queued",
      },
      {
        actionKind: "PHYSICAL_SAFETY",
        risk: "CRITICAL",
        ownerPresence: true,
        state: "rejected",
      },
      {
        actionKind: "PHYSICAL_SAFETY",
        risk: "CRITICAL",
        ownerPresence: true,
        state: "rejected",
      },
    ]);
    await h.repository.close();
  });
});

describe("[iOS-9A] every action carries the words for its confirm button", () => {
  it("[reverse] a registration without a confirm label in every language is refused", () => {
    const [base] = DEVICE_ACTION_REGISTRATIONS;
    if (!base) throw new Error("registry is empty");
    for (const confirmLabel of [
      undefined,
      { "zh-CN": "删掉", en: "Delete", ja: " " },
      { "zh-CN": "删掉", en: "Delete" },
    ])
      expect(() => new DeviceActionRegistry([{ ...base, confirmLabel } as typeof base])).toThrow(
        "DEVICE_ACTION_REGISTRATION_INVALID",
      );
    for (const declineLabel of [undefined, { "zh-CN": "不删", en: "Don't delete" }])
      expect(() => new DeviceActionRegistry([{ ...base, declineLabel } as typeof base])).toThrow(
        "DEVICE_ACTION_REGISTRATION_INVALID",
      );
    for (const registration of DEVICE_ACTION_REGISTRATIONS)
      for (const words of [registration.confirmLabel, registration.declineLabel])
        expect(Object.keys(words).sort()).toEqual(["en", "ja", "zh-CN"]);
    for (const title of [undefined, { "zh-CN": "删除日程", en: "", ja: "予定を削除" }])
      expect(() => new DeviceActionRegistry([{ ...base, title } as typeof base])).toThrow(
        "DEVICE_ACTION_REGISTRATION_INVALID",
      );
  });
});

describe("[iOS-9A] each device has its own policy and a revoked device gets nothing", () => {
  it("only the owner in person can change a device's policy, and the change is written to the decision ledger", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["home.read", "device_reminder.create"]);
    expect((await deviceGet(h, client, "actions/policy")).body).toEqual({
      revision: 0,
      actions: [
        {
          name: "device_reminder.create",
          title: {
            "zh-CN": "在“提醒事项”里新建",
            en: "Create in Reminders",
            ja: "「リマインダー」に作成",
          },
          allowed: true,
        },
        {
          name: "home.read",
          title: {
            "zh-CN": "读取家居状态",
            en: "Read home state",
            ja: "家の状態を読む",
          },
          allowed: true,
        },
      ],
    });
    const unsigned = await changePolicy(
      h,
      client,
      { expectedRevision: 0, blockedActions: ["home.read"] },
      false,
    );
    expect([unsigned.status, unsigned.body]).toEqual([
      403,
      { code: "DEVICE_OWNER_PRESENCE_REQUIRED" },
    ]);
    expect((await deviceGet(h, client, "actions/policy")).body["revision"]).toBe(0);
    expect(await ledger(h)).toEqual([]);
    const unknown = await changePolicy(
      h,
      client,
      { expectedRevision: 0, blockedActions: ["lights.explode"] },
      true,
    );
    expect(unknown.status).toBe(400);
    const written = await changePolicy(
      h,
      client,
      { expectedRevision: 0, blockedActions: ["home.read"] },
      true,
    );
    expect([written.status, written.body]).toEqual([
      200,
      {
        revision: 1,
        actions: [
          expect.objectContaining({
            name: "device_reminder.create",
            allowed: true,
          }),
          expect.objectContaining({ name: "home.read", allowed: false }),
        ],
      },
    ]);
    const stale = await changePolicy(h, client, { expectedRevision: 0, blockedActions: [] }, true);
    expect([stale.status, stale.body["code"], stale.body["revision"]]).toEqual([
      409,
      "DEVICE_POLICY_REVISION_CONFLICT",
      1,
    ]);
    expect(await ledger(h)).toEqual([
      {
        outcome: "policy_changed",
        reasonCode: "device_policy_owner_change",
        subjectRef: client.deviceId,
      },
    ]);
    const page = await h.app.inject({
      method: "POST",
      url: "/api/devices/v1/actions/policy",
      headers: await h.webHeaders(),
      payload: JSON.stringify({
        deviceId: client.deviceId,
        expectedRevision: 1,
        blockedActions: [],
      }),
    });
    expect(page.statusCode).toBe(404);
    await h.repository.close();
  });

  it("[reverse] the server refuses an action the device's policy turned off, including one already waiting in the queue", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["home.read", "device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    expect(
      await act("run-1", {
        action: "device_reminder.create",
        arguments: { title: "买牛奶" },
      }),
    ).toMatchObject({ state: "queued" });
    h.clock.advance(1000);
    await changePolicy(
      h,
      client,
      {
        expectedRevision: 0,
        blockedActions: ["home.read", "device_reminder.create"],
      },
      true,
    );
    const device = await connectDevice(h, client, () => ({
      outcome: "succeeded",
      readBack: true,
    }));
    expect(await act("run-1", { action: "lights.explode" })).toMatchObject({
      done: false,
      availableActions: [],
    });
    const refused = await act("run-1", {
      action: "home.read",
      arguments: { room: "客厅" },
    });
    expect(refused).toMatchObject({
      done: false,
      state: "rejected",
      reason: TOOL_RESULT_DEVICE_ACTION_REASON_DEVICE_POLICY.text,
    });
    await device.close();
    expect(device.claimed).toEqual([]);
    expect(
      (await rows(h)).map(({ action, state, reasonCode }) => [action, state, reasonCode]),
    ).toEqual([
      ["device_reminder.create", "rejected", "device_policy"],
      ["home.read", "rejected", "device_policy"],
    ]);
    expect((await ledger(h)).map(({ outcome, reasonCode }) => [outcome, reasonCode])).toEqual(
      expect.arrayContaining([
        ["rejected", "device_action_device_policy"],
        ["policy_changed", "device_policy_owner_change"],
      ]),
    );
    await h.repository.close();
  });

  it("[reverse] a revoked device cannot fetch its queue and its waiting actions are cancelled", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create", "alarm.set"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    await act("run-1", {
      action: "device_reminder.create",
      arguments: { title: "买牛奶" },
    });
    expect((await devicePost(h, client, "actions/claim", {})).body["actions"]).toHaveLength(1);
    h.clock.advance(1000);
    await act("run-1", {
      action: "alarm.set",
      arguments: { time: "2026-11-13T07:00" },
    });
    const device = (await h.repository.pairedDevices().listDevices(perceptionScope))[0];
    if (!device) throw new Error("device missing");
    const revoked = await web(h, "revoke", {
      deviceId: client.deviceId,
      expectedRevision: device.revision,
    });
    expect(revoked.status).toBe(200);
    for (const route of ["actions/claim", "actions/open"])
      expect((await devicePost(h, client, route, {})).status).toBe(403);
    expect(await h.actions.service.claim(client.deviceId)).toEqual([]);
    expect(
      (await rows(h)).map(({ action, state, reasonCode }) => [action, state, reasonCode]),
    ).toEqual([
      ["device_reminder.create", "result_unknown", "device_revoked"],
      ["alarm.set", "rejected", "device_revoked"],
    ]);
    const after = await act("run-1", {
      action: "alarm.set",
      arguments: { time: "2026-11-13T08:00" },
    });
    expect(after).toMatchObject({ done: false });
    expect(await rows(h)).toHaveLength(2);
    await h.repository.close();
  });
});

describe("[iOS-9A] device actions and policies are part of the owner's data export", () => {
  function lines(files: PortableFiles, file: string): Record<string, unknown>[] {
    const text = new TextDecoder().decode(files.get(file));
    return text === ""
      ? []
      : text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async function exported(h: Harness) {
    const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
    try {
      return await buildPortableExport({
        database,
        scope: perceptionScope,
        migrationSequence: LATEST_MIGRATION_SEQUENCE,
        protector: h.protector,
        policy: createDataExportTextPolicy(),
        now: () => h.clock.now(),
        sealPassphrase: "测试口令-correct horse battery staple",
        withEvidence: false,
      });
    } finally {
      database.close();
    }
  }

  it("exports what was asked, what happened and the per-device policy, and exports empty files when there is none", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const empty = await exported(h);
    expect(lines(empty.files, "data/device-actions.jsonl")).toEqual([]);
    expect(lines(empty.files, "data/device-policies.jsonl")).toEqual([]);
    await supports(h, client, ["device_reminder.create", "home.read"]);
    h.actions.authorization.current = ownerAllows(false);
    const device = await connectDevice(h, client, () => ({
      outcome: "succeeded",
      readBack: true,
      evidence: { reminderId: "r-1" },
    }));
    const { act } = setup(h);
    await addRun(h, "run-1");
    await act("run-1", {
      action: "device_reminder.create",
      arguments: { title: "买牛奶" },
    });
    await device.close();
    await changePolicy(h, client, { expectedRevision: 0, blockedActions: ["home.read"] }, true);
    const { files, manifest } = await exported(h);
    const [record] = await rows(h);
    const [action] = lines(files, "data/device-actions.jsonl");
    expect(action).toMatchObject({
      id: record?.id,
      deviceId: client.deviceId,
      action: "device_reminder.create",
      schemaVersion: 1,
      actionKind: "CREATE_OR_UPDATE",
      risk: "MEDIUM",
      ownerPresence: false,
      approvalId: null,
      classification: "private",
      state: "succeeded",
      reasonCode: null,
      createdAt: record?.createdAt,
      deliveredAt: record?.deliveredAt,
      finishedAt: record?.finishedAt,
    });
    expect(JSON.stringify(action?.["request"])).toContain("买牛奶");
    expect(JSON.stringify(action?.["result"])).toContain("r-1");
    expect(lines(files, "data/device-policies.jsonl")).toEqual([
      {
        deviceId: client.deviceId,
        blockedActions: ["home.read"],
        updatedAt: h.clock.now(),
      },
    ]);
    expect(manifest.counts).toMatchObject({
      deviceActions: 1,
      devicePolicies: 1,
    });
    const parsed = parsePortable(files, LATEST_MIGRATION_SEQUENCE);
    expect(parsed.perception.deviceActions).toHaveLength(1);
    expect(parsed.perception.devicePolicies).toHaveLength(1);
    await h.repository.close();
  });

  it("deleting a run removes its device actions and their stored content, not another run's", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["device_reminder.create"]);
    h.actions.authorization.current = ownerAllows(false);
    noWaiting(h);
    const { act } = setup(h);
    await addRun(h, "run-1");
    await addRun(h, "run-2");
    await act("run-1", {
      action: "device_reminder.create",
      arguments: { title: "买牛奶" },
    });
    h.clock.advance(1000);
    await act("run-2", {
      action: "device_reminder.create",
      arguments: { title: "交房租" },
    });
    const before = await rows(h);
    expect(before.map(({ runId }) => runId).sort()).toEqual(["run-1", "run-2"]);
    const gone = before.find(({ runId }) => runId === "run-1");
    const kept = before.find(({ runId }) => runId === "run-2");
    await h.repository.close();
    const databasePath = path.join(h.stateRoot, "data", "product.sqlite");
    await mkdir(path.dirname(databasePath), { recursive: true });
    for (const name of await readdir(h.stateRoot))
      if (name.startsWith("product.sqlite"))
        await rename(path.join(h.stateRoot, name), path.join(h.stateRoot, "data", name));
    await new SqliteGovernedDeletionAdapter({
      stateRoot: h.stateRoot,
      databasePath,
      ownerId,
      agentId,
      now: () => h.clock.now(),
    }).deleteImmediately({ objectType: "run", objectId: "run-1" });
    const database = openQualifiedDatabase(databasePath);
    try {
      expect(database.prepare("SELECT run_id AS runId FROM device_actions").all()).toEqual([
        { runId: "run-2" },
      ]);
      const stored = (ref: string | undefined) =>
        database.prepare("SELECT COUNT(*) AS total FROM payloads WHERE ref = ?").get(ref);
      expect(stored(gone?.argumentsRef)).toEqual({ total: 0 });
      expect(stored(kept?.argumentsRef)).toEqual({ total: 1 });
    } finally {
      database.close();
    }
  });
});

describe("Himawari reads the owner's calendar and contacts on the device and acts on what it read", () => {
  const SHOW_EVENT = {
    eventId: "evt-show#2026-11-28T19:00",
    title: "看话剧",
    start: "2026-11-28T19:00",
    end: "2026-11-28T21:00",
    allDay: false,
    calendar: "家庭",
    startsAtMs: Date.parse("2026-11-28T10:00:00.000Z"),
    endsAtMs: Date.parse("2026-11-28T12:00:00.000Z"),
    attendeeCount: 0,
  };
  const KEN = {
    contactId: "contact-ken",
    name: "山田健",
    givenName: "健",
    familyName: "山田",
    organization: "",
    phones: ["090-1234-5678"],
    emails: [],
  };

  function answering() {
    return (delivery: Record<string, unknown>) => {
      if (delivery["action"] === "calendar.read")
        return {
          outcome: "succeeded",
          readBack: false,
          evidence: { done: { events: [SHOW_EVENT], truncated: false } },
        };
      if (delivery["action"] === "contact.search")
        return {
          outcome: "succeeded",
          readBack: false,
          evidence: { done: { contacts: [KEN], truncated: false } },
        };
      return {
        outcome: "succeeded",
        readBack: true,
        evidence: { before: { title: SHOW_EVENT.title } },
      };
    };
  }

  it("describes calendar.read and contact.search with their parameters and how to use the ids they return", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.read", "calendar.delete", "contact.search"]);
    const { act } = setup(h);
    await addRun(h, "run-1");
    const described = (await act("run-1", { action: "describe" })) as {
      devices: { actions: string[] }[];
      actions: {
        name: string;
        confirm: boolean;
        parameters: Record<string, unknown>;
        usage?: string;
      }[];
    };
    expect(described.devices[0]?.actions).toEqual([
      "calendar.delete",
      "calendar.read",
      "contact.search",
    ]);
    const byName = Object.fromEntries(described.actions.map((entry) => [entry.name, entry]));
    expect(byName["calendar.read"]).toMatchObject({
      confirm: false,
      usage: TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_READ.text,
    });
    expect(Object.keys(byName["calendar.read"]?.parameters ?? {})).toEqual(["from", "to"]);
    expect(byName["contact.search"]).toMatchObject({
      confirm: false,
      usage: TOOL_RESULT_DEVICE_ACTION_USAGE_CONTACT_SEARCH.text,
    });
    expect(byName["calendar.delete"]?.usage).toBe(
      TOOL_RESULT_DEVICE_ACTION_USAGE_CALENDAR_CHANGE.text,
    );
    await h.repository.close();
  });

  it("reads the day's events from the device without asking the owner, then deletes one by the id it read", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.read", "calendar.delete"]);
    const device = await connectDevice(h, client, answering());
    const { act } = setup(h);
    await addRun(h, "run-1");
    const read = await act("run-1", {
      action: "calendar.read",
      arguments: { from: "2026-11-28T00:00", to: "2026-11-28T23:59" },
    });
    expect(read).toMatchObject({
      done: true,
      state: "succeeded",
      evidence: { done: { events: [SHOW_EVENT], truncated: false } },
    });
    expect(device.claimed[0]).toMatchObject({
      action: "calendar.read",
      arguments: { from: "2026-11-28T00:00", to: "2026-11-28T23:59" },
      risk: "LOW",
      ownerPresence: false,
      resultMaximumBytes: DEVICE_ACTION_RESULT_MAXIMUM_BYTES,
      detail: { "zh-CN": "读取日程：2026-11-28 00:00–23:59" },
    });
    h.actions.authorization.current = ownerAllows(true);
    const deleted = await act("run-1", {
      action: "calendar.delete",
      arguments: { eventId: SHOW_EVENT.eventId },
    });
    expect(deleted).toMatchObject({ done: true, state: "succeeded" });
    expect(device.claimed[1]).toMatchObject({
      action: "calendar.delete",
      arguments: { eventId: SHOW_EVENT.eventId },
      detail: { "zh-CN": "删除日程“看话剧”：2026-11-28 19:00–21:00" },
    });
    await device.close();
    await h.repository.close();
  });

  it("[reverse] an event id that no read returned and no sync holds is still refused without a record", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["calendar.read", "calendar.delete"]);
    const device = await connectDevice(h, client, answering());
    const { act } = setup(h);
    await addRun(h, "run-1");
    await act("run-1", {
      action: "calendar.read",
      arguments: { from: "2026-11-28T00:00", to: "2026-11-28T23:59" },
    });
    h.actions.authorization.current = ownerAllows(true);
    await expect(
      act("run-1", { action: "calendar.delete", arguments: { eventId: "evt-guessed" } }),
    ).rejects.toMatchObject({
      code: "DEVICE_ACTION_INPUT_INVALID",
      note: TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN.text,
    });
    expect((await rows(h)).map(({ action }) => action)).toEqual(["calendar.read"]);
    await device.close();
    await h.repository.close();
  });

  it("[reverse] an id read from another device does not count for this one", async () => {
    const h = await harness();
    const phone = await pairAndConfirm(h);
    await supports(h, phone, ["calendar.read"]);
    const device = await connectDevice(h, phone, answering());
    const { act } = setup(h);
    await addRun(h, "run-1");
    await act("run-1", {
      action: "calendar.read",
      arguments: { from: "2026-11-28T00:00", to: "2026-11-28T23:59" },
    });
    const other = (await h.repository.pairedDevices().listDevices(perceptionScope)).find(
      ({ id }) => id === phone.deviceId,
    );
    if (!other) throw new Error("device missing");
    expect(
      await h.actions.service.request({
        runId: "run-1",
        toolCallId: "elsewhere",
        dataClassification: "private",
        device: { ...other, id: "device-elsewhere", supportedActions: ["calendar.delete"] },
        action: "calendar.delete",
        arguments: { eventId: SHOW_EVENT.eventId },
      }),
    ).toEqual({ kind: "invalid", note: TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN.text });
    await device.close();
    await h.repository.close();
  });

  it("finds one contact by name on the device and changes that contact by the id it found", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await supports(h, client, ["contact.search", "contact.update"]);
    const device = await connectDevice(h, client, answering());
    const { act } = setup(h);
    await addRun(h, "run-1");
    const found = await act("run-1", {
      action: "contact.search",
      arguments: { query: "山田" },
    });
    expect(found).toMatchObject({
      done: true,
      state: "succeeded",
      evidence: { done: { contacts: [KEN], truncated: false } },
    });
    h.actions.authorization.current = ownerAllows(false);
    await act("run-1", {
      action: "contact.update",
      arguments: { contactId: KEN.contactId, organization: "向日葵商事" },
    });
    expect(device.claimed[1]).toMatchObject({
      action: "contact.update",
      detail: { "zh-CN": "修改联系人“山田健”：公司：向日葵商事" },
    });
    await device.close();
    await h.repository.close();
  });

  it("[reverse] a registration whose ids are listed by an action that is not a read is refused", () => {
    const update = DEVICE_ACTION_REGISTRY.get("calendar.update");
    if (!update) throw new Error("calendar.update missing");
    expect(
      () =>
        new DeviceActionRegistry([
          ...DEVICE_ACTION_REGISTRATIONS.filter(({ name }) => name !== "calendar.update"),
          {
            ...update,
            target: {
              mirrorKind: "calendar_event",
              idKey: "eventId",
              listedBy: { action: "calendar.create", list: "events" },
            },
          },
        ]),
    ).toThrow("DEVICE_ACTION_REGISTRATION_INVALID calendar.update");
  });
});

function sampleArguments(registration: DeviceActionRegistration): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(registration.parameters)) {
    if (!field.required) continue;
    if (field.type === "string")
      args[name] =
        field.values?.[0] ??
        (field.format === "local_time"
          ? "2026-11-28T09:00"
          : field.format === "date"
            ? "2026-11-28"
            : "x");
    else if (field.type === "integer" || field.type === "number") args[name] = field.minimum;
    else if (field.type === "boolean") args[name] = true;
    else args[name] = ["x"];
  }
  return args;
}

describe("[I-129] every device read goes through to the device and back, and what it lists can be acted on", () => {
  const reads = DEVICE_ACTION_REGISTRATIONS.filter(({ actionKind }) => actionKind === "READ");
  const listed = DEVICE_ACTION_REGISTRATIONS.filter(({ target }) => target?.listedBy);

  it("the registry has reads to check", () => {
    expect(reads.length).toBeGreaterThan(0);
  });

  it.each(reads.map((read) => [read.name, read] as const))(
    "%s reaches the device without asking the owner and hands the model what the device read",
    async (_name, read) => {
      const h = await harness();
      const client = await pairAndConfirm(h);
      await supports(h, client, [read.name]);
      const item = { itemId: "item-1", name: "读到的那一项" };
      const device = await connectDevice(h, client, () => ({
        outcome: "succeeded",
        readBack: false,
        evidence: { done: { items: [item], truncated: false } },
      }));
      const { act } = setup(h);
      await addRun(h, "run-1");
      const result = await act("run-1", { action: read.name, arguments: sampleArguments(read) });
      expect(result).toMatchObject({
        done: true,
        state: "succeeded",
        evidence: { done: { items: [item], truncated: false } },
      });
      expect(device.claimed[0]).toMatchObject({ action: read.name, ownerPresence: false });
      await device.close();
      await h.repository.close();
    },
  );

  it.each(reads.map((read) => [read.name, read] as const))(
    "%s that the device could not do is written to the service log for developers",
    async (_name, read) => {
      const h = await harness();
      const client = await pairAndConfirm(h);
      await supports(h, client, [read.name]);
      const device = await connectDevice(h, client, () => ({
        outcome: "failed",
        readBack: false,
        reason: "读失败",
      }));
      const { act } = setup(h);
      await addRun(h, "run-1");
      await act("run-1", { action: read.name, arguments: sampleArguments(read) }).catch(
        () => undefined,
      );
      expect(h.actionReadFailures).toEqual([
        {
          event: "device_action.read_failed",
          action: read.name,
          deviceId: expect.any(String),
          outcome: "failed",
        },
      ]);
      await device.close();
      await h.repository.close();
    },
  );

  it("[reverse] a read that succeeded, or a change the device could not make, is not logged as a failed read", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const read = reads[0];
    if (!read) throw new Error("no read");
    await supports(h, client, [read.name, "calendar.create"]);
    const device = await connectDevice(h, client, (delivery) =>
      delivery["action"] === read.name
        ? { outcome: "succeeded", readBack: false, evidence: { done: { items: [] } } }
        : { outcome: "failed", readBack: false, reason: "没建成" },
    );
    const { act } = setup(h);
    await addRun(h, "run-1");
    await act("run-1", { action: read.name, arguments: sampleArguments(read) });
    h.actions.authorization.current = ownerAllows(true);
    await act("run-1", {
      action: "calendar.create",
      arguments: sampleArguments(
        DEVICE_ACTION_REGISTRY.get("calendar.create") as DeviceActionRegistration,
      ),
    }).catch(() => undefined);
    expect(h.actionReadFailures).toEqual([]);
    await device.close();
    await h.repository.close();
  });

  it.each(listed.map((registration) => [registration.name, registration] as const))(
    "%s accepts the id its read listed and refuses one it did not",
    async (_name, registration) => {
      const target = registration.target;
      const lister = target?.listedBy;
      if (!target || !lister) throw new Error("listedBy missing");
      const read = DEVICE_ACTION_REGISTRY.get(lister.action);
      if (!read) throw new Error(`${lister.action} missing`);
      const h = await harness();
      const client = await pairAndConfirm(h);
      await supports(h, client, [read.name, registration.name]);
      const item = { [target.idKey]: "listed-1", name: "读到的那一项", title: "读到的那一项" };
      const device = await connectDevice(h, client, (delivery) =>
        delivery["action"] === read.name
          ? {
              outcome: "succeeded",
              readBack: false,
              evidence: { done: { [lister.list]: [item], truncated: false } },
            }
          : { outcome: "succeeded", readBack: true, evidence: { before: item } },
      );
      const { act } = setup(h);
      await addRun(h, "run-1");
      await act("run-1", { action: read.name, arguments: sampleArguments(read) });
      h.actions.authorization.current = ownerAllows(true);
      await expect(
        act("run-1", {
          action: registration.name,
          arguments: { ...sampleArguments(registration), [target.idKey]: "never-listed" },
        }),
      ).rejects.toMatchObject({ note: TOOL_RESULT_DEVICE_ACTION_REASON_TARGET_UNKNOWN.text });
      const acted = await act("run-1", {
        action: registration.name,
        arguments: { ...sampleArguments(registration), [target.idKey]: "listed-1" },
      });
      expect(acted).toMatchObject({ done: true });
      expect(device.claimed.at(-1)).toMatchObject({
        action: registration.name,
        arguments: { [target.idKey]: "listed-1" },
      });
      await device.close();
      await h.repository.close();
    },
  );
});
