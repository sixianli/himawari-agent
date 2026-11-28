import { createRunId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentId,
  createThread,
  harness,
  ownerId,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

const MODELS = {
  primaryRef: "magpie-main",
  catalog: [
    {
      ref: "magpie-main",
      name: "himawari-main",
      provider: "magpie",
      thinkingLevels: ["off", "low", "medium", "high"],
      automatic: true,
    },
    {
      ref: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      provider: "magpie",
      thinkingLevels: ["off", "high"],
      price: { input: 0.1, output: 0.4 },
      priceTier: "low" as const,
    },
    {
      ref: "public-only",
      name: "Public only",
      provider: "magpie",
      thinkingLevels: ["off"],
    },
  ],
};

type H = Awaited<ReturnType<typeof harness>>;
type Client = Awaited<ReturnType<typeof pairAndConfirm>>;

async function config(h: H, client: Client) {
  const response = await send(
    h,
    signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" }),
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Record<string, unknown>;
}

async function say(h: H, client: Client, threadId: string, messageId: string, revision: number) {
  const response = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/messages",
      body: JSON.stringify({ messageId, threadId, expectedRevision: revision, text: "你好" }),
    }),
  );
  expect(response.statusCode, response.body).toBe(200);
  const detail = await send(
    h,
    signedRequest(h, client, { method: "GET", path: `/api/device/v1/threads/${threadId}` }),
  );
  const runs = (detail.json() as { payload: { runs: { runId: string }[] } }).payload.runs;
  const runId = runs.at(-1)?.runId;
  expect(runId).toBeTruthy();
  const source = await h.repository
    .runExecutionSource(ownerId, agentId)
    .read(createRunId(runId as string));
  return source?.modelSelection ?? null;
}

async function choose(h: H, modelRef: string | null, thinkingLevel: string | null) {
  const store = h.repository.ownerPreferences();
  const current = await store.read({ ownerId, agentId });
  await store.write({
    ownerId,
    agentId,
    name: current.name,
    locale: current.locale,
    accent: current.accent,
    theme: current.theme,
    modelRef,
    thinkingLevel: thinkingLevel as never,
    expectedRevision: current.revision,
    now: new Date().toISOString(),
  });
}

describe("[MODELS] the model the owner picks on the phone", () => {
  it("[I-129] lists every chat model the server has, whatever data it was once limited to, in /config", async () => {
    const h = await harness({ chatModels: MODELS });
    const client = await pairAndConfirm(h);
    expect((await config(h, client))["chatModels"]).toEqual({
      defaultRef: "magpie-main",
      options: MODELS.catalog,
    });
    await h.repository.close();
  });

  it("answers with the saved model and depth, and with the server default when nothing is saved", async () => {
    const h = await harness({ chatModels: MODELS });
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-device-models");

    expect(await say(h, client, "thread-device-models", "device-message-models-01", 1)).toBeNull();

    await choose(h, "deepseek-flash", "high");
    const revision = (
      await send(
        h,
        signedRequest(h, client, {
          method: "GET",
          path: "/api/device/v1/threads/thread-device-models",
        }),
      )
    ).json() as { payload: { thread: { revision: number } } };
    expect(
      await say(
        h,
        client,
        "thread-device-models",
        "device-message-models-02",
        revision.payload.thread.revision,
      ),
    ).toEqual({ modelRef: "deepseek-flash", thinkingLevel: "high" });
    await h.repository.close();
  });

  it("falls back to the server default when the saved model is no longer offered", async () => {
    const h = await harness({ chatModels: MODELS });
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-device-models-gone");
    await choose(h, "retired-model", "off");
    expect(
      await say(h, client, "thread-device-models-gone", "device-message-models-03", 1),
    ).toBeNull();
    await h.repository.close();
  });

  it("picks a usable depth when the saved one does not fit the saved model", async () => {
    const h = await harness({ chatModels: MODELS });
    const client = await pairAndConfirm(h);
    await createThread(h, "thread-device-models-depth");
    await choose(h, "deepseek-flash", "medium");
    expect(
      await say(h, client, "thread-device-models-depth", "device-message-models-04", 1),
    ).toEqual({ modelRef: "deepseek-flash", thinkingLevel: "high" });
    await h.repository.close();
  });

  it("offers no model list on a server without one", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    expect(await config(h, client)).not.toHaveProperty("chatModels");
    await h.repository.close();
  });
});
