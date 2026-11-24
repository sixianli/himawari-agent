import { describe, expect, it } from "vitest";
import { herWordsPushKey, pushClassOf } from "../src/services/web-push-gate.js";

describe("[SAID-4] her words push key", () => {
  it("gives the same key for the same event every time and a key the push gate recognises", async () => {
    const source = { kind: "mail", id: "gmail:msg-1", version: "3" };
    const first = await herWordsPushKey({ messageId: "m-1", source });
    expect(first).toBe("said:4:mail11:gmail:msg-11:3");
    expect(await herWordsPushKey({ messageId: "m-2", source })).toBe(first);
    expect(pushClassOf({ kind: "reminder", sourceKey: first })).toBe("her_words");
  });

  it("keys words she chose to say on her own by her message", async () => {
    expect(await herWordsPushKey({ messageId: "assistant:abc" })).toBe(
      "said:7:message13:assistant:abc1:1",
    );
  });

  it("REVERSE: two different events whose parts share a separator never share a key", async () => {
    const left = await herWordsPushKey({
      messageId: "m",
      source: { kind: "mail", id: "a1:b", version: "1" },
    });
    const right = await herWordsPushKey({
      messageId: "m",
      source: { kind: "mail", id: "a", version: "1:b1:1" },
    });
    expect(left).not.toBe(right);
  });

  it("stays within the push table's 256 characters, still the same for the same event and different for another", async () => {
    const long = (id: string) =>
      herWordsPushKey({ messageId: "m", source: { kind: "mail", id, version: "v".repeat(256) } });
    const one = await long("x".repeat(256));
    expect(one.length).toBeLessThanOrEqual(256);
    expect(one.startsWith("said:")).toBe(true);
    expect(await long("x".repeat(256))).toBe(one);
    expect(await long(`${"x".repeat(255)}y`)).not.toBe(one);
    expect(pushClassOf({ kind: "reminder", sourceKey: one })).toBe("her_words");
  });

  it("REVERSE: refuses an empty part instead of writing an ambiguous key", async () => {
    await expect(
      herWordsPushKey({ messageId: "m", source: { kind: "mail", id: "", version: "1" } }),
    ).rejects.toThrow("HER_WORDS_PUSH_SOURCE_EMPTY");
  });
});
