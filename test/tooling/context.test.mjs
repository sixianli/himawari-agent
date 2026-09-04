import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, outputPath, verifyContext } from "../../scripts/ci/context.mjs";
import { fileSha256, readJson, validateRecord } from "../../scripts/ci/contracts.mjs";

const roots = [];
const tempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "himawari-ci-context-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = tempRoot();
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.name", "CI fixture"]);
  git(["config", "user.email", "ci@example.invalid"]);
  git(["commit", "--allow-empty", "-m", "fixture base"]);
  const base = git(["rev-parse", "HEAD"]);
  mkdirSync(path.join(root, "ci"));
  copyFileSync("ci/policy.json", path.join(root, "ci/policy.json"));
  writeFileSync(path.join(root, "ci/toolchain-lock.json"), "{}\n");
  return { root, git, base };
}
function hosted(root, sha, event, data) {
  const eventPath = path.join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify(data));
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: event,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: "sixianli/himawari-agent",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
  };
}

describe("CI output boundary", () => {
  it.each([".git/config", "../outside", "/etc/hosts", ".ci-output/../../outside", ".ci-output"])(
    "rejects %s",
    (value) => {
      expect(() => outputPath(value, tempRoot())).toThrow();
    },
  );
  it("accepts a run-owned directory without shell interpretation", () => {
    const root = tempRoot();
    expect(outputPath(".ci-output/$(touch sentinel)/report.json", root)).toContain(
      "$(touch sentinel)",
    );
  });
  it("rejects links into source and similarly prefixed directories", () => {
    const root = tempRoot();
    mkdirSync(path.join(root, ".ci-output"));
    mkdirSync(path.join(root, ".ci-output-other"));
    symlinkSync(path.join(root, ".ci-output-other"), path.join(root, ".ci-output/link"));
    expect(() => outputPath(".ci-output/link/report.json", root)).toThrow("SYMLINK_ESCAPE");
  });
  it("rejects a broken symlink", () => {
    const root = tempRoot();
    symlinkSync(path.join(root, "missing"), path.join(root, ".ci-output"));
    expect(() => outputPath(".ci-output/report.json", root)).toThrow("BROKEN_SYMLINK");
  });
});

describe("CI revision identity", () => {
  it("records the actual local commit and detects changed toolchain contents", () => {
    const { root, base } = fixture();
    const context = createContext({ root, env: {}, now: 123 });
    expect(context).toMatchObject({
      testedSha: base,
      headSha: base,
      baseSha: base,
      initialization: true,
      runId: "123",
    });
    expect(verifyContext(context, { root, env: {} })).toEqual(context);
    writeFileSync(path.join(root, "ci/toolchain-lock.json"), '{"changed":true}\n');
    expect(() => verifyContext(context, { root, env: {} })).toThrow("toolchainSha256");
  });
  it("records exact push before/after and rejects missing before", () => {
    const { root, base, git } = fixture();
    git(["commit", "--allow-empty", "-m", "fixture after"]);
    const after = git(["rev-parse", "HEAD"]);
    const env = hosted(root, after, "push", { before: base, after });
    expect(createContext({ root, env })).toMatchObject({
      event: "push",
      baseSha: base,
      testedSha: after,
      attempt: 2,
    });
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ after }));
    expect(() => createContext({ root, env })).toThrow("COMMIT_ID_REQUIRED");
  });
  it("requires an explicit baseline for hosted manual runs", () => {
    const { root, base } = fixture();
    const env = hosted(root, base, "workflow_dispatch", {});
    expect(() => createContext({ root, env })).toThrow("COMMIT_ID_REQUIRED");
    expect(createContext({ root, env, base }).baseSha).toBe(base);
  });
  it("rejects untrusted SHA arguments and checkout substitutions", () => {
    const { root, base } = fixture();
    expect(() => createContext({ root, env: {}, base: "$(touch sentinel)" })).toThrow(
      "COMMIT_ID_REQUIRED",
    );
    const env = hosted(root, "a".repeat(40), "push", { before: base, after: base });
    expect(() => createContext({ root, env })).toThrow("CHECKOUT_SHA_MISMATCH");
  });
  it("requires both exact parents of a PR merge commit", () => {
    const { root, base, git } = fixture();
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const head = git(["commit-tree", tree, "-p", base, "-m", "fixture PR head"]);
    const merge = git(["commit-tree", tree, "-p", base, "-p", head, "-m", "fixture tested merge"]);
    git(["update-ref", "HEAD", merge]);
    const env = hosted(root, merge, "pull_request", {
      pull_request: { head: { sha: head }, base: { sha: base } },
      title: "$(touch sentinel)",
    });
    expect(createContext({ root, env })).toMatchObject({
      headSha: head,
      baseSha: base,
      testedSha: merge,
    });
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH));
    payload.pull_request.head.sha = base;
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(payload));
    expect(() => createContext({ root, env })).toThrow("PR_MERGE_IDENTITY_MISMATCH");
  });
});

function scheduledFixture({ enabled = true, accepted = true } = {}) {
  const fixtureValue = fixture();
  const { root, git } = fixtureValue;
  const policy = readJson("ci/quality-policy.json");
  policy.schedule.enabled = enabled;
  writeFileSync(path.join(root, "ci/quality-policy.json"), JSON.stringify(policy));
  if (accepted) {
    copyFileSync("ci/coverage-policy.json", path.join(root, "ci/coverage-policy.json"));
    git(["add", "ci"]);
  } else {
    git(["add", "ci/quality-policy.json"]);
  }
  git(["commit", "-m", "fixture accepted schedule"]);
  const sha = git(["rev-parse", "HEAD"]);
  const env = {
    ...hosted(root, sha, "schedule", { schedule: policy.schedule.cron }),
    GITHUB_REF: "refs/heads/main",
  };
  return { ...fixtureValue, sha, env };
}

describe("scheduled quality identity", () => {
  it("pins policy and base to the actual default-branch commit and re-verifies that identity", () => {
    const { root, sha, env } = scheduledFixture();
    const context = createContext({ root, env });
    expect(context).toMatchObject({
      event: "schedule",
      testedSha: sha,
      headSha: sha,
      baseSha: sha,
      initialization: false,
      policySha256: fileSha256(path.join(root, "ci/policy.json")),
    });
    expect(createContext({ root, env, base: sha })).toEqual(context);
    expect(verifyContext(context, { root, env })).toEqual(context);
    expect(validateRecord("Context", context)).toBe(context);
    expect(() => verifyContext({ ...context, event: "push" }, { root, env })).toThrow("event");
  });
  it.each([
    [
      "non-default ref",
      (value) => {
        value.env.GITHUB_REF = "refs/heads/feature";
      },
      "DEFAULT_BRANCH",
    ],
    [
      "absent ref",
      (value) => {
        delete value.env.GITHUB_REF;
      },
      "DEFAULT_BRANCH",
    ],
    [
      "substituted checkout",
      (value) => {
        value.env.GITHUB_SHA = value.base;
      },
      "CHECKOUT_SHA",
    ],
    [
      "other cron",
      (value) => {
        writeFileSync(value.env.GITHUB_EVENT_PATH, '{"schedule":"0 * * * *"}');
      },
      "SCHEDULE_MISMATCH",
    ],
    [
      "missing cron",
      (value) => {
        writeFileSync(value.env.GITHUB_EVENT_PATH, "{}");
      },
      "SCHEDULE_MISMATCH",
    ],
    [
      "working-tree policy",
      (value) => {
        writeFileSync(path.join(value.root, "ci/quality-policy.json"), "{}\n");
      },
      "POLICY_CHECKOUT_MISMATCH",
    ],
  ])("rejects %s", (_label, mutate, message) => {
    const value = scheduledFixture();
    mutate(value);
    expect(() => createContext(value)).toThrow(message);
  });
  it("rejects another, empty or unresolvable explicit base instead of silently selecting a diff", () => {
    const { root, env, base } = scheduledFixture();
    for (const value of [base, "", "main", "a".repeat(40)])
      expect(() => createContext({ root, env, base: value })).toThrow("SCHEDULE_BASE_MISMATCH");
  });
  it("cannot enable a disabled committed schedule by changing only the working tree", () => {
    const { root, env } = scheduledFixture({ enabled: false });
    expect(() => createContext({ root, env })).toThrow("SCHEDULE_DISABLED");
    const policy = readJson(path.join(root, "ci/quality-policy.json"));
    policy.schedule.enabled = true;
    writeFileSync(path.join(root, "ci/quality-policy.json"), JSON.stringify(policy));
    expect(() => createContext({ root, env })).toThrow("SCHEDULE_DISABLED");
  });
  it("requires already accepted CI and coverage policies, and a committed quality policy", () => {
    const { root, env } = scheduledFixture({ accepted: false });
    expect(() => createContext({ root, env })).toThrow("ACCEPTED_POLICY_REQUIRED");
    const other = fixture();
    const missing = {
      ...hosted(other.root, other.base, "schedule", { schedule: "23 3 * * *" }),
      GITHUB_REF: "refs/heads/main",
    };
    expect(() => createContext({ root: other.root, env: missing })).toThrow();
  });
});
