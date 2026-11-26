import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildDeviceTestRequest,
  type DeviceTestKeyPair,
  generateDeviceTestKeyPair,
} from "@himawari-agent/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pairingCode } from "../fixtures/device-api-harness.ts";
import { ANSWER_ENDING, ANSWER_OPENING } from "../ios-e2e/answers.ts";
import { type E2eBackend, startE2eBackend } from "../ios-e2e/backend.ts";

let backend: E2eBackend;
let ca: Buffer;

interface Reply {
  readonly status: number;
  readonly text: string;
}

function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
  onChunk?: (chunk: string) => boolean,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { method: init.method ?? "GET", headers: init.headers, ca },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
          if (onChunk?.(chunk)) {
            request.destroy();
            resolve({ status: response.statusCode ?? 0, text });
          }
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
        response.on("error", reject);
      },
    );
    request.on("error", (error) => {
      if (!request.destroyed) reject(error);
    });
    if (init.body) request.write(init.body);
    request.end();
  });
}

function signed(
  device: { id: string; keys: DeviceTestKeyPair },
  method: string,
  path: string,
  body?: unknown,
) {
  const built = buildDeviceTestRequest({
    origin: backend.origin,
    deviceId: device.id,
    deviceKey: device.keys.privateKey,
    method,
    path,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    url: built.url,
    init: { method, headers: built.headers, ...(built.body ? { body: built.body } : {}) },
  };
}

async function pairDevice() {
  const link = JSON.parse(
    (await call(`${backend.controlOrigin}/pairing-link`, { method: "POST" })).text,
  ) as { link: string };
  const keys = generateDeviceTestKeyPair();
  const confirmKeys = generateDeviceTestKeyPair();
  const paired = await call(`${backend.origin}/api/device/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode: pairingCode(link.link),
      kind: "iphone",
      name: "E2E iPhone",
      releaseChannel: "direct",
      devicePublicKey: keys.publicKeySpkiBase64,
      confirmPublicKey: confirmKeys.publicKeySpkiBase64,
    }),
  });
  expect(paired.status, paired.text).toBe(201);
  const device = { id: (JSON.parse(paired.text) as { device: { id: string } }).device.id, keys };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const config = signed(device, "GET", "/api/device/v1/config");
    if ((await call(config.url, config.init)).status === 200) return device;
    await delay(200);
  }
  throw new Error("IOS_E2E_PAIRING_NOT_CONFIRMED");
}

async function mainThread(device: { id: string; keys: DeviceTestKeyPair }) {
  const query = signed(device, "POST", "/api/device/v1/gateway", {
    gateway: "thread-v3",
    type: "thread.main",
    messageId: "device-message-main",
    payload: {},
  });
  const reply = await call(query.url, query.init);
  expect(reply.status, reply.text).toBe(200);
  return (JSON.parse(reply.text) as { payload: { thread: { threadId: string; revision: number } } })
    .payload.thread;
}

describe("iPhone end-to-end backend", () => {
  beforeAll(async () => {
    backend = await startE2eBackend();
    ca = await readFile(backend.caPath);
  }, 120_000);

  afterAll(async () => {
    await backend?.close();
  });

  it("pairs a device over HTTPS and streams the answer to it piece by piece", async () => {
    const device = await pairDevice();
    const thread = await mainThread(device);
    const pieces: { at: number; text: string }[] = [];
    const stream = signed(
      device,
      "GET",
      `/api/device/v1/threads/${thread.threadId}/execution-stream`,
    );
    const watching = call(stream.url, stream.init, (chunk) => {
      for (const line of chunk.split("\n"))
        if (line.startsWith("data:") && line.includes("thread.execution_text")) {
          const event = JSON.parse(line.slice(5)) as { payload: { text: string } };
          pieces.push({ at: Date.now(), text: event.payload.text });
        }
      return pieces
        .map((piece) => piece.text)
        .join("")
        .includes(ANSWER_ENDING);
    });
    const message = signed(device, "POST", "/api/device/v1/messages", {
      messageId: "device-message-e2e-0001",
      threadId: thread.threadId,
      expectedRevision: thread.revision,
      text: "你好",
    });
    const sent = await call(message.url, message.init);
    expect(sent.status, sent.text).toBe(200);
    await Promise.race([
      watching,
      delay(60_000).then(() => {
        throw new Error("IOS_E2E_ANSWER_NOT_STREAMED");
      }),
    ]);
    const joined = pieces.map((piece) => piece.text).join("");
    expect(joined.startsWith(`${ANSWER_OPENING}“你好”。`)).toBe(true);
    expect(pieces.length).toBeGreaterThan(5);
    expect((pieces.at(-1)?.at ?? 0) - (pieces[0]?.at ?? 0)).toBeGreaterThan(1000);
    const listed = JSON.parse((await call(`${backend.controlOrigin}/messages`)).text) as {
      messages: { role: string; text: string }[];
    };
    expect(listed.messages.filter((entry) => entry.text === "你好")).toHaveLength(1);
  }, 120_000);

  it("refuses connections while offline and accepts them again once back online", async () => {
    await call(`${backend.controlOrigin}/offline`, { method: "POST" });
    await expect(call(`${backend.origin}/api/device/v1/config`)).rejects.toThrow();
    await call(`${backend.controlOrigin}/online`, { method: "POST" });
    expect((await call(`${backend.origin}/api/device/v1/config`)).status).toBe(401);
  });
});
