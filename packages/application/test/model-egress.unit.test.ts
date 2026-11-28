import { describe, expect, it } from "vitest";
import {
  ModelEgress,
  type ModelEgressContext,
  ModelEgressRefusedError,
  type ModelEgressSighting,
} from "../src/runtime-port.js";

const key = new Uint8Array([1, 2, 3, 4]);

function sign(secret: Uint8Array, message: string): Uint8Array {
  let hash = secret[0] ?? 0;
  const out = new Uint8Array(8);
  for (const char of message) {
    hash = (hash * 131 + char.charCodeAt(0)) % 2147483647;
    out[hash % 8] = (out[hash % 8] ?? 0) ^ (hash & 255);
  }
  return out;
}

function egress(): ModelEgress {
  return new ModelEgress({ key: async () => key, sign });
}

type Call = readonly [string, { body?: unknown; headers?: unknown; method?: string } | undefined];

function recorder() {
  const calls: Call[] = [];
  const base = async (
    input: string,
    init?: { method?: string; body?: unknown; headers?: unknown },
  ) => {
    calls.push([input, init]);
    return { ok: true };
  };
  return { calls, base };
}

async function send(
  path: string,
  body: unknown,
  options: { readonly exchange?: ReturnType<ModelEgress["exchange"]> } = {},
) {
  const exchange = options.exchange ?? egress().exchange();
  const { calls, base } = recorder();
  const fetch = exchange.wrapFetch(base);
  await fetch(`https://gateway.invalid/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "999" },
    body: JSON.stringify(body),
  });
  const init = calls[0]?.[1];
  return {
    exchange,
    init,
    sent: JSON.parse(String(init?.body)) as Record<string, unknown>,
    raw: String(init?.body),
  };
}

const PASSWORD = "Qz7mWx42Lp";
const PLACEHOLDER = /\[[^\]]+#[a-z]{8}\]/u;

describe("chat completions", () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    model: "m",
    stream: true,
    tools: [{ type: "function", function: { name: "bash", description: "password: tool-doc" } }],
    messages: [
      { role: "system", content: "你是 Himawari" },
      { role: "user", content: `我的密码：${PASSWORD}` },
      {
        role: "assistant",
        content: null,
        reasoning_content: "密码：reasoning-secret-1",
        tool_calls: [
          {
            id: "call_1234567890123456789",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: "login",
                signature: "密码：hunter22abc",
                nested: { list: ["验证码 482910"] },
              }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1234567890123456789", content: "验证码 482910" },
      {
        role: "user",
        content: [
          { type: "text", text: "再看一下" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA4111111111111111" } },
        ],
      },
    ],
    ...extra,
  });

  it("masks message text, tool results and every string inside tool-call arguments", async () => {
    const { sent, raw } = await send("/chat/completions", body());
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("482910");
    expect(raw).not.toContain("hunter22abc");
    const messages = sent["messages"] as Record<string, unknown>[];
    const calls = messages[2]?.["tool_calls"] as { function: { arguments: string } }[];
    const parsed = JSON.parse(calls[0]?.function.arguments ?? "{}");
    expect(parsed.signature).toMatch(PLACEHOLDER);
    expect(parsed.nested.list[0]).toMatch(PLACEHOLDER);
    expect(parsed.command).toBe("login");
  });

  it("leaves reasoning, ids, tool names, tool definitions and images byte-identical", async () => {
    const original = body();
    const { sent } = await send("/chat/completions", original);
    const messages = sent["messages"] as Record<string, unknown>[];
    expect(messages[2]?.["reasoning_content"]).toBe("密码：reasoning-secret-1");
    const call = (messages[2]?.["tool_calls"] as Record<string, unknown>[])[0];
    expect(call?.["id"]).toBe("call_1234567890123456789");
    expect((call?.["function"] as Record<string, unknown>)["name"]).toBe("bash");
    expect(messages[3]?.["tool_call_id"]).toBe("call_1234567890123456789");
    expect(sent["tools"]).toEqual(original.tools);
    expect(JSON.stringify(messages[4])).toContain("data:image/png;base64,AAAA4111111111111111");
  });

  it("masks text that only starts with data: and keeps real base64 data URLs", async () => {
    const AWS_LIKE = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const image = "data:image/png;base64,AAAA4111111111111111";
    const { raw } = await send("/chat/completions", {
      model: "m",
      messages: [
        { role: "tool", tool_call_id: "c", content: `data: token sk-${"a".repeat(24)}` },
        { role: "user", content: `data:text/plain,password=hunter22abc` },
        { role: "user", content: "data:text/plain;base64,password=hunter22abc" },
        { role: "user", content: `data:image/png;base64,${AWS_LIKE}` },
        { role: "user", content: image },
      ],
    });
    expect(raw).not.toContain("a".repeat(24));
    expect(raw).not.toContain("hunter22abc");
    expect(raw).not.toContain(AWS_LIKE);
    expect(raw).toContain(image);
  });

  it("masks a secret that sits in the very first history message", async () => {
    const { raw } = await send("/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: `密码：${PASSWORD}` },
        { role: "assistant", content: "好的" },
        { role: "user", content: "继续" },
      ],
    });
    expect(raw).not.toContain(PASSWORD);
  });

  it("sends the original bytes and keeps content-length when nothing needs masking", async () => {
    const clean = { model: "m", messages: [{ role: "user", content: "你好" }] };
    const { init } = await send("/chat/completions", clean);
    expect(init?.body).toBe(JSON.stringify(clean));
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "content-length": "999",
    });
  });

  it("drops content-length when the body changed", async () => {
    const { init } = await send("/chat/completions", body());
    expect(init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("keeps earlier messages byte-identical when a later message is appended", async () => {
    const history = body().messages;
    const turnOne = await send("/chat/completions", { model: "m", messages: history });
    const turnTwo = await send("/chat/completions", {
      model: "m",
      messages: [...history, { role: "user", content: "谢谢，密码：abc123xyz" }],
    });
    const one = turnOne.sent["messages"] as unknown[];
    const two = turnTwo.sent["messages"] as unknown[];
    expect(JSON.stringify(two.slice(0, one.length))).toBe(JSON.stringify(one));
  });

  it("keeps an old conversation's history byte-identical under ruleset 1 and masks the looser form from ruleset 2", async () => {
    const history = [
      { role: "user", content: "家里 Wi-Fi 密码 abc12345，记一下" },
      { role: "assistant", content: "好的" },
    ];
    const next = [...history, { role: "user", content: "谢谢" }];
    const old = (messages: unknown[]) =>
      send(
        "/chat/completions",
        { model: "m", messages },
        {
          exchange: egress().exchange({
            ownerId: "owner-1",
            agentId: "agent-1",
            threadId: "thread-1",
            source: "chat",
            purpose: "chat",
            redactionRuleset: 1,
          } as unknown as ModelEgressContext),
        },
      );
    const turnOne = await old(history);
    const turnTwo = await old(next);
    expect(JSON.stringify(turnOne.sent["messages"])).toContain("abc12345");
    const sentOne = turnOne.sent["messages"] as unknown[];
    expect(JSON.stringify((turnTwo.sent["messages"] as unknown[]).slice(0, sentOne.length))).toBe(
      JSON.stringify(sentOne),
    );
    expect(JSON.stringify(turnOne.sent["messages"])).toBe(JSON.stringify(history));
    const fresh = await send("/chat/completions", { model: "m", messages: history });
    expect(fresh.raw).not.toContain("abc12345");
  });

  it("[I-129] masks card and identity numbers only for a conversation still on ruleset 2, and sends them as they are from ruleset 3", async () => {
    const messages = [
      { role: "user", content: "卡号 4111 1111 1111 1111，身份证 11010519491231002X" },
    ];
    const onRuleset = (redactionRuleset: number) =>
      send(
        "/chat/completions",
        { model: "m", messages },
        {
          exchange: egress().exchange({
            ownerId: "owner-1",
            agentId: "agent-1",
            threadId: "thread-1",
            source: "chat",
            purpose: "chat",
            redactionRuleset,
          } as unknown as ModelEgressContext),
        },
      );
    const older = await onRuleset(2);
    expect(older.raw).not.toContain("4111 1111 1111 1111");
    expect(older.raw).not.toContain("11010519491231002X");
    const current = await send("/chat/completions", { model: "m", messages });
    expect(JSON.stringify(current.sent["messages"])).toBe(JSON.stringify(messages));
  });

  it("gives the same placeholder to the same value across calls and keys", async () => {
    const a = await send("/chat/completions", body());
    const b = await send("/chat/completions", body());
    expect(a.raw).toBe(b.raw);
    const other = new ModelEgress({ key: async () => new Uint8Array([9, 9]), sign });
    const c = await send("/chat/completions", body(), { exchange: other.exchange() });
    expect(c.raw).not.toBe(a.raw);
  });

  it("masks a later plain mention of a value that was masked earlier in the same request", async () => {
    const { raw } = await send("/chat/completions", {
      model: "m",
      messages: [
        { role: "user", content: "我的密码：hunter22abc" },
        { role: "assistant", content: "收到，hunter22abc 已经记下" },
      ],
    });
    expect(raw).not.toContain("hunter22abc");
  });

  it("masks sensitive values in positions nobody listed, such as new fields and unknown part types", async () => {
    const { raw } = await send("/chat/completions", {
      model: "m",
      metadata: { note: `密码：${PASSWORD}` },
      messages: [
        { role: "oracle", content: "验证码 482910", extra: { deep: [`密码：hunter22abc`] } },
        { role: "user", content: [{ type: "hologram", text: `密码：${PASSWORD}` }] },
      ],
    });
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("482910");
    expect(raw).not.toContain("hunter22abc");
  });

  it("leaves identifiers alone even when they look like card numbers", async () => {
    const lookalike = "call_4111111111111111";
    const { sent } = await send("/chat/completions", {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: lookalike, type: "function", function: { name: "n", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: lookalike, content: "ok" },
      ],
    });
    const messages = sent["messages"] as Record<string, unknown>[];
    expect((messages[0]?.["tool_calls"] as { id: string }[])[0]?.id).toBe(lookalike);
    expect(messages[1]?.["tool_call_id"]).toBe(lookalike);
  });

  it("masks a value inside tool arguments even when its key is named like a protected one", async () => {
    const { raw } = await send("/chat/completions", {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "n",
                arguments: JSON.stringify({
                  id: `密码：${PASSWORD}`,
                  name: "密码：hunter22abc",
                  type: "验证码 482910",
                }),
              },
            },
          ],
        },
      ],
    });
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("hunter22abc");
    expect(raw).not.toContain("482910");
  });

  it("refuses a request that has no conversation", async () => {
    await expect(send("/chat/completions", { model: "m" })).rejects.toBeInstanceOf(
      ModelEgressRefusedError,
    );
  });

  it("counts findings by kind without keeping values", async () => {
    const { exchange } = await send("/chat/completions", body());
    expect(exchange.findings().map(({ kind }) => kind)).toContain("password");
    expect(JSON.stringify(exchange.findings())).not.toContain(PASSWORD);
  });
});

describe("responses", () => {
  it("masks instructions, messages, function calls and outputs; keeps reasoning", async () => {
    const { sent, raw } = await send("/responses", {
      model: "m",
      instructions: "密码：sys-secret-1",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `密码：${PASSWORD}` }],
        },
        { type: "reasoning", id: "rs_1", encrypted_content: `密码：keep-this-1` },
        { type: "function_call", call_id: "c1", name: "x", arguments: '{"a":"验证码 482910"}' },
        { type: "function_call_output", call_id: "c1", output: "验证码 482910" },
      ],
    });
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("sys-secret-1");
    expect(raw).not.toContain("482910");
    const input = sent["input"] as Record<string, unknown>[];
    expect(input[1]?.["encrypted_content"]).toBe("密码：keep-this-1");
  });

  it("refuses a responses request without input", async () => {
    await expect(send("/responses", { model: "m" })).rejects.toBeInstanceOf(
      ModelEgressRefusedError,
    );
  });
});

describe("anthropic messages", () => {
  it("masks system, text, tool_use input and tool_result; keeps thinking and its signature", async () => {
    const { sent, raw } = await send("/messages", {
      model: "m",
      system: [{ type: "text", text: "密码：sys-secret-1" }],
      messages: [
        { role: "user", content: `密码：${PASSWORD}` },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "密码：think-keep-1", signature: "Ev8x9kQ2" },
            { type: "tool_use", id: "tu1", name: "bash", input: { c: "验证码 482910" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: [{ type: "text", text: "验证码 482910" }],
            },
          ],
        },
      ],
    });
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("sys-secret-1");
    expect(raw).not.toContain("482910");
    const messages = sent["messages"] as { content: Record<string, unknown>[] }[];
    expect(messages[1]?.content[0]).toEqual({
      type: "thinking",
      thinking: "密码：think-keep-1",
      signature: "Ev8x9kQ2",
    });
    expect(messages[1]?.content[1]?.["id"]).toBe("tu1");
  });
});

describe("embeddings", () => {
  it("masks a string input and a list of strings", async () => {
    const one = await send("/embeddings", { model: "m", input: `密码：${PASSWORD}` });
    expect(one.raw).not.toContain(PASSWORD);
    const many = await send("/embeddings", { model: "m", input: [`密码：${PASSWORD}`, "你好"] });
    expect(many.raw).not.toContain(PASSWORD);
    expect((many.sent["input"] as string[])[1]).toBe("你好");
  });

  it("refuses token-id arrays because they cannot be inspected", async () => {
    await expect(send("/embeddings", { model: "m", input: [1, 2, 3] })).rejects.toBeInstanceOf(
      ModelEgressRefusedError,
    );
    await expect(send("/embeddings", { model: "m", input: [[1, 2]] })).rejects.toBeInstanceOf(
      ModelEgressRefusedError,
    );
  });
});

describe("what is not sent", () => {
  it("refuses a body sent to an unknown path", async () => {
    await expect(send("/audio/speech", { input: `密码：${PASSWORD}` })).rejects.toBeInstanceOf(
      ModelEgressRefusedError,
    );
  });

  it("refuses a body that is not text or not JSON, and a request object with its own body", async () => {
    const exchange = egress().exchange();
    const { base, calls } = recorder();
    const fetch = exchange.wrapFetch(base);
    await expect(
      fetch("https://gateway.invalid/v1/chat/completions", {
        method: "POST",
        body: new Uint8Array(3),
      }),
    ).rejects.toBeInstanceOf(ModelEgressRefusedError);
    await expect(
      fetch("https://gateway.invalid/v1/chat/completions", { method: "POST", body: "not json" }),
    ).rejects.toBeInstanceOf(ModelEgressRefusedError);
    await expect(
      (fetch as unknown as (input: unknown, init?: unknown) => Promise<unknown>)({
        url: "https://gateway.invalid/v1/chat/completions",
        body: "x",
      }),
    ).rejects.toBeInstanceOf(ModelEgressRefusedError);
    expect(calls).toEqual([]);
  });

  it("passes requests without a body through untouched", async () => {
    const exchange = egress().exchange();
    const { base, calls } = recorder();
    await exchange.wrapFetch(base)("https://gateway.invalid/v1/generation?id=1", { method: "GET" });
    expect(calls).toHaveLength(1);
  });
});

describe("putting values back", () => {
  it("restores placeholders from this request and leaves unknown ones alone", async () => {
    const { exchange, raw } = await send("/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: `密码：${PASSWORD}，密码：hunter22abc` }],
    });
    const placeholders = [
      ...raw.matchAll(/\[(?:密码|验证码|证件号|银行卡 尾号\d{4})#[a-z]{8}\]/gu),
    ].map((match) => match[0]);
    expect(placeholders).toHaveLength(2);
    const reply = `你的卡是 ${placeholders[0]}，另一个 [密码#zzzzzzzz] 不认识`;
    const restored = exchange.restore(reply);
    expect(restored).toContain(PASSWORD);
    expect(restored).toContain("[密码#zzzzzzzz]");
  });

  it("never restores a machine secret", async () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    const { exchange, raw } = await send("/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: `key ${secret}` }],
    });
    expect(raw).toContain("[密钥]");
    expect(exchange.restore("[密钥]")).toBe("[密钥]");
    expect(exchange.table.size).toBe(0);
  });

  it("restores a placeholder that arrives split across chunks and holds nothing back at the end", async () => {
    const { exchange, raw } = await send("/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "密码：hunter22abc" }],
    });
    const placeholder =
      [...raw.matchAll(/\[(?:密码|验证码|证件号|银行卡 尾号\d{4})#[a-z]{8}\]/gu)][0]?.[0] ?? "";
    const text = `好的，${placeholder}，已经记下 [不是占位符] 结束`;
    for (let cut = 1; cut < text.length; cut += 1) {
      const restorer = exchange.streamingRestorer();
      const out =
        restorer.append(text.slice(0, cut)) + restorer.append(text.slice(cut)) + restorer.flush();
      expect(out).toBe("好的，hunter22abc，已经记下 [不是占位符] 结束");
    }
  });

  it("flushes an unfinished bracket as-is when the stream ends", () => {
    const restorer = egress().exchange().streamingRestorer();
    expect(restorer.append("看这里 [密码#abc")).toBe("看这里 ");
    expect(restorer.flush()).toBe("[密码#abc");
  });
});

describe("reporting what was masked", () => {
  const context = {
    ownerId: "owner-1",
    agentId: "agent-1",
    threadId: "thread-1",
    source: "chat",
    purpose: "chat",
  } as unknown as ModelEgressContext;

  function reporting(fail = false) {
    const reports: { context: ModelEgressContext; sightings: readonly ModelEgressSighting[] }[] =
      [];
    const instance = new ModelEgress({
      key: async () => key,
      sign,
      report: (seenContext, sightings) => {
        if (fail) throw new Error("recorder failed");
        reports.push({ context: seenContext, sightings });
      },
    });
    return { reports, instance };
  }

  const chat = {
    model: "m",
    messages: [
      { role: "system", content: "密码：sys9pass99" },
      { role: "user", content: `密码：${PASSWORD}，再说一次密码：${PASSWORD}` },
      {
        role: "assistant",
        content: "好的",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: '{"q":"验证码 482910"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "身份证 11010519491231002X" },
    ],
  };

  it("names the part of the request each masked value was in, once per request", async () => {
    const { reports, instance } = reporting();
    const { raw } = await send("/chat/completions", chat, { exchange: instance.exchange(context) });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.context).toBe(context);
    expect(
      reports[0]?.sightings.map(({ part, category, ruleId }) => `${part}/${category}/${ruleId}`),
    ).toEqual([
      "system/password/password-keyword",
      "owner_message/password/password-keyword",
      "tool_call/verification-code/verification-code-keyword",
    ]);
    expect(raw).toContain("身份证 11010519491231002X");
    const serialized = JSON.stringify(reports);
    for (const value of ["sys9pass99", PASSWORD, "482910"]) {
      expect(serialized).not.toContain(value);
      expect(raw).not.toContain(value);
    }
    for (const { fingerprint } of reports[0]?.sightings ?? [])
      expect(fingerprint).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("records every value as withheld when the self-check refuses to send the request", async () => {
    const reports: (readonly ModelEgressSighting[])[] = [];
    const leaked = `固定说明里不该有的 token sk-${"a".repeat(24)} 结尾`;
    const instance = new ModelEgress({
      key: async () => key,
      sign,
      trusted: [leaked],
      report: (_context, sightings) => reports.push(sightings),
    });
    await expect(
      send(
        "/chat/completions",
        {
          model: "m",
          messages: [{ role: "user", content: `密码：${PASSWORD}\n${leaked}` }],
        },
        { exchange: instance.exchange(context) },
      ),
    ).rejects.toThrow(ModelEgressRefusedError);
    expect(reports).toHaveLength(1);
    expect(
      reports[0]?.map(({ part, category, ruleId, outcome }) =>
        [part, category, ruleId, outcome].join("/"),
      ),
    ).toEqual([
      "owner_message/password/password-keyword/withheld",
      "owner_message/machine-secret/openai-api-key/withheld",
    ]);
    expect(JSON.stringify(reports)).not.toContain("a".repeat(24));
  });

  it("[RETRY-429] a refused request that is sent again is refused again without a second withheld report", async () => {
    const reports: (readonly ModelEgressSighting[])[] = [];
    const leaked = `固定说明里不该有的 token sk-${"b".repeat(24)} 结尾`;
    const instance = new ModelEgress({
      key: async () => key,
      sign,
      trusted: [leaked],
      report: (_context, sightings) => reports.push(sightings),
    });
    const { calls, base } = recorder();
    const fetch = instance.exchange(context).wrapFetch(base);
    const call = () =>
      fetch("https://gateway.invalid/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: `密码：${PASSWORD}\n${leaked}` }],
        }),
      });
    const first = await call().catch((error: unknown) => error);
    const second = await call().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ModelEgressRefusedError);
    expect(second).toBe(first);
    expect(calls).toHaveLength(0);
    expect(reports).toHaveLength(1);
  });

  it("REVERSE [RETRY-429] the resend memory is not used for a different body or for a request object carrying its own body", async () => {
    const { calls, base } = recorder();
    const fetch = egress().exchange(context).wrapFetch(base);
    const url = "https://gateway.invalid/v1/chat/completions";
    const post = (input: unknown, body: string) => fetch(input as string, { method: "POST", body });
    const good = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    await post(url, good);
    await expect(post({ href: url, body: good }, good)).rejects.toThrow(ModelEgressRefusedError);
    await expect(post(url, "not json")).rejects.toThrow(ModelEgressRefusedError);
    await post(url, good);
    expect(calls).toHaveLength(2);
  });

  it("masks and records part of a private key", async () => {
    const { reports, instance } = reporting();
    const marker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const fragment = [marker, `MIIE${"Qk".repeat(30)}`, `MIIF${"Qk".repeat(30)}`].join("\n");
    const { raw } = await send(
      "/chat/completions",
      { model: "m", messages: [{ role: "user", content: `看一下\n${fragment}` }] },
      { exchange: instance.exchange(context) },
    );
    expect(raw).not.toContain("Qk".repeat(30));
    expect(raw).toContain("[密钥]");
    expect(
      reports[0]?.sightings.map(({ part, category, ruleId }) => `${part}/${category}/${ruleId}`),
    ).toEqual(["owner_message/machine-secret/private-key-block"]);
  });

  it("sends the same bytes whether or not anything is recorded, and even when recording fails", async () => {
    const plain = await send("/chat/completions", chat);
    const recorded = await send("/chat/completions", chat, {
      exchange: reporting().instance.exchange(context),
    });
    const failing = await send("/chat/completions", chat, {
      exchange: reporting(true).instance.exchange(context),
    });
    expect(recorded.raw).toBe(plain.raw);
    expect(failing.raw).toBe(plain.raw);
  });

  it("gives the same value the same fingerprint in every request", async () => {
    const { reports, instance } = reporting();
    await send("/chat/completions", chat, { exchange: instance.exchange(context) });
    await send("/chat/completions", chat, { exchange: instance.exchange(context) });
    expect(reports[1]?.sightings).toEqual(reports[0]?.sightings);
  });

  it("reports a value named once and repeated later in the same part as one sighting", async () => {
    const { reports, instance } = reporting();
    await send(
      "/chat/completions",
      {
        model: "m",
        messages: [
          { role: "user", content: "密码：hunter22abc" },
          { role: "assistant", content: "好的" },
          { role: "user", content: "再说一次，hunter22abc 别忘了" },
        ],
      },
      { exchange: instance.exchange(context) },
    );
    expect(reports[0]?.sightings).toHaveLength(1);
    expect(reports[0]?.sightings[0]).toMatchObject({
      part: "owner_message",
      category: "password",
      ruleId: "password-keyword",
    });
  });

  it("[RETRY-429] resends the same bytes and reports once when the identical request is sent again", async () => {
    const { reports, instance } = reporting();
    const { calls, base } = recorder();
    const fetch = instance.exchange(context).wrapFetch(base);
    const request = {
      model: "m",
      messages: [
        { role: "user", content: "先记一下 hunter22abc" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "密码：hunter22abc" },
      ],
    };
    const call = () =>
      fetch("https://gateway.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "999" },
        body: JSON.stringify(request),
      });
    await call();
    await call();
    await call();
    expect(calls).toHaveLength(3);
    expect(String(calls[1]?.[1]?.body)).toBe(String(calls[0]?.[1]?.body));
    expect(String(calls[2]?.[1]?.body)).toBe(String(calls[0]?.[1]?.body));
    expect(String(calls[0]?.[1]?.body)).toContain("先记一下 hunter22abc");
    expect(reports).toHaveLength(1);
  });

  it("REVERSE [RETRY-429] masks a different request on its own, so a changed body is never served from the resend memory", async () => {
    const { reports, instance } = reporting();
    const { calls, base } = recorder();
    const fetch = instance.exchange(context).wrapFetch(base);
    const send2 = (text: string) =>
      fetch("https://gateway.invalid/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: text }] }),
      });
    await send2("密码：hunter22abc");
    await send2("密码：other77pass9");
    expect(String(calls[1]?.[1]?.body)).not.toContain("other77pass9");
    expect(String(calls[1]?.[1]?.body)).not.toBe(String(calls[0]?.[1]?.body));
    expect(reports).toHaveLength(2);
  });

  it("reports nothing without a context or when nothing was masked", async () => {
    const { reports, instance } = reporting();
    await send("/chat/completions", chat, { exchange: instance.exchange() });
    await send(
      "/chat/completions",
      { model: "m", messages: [{ role: "user", content: "你好" }] },
      { exchange: instance.exchange(context) },
    );
    expect(reports).toEqual([]);
  });

  it("names anthropic, responses and embeddings parts", async () => {
    const { reports, instance } = reporting();
    await send(
      "/messages",
      {
        model: "m",
        system: "密码：sys9pass99",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t", name: "f", input: { q: "密码：tool9pass9" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t", content: `密码：${PASSWORD}` }],
          },
        ],
      },
      { exchange: instance.exchange(context) },
    );
    await send(
      "/responses",
      {
        model: "m",
        instructions: "密码：sys9pass99",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "验证码 482910" }],
          },
          { type: "function_call", call_id: "x", name: "f", arguments: '{"p":"密码：call9pass9"}' },
          { type: "function_call_output", call_id: "x", output: `密码：${PASSWORD}` },
        ],
      },
      { exchange: instance.exchange(context) },
    );
    await send(
      "/embeddings",
      { model: "e", input: ["验证码 482910"] },
      { exchange: instance.exchange({ ...context, source: "embedding", threadId: null }) },
    );
    expect(reports.map(({ sightings }) => sightings.map(({ part }) => part))).toEqual([
      ["system", "tool_call", "tool_result"],
      ["system", "owner_message", "tool_call", "tool_result"],
      ["embedding_input"],
    ]);
  });

  it("fingerprints values masked elsewhere the same way as in a request, once per value", async () => {
    const { reports, instance } = reporting();
    await send(
      "/chat/completions",
      { model: "m", messages: [{ role: "user", content: "验证码 482910" }] },
      { exchange: instance.exchange(context) },
    );
    const mailContext = { ...context, source: "mail", threadId: null } as ModelEgressContext;
    const sighting = {
      kind: "verification-code",
      ruleId: "verification-code-keyword",
      value: "482910",
    } as const;
    await instance.reportMasked(mailContext, "mail", [sighting, sighting]);
    await reporting(true).instance.reportMasked(mailContext, "mail", [sighting]);
    expect(reports[1]?.context).toBe(mailContext);
    expect(reports[1]?.sightings).toEqual([{ ...reports[0]?.sightings[0], part: "mail" }]);
    expect(JSON.stringify(reports[1])).not.toContain("482910");
  });
});

describe("[mask-not-block] external services", () => {
  it("numbers a value sent to an external service the same way as in a model request", async () => {
    const { sent } = await send("/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "password: hunter2abc" }],
    });
    const modelText = (sent["messages"] as { content: string }[])[0]?.content ?? "";
    const tag = await egress().externalTag();
    expect(`password: [密码#${tag("password", "hunter2abc")}]`).toBe(modelText);
    expect(tag("password", "hunter2abc")).not.toBe(tag("password", "other9xyz"));
  });
});
