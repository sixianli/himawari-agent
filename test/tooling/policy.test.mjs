import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  chromiumInstall,
  evaluateTestHygiene,
  inspectTestSource,
  parseTestHygieneBaseline,
  planTestInventory,
  main as policyMain,
  resolvePolicySource,
  resolveTestHygieneBaseline,
  upgradeHostedRunnerPolicy,
  upgradeRetiredTestChecks,
  upgradeRunnerLabel,
  validatePolicy,
  validateTestFileSource,
  validateTestHygiene,
  validateTestInventory,
  validateTestPlacement,
  validateVitestProjects,
  validateWorkflow,
} from "../../scripts/ci/check-policy.mjs";
import {
  activeMembers,
  expectedMembers,
  githubExpression,
  linuxRunnerLabel,
  readJson,
  repositoryRoot,
  sha256,
  validateRecord,
} from "../../scripts/ci/contracts.mjs";
import { testWorkerCount } from "../../scripts/ci/test-concurrency.mjs";

const policy = readJson(path.join(repositoryRoot, "ci/policy.json"));
const clone = () => structuredClone(policy);
const checkout = {
  repository: "actions/checkout",
  version: "v4",
  sha: "a".repeat(40),
  license: "MIT",
};
const lock = {
  actions: [
    checkout,
    { repository: "actions/download-artifact", sha: "d3f86a106a0bac45b974a628896c90dbdf5c8093" },
    { repository: "actions/upload-artifact", sha: "ea165f8d65b6e75b540449e92b4886f43607fa02" },
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
const shareRemove = () => ({ if: "always()", run: `${shareCommand} remove` });

function workflow() {
  return {
    name: "CI",
    on: {
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review", "edited"] },
      workflow_call: { inputs: { base_sha: { required: false, type: "string" } } },
      workflow_dispatch: {},
    },
    permissions: { contents: "read" },
    concurrency: {
      group: [
        "github.workflow",
        "github.event_name",
        "github.event.pull_request.number || github.ref",
        "github.event_name == 'push' && github.run_id || ''",
        "github.event.action == 'edited' && 'edited' || ''",
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
            ? { strategy: { "fail-fast": false, matrix: { include: activeMembers(check) } } }
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
          ...(["browser", "coverage"].includes(check.id)
            ? {
                if: githubExpression(
                  "github.event_name != 'pull_request' || github.event.pull_request.draft != true",
                ),
              }
            : {}),
          steps: [
            { uses: `actions/checkout@${checkout.sha}`, with: { "persist-credentials": false } },
            {
              run:
                check.id === "coverage"
                  ? '.ci-output/tools/bin/node scripts/ci/run.mjs --check coverage --matrix "$CI_MATRIX" --base "$CI_BASE" --tools .ci-output/tools --output .ci-output/check --baseline-candidate initial-only --input .ci-output/input/result.json'
                  : "node scripts/ci/run.mjs",
            },
            ...(["browser", "coverage"].includes(check.id) ? [buildFetch()] : []),
            ...(check.id === "required" ? [shareCollect(), shareRemove()] : [sharePut(check)]),
            ...(["static", "coverage"].includes(check.id) ? [{ run: chromiumInstall }] : []),
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

describe("CI policy contract", () => {
  it("accepts Vitest main and qualification projects only when they agree with policy", () => {
    expect(validateVitestProjects(policy, vitestConfig()).projects).toBe(17);
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

  it("accepts the exact seven-job policy and literal execution graph", () => {
    expect(validatePolicy(policy)).toBe(policy);
    expect(validateWorkflow(policy, stringify(workflow()), lock)).toEqual({ jobs: 7, members: 10 });
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
        value.checks.find((check) => check.id === "coverage").projects.pop();
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
      "hosted Linux runner",
      (value) => {
        value.checks.find((check) => check.id === "static").members[0].runner = "ubuntu-24.04";
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
      "concurrency without the edited segment",
      (value) => {
        value.concurrency.group = value.concurrency.group.replace(
          ["-$", "{{ github.event.action == 'edited' && 'edited' || '' }}"].join(""),
          "",
        );
      },
    ],
    [
      "edited segment keyed by run id",
      (value) => {
        value.concurrency.group = value.concurrency.group.replace(
          "&& 'edited' ||",
          "&& github.run_id ||",
        );
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
        value.jobs.coverage.needs = ["policy"];
      },
    ],
    [
      "matrix omission",
      (value) => {
        value.jobs.browser.strategy.matrix.include = activeMembers(
          policy.checks.find((check) => check.id === "browser"),
        ).slice(1);
      },
    ],
    [
      "matrix expression",
      (value) => {
        value.jobs.browser.strategy.matrix = githubExpression(
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
      "other condition on coverage",
      (value) => {
        value.jobs.coverage.if = githubExpression("!github.event.pull_request.draft");
      },
    ],
    [
      "draft condition on policy",
      (value) => {
        value.jobs.policy.if = githubExpression(
          "github.event_name != 'pull_request' || github.event.pull_request.draft != true",
        );
      },
    ],
    [
      "missing draft condition on browser",
      (value) => {
        delete value.jobs.browser.if;
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
        value.jobs.required.permissions = { contents: "read", actions: "write" };
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
        value.jobs.policy.env = { TOKEN: githubExpression("secrets.PRODUCTION") };
      },
    ],
  ])("rejects workflow %s", (_name, mutate) => {
    const value = workflow();
    mutate(value);
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow();
  });
  it.each(["browser", "required"])("rejects a pinned GitHub artifact download in %s", (id) => {
    const value = workflow();
    value.jobs[id].steps.push({
      uses: `actions/download-artifact@${lock.actions.find((entry) => entry.repository === "actions/download-artifact").sha}`,
    });
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      `Jobs must take reports and builds from the runner share, not GitHub artifacts: ${id}`,
    );
  });
  it.each([
    ["static", ".ci-output/public/reports/", 1],
    ["static", ".ci-output/public/", 1],
    ["static", ".ci-output/public/diagnostics/", 7],
    ["required", ".ci-output/reports/", 1],
    ["required", ".ci-output/public/diagnostics/", 1],
  ])("rejects a %s upload of %s kept %s days", (id, uploadPath, days) => {
    const value = workflow();
    value.jobs[id].steps.push({
      uses: `actions/upload-artifact@${lock.actions.find((entry) => entry.repository === "actions/upload-artifact").sha}`,
      with: { name: "x", path: uploadPath, "retention-days": days },
    });
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(`Jobs may upload only`);
  });
  it("accepts one-day diagnostics uploads and the gate upload", () => {
    const value = workflow();
    const upload = `actions/upload-artifact@${lock.actions.find((entry) => entry.repository === "actions/upload-artifact").sha}`;
    value.jobs.static.steps.push({
      uses: upload,
      with: { name: "d", path: ".ci-output/public/diagnostics/", "retention-days": 1 },
    });
    value.jobs.required.steps.push({
      uses: upload,
      with: { name: "g", path: ".ci-output/gate/", "retention-days": 1 },
    });
    expect(() => validateWorkflow(policy, stringify(value), lock)).not.toThrow();
  });
  it("accepts read-only permissions on the gate job", () => {
    const value = workflow();
    value.jobs.required.permissions = { contents: "read", actions: "read" };
    expect(() => validateWorkflow(policy, stringify(value), lock)).not.toThrow();
  });
  it.each(["static", "coverage"])(
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
    "missing option",
    "always measure",
    "conditional runner",
    "duplicate runner",
    "direct baseline write",
  ])("rejects coverage candidate workflow drift: %s", (change) => {
    const value = workflow();
    const steps = value.jobs.coverage.steps;
    if (change === "missing option")
      steps[1].run = steps[1].run.replace(" --baseline-candidate initial-only", "");
    if (change === "always measure") steps[1].run = steps[1].run.replace("initial-only", "always");
    if (change === "conditional runner") steps[1].if = "false";
    if (change === "duplicate runner") steps.push({ ...steps[1] });
    if (change === "direct baseline write")
      steps[1].run =
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
    const hosted = clone();
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
    const mixed = clone();
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
      const value = clone();
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
    expect(() => validatePolicy(upgradeHostedRunnerPolicy(legacy))).not.toThrow();
    const wrongTimeout = hostedWithTimeouts((id) => (id === "build" ? 1 : legacyTimeout(id)));
    expect(upgradeHostedRunnerPolicy(wrongTimeout)).toBe(wrongTimeout);
    expect(() => validatePolicy(upgradeHostedRunnerPolicy(wrongTimeout))).toThrow();
  });
  const hermesPolicy = () => {
    const value = clone();
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
    expect(linuxRunnerLabel).toBe("ci-vps");
    expect(upgradeRunnerLabel(policy)).toBe(policy);
    const mixed = hermesPolicy();
    mixed.checks.find((check) => check.id === "static").members[0].runner = linuxRunnerLabel;
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
    const value = clone();
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
          { key: "linux-x64", runner: "ci-vps", os: "linux", arch: "x64", node: "22.22.3" },
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
        members: [{ key: "default", runner: "ci-vps", os: "linux", arch: "x64", node: "22.19.0" }],
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
    const upgraded = upgradeRetiredTestChecks(accepted);
    expect(upgraded).toEqual(policy);
    expect(accepted.checks.map((check) => check.id)).toContain("node-floor");
  });
  it.each(["test", "node-floor"])("工作流里多出 %s 作业就被拒", (id) => {
    const value = workflow();
    value.jobs[id] = structuredClone(value.jobs.security);
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow();
  });
  it.each(["e2e", "pi-compat"])("coverage 作业缺 %s 就被拒", (project) => {
    const value = clone();
    const coverage = value.checks.find((check) => check.id === "coverage");
    coverage.projects = coverage.projects.filter((id) => id !== project);
    expect(() => validatePolicy(value)).toThrow();
  });
  it("[HR-11] 工作流里留下一处 hermes-home 就被拒", () => {
    const value = workflow();
    const job = Object.values(value.jobs).find((entry) => entry["runs-on"] === linuxRunnerLabel);
    job["runs-on"] = "hermes-home";
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
    const old = clone();
    const coverage = old.checks.find((entry) => entry.id === "coverage");
    coverage.projects = ["unit", "contracts", "tooling"];
    coverage.needs = ["policy"];
    coverage.outputs = ["json", "lcov"];
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(old));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify(reviewedCoverage()));
    git("add", "ci");
    git("commit", "--quiet", "-m", "accepted legacy policy");
    const selected = resolvePolicySource({ root });
    expect(selected.policy.checks.find((entry) => entry.id === "coverage")).toMatchObject({
      projects: ["unit", "contracts", "tooling", "integration", "e2e", "pi-compat"],
      needs: ["policy", "build"],
      outputs: ["json", "lcov", "artifact"],
    });
    expect(selected.policy.checks.filter((entry) => entry.id !== "coverage")).toEqual(
      old.checks.filter((entry) => entry.id !== "coverage"),
    );
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
        workerLimits: { maximum: 3, cpusPerWorker: 1, memoryMiBPerWorker: 2048 },
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
    ["browser", "coverage"].flatMap((id) =>
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
  it.each([
    "missing put",
    "second put",
    "renamed id",
    "missing output",
    "extra output",
    "wrong output",
  ])("拒绝报告不放 CI 服务器或摘要没交出去：%s", (fault) => {
    const value = workflow();
    const job = value.jobs.browser;
    const put = job.steps.find((entry) => entry.id === "share");
    if (fault === "missing put") job.steps.splice(job.steps.indexOf(put), 1);
    if (fault === "second put") job.steps.push({ ...put, id: "again" });
    if (fault === "renamed id") put.id = "other";
    if (fault === "missing output") delete job.outputs.firefox;
    if (fault === "extra output") job.outputs["macos-arm64"] = "x";
    if (fault === "wrong output")
      job.outputs.webkit = githubExpression("steps.other.outputs.webkit");
    expect(() => validateWorkflow(policy, stringify(value), lock)).toThrow(
      /runner share|report digest/u,
    );
  });
  it.each(["missing collect", "conditional collect", "missing remove", "remove only on success"])(
    "拒绝汇总不从 CI 服务器收齐或不总是删掉本次目录：%s",
    (fault) => {
      const value = workflow();
      const steps = value.jobs.required.steps;
      const collect = steps.find((entry) => entry.run?.includes("run-share.mjs collect"));
      const remove = steps.find((entry) => entry.run?.includes("run-share.mjs remove"));
      if (fault === "missing collect") steps.splice(steps.indexOf(collect), 1);
      if (fault === "conditional collect") collect.if = "success()";
      if (fault === "missing remove") steps.splice(steps.indexOf(remove), 1);
      if (fault === "remove only on success") remove.if = "success()";
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
