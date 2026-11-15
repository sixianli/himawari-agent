import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEVICE_ACTION_REGISTRATIONS,
  type DeviceActionRegistration,
  DeviceActionRegistry,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  harness,
  pairingCode,
  removeDeviceHarnessDirectories,
  web,
} from "../fixtures/device-api-harness.ts";
import { addRun, perceptionScope } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

const swift = spawnSync("swift", ["--version"], { encoding: "utf8" });
const swiftAvailable = swift.status === 0;
const packagePath =
  process.env["HIMAWARI_APPLE_PACKAGE"] ?? path.resolve(import.meta.dirname, "../../clients/apple");

const NOTE_ACTION: DeviceActionRegistration = {
  name: "test.note.append",
  schemaVersion: 1,
  deviceKinds: ["iphone"],
  parameters: { text: { type: "string", required: true, maxLength: 200 } },
  target: null,
  actionKind: "CREATE_OR_UPDATE",
  escalation: null,
  ownerPresence: () => false,
  recipients: null,
  resultOrigin: "owner",
  readBack: "read_item",
  snapshotBefore: true,
  reversible: true,
  untrustedOriginAllowed: true,
  confirmLabel: { "zh-CN": "记下", en: "Note it", ja: "メモする" },
  declineLabel: { "zh-CN": "不记", en: "Don't note it", ja: "メモしない" },
  title: { "zh-CN": "记一笔", en: "Take a note", ja: "メモを取る" },
  detail: (args) => ({
    "zh-CN": `记一笔：${args["text"]}`,
    en: `Note: ${args["text"]}`,
    ja: `メモ：${args["text"]}`,
  }),
};

const TOUCH_ACTION: DeviceActionRegistration = {
  ...NOTE_ACTION,
  name: "test.note.touch",
  readBack: "none",
  snapshotBefore: false,
  title: { "zh-CN": "摸一下", en: "Touch", ja: "触る" },
};

const NEWER_ACTION: DeviceActionRegistration = {
  ...NOTE_ACTION,
  name: "test.note.v2",
  schemaVersion: 2,
  title: { "zh-CN": "新版记一笔", en: "Take a note, version 2", ja: "メモ（第 2 版）" },
};

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function swiftActionNames(): Set<string> {
  const directory = path.join(packagePath, "Sources/HimawariActions");
  const names = new Set<string>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".swift"))) {
    const source = readFileSync(path.join(directory, file), "utf8");
    for (const list of source.matchAll(/public let names = \[([^\]]*)\]/gu))
      for (const name of (list[1] ?? "").matchAll(/"([^"]+)"/gu)) names.add(name[1] ?? "");
  }
  return names;
}

describe("[iOS-9B] the iPhone and the server name device actions the same way", () => {
  it("every action the server sends to an iPhone has an iPhone handler, and the iPhone handles nothing the server does not know", () => {
    const server = DEVICE_ACTION_REGISTRATIONS.filter((registration) =>
      registration.deviceKinds.includes("iphone"),
    ).map((registration) => registration.name);
    const iphone = swiftActionNames();
    expect(iphone.size).toBeGreaterThan(0);
    expect([...server].filter((name) => !iphone.has(name)).sort()).toEqual([]);
    const known = new Set(DEVICE_ACTION_REGISTRATIONS.map((registration) => registration.name));
    expect([...iphone].filter((name) => !known.has(name)).sort()).toEqual([]);
  });
});

describe("[iOS-9B] the iPhone executor runs against the real device-action server", () => {
  it("performs, reads back, replays and verifies through the Swift client", async () => {
    if (!swiftAvailable) return;
    const gateway = createServer();
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as AddressInfo).port;
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const h = await harness({
      origin,
      actionRegistry: new DeviceActionRegistry([
        ...DEVICE_ACTION_REGISTRATIONS,
        NOTE_ACTION,
        TOUCH_ACTION,
        NEWER_ACTION,
      ]),
    });
    h.actions.authorization.current = {
      authorize: async () => ({ decision: "allow", ownerPresent: false }),
    };
    await h.app.listen({ port, host: "127.0.0.1" });
    let runs = 0;
    const control = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://control");
        const input = request.method === "POST" ? await body(request) : {};
        if (url.pathname === "/pair") {
          const started = await web(h, "pairing-codes");
          const paired = await h.app.inject({
            method: "POST",
            url: "/api/device/v1/pair",
            headers: { host: new URL(origin).host, "content-type": "application/json" },
            payload: JSON.stringify({
              pairingCode: pairingCode(started.body["pairingUri"]),
              kind: "iphone",
              name: "Swift client",
              releaseChannel: "direct",
              devicePublicKey: input["devicePublicKey"],
              confirmPublicKey: input["confirmPublicKey"],
            }),
          });
          const device = (paired.json() as { device: { id: string; revision: number } }).device;
          await web(h, "confirm", { deviceId: device.id, expectedRevision: device.revision });
          return reply(response, 200, { deviceId: device.id, origin });
        }
        if (url.pathname === "/clock") return reply(response, 200, { now: h.clock.now() });
        if (url.pathname === "/advance") {
          h.clock.advance(Number(input["seconds"]) * 1000);
          return reply(response, 200, { now: h.clock.now() });
        }
        if (url.pathname === "/request") {
          const runId = String(input["runId"] ?? `run-${++runs}`);
          if (input["runId"] === undefined) await addRun(h, runId);
          const devices = await h.repository.pairedDevices().listDevices(perceptionScope);
          const device = devices.find((entry) => entry.id === input["deviceId"]);
          if (!device) return reply(response, 404, {});
          const outcome = await h.actions.service.request({
            runId,
            toolCallId: String(input["toolCallId"] ?? "call-1"),
            dataClassification: "private",
            device,
            action: String(input["action"]),
            arguments: (input["arguments"] ?? {}) as Record<string, unknown>,
          });
          return reply(response, 200, { runId, ...outcome });
        }
        return reply(response, 404, {});
      } catch (error) {
        return reply(response, 500, { error: String(error) });
      }
    });
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
    try {
      const child = spawn(
        "swift",
        ["test", "--package-path", packagePath, "--filter", "DeviceActionServerTests"],
        {
          env: { ...process.env, HIMAWARI_ACTION_CONTROL: controlUrl },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code, output.slice(-6000)).toBe(0);
      expect(output).toMatch(/DeviceActionServerTests/u);
      expect(output).not.toMatch(/skipped/u);
    } finally {
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await h.app.close();
      await h.repository.close();
    }
  }, 600_000);
});
