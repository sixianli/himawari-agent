import { describe, expect, it } from "vitest";
import { fitPiResultOutput } from "../src/model-output-budget.js";

const source = {
  workspace: "/workspace",
  toolCallId: "call-budget",
  directoryGrantRef: "grant",
  directoryGrantRevision: 1,
  parameters: { path: "big.txt" },
};

function envelope(text: string, tool = "read"): string {
  return JSON.stringify({
    schemaVersion: "pi-result.v1",
    tool,
    content: [{ type: "text", text }],
    details: {},
    fullOutput: null,
    isError: false,
    commandExitCode: null,
    verifiedWrite: null,
    source,
  });
}

interface FittedEnvelope {
  content: { text: string }[];
  details: { truncation: Record<string, unknown> };
}

const manyLines = Array.from({ length: 5000 }, (_, index) => `line-${index}`).join("\n");

describe("[R2-T9] fitPiResultOutput", () => {
  it("[R2-T9] returns the envelope unchanged when it is within the budget", () => {
    const json = envelope("短内容");
    expect(fitPiResultOutput(json, 4096)).toBe(json);
  });

  it("drops the cut-off start of a token when one long line is cut in the middle", () => {
    const line = `${"x ".repeat(3000)}token=sk-${"a".repeat(40)} done`;
    const fitted = fitPiResultOutput(envelope(line, "bash"), 4096);
    const text = (JSON.parse(fitted ?? "{}") as FittedEnvelope).content[0]?.text ?? "";
    expect(text).toMatch(/^ /u);
    expect(text).not.toMatch(/^[A-Za-z0-9._~+/=-]/u);
  });

  it("[R2-T9] truncates the head of an over-limit result and adds Pi's limit notice", () => {
    const fitted = fitPiResultOutput(envelope(manyLines), 4096);
    expect(fitted).not.toBeNull();
    expect(fitted).toContain("limit reached");
    expect(Buffer.byteLength(fitted as string, "utf-8")).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(fitted as string) as FittedEnvelope;
    expect(parsed.details.truncation["truncated"]).toBe(true);
    expect(parsed.content[0]?.text.startsWith("line-0")).toBe(true);
  });

  it("[R2-T9] keeps the tail of an over-limit command result", () => {
    const fitted = fitPiResultOutput(envelope(manyLines, "bash"), 4096);
    expect(fitted).not.toBeNull();
    expect(fitted).toContain("line-4999");
    expect(fitted).not.toContain("line-0\n");
  });

  it("[R2-T9] returns null only when even empty content cannot fit", () => {
    expect(fitPiResultOutput(envelope("x".repeat(10000)), 64)).toBeNull();
  });

  it("[R2-T9] keeps three quarters of the budget for the read body without duplicating it", () => {
    expect(Buffer.byteLength(envelope(""), "utf-8")).toBeLessThan(1024);
    const fitted = fitPiResultOutput(envelope(manyLines), 4096);
    const parsed = JSON.parse(fitted as string) as FittedEnvelope;
    expect(parsed.details.truncation).not.toHaveProperty("content");
    expect(Buffer.byteLength(parsed.content[0]?.text ?? "", "utf-8")).toBeGreaterThanOrEqual(3072);
  });

  it("[R2-T9] keeps three quarters of the budget for the bash tail without duplicating it", () => {
    const fitted = fitPiResultOutput(envelope(manyLines, "bash"), 4096);
    const parsed = JSON.parse(fitted as string) as FittedEnvelope;
    expect(parsed.details.truncation).not.toHaveProperty("content");
    expect(Buffer.byteLength(parsed.content[0]?.text ?? "", "utf-8")).toBeGreaterThanOrEqual(3072);
  });
});
