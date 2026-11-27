import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  admitNewQualificationTests,
  chromiumInstall,
  DRAFT_SKIP_CONDITION,
  evaluateTestHygiene,
  inspectTestSource,
  parseTestHygieneBaseline,
  planTestInventory,
  main as policyMain,
  REQUIRED_AFTER_ENTRY,
  SHARE_AFTER_PUT,
  SHARE_ROOT_COMMAND,
  shareCacheKey,
  sharePath,
  REQUIRED_CANCELLED,
  REQUIRED_DRAFT,
  REQUIRED_ENTRY_SCRIPT,
  REQUIRED_GATE_COMMAND,
  resolvePolicySource,
  resolveTestHygieneBaseline,
  testsMembers,
  upgradeArmRunnerPolicy,
  upgradeCoverageToTests,
  upgradeGateRunnerPolicy,
  upgradeHostedRunnerPolicy,
  upgradeRetiredBrowserCheck,
  upgradeRetiredTestChecks,
  upgradeRunnerLabel,
  upgradeSplitTests,
  validatePolicy,
  validateTestFileSource,
  validateTestHygiene,
  validateTestInventory,
  validateTestPlacement,
  validateVitestProjects,
  upgradeSelfHostedRunners,
  validateHostedRunners,
  validateWorkflow,
} from "../../scripts/ci/check-policy.mjs";
import {
  activeMembers,
  armChecks,
  armRunnerLabel,
  expectedMembers,
  gateRunnerLabel,
  githubExpression,
  hostedRunnerLabels,
  legacyArmChecks,
  legacyRunnerLabels,
  linuxRunnerLabel,
  readJson,
  repositoryRoot,
  sha256,
  validateRecord,
} from "../../scripts/ci/contracts.mjs";
import { testWorkerCount } from "../../scripts/ci/test-concurrency.mjs";

const policy = readJson(path.join(repositoryRoot, "ci/policy.json"));
const clone = () => structuredClone(policy);
const retiredBrowserCheck = () => ({
  id: "browser",
  needs: ["build"],
  timeoutMinutes: 90,
  members: ["chromium", "firefox", "webkit"].map((engine) => ({
    key: engine,
    runner: linuxRunnerLabel,
    os: "linux",
    arch: policy.checks.find((check) => check.id === "tests").members[0].arch,
    node: "22.22.3",
    browser: engine,
  })),
  projects: [],
  outputs: ["json", "artifact"],
});
const withRetiredBrowser = (value) => {
  value.checks.splice(
    value.checks.findIndex((check) => check.id === "build") + 1,
    0,
    retiredBrowserCheck(),
  );
  const required = value.checks.find((check) => check.id === "required");
  required.needs.splice(required.needs.indexOf("build") + 1, 0, "browser");
  return value;
};
const legacyClone = () => {
  const value = withRetiredBrowser(clone());
  for (const check of value.checks)
    for (const member of check.members)
      if (member.key === "macos-arm64") member.runner = "macos-15";
      else if (legacyArmChecks.includes(check.id))
        Object.assign(member, {
          runner: legacyRunnerLabels.arm,
          alternateArch: "arm64",
        });
      else if (check.id === "required") member.runner = legacyRunnerLabels.gate;
      else if (member.runner === linuxRunnerLabel) member.runner = legacyRunnerLabels.linux;
  return value;
};
const legacyPolicy = legacyClone();
const toCurrentTests = (value) => upgradeSplitTests(upgradeCoverageToTests(value));
const coverageShaped = () => {
  const value = legacyClone();
  Object.assign(
    value.checks.find((check) => check.id === "tests"),
    {
      id: "coverage",
      members: [
        {
          key: "default",
          runner: legacyRunnerLabels.linux,
          os: "linux",
          arch: "x64",
          node: "22.22.3",
        },
      ],
      projects: ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
      outputs: ["json", "lcov", "artifact"],
    },
  );
  value.checks = value.checks.filter((check) => check.id !== "tooling");
  value.checks.find((check) => check.id === "policy").projects = ["tooling"];
  value.checks.find((check) => check.id === "required").needs = [
    "policy",
    "static",
    "build",
    "browser",
    "coverage",
    "security",
  ];
  return value;
};
const armOnSharedRunner = (value) => {
  for (const check of value.checks)
    if (legacyArmChecks.includes(check.id)) {
      delete check.members[0].alternateArch;
      check.members[0].runner = legacyRunnerLabels.linux;
    }
  return value;
};
const checkout = {
  repository: "actions/checkout",
  version: "v4",
  sha: "a".repeat(40),
  license: "MIT",
};
const cacheAction = { repository: "actions/cache", sha: "c".repeat(40) };
const lock = {
  actions: [
    checkout,
    cacheAction,
    {
      repository: "actions/download-artifact",
      sha: "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    },
    {
      repository: "actions/upload-artifact",
      sha: "ea165f8d65b6e75b540449e92b4886f43607fa02",
    },
  ],
};
const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function policyFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "himawari-quality-policy-entry-"));
  fixtures.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", "quality policy fixture");
  for (const filename of [
    "ci/policy.json",
    "ci/toolchain-lock.json",
    "ci/quality-policy.json",
    "package.json",
    "package-lock.json",
    ".github/workflows/ci.yml",
    ".github/workflows/main.yml",
  ]) {
    mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    copyFileSync(path.join(repositoryRoot, filename), path.join(root, filename));
  }
  return root;
}

it("policy入口在测试发现前拒绝质量工作流漏项", async () => {
  const root = policyFixtureRoot();
  const document = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/quality.yml"), "utf8"),
  );
  delete document.jobs.dependencies;
  writeFileSync(path.join(root, ".github/workflows/quality.yml"), stringify(document));
  await expect(policyMain(["--root", root])).rejects.toThrow("CI_QUALITY_WORKFLOW_MISMATCH:jobs");
});

it("[I-91] policy入口拒绝与 package-lock.json 不符的安装脚本审阅记录", async () => {
  const root = policyFixtureRoot();
  const lockPath = path.join(root, "ci/toolchain-lock.json");
  const toolchain = JSON.parse(readFileSync(lockPath, "utf8"));
  toolchain.nativeDependencies[0].version = "0.0.1";
  writeFileSync(lockPath, JSON.stringify(toolchain));
  await expect(policyMain(["--root", root])).rejects.toThrow(
    "Install-script review version differs from package-lock",
  );
});

const shareCommand = ".ci-output/tools/bin/node scripts/ci/run-share.mjs";
const sharePut = (check) => ({
  id: "share",
  run: `${shareCommand} put --name "${check.id}-$CI_MATRIX" --from .ci-output/public/reports --output-key "$CI_MATRIX"`,
});
const buildFetch = () => ({
  env: { CI_BUILD_DIGEST: githubExpression("needs.build.outputs.linux-x64") },
  run: `${shareCommand} get --name build-linux-x64 --digest "$CI_BUILD_DIGEST" --to .ci-output/input`,
});
const shareCollect = () => ({
  env: { CI_NEEDS: githubExpression("toJSON(needs)") },
  run: `${shareCommand} collect --to .ci-output/reports`,
});
const shareRoot = () => ({ run: SHARE_ROOT_COMMAND });
const shareSave = (check) => ({
  if: SHARE_AFTER_PUT,
  uses: `actions/cache/save@${cacheAction.sha}`,
  with: {
    path: sharePath(`${check.id}-\${{ env.CI_MATRIX }}`),
    key: shareCacheKey(`${check.id}-\${{ env.CI_MATRIX }}`),
  },
});
const shareRestore = (name, extra = {}) => ({
  uses: `actions/cache/restore@${cacheAction.sha}`,
  with: { path: sharePath(name), key: shareCacheKey(name), ...extra },
});
const buildRestore = () => shareRestore("build-linux-x64", { "fail-on-cache-miss": true });
const reportRestores = () =>
  policy.checks
    .filter((check) => check.id !== "required")
    .flatMap((check) =>
      activeMembers(check).map((member) => shareRestore(`${check.id}-${member.key}`)),
    );
const gateStep = () => ({
  env: { CI_NEEDS: githubExpression("toJSON(needs)") },
  run: REQUIRED_GATE_COMMAND,
});
const diagnosticSummary = (check) => ({
  if: githubExpression("always() && steps.publish.outcome == 'success'"),
  run: `.ci-output/tools/bin/node scripts/ci/ci-summary.mjs --title "${check.id}/$CI_MATRIX 失败诊断" --from .ci-output/public/diagnostics --failed-logs .ci-output/public/reports`,
});
const requiredEntry = () => ({
  name: "草稿和被取消的运行直接判失败",
  id: "entry",
  env: {
    CI_DRAFT: githubExpression(REQUIRED_DRAFT),
    CI_CANCELLED: githubExpression(REQUIRED_CANCELLED),
  },
  run: REQUIRED_ENTRY_SCRIPT,
});

function workflow() {
  return {
    name: "CI",
    on: {
      pull_request: {
        types: ["opened", "synchronize", "reopened", "ready_for_review"],
      },
      workflow_call: {
        inputs: { base_sha: { required: false, type: "string" } },
      },
      workflow_dispatch: {},
    },
    permissions: { contents: "read" },
    concurrency: {
      group: [
        "github.workflow",
        "github.event_name",
        "github.event.pull_request.number || github.ref",
        "github.event_name == 'push' && github.run_id || ''",
        "github.event.pull_request.draft == true && 'draft' || 'ready'",
      ]
        .map(githubExpression)
        .join("-"),
      "cancel-in-progress": githubExpression("github.event_name == 'pull_request'"),
    },
    jobs: Object.fromEntries(
      policy.checks.map((check) => [
        check.id,
        {
          needs: check.needs,
          "runs-on":
            check.members.length > 1 ? githubExpression("matrix.runner") : check.members[0].runner,
          "timeout-minutes": check.timeoutMinutes,
          ...(check.members.length > 1
            ? {
                strategy: {
                  "fail-fast": false,
                  matrix: { include: activeMembers(check) },
                },
              }
            : {}),
          ...(check.id === "required"
            ? { name: "ci/required", if: githubExpression("always()") }
            : {
                outputs: Object.fromEntries(
                  activeMembers(check).map((member) => [
                    member.key,
                    githubExpression(`steps.share.outputs.${member.key}`),
                  ]),
                ),
              }),
          ...(check.id === "required" ? {} : { if: githubExpression(DRAFT_SKIP_CONDITION) }),
          steps: [
            ...(check.id === "required" ? [requiredEntry()] : []),
            {
              uses: `actions/checkout@${checkout.sha}`,
              with: { "persist-credentials": false },
            },
            shareRoot(),
            ...(["tests", "tooling"].includes(check.id) ? [{ run: chromiumInstall }] : []),
            {
              run:
                check.id === "tests"
                  ? '.ci-output/tools/bin/node scripts/ci/run.mjs --check tests --matrix "$CI_MATRIX" --base "$CI_BASE" --tools .ci-output/tools --output .ci-output/check --baseline-candidate initial-only --input .ci-output/input/result.json'
                  : "node scripts/ci/run.mjs",
            },
            ...(check.id === "tests" ? [buildRestore(), buildFetch()] : []),
            ...(check.id === "required"
              ? [...reportRestores(), shareCollect(), gateStep()]
              : [sharePut(check), shareSave(check), diagnosticSummary(check)]),
          ],
        },
      ]),
    ),
  };
}

function inventory() {
  return [
    "apps/a/src/a.unit.test.ts",
    "packages/a/src/a.contract.test.ts",
    "test/integration/a.test.ts",
    "test/e2e/a.test.ts",
    "packages/runtime-pi/a.compat.test.ts",
    "test/tooling/a.test.mjs",
    ...policy.registeredTests.map((entry) => entry.path),
  ];
}
const testSource = 'import { it } from "vitest"; it("works", () => {});';

function reviewedCoverage() {
  const value = readJson(path.join(repositoryRoot, "ci/coverage-policy.json"));
  value.baseline = {
    sourceSha: "a".repeat(40),
    sourceTreeSha256: "b".repeat(64),
    reportSha256: "c".repeat(64),
    groups: {
      "scripts/ci": Object.fromEntries(
        ["lines", "branches", "functions", "statements"].map((metric) => [
          metric,
          { total: 10, covered: 8, pct: 80 },
        ]),
      ),
    },
  };
  return value;
}

function vitestConfig() {
  return {
    test: {
      allowOnly: false,
      retry: 0,
      projects: [
        ...policy.testProjects.map((project) => ({
          test: {
            name: project.id,
            include: project.include,
            exclude: project.exclude,
            fileParallelism: project.fileParallelism,
            environment: "node",
            retry: 0,
            ...(project.id === "integration"
              ? {
                  maxWorkers: testWorkerCount(project),
                  isolate: true,
                  sequence: { groupOrder: 1 },
                }
              : {}),
          },
        })),
        ...policy.registeredTests
          .filter((test) => test.kind === "qualification")
          .map((test) => ({
            test: {
              name: test.project,
              include: [test.path],
              exclude: [],
              fileParallelism: false,
              environment: "node",
              retry: 0,
            },
          })),
      ],
    },
  };
}

function fixtureRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ci-policy-"));
  fixtures.push(root);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--quiet", "--allow-empty", "-m", "fixture");
  mkdirSync(path.join(root, "ci"));
  writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(policy));
  return { root, git };
}

describe("[ci-new-qualification] accepted policy admits only brand-new qualification tests", () => {
  const added = "test/integration/memory-benchmark/live.test.ts";
  const withoutAdded = () => {
    const value = clone();
    value.registeredTests = value.registeredTests.filter((entry) => entry.path !== added);
    const integration = value.testProjects.find((entry) => entry.id === "integration");
    integration.exclude = integration.exclude.filter((entry) => entry !== added);
    return value;
  };
  const existing = "test/integration/production-memory-capture.test.ts";

  it("admits a qualification test whose file is new, so the accepted policy matches Vitest", () => {
    const accepted = withoutAdded();
    expect(() => validateVitestProjects(accepted, vitestConfig())).toThrow(
      "Vitest file selection differs from policy: integration",
    );
    const admitted = admitNewQualificationTests(accepted, policy, [existing]);
    expect(validateVitestProjects(admitted, vitestConfig()).projects).toBe(20);
    expect(accepted.registeredTests.some((entry) => entry.path === added)).toBe(false);
  });

  it("REVERSE: does not admit a registration whose file already exists at the base", () => {
    const accepted = withoutAdded();
    expect(admitNewQualificationTests(accepted, policy, [existing, added])).toBe(accepted);
  });

  it("REVERSE: does not let a proposal exclude an existing integration test by registering it", () => {
    const accepted = withoutAdded();
    const proposed = structuredClone(policy);
    proposed.registeredTests.push({
      path: existing,
      kind: "qualification",
      project: "qualification-hidden",
      reason: "hide an existing test",
      allowedModifiers: ["skip"],
    });
    proposed.testProjects.find((entry) => entry.id === "integration").exclude.push(existing);
    const admitted = admitNewQualificationTests(accepted, proposed, [existing]);
    expect(admitted.registeredTests.some((entry) => entry.path === existing)).toBe(false);
    expect(admitted.testProjects.find((entry) => entry.id === "integration").exclude).not.toContain(
      existing,
    );
  });

  it("REVERSE: does not admit a new registration that is not a qualification test", () => {
    const accepted = withoutAdded();
    const proposed = structuredClone(policy);
    proposed.registeredTests.find((entry) => entry.path === added).kind = "type-check";
    expect(admitNewQualificationTests(accepted, proposed, [existing])).toBe(accepted);
  });

  it("REVERSE: does not admit a new qualification file that integration still runs", () => {
    const accepted = withoutAdded();
    const proposed = structuredClone(policy);
    const integration = proposed.testProjects.find((entry) => entry.id === "integration");
    integration.exclude = integration.exclude.filter((entry) => entry !== added);
    expect(admitNewQualificationTests(accepted, proposed, [existing])).toBe(accepted);
  });
});

describe("CI policy contract", () => {
  it("accepts Vitest main and qualification projects only when they agree with policy", () => {
    expect(validateVitestProjects(policy, vitestConfig()).projects).toBe(20);
  });
  it.each([
    [
      "wrong qualification identity",
      (config) => {
        config.test.projects[6].test.name = "scale";
      },
    ],
    [
      "omitted project",
      (config) => {
        config.test.projects.pop();
      },
    ],
    [
      "wrong include",
      (config) => {
        config.test.projects[0].test.include = ["apps/**"];
      },
    ],
    [
      "hidden opt-in inclusion",
      (config) => {
        config.test.projects[2].test.exclude = [];
      },
    ],
    [
      "wrong tooling concurrency",
      (config) => {
        config.test.projects[5].test.fileParallelism = !policy.testProjects[5].fileParallelism;
      },
    ],
    [
      "allow focused tests",
      (config) => {
        config.test.allowOnly = true;
      },
    ],
    [
      "allow project focus",
      (config) => {
        config.test.projects[0].test.allowOnly = true;
      },
    ],
    [
      "global retries",
      (config) => {
        config.test.retry = 1;
      },
    ],
    [
      "project retries",
      (config) => {
        config.test.projects[0].test.retry = 1;
      },
    ],
    [
      "empty project success",
      (config) => {
        config.test.projects[0].test.passWithNoTests = true;
      },
    ],
    [
      "filtered tests",
      (config) => {
        config.test.projects[0].test.testNamePattern = "green";
      },
    ],
  ])("rejects Vitest %s", (_name, mutate) => {
    const config = structuredClone(vitestConfig());
    mutate(config);
    expect(() => validateVitestProjects(policy, config)).toThrow();
  });
  it.each([null, {}])("rejects an accepted unmeasured or malformed coverage policy", (baseline) => {
    const { root, git } = fixtureRepository();
    const coverage = reviewedCoverage();
    coverage.baseline = baseline;
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(coverage));
    git("add", "ci");
    git("commit", "--quiet", "-m", "broken coverage");
    expect(() => resolvePolicySource({ root })).toThrow();
  });

  it("accepts the exact eight-job policy and literal execution graph", () => {
    expect(validatePolicy(policy)).toBe(policy);
    expect(validateWorkflow(policy, stringify(workflow()), lock)).toEqual({
      jobs: 7,
      members: 10,
    });
  });
  it.each([
    [
      "unknown property",
      (value) => {
        value.unreviewed = true;
      },
    ],
    [
      "duplicate identity",
      (value) => {
        value.checks[1].id = "policy";
      },
    ],
    [
      "missing matrix",
      (value) => {
        value.checks.find((check) => check.id === "build").members.pop();
      },
    ],
    [
      "duplicate matrix",
      (value) => {
        const check = value.checks.find((check) => check.id === "build");
        check.members[1] = check.members[0];
      },
    ],
    [
      "unbounded parallel integration",
      (value) => {
        delete value.testProjects.find((project) => project.id === "integration").workerLimits;
      },
    ],
    [
      "broad exclusion",
      (value) => {
        value.testProjects[0].exclude.push("apps/**");
      },
    ],
    [
      "missing project",
      (value) => {
        value.checks.find((check) => check.id === "tests").projects.pop();
      },
    ],
    [
      "paused Linux member",
      (value) => {
        value.checks.find((check) => check.id === "build").members[0].paused = true;
      },
    ],
    [
      "every member paused",
      (value) => {
        for (const member of value.checks.find((check) => check.id === "build").members)
          member.paused = true;
      },
    ],
    [
      "static on the arm runner",
      (value) => {
        Object.assign(value.checks.find((check) => check.id === "static").members[0], {
          runner: armRunnerLabel,
          alternateArch: "arm64",
        });
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = clone();
    mutate(value);
    expect(() => validatePolicy(value)).toThrow();
  });
  it.each([
    [
      "fake concurrency tokens",
      (value) => {
        value.concurrency.group =
          "github.workflow-github.event_name-github.event.pull_request.number-github.run_id";
      },
    ],
    [
      "edited events rerunning CI",
      (value) => {
        value.on.pull_request.types.push("edited");
      },
    ],
    [
      "draft and ready runs sharing one concurrency group",
      (value) => {
        value.concurrency.group = value.concurrency.group.replace(
          /-\$\{\{ github\.event\.pull_request\.draft[^}]*\}\}$/,
          "",
        );
      },
    ],
    [
      "concurrency with an extra segment",
      (value) => {
        value.concurrency.group += "-x";
      },
    ],
    [
      "missing job",
      (value) => {
        delete value.jobs.static;
      },
    ],
    [
      "unknown job",
      (value) => {
        value.jobs.extra = value.jobs.static;
      },
    ],
    [
      "wrong DAG",
      (value) => {
        value.jobs.tests.needs = ["policy"];
      },
    ],
    [
      "matrix omission",
      (value) => {
        value.jobs.tests.strategy.matrix.include = activeMembers(
          policy.checks.find((check) => check.id === "tests"),
        ).slice(1);
      },
    ],
    [
      "matrix expression",
      (value) => {
        value.jobs.tests.strategy.matrix = githubExpression(
          "fromJSON(needs.policy.outputs.matrix)",
        );
      },
    ],
    [
      "matrix early stop",
      (value) => {
        value.jobs.build.strategy["fail-fast"] = true;
      },
    ],
    [
      "required skip",
      (value) => {
        value.jobs.required.if = "success()";
      },
    ],
    [
      "other condition on tests",
      (value) => {
        value.jobs.tests.if = githubExpression("!github.event.pull_request.draft");
      },
    ],
    [
      "missing draft condition on policy",
      (value) => {
        delete value.jobs.policy.if;
      },
    ],
    [
      "other condition on security",
      (value) => {
        value.jobs.security.if = githubExpression("always()");
      },
    ],
    [
      "required without the entry check",
      (value) => {
        value.jobs.required.steps.shift();
      },
    ],
    [
      "required entry check after checkout",
      (value) => {
        const [entry, checkoutStep] = value.jobs.required.steps;
        value.jobs.required.steps.splice(0, 2, checkoutStep, entry);
      },
    ],
    [
      "required entry check ignoring cancelled upstream",
      (value) => {
        value.jobs.required.steps[0].env.CI_CANCELLED = githubExpression("false");
      },
    ],
    [
      "required entry check that passes drafts",
      (value) => {
        value.jobs.required.steps[0].run = REQUIRED_ENTRY_SCRIPT.replace("exit 1; fi", "fi");
      },
    ],
    [
      "required running a step after a failed entry check",
      (value) => {
        value.jobs.required.steps.push({ if: "always()", run: "echo late" });
      },
    ],
    [
      "required collecting reports after a failed entry check",
      (value) => {
        value.jobs.required.steps.find((step) => step.run?.includes(" collect ")).if = "always()";
      },
    ],
    [
      "missing draft condition on tests",
      (value) => {
        delete value.jobs.tests.if;
      },
    ],
    [
      "path filtering",
      (value) => {
        value.on.pull_request.paths = ["apps/**"];
      },
    ],
    [
      "write token",
      (value) => {
        value.permissions.contents = "write";
      },
    ],
    [
      "ID token",
      (value) => {
        value.jobs.static.permissions = { "id-token": "write" };
      },
    ],
    [
      "artifact write on a check job",
      (value) => {
        value.jobs.static.permissions = { contents: "read", actions: "write" };
      },
    ],
    [
      "artifact write on the gate job",
      (value) => {
        value.jobs.required.permissions = {
          contents: "read",
          actions: "write",
        };
      },
    ],
    [
      "floating action",
      (value) => {
        value.jobs.policy.steps[0].uses = "actions/checkout@v4";
      },
    ],
    [
      "unlocked SHA",
      (value) => {
        value.jobs.policy.steps[0].uses = `actions/checkout@${"b".repeat(40)}`;
      },
    ],
    [
      "credential persistence",
      (value) => {
        value.jobs.policy.steps[0].with["persist-credentials"] = true;
      },
    ],
    [
      "shell interpolation",
      (value) => {
        value.jobs.policy.steps[1].run = `echo ${githubExpression("github.event.pull_request.title")}`;
      },
    ],
    [
      "hidden command failure",
      (value) => {
        value.jobs.policy.steps[1]["continue-on-error"] = true;
      },
    ],
    [
      "production secret",
      (value) => {
        value.jobs.policy.env = {
          TOKEN: githubExpression("secrets.PRODUCTION"),
        };
      },
    ],
  ])("rejects workflow %s", (_name, mutate) => {
    const value = workflow();
    mutate(value);
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow();
  });
  const formerArtifactActions = [
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  ];
  it.each(
    ["policy", "tests", "tooling", "required"].flatMap((id) =>
      formerArtifactActions.map((uses) => [id, uses]),
    ),
  )("[I-95] rejects a GitHub artifact step in %s: %s", (id, uses) => {
    const value = workflow();
    value.jobs[id].steps.push({
      uses,
      with: { name: "x", path: ".ci-output/gate/" },
    });
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      `GitHub artifacts are not used; reports stay on the runner share and diagnostics go to the job summary: ${id}`,
    );
  });
  it("rejects artifact steps even when the actions are locked, and the repository no longer locks them", () => {
    const repositoryLock = readJson(path.join(repositoryRoot, "ci/toolchain-lock.json"));
    expect(repositoryLock.actions.filter((entry) => entry.repository.includes("artifact"))).toEqual(
      [],
    );
  });
  it.each(["missing", "conditional", "different output"])(
    "rejects a gate job that does not print its gate into the log: %s",
    (change) => {
      const value = workflow();
      const steps = value.jobs.required.steps;
      const index = steps.findIndex((step) => step.run === REQUIRED_GATE_COMMAND);
      if (change === "missing") steps.splice(index, 1);
      if (change === "conditional") steps[index].if = REQUIRED_AFTER_ENTRY;
      if (change === "different output")
        steps[index].run = steps[index].run.replace(".ci-output/gate", ".ci-output/other");
      expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
        "Required must print its gate into the ci/required log, where main reads it",
      );
    },
  );
  it.each([
    "missing",
    "duplicated",
    "only on success",
    "wrong folder",
    "wrong title",
    "no failed logs",
    "wrong failed logs folder",
  ])("rejects a check job whose diagnostics do not reach the job summary: %s", (change) => {
    const value = workflow();
    const steps = value.jobs.static.steps;
    const index = steps.findIndex((step) => step.run?.includes("ci-summary.mjs"));
    if (change === "missing") steps.splice(index, 1);
    if (change === "duplicated") steps.push({ ...steps[index] });
    if (change === "only on success") delete steps[index].if;
    if (change === "wrong folder")
      steps[index].run = steps[index].run.replace("public/diagnostics", "check");
    if (change === "wrong title") steps[index].run = steps[index].run.replace("static/", "x/");
    if (change === "no failed logs")
      steps[index].run = steps[index].run.replace(" --failed-logs .ci-output/public/reports", "");
    if (change === "wrong failed logs folder")
      steps[index].run = steps[index].run.replace("public/reports", "public/other");
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      "Job must write its diagnostics into the job summary exactly once: static",
    );
  });
  it("accepts read-only permissions on the gate job", () => {
    const value = workflow();
    value.jobs.required.permissions = { contents: "read", actions: "read" };
    expect(() => validateWorkflow(policy, stringify(value), lock)).not.toThrow();
  });
  it.each(["tests", "tooling"])(
    "rejects a %s job that runs browser tests without installing Chromium",
    (id) => {
      const value = workflow();
      value.jobs[id].steps = value.jobs[id].steps.filter((step) => step.run !== chromiumInstall);
      expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
        `without installing Chromium: ${id}`,
      );
    },
  );
  it.each([
    ["after the checks", (steps, index) => steps.push(...steps.splice(index, 1))],
    ["with a condition", (steps, index) => Object.assign(steps[index], { if: "false" })],
    [
      "without a check step",
      (steps) =>
        steps.splice(
          steps.findIndex((step) => step.run?.includes("scripts/ci/run.mjs")),
          1,
        ),
    ],
  ])("rejects a tooling Chromium install %s", (_name, change) => {
    const value = workflow();
    const steps = value.jobs.tooling.steps;
    change(
      steps,
      steps.findIndex((step) => step.run === chromiumInstall),
    );
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      "Chromium must install unconditionally before the checks run: tooling",
    );
  });
  it("accepts a Chromium install that states it may not fail", () => {
    const value = workflow();
    const steps = value.jobs.tooling.steps;
    steps.find((step) => step.run === chromiumInstall)["continue-on-error"] = false;
    expect(() => validateWorkflow(policy, stringify(value), lock)).not.toThrow();
  });
  it.each([
    "missing option",
    "always measure",
    "conditional runner",
    "duplicate runner",
    "direct baseline write",
  ])("rejects tests candidate workflow drift: %s", (change) => {
    const value = workflow();
    const steps = value.jobs.tests.steps;
    const runner = steps.find((step) => step.run?.includes("scripts/ci/run.mjs"));
    if (change === "missing option")
      runner.run = runner.run.replace(" --baseline-candidate initial-only", "");
    if (change === "always measure") runner.run = runner.run.replace("initial-only", "always");
    if (change === "conditional runner") runner.if = "false";
    if (change === "duplicate runner") steps.push({ ...runner });
    if (change === "direct baseline write")
      runner.run =
        "node scripts/ci/check-coverage.mjs --mode measure --baseline-output ci/coverage-policy.json";
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      "initial-only baseline candidate",
    );
  });
  it.each([
    "import { test } from 'vitest'; const { only } = test; test('normal', () => {}); only('focused', () => {});",
    "import { test } from 'vitest'; const { only: focus } = test; focus('focused', () => {});",
    "import * as v from 'vitest'; const { test: check } = v; const { skip: omit } = check; omit('skipped', () => {});",
  ])("rejects destructured focused or skipped aliases", (source) => {
    expect(inspectTestSource(source, "a.test.ts").modifiers.length).toBeGreaterThan(0);
    expect(() => validateTestInventory(policy, inventory(), () => source)).toThrow();
  });
  it("keeps ordinary destructured parameterized tests and namespace assertions valid", () => {
    const source =
      "import * as v from 'vitest'; const { test: check } = v; const { each } = check; each([1])('normal', () => { v.expect(1).toBe(1); });";
    expect(inspectTestSource(source, "a.test.ts").modifiers).toEqual([]);
    expect(inspectTestSource(source, "a.test.ts").declarations).toBe(1);
  });
  it("resolves lexical bindings so local report objects do not become Vitest globals", () => {
    const source =
      "import { it, test } from 'vitest'; it('report', () => { const test = { artifacts: [{}], only: 'metadata' }; inspect(test.artifacts[0], test.only); });";
    for (const filename of ["a.test.ts", "a.test.mjs"]) {
      expect(inspectTestSource(source, filename).modifiers).toEqual([]);
      expect(inspectTestSource(source, filename).declarations).toBe(1);
    }
  });
  it("tracks assigned Vitest aliases in their lexical scope", () => {
    const source =
      "import { test as declare } from 'vitest'; let focused; focused = declare; focused.only('bad', () => {});";
    expect(
      inspectTestSource(source, "a.test.mjs").modifiers.map((entry) => entry.modifier),
    ).toContain("only");
  });
  it("rejects empty suites through an import alias", () => {
    expect(
      inspectTestSource(
        "import { describe as group } from 'vitest'; group('empty', () => {});",
        "a.test.ts",
      ).emptySuites,
    ).toHaveLength(1);
  });
  it("rejects duplicate YAML keys before object parsing", () => {
    expect(() => validateWorkflow(policy, "on: {}\non: {}\n", lock)).toThrow(
      "Invalid workflow YAML",
    );
  });
  it("accepts full test ownership including exact qualification and type fixtures", () => {
    expect(validateTestInventory(policy, inventory(), () => testSource).projects).toEqual({
      unit: 1,
      contracts: 1,
      integration: 1,
      e2e: 1,
      "pi-compat": 1,
      tooling: 1,
    });
  });
  it.each([
    ["unowned", (files) => [...files, "test/unowned.test.ts"]],
    ["empty project", (files) => files.filter((file) => !file.startsWith("apps/"))],
    ["stale fixture", (files) => files.filter((file) => !file.includes("durable-phase-child"))],
  ])("rejects %s test inventory", (_name, mutate) => {
    expect(() => validateTestInventory(policy, mutate(inventory()), () => testSource)).toThrow();
  });
  it("rejects duplicate test ownership", () => {
    const value = clone();
    value.testProjects[1].include.push("apps/**/*.unit.test.ts");
    expect(() => validateTestInventory(value, inventory(), () => testSource)).toThrow(
      "exactly one owner",
    );
  });
  it("does not treat comments, strings, and unrelated .only methods as test declarations", () => {
    const source = `${testSource}\n// test.only('bad', () => {})\nconst fixture = "describe.skip('text')"; const object = { only() {} }; object.only();`;
    expect(inspectTestSource(source, "a.test.ts").modifiers).toEqual([]);
  });
  it.each(["only", "skip", "todo", "skipIf", "runIf"])(
    "finds actual %s modifiers, including Vitest aliases and computed properties",
    (modifier) => {
      const source = `import { test as check } from 'vitest'; check['${modifier}']('case', () => {});`;
      expect(
        inspectTestSource(source, "a.test.ts").modifiers.map((item) => item.modifier),
      ).toContain(modifier);
      expect(() => validateTestInventory(policy, inventory(), () => source)).toThrow();
    },
  );
  it("allows an explicitly registered opt-in modifier and refuses focused qualification tests", () => {
    const readSource = (file) =>
      file.endsWith("scale-qualification.test.ts")
        ? `import { describe } from 'vitest'; const suite = true ? describe : describe.skip; suite('case', () => { it('works', () => {}); });`
        : testSource;
    expect(() => validateTestInventory(policy, inventory(), readSource)).not.toThrow();
    expect(() =>
      validateTestInventory(policy, inventory(), (file) =>
        file.endsWith("scale-qualification.test.ts")
          ? "describe.only('focused', () => { it('works', () => {}); });"
          : testSource,
      ),
    ).toThrow("only");
  });
  it("rejects a file with no test declarations or an empty suite", () => {
    expect(() =>
      validateTestInventory(policy, inventory(), () => "export const data = 'test.only';"),
    ).toThrow("No executable");
    expect(() =>
      validateTestInventory(policy, inventory(), () => "describe('empty', () => {});"),
    ).toThrow("Empty suite");
  });
  it("initializes only when git proves both accepted policy files are absent", () => {
    const { root } = fixtureRepository();
    const selected = resolvePolicySource({ root });
    expect(selected.initialization).toBe(true);
    expect(selected.coverage).toBeNull();
  });
  it.each(["ci/policy.json", "ci/coverage-policy.json"])(
    "fails closed when only %s exists at base",
    (filename) => {
      const { root, git } = fixtureRepository();
      if (filename.includes("coverage")) writeFileSync(path.join(root, filename), "{}");
      git("add", filename);
      git("commit", "--quiet", "-m", "partial");
      expect(() => resolvePolicySource({ root })).toThrow("Damaged accepted policy");
    },
  );
  it("reads reviewed policy from base and rejects invalid base refs", () => {
    const { root, git } = fixtureRepository();
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted");
    const proposed = clone();
    proposed.retentionDays.reports = 2;
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(proposed));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify({ baseline: 0 }));
    const selected = resolvePolicySource({ root });
    expect(selected.initialization).toBe(false);
    expect(selected.policy.retentionDays.reports).toBe(1);
    expect(selected.coverage.baseline.groups["scripts/ci"].lines.pct).toBe(80);
    expect(() => resolvePolicySource({ root, base: "--help" })).toThrow();
    expect(() => resolvePolicySource({ root, base: "f".repeat(40) })).toThrow();
  });
  it("[ADR-0309] 基准上还带三个浏览器作业的策略升级成去掉 browser 的七作业，别的写法照样被拒", () => {
    expect(upgradeRetiredBrowserCheck(withRetiredBrowser(clone()))).toEqual(policy);
    expect(upgradeRetiredBrowserCheck(policy)).toBe(policy);
    const twoEngines = withRetiredBrowser(clone());
    twoEngines.checks.find((check) => check.id === "browser").members.pop();
    expect(upgradeRetiredBrowserCheck(twoEngines)).toBe(twoEngines);
    expect(() => validatePolicy(upgradeRetiredBrowserCheck(twoEngines))).toThrow(
      "Policy must declare exactly seven required jobs",
    );
    const requiredSkipsBrowser = withRetiredBrowser(clone());
    const required = requiredSkipsBrowser.checks.find((check) => check.id === "required");
    required.needs = required.needs.filter((id) => id !== "browser");
    expect(upgradeRetiredBrowserCheck(requiredSkipsBrowser)).toBe(requiredSkipsBrowser);
    const { root, git } = fixtureRepository();
    const accepted = withRetiredBrowser(clone());
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted browser jobs");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(accepted)));
    expect(validateWorkflow(selected.policy, stringify(workflow()), lock)).toEqual({
      jobs: 7,
      members: 10,
    });
  });
  it("暂停的 macOS 成员不进矩阵，也不进闸门要等的结果", () => {
    const withMac = workflow();
    withMac.jobs.build.strategy.matrix.include = policy.checks.find(
      (check) => check.id === "build",
    ).members;
    expect(() => validateWorkflow(policy, stringify(withMac), lock)).toThrow(
      "Matrix members differ: build",
    );
    const ids = expectedMembers(policy).map((entry) => entry.id);
    expect(ids).toHaveLength(8);
    expect(ids.some((id) => id.includes("macos-arm64"))).toBe(false);
  });
  it("把已接受的托管 runner 政策升级成 ci-vps 加暂停 macOS 一次", () => {
    const { root, git } = fixtureRepository();
    const hosted = armOnSharedRunner(coverageShaped());
    for (const check of hosted.checks) {
      check.timeoutMinutes =
        check.id === "required"
          ? 5
          : ["build", "test", "node-floor", "browser"].includes(check.id)
            ? 30
            : 15;
      for (const member of check.members)
        if (member.key === "macos-arm64") delete member.paused;
        else member.runner = "ubuntu-24.04";
    }
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(hosted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted hosted runners");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(hosted)));
  });
  it("把已接受的 30 天和 7 天保存期升级成 1 天一次，别的值照样被拒", () => {
    const { root, git } = fixtureRepository();
    const accepted = clone();
    accepted.retentionDays = { reports: 30, diagnostics: 7 };
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted 30/7");
    expect(resolvePolicySource({ root }).policy).toEqual(policy);
    accepted.retentionDays = { reports: 14, diagnostics: 7 };
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted 14/7");
    expect(() => resolvePolicySource({ root })).toThrow("retentionDays");
  });
  it("只升级完整的托管 runner 写法，混合写法照样被拒", () => {
    const mixed = legacyClone();
    mixed.checks.find((check) => check.id === "static").members[0].runner = "ubuntu-24.04";
    expect(upgradeHostedRunnerPolicy(mixed)).toBe(mixed);
    expect(upgradeHostedRunnerPolicy(policy)).toBe(policy);
    const unpausedMac = clone();
    for (const check of unpausedMac.checks)
      for (const member of check.members)
        if (member.key !== "macos-arm64") member.runner = "ubuntu-24.04";
    expect(upgradeHostedRunnerPolicy(unpausedMac)).toBe(unpausedMac);
    expect(() => validatePolicy(upgradeHostedRunnerPolicy(mixed))).toThrow();
    const hostedWithTimeouts = (timeoutFor) => {
      const value = armOnSharedRunner(coverageShaped());
      for (const check of value.checks) {
        check.timeoutMinutes = timeoutFor(check.id);
        for (const member of check.members)
          if (member.key === "macos-arm64") delete member.paused;
          else member.runner = "ubuntu-24.04";
      }
      return value;
    };
    const legacyTimeout = (id) =>
      id === "required" ? 5 : ["build", "test", "node-floor", "browser"].includes(id) ? 30 : 15;
    const legacy = hostedWithTimeouts(legacyTimeout);
    expect(upgradeHostedRunnerPolicy(legacy)).not.toBe(legacy);
    expect(() =>
      validatePolicy(
        upgradeRetiredBrowserCheck(
          upgradeSelfHostedRunners(
            toCurrentTests(
              upgradeArmRunnerPolicy(upgradeGateRunnerPolicy(upgradeHostedRunnerPolicy(legacy))),
            ),
          ),
        ),
      ),
    ).not.toThrow();
    const wrongTimeout = hostedWithTimeouts((id) => (id === "build" ? 1 : legacyTimeout(id)));
    expect(upgradeHostedRunnerPolicy(wrongTimeout)).toBe(wrongTimeout);
    expect(() => validatePolicy(upgradeHostedRunnerPolicy(wrongTimeout))).toThrow();
  });
  const hermesPolicy = () => {
    const value = armOnSharedRunner(coverageShaped());
    for (const check of value.checks)
      for (const member of check.members)
        if (member.key !== "macos-arm64") member.runner = "hermes-home";
    return value;
  };
  it("[HR-11] 基准上恰好是 hermes-home 的策略升级成 ci-vps，摘要仍按原始字节算", () => {
    const { root, git } = fixtureRepository();
    const accepted = hermesPolicy();
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted hermes-home");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(accepted)));
    expect(validateWorkflow(selected.policy, stringify(workflow()), lock)).toEqual({
      jobs: 7,
      members: 10,
    });
  });
  it("[HR-11] 只升级完整的 hermes-home 写法，混写、未暂停 macOS、时限不对的照样被拒", () => {
    expect(legacyRunnerLabels.linux).toBe("ci-vps");
    expect(upgradeRunnerLabel(policy)).toBe(policy);
    const mixed = hermesPolicy();
    mixed.checks.find((check) => check.id === "static").members[0].runner =
      legacyRunnerLabels.linux;
    expect(upgradeRunnerLabel(mixed)).toBe(mixed);
    expect(() => validatePolicy(upgradeRunnerLabel(mixed))).toThrow();
    const unpausedMac = hermesPolicy();
    for (const check of unpausedMac.checks)
      for (const member of check.members) if (member.key === "macos-arm64") delete member.paused;
    expect(upgradeRunnerLabel(unpausedMac)).toBe(unpausedMac);
    const wrongTimeout = hermesPolicy();
    wrongTimeout.checks.find((check) => check.id === "build").timeoutMinutes = 1;
    expect(upgradeRunnerLabel(wrongTimeout)).toBe(wrongTimeout);
    expect(() => validatePolicy(upgradeRunnerLabel(wrongTimeout))).toThrow();
    expect(() => validatePolicy(hermesPolicy())).toThrow(
      "runner must be equal to one of the allowed values",
    );
  });
  const retiredTestPolicy = () => {
    const value = coverageShaped();
    value.checks.find((check) => check.id === "required").members[0].runner =
      legacyRunnerLabels.linux;
    const fiveProjects = ["unit", "contracts", "integration", "e2e", "pi-compat"];
    const coverageIndex = value.checks.findIndex((check) => check.id === "coverage");
    value.checks[coverageIndex].projects = ["unit", "contracts", "tooling", "integration"];
    const browserIndex = value.checks.findIndex((check) => check.id === "browser");
    value.checks.splice(
      browserIndex,
      0,
      {
        id: "test",
        needs: ["policy", "build"],
        timeoutMinutes: 90,
        members: [
          {
            key: "linux-x64",
            runner: "ci-vps",
            os: "linux",
            arch: "x64",
            node: "22.22.3",
          },
          {
            key: "macos-arm64",
            runner: "macos-15",
            os: "darwin",
            arch: "arm64",
            node: "22.22.3",
            paused: true,
          },
        ],
        projects: fiveProjects,
        outputs: ["json", "junit", "artifact"],
      },
      {
        id: "node-floor",
        needs: ["policy"],
        timeoutMinutes: 90,
        members: [
          {
            key: "default",
            runner: "ci-vps",
            os: "linux",
            arch: "x64",
            node: "22.19.0",
          },
        ],
        projects: fiveProjects,
        outputs: ["json", "junit"],
      },
    );
    value.checks.find((check) => check.id === "required").needs = [
      "policy",
      "static",
      "build",
      "test",
      "node-floor",
      "browser",
      "coverage",
      "security",
    ];
    return value;
  };
  it("基准上恰好是带 test 和 node-floor 的九作业策略时升级成七作业，摘要仍按原始字节算", () => {
    const { root, git } = fixtureRepository();
    const accepted = retiredTestPolicy();
    expect(() => validatePolicy(accepted)).toThrow();
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted nine jobs");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(accepted)));
    expect(validateWorkflow(selected.policy, stringify(workflow()), lock)).toEqual({
      jobs: 7,
      members: 10,
    });
  });
  it.each([
    [
      "test 作业少一个项目",
      (value) => {
        value.checks.find((check) => check.id === "test").projects.pop();
      },
    ],
    [
      "node-floor 换了 Node 版本",
      (value) => {
        value.checks.find((check) => check.id === "node-floor").members[0].node = "22.20.0";
      },
    ],
    [
      "test 的 macOS 成员没暂停",
      (value) => {
        delete value.checks.find((check) => check.id === "test").members[1].paused;
      },
    ],
    [
      "required 没等 node-floor",
      (value) => {
        const required = value.checks.find((check) => check.id === "required");
        required.needs = required.needs.filter((id) => id !== "node-floor");
      },
    ],
    [
      "coverage 少一种输出",
      (value) => {
        value.checks.find((check) => check.id === "coverage").outputs = ["json", "artifact"];
      },
    ],
    [
      "coverage 多一个项目",
      (value) => {
        value.checks.find((check) => check.id === "coverage").projects.push("e2e");
      },
    ],
    [
      "required 的时限变了",
      (value) => {
        value.checks.find((check) => check.id === "required").timeoutMinutes = 30;
      },
    ],
    [
      "多一个作业",
      (value) => {
        value.checks.push({
          ...value.checks.find((check) => check.id === "security"),
          id: "extra",
        });
      },
    ],
  ])("只升级完整的九作业旧写法，%s的照样被拒", (_name, mutate) => {
    const value = retiredTestPolicy();
    mutate(value);
    expect(upgradeRetiredTestChecks(value)).toBe(value);
    expect(() => validatePolicy(upgradeRetiredTestChecks(value))).toThrow();
  });
  it("覆盖率基线所在的 5daedc92 托管九作业策略经整条升级链得到现行七作业策略", () => {
    const { root, git } = fixtureRepository();
    const fixtures = path.join(repositoryRoot, "test/tooling/fixtures/ci-policy");
    copyFileSync(
      path.join(fixtures, "hosted-nine-jobs-5daedc92.json"),
      path.join(root, "ci/policy.json"),
    );
    copyFileSync(
      path.join(fixtures, "hosted-nine-jobs-5daedc92-coverage.json"),
      path.join(root, "ci/coverage-policy.json"),
    );
    git("add", "ci");
    git("commit", "--quiet", "-m", "hosted nine jobs");
    const selected = resolvePolicySource({ root });
    expect(selected.policy.checks.map((check) => check.id)).toEqual(
      policy.checks.map((check) => check.id),
    );
    expect(selected.policy.checks).toEqual(policy.checks);
    expect(selected.policy.retentionDays).toEqual(policy.retentionDays);
  });
  it("升级保留 coverage 以外作业的原样，现行七作业策略原样返回", () => {
    expect(upgradeRetiredTestChecks(policy)).toBe(policy);
    const accepted = retiredTestPolicy();
    const upgraded = toCurrentTests(upgradeGateRunnerPolicy(upgradeRetiredTestChecks(accepted)));
    expect(upgraded).toEqual(legacyPolicy);
    expect(accepted.checks.map((check) => check.id)).toContain("node-floor");
  });
  const sharedRunnerPolicy = () => {
    const value = coverageShaped();
    value.checks.find((check) => check.id === "required").members[0].runner =
      legacyRunnerLabels.linux;
    return value;
  };
  it("[ADR-0287] 基准上汇总作业还在 ci-vps 的七作业策略升级成 ci-vps-gate，摘要仍按原始字节算", () => {
    const { root, git } = fixtureRepository();
    const accepted = sharedRunnerPolicy();
    expect(() => validatePolicy(toCurrentTests(accepted))).toThrow();
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted shared runner");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(accepted)));
    expect(validateWorkflow(selected.policy, stringify(workflow()), lock)).toEqual({
      jobs: 7,
      members: 10,
    });
  });
  it("[ADR-0287] 只升级汇总作业在 ci-vps 的七作业写法，现行策略原样返回，别的写法照样被拒", () => {
    expect(upgradeGateRunnerPolicy(policy)).toBe(policy);
    const upgraded = upgradeGateRunnerPolicy(sharedRunnerPolicy());
    expect(upgraded).toEqual(coverageShaped());
    const hosted = sharedRunnerPolicy();
    hosted.checks.find((check) => check.id === "required").members[0].runner = "ubuntu-24.04";
    expect(upgradeGateRunnerPolicy(hosted)).toBe(hosted);
    expect(() => validatePolicy(upgradeGateRunnerPolicy(hosted))).toThrow();
  });
  it("[ADR-0287] 检查作业写成 ci-vps-gate、汇总作业写回 ci-vps 的策略都被拒", () => {
    const checkOnGate = clone();
    checkOnGate.checks.find((check) => check.id === "static").members[0].runner = "ci-vps-gate";
    expect(upgradeGateRunnerPolicy(checkOnGate)).toBe(checkOnGate);
    expect(() => validatePolicy(checkOnGate)).toThrow(
      "runner must be equal to one of the allowed values",
    );
    expect(() => validatePolicy(toCurrentTests(sharedRunnerPolicy()))).toThrow(
      "runner must be equal to one of the allowed values",
    );
  });
  it("[ADR-0287] 工作流的汇总作业写回 ci-vps、或检查作业写成 ci-vps-gate 时被拒", () => {
    const gateOnShared = workflow();
    gateOnShared.jobs.required["runs-on"] = legacyRunnerLabels.linux;
    expect(() => validateWorkflow(policy, stringify(gateOnShared), lock)).toThrow();
    const checkOnGate = workflow();
    checkOnGate.jobs.static["runs-on"] = "ci-vps-gate";
    expect(() => validateWorkflow(policy, stringify(checkOnGate), lock)).toThrow();
  });
  it("[ADR-0267] 基准上 coverage 作业带全部测试的七作业策略升级成 tests 加 Oracle 上的 tooling", () => {
    expect(policy.checks.find((check) => check.id === "policy").projects).toEqual([]);
    for (const projects of [["tooling"], []]) {
      const accepted = coverageShaped();
      accepted.checks.find((check) => check.id === "policy").projects = projects;
      expect(toCurrentTests(accepted)).toEqual(legacyPolicy);
    }
    expect(toCurrentTests(policy)).toBe(policy);
    expect(policy.checks.find((check) => check.id === "tooling")).toEqual({
      id: "tooling",
      needs: ["policy"],
      timeoutMinutes: 60,
      members: policy.checks.find((check) => check.id === "policy").members,
      projects: ["tooling"],
      outputs: ["json"],
    });
    expect(policy.checks.find((check) => check.id === "static").members[0]).toEqual({
      key: "default",
      runner: linuxRunnerLabel,
      os: "linux",
      arch: "x64",
      node: "22.22.3",
    });
  });
  it.each([
    [
      "policy 带了别的项目",
      (value) => {
        value.checks[0].projects = ["unit"];
      },
    ],
    [
      "coverage 少 integration",
      (value) => {
        const coverage = value.checks.find((check) => check.id === "coverage");
        coverage.projects = coverage.projects.filter((id) => id !== "integration");
      },
    ],
    [
      "coverage 少 lcov 输出",
      (value) => {
        value.checks.find((check) => check.id === "coverage").outputs = ["json"];
      },
    ],
    [
      "coverage 放到 ci-arm",
      (value) => {
        value.checks.find((check) => check.id === "coverage").members[0].runner = "ci-arm";
      },
    ],
    [
      "required 没等 coverage",
      (value) => {
        const required = value.checks.find((check) => check.id === "required");
        required.needs = required.needs.filter((id) => id !== "coverage");
      },
    ],
  ])("[ADR-0267] 只升级完整的 coverage 七作业写法，%s的照样被拒", (_name, mutate) => {
    const value = coverageShaped();
    mutate(value);
    expect(toCurrentTests(value)).toBe(value);
    expect(() => validatePolicy(toCurrentTests(value))).toThrow();
  });
  it("[ADR-0275] tests 拆成两份集成测试和其余项目三台并行，基准上的单台写法升级一次", () => {
    expect(policy.checks.find((check) => check.id === "tests").members).toEqual(
      testsMembers.map((member) => ({ ...member, runner: linuxRunnerLabel })),
    );
    const single = legacyClone();
    single.checks.find((check) => check.id === "tests").members = [
      {
        key: "default",
        runner: legacyRunnerLabels.linux,
        os: "linux",
        arch: "x64",
        node: "22.22.3",
      },
    ];
    expect(() =>
      validatePolicy(upgradeRetiredBrowserCheck(upgradeSelfHostedRunners(single))),
    ).toThrow("Incomplete matrix: tests");
    expect(upgradeSplitTests(single)).toEqual(legacyPolicy);
    expect(upgradeSplitTests(policy)).toBe(policy);
    const { root, git } = fixtureRepository();
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(single));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted single tests member");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(single)));
    expect(validateWorkflow(selected.policy, stringify(workflow()), lock)).toEqual({
      jobs: 7,
      members: 10,
    });
  });
  it.each([
    [
      "少了一份分片",
      (members) => members.filter((member) => member.key !== "integration-2"),
      "Incomplete matrix: tests",
    ],
    [
      "分片编号重复",
      (members) => {
        members[1].shard.index = 1;
        return members;
      },
      "Tests project must run exactly once across members: integration",
    ],
    [
      "分片总数和份数不符",
      (members) => {
        for (const member of members.slice(0, 2)) member.shard.count = 3;
        return members;
      },
      "Tests project must run exactly once across members: integration",
    ],
    [
      "一个项目没人跑",
      (members) => {
        members[2].projects = members[2].projects.filter((id) => id !== "e2e");
        return members;
      },
      "Tests project must run exactly once across members: e2e",
    ],
    [
      "一个项目跑了两次",
      (members) => {
        members[2].projects.push("integration");
        return members;
      },
      "Tests project must run exactly once across members: integration",
    ],
    [
      "分片成员带了两个项目",
      (members) => {
        members[0].projects.push("unit");
        return members;
      },
      "Sharded tests member must run exactly one project: integration-1",
    ],
    [
      "成员跑 tests 以外的项目",
      (members) => {
        members[2].projects.push("tooling");
        return members;
      },
      "Split tests member runs a project outside tests: others",
    ],
    [
      "成员没写项目",
      (members) => {
        delete members[2].projects;
        return members;
      },
      "Split tests member names no projects: others",
    ],
  ])("[ADR-0275] 反向：tests 拆分写错（%s）时策略被拒", (_name, mutate, message) => {
    const value = clone();
    const tests = value.checks.find((check) => check.id === "tests");
    tests.members = mutate(tests.members);
    expect(() => validatePolicy(value)).toThrow(message);
  });
  it("[ADR-0275] 反向：tests 以外的作业写了项目拆分时策略被拒", () => {
    const value = clone();
    value.checks.find((check) => check.id === "tooling").members[0].projects = ["tooling"];
    expect(() => validatePolicy(value)).toThrow("Only tests members may split projects: tooling");
  });
  it("[ADR-0275] 反向：工作流里 tests 的矩阵和策略的拆分不一致时被拒", () => {
    const value = workflow();
    const include = structuredClone(value.jobs.tests.strategy.matrix.include);
    include[1].shard = { index: 1, count: 2 };
    value.jobs.tests.strategy.matrix.include = include;
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      "Matrix members differ: tests",
    );
  });
  it("[ADR-0267] 反向：policy 作业重新带上 tooling、tests 带上 tooling 或 tooling 回到 CI 服务器，策略都被拒", () => {
    const withTooling = clone();
    withTooling.checks.find((check) => check.id === "policy").projects = ["tooling"];
    expect(() => validatePolicy(withTooling)).toThrow("Incomplete project selection: policy");
    const testsWithTooling = clone();
    testsWithTooling.checks.find((check) => check.id === "tests").projects.push("tooling");
    expect(() => validatePolicy(testsWithTooling)).toThrow("Incomplete project selection: tests");
    const toolingOnVps = clone();
    const member = toolingOnVps.checks.find((check) => check.id === "tooling").members[0];
    member.runner = linuxRunnerLabel;
    delete member.alternateArch;
    expect(() => validatePolicy(toolingOnVps)).toThrow("Incorrect platform: tooling/default");
  });
  it("[ADR-0287] 基准上三项检查没有 alternateArch 的策略升级成在 ci-arm 上跑，摘要仍按原始字节算", () => {
    expect(legacyArmChecks).toEqual(["policy", "static", "tooling", "security"]);
    expect(armChecks).toEqual(["policy", "tooling", "security"]);
    const { root, git } = fixtureRepository();
    const accepted = armOnSharedRunner(coverageShaped());
    expect(() => validatePolicy(accepted)).toThrow();
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted checks without alternateArch");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(accepted)));
    for (const id of armChecks)
      expect(selected.policy.checks.find((check) => check.id === id).members).toEqual([
        {
          key: "default",
          runner: armRunnerLabel,
          os: "linux",
          arch: "x64",
          alternateArch: "arm64",
          node: "22.22.3",
        },
      ]);
    expect(validateWorkflow(selected.policy, stringify(workflow()), lock)).toEqual({
      jobs: 7,
      members: 10,
    });
  });
  it("[ADR-0287] 三项检查还在共享 runner 上的写法一起升级成 ci-arm，现行策略原样返回，只有部分搬过去的混写照样被拒", () => {
    expect(upgradeArmRunnerPolicy(policy)).toBe(policy);
    expect(upgradeArmRunnerPolicy(armOnSharedRunner(coverageShaped()))).toEqual(coverageShaped());
    const withAlternate = armOnSharedRunner(coverageShaped());
    for (const check of withAlternate.checks)
      if (legacyArmChecks.includes(check.id)) check.members[0].alternateArch = "arm64";
    expect(upgradeArmRunnerPolicy(withAlternate)).toEqual(coverageShaped());
    const mixed = armOnSharedRunner(coverageShaped());
    mixed.checks.find((check) => check.id === "security").members[0].runner =
      legacyRunnerLabels.arm;
    expect(upgradeArmRunnerPolicy(mixed)).toBe(mixed);
    expect(() =>
      validatePolicy(upgradeRetiredBrowserCheck(upgradeSelfHostedRunners(toCurrentTests(mixed)))),
    ).toThrow("Incorrect platform: policy/default");
  });
  it.each([
    ["build 允许 arm64", "build", { alternateArch: "arm64" }],
    ["tests 写成 arm64", "tests", { arch: "arm64" }],
    ["tooling 放回 x64 机器", "tooling", { runner: linuxRunnerLabel }],
    ["static 允许 arm64", "static", { alternateArch: "arm64" }],
    ["security 放到汇总 runner", "security", { runner: gateRunnerLabel }],
    ["static 放到 ARM 机器", "static", { runner: armRunnerLabel }],
    ["tests 放到 ARM 机器", "tests", { runner: armRunnerLabel }],
    ["policy 写成 arm64", "policy", { arch: "arm64" }],
  ])("[ADR-0287] 策略里%s就被拒", (_label, id, change) => {
    const value = clone();
    const member = value.checks.find((check) => check.id === id).members[0];
    for (const [key, entry] of Object.entries(change))
      if (entry === undefined) delete member[key];
      else member[key] = entry;
    expect(() => validatePolicy(value)).toThrow(`Incorrect platform: ${id}/`);
  });
  it.each([
    ["static", "ci-vps"],
    ["security", "ci-vps"],
    ["policy", "ci-vps"],
    ["tests", "ci-arm"],
    ["tooling", "ci-vps"],
    ["build", "ci-arm"],
  ])("[ADR-0287] ci.yml 里 %s 的 runs-on 写成 %s 就被拒", (id, label) => {
    const value = workflow();
    value.jobs[id]["runs-on"] = label;
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow();
  });
  it("汇总作业还在用 ssh 从别的机器拉报告（--remote-jobs）就被拒", () => {
    const value = workflow();
    const collect = value.jobs.required.steps.find((step) =>
      step.run?.includes("run-share.mjs collect"),
    );
    collect.run = `${collect.run} --remote-jobs ${armChecks.join(",")}`;
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      "Required must collect digest-checked reports from the run share",
    );
  });
  it("[ADR-0287] 试跑工作流已删除，ci.yml 和 main.yml 里没有它的痕迹", () => {
    const read = (name) =>
      readFileSync(path.join(repositoryRoot, ".github/workflows", name), "utf8");
    expect(existsSync(path.join(repositoryRoot, ".github/workflows/ci-arm-trial.yml"))).toBe(false);
    expect(read("ci.yml")).not.toContain("ci-arm-trial");
    expect(read("main.yml")).not.toContain("ci-arm-trial");
  });
  it.each(["test", "node-floor"])("工作流里多出 %s 作业就被拒", (id) => {
    const value = workflow();
    value.jobs[id] = structuredClone(value.jobs.security);
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow();
  });
  it.each(["e2e", "pi-compat"])("tests 作业缺 %s 就被拒", (project) => {
    const value = clone();
    const tests = value.checks.find((check) => check.id === "tests");
    tests.projects = tests.projects.filter((id) => id !== project);
    expect(() => validatePolicy(value)).toThrow();
  });
  it("[HR-11] 工作流里留下一处 hermes-home 就被拒", () => {
    const value = workflow();
    const include = structuredClone(value.jobs.tests.strategy.matrix.include);
    include[0].runner = "hermes-home";
    value.jobs.tests.strategy.matrix.include = include;
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow();
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/main.yml",
      ".github/workflows/quality.yml",
      ".github/actionlint.yaml",
    ])
      expect(readFileSync(path.join(repositoryRoot, file), "utf8")).not.toContain("hermes-home");
  });
  it("迁移旧采集政策时保留原始来源、阈值和其他要求", () => {
    const { root, git } = fixtureRepository();
    const old = coverageShaped();
    const coverage = old.checks.find((entry) => entry.id === "coverage");
    coverage.projects = ["unit", "contracts", "tooling"];
    coverage.needs = ["policy"];
    coverage.outputs = ["json", "lcov"];
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(old));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted legacy policy");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(old)));
    expect(selected.coverage).toEqual(reviewedCoverage());
  });
  it("仅迁移旧 integration 调度而保留已接受的文件清单和其他门禁", () => {
    const { root, git } = fixtureRepository();
    const old = clone();
    const integration = old.testProjects.find((entry) => entry.id === "integration");
    integration.fileParallelism = false;
    delete integration.workerLimits;
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(old));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted serial integration");
    const proposed = clone();
    proposed.testProjects.find((entry) => entry.id === "integration").include = ["hidden/**"];
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(proposed));
    const selected = resolvePolicySource({ root });
    const expected = structuredClone(old);
    Object.assign(
      expected.testProjects.find((entry) => entry.id === "integration"),
      {
        fileParallelism: true,
        workerLimits: {
          maximum: 3,
          cpusPerWorker: 1,
          memoryMiBPerWorker: 2048,
        },
      },
    );
    expect(selected.policy).toEqual(expected);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(old)));
    expect(selected.coverage).toEqual(reviewedCoverage());
  });
  it("把已接受的 2026-10-14 之前 integration 预算换成当前固定预算一次", () => {
    const { root, git } = fixtureRepository();
    const accepted = clone();
    accepted.testProjects.find((entry) => entry.id === "integration").workerLimits = {
      maximum: 4,
      cpusPerWorker: 2,
      memoryMiBPerWorker: 2048,
    };
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted 2026-09-29 integration budget");
    const selected = resolvePolicySource({ root });
    expect(
      selected.policy.testProjects.find((entry) => entry.id === "integration").workerLimits,
    ).toEqual({ maximum: 3, cpusPerWorker: 1, memoryMiBPerWorker: 2048 });
    expect(selected.policySha256).toBe(sha256(JSON.stringify(accepted)));
    expect(selected.coverage).toEqual(reviewedCoverage());
  });
  it("保留其他已接受的 integration 预算并让政策检查照常报漂移", async () => {
    const { root, git } = fixtureRepository();
    const accepted = clone();
    accepted.testProjects.find((entry) => entry.id === "integration").workerLimits = {
      maximum: 3,
      cpusPerWorker: 1024,
      memoryMiBPerWorker: 2048,
    };
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted unrelated integration budget");
    const selected = resolvePolicySource({ root });
    expect(
      selected.policy.testProjects.find((entry) => entry.id === "integration").workerLimits,
    ).toEqual({ maximum: 3, cpusPerWorker: 1024, memoryMiBPerWorker: 2048 });
    const configuration = await import("../../vitest.workspace.ts");
    const integration = configuration.default.test.projects.find(
      (project) => project.test.name === "integration",
    );
    expect(integration.test.maxWorkers).toBeGreaterThan(1);
    expect(() => validateVitestProjects(selected.policy, configuration.default)).toThrow(
      "Vitest integration worker count differs from policy",
    );
  });
  it.each(
    ["tests"].flatMap((id) =>
      ["missing", "wrong digest", "conditional", "wrong path", "duplicated"].map((fault) => [
        id,
        fault,
      ]),
    ),
  )("拒绝 %s 从 CI 服务器取构建的配置错误：%s", (id, fault) => {
    const value = workflow();
    const steps = value.jobs[id].steps;
    const fetch = steps.find((entry) => entry.run?.includes("run-share.mjs get"));
    if (fault === "missing") steps.splice(steps.indexOf(fetch), 1);
    if (fault === "wrong digest") fetch.env.CI_BUILD_DIGEST = "other-build";
    if (fault === "conditional") fetch.if = "false";
    if (fault === "wrong path") fetch.run = fetch.run.replace(".ci-output/input", ".ci-output/x");
    if (fault === "duplicated") steps.push(structuredClone(fetch));
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      `${id} must take this attempt's Linux build from the runner share by digest`,
    );
  });
  it.each(
    ["tests"].flatMap((id) =>
      ["missing", "after fetch", "conditional", "wrong key", "may miss"].map((fault) => [
        id,
        fault,
      ]),
    ),
  )("拒绝 %s 不先从本次运行的缓存取回构建：%s", (id, fault) => {
    const value = workflow();
    const steps = value.jobs[id].steps;
    const restore = steps.find((entry) => entry.uses?.startsWith("actions/cache/restore@"));
    const fetch = steps.find((entry) => entry.run?.includes("run-share.mjs get"));
    if (fault === "missing") steps.splice(steps.indexOf(restore), 1);
    if (fault === "after fetch") {
      steps.splice(steps.indexOf(restore), 1);
      steps.splice(steps.indexOf(fetch) + 1, 0, restore);
    }
    if (fault === "conditional") restore.if = "success()";
    if (fault === "wrong key") restore.with.key = "ci-share-build-linux-x64";
    if (fault === "may miss") delete restore.with["fail-on-cache-miss"];
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      `${id} must restore this attempt's Linux build from the run cache before taking it`,
    );
  });
  it.each(["missing", "duplicated", "before put", "always", "wrong path", "wrong key"])(
    "拒绝检查作业不把报告存进本次运行的缓存：%s",
    (fault) => {
      const value = workflow();
      const steps = value.jobs.static.steps;
      const save = steps.find((entry) => entry.uses?.startsWith("actions/cache/save@"));
      const put = steps.find((entry) => entry.id === "share");
      if (fault === "missing") steps.splice(steps.indexOf(save), 1);
      if (fault === "duplicated") steps.push(structuredClone(save));
      if (fault === "before put") {
        steps.splice(steps.indexOf(save), 1);
        steps.splice(steps.indexOf(put), 0, save);
      }
      if (fault === "always") save.if = githubExpression("always()");
      if (fault === "wrong path") save.with.path = "/tmp/share";
      if (fault === "wrong key") save.with.key = "ci-share-static";
      expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
        "Job must save its shared reports to this run's cache exactly once: static",
      );
    },
  );
  it.each(["missing", "conditional", "required to hit", "after collect"])(
    "拒绝汇总作业没在收齐前从缓存取回每个成员的报告：%s",
    (fault) => {
      const value = workflow();
      const steps = value.jobs.required.steps;
      const restore = steps.find(
        (entry) =>
          entry.uses?.startsWith("actions/cache/restore@") &&
          entry.with.key.endsWith("-tests-integration-2"),
      );
      const collect = steps.find((entry) => entry.run?.includes("run-share.mjs collect"));
      if (fault === "missing") steps.splice(steps.indexOf(restore), 1);
      if (fault === "conditional") restore.if = REQUIRED_AFTER_ENTRY;
      if (fault === "required to hit") restore.with["fail-on-cache-miss"] = true;
      if (fault === "after collect") {
        steps.splice(steps.indexOf(restore), 1);
        steps.splice(steps.indexOf(collect) + 1, 0, restore);
      }
      expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
        "Required must restore every member's reports from the run cache before collecting: tests-integration-2",
      );
    },
  );
  it.each(["policy", "required", "tests"])("拒绝作业没把共享目录指到本机临时目录：%s", (id) => {
    const value = workflow();
    const steps = value.jobs[id].steps;
    steps.splice(
      steps.findIndex((entry) => entry.run === SHARE_ROOT_COMMAND),
      1,
    );
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      `Job must point the run share at this runner's temporary directory exactly once: ${id}`,
    );
  });
  it.each([
    "missing put",
    "second put",
    "renamed id",
    "missing output",
    "extra output",
    "wrong output",
  ])("拒绝报告不放 CI 服务器或摘要没交出去：%s", (fault) => {
    const value = workflow();
    const job = value.jobs.tests;
    const put = job.steps.find((entry) => entry.id === "share");
    if (fault === "missing put") job.steps.splice(job.steps.indexOf(put), 1);
    if (fault === "second put") job.steps.push({ ...put, id: "again" });
    if (fault === "renamed id") put.id = "other";
    if (fault === "missing output") delete job.outputs.others;
    if (fault === "extra output") job.outputs["macos-arm64"] = "x";
    if (fault === "wrong output")
      job.outputs["integration-2"] = githubExpression("steps.other.outputs.integration-2");
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      /runner share|report digest/u,
    );
  });
  it.each(["missing collect", "conditional collect"])(
    "拒绝汇总不从共享目录收齐报告：%s",
    (fault) => {
      const value = workflow();
      const steps = value.jobs.required.steps;
      const collect = steps.find((entry) => entry.run?.includes("run-share.mjs collect"));
      if (fault === "missing collect") steps.splice(steps.indexOf(collect), 1);
      if (fault === "conditional collect") collect.if = "success()";
      expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
        "Required must collect digest-checked reports",
      );
    },
  );
  it("keeps result schemas closed", () => {
    expect(() => validateRecord("Context", { surprise: true })).toThrow();
  });
  it("rejects tests inside production coverage before collecting coverage", () => {
    const coverage = readJson(path.join(repositoryRoot, "ci/coverage-policy.json"));
    expect(() =>
      validateTestPlacement(["apps/execution-worker/src/product-job-host.unit.test.ts"], coverage),
    ).toThrow("Test file overlaps production coverage");
    expect(() =>
      validateTestPlacement(
        [
          "apps/execution-worker/src/product-job-host.ts",
          "apps/execution-worker/test/product-job-host.unit.test.ts",
          "packages/runtime-pi/test/example.compat.test.ts",
        ],
        coverage,
      ),
    ).not.toThrow();
  });
  const repositoryFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const repositoryInventory = planTestInventory(policy, [...new Set(repositoryFiles)]);
  it("assigns every current repository test to exactly one project or registration", () => {
    expect(repositoryInventory.files).toBeGreaterThan(100);
    expect(repositoryInventory.entries).toHaveLength(repositoryInventory.files);
  });
  it.each(repositoryInventory.entries)(
    "validates executable test source: $filename",
    ({ filename, registration }) => {
      expect(() =>
        validateTestFileSource(
          readFileSync(path.join(repositoryRoot, filename), "utf8"),
          filename,
          registration,
        ),
      ).not.toThrow();
    },
  );
});

describe("[R2-H1] 测试卫生门禁", () => {
  const file = "apps/a/src/a.unit.test.ts";
  const hygieneFixture = (name) =>
    readFileSync(path.join(repositoryRoot, "test/tooling/fixtures/test-hygiene", name), "utf8");
  const baseline = (mode, entries) => ({ schemaVersion: 1, mode, entries });
  const finding = (kind, line, path = file) => ({ path, kind, line });
  const codes = (result) => result.violations.map((violation) => violation.code);
  const violation = (result, code) =>
    result.violations.find((entry) => entry.code === code).message;

  it("[R2-H1] 逐用例模块重置只认 Vitest 的 vi 对象", () => {
    expect(
      inspectTestSource(hygieneFixture("module-reset.dirty.ts.txt"), "dirty.unit.test.ts").hygiene,
    ).toEqual([{ kind: "module-reset", line: 4 }]);
    expect(
      inspectTestSource(hygieneFixture("module-reset.clean.ts.txt"), "clean.unit.test.ts").hygiene,
    ).toEqual([]);
  });
  it("[R2-H1] 100 毫秒以上的真实等待才拦", () => {
    expect(
      inspectTestSource(hygieneFixture("real-wait.dirty.ts.txt"), "dirty.unit.test.ts").hygiene,
    ).toEqual([
      { kind: "real-wait", line: 5 },
      { kind: "real-wait", line: 9 },
      { kind: "real-wait", line: 13 },
    ]);
    expect(
      inspectTestSource(hygieneFixture("real-wait.clean.ts.txt"), "clean.unit.test.ts").hygiene,
    ).toEqual([]);
  });
  it("[R2-H1] 固定端口监听被拦而 0 端口放行", () => {
    expect(
      inspectTestSource(hygieneFixture("fixed-port.dirty.ts.txt"), "dirty.unit.test.ts").hygiene,
    ).toEqual([
      { kind: "fixed-port", line: 7 },
      { kind: "fixed-port", line: 11 },
    ]);
    expect(
      inspectTestSource(hygieneFixture("fixed-port.clean.ts.txt"), "clean.unit.test.ts").hygiene,
    ).toEqual([]);
  });
  it("[R2-H1] 普通单测读取生产源码文本被拦", () => {
    const source = hygieneFixture("production-source-read.dirty.unit.ts.txt");
    expect(inspectTestSource(source, "dirty.unit.test.ts").hygiene).toEqual([
      { kind: "production-source-read", line: 7 },
      { kind: "production-source-read", line: 12 },
    ]);
    expect(inspectTestSource(source, "dirty.contract.test.ts").hygiene).toEqual([]);
    expect(
      inspectTestSource(hygieneFixture("production-source-read.clean.ts.txt"), "clean.unit.test.ts")
        .hygiene,
    ).toEqual([]);
  });
  it("[R2-H1] 基线等于现状时不报错", () => {
    const accepted = baseline("report", [{ path: file, kind: "module-reset", count: 1 }]);
    const result = evaluateTestHygiene({
      findings: [finding("module-reset", 3)],
      workspace: accepted,
      accepted,
    });
    expect(result.violations).toEqual([]);
  });
  it("[R2-H1] 发现数超过基线时指到文件和行", () => {
    const accepted = baseline("report", [{ path: file, kind: "module-reset", count: 1 }]);
    const result = evaluateTestHygiene({
      findings: [finding("module-reset", 3), finding("module-reset", 7)],
      workspace: accepted,
      accepted,
    });
    expect(codes(result)).toContain("TEST_HYGIENE_EXCESS");
    expect(violation(result, "TEST_HYGIENE_EXCESS")).toContain(`${file}:7`);
    expect(violation(result, "TEST_HYGIENE_EXCESS")).toContain("module-reset");
  });
  it("[R2-H1] 基线可收紧未收紧时给出建议值", () => {
    const accepted = baseline("report", [{ path: file, kind: "module-reset", count: 2 }]);
    const result = evaluateTestHygiene({
      findings: [finding("module-reset", 3)],
      workspace: accepted,
      accepted,
    });
    expect(codes(result)).toContain("TEST_HYGIENE_STALE");
    expect(violation(result, "TEST_HYGIENE_STALE")).toContain("lower the entry to 1");
  });
  it("[R2-H1] 工作区基线不得比基准提交多出条目", () => {
    const accepted = baseline("report", []);
    const workspace = baseline("report", [{ path: file, kind: "module-reset", count: 1 }]);
    const result = evaluateTestHygiene({
      findings: [finding("module-reset", 3)],
      workspace,
      accepted,
    });
    expect(codes(result)).toContain("TEST_HYGIENE_UNACCEPTED");
    expect(violation(result, "TEST_HYGIENE_UNACCEPTED")).toContain(file);
  });
  it("[R2-H1] 工作区基线不得比基准提交调高数量", () => {
    const accepted = baseline("report", [{ path: file, kind: "module-reset", count: 1 }]);
    const workspace = baseline("report", [{ path: file, kind: "module-reset", count: 2 }]);
    const result = evaluateTestHygiene({
      findings: [finding("module-reset", 3), finding("module-reset", 7)],
      workspace,
      accepted,
    });
    expect(codes(result)).toContain("TEST_HYGIENE_RAISED");
    expect(violation(result, "TEST_HYGIENE_RAISED")).toContain("baseline is 2");
  });
  it("[R2-H1] 工作区不得把阻断模式降回只报告", () => {
    const entries = [{ path: file, kind: "module-reset", count: 1 }];
    const result = evaluateTestHygiene({
      findings: [finding("module-reset", 3)],
      workspace: baseline("report", entries),
      accepted: baseline("enforce", entries),
    });
    expect(codes(result)).toContain("TEST_HYGIENE_MODE_WEAKENED");
  });
  it("[R2-H1] 只报告模式打印文件行号且不抛错", () => {
    const { root, git } = fixtureRepository();
    const workspace = baseline("report", [
      { path: file, kind: "module-reset", count: 1 },
      { path: file, kind: "real-wait", count: 1 },
    ]);
    writeFileSync(path.join(root, "ci/test-hygiene-baseline.json"), JSON.stringify(workspace));
    git("add", "ci");
    git("commit", "--quiet", "-m", "hygiene baseline");
    const written = [];
    const result = validateTestHygiene({
      root,
      findings: [finding("module-reset", 3), finding("module-reset", 7)],
      write: (line) => written.push(line),
    });
    expect(written).toContain(`TEST_HYGIENE_FINDING ${file}:3 module-reset\n`);
    expect(written.some((line) => line.startsWith("TEST_HYGIENE_EXCESS:"))).toBe(true);
    expect(written.some((line) => line.startsWith("TEST_HYGIENE_STALE:"))).toBe(true);
    expect(result.summary).toContain("mode=report");
    expect(written.at(-1)).toBe(`${result.summary}\n`);
  });
  it("[R2-H1] 基准提交的基线优先于工作区手改", () => {
    const { root, git } = fixtureRepository();
    const accepted = baseline("enforce", [{ path: file, kind: "module-reset", count: 1 }]);
    const baselinePath = path.join(root, "ci/test-hygiene-baseline.json");
    writeFileSync(baselinePath, JSON.stringify(accepted));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted hygiene baseline");
    const workspace = baseline("report", [{ path: file, kind: "module-reset", count: 5 }]);
    writeFileSync(baselinePath, JSON.stringify(workspace));
    const resolved = resolveTestHygieneBaseline({ root });
    expect(resolved.initialization).toBe(false);
    expect(resolved.baseline).toEqual(accepted);
    const result = evaluateTestHygiene({
      findings: [3, 4, 5, 6, 7].map((line) => finding("module-reset", line)),
      workspace,
      accepted: resolved.baseline,
    });
    expect(codes(result)).toContain("TEST_HYGIENE_RAISED");
    expect(codes(result)).toContain("TEST_HYGIENE_MODE_WEAKENED");
  });
  it.each([
    [
      "未排序",
      {
        schemaVersion: 1,
        mode: "report",
        entries: [
          { path: "b/x.unit.test.ts", kind: "module-reset", count: 1 },
          { path: "a/x.unit.test.ts", kind: "module-reset", count: 1 },
        ],
      },
    ],
    [
      "未知类别",
      {
        schemaVersion: 1,
        mode: "report",
        entries: [{ path: "a/x.unit.test.ts", kind: "slow", count: 1 }],
      },
    ],
    [
      "零计数",
      {
        schemaVersion: 1,
        mode: "report",
        entries: [{ path: "a/x.unit.test.ts", kind: "module-reset", count: 0 }],
      },
    ],
    ["未知模式", { schemaVersion: 1, mode: "off", entries: [] }],
  ])("[R2-H1] 基线文件结构损坏时关闭放行：%s", (_name, value) => {
    expect(() => parseTestHygieneBaseline(value)).toThrow("TEST_HYGIENE_BASELINE_INVALID");
  });
});

describe("GitHub 托管机器白名单", () => {
  const job = (runsOn, extra = {}) => ({
    jobs: { only: { "runs-on": runsOn, steps: [], ...extra } },
  });
  it("只用三种免费标准机器的工作流通过，仓库里的全部工作流都通过", () => {
    expect(hostedRunnerLabels).toEqual(["ubuntu-24.04", "ubuntu-24.04-arm", "macos-26"]);
    for (const label of hostedRunnerLabels)
      expect(() => validateHostedRunners({ "a.yml": stringify(job(label)) })).not.toThrow();
    expect(() =>
      validateHostedRunners({
        "a.yml": stringify(
          job(githubExpression("matrix.runner"), {
            strategy: {
              matrix: {
                include: [{ runner: "ubuntu-24.04" }, { runner: "macos-26" }],
              },
            },
          }),
        ),
        "b.yml": stringify({
          jobs: { call: { uses: "./.github/workflows/ci.yml" } },
        }),
      }),
    ).not.toThrow();
    const directory = path.join(repositoryRoot, ".github/workflows");
    expect(() =>
      validateHostedRunners(
        Object.fromEntries(
          readdirSync(directory).map((name) => [
            name,
            readFileSync(path.join(directory, name), "utf8"),
          ]),
        ),
      ),
    ).not.toThrow();
  });
  it.each([
    ["自托管标签", "ci-vps"],
    ["self-hosted 数组", ["self-hosted", "linux"]],
    ["larger runner", "ubuntu-24.04-16core"],
    ["会收费的 xlarge", "macos-26-xlarge"],
    ["浮动标签", "ubuntu-latest"],
    ["表达式", githubExpression("inputs.runner")],
    ["分组", { group: "paid" }],
    ["没写", undefined],
  ])("拒绝%s", (_name, label) => {
    expect(() => validateHostedRunners({ "a.yml": stringify(job(label)) })).toThrow(
      "HOSTED_RUNNER_REQUIRED a.yml/only",
    );
  });
  it("矩阵里有一个成员不在白名单就被拒", () => {
    expect(() =>
      validateHostedRunners({
        "a.yml": stringify(
          job(githubExpression("matrix.runner"), {
            strategy: {
              matrix: {
                include: [{ runner: "ubuntu-24.04" }, { runner: "ci-arm" }],
              },
            },
          }),
        ),
      }),
    ).toThrow("HOSTED_RUNNER_REQUIRED a.yml/only");
  });
  it("main 上还是自托管标签的策略在基准上整体换成托管机器，摘要仍按原始字节算", () => {
    const { root, git } = fixtureRepository();
    const accepted = legacyClone();
    expect(() => validatePolicy(accepted)).toThrow(
      "runner must be equal to one of the allowed values",
    );
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(accepted));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted self-hosted runners");
    const selected = resolvePolicySource({ root });
    expect(selected.policy).toEqual(policy);
    expect(selected.policySha256).toBe(sha256(JSON.stringify(accepted)));
    expect(upgradeSelfHostedRunners(policy)).toBe(policy);
  });
  it("旧标签和托管标签混写、或 macOS 成员没暂停的基准策略不升级，照样被拒", () => {
    const mixed = legacyClone();
    mixed.checks.find((check) => check.id === "static").members[0].runner = armRunnerLabel;
    expect(upgradeSelfHostedRunners(mixed)).toBe(mixed);
    expect(() => validatePolicy(upgradeSelfHostedRunners(mixed))).toThrow();
    const unpausedMac = legacyClone();
    for (const check of unpausedMac.checks)
      for (const member of check.members) if (member.key === "macos-arm64") delete member.paused;
    expect(upgradeSelfHostedRunners(unpausedMac)).toBe(unpausedMac);
    expect(() => validatePolicy(upgradeSelfHostedRunners(unpausedMac))).toThrow();
  });
});
