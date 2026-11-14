import { createHash, randomBytes } from "node:crypto";
import { expect } from "vitest";
import {
  agentId,
  type Harness,
  ownerId,
  type PairedClient,
  send,
  signedRequest,
} from "./device-api-harness.ts";

export const perceptionScope = { ownerId, agentId };

export function recordId(): string {
  return `perception:${randomBytes(16).toString("hex")}`;
}

export function atOffset(h: Harness, seconds: number): string {
  return new Date(Date.parse(h.clock.now()) + seconds * 1000).toISOString();
}

export function utterance(
  h: Harness,
  text: string,
  options: {
    readonly id?: string;
    readonly seconds?: number;
    readonly durationMs?: number;
    readonly speaker?: Record<string, unknown>;
  } = {},
) {
  return {
    id: options.id ?? recordId(),
    type: "speech.utterance",
    captureSource: "device_microphone",
    occurredAt: atOffset(h, options.seconds ?? 0),
    confidence: 900,
    text,
    ...(options.speaker ? { speaker: options.speaker } : {}),
    evidence: { durationMs: options.durationMs ?? 2000 },
  };
}

export function power(h: Harness, seconds = 0, id = recordId()) {
  return {
    id,
    type: "context.power",
    captureSource: "system_api",
    occurredAt: atOffset(h, seconds),
    confidence: 1000,
    evidence: { batteryPercent: 80, charging: false },
  };
}

export function visit(h: Harness, seconds = 0, id = recordId()) {
  return {
    id,
    type: "location.visit",
    captureSource: "device_sensor",
    occurredAt: atOffset(h, seconds),
    confidence: 1000,
    evidence: { latitude: 35.68, longitude: 139.76, placeName: "Tokyo Station" },
  };
}

function reply(response: { statusCode: number; json: () => unknown }) {
  const body = response.json() as Record<string, unknown>;
  const error = body["error"] as Record<string, unknown> | undefined;
  return { status: response.statusCode, body, code: error?.["code"], error };
}

export async function devicePost(h: Harness, client: PairedClient, path: string, body: unknown) {
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: `/api/device/v1/${path}`,
      body: JSON.stringify(body),
    }),
  );
  return reply(response);
}

export async function deviceGet(h: Harness, client: PairedClient, path: string) {
  const response = await send(
    h,
    signedRequest(h, client, { method: "GET", path: `/api/device/v1/${path}` }),
  );
  return reply(response);
}

export async function ingest(h: Harness, client: PairedClient, records: readonly unknown[]) {
  const result = await devicePost(h, client, "perception", { records });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as {
    outcomes: { id: string; outcome: string }[];
    reached: string[];
  };
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function ndjson(lines: readonly unknown[]): Buffer {
  return Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
}

export async function beginUpload(h: Harness, client: PairedClient, body: Record<string, unknown>) {
  const result = await devicePost(h, client, "uploads/begin", body);
  return {
    ...result,
    target: result.body as { grant: string; expiresAt: string; path: string; header: string },
  };
}

export async function upload(
  h: Harness,
  target: { readonly path: string; readonly header: string; readonly grant: string },
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) {
  const response = await h.app.inject({
    method: "POST",
    url: target.path,
    headers: {
      host: new URL(h.origin).host,
      "content-type": "application/octet-stream",
      [target.header]: target.grant,
      ...headers,
    },
    payload: Buffer.from(bytes),
  });
  return reply(response);
}
