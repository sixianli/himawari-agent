import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (file) => parse(readFileSync(file, "utf8"));

function evaluateCiGroup(template, { workflow, eventName, prNumber, draft }) {
  const values = new Map([
    ["github.workflow", workflow],
    ["github.event_name", eventName],
    ["github.event.pull_request.number || github.ref", String(prNumber)],
    ["github.event_name == 'push' && github.run_id || ''", ""],
    ["github.event.pull_request.draft == true && 'draft' || 'ready'", draft ? "draft" : "ready"],
  ]);
  return template.replace(/\$\{\{\s*(.+?)\s*\}\}/gu, (_, expression) => {
    expect(values.has(expression)).toBe(true);
    return values.get(expression);
  });
}

describe("关闭或合并 PR 时取消它还在排队的 CI", () => {
  const ci = read(".github/workflows/ci.yml");
  const closed = read(".github/workflows/pr-closed.yml");
  const closedGroup = (number) =>
    closed.concurrency.group.replace(
      /\$\{\{ github\.event\.pull_request\.number \}\}/u,
      String(number),
    );

  it("只在 PR 关闭时触发，抢占与 CI 相同的并发组并取消里面的运行", () => {
    expect(closed.on).toEqual({ pull_request: { types: ["closed"] } });
    expect(closed.concurrency["cancel-in-progress"]).toBe(true);
    expect(closed.permissions).toEqual({});
    expect(Object.values(closed.jobs).every((job) => job.if === false)).toBe(true);
    expect(closedGroup(516)).toBe(
      evaluateCiGroup(ci.concurrency.group, {
        workflow: ci.name,
        eventName: "pull_request",
        prNumber: 516,
        draft: false,
      }),
    );
  });

  it("不碰别的 PR、草稿运行和 main 上的运行", () => {
    const ready517 = evaluateCiGroup(ci.concurrency.group, {
      workflow: ci.name,
      eventName: "pull_request",
      prNumber: 517,
      draft: false,
    });
    const draft516 = evaluateCiGroup(ci.concurrency.group, {
      workflow: ci.name,
      eventName: "pull_request",
      prNumber: 516,
      draft: true,
    });
    expect(closedGroup(516)).not.toBe(ready517);
    expect(closedGroup(516)).not.toBe(draft516);
    expect(closedGroup(516)).not.toMatch(/^Main confirmation|^main-confirmation/u);
  });
});
