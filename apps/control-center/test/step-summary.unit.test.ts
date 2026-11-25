import {
  PROCESS_STEP_KINDS,
  PROCESS_STEP_TEXT,
  type ThreadExecutionRecord,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import { endedAwaitingApproval, type RunSummary } from "../src/execution-view.js";
import { messages as en } from "../src/i18n/resources/en.js";
import { messages as ja } from "../src/i18n/resources/ja.js";
import { messages as zh } from "../src/i18n/resources/zh-CN.js";
import { toolStepSummary } from "../src/step-summary.js";

const record = (
  sequence: number,
  overrides: Partial<ThreadExecutionRecord> = {},
): ThreadExecutionRecord => ({
  id: `event:${sequence}`,
  itemId: "call:one",
  sequence,
  kind: "status",
  phase: "updated",
  name: "runtime.activity.toolCall",
  text: "",
  input: "",
  output: "",
  activity: "",
  activityIcon: "",
  occurredAt: new Date(sequence * 1000).toISOString(),
  ...overrides,
});
const run: RunSummary = {
  runId: "run:one",
  revision: 1,
  status: "failed",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(100000).toISOString(),
  background: null,
  backgroundCommands: [],
};

describe("plain-language step summaries", () => {
  it.each([
    ["web_search", '{"query":"Tokyo weather"}', "step.search", "Tokyo weather"],
    ["recall", '{"query":"最喜欢的颜色"}', "step.recall", "最喜欢的颜色"],
    [
      "web_fetch",
      '{"url":"https://weather.example.com/tokyo"}',
      "step.fetch",
      "weather.example.com",
    ],
    ["read", '{"path":"docs/notes.md"}', "step.read", "notes.md"],
    ["write", '{"path":"poem.txt","content":"x"}', "step.write", "poem.txt"],
    ["ls", '{"path":"."}', "step.list", ""],
    ["grep", '{"pattern":"TODO"}', "step.grep", "TODO"],
    ["bash", '{"command":"rm -rf build"}', "step.command", ""],
    ["authorized_0123456789abcdef01234567", '{"inputRef":"x"}', "step.authorized", ""],
    ["custom_tool", "", "step.other", "custom_tool"],
  ])("summarizes %s without raw arguments", (name, input, id, target) => {
    expect(toolStepSummary(name, input)).toEqual({ id, target });
  });

  it("keeps truncated arguments out of the summary", () => {
    expect(toolStepSummary("web_search", '{"query":"Tok')).toEqual({
      id: "step.search",
      target: "",
    });
  });

  it("has copy for every summary in each language", () => {
    expect(zh["step.active"].replace("{step}", zh["step.search"])).toBe("正在搜索网页");
    for (const catalog of [zh, en, ja])
      expect(catalog["chat.phase.expiredAwaitingApproval"]).not.toBe("");
  });
});

describe("tools that never ran because approval never came", () => {
  const tool = { itemId: "call:one", kind: "tool" as const, output: "", firstSequence: 1 };
  const started = record(1, { kind: "tool", phase: "started", name: "web_search" });
  const suspended = record(2, { phase: "waiting", name: "runtime.suspended" });
  const failed = record(3, { phase: "failed", name: "runtime.failed" });

  it("reports a Run that ended while waiting for approval", () => {
    expect(endedAwaitingApproval(tool, [started, suspended, failed], run)).toBe(true);
  });

  it("does not claim the tool was skipped after the Run resumed", () => {
    const resumed = record(3, { phase: "started", name: "runtime.model_started" });
    expect(
      endedAwaitingApproval(
        tool,
        [started, suspended, resumed, { ...failed, id: "event:4", sequence: 4 }],
        run,
      ),
    ).toBe(false);
    const result = record(3, { kind: "tool", phase: "failed", name: "web_search" });
    expect(
      endedAwaitingApproval(
        tool,
        [started, suspended, result, { ...failed, id: "event:4", sequence: 4 }],
        run,
      ),
    ).toBe(false);
  });

  it("requires a finished Run, no output and no execution interval", () => {
    expect(
      endedAwaitingApproval(tool, [started, suspended], { ...run, status: "awaiting_approval" }),
    ).toBe(false);
    expect(
      endedAwaitingApproval({ ...tool, output: "News" }, [started, suspended, failed], run),
    ).toBe(false);
    expect(
      endedAwaitingApproval(
        tool,
        [
          started,
          record(4, { name: "runtime.tool_execution.started" }),
          record(5, { name: "runtime.tool_execution.ended" }),
          suspended,
          failed,
        ],
        run,
      ),
    ).toBe(false);
    expect(endedAwaitingApproval(tool, [started, failed], run)).toBe(false);
  });
});

describe("[P2-3] standing rule steps", () => {
  it("names the rule tools in all three languages and shows the rule summary", () => {
    for (const name of ["rule_set", "rule_list", "rule_undo"])
      expect(toolStepSummary(name, '{"summary":"入管局的邮件一律提醒"}').id).toBe("step.rule");
    expect(toolStepSummary("rule_set", '{"summary":"入管局的邮件一律提醒"}').target).toBe(
      "入管局的邮件一律提醒",
    );
    expect([zh["step.rule"], en["step.rule"], ja["step.rule"]].every(Boolean)).toBe(true);
  });
});

describe("[ICON-3] step names shared with the server", () => {
  it("keeps every web step label equal to the text the server fills in when the model gave none", () => {
    for (const [locale, catalog] of [
      ["zh-CN", zh],
      ["en", en],
      ["ja", ja],
    ] as const)
      for (const kind of PROCESS_STEP_KINDS)
        expect(catalog[`step.${kind}` as keyof typeof catalog]).toBe(
          PROCESS_STEP_TEXT[locale][kind],
        );
  });
});
