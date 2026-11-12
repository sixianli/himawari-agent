import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeToolDescriptor } from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadDataset } from "./cases.ts";
import {
  DECISION_JUDGE_MODEL,
  gatewayDecisionJudge,
  gatewayReasoningJudge,
  parseReasoningVerdict,
  REASONING_JUDGE_MODEL,
} from "./gateway-judges.ts";
import type { TranscriptStep } from "./graders.ts";
import {
  FixtureRuntimeTools,
  prepareWorkspace,
  removeWorkspace,
  workspaceOperations,
} from "./live-harness.ts";

const dataset = loadDataset();
const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map(removeWorkspace));
});

const descriptors: RuntimeToolDescriptor[] = [
  ...(["read", "write", "edit", "bash", "find", "grep", "ls"] as const).map((name) => ({
    definition: "builtin-coding" as const,
    name,
    capabilityRef: `host.coding.${name}`,
    capabilityHandleRef: null,
  })),
  {
    name: "web_fetch",
    capabilityRef: "web.fetch.web_fetch",
    capabilityHandleRef: null,
    description: "fixture",
    parameters: { type: "object" },
  },
  {
    name: "web_search",
    capabilityRef: "web.search.web_search",
    capabilityHandleRef: null,
    description: "fixture",
    parameters: { type: "object" },
  },
];

function caseById(id: string) {
  const item = dataset.cases.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`missing case ${id}`);
  return item;
}

async function toolsFor(id: string) {
  const item = caseById(id);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), `himawari-jarvis-tools-${id}-`));
  roots.push(workspaceRoot);
  await prepareWorkspace(item, workspaceRoot);
  const steps: TranscriptStep[] = [];
  const tools = new FixtureRuntimeTools({
    descriptors,
    workspaceRoot,
    failures: item.failures ?? [],
    ...(item.toolResults ? { toolResults: item.toolResults } : {}),
    ...(item.permissions ? { permissions: item.permissions } : {}),
    steps,
  });
  let call = 0;
  const run = (name: string, args: Record<string, unknown>) => {
    call += 1;
    return tools.execute({
      runId: createRunId(`run-jarvis-tools-${id}`),
      toolCallId: `call-${call}`,
      capabilityRef:
        descriptors.find((descriptor) => descriptor.name === name)?.capabilityRef ?? name,
      capabilityHandleRef: null,
      arguments: args as never,
      dataClassification: "private",
    });
  };
  return { run, steps, workspaceRoot };
}

describe("Jarvis Test live tools", () => {
  it("reads a case file through Pi's own read tool and records the step", async () => {
    const { run, steps } = await toolsFor("6a");
    const result = await run("read", { path: "inbox/2026-10-30-amazon-refund.txt" });
    expect(result.outcome).toBe("succeeded");
    expect(result.modelContent).toContain("经审核不予退款");
    expect(steps).toEqual([
      expect.objectContaining({
        kind: "tool",
        name: "read",
        isError: false,
        args: { path: "inbox/2026-10-30-amazon-refund.txt" },
      }),
    ]);
  });

  it("answers a search with the case's prepared results in order and repeats the last one", async () => {
    const { run, steps } = await toolsFor("9a");
    const first = await run("web_search", { query: "东京 明天 天气" });
    expect(first.outcome).toBe("succeeded");
    expect(first.modelContent).toContain("11月3日（周二）：雨");
    expect(first.modelContent).not.toContain("11月4日");
    const second = await run("web_search", { query: "东京 后天 天气" });
    expect(second.modelContent).toContain("11月4日（周三）：晴");
    const third = await run("web_search", { query: "东京 一周天气" });
    expect(third.modelContent).toBe(second.modelContent);
    expect(steps.map((step) => step.kind === "tool" && step.isError)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("REVERSE: keeps search unavailable in a case that prepared no results", async () => {
    const { run } = await toolsFor("6a");
    const result = await run("web_search", { query: "东京 明天 天气" });
    expect(result.outcome).toBe("failed");
    expect(result.modelContent).toContain("评测环境没有联网");
  });

  it("REVERSE: ignores results prepared for a tool that is not a web tool", async () => {
    const item = caseById("6a");
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "himawari-jarvis-tools-canned-"));
    roots.push(workspaceRoot);
    await prepareWorkspace(item, workspaceRoot);
    const tools = new FixtureRuntimeTools({
      descriptors,
      workspaceRoot,
      failures: [],
      toolResults: [{ tool: "read" as never, outputs: ["预设的假文件内容"] }],
      steps: [],
    });
    const result = await tools.execute({
      runId: createRunId("run-jarvis-tools-canned"),
      toolCallId: "call-1",
      capabilityRef: descriptors.find(({ name }) => name === "read")?.capabilityRef ?? "read",
      capabilityHandleRef: null,
      arguments: { path: "inbox/2026-10-30-amazon-refund.txt" },
    } as never);
    expect(result.outcome).toBe("succeeded");
    expect(result.modelContent).toContain("经审核不予退款");
    expect(result.modelContent).not.toContain("预设的假文件内容");
  });

  it("refuses every write in the read-only folder, through tools and shell alike", async () => {
    const { run, workspaceRoot } = await toolsFor("8a");
    const write = await run("write", { path: "report.md", content: "合计 3500\n" });
    expect(write).toMatchObject({
      outcome: "failed",
      modelContent: expect.stringContaining("EACCES"),
    });
    const shell = await run("bash", { command: "echo 3500 > report.md" });
    expect(shell.outcome).toBe("failed");
    expect(shell.modelContent).toContain("Permission denied");
    const other = await run("write", { path: "summary.md", content: "3500\n" });
    expect(other.outcome).toBe("failed");
    const read = await run("bash", { command: "cat sales.csv" });
    expect(read.modelContent).toContain("1500");
    expect(existsSync(path.join(workspaceRoot, "report.md"))).toBe(false);
  });

  it.each(dataset.cases.filter(({ realFailures }) => realFailures !== undefined))(
    "really fails the declared commands of case $id inside its workspace",
    async (item) => {
      const { workspaceRoot } = await toolsFor(item.id);
      const operations = workspaceOperations(workspaceRoot, item.failures ?? [], item.permissions);
      for (const failure of item.realFailures ?? []) {
        const chunks: Uint8Array[] = [];
        const { exitCode } = await operations.executeCommand({
          command: failure.command,
          cwd: workspaceRoot,
          onData: (data) => chunks.push(data),
        });
        expect(exitCode, failure.command).toBe(failure.exitCode);
        if (failure.output)
          expect(Buffer.concat(chunks).toString("utf8"), failure.command).toContain(failure.output);
      }
    },
  );

  it("keeps the passing tests and the source untouched by a real npm test run", async () => {
    const { run, workspaceRoot } = await toolsFor("8c");
    const result = await run("bash", { command: "npm test" });
    expect(result.outcome).toBe("failed");
    expect(result.modelContent).toContain("ok 2 - sums amounts");
    expect(result.modelContent).toContain("not ok 4 - rounds totals");
    expect(await readFile(path.join(workspaceRoot, "src/csv.js"), "utf8")).toBe(
      caseById("8c").files?.find(({ path: file }) => file === "src/csv.js")?.content,
    );
  });

  it("refuses the search and read tools on unreadable paths like the shell does", async () => {
    const search = await toolsFor("8e");
    const grep = await search.run("grep", { pattern: "legacyFetch" });
    expect(grep).toMatchObject({
      outcome: "failed",
      modelContent: "src: Permission denied (os error 13)",
    });
    const listed = await search.run("ls", {});
    expect(listed.outcome).toBe("succeeded");
    const inside = await search.run("ls", { path: "src" });
    expect(inside.modelContent).toContain("EACCES");
    const copy = await toolsFor("8f");
    const read = await copy.run("read", { path: "report-2026.md" });
    expect(read).toMatchObject({
      outcome: "failed",
      modelContent: expect.stringContaining("EACCES"),
    });
    const made = await copy.run("bash", { command: "mkdir archive && ls" });
    expect(made.outcome).toBe("succeeded");
    expect(existsSync(path.join(copy.workspaceRoot, "archive"))).toBe(true);
  });

  it("runs commands for real inside the workspace only", async () => {
    const { run } = await toolsFor("6a");
    const outside = await run("write", { path: "/etc/jarvis-test.txt", content: "x" });
    expect(outside.outcome).toBe("failed");
    expect(existsSync("/etc/jarvis-test.txt")).toBe(false);
  });

  it("stores the GBK files as real GBK bytes", async () => {
    const { workspaceRoot } = await toolsFor("8d");
    expect(await readFile(path.join(workspaceRoot, "notes", "a.txt"))).not.toEqual(
      Buffer.from("会议记录 A\n"),
    );
  });

  it("fails every web call because the evaluation has no network", async () => {
    const { run } = await toolsFor("8b");
    const result = await run("web_fetch", { url: "https://www.tepco.co.jp/notice/2026-11-rates" });
    expect(result).toMatchObject({ outcome: "failed", modelContent: "timeout after 30000ms" });
  });
});

describe("Jarvis Test gateway judges", () => {
  const rule = dataset.judgeRules[0];
  if (!rule) throw new Error("no judge rules");
  const question = { rule, evidence: "邮件：经审核不予退款。", answer: "退款被拒了。" };

  it("asks the pinned decision model one boolean question per answer and counts its cost", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: { verdict: { type: "boolean", probability: 0.97 } },
            usage: { inputTokens: 300, outputTokens: 20 },
            providerMetadata: { gateway: { cost: "0.000014" } },
          }),
        ),
    );
    const usage = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
    const judge = gatewayDecisionJudge({ secret: async () => "fixture", usage, fetch });
    expect(await judge.decide([question])).toEqual([0.97]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: DECISION_JUDGE_MODEL.id,
      state: { evidence: question.evidence, answer: question.answer },
      questions: { verdict: { type: "boolean" } },
    });
    expect(usage).toEqual({ inputTokens: 300, outputTokens: 20, costMicros: 14 });
  });

  it("reads the reasoning judge's JSON verdict and quote", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '结论如下：{"passed": true, "quote": "退款被拒了。", "reason": "和邮件一致"}',
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.0005 },
          }),
        ),
    );
    const usage = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
    const judge = gatewayReasoningJudge({ secret: async () => "fixture", usage, fetch });
    expect(await judge.judge(question)).toEqual({
      passed: true,
      quote: "退款被拒了。",
      reason: "和邮件一致",
    });
    const body = JSON.parse(
      String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.model).toBe(REASONING_JUDGE_MODEL.id);
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 30, costMicros: 500 });
    expect(() => parseReasoningVerdict("我觉得可以")).toThrow("REASONING_JUDGE_NOT_JSON");
  });
});
