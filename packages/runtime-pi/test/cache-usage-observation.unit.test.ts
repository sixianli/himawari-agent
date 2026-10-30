import { describe, expect, it } from "vitest";
import { observeCacheFields, usageReportsCache } from "../src/cache-usage-observation.js";

function sse(frames: readonly unknown[], status = 200): Response {
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

async function observe(response: Response): Promise<boolean> {
  const observation = observeCacheFields(async () => response);
  const returned = await observation.fetch("https://provider.invalid/v1/chat/completions");
  await returned.text();
  return observation.reported();
}

describe("cache field observation", () => {
  it("counts a response as reported when the usage frame carries OpenAI cached_tokens, even at zero", async () => {
    const frames = [
      { choices: [{ index: 0, delta: { content: "hi" } }] },
      { usage: { prompt_tokens: 3759, prompt_tokens_details: { cached_tokens: 0 } } },
    ];
    await expect(observe(sse(frames))).resolves.toBe(true);
  });

  it("counts DeepSeek prompt_cache_hit_tokens and Anthropic cache_read_input_tokens", async () => {
    await expect(
      observe(sse([{ usage: { prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 40 } }])),
    ).resolves.toBe(true);
    await expect(
      observe(sse([{ usage: { cache_read_input_tokens: 0, input_tokens: 10 } }])),
    ).resolves.toBe(true);
  });

  it("treats a usage frame without any cache field as not reported", async () => {
    const frames = [{ usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }];
    await expect(observe(sse(frames))).resolves.toBe(false);
  });

  it("does not count a null or non-numeric cache field", async () => {
    await expect(
      observe(sse([{ usage: { prompt_tokens_details: { cached_tokens: null } } }])),
    ).resolves.toBe(false);
    await expect(observe(sse([{ usage: { prompt_cache_hit_tokens: "128" } }]))).resolves.toBe(
      false,
    );
  });

  it("is not fooled by model text that mentions the field names", async () => {
    const frames = [
      {
        choices: [
          { index: 0, delta: { content: 'the usage field "cached_tokens": 5 was returned' } },
        ],
      },
      { usage: { prompt_tokens: 100, completion_tokens: 5 } },
    ];
    await expect(observe(sse(frames))).resolves.toBe(false);
  });

  it("reads a usage object nested in a choice", async () => {
    const frames = [{ choices: [{ index: 0, usage: { prompt_cache_hit_tokens: 0 } }] }];
    await expect(observe(sse(frames))).resolves.toBe(true);
  });

  it("returns false and leaves the response intact when the provider answers with an error", async () => {
    const observation = observeCacheFields(async () => sse([{ usage: { cached_tokens: 1 } }], 500));
    const response = await observation.fetch("https://provider.invalid/v1/chat/completions");
    expect(response.status).toBe(500);
    await expect(observation.reported()).resolves.toBe(false);
  });

  it("reports false before any request has been made", async () => {
    await expect(observeCacheFields(async () => sse([])).reported()).resolves.toBe(false);
  });

  it("recognises the three field names on a usage object directly", () => {
    expect(usageReportsCache({ prompt_tokens_details: { cached_tokens: 7 } })).toBe(true);
    expect(usageReportsCache({ prompt_tokens: 7 })).toBe(false);
    expect(usageReportsCache(undefined)).toBe(false);
  });
});
