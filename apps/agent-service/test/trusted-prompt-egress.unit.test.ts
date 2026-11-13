import { createHmac } from "node:crypto";
import {
  EGRESS_PLACEHOLDER_LEGEND,
  ModelEgress,
  type ModelEgressSighting,
} from "@himawari-agent/application/runtime-port";
import type { PromptEntry } from "@himawari-agent/prompt-catalog";
import * as catalog from "@himawari-agent/prompt-catalog";
import {
  CHAT_IDENTITY,
  MEMORY_CAPTURE,
  renderPrompt,
  TRUSTED_PROMPT_TEXTS,
} from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import { memoryCapturePrompt } from "../src/production-memory-capture.js";
import { createProductionModelEgress } from "../src/production-model-egress.js";

const PLACEHOLDER = /\[(?:密码|验证码|证件号|银行卡 尾号\d{4})#[a-z]{8}\]|\[密钥\]/u;
const CONFIDENCE = "confidence 是 0 到 1000 的整数";

const isEntry = (value: unknown): value is PromptEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  Array.isArray((value as { segments?: unknown }).segments);

const entries = (): readonly PromptEntry[] =>
  (Object.values(catalog) as unknown[])
    .filter(isEntry)
    .sort((left, right) => left.id.localeCompare(right.id));

function rendered(entry: PromptEntry): string {
  const values: Record<string, string> = {};
  for (const segment of entry.segments)
    if (segment.kind === "slot") values[segment.name] = "示例 482910";
  return renderPrompt(entry, values);
}

function egress(reports: ModelEgressSighting[], trusted?: readonly string[]): ModelEgress {
  const report = (_context: unknown, sightings: readonly ModelEgressSighting[]) =>
    reports.push(...sightings);
  if (trusted === undefined)
    return createProductionModelEgress(
      {
        secretReferences: [{ ref: "payload-key", version: "v1", purpose: "payload-encryption" }],
      } as never,
      { keys: { resolve: async () => new TextEncoder().encode("payload-key-material") } } as never,
      { reportEgress: report } as never,
    );
  const key = new TextEncoder().encode("trusted-prompt-egress");
  return new ModelEgress({
    key: async () => key,
    sign: (secret, message) =>
      new Uint8Array(createHmac("sha256", secret).update(message).digest()),
    report,
    trusted,
  });
}

async function sent(
  messages: readonly { readonly role: string; readonly content: string }[],
  options: { readonly trusted?: readonly string[] } = {},
): Promise<{
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly reports: readonly ModelEgressSighting[];
  readonly body: string;
}> {
  const reports: ModelEgressSighting[] = [];
  const bodies: string[] = [];
  const exchange = egress(reports, options.trusted).exchange({
    ownerId: "owner-trusted" as never,
    agentId: "agent-trusted" as never,
    threadId: null,
    source: "background",
    purpose: "memory-capture",
  });
  const fetch = exchange.wrapFetch(async (_input: string, init?: { body?: string }) => {
    bodies.push(String(init?.body ?? ""));
    return { ok: true };
  });
  await fetch("http://127.0.0.1:9/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "loopback", messages }),
  } as never);
  const body = bodies[0] ?? "";
  return { messages: JSON.parse(body).messages, reports, body };
}

const background = (prompt: string) => [
  { role: "system", content: EGRESS_PLACEHOLDER_LEGEND },
  { role: "user", content: prompt },
];

describe("Himawari's own fixed prompt text on the way to the model", () => {
  it("[I-78] sends the memory capture instructions unchanged and records nothing for them", async () => {
    const prompt = memoryCapturePrompt("写一个小游戏", []);
    const { messages, reports } = await sent(background(prompt));
    expect(messages.at(-1)?.content).toBe(prompt);
    expect(messages.at(-1)?.content).toContain(CONFIDENCE);
    expect(reports).toEqual([]);
  });

  it("[I-78] REVERSE: without the trusted list the same request masks 1000 as a code and records it", async () => {
    const fixed = "验证码说明：Himawari 自己写的固定文字，评分是 0 到 1000 的整数。";
    const withList = await sent(background(fixed), { trusted: [fixed] });
    expect(withList.messages.at(-1)?.content).toBe(fixed);
    expect(withList.reports).toEqual([]);
    const { messages, reports } = await sent(background(fixed), { trusted: [] });
    expect(messages.at(-1)?.content).not.toContain("1000");
    expect(messages.at(-1)?.content).toMatch(/0 到 \[验证码#[a-z]{8}\] 的整数/u);
    expect(reports.map(({ category, part }) => [category, part])).toEqual([
      ["verification-code", "owner_message"],
    ]);
  });

  it("sends the chat identity from before the look-it-up-first sentence unchanged, so conversations frozen with it keep their request head", async () => {
    const added =
      "\n- 提下一步之前，能用本轮的工具查清楚的先查，再提一个主人可以直接点头的具体做法，并说出依据；查不到依据的不提。";
    expect(CHAT_IDENTITY.text).toContain(added);
    const previous = CHAT_IDENTITY.text.replace(added, "");
    expect(TRUSTED_PROMPT_TEXTS).not.toContain(previous);
    const { messages, reports } = await sent([
      { role: "system", content: previous },
      { role: "user", content: "明天天气怎么样" },
    ]);
    expect(messages[0]?.content).toBe(previous);
    expect(reports).toEqual([]);
  });

  it("[I-78] sends every catalog entry unchanged, as a system message and as a user message", async () => {
    const list = entries();
    expect(list.length).toBeGreaterThan(100);
    for (const entry of list) {
      const text = rendered(entry);
      for (const role of ["system", "user"]) {
        const { messages, reports } = await sent([{ role, content: text }]);
        expect({ id: entry.id, role, text: messages[0]?.content }).toEqual({
          id: entry.id,
          role,
          text,
        });
        expect({ id: entry.id, role, reports }).toEqual({ id: entry.id, role, reports: [] });
      }
    }
  });

  it("[I-78] does not let a keyword in the fixed text reach a number in the data right after it", async () => {
    expect(TRUSTED_PROMPT_TEXTS).toContain(MEMORY_CAPTURE.text);
    const data = '{"ownerMessage":"房间号 123456"}';
    const trusted = await sent(background(`验证码由下面说明决定：${MEMORY_CAPTURE.text}${data}`));
    expect(trusted.messages.at(-1)?.content).toContain("123456");
    const glued = await sent(background(`${MEMORY_CAPTURE.text.slice(0, -1)}验证码。${data}`));
    expect(glued.body).not.toContain("123456");
  });

  it("[I-78] still masks a code the owner wrote inside the data, and records it", async () => {
    const prompt = memoryCapturePrompt("我的验证码是 482910", []);
    const { messages, reports, body } = await sent(background(prompt));
    expect(body).not.toContain("482910");
    expect(messages.at(-1)?.content).toContain(CONFIDENCE);
    expect(messages.at(-1)?.content).toMatch(PLACEHOLDER);
    expect(reports.map(({ category }) => category)).toEqual(["verification-code"]);
  });

  it("[I-78] does not treat a short piece as trusted, so a keyword the owner wrote still counts", async () => {
    expect(TRUSTED_PROMPT_TEXTS.every((text) => [...text].length >= 24)).toBe(true);
    expect(TRUSTED_PROMPT_TEXTS).not.toContain("。");
    const sentence = "验证码 482910";
    const shortTrusted = await sent([{ role: "user", content: sentence }], { trusted: ["验证码"] });
    expect(shortTrusted.body).not.toContain("482910");
    const { body } = await sent([{ role: "user", content: sentence }]);
    expect(body).not.toContain("482910");
  });

  it("[I-78] masks a code named after the fixed text in the same message also before it", async () => {
    const before = `${MEMORY_CAPTURE.text}\n旧号码 482910`;
    const prompt = `${before}\n${MEMORY_CAPTURE.text}\n482910 是验证码`;
    const { body, messages } = await sent([{ role: "user", content: prompt }]);
    expect(body).not.toContain("482910");
    expect(messages[0]?.content.startsWith(`${MEMORY_CAPTURE.text}\n旧号码 [验证码#`)).toBe(true);
  });

  it("[I-78] keeps trusted text unchanged next to a machine secret marker and still masks the secret", async () => {
    const prompt = `${MEMORY_CAPTURE.text}\n[MACHINE_SECRET_REDACTED] 验证码 482910`;
    const { messages, body } = await sent(background(prompt));
    expect(
      messages.at(-1)?.content.startsWith(`${MEMORY_CAPTURE.text}\n[密钥] 验证码 [验证码#`),
    ).toBe(true);
    expect(body).not.toContain("482910");
  });

  it("[I-78] masks a private key that wraps a fixed text instead of refusing the request", async () => {
    const fence = (word: string) =>
      `${"-".repeat(5)}${word} ${["PRIVATE", "KEY"].join(" ")}${"-".repeat(5)}`;
    const prompt = `${fence("BEGIN")}\n${MEMORY_CAPTURE.text}\n${fence("END")}`;
    const { messages } = await sent([{ role: "user", content: prompt }]);
    expect(messages[0]?.content).toBe("[密钥]");
  });

  it("[I-78] keeps the memory capture instructions unchanged when the owner's message holds an odd character", async () => {
    const prompt = memoryCapturePrompt("\uFFFF写一个小游戏", []);
    const { messages, reports } = await sent(background(prompt));
    expect(messages.at(-1)?.content).toBe(prompt);
    expect(reports).toEqual([]);
  });

  it("[I-78] masks the same content to the same bytes every time", async () => {
    const prompt = memoryCapturePrompt("我的验证码是 482910", []);
    const first = await sent(background(prompt));
    const second = await sent(background(prompt));
    expect(second.body).toBe(first.body);
  });
});
