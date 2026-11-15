import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DELIVERY_TIMING_DEFAULTS } from "@himawari-agent/application";
import { DeliveryTimingDecision } from "@himawari-agent/platform-node";
import { createDeliveryTimingSource } from "../../apps/agent-service/src/production-delivery-timing.ts";
import {
  type Harness,
  harness,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import { atOffset, ingest, perceptionScope, recordId } from "../fixtures/perception-test-client.ts";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await removeDeviceHarnessDirectories();
});

async function jevStub(probability: number) {
  const seen: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "typesafe-ai/jev",
          answers: [{ type: "predicate", name: "unwelcome", probability }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { seen, baseUrl: `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1` };
}

function motion(h: Harness, seconds: number, activity: string) {
  return {
    id: recordId(),
    type: "motion.activity",
    captureSource: "system_api",
    occurredAt: atOffset(h, seconds),
    confidence: 900,
    evidence: { activity, certainty: "high" },
  };
}

function focus(h: Harness, seconds: number, active: boolean) {
  return {
    id: recordId(),
    type: "context.focus",
    captureSource: "system_api",
    occurredAt: atOffset(h, seconds),
    confidence: 1000,
    evidence: { active },
  };
}

async function source(h: Harness, baseUrl: string) {
  return createDeliveryTimingSource({
    model: new DeliveryTimingDecision({
      model: "typesafe-ai/jev",
      inputMicrosPerMillionTokens: 100_000,
      apiKey: async () => "test-key",
      baseUrl,
    }),
    configuration: () => DELIVERY_TIMING_DEFAULTS,
    store: h.repository.perception(),
    scope: perceptionScope,
    reserve: (micros) => h.perception.reserveModelCost(perceptionScope, micros),
    now: () => Date.parse(h.clock.now()),
  });
}

describe("[IOS-4] delivery timing source over the real perception store", () => {
  it("reads the owner's fresh reports, asks the decision model about them, and defers on a busy answer", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [motion(h, -30, "driving"), focus(h, -60, true)]);
    const stub = await jevStub(0.95);
    const timing = await source(h, stub.baseUrl);
    const judgement = await timing.judge("run_result", Date.parse(h.clock.now()));
    expect(judgement).toMatchObject({
      action: "defer",
      reasonCode: "timing_busy",
      judged: true,
      signals: ["motion", "focus"],
    });
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]?.authorization).toBe("Bearer test-key");
    const input = JSON.stringify(stub.seen[0]?.body["input"]);
    expect(input).toContain("driving");
    expect(input).toContain("run_result");
  });

  it("delivers when the decision model says the owner is not busy", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [motion(h, -30, "walking")]);
    const stub = await jevStub(0.1);
    const timing = await source(h, stub.baseUrl);
    expect(await timing.judge("mail_reminder", Date.parse(h.clock.now()))).toMatchObject({
      action: "deliver",
      reasonCode: "timing_clear",
    });
  });

  it("REVERSE: makes no model call and delivers when the owner has no fresh report", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [motion(h, -1800, "driving"), focus(h, -3600, true)]);
    const stub = await jevStub(1);
    const timing = await source(h, stub.baseUrl);
    expect(await timing.judge("run_result", Date.parse(h.clock.now()))).toMatchObject({
      action: "deliver",
      reasonCode: "timing_unknown",
      judged: false,
    });
    expect(stub.seen).toEqual([]);
  });

  it("REVERSE: delivers when the decision service is unreachable", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [motion(h, -30, "driving")]);
    const timing = await source(h, "http://127.0.0.1:1/v1");
    expect(await timing.judge("run_result", Date.parse(h.clock.now()))).toMatchObject({
      action: "deliver",
      reasonCode: "timing_failed",
    });
  });
});
