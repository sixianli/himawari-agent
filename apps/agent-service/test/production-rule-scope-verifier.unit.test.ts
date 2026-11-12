import type { ProactiveModelInvoker } from "@himawari-agent/application";
import { RULE_SCOPE_VERIFY } from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import {
  createRuleScopeVerifier,
  ruleScopePrompt,
  ruleScopeWiring,
} from "../src/production-rule-scope-verifier.js";

const NOW = "2026-11-12T00:00:00.000Z";
const INPUT = {
  quote: "夜里别提醒我",
  context: "好的。夜里别提醒我，谢谢",
  now: NOW,
  timeZone: "Asia/Tokyo",
};

function invoker(events: readonly Record<string, unknown>[], outputs: Record<string, string>) {
  const released: string[] = [];
  const prepared: string[] = [];
  const value = {
    modelRef: "scope-model",
    model: {
      async *invoke(request: { invocationId: string }) {
        for (const event of events) yield { invocationId: request.invocationId, ...event };
      },
    },
    async prepare(input: { prompt: string }) {
      prepared.push(input.prompt);
      return {
        runId: "run-1",
        inputRef: "input",
        allowedDisclosureRef: "input",
        secretHandleRefs: [],
        release: async () => {
          released.push("done");
        },
      };
    },
    readOutput: async (ref: string) => outputs[ref] ?? "",
    release: async () => undefined,
  } as unknown as ProactiveModelInvoker;
  return { value, released, prepared };
}

const ids = { next: (namespace: string) => `${namespace}:1` };
const clock = { now: () => NOW };
const output = (text: string) => [
  { type: "model.output", payloadRef: "out" },
  { type: "model.completed", costMicros: 1, outputTokens: 5 },
  { text },
];

describe("[RS-1] rule scope verifier", () => {
  it("puts the fixed instruction first and the changing local time last", () => {
    const prompt = ruleScopePrompt("model", INPUT);
    expect(prompt.startsWith(RULE_SCOPE_VERIFY.text)).toBe(true);
    expect(prompt.endsWith("（Asia/Tokyo）")).toBe(true);
    expect(prompt).toContain("2026-11-12T09:00");
    expect(JSON.parse(ruleScopePrompt("jev", INPUT))).toMatchObject({
      schemaVersion: "rule-scope-input.v1",
      quote: INPUT.quote,
    });
  });

  it("returns the verdict the model gave, and releases the authority", async () => {
    const answer = '{"scope":"standing","until":null,"evidence":"夜里"}';
    const fake = invoker(output(answer).slice(0, 2), { out: answer });
    const verifier = createRuleScopeVerifier({
      kind: "model",
      invoker: fake.value,
      ids,
      clock,
      timeoutMs: 5_000,
    });
    expect(await verifier.verify(INPUT)).toEqual({
      scope: "standing",
      until: null,
      evidence: "夜里",
    });
    expect(fake.released).toEqual(["done"]);
    expect(fake.prepared[0]).toContain("夜里别提醒我");
  });

  it("treats a failed call, plain text, a missing or invented evidence and a cut-off answer as no verdict", async () => {
    const cases: [string, readonly Record<string, unknown>[], string][] = [
      ["failed", [{ type: "model.failed", errorCode: "X", retryable: false }], ""],
      ["plain text", output("好的").slice(0, 2), "好的"],
      ["no evidence", output("").slice(0, 2), '{"scope":"standing","until":null,"evidence":null}'],
      [
        "invented evidence",
        output("").slice(0, 2),
        '{"scope":"standing","until":null,"evidence":"以后永远"}',
      ],
      ["cut off", [{ type: "model.output", payloadRef: "out" }], '{"scope":"standing"'],
    ];
    for (const [name, events, text] of cases) {
      const failures: string[] = [];
      const verifier = createRuleScopeVerifier({
        kind: "model",
        invoker: invoker(events, { out: text }).value,
        ids,
        clock,
        timeoutMs: 5_000,
        onFailure: (code) => failures.push(code),
      });
      expect(await verifier.verify(INPUT), name).toBeUndefined();
    }
  });

  it("accepts a Jev answer without evidence but still rejects a malformed one", async () => {
    const good = '{"scope":"until","until":null,"evidence":null}';
    const verifier = createRuleScopeVerifier({
      kind: "jev",
      invoker: invoker(output(good).slice(0, 2), { out: good }).value,
      ids,
      clock,
      timeoutMs: 5_000,
    });
    expect(await verifier.verify(INPUT)).toEqual({ scope: "until", until: null, evidence: null });
    const bad = createRuleScopeVerifier({
      kind: "jev",
      invoker: invoker(output("x").slice(0, 2), { out: '{"scope":"forever"}' }).value,
      ids,
      clock,
      timeoutMs: 5_000,
    });
    expect(await bad.verify(INPUT)).toBeUndefined();
  });

  it("wires nothing when off, and a verifier that never confirms when the model cannot be built", async () => {
    const composition = {
      proactiveModel: () => {
        throw new Error("PROACTIVE_MODEL_DISCLOSURE_DENIED");
      },
    };
    const failures: string[] = [];
    const base = { composition, ids, clock, onFailure: (code: string) => failures.push(code) };
    expect(ruleScopeWiring({ ...base, configuration: undefined })).toEqual({ maxDays: 366 });
    expect(
      ruleScopeWiring({
        ...base,
        configuration: { verifier: "off", jevThreshold: 0.85, timeoutMs: 10_000, maxDays: 30 },
      }),
    ).toEqual({ maxDays: 30 });
    const wired = ruleScopeWiring({
      ...base,
      configuration: {
        verifier: "model",
        modelRef: "scope-model",
        jevThreshold: 0.85,
        timeoutMs: 10_000,
        maxDays: 30,
      },
    });
    expect(await wired.verifier?.verify(INPUT)).toBeUndefined();
    expect(failures).toEqual(["PROACTIVE_MODEL_DISCLOSURE_DENIED"]);
  });
});
