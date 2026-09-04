import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { githubExpression, readJson, repositoryRoot } from "../../scripts/ci/contracts.mjs";
import {
  validateQualityPolicy,
  validateQualityWorkflow,
} from "../../scripts/ci/quality-policy.mjs";

const policy = readJson(path.join(repositoryRoot, "ci/quality-policy.json"));
const lock = readJson(path.join(repositoryRoot, "ci/toolchain-lock.json"));
const workflow = () =>
  parse(readFileSync(path.join(repositoryRoot, ".github/workflows/quality.yml"), "utf8"));
const validate = (document, proposed = policy, tools = lock) =>
  validateQualityWorkflow(proposed, stringify(document), tools);

describe("quality policy and dormant schedule", () => {
  it("accepts the actual disabled workflow and an enabled pair without changing tracked configuration", () => {
    expect(policy.schedule.enabled).toBe(false);
    const document = workflow();
    expect(document.on).not.toHaveProperty("schedule");
    expect(validate(document)).toBe(true);
    const enabled = structuredClone(policy);
    enabled.schedule.enabled = true;
    document.on.schedule = [{ cron: enabled.schedule.cron }];
    expect(validateQualityPolicy(enabled)).toBe(enabled);
    expect(validate(document, enabled)).toBe(true);
    expect(() => validate(document)).toThrow("events");
    delete document.on.schedule;
    expect(() => validate(document, enabled)).toThrow("events");
  });
  it.each([
    ["missing policy", () => null],
    ["unknown policy key", (value) => ({ ...value, allowSchedule: true })],
    [
      "string enabled",
      (value) => {
        value.schedule.enabled = "true";
        return value;
      },
    ],
    [
      "local timezone",
      (value) => {
        value.schedule.timezone = "local";
        return value;
      },
    ],
    [
      "unbounded timeout",
      (value) => {
        value.timeoutsMinutes.scale = 0;
        return value;
      },
    ],
    [
      "added observation test",
      (value) => {
        value.nodeObservation.testFiles.push("test/network.test.mjs");
        return value;
      },
    ],
    [
      "floating runtime",
      (value) => {
        value.nodeObservation.version = "24.x";
        return value;
      },
    ],
    [
      "unverified download",
      (value) => {
        value.nodeObservation.artifacts["linux-x64"].sha256 = "";
        return value;
      },
    ],
    [
      "other download source",
      (value) => {
        value.nodeObservation.artifacts["linux-x64"].url = "https://example.invalid/node.tar.gz";
        return value;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => validateQualityPolicy(mutate(structuredClone(policy)))).toThrow("POLICY_INVALID");
  });
  it.each([
    [
      "unapproved event",
      (value) => {
        value.on.push = {};
      },
    ],
    [
      "manual implicit base",
      (value) => {
        value.on.workflow_dispatch.inputs.base_sha.required = false;
      },
    ],
    [
      "automatic base fallback",
      (value) => {
        value.env.CI_BASE = githubExpression("inputs.base_sha || github.sha");
      },
    ],
    [
      "missing check",
      (value) => {
        delete value.jobs.dependencies;
      },
    ],
    [
      "extra job",
      (value) => {
        value.jobs.extra = structuredClone(value.jobs.scale);
      },
    ],
    [
      "non-default source",
      (value) => {
        value.jobs.scale.if = "always()";
      },
    ],
    [
      "unbounded job",
      (value) => {
        delete value.jobs.scale["timeout-minutes"];
      },
    ],
    [
      "silenced failure",
      (value) => {
        value.jobs.scale["continue-on-error"] = true;
      },
    ],
    [
      "skipped execution",
      (value) => {
        value.jobs.scale.steps[4].if = "false";
      },
    ],
    [
      "wrong CLI check",
      (value) => {
        value.jobs.scale.steps[4].run = value.jobs.scale.steps[4].run.replace(
          "--check scale",
          "--check dependencies",
        );
      },
    ],
    [
      "unbounded extra command",
      (value) => {
        value.jobs.scale.steps.push({ run: "echo unexpected" });
      },
    ],
    [
      "stale checkout ref",
      (value) => {
        value.jobs.scale.steps[0].with.ref = "older-sha";
      },
    ],
    [
      "checkout credentials",
      (value) => {
        value.jobs.scale.steps[0].with["persist-credentials"] = true;
      },
    ],
    [
      "unlocked action",
      (value) => {
        value.jobs.scale.steps[0].uses = "actions/checkout@main";
      },
    ],
    [
      "floating node",
      (value) => {
        value.jobs.scale.steps[1].with["node-version"] = "22.x";
      },
    ],
    [
      "write permission",
      (value) => {
        value.permissions.contents = "write";
      },
    ],
    [
      "job permission escalation",
      (value) => {
        value.jobs.brands.permissions = { "id-token": "write" };
      },
    ],
    [
      "wrong concurrency",
      (value) => {
        value.concurrency["cancel-in-progress"] = true;
      },
    ],
    [
      "unsafe upload",
      (value) => {
        value.jobs.scale.steps[6].with.path = ".";
      },
    ],
    [
      "upload despite publish failure",
      (value) => {
        value.jobs.scale.steps[6].if = "always()";
      },
    ],
    [
      "long-lived diagnostics",
      (value) => {
        value.jobs.scale.steps[7].with["retention-days"] = 30;
      },
    ],
    [
      "automatic handoff",
      (value) => {
        value.jobs.handoff.if = value.jobs.scale.if;
      },
    ],
    [
      "mixed artifact run",
      (value) => {
        value.jobs.handoff.steps[5].with["run-id"] = "latest";
      },
    ],
  ])("rejects workflow drift: %s", (_name, mutate) => {
    const document = workflow();
    mutate(document);
    expect(() => validate(document)).toThrow("WORKFLOW_MISMATCH");
  });
  it("rejects a mismatched or duplicate enabled cron and malformed YAML", () => {
    const enabled = structuredClone(policy);
    enabled.schedule.enabled = true;
    const document = workflow();
    for (const entries of [
      [{ cron: "0 0 * * *" }],
      [{ cron: enabled.schedule.cron }, { cron: enabled.schedule.cron }],
    ]) {
      document.on.schedule = entries;
      expect(() => validate(document, enabled)).toThrow("events");
    }
    expect(() => validateQualityWorkflow(policy, "name: a\nname: b\n", lock)).toThrow(
      "INVALID_YAML",
    );
    expect(() => validateQualityWorkflow(policy, "null", lock)).toThrow("events");
    expect(() => validate(workflow(), policy, { ...lock, actions: [] })).toThrow(
      "ACTION_LOCK_MISSING",
    );
  });
  it("allows presentation-only changes while preserving every execution-bearing field", () => {
    const document = workflow();
    document.name = "质量检查";
    document.jobs.scale.steps[0].name = "取受审阅源码";
    document.on.workflow_dispatch.inputs.base_sha.description = "完整 commit SHA";
    expect(validate(document)).toBe(true);
  });
});
