import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { compareToolMessage } from "../../scripts/operations/hermes-e2e-tool-flow-diagnostic.mjs";
import {
  contentText,
  policyFlags,
  summarize,
} from "../../scripts/operations/hermes-e2e-context-policy-diagnostic.mjs";

for (const name of [
  "hermes-e2e-language-diagnostic",
  "hermes-e2e-context-policy-diagnostic",
  "hermes-e2e-tool-flow-diagnostic",
]) {
  test(`${name} direct CLI reaches authorization guard instead of silently exiting`, () => {
    const path = fileURLToPath(new URL(`../../scripts/operations/${name}.mjs`, import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", "data:text/javascript,process.getuid=()=>12345", path],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
    assert.match(result.stderr, /12345 !== 0/);
    assert.doesNotMatch(result.stdout, /Diagnostic written/);
  });
}

test("diagnostic exposes conflicting language flags without exporting unrelated text", () => {
  const value =
    "你是 Himawari，使用简体中文帮助用户。Write user-facing answers in English. PRIVATE_SENTINEL";
  assert.deepEqual(policyFlags(value), {
    chineseDirective: true,
    englishDirective: true,
    japaneseDirective: false,
  });
  assert.equal(JSON.stringify(summarize(value)).includes("PRIVATE_SENTINEL"), false);
  assert.equal(policyFlags("网页提到了中文课程").chineseDirective, false);
});

test("tool-flow comparison requires both the current call identity and exact tool text", () => {
  const content = summarize("current result");
  const message = { toolCallId: "call-current", ...content };
  const result = { toolCallId: "call-current", content };
  assert.equal(compareToolMessage(message, [result], "now").matchesRecordedContent, true);
  assert.equal(
    compareToolMessage(message, [{ ...result, toolCallId: "call-old" }], "now")
      .matchesRecordedContent,
    false,
  );
  assert.equal(
    compareToolMessage(message, [{ ...result, content: summarize("old result") }], "now")
      .matchesRecordedContent,
    false,
  );
});

test("tool text digests compare block content with provider text without exporting either", () => {
  const blocks = [
    { type: "text", text: "one" },
    { type: "text", text: "two" },
  ];
  assert.equal(contentText(blocks), "one\ntwo");
  assert.equal(summarize(blocks).textSha256, summarize("one\ntwo").textSha256);
  assert.notEqual(summarize(blocks).textSha256, summarize("old result").textSha256);
});
