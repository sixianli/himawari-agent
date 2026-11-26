import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SpeechConfiguration } from "@himawari-agent/application";
import { MagpieDashScopeSpeech } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";

const GATEWAY_KEY = "magpie-gateway-test-key";
const PCM_PARTS = [Buffer.from([1, 0, 2, 0, 3, 0]), Buffer.from([4, 0, 5, 0])];

interface MagpieCall {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

type Behaviour = "audio" | "silent" | "upstream-error" | "status-401";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await removeDeviceHarnessDirectories();
});

function event(payload: unknown): string {
  return `id:1\nevent:result\ndata:${JSON.stringify(payload)}\n\n`;
}

async function loopbackMagpie(behaviour: { current: Behaviour }) {
  const calls: MagpieCall[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push({
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      if (behaviour.current === "status-401") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (behaviour.current === "silent") return;
      if (behaviour.current === "upstream-error") {
        response.end(event({ code: "InvalidParameter", message: "voice not found" }));
        return;
      }
      for (const part of PCM_PARTS)
        response.write(event({ output: { audio: { data: part.toString("base64") } } }));
      response.end(
        event({ output: { finish_reason: "stop", audio: { data: "", url: "https://x" } } }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, port: (server.address() as AddressInfo).port };
}

const speechConfiguration: SpeechConfiguration = {
  adapter: "dashscope-qwen-tts",
  magpieModelRef: "deepseek-primary",
  provider: "dashscope-intl",
  model: "qwen3-tts-flash",
  voice: "Serena",
  languageType: "Chinese",
  firstAudioTimeoutMs: 300,
  maximumCharacters: 600,
};

async function setup(behaviour: Behaviour, withSpeech = true) {
  const state = { current: behaviour };
  const magpie = await loopbackMagpie(state);
  const h = await harness(
    withSpeech
      ? {
          speech: new MagpieDashScopeSpeech({
            configuration: speechConfiguration,
            magpieBaseUrl: `http://127.0.0.1:${magpie.port}/v1`,
            gatewayKey: async () => GATEWAY_KEY,
          }),
        }
      : {},
  );
  const client = await pairAndConfirm(h);
  return { h, client, magpie, state };
}

function speak(h: Harness, client: PairedClient, body: unknown) {
  return send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/speech",
      body: JSON.stringify(body),
    }),
  );
}

describe("device speech goes through Magpie to the configured voice", () => {
  it("streams the voice's PCM audio and sends the configured model, voice and language through Magpie", async () => {
    const { h, client, magpie } = await setup("audio");
    const response = await speak(h, client, { text: "明天上午十点你和牙医有约。" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/L16;rate=24000;channels=1");
    expect(response.headers["x-himawari-speech-sample-rate"]).toBe("24000");
    expect(Number(response.headers["x-himawari-speech-first-audio-ms"])).toBeGreaterThanOrEqual(0);
    expect(response.rawPayload.equals(Buffer.concat(PCM_PARTS))).toBe(true);
    expect(magpie.calls).toHaveLength(1);
    const call = magpie.calls[0] as MagpieCall;
    expect(call.url).toBe(
      "/v1/magpie/native/dashscope-intl/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(call.headers["authorization"]).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(call.headers["x-dashscope-sse"]).toBe("enable");
    expect(call.body).toEqual({
      model: "qwen3-tts-flash",
      input: { text: "明天上午十点你和牙医有约。", voice: "Serena", language_type: "Chinese" },
    });
  });

  it("keeps a password on the phone: the sentence is refused before anything leaves", async () => {
    const { h, client, magpie } = await setup("audio");
    const response = await speak(h, client, { text: "你的密码是 Abc12345!" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ code: "SPEECH_SENSITIVE_TEXT" });
    expect(magpie.calls).toHaveLength(0);
  });

  it("answers within the first-audio limit when the voice stays silent, so the phone can speak instead", async () => {
    const { h, client, magpie } = await setup("silent");
    const started = Date.now();
    const response = await speak(h, client, { text: "好的，记下了。" });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ code: "SPEECH_FIRST_AUDIO_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(speechConfiguration.firstAudioTimeoutMs + 1500);
    expect(magpie.calls).toHaveLength(1);
  });

  it("reports an upstream refusal instead of sending empty audio", async () => {
    for (const behaviour of ["upstream-error", "status-401"] as const) {
      const { h, client } = await setup(behaviour);
      const response = await speak(h, client, { text: "晚安，今天辛苦了。" });
      expect(response.statusCode, behaviour).toBe(502);
      expect(response.json()).toEqual({ code: "SPEECH_UPSTREAM_REJECTED" });
    }
  });

  it("says the voice is unavailable when no speech is configured", async () => {
    const { h, client, magpie } = await setup("audio", false);
    const response = await speak(h, client, { text: "好的。" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "SPEECH_UNAVAILABLE" });
    expect(magpie.calls).toHaveLength(0);
  });

  it("refuses empty, oversized and malformed requests without calling the voice", async () => {
    const { h, client, magpie } = await setup("audio");
    expect((await speak(h, client, { text: "   " })).statusCode).toBe(422);
    expect((await speak(h, client, { text: "好".repeat(601) })).statusCode).toBe(422);
    expect((await speak(h, client, { text: 3 })).statusCode).toBe(400);
    expect((await speak(h, client, { text: "好", extra: true })).statusCode).toBe(400);
    expect(magpie.calls).toHaveLength(0);
  });

  it("refuses an unsigned request", async () => {
    const { h, magpie } = await setup("audio");
    const response = await h.app.inject({
      method: "POST",
      url: "/api/device/v1/speech",
      headers: { host: new URL(h.origin).host, "content-type": "application/json" },
      payload: JSON.stringify({ text: "好的。" }),
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(magpie.calls).toHaveLength(0);
  });
});
