import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { afterEach, expect, it } from "vitest";
import { runAdminCli, runOutagePush } from "../../apps/admin-cli/src/index.ts";
import { type ApnsStub, startApnsStub } from "../fixtures/apns-stub.ts";

const TOPIC = "win.siyi.himawari.app";
const START = "2026-11-27T01:00:00.000Z";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function sink() {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        text += String(chunk);
        done();
      },
    }),
    text: () => text,
  };
}

async function deployment(options: { readonly applePush: boolean }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-outage-push-")));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const source = JSON.parse(
    await readFile(new URL("./fixtures/file-summary/configuration.json", import.meta.url), "utf8"),
  );
  const stateRoot = path.join(root, "state");
  const config = {
    ...source,
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    memory: { ...source.memory, storagePath: path.join(stateRoot, "data", "memory") },
    ...(options.applePush
      ? {
          secretReferences: [
            ...source.secretReferences,
            { ref: "web-push-vapid", version: "v1", purpose: "web-push", scope: "agent" },
            { ref: "apple-push-key", version: "v1", purpose: "apple-push", scope: "agent" },
          ],
          runPolicy: {
            ...source.runPolicy,
            webPush: { secretRef: "web-push-vapid", subject: "mailto:owner@example.com" },
            applePush: {
              secretRef: "apple-push-key",
              teamId: "TEAM123456",
              keyId: "KEY1234567",
              topics: [TOPIC],
              environments: ["development", "production"],
            },
          },
        }
      : {}),
  };
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const errors = sink();
  expect(await runAdminCli(["init", "--config", configPath], sink().stream, errors.stream)).toBe(0);
  const secrets = path.join(root, "secrets");
  await mkdir(secrets, { mode: 0o700 });
  const database = openQualifiedDatabase(path.join(stateRoot, "data", "product.sqlite"));
  try {
    database.pragma("foreign_keys = OFF");
    const device = database.prepare(
      `INSERT INTO paired_devices (
        id, owner_id, agent_id, revision, kind, name, release_channel, device_public_key,
        confirm_public_key, status, supported_actions, web_device_id, web_session_id,
        paired_at, confirmed_at, revoked_at, last_seen_at, companion_of
      ) VALUES (?, ?, ?, 1, 'iphone', ?, 'direct', ?, ?, ?, '[]', 'web-device', 'web-session',
        ?, ?, CASE WHEN ? = 'revoked' THEN ? END, NULL, NULL)`,
    );
    const registration = database.prepare(
      `INSERT INTO apns_registrations (
        id, owner_id, agent_id, device_id, push_type, activity_ref, token, environment,
        topic, locale, status, failure_code, created_at, updated_at, last_delivered_at
      ) VALUES (?, ?, ?, ?, ?, '', ?, 'production', ?, ?, ?, NULL, ?, ?, NULL)`,
    );
    const add = (
      id: string,
      deviceStatus: string,
      pushType: string,
      status: string,
      locale: string,
      topic = TOPIC,
    ) => {
      const deviceId = `dev_${id.padEnd(22, "x")}`;
      device.run(
        deviceId,
        config.ownerId,
        config.agentId,
        id,
        `key-${id}`,
        `confirm-${id}`,
        deviceStatus,
        START,
        START,
        deviceStatus,
        START,
      );
      registration.run(
        `apn_${id.padEnd(22, "x")}`,
        config.ownerId,
        config.agentId,
        deviceId,
        pushType,
        id.padEnd(64, "0"),
        topic,
        locale,
        status,
        START,
        START,
      );
    };
    add("a1", "active", "alert", "active", "zh-CN");
    add("b2", "active", "alert", "active", "en");
    add("c3", "revoked", "alert", "active", "zh-CN");
    add("d4", "active", "alert", "disabled", "zh-CN");
    add("e5", "active", "widgets", "active", "zh-CN");
    add("f6", "active", "alert", "active", "ja", "other.topic.app");
  } finally {
    database.close();
  }
  return { root, configPath, secrets, stateRoot };
}

async function event(root: string, value: unknown) {
  const file = path.join(root, "outage.json");
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function outageArguments(paths: { configPath: string; secrets: string }, eventFile: string) {
  return [
    "push",
    "outage",
    "--config",
    paths.configPath,
    "--secret-dir",
    paths.secrets,
    "--event-file",
    eventFile,
  ];
}

it("[OUTAGE-1] tells each active iPhone the server is down, then replaces it with the recovery", async () => {
  const apns: ApnsStub = await startApnsStub();
  closers.push(() => apns.close());
  const paths = await deployment({ applePush: true });
  await writeFile(path.join(paths.secrets, "apple-push-key.v1"), apns.signingKeyPem, {
    mode: 0o600,
  });

  const down = await event(paths.root, {
    schemaVersion: 1,
    state: "down",
    failedChecks: 5,
    since: "2026-11-27T02:00:00.000Z",
    at: "2026-11-27T02:04:00.000Z",
  });
  expect(await runOutagePush(outageArguments(paths, down), { origins: apns.origins })).toEqual({
    outputSchemaVersion: 1,
    command: "push.outage",
    state: "down",
    registrations: 2,
    sent: 2,
    failures: [],
  });
  const downAlerts = apns.ofType("alert");
  expect(downAlerts.map((alert) => alert.path)).toEqual([
    `/3/device/${"a1".padEnd(64, "0")}`,
    `/3/device/${"b2".padEnd(64, "0")}`,
  ]);
  expect(downAlerts[0]?.headers).toMatchObject({
    "apns-topic": TOPIC,
    "apns-priority": "10",
    "apns-collapse-id": "server-outage",
    "apns-expiration": String(Date.parse("2026-11-27T02:04:00.000Z") / 1_000 + 86_400),
  });
  expect(downAlerts[0]?.json).toMatchObject({
    aps: {
      alert: {
        title: "Himawari 服务器没有响应",
        body: "健康检查已连续 5 次没有通过，恢复后会再通知你",
      },
      "interruption-level": "time-sensitive",
    },
    himawari: { kind: "server_outage", state: "down" },
  });
  expect(downAlerts[1]?.json).toMatchObject({
    aps: { alert: { title: "Himawari's server is not responding" } },
  });

  const up = await event(paths.root, {
    schemaVersion: 1,
    state: "up",
    failedChecks: 12,
    since: "2026-11-27T02:00:00.000Z",
    at: "2026-11-27T02:12:00.000Z",
  });
  const refused = sink();
  expect(
    await runAdminCli(
      ["push", "outage", "--config", paths.configPath],
      sink().stream,
      refused.stream,
    ),
  ).toBe(1);
  expect(JSON.parse(refused.text())).toEqual({ error: { code: "PUSH_ARGUMENT_INVALID" } });
  expect(await runOutagePush(outageArguments(paths, up), { origins: apns.origins })).toMatchObject({
    state: "up",
    sent: 2,
  });
  const upAlert = apns.ofType("alert")[2];
  expect(upAlert?.headers["apns-collapse-id"]).toBe("server-outage");
  expect(upAlert?.json).toMatchObject({
    aps: {
      alert: { title: "Himawari 服务器已恢复", body: "从第一次检查失败到恢复，约 12 分钟" },
      "interruption-level": "active",
    },
    himawari: { state: "up" },
  });
});

it("[OUTAGE-2] reports a retryable failure so systemd tries again, and sends nothing for a broken event", async () => {
  const apns: ApnsStub = await startApnsStub();
  closers.push(() => apns.close());
  const paths = await deployment({ applePush: true });
  await writeFile(path.join(paths.secrets, "apple-push-key.v1"), apns.signingKeyPem, {
    mode: 0o600,
  });
  const valid = {
    schemaVersion: 1,
    state: "down",
    failedChecks: 5,
    since: "2026-11-27T02:00:00.000Z",
    at: "2026-11-27T02:04:00.000Z",
  };
  apns.respond = () => ({ status: 503, reason: "ServiceUnavailable" });
  await expect(
    runOutagePush(outageArguments(paths, await event(paths.root, valid)), {
      origins: apns.origins,
    }),
  ).rejects.toThrow("PUSH_OUTAGE_RETRY");

  const before = apns.requests.length;
  for (const broken of [
    "not json",
    { ...valid, schemaVersion: 2 },
    { ...valid, state: "maybe" },
    { ...valid, failedChecks: 0 },
    { ...valid, since: "2026-11-27T03:00:00.000Z" },
    { ...valid, at: "yesterday" },
  ])
    await expect(
      runOutagePush(outageArguments(paths, await event(paths.root, broken)), {
        origins: apns.origins,
      }),
    ).rejects.toThrow("PUSH_OUTAGE_EVENT_INVALID");
  expect(apns.requests.length).toBe(before);
});

it("[OUTAGE-3] does nothing when Apple push is not configured", async () => {
  const paths = await deployment({ applePush: false });
  const file = await event(paths.root, {
    schemaVersion: 1,
    state: "down",
    failedChecks: 5,
    since: "2026-11-27T02:00:00.000Z",
    at: "2026-11-27T02:04:00.000Z",
  });
  const output = sink();
  expect(await runAdminCli(outageArguments(paths, file), output.stream, sink().stream)).toBe(0);
  expect(JSON.parse(output.text())).toEqual({
    outputSchemaVersion: 1,
    command: "push.outage",
    state: "down",
    skipped: "APPLE_PUSH_NOT_CONFIGURED",
  });
});
