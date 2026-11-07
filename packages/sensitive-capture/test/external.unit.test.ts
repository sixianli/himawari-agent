import { describe, expect, it } from "vitest";
import {
  isSensitiveUrlParameter,
  redactForExternalText,
  redactForExternalUrl,
} from "../src/index.js";

const tag = (kind: string, value: string) => {
  let hash = 0;
  for (const character of `${kind}\u0000${value}`)
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  let out = "";
  for (let index = 0; index < 8; index += 1) {
    out += String.fromCharCode(97 + (hash % 26));
    hash = Math.floor(hash / 26) + index * 7;
  }
  return out;
};

const token = ["ghp", "_", "C".repeat(30)].join("");

describe("isSensitiveUrlParameter", () => {
  it.each([
    "token",
    "access_token",
    "api-key",
    "KEY",
    "sig",
    "signature",
    "password",
    "X-Amz-Signature",
    "X-Amz-Credential",
    "x-goog-signature",
    "client%5Fsecret",
  ])("matches the whole parameter name %s", (name) => {
    expect(isSensitiveUrlParameter(name)).toBe(true);
  });

  it.each(["monkey", "keyboard", "tokenizer", "signal", "q", "page", "design"])(
    "does not match %s by a fragment of its name",
    (name) => {
      expect(isSensitiveUrlParameter(name)).toBe(false);
    },
  );
});

describe("redactForExternalText", () => {
  it("masks secrets with numbered placeholders and leaves ordinary text unchanged", () => {
    const first = redactForExternalText(`password: hunter2abc ${token}`, { tag });
    expect(first.text).toMatch(/^password: \[密码#[a-z]{8}\] \[密钥\]$/u);
    expect(redactForExternalText(`password: hunter2abc ${token}`, { tag }).text).toBe(first.text);
    expect(redactForExternalText("password: other9xyz", { tag }).text).not.toBe(
      first.text.replace(" [密钥]", ""),
    );
    expect(redactForExternalText("Tokyo weather tomorrow", { tag }).text).toBe(
      "Tokyo weather tomorrow",
    );
  });

  it("leaves text it already masked unchanged", () => {
    const once = redactForExternalText(`password: hunter2abc ${token}`, { tag }).text;
    expect(redactForExternalText(once, { tag }).text).toBe(once);
    expect(redactForExternalText(once).text).toBe(once);
  });
});

describe("redactForExternalUrl", () => {
  it("removes user info from the address", () => {
    const result = redactForExternalUrl("https://user:pw@example.org/a?b=1", { tag });
    expect(result.text).toBe("https://example.org/a?b=1");
    expect(result.findings).toEqual([{ kind: "password", count: 1 }]);
  });

  it("masks sensitive parameters by their whole name and keeps the others byte for byte", () => {
    const result = redactForExternalUrl(
      "https://example.org/a?monkey=1&sig=abc123&q=hello+world&X-Amz-Signature=deadbeef#top",
      { tag },
    );
    expect(result.text).toMatch(
      /^https:\/\/example\.org\/a\?monkey=1&sig=%5B%E5%AF%86%E7%A0%81%23[a-z]{8}%5D&q=hello\+world&X-Amz-Signature=%5B%E5%AF%86%E7%A0%81%23[a-z]{8}%5D#top$/u,
    );
    expect(result.findings).toEqual([{ kind: "password", count: 2 }]);
  });

  it("gives different values different placeholders and the same value the same one", () => {
    const one = redactForExternalUrl("https://example.org/?token=first-value", { tag }).text;
    const two = redactForExternalUrl("https://example.org/?token=second-value", { tag }).text;
    expect(one).not.toBe(two);
    expect(redactForExternalUrl("https://example.org/?token=first-value", { tag }).text).toBe(one);
  });

  it("masks secrets in the path and percent-encodes the placeholder", () => {
    expect(redactForExternalUrl(`https://example.org/${token}/x`, { tag }).text).toBe(
      "https://example.org/%5B%E5%AF%86%E9%92%A5%5D/x",
    );
  });

  it("returns an ordinary address unchanged", () => {
    const url = "https://example.org/news/2026/11/07?page=2&lang=ja#section-3";
    expect(redactForExternalUrl(url, { tag })).toEqual({ text: url, findings: [] });
  });

  it("leaves an address it already masked unchanged, with or without the numbering key", () => {
    for (const url of [
      "https://user:pw@example.org/a?sig=abc123&password=hunter2abc",
      `https://example.org/${token}?key=value123`,
    ]) {
      const once = redactForExternalUrl(url, { tag }).text;
      expect(redactForExternalUrl(once, { tag }).text).toBe(once);
      expect(redactForExternalUrl(once).text).toBe(once);
    }
  });

  it("encodes a placeholder the model copied into the address instead of reading it as a fragment", () => {
    expect(redactForExternalUrl("https://example.org/s?sig=[密码#abcdefgh]&b=2", { tag })).toEqual({
      text: "https://example.org/s?sig=%5B%E5%AF%86%E7%A0%81%23abcdefgh%5D&b=2",
      findings: [],
    });
  });
});
