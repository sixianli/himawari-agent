import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  inspectTestSource,
  resolvePolicySource,
  validatePolicy,
  validateTestInventory,
  validateVitestProjects,
  validateWorkflow,
} from "../../scripts/ci/check-policy.mjs";
import {
  githubExpression,
  readJson,
  repositoryRoot,
  validateRecord,
} from "../../scripts/ci/contracts.mjs";

const policy = readJson(path.join(repositoryRoot, "ci/policy.json"));
const clone = () => structuredClone(policy);
const checkout = {
  repository: "actions/checkout",
  version: "v4",
  sha: "a".repeat(40),
  license: "MIT",
};
const lock = { actions: [checkout] };
const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function workflow() {
  return {
    name: "CI",
    on: {
      pull_request: { types: ["opened", "synchronize", "reopened", "ready_for_review", "edited"] },
      push: { branches: ["main"] },
      workflow_dispatch: {},
    },
    permissions: { contents: "read" },
    concurrency: {
      group: [
        "github.workflow",
        "github.event_name",
        "github.event.pull_request.number || github.ref",
        "github.event_name == 'push' && github.run_id || ''",
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
            ? { strategy: { "fail-fast": false, matrix: { include: check.members } } }
            : {}),
          ...(check.id === "required"
            ? { name: "ci/required", if: githubExpression("always()") }
            : {}),
          steps: [
            { uses: `actions/checkout@${checkout.sha}`, with: { "persist-credentials": false } },
            { run: "node scripts/ci/run.mjs" },
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
    expect(validateVitestProjects(policy, vitestConfig()).projects).toBe(10);
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

  it("accepts the exact nine-job policy and literal execution graph", () => {
    expect(validatePolicy(policy)).toBe(policy);
    expect(validateWorkflow(policy, stringify(workflow()), lock)).toEqual({ jobs: 9, members: 13 });
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
      "parallel integration",
      (value) => {
        value.testProjects.find((project) => project.id === "integration").fileParallelism = true;
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
        value.checks.find((check) => check.id === "test").projects.pop();
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
        value.jobs.test.needs = ["policy"];
      },
    ],
    [
      "matrix omission",
      (value) => {
        value.jobs.build.strategy.matrix.include = [
          policy.checks.find((check) => check.id === "build").members[0],
        ];
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
        value.jobs.test.strategy["fail-fast"] = true;
      },
    ],
    [
      "required skip",
      (value) => {
        value.jobs.required.if = "success()";
      },
    ],
    [
      "conditional test",
      (value) => {
        value.jobs.test.if = githubExpression("!github.event.pull_request.draft");
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
    proposed.retentionDays.reports = 1;
    writeFileSync(path.join(root, "ci/policy.json"), JSON.stringify(proposed));
    writeFileSync(path.join(root, "ci/coverage-policy.json"), JSON.stringify({ baseline: 0 }));
    const selected = resolvePolicySource({ root });
    expect(selected.initialization).toBe(false);
    expect(selected.policy.retentionDays.reports).toBe(30);
    expect(selected.coverage.baseline.groups["scripts/ci"].lines.pct).toBe(80);
    expect(() => resolvePolicySource({ root, base: "--help" })).toThrow();
    expect(() => resolvePolicySource({ root, base: "f".repeat(40) })).toThrow();
  });
  it("keeps result schemas closed", () => {
    expect(() => validateRecord("Context", { surprise: true })).toThrow();
  });
  it("assigns the repository's current tests without source-text false positives", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    expect(
      validateTestInventory(policy, [...new Set(files)], (file) =>
        readFileSync(path.join(repositoryRoot, file), "utf8"),
      ).files,
    ).toBeGreaterThan(100);
  });
});
