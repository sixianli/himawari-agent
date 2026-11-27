import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { parseDocument } from "yaml";
import {
  activeMembers,
  armChecks,
  legacyArmChecks,
  armRunnerLabel,
  fileSha256,
  gateRunnerLabel,
  githubExpression,
  hostedRunnerLabels,
  legacyRunnerLabels,
  linuxRunnerLabel,
  macRunnerLabel,
  parseArguments,
  readJson,
  repositoryRoot,
  safeRelativePath,
  sha256,
  validateRecord,
} from "./contracts.mjs";
import { coverageProjects, inCoverageScope } from "./coverage-model.mjs";
import { validateCallerGrantsCalledPermissions, validateMainWorkflow } from "./main-workflow.mjs";
import { validateQualityWorkflow } from "./quality-policy.mjs";
import { integrationWorkerLimits, testWorkerCount } from "./test-concurrency.mjs";

const sorted = (values) => [...values].sort();
const sameSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
export const DRAFT_SKIP_CONDITION =
  "github.event_name != 'pull_request' || github.event.pull_request.draft != true";
export const REQUIRED_DRAFT =
  "github.event_name == 'pull_request' && github.event.pull_request.draft == true";
export const REQUIRED_CANCELLED = "contains(needs.*.result, 'cancelled')";
export const REQUIRED_ENTRY_SCRIPT = [
  'if [ "$CI_DRAFT" != false ]; then echo "CI_DRAFT_UNVERIFIED 草稿 PR 不跑 CI，标成准备合并后才跑完整检查"; exit 1; fi',
  'if [ "$CI_CANCELLED" != false ]; then echo "CI_UPSTREAM_CANCELLED 上游作业被取消，这一轮不算数"; exit 1; fi',
  "",
].join("\n");
export const REQUIRED_AFTER_ENTRY = githubExpression(
  "always() && steps.entry.outcome == 'success'",
);
export const SHARE_ROOT_COMMAND =
  'mkdir -p "$RUNNER_TEMP/ci-share" && echo "HIMAWARI_CI_SHARE=$RUNNER_TEMP/ci-share" >> "$GITHUB_ENV"';
const runShareKey = `${githubExpression("github.run_id")}-${githubExpression("github.run_attempt")}`;
export const sharePath = (name) =>
  `${githubExpression("runner.temp")}/ci-share/${runShareKey}/${name}`;
export const shareCacheKey = (name) => `ci-share-${runShareKey}-${name}`;
export const SHARE_AFTER_PUT = githubExpression("always() && steps.share.outcome == 'success'");
const actionRepository = (uses) => uses.split("@")[0].split("/").slice(0, 2).join("/");
const isCacheAction = (step, kind) =>
  typeof step.uses === "string" && step.uses.startsWith(`actions/cache/${kind}@`);
const restoresShare = (step, name) =>
  isCacheAction(step, "restore") &&
  step.with?.path === sharePath(name) &&
  step.with?.key === shareCacheKey(name);
export const REQUIRED_GATE_COMMAND =
  '.ci-output/tools/bin/node scripts/ci/required.mjs --reports .ci-output/reports --output .ci-output/gate --base "$CI_BASE"';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const unique = (values, label) =>
  assert(new Set(values).size === values.length, `Duplicate ${label}`);
const legacyJobIds = [
  "policy",
  "static",
  "build",
  "browser",
  "tests",
  "tooling",
  "security",
  "required",
];
const jobIds = legacyJobIds.filter((id) => id !== "browser");
const retiredBrowserEngines = ["chromium", "firefox", "webkit"];
const coverageArmChecks = ["policy", "static", "security"];
const coverageJobIds = ["policy", "static", "build", "browser", "coverage", "security", "required"];
const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];
export const chromiumInstall =
  ".ci-output/tools/bin/node node_modules/playwright/cli.js install --only-shell chromium";
const chromiumChecks = ["tests", "tooling"];

export function timeoutMinutesFor(checkId) {
  if (checkId === "required") return 15;
  return ["build", "test", "node-floor", "browser"].includes(checkId) ? 90 : 60;
}

function hostedTimeoutMinutesFor(checkId) {
  if (checkId === "required") return 5;
  return ["build", "test", "node-floor", "browser"].includes(checkId) ? 30 : 15;
}

export function upgradeHostedRunnerPolicy(policy) {
  const checks = policy?.checks ?? [];
  const members = checks.flatMap((check) => check.members ?? []);
  const hosted =
    members.length > 0 &&
    checks.every((check) => check.timeoutMinutes === hostedTimeoutMinutesFor(check.id)) &&
    members.every(
      (member) =>
        !Object.hasOwn(member, "paused") &&
        member.runner === (member.key === "macos-arm64" ? "macos-15" : "ubuntu-24.04"),
    );
  if (!hosted) return policy;
  const upgraded = structuredClone(policy);
  for (const check of upgraded.checks) check.timeoutMinutes = timeoutMinutesFor(check.id);
  for (const check of upgraded.checks)
    for (const member of check.members)
      if (member.key === "macos-arm64") member.paused = true;
      else member.runner = legacyRunnerLabels.linux;
  return upgraded;
}

export function upgradeRunnerLabel(policy) {
  const checks = policy?.checks ?? [];
  const members = checks.flatMap((check) => check.members ?? []);
  const hermes =
    members.length > 0 &&
    checks.every((check) => check.timeoutMinutes === timeoutMinutesFor(check.id)) &&
    members.every((member) =>
      member.key === "macos-arm64"
        ? member.runner === "macos-15" && member.paused === true
        : member.runner === "hermes-home" && !Object.hasOwn(member, "paused"),
    );
  if (!hermes) return policy;
  const upgraded = structuredClone(policy);
  for (const check of upgraded.checks)
    for (const member of check.members)
      if (member.key !== "macos-arm64") member.runner = legacyRunnerLabels.linux;
  return upgraded;
}

const canonicalJson = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );

const retiredTestChecks = [
  {
    id: "test",
    needs: ["policy", "build"],
    timeoutMinutes: 90,
    members: [
      {
        key: "linux-x64",
        runner: legacyRunnerLabels.linux,
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
    projects: ["unit", "contracts", "integration", "e2e", "pi-compat"],
    outputs: ["json", "junit", "artifact"],
  },
  {
    id: "node-floor",
    needs: ["policy"],
    timeoutMinutes: 90,
    members: [
      {
        key: "default",
        runner: legacyRunnerLabels.linux,
        os: "linux",
        arch: "x64",
        node: "22.19.0",
      },
    ],
    projects: ["unit", "contracts", "integration", "e2e", "pi-compat"],
    outputs: ["json", "junit"],
  },
];

const ciVpsDefaultMember = {
  key: "default",
  runner: legacyRunnerLabels.linux,
  os: "linux",
  arch: "x64",
  node: "22.22.3",
};

export const testsMembers = [
  {
    key: "integration-1",
    projects: ["integration"],
    shard: { index: 1, count: 2 },
  },
  {
    key: "integration-2",
    projects: ["integration"],
    shard: { index: 2, count: 2 },
  },
  { key: "others", projects: ["unit", "contracts", "e2e", "pi-compat"] },
].map((member) => ({ ...ciVpsDefaultMember, ...member }));

export function upgradeSplitTests(policy) {
  const tests = policy?.checks?.find((check) => check.id === "tests");
  if (!tests || canonicalJson(tests.members) !== canonicalJson([ciVpsDefaultMember])) return policy;
  const upgraded = structuredClone(policy);
  upgraded.checks.find((check) => check.id === "tests").members = structuredClone(testsMembers);
  return upgraded;
}

const retiredShapeChecks = [
  ...retiredTestChecks,
  {
    id: "coverage",
    needs: ["policy", "build"],
    timeoutMinutes: 60,
    members: [ciVpsDefaultMember],
    projects: ["unit", "contracts", "tooling", "integration"],
    outputs: ["json", "lcov", "artifact"],
  },
  {
    id: "required",
    needs: ["policy", "static", "build", "test", "node-floor", "browser", "coverage", "security"],
    timeoutMinutes: 15,
    members: [ciVpsDefaultMember],
    projects: [],
    outputs: [],
  },
];

export function upgradeRetiredTestChecks(policy) {
  const checks = policy?.checks ?? [];
  const retiredIds = retiredTestChecks.map((check) => check.id);
  const retired =
    sameSet(
      checks.map((check) => check.id),
      [...coverageJobIds, ...retiredIds],
    ) &&
    retiredShapeChecks.every(
      (expected) =>
        canonicalJson(checks.find((check) => check.id === expected.id)) === canonicalJson(expected),
    );
  if (!retired) return policy;
  const upgraded = structuredClone(policy);
  upgraded.checks = upgraded.checks.filter((check) => !retiredIds.includes(check.id));
  for (const check of upgraded.checks) {
    check.needs = check.needs.filter((id) => !retiredIds.includes(id));
    if (check.id === "coverage") check.projects = [...check.projects, "e2e", "pi-compat"];
  }
  return upgraded;
}

export function upgradeCoverageCollection(policy) {
  const collection = policy?.checks?.find((check) => check.id === "coverage");
  if (!collection || !sameSet(collection.projects ?? [], ["unit", "contracts", "tooling"]))
    return policy;
  const upgraded = structuredClone(policy);
  Object.assign(
    upgraded.checks.find((check) => check.id === "coverage"),
    {
      projects: [...coverageProjects, "e2e", "pi-compat"],
      needs: ["policy", "build"],
      outputs: [...new Set([...collection.outputs, "artifact"])],
    },
  );
  return upgraded;
}

export function upgradeCoverageToTests(policy) {
  const checks = policy?.checks ?? [];
  const find = (id) => checks.find((check) => check.id === id);
  const coverage = find("coverage");
  const accepted =
    sameSet(
      checks.map((check) => check.id),
      coverageJobIds,
    ) &&
    [[], ["tooling"]].some((projects) => sameSet(find("policy").projects ?? [], projects)) &&
    sameSet(
      find("required").needs ?? [],
      coverageJobIds.filter((id) => id !== "required"),
    ) &&
    sameSet(coverage.needs ?? [], ["policy", "build"]) &&
    sameSet(coverage.projects ?? [], mainProjects) &&
    sameSet(coverage.outputs ?? [], ["json", "lcov", "artifact"]) &&
    coverage.timeoutMinutes === timeoutMinutesFor("coverage") &&
    canonicalJson(coverage.members) === canonicalJson([ciVpsDefaultMember]);
  if (!accepted) return policy;
  const upgraded = structuredClone(policy);
  upgraded.checks = upgraded.checks.flatMap((check) => {
    if (check.id === "policy") return [{ ...check, projects: [] }];
    if (check.id === "required")
      return [{ ...check, needs: legacyJobIds.filter((id) => id !== "required") }];
    if (check.id !== "coverage") return [check];
    return [
      {
        ...check,
        id: "tests",
        projects: mainProjects.filter((id) => id !== "tooling"),
        outputs: ["json", "artifact"],
      },
      {
        id: "tooling",
        needs: ["policy"],
        timeoutMinutes: timeoutMinutesFor("tooling"),
        members: [
          {
            ...ciVpsDefaultMember,
            runner: legacyRunnerLabels.arm,
            alternateArch: "arm64",
          },
        ],
        projects: ["tooling"],
        outputs: ["json"],
      },
    ];
  });
  return upgraded;
}

const runnerLabelFor = (checkId) =>
  checkId === "required"
    ? gateRunnerLabel
    : armChecks.includes(checkId)
      ? armRunnerLabel
      : linuxRunnerLabel;

export function upgradeArmRunnerPolicy(policy) {
  const checks = policy?.checks ?? [];
  const onSharedRunner = (id) => {
    const members = checks.find((check) => check.id === id)?.members;
    return (
      members?.length === 1 &&
      members[0].runner === legacyRunnerLabels.linux &&
      members[0].os === "linux" &&
      members[0].arch === "x64" &&
      [undefined, "arm64"].includes(members[0].alternateArch)
    );
  };
  if (
    !sameSet(
      checks.map((check) => check.id),
      coverageJobIds,
    ) ||
    !coverageArmChecks.every(onSharedRunner)
  )
    return policy;
  const upgraded = structuredClone(policy);
  for (const check of upgraded.checks)
    if (coverageArmChecks.includes(check.id))
      Object.assign(check.members[0], {
        runner: legacyRunnerLabels.arm,
        alternateArch: "arm64",
      });
  return upgraded;
}

export function upgradeGateRunnerPolicy(policy) {
  const checks = policy?.checks ?? [];
  const required = checks.find((check) => check.id === "required");
  const sharedRunner =
    sameSet(
      checks.map((check) => check.id),
      coverageJobIds,
    ) &&
    required.members?.length === 1 &&
    required.members[0].runner === legacyRunnerLabels.linux;
  if (!sharedRunner) return policy;
  const upgraded = structuredClone(policy);
  upgraded.checks.find((check) => check.id === "required").members[0].runner =
    legacyRunnerLabels.gate;
  return upgraded;
}

export function upgradeRetiredBrowserCheck(policy) {
  const checks = policy?.checks ?? [];
  const browser = checks.find((check) => check.id === "browser");
  const required = checks.find((check) => check.id === "required");
  const retired =
    browser &&
    required &&
    sameSet(
      checks.map((check) => check.id),
      legacyJobIds,
    ) &&
    sameSet(browser.needs ?? [], ["build"]) &&
    sameSet(
      (browser.members ?? []).map((member) => member.key),
      retiredBrowserEngines,
    ) &&
    (browser.members ?? []).every((member) => member.browser === member.key) &&
    sameSet(
      required.needs ?? [],
      legacyJobIds.filter((id) => id !== "required"),
    );
  if (!retired) return policy;
  const upgraded = structuredClone(policy);
  upgraded.checks = upgraded.checks.filter((check) => check.id !== "browser");
  for (const check of upgraded.checks) check.needs = check.needs.filter((id) => id !== "browser");
  return upgraded;
}

export function upgradeSelfHostedRunners(policy) {
  const hosted = {
    [legacyRunnerLabels.linux]: linuxRunnerLabel,
    [legacyRunnerLabels.gate]: gateRunnerLabel,
    [legacyRunnerLabels.arm]: armRunnerLabel,
  };
  const members = (policy?.checks ?? []).flatMap((check) => check.members ?? []);
  const legacyMac = (member) =>
    member.key === "macos-arm64" && member.runner === "macos-15" && member.paused === true;
  const selfHosted =
    members.length > 0 &&
    members.every((member) => legacyMac(member) || Object.hasOwn(hosted, member.runner));
  if (!selfHosted) return policy;
  const upgraded = structuredClone(policy);
  for (const check of upgraded.checks)
    for (const member of check.members) {
      if (legacyMac(member)) {
        member.runner = macRunnerLabel;
        continue;
      }
      member.runner = hosted[member.runner];
      const leftArm =
        member.runner === armRunnerLabel &&
        legacyArmChecks.includes(check.id) &&
        !armChecks.includes(check.id);
      if (leftArm) {
        member.runner = linuxRunnerLabel;
        delete member.alternateArch;
      }
    }
  return upgraded;
}

export function upgradeArtifactRetention(policy) {
  const retention = policy?.retentionDays;
  const accepted =
    retention &&
    Object.keys(retention).length === 2 &&
    retention.reports === 30 &&
    retention.diagnostics === 7;
  if (!accepted) return policy;
  return { ...policy, retentionDays: { reports: 1, diagnostics: 1 } };
}

export function validatePolicy(policy, { allowLegacyIntegration = false } = {}) {
  validateRecord("CheckPolicy", policy);
  unique(policy.events, "event");
  unique(
    policy.checks.map((check) => check.id),
    "check ID",
  );
  assert(
    sameSet(
      policy.checks.map((check) => check.id),
      jobIds,
    ),
    "Policy must declare exactly seven required jobs",
  );
  unique(
    policy.testProjects.map((project) => project.id),
    "project ID",
  );
  assert(
    sameSet(
      policy.testProjects.map((project) => project.id),
      mainProjects,
    ),
    "Policy must declare five main projects and tooling",
  );
  unique(
    policy.registeredTests.map((test) => test.path),
    "registered test",
  );
  for (const registration of policy.registeredTests) {
    assert(
      safeRelativePath(registration.path) && !/[?*{}]/u.test(registration.path),
      `Registration must use an exact file: ${registration.path}`,
    );
    unique(registration.allowedModifiers, "allowed modifier");
    assert(
      registration.kind === "qualification" || registration.allowedModifiers.length === 0,
      "Only explicit qualification files can opt out",
    );
  }
  for (const project of policy.testProjects) {
    unique(project.include, "project include");
    unique(project.exclude, "project exclude");
    assert(
      project.id !== "integration" ||
        (project.fileParallelism === true && project.workerLimits) ||
        (allowLegacyIntegration && project.fileParallelism === false && !project.workerLimits),
      "Integration files require a bounded parallel worker budget",
    );
    assert(
      project.id === "integration" || !project.workerLimits,
      "Only integration may change the worker budget",
    );
    for (const excluded of project.exclude)
      assert(
        policy.registeredTests.some((test) => test.path === excluded),
        `Unregistered project exclusion: ${excluded}`,
      );
  }
  const graph = new Map(policy.checks.map((check) => [check.id, check.needs]));
  const visit = (id, ancestors) => {
    assert(graph.has(id), `Unknown job dependency: ${id}`);
    assert(!ancestors.has(id), `Dependency cycle: ${id}`);
    for (const parent of graph.get(id)) visit(parent, new Set([...ancestors, id]));
  };
  const expectedNeeds = {
    policy: [],
    static: ["policy"],
    build: ["policy"],
    tests: ["policy", "build"],
    tooling: ["policy"],
    security: ["policy"],
    required: jobIds.filter((id) => id !== "required"),
  };
  for (const check of policy.checks) {
    unique(check.needs, `${check.id} dependency`);
    unique(
      check.members.map((member) => member.key),
      `${check.id} matrix member`,
    );
    unique(check.projects, `${check.id} project`);
    unique(check.outputs, `${check.id} output`);
    assert(sameSet(check.needs, expectedNeeds[check.id]), `Unexpected policy DAG: ${check.id}`);
    assert(check.timeoutMinutes === timeoutMinutesFor(check.id), `Unexpected timeout: ${check.id}`);
    const requiredProjects =
      check.id === "tests"
        ? mainProjects.filter((id) => id !== "tooling")
        : check.id === "tooling"
          ? ["tooling"]
          : [];
    assert(sameSet(check.projects, requiredProjects), `Incomplete project selection: ${check.id}`);
    const requiredKeys =
      check.id === "build"
        ? ["linux-x64", "macos-arm64"]
        : check.id === "tests"
          ? testsMembers.map((member) => member.key)
          : ["default"];
    assert(
      sameSet(
        check.members.map((member) => member.key),
        requiredKeys,
      ),
      `Incomplete matrix: ${check.id}`,
    );
    validateMemberProjects(check);
    assert(activeMembers(check).length > 0, `Every member is paused: ${check.id}`);
    for (const member of check.members) {
      const mac = member.key === "macos-arm64";
      const arm = armChecks.includes(check.id);
      assert(
        member.os === (mac ? "darwin" : "linux") &&
          member.arch === (mac ? "arm64" : "x64") &&
          member.alternateArch === (arm ? "arm64" : undefined) &&
          member.runner === (mac ? macRunnerLabel : runnerLabelFor(check.id)),
        `Incorrect platform: ${check.id}/${member.key}`,
      );
      assert(mac || member.paused === undefined, `Only macOS members may pause: ${check.id}`);
      assert(member.browser === undefined, `Incorrect browser identity: ${check.id}`);
    }
    visit(check.id, new Set());
  }
  return policy;
}

function validateMemberProjects(check) {
  const split = check.members.some((member) => member.projects || member.shard);
  if (check.id !== "tests" || !split) {
    assert(!split, `Only tests members may split projects: ${check.id}`);
    return;
  }
  for (const member of check.members) {
    assert(member.projects, `Split tests member names no projects: ${member.key}`);
    unique(member.projects, `${member.key} project`);
    assert(
      member.projects.every((id) => check.projects.includes(id)),
      `Split tests member runs a project outside tests: ${member.key}`,
    );
    assert(
      !member.shard || member.projects.length === 1,
      `Sharded tests member must run exactly one project: ${member.key}`,
    );
  }
  for (const id of check.projects) {
    const owners = check.members.filter((member) => member.projects.includes(id));
    const shards = owners.map((member) => member.shard);
    const whole = owners.length === 1 && shards[0] === undefined;
    const sharded =
      owners.length > 1 &&
      shards.every((shard) => shard?.count === owners.length) &&
      sameSet(
        shards.map((shard) => String(shard.index)),
        owners.map((_member, index) => String(index + 1)),
      );
    assert(whole || sharded, `Tests project must run exactly once across members: ${id}`);
  }
}

function requireReadPermissions(permissions, label, root = false) {
  assert(
    permissions && typeof permissions === "object" && !Array.isArray(permissions),
    `${label}: permissions must be explicit`,
  );
  assert(
    Object.entries(permissions).every(
      ([key, value]) => ["contents", "actions", "pull-requests"].includes(key) && value === "read",
    ),
    `${label}: write or unknown permissions`,
  );
  assert(!root || permissions.contents === "read", "Workflow requires contents: read");
}

export function validateWorkflow(policy, source, toolchain) {
  validatePolicy(policy);
  const document = parseDocument(source, {
    uniqueKeys: true,
    maxAliasCount: 0,
  });
  assert(
    document.errors.length === 0,
    `Invalid workflow YAML: ${document.errors.map((error) => error.message).join("; ")}`,
  );
  const workflow = document.toJS({ maxAliasCount: 0 });
  assert(workflow && typeof workflow === "object", "Workflow must be a mapping");
  assert(
    workflow.on && typeof workflow.on === "object" && !Array.isArray(workflow.on),
    "Workflow events must be explicit mappings",
  );
  assert(
    sameSet(
      Object.keys(workflow.on),
      policy.events.map((event) => (event === "push" ? "workflow_call" : event)),
    ),
    "Unexpected workflow events",
  );
  for (const event of Object.values(workflow.on))
    assert(
      !event || (!Object.hasOwn(event, "paths") && !Object.hasOwn(event, "paths-ignore")),
      "Required workflow cannot filter paths",
    );
  assert(
    sameSet(workflow.on.pull_request?.types ?? [], [
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]),
    "PR activity types are incomplete",
  );
  assert(
    workflow.on.workflow_call?.inputs?.base_sha?.type === "string" &&
      workflow.on.push === undefined,
    "Main must call the reusable full workflow",
  );
  requireReadPermissions(workflow.permissions, "Workflow", true);
  assert(
    workflow.concurrency && typeof workflow.concurrency.group === "string",
    "Workflow concurrency is required",
  );
  const concurrencyGroup = [
    "github.workflow",
    "github.event_name",
    "github.event.pull_request.number || github.ref",
    "github.event_name == 'push' && github.run_id || ''",
    "github.event.pull_request.draft == true && 'draft' || 'ready'",
  ]
    .map(githubExpression)
    .join("-");
  assert(
    workflow.concurrency.group === concurrencyGroup,
    "Concurrency must identify the actual workflow, event, PR/ref, and give push runs their own group",
  );
  assert(
    workflow.concurrency["cancel-in-progress"] ===
      githubExpression("github.event_name == 'pull_request'"),
    "Only obsolete PR runs may be cancelled",
  );
  assert(
    workflow.jobs &&
      sameSet(
        Object.keys(workflow.jobs),
        policy.checks.map((check) => check.id),
      ),
    "Workflow jobs differ from policy",
  );
  const actions = new Map(
    (toolchain?.actions ?? []).map((action) => [action.repository, action.sha]),
  );
  for (const check of policy.checks) {
    const job = workflow.jobs[check.id];
    const needs = typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
    assert(
      Array.isArray(needs) && sameSet(needs, check.needs),
      `Incorrect workflow DAG: ${check.id}`,
    );
    assert(
      job["timeout-minutes"] === check.timeoutMinutes,
      `Incorrect workflow timeout: ${check.id}`,
    );
    assert(
      job["continue-on-error"] === undefined || job["continue-on-error"] === false,
      `Job can hide failure: ${check.id}`,
    );
    assert(
      !job.uses && !job.container && !job.environment && !job.secrets,
      `Unsupported execution boundary: ${check.id}`,
    );
    if (job.permissions) requireReadPermissions(job.permissions, check.id);
    if (check.id === "required")
      assert(
        job.name === "ci/required" && ["always()", githubExpression("always()")].includes(job.if),
        "required must use always() and ci/required",
      );
    else
      assert(
        job.if === githubExpression(DRAFT_SKIP_CONDITION),
        `Every check job must skip draft pull requests and nothing else: ${check.id}`,
      );
    if (check.members.length > 1) {
      assert(
        job["runs-on"] === githubExpression("matrix.runner"),
        `Matrix runner expression drift: ${check.id}`,
      );
      assert(job.strategy?.["fail-fast"] === false, `Matrix fail-fast must be false: ${check.id}`);
      const matrix = job.strategy?.matrix;
      assert(
        matrix && sameSet(Object.keys(matrix), ["include"]) && Array.isArray(matrix.include),
        `Matrix must use literal include: ${check.id}`,
      );
      const canonical = (member) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(member).sort(([a], [b]) => a.localeCompare(b))),
        );
      assert(
        sameSet(matrix.include.map(canonical), activeMembers(check).map(canonical)),
        `Matrix members differ: ${check.id}`,
      );
    } else
      assert(
        !job.strategy && job["runs-on"] === check.members[0].runner,
        `Single job platform differs: ${check.id}`,
      );
    assert(Array.isArray(job.steps) && job.steps.length > 0, `Empty job: ${check.id}`);
    for (const step of job.steps) {
      assert(
        !/^actions\/(?:upload|download)-artifact@/u.test(step.uses ?? ""),
        `GitHub artifacts are not used; reports stay on the runner share and diagnostics go to the job summary: ${check.id}`,
      );
      assert(
        step["continue-on-error"] === undefined || step["continue-on-error"] === false,
        `Step can hide failure: ${check.id}`,
      );
      if (step.run)
        assert(
          typeof step.run === "string" && !step.run.includes("${{"),
          `Untrusted expression interpolated into shell: ${check.id}`,
        );
      if (step.uses) {
        const match = /^([^@]+)@([a-f0-9]{40})$/u.exec(step.uses);
        assert(match, `Action must use a full commit SHA: ${step.uses}`);
        assert(
          actions.get(actionRepository(step.uses)) === match[2],
          `Action is not toolchain-locked: ${step.uses}`,
        );
        if (match[1] === "actions/checkout")
          assert(
            step.with?.["persist-credentials"] === false,
            "Checkout must not persist credentials",
          );
      }
    }
    if (chromiumChecks.includes(check.id)) {
      const install = job.steps.findIndex((step) => step.run === chromiumInstall);
      const run = job.steps.findIndex((step) => step.run?.includes("scripts/ci/run.mjs"));
      assert(install >= 0, `Job runs browser tests without installing Chromium: ${check.id}`);
      const step = job.steps[install];
      assert(
        (run < 0 ? check.id === "tests" : install < run) &&
          step.if === undefined &&
          step["continue-on-error"] !== true,
        `Chromium must install unconditionally before the checks run: ${check.id}`,
      );
    }
    const shareRoots = job.steps.filter((step) => step.run === SHARE_ROOT_COMMAND);
    assert(
      shareRoots.length === 1 && shareRoots[0].if === undefined && !shareRoots[0].env,
      `Job must point the run share at this runner's temporary directory exactly once: ${check.id}`,
    );
    if (check.id === "required") {
      const [entry] = job.steps;
      assert(
        entry?.id === "entry" &&
          entry.if === undefined &&
          entry.uses === undefined &&
          entry.env?.CI_DRAFT === githubExpression(REQUIRED_DRAFT) &&
          entry.env?.CI_CANCELLED === githubExpression(REQUIRED_CANCELLED) &&
          entry.run === REQUIRED_ENTRY_SCRIPT,
        "Required must first fail draft and cancelled runs before installing anything",
      );
      const collectIndex = job.steps.findIndex(
        (step) =>
          step.run ===
            ".ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports" &&
          step.env?.CI_NEEDS === githubExpression("toJSON(needs)") &&
          step.if === undefined,
      );
      assert(collectIndex > 0, "Required must collect digest-checked reports from the run share");
      const reported = policy.checks
        .filter((other) => other.id !== "required")
        .flatMap((other) => activeMembers(other).map((member) => `${other.id}-${member.key}`));
      for (const name of reported)
        assert(
          job.steps
            .slice(0, collectIndex)
            .some(
              (step) =>
                restoresShare(step, name) &&
                step.if === undefined &&
                step.with?.["fail-on-cache-miss"] === undefined,
            ),
          `Required must restore every member's reports from the run cache before collecting: ${name}`,
        );
      assert(
        job.steps
          .slice(1)
          .every((step) => step.if === undefined || step.if === REQUIRED_AFTER_ENTRY),
        "Required runs nothing after a failed entry check",
      );
      assert(
        job.steps.some(
          (step) =>
            step.run === REQUIRED_GATE_COMMAND &&
            step.env?.CI_NEEDS === githubExpression("toJSON(needs)") &&
            step.if === undefined,
        ),
        "Required must print its gate into the ci/required log, where main reads it",
      );
    } else {
      const shares = job.steps.filter((step) => step.run?.includes("scripts/ci/run-share.mjs put"));
      assert(
        shares.length === 1 &&
          shares[0].id === "share" &&
          shares[0].run ===
            `.ci-output/tools/bin/node scripts/ci/run-share.mjs put --name "${check.id}-$CI_MATRIX" --from .ci-output/public/reports --output-key "$CI_MATRIX"`,
        `Job must put its reports on the runner share exactly once: ${check.id}`,
      );
      const shareIndex = job.steps.findIndex((step) => step.id === "share");
      const saves = job.steps.filter((step) => isCacheAction(step, "save"));
      assert(
        saves.length === 1 &&
          job.steps.indexOf(saves[0]) > shareIndex &&
          saves[0].if === SHARE_AFTER_PUT &&
          saves[0].with?.path === sharePath(`${check.id}-\${{ env.CI_MATRIX }}`) &&
          saves[0].with?.key === shareCacheKey(`${check.id}-\${{ env.CI_MATRIX }}`),
        `Job must save its shared reports to this run's cache exactly once: ${check.id}`,
      );
      const summaries = job.steps.filter((step) => step.run?.includes("scripts/ci/ci-summary.mjs"));
      assert(
        summaries.length === 1 &&
          summaries[0].if === githubExpression("always() && steps.publish.outcome == 'success'") &&
          summaries[0].run ===
            `.ci-output/tools/bin/node scripts/ci/ci-summary.mjs --title "${check.id}/$CI_MATRIX 失败诊断" --from .ci-output/public/diagnostics --failed-logs .ci-output/public/reports`,
        `Job must write its diagnostics into the job summary exactly once: ${check.id}`,
      );
      const members = activeMembers(check)
        .map((member) => member.key)
        .sort();
      assert(
        JSON.stringify(Object.keys(job.outputs ?? {}).sort()) === JSON.stringify(members) &&
          members.every(
            (member) => job.outputs[member] === githubExpression(`steps.share.outputs.${member}`),
          ),
        `Job must expose one report digest per matrix member: ${check.id}`,
      );
    }
    if (check.id === "tests") {
      const fetches = job.steps.filter((step) =>
        step.run?.includes("scripts/ci/run-share.mjs get"),
      );
      const fetchIndex = job.steps.indexOf(fetches[0]);
      assert(
        job.steps
          .slice(0, fetchIndex)
          .some(
            (step) =>
              restoresShare(step, "build-linux-x64") &&
              step.if === undefined &&
              step.with?.["fail-on-cache-miss"] === true,
          ),
        `${check.id} must restore this attempt's Linux build from the run cache before taking it`,
      );
      assert(
        fetches.length === 1 &&
          fetches[0].if === undefined &&
          fetches[0].env?.CI_BUILD_DIGEST === githubExpression("needs.build.outputs.linux-x64") &&
          fetches[0].run ===
            '.ci-output/tools/bin/node scripts/ci/run-share.mjs get --name build-linux-x64 --digest "$CI_BUILD_DIGEST" --to .ci-output/input',
        `${check.id} must take this attempt's Linux build from the runner share by digest`,
      );
    }
    if (check.id === "tests") {
      const executions = job.steps.filter((step) => step.run?.includes("scripts/ci/run.mjs"));
      assert(
        executions.length === 1 &&
          executions[0].if === undefined &&
          executions[0].run ===
            '.ci-output/tools/bin/node scripts/ci/run.mjs --check tests --matrix "$CI_MATRIX" --base "$CI_BASE" --tools .ci-output/tools --output .ci-output/check --baseline-candidate initial-only --input .ci-output/input/result.json',
        "Tests must use the shared runner with the initial-only baseline candidate option",
      );
    }
  }
  assert(!JSON.stringify(workflow).includes("secrets."), "Required CI cannot reference secrets");
  return {
    jobs: policy.checks.length,
    members: policy.checks.reduce((total, check) => total + check.members.length, 0),
  };
}

export function validateHostedRunners(workflows) {
  for (const [file, text] of Object.entries(workflows)) {
    const workflow = parseDocument(text, { uniqueKeys: true }).toJS();
    for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
      if (job.uses) {
        assert(job["runs-on"] === undefined, `HOSTED_RUNNER_REQUIRED ${file}/${id}`);
        continue;
      }
      const label = job["runs-on"];
      const labels =
        label === githubExpression("matrix.runner")
          ? (job.strategy?.matrix?.include ?? [null]).map((member) => member?.runner)
          : [label];
      assert(
        labels.length > 0 && labels.every((entry) => hostedRunnerLabels.includes(entry)),
        `HOSTED_RUNNER_REQUIRED ${file}/${id}: only ${hostedRunnerLabels.join(", ")} are free on this public repository`,
      );
    }
  }
}

export function inspectTestSource(source, filename) {
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  assert(ast.parseDiagnostics.length === 0, `Invalid test syntax: ${filename}`);
  const globals = new Map(["describe", "suite", "it", "test"].map((name) => [name, [name]]));
  const options = { noLib: true, noResolve: true, allowJs: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === filename ? ast : undefined);
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  const unitFile = /\.unit\.test\.[cm]?[jt]sx?$/u.test(filename);
  const roots = new Map();
  const namespaces = new Set();
  const rootNames = new Set(globals.keys());
  const importedNames = new Map();
  const namespaceModules = new Map();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceModules.set(checker.getSymbolAtLocation(bindings.name), module);
      if (module === "vitest") {
        namespaces.add(checker.getSymbolAtLocation(bindings.name));
        rootNames.add(bindings.name.text);
      }
    }
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) {
        const imported = item.propertyName?.text ?? item.name.text;
        importedNames.set(checker.getSymbolAtLocation(item.name), {
          module,
          name: imported,
        });
        if (module === "vitest" && ["describe", "suite", "it", "test"].includes(imported)) {
          roots.set(checker.getSymbolAtLocation(item.name), [imported]);
          rootNames.add(item.name.text);
        }
      }
  }
  const chain = (node) => {
    if (ts.isIdentifier(node)) {
      if (!rootNames.has(node.text)) return [];
      const symbol = checker.getSymbolAtLocation(node);
      return symbol
        ? (roots.get(symbol) ?? (namespaces.has(symbol) ? ["vitest"] : []))
        : (globals.get(node.text) ?? []);
    }
    if (ts.isCallExpression(node) || ts.isParenthesizedExpression(node))
      return chain(node.expression);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parent = chain(node.expression);
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : "<dynamic>";
      if (
        parent.length === 1 &&
        parent[0] === "vitest" &&
        !["describe", "suite", "it", "test", "<dynamic>"].includes(name)
      )
        return [];
      return parent.length ? [...parent, name] : [];
    }
    return [];
  };
  const propertyName = (node) =>
    ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
  const vitestPath = (node) => {
    if (ts.isParenthesizedExpression(node)) return vitestPath(node.expression);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const imported = symbol && importedNames.get(symbol);
      if (imported?.module === "vitest") return [imported.name];
      if (symbol && namespaces.has(symbol)) return ["vitest"];
      return [];
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parent = vitestPath(node.expression);
      const name = propertyName(node);
      if (!parent.length || name === undefined) return [];
      if (parent.length === 1 && parent[0] === "vitest" && name !== "vi") return [];
      return [...parent, name];
    }
    return [];
  };
  const moduleMember = (expression) => {
    if (ts.isIdentifier(expression))
      return importedNames.get(checker.getSymbolAtLocation(expression));
    if (ts.isPropertyAccessExpression(expression)) {
      const module = namespaceModules.get(checker.getSymbolAtLocation(expression.expression));
      return module ? { module, name: expression.name.text } : undefined;
    }
    return undefined;
  };
  const numericLiteral = (node) => {
    if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const value = numericLiteral(node.operand);
      return value === null ? null : -value;
    }
    return null;
  };
  const timerDelayIndex = (expression) => {
    if (ts.isIdentifier(expression)) {
      const member = moduleMember(expression);
      if (member?.module === "node:timers/promises" && member.name === "setTimeout") return 0;
      if (expression.text !== "setTimeout") return null;
      return !member || member.module === "node:timers" ? 1 : null;
    }
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "setTimeout") {
      if (
        ts.isIdentifier(expression.expression) &&
        ["globalThis", "window"].includes(expression.expression.text)
      )
        return 1;
      const module = namespaceModules.get(checker.getSymbolAtLocation(expression.expression));
      if (module === "node:timers/promises") return 0;
      if (module === "node:timers") return 1;
    }
    return null;
  };
  const listenPort = (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "listen" ||
      !node.arguments.length
    )
      return null;
    const [first] = node.arguments;
    const port = numericLiteral(first);
    if (port !== null) return port;
    if (!ts.isObjectLiteralExpression(first)) return null;
    for (const property of first.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : "";
      if (name === "port") return numericLiteral(property.initializer);
    }
    return null;
  };
  const initializers = new Map();
  const collectInitializers = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name))
      initializers.set(checker.getSymbolAtLocation(node.name), node.initializer);
    ts.forEachChild(node, collectInitializers);
  };
  collectInitializers(ast);
  const textualPath = (node, seen = new Set()) => {
    if (ts.isParenthesizedExpression(node)) return textualPath(node.expression, seen);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "URL")
        return node.arguments?.length ? textualPath(node.arguments[0], seen) : null;
      return null;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const member = moduleMember(callee);
      if (member?.module === "node:path" && ["join", "resolve"].includes(member.name)) {
        const parts = node.arguments.map((argument) => textualPath(argument, seen));
        return parts.every((part) => part !== null) ? parts.join("/") : null;
      }
      if (ts.isIdentifier(callee) && callee.text === "fileURLToPath" && node.arguments.length === 1)
        return textualPath(node.arguments[0], seen);
      return null;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const initializer = symbol && initializers.get(symbol);
      if (!initializer || seen.has(symbol)) return null;
      seen.add(symbol);
      return textualPath(initializer, seen);
    }
    return null;
  };
  const readsSource = (expression) => {
    const member = moduleMember(expression);
    return Boolean(
      member &&
        (member.module === "node:fs" || member.module === "node:fs/promises") &&
        (member.name === "readFile" || member.name === "readFileSync"),
    );
  };
  const modifiers = [];
  const recordModifier = (name, node) => {
    if (["only", "skip", "todo", "skipIf", "runIf", "<dynamic>"].includes(name))
      modifiers.push({
        modifier: name,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      });
  };
  const bind = (binding, names) => {
    if (ts.isIdentifier(binding)) {
      roots.set(checker.getSymbolAtLocation(binding), names);
      rootNames.add(binding.text);
      return;
    }
    if (!ts.isObjectBindingPattern(binding)) return;
    for (const element of binding.elements) {
      const property = element.propertyName ?? element.name;
      const name =
        ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : "<dynamic>";
      recordModifier(name, element);
      bind(element.name, [...names, name]);
    }
  };
  const resetAliases = new Set();
  const findAliases = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const value = node.initializer;
      const names = chain(value);
      if (names.length) bind(node.name, names);
      else if (ts.isConditionalExpression(value)) {
        const whenTrue = chain(value.whenTrue);
        const whenFalse = chain(value.whenFalse);
        if (whenTrue.length || whenFalse.length)
          bind(node.name, whenTrue.length ? whenTrue : whenFalse);
      }
      if (ts.isObjectBindingPattern(node.name) && vitestPath(value).join(".") === "vi")
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          const name =
            ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : "";
          if (name === "resetModules" && ts.isIdentifier(element.name))
            resetAliases.add(element.name.text);
        }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const names = chain(node.right);
      if (names.length) bind(node.left, names);
    }
    ts.forEachChild(node, findAliases);
  };
  findAliases(ast);
  const emptySuites = [];
  const hygiene = [];
  let declarations = 0;
  const recordHygiene = (kind, node) =>
    hygiene.push({
      kind,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
    });
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const names = chain(node);
      const modifier = names.at(-1);
      if (["only", "skip", "todo", "skipIf", "runIf", "<dynamic>"].includes(modifier))
        modifiers.push({
          modifier,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        });
    }
    if (ts.isCallExpression(node)) {
      const names = chain(node.expression);
      const called = vitestPath(node.expression);
      if (called.at(-2) === "vi" && called.at(-1) === "resetModules")
        recordHygiene("module-reset", node);
      if (ts.isIdentifier(node.expression) && resetAliases.has(node.expression.text))
        recordHygiene("module-reset", node);
      const timerDelay = timerDelayIndex(node.expression);
      if (timerDelay !== null && node.arguments.length > timerDelay) {
        const delay = numericLiteral(node.arguments[timerDelay]);
        if (delay !== null && delay >= 100) recordHygiene("real-wait", node);
      }
      const port = listenPort(node);
      if (port !== null && port > 0) recordHygiene("fixed-port", node);
      if (unitFile && readsSource(node.expression) && node.arguments.length) {
        const target = textualPath(node.arguments[0]);
        if (target && /(?:^|\/)src\/.*\.[cm]?[jt]sx?$/u.test(target))
          recordHygiene("production-source-read", node);
      }
      const callback = node.arguments.at(-1);
      if (
        names.length &&
        node.arguments.length >= 2 &&
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        declarations += 1;
        if (
          ["describe", "suite"].some((name) => names.includes(name)) &&
          ts.isBlock(callback.body) &&
          callback.body.statements.length === 0
        )
          emptySuites.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  hygiene.sort(
    (left, right) =>
      left.line - right.line || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
  );
  return { declarations, modifiers, emptySuites, hygiene };
}

export function validateTestPlacement(files, coveragePolicy) {
  for (const filename of files)
    if (/(?:\.test|\.spec|\.type-test)\.[cm]?[jt]sx?$/u.test(filename))
      assert(
        !inCoverageScope(filename, coveragePolicy),
        `Test file overlaps production coverage: ${filename}; move it to the workspace test directory`,
      );
}

export function planTestInventory(policy, files) {
  validatePolicy(policy);
  unique(files, "inventory file");
  const tests = files.filter((file) => /(?:\.test|\.spec|\.type-test)\.[cm]?[jt]sx?$/u.test(file));
  const counts = Object.fromEntries(policy.testProjects.map((project) => [project.id, 0]));
  const registered = new Map(policy.registeredTests.map((entry) => [entry.path, entry]));
  for (const registration of policy.registeredTests)
    assert(tests.includes(registration.path), `Stale test registration: ${registration.path}`);
  const entries = [];
  for (const filename of tests) {
    const owners = policy.testProjects.filter(
      (project) =>
        project.include.some((glob) => path.matchesGlob(filename, glob)) &&
        !project.exclude.some((glob) => path.matchesGlob(filename, glob)),
    );
    const registration = registered.get(filename);
    assert(
      owners.length + Number(Boolean(registration)) === 1,
      `Test requires exactly one owner: ${filename}`,
    );
    if (owners.length) counts[owners[0].id] += 1;
    entries.push({ filename, registration });
  }
  for (const [id, count] of Object.entries(counts)) assert(count > 0, `Empty project: ${id}`);
  return { files: tests.length, projects: counts, entries };
}

export function validateTestFileSource(source, filename, registration) {
  if (registration?.kind === "type-check") return;
  const inspection = inspectTestSource(source, filename);
  assert(inspection.declarations > 0, `No executable test declarations: ${filename}`);
  assert(inspection.emptySuites.length === 0, `Empty suite: ${filename}`);
  for (const { modifier, line } of inspection.modifiers) {
    assert(
      modifier !== "only" &&
        modifier !== "<dynamic>" &&
        registration?.allowedModifiers.includes(modifier),
      `Forbidden test modifier ${modifier}: ${filename}:${line}`,
    );
  }
  return inspection;
}

export function validateTestInventory(policy, files, readSource) {
  const { entries, ...inventory } = planTestInventory(policy, files);
  const findings = [];
  for (const { filename, registration } of entries) {
    if (registration?.kind === "type-check") continue;
    const inspection = validateTestFileSource(readSource(filename), filename, registration);
    for (const finding of inspection.hygiene) findings.push({ path: filename, ...finding });
  }
  findings.sort(
    (left, right) =>
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
      left.line - right.line ||
      (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
  );
  return { ...inventory, findings };
}

const testHygieneKinds = ["fixed-port", "module-reset", "production-source-read", "real-wait"];
const testHygieneModeRank = { report: 0, enforce: 1 };
const testHygieneAdvice = {
  "fixed-port": "listen on port 0 and read the assigned port instead of a fixed one",
  "module-reset": "load the module once at file scope and reset the state it holds",
  "production-source-read": "assert the public behaviour instead of reading production source text",
  "real-wait": "await the condition or use fake timers instead of a real wait of 100 ms or more",
};
const baselineInvalid = (reason) => new Error(`TEST_HYGIENE_BASELINE_INVALID:${reason}`);
const compareHygieneEntries = (left, right) =>
  left.path !== right.path
    ? left.path < right.path
      ? -1
      : 1
    : left.kind !== right.kind
      ? left.kind < right.kind
        ? -1
        : 1
      : 0;

export function parseTestHygieneBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw baselineInvalid("not an object");
  if (value.schemaVersion !== 1) throw baselineInvalid("schemaVersion");
  if (!Object.hasOwn(testHygieneModeRank, value.mode ?? ""))
    throw baselineInvalid(`mode ${value.mode}`);
  if (!Array.isArray(value.entries)) throw baselineInvalid("entries");
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw baselineInvalid("entry");
    if (!safeRelativePath(entry.path)) throw baselineInvalid(`path ${entry.path}`);
    if (!testHygieneKinds.includes(entry.kind)) throw baselineInvalid(`kind ${entry.kind}`);
    if (!Number.isInteger(entry.count) || entry.count < 1)
      throw baselineInvalid(`count ${entry.path} ${entry.kind}`);
    return { path: entry.path, kind: entry.kind, count: entry.count };
  });
  const keys = entries.map((entry) => `${entry.path}\u0000${entry.kind}`);
  if (new Set(keys).size !== keys.length) throw baselineInvalid("duplicate entry");
  for (let index = 1; index < entries.length; index += 1)
    if (compareHygieneEntries(entries[index - 1], entries[index]) >= 0)
      throw baselineInvalid("entries must be sorted by path and kind");
  return { schemaVersion: 1, mode: value.mode, entries };
}

export function resolveTestHygieneBaseline({
  root = repositoryRoot,
  base = "HEAD",
  baselinePath = "ci/test-hygiene-baseline.json",
} = {}) {
  assert(/^(?:[a-f0-9]{40}|HEAD)$/u.test(base), "Hygiene base must be HEAD or a full commit SHA");
  assert(safeRelativePath(baselinePath), "Hygiene baseline path must be relative");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const present = git(["ls-tree", "-r", "--name-only", baseSha, "--", baselinePath])
    .split("\n")
    .includes(baselinePath);
  if (!present) return { baseline: null, baseSha, initialization: true };
  return {
    baseline: parseTestHygieneBaseline(JSON.parse(git(["show", `${baseSha}:${baselinePath}`]))),
    baseSha,
    initialization: false,
  };
}

export function evaluateTestHygiene({ findings, workspace, accepted }) {
  const baseline = parseTestHygieneBaseline(workspace);
  const acceptedBaseline =
    accepted === null || accepted === undefined ? null : parseTestHygieneBaseline(accepted);
  const observed = new Map();
  for (const finding of findings) {
    const key = `${finding.path}\u0000${finding.kind}`;
    const entry = observed.get(key);
    if (entry) {
      entry.count += 1;
      entry.lines.push(finding.line);
    } else
      observed.set(key, {
        path: finding.path,
        kind: finding.kind,
        count: 1,
        lines: [finding.line],
      });
  }
  const violations = [];
  const entries = new Map(
    baseline.entries.map((entry) => [`${entry.path}\u0000${entry.kind}`, entry]),
  );
  const acceptedEntries = acceptedBaseline
    ? new Map(acceptedBaseline.entries.map((entry) => [`${entry.path}\u0000${entry.kind}`, entry]))
    : null;
  for (const [key, entry] of entries) {
    const current = observed.get(key);
    const count = current?.count ?? 0;
    if (count > entry.count)
      violations.push({
        code: "TEST_HYGIENE_EXCESS",
        message: `TEST_HYGIENE_EXCESS: ${entry.path}:${current.lines[entry.count]} ${entry.kind} has ${count} findings but the baseline allows ${entry.count}; ${testHygieneAdvice[entry.kind]}`,
      });
    else if (count < entry.count)
      violations.push({
        code: "TEST_HYGIENE_STALE",
        message: `TEST_HYGIENE_STALE: ${entry.path} ${entry.kind} baseline is ${entry.count} but ${count} remain; lower the entry to ${count}`,
      });
    if (!acceptedEntries) continue;
    const acceptedEntry = acceptedEntries.get(key);
    if (!acceptedEntry)
      violations.push({
        code: "TEST_HYGIENE_UNACCEPTED",
        message: `TEST_HYGIENE_UNACCEPTED: ${entry.path} ${entry.kind} is not in the baseline at the accepted base commit; a baseline entry can never be added, remove the finding instead`,
      });
    else if (entry.count > acceptedEntry.count)
      violations.push({
        code: "TEST_HYGIENE_RAISED",
        message: `TEST_HYGIENE_RAISED: ${entry.path} ${entry.kind} baseline is ${entry.count} but the accepted base allows ${acceptedEntry.count}`,
      });
  }
  for (const [key, current] of observed) {
    if (entries.has(key)) continue;
    violations.push({
      code: "TEST_HYGIENE_UNACCEPTED",
      message: `TEST_HYGIENE_UNACCEPTED: ${current.path}:${current.lines[0]} ${current.kind} has ${current.count} findings and no baseline entry; ${testHygieneAdvice[current.kind]}`,
    });
  }
  if (
    acceptedBaseline &&
    testHygieneModeRank[baseline.mode] < testHygieneModeRank[acceptedBaseline.mode]
  )
    violations.push({
      code: "TEST_HYGIENE_MODE_WEAKENED",
      message: `TEST_HYGIENE_MODE_WEAKENED: workspace mode ${baseline.mode} is weaker than ${acceptedBaseline.mode} at the accepted base commit`,
    });
  return { baseline, violations, findings };
}

export function validateTestHygiene({
  root = repositoryRoot,
  base = "HEAD",
  findings,
  baselinePath = "ci/test-hygiene-baseline.json",
  write = (line) => process.stderr.write(line),
}) {
  const accepted = resolveTestHygieneBaseline({ root, base, baselinePath });
  let workspace;
  try {
    workspace = parseTestHygieneBaseline(
      JSON.parse(readFileSync(path.join(root, baselinePath), "utf8")),
    );
  } catch (error) {
    if (error instanceof SyntaxError) throw baselineInvalid(`syntax ${error.message}`);
    if (error?.code === "ENOENT") throw new Error(`TEST_HYGIENE_BASELINE_MISSING:${baselinePath}`);
    throw error;
  }
  const evaluation = evaluateTestHygiene({
    findings,
    workspace,
    accepted: accepted.baseline,
  });
  const count = (code) =>
    evaluation.violations.filter((violation) => violation.code === code).length;
  const summary =
    `TEST_HYGIENE_SUMMARY records=${workspace.entries.length} findings=${findings.length} ` +
    `excess=${count("TEST_HYGIENE_EXCESS")} stale=${count("TEST_HYGIENE_STALE")} ` +
    `unaccepted=${count("TEST_HYGIENE_UNACCEPTED")} raised=${count("TEST_HYGIENE_RAISED")} ` +
    `mode=${workspace.mode} accepted=${accepted.initialization ? "initializing" : accepted.baseSha.slice(0, 7)}`;
  for (const finding of findings)
    write(`TEST_HYGIENE_FINDING ${finding.path}:${finding.line} ${finding.kind}\n`);
  for (const violation of evaluation.violations) write(`${violation.message}\n`);
  write(`${summary}\n`);
  if (workspace.mode === "enforce" && evaluation.violations.length > 0)
    throw new Error(evaluation.violations.map((violation) => violation.message).join("\n"));
  return { ...evaluation, summary };
}

export function resolvePolicySource({
  root = repositoryRoot,
  base = "HEAD",
  policyPath = "ci/policy.json",
  coveragePath = "ci/coverage-policy.json",
} = {}) {
  assert(/^(?:[a-f0-9]{40}|HEAD)$/u.test(base), "Policy base must be HEAD or a full commit SHA");
  assert(
    safeRelativePath(policyPath) && safeRelativePath(coveragePath),
    "Policy source paths must be relative",
  );
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const baseSha = git(["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const paths = git(["ls-tree", "-r", "--name-only", baseSha, "--", policyPath, coveragePath])
    .trim()
    .split("\n")
    .filter(Boolean);
  const hasPolicy = paths.includes(policyPath);
  const hasCoverage = paths.includes(coveragePath);
  assert(
    hasPolicy === hasCoverage,
    "Damaged accepted policy: exactly one of policy and coverage exists at base",
  );
  const bytes = hasPolicy
    ? git(["show", `${baseSha}:${policyPath}`])
    : readFileSync(path.join(root, policyPath), "utf8");
  const policy = validatePolicy(
    upgradeRetiredBrowserCheck(
      upgradeSelfHostedRunners(
        upgradeSplitTests(
          upgradeCoverageToTests(
            upgradeCoverageCollection(
              upgradeArmRunnerPolicy(
                upgradeGateRunnerPolicy(
                  upgradeRetiredTestChecks(
                    upgradeArtifactRetention(
                      upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes))),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    {
      allowLegacyIntegration: true,
    },
  );
  const integration = policy.testProjects.find((project) => project.id === "integration");
  if (!integration.fileParallelism && !integration.workerLimits) {
    integration.fileParallelism = true;
    integration.workerLimits = { ...integrationWorkerLimits };
  } else if (
    integration.workerLimits &&
    integration.workerLimits.maximum === 4 &&
    integration.workerLimits.cpusPerWorker === 2 &&
    integration.workerLimits.memoryMiBPerWorker === 2048
  ) {
    integration.workerLimits = { ...integrationWorkerLimits };
  }
  const coverage = hasCoverage ? JSON.parse(git(["show", `${baseSha}:${coveragePath}`])) : null;
  assert(
    !hasCoverage || (coverage && typeof coverage === "object" && !Array.isArray(coverage)),
    "Damaged coverage policy at base",
  );
  if (hasCoverage) {
    validateRecord("CoveragePolicy", coverage);
    assert(coverage.baseline !== null, "Accepted coverage policy has no measured baseline");
  }
  return {
    policy: hasPolicy ? admitFromProposal(root, policyPath, policy, baseSha) : policy,
    policySha256: sha256(bytes),
    coverage,
    baseSha,
    initialization: !hasPolicy,
  };
}

export function validateToolchain(policy, lock, packageManifest) {
  assert(lock.schemaVersion === 1, "Unknown toolchain schema");
  assert(/^\d+\.\d+\.\d+$/u.test(lock.node?.baseline), "Node version must be exact");
  assert(
    packageManifest.packageManager === `npm@${lock.npm?.version}`,
    "npm identity differs from toolchain",
  );
  for (const check of policy.checks)
    for (const member of check.members)
      assert(member.node === lock.node.baseline, `Node identity drift: ${check.id}`);
  assert(Array.isArray(lock.actions) && lock.actions.length > 0, "No locked Actions");
  unique(
    lock.actions.map((action) => action.repository),
    "locked Action",
  );
  for (const action of lock.actions)
    assert(
      /^[a-f0-9]{40}$/u.test(action.sha) && action.version && action.license,
      `Invalid Action lock: ${action.repository}`,
    );
  return true;
}

export function validateInstallScriptReviews(toolchainLock, packageLock) {
  const packages = packageLock?.packages ?? {};
  const reviews = toolchainLock?.nativeDependencies ?? [];
  for (const review of reviews) {
    const locked = packages[review.path];
    assert(locked, `Install-script review for a package missing from package-lock: ${review.path}`);
    assert(
      locked.version === review.version,
      `Install-script review version differs from package-lock: ${review.path}`,
    );
    assert(
      locked.hasInstallScript === true,
      `Install-script review for a package without install script: ${review.path}`,
    );
    assert(
      review.name === review.path.slice(review.path.lastIndexOf("node_modules/") + 13),
      `Install-script review name differs from its path: ${review.path}`,
    );
  }
  const reviewed = new Set(reviews.map((review) => review.path));
  for (const [packagePath, locked] of Object.entries(packages))
    if (locked.hasInstallScript === true)
      assert(reviewed.has(packagePath), `Install script is not reviewed: ${packagePath}`);
  return true;
}

export function admitNewQualificationTests(accepted, proposed, baseFiles) {
  const known = new Set(accepted.registeredTests.map((entry) => entry.path));
  const base = new Set(baseFiles);
  const proposedIntegration = proposed.testProjects.find((project) => project.id === "integration");
  const admitted = proposed.registeredTests.filter(
    (entry) =>
      entry.kind === "qualification" &&
      !known.has(entry.path) &&
      !base.has(entry.path) &&
      proposedIntegration?.exclude.includes(entry.path),
  );
  if (!admitted.length) return accepted;
  const widened = structuredClone(accepted);
  widened.registeredTests.push(...structuredClone(admitted));
  const integration = widened.testProjects.find((project) => project.id === "integration");
  for (const entry of admitted)
    if (!integration.exclude.includes(entry.path)) integration.exclude.push(entry.path);
  return validatePolicy(widened);
}

function admitFromProposal(root, policyPath, accepted, baseSha) {
  let proposed;
  try {
    proposed = validatePolicy(JSON.parse(readFileSync(path.join(root, policyPath), "utf8")));
  } catch {
    return accepted;
  }
  return admitNewQualificationTests(accepted, proposed, baseTrackedFiles(root, baseSha));
}

export function baseTrackedFiles(root, baseSha) {
  return execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", baseSha], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

export function validateVitestProjects(policy, config) {
  validatePolicy(policy);
  const root = config?.test;
  assert(root && Array.isArray(root.projects), "Vitest must declare literal project objects");
  assert(
    root.allowOnly === false && !root.passWithNoTests && (root.retry ?? 0) === 0,
    "Vitest root must not hide empty projects or retry failures",
  );
  const projects = new Map();
  const aliases = new Set(["browser", "admin-cli", "node-services", "workspace-scaffolds"]);
  for (const entry of root.projects) {
    assert(
      entry && typeof entry === "object" && entry.test && typeof entry.test.name === "string",
      "Dynamic or unnamed Vitest project",
    );
    const test = entry.test;
    assert(!projects.has(test.name), `Duplicate Vitest project: ${test.name}`);
    assert(
      test.allowOnly !== true && !test.passWithNoTests && (test.retry ?? root.retry ?? 0) === 0,
      `Vitest project can hide failure: ${test.name}`,
    );
    assert(
      !test.testNamePattern && !test.only && !test.setupFiles?.length,
      `Unexpected test selection or setup: ${test.name}`,
    );
    projects.set(test.name, test);
  }
  const expected = [
    ...policy.testProjects,
    ...policy.registeredTests
      .filter((test) => test.kind === "qualification")
      .map((test) => ({
        id: test.project,
        include: [test.path],
        exclude: [],
        fileParallelism: false,
      })),
  ];
  for (const required of expected) {
    const actual = projects.get(required.id);
    assert(actual, `Missing Vitest project: ${required.id}`);
    assert(
      sameSet(actual.include ?? [], required.include) &&
        sameSet(actual.exclude ?? [], required.exclude),
      `Vitest file selection differs from policy: ${required.id}`,
    );
    assert(
      (actual.fileParallelism ?? root.fileParallelism ?? true) === required.fileParallelism,
      `Vitest file parallelism differs from policy: ${required.id}`,
    );
    assert(actual.environment === "node", `Vitest environment differs from policy: ${required.id}`);
    assert(
      (actual.sequence?.groupOrder ?? root.sequence?.groupOrder ?? 0) ===
        (required.id === "integration" ? 1 : 0),
      `Vitest scheduling group differs from policy: ${required.id}`,
    );
    if (required.id === "integration") {
      assert(
        actual.maxWorkers === testWorkerCount(required),
        "Vitest integration worker count differs from policy",
      );
      assert(
        (actual.isolate ?? root.isolate ?? true) === true,
        "Vitest integration files must remain isolated",
      );
    }
  }
  for (const id of projects.keys())
    assert(
      expected.some((project) => project.id === id) || aliases.has(id),
      `Unknown Vitest project: ${id}`,
    );
  return {
    projects: expected.length,
    aliases: [...projects.keys()].filter((id) => aliases.has(id)),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, ["--base", "--workflow", "--root"]);
  const root = path.resolve(args["--root"] ?? repositoryRoot);
  const source = resolvePolicySource({ root, base: args["--base"] ?? "HEAD" });
  const proposed = validatePolicy(readJson(path.join(root, "ci/policy.json")));
  const lock = readJson(path.join(root, "ci/toolchain-lock.json"));
  validateToolchain(proposed, lock, readJson(path.join(root, "package.json")));
  validateInstallScriptReviews(lock, readJson(path.join(root, "package-lock.json")));
  const workflow = path.resolve(root, args["--workflow"] ?? ".github/workflows/ci.yml");
  validateWorkflow(proposed, readFileSync(workflow, "utf8"), lock);
  const mainWorkflow = readFileSync(path.join(root, ".github/workflows/main.yml"), "utf8");
  validateMainWorkflow(mainWorkflow, lock);
  validateCallerGrantsCalledPermissions(mainWorkflow, readFileSync(workflow, "utf8"));
  validateWorkflow(source.policy, readFileSync(workflow, "utf8"), lock);
  validateQualityWorkflow(
    readJson(path.join(root, "ci/quality-policy.json")),
    readFileSync(path.join(root, ".github/workflows/quality.yml"), "utf8"),
    lock,
  );
  const workflowDirectory = path.join(root, ".github/workflows");
  validateHostedRunners(
    Object.fromEntries(
      readdirSync(workflowDirectory)
        .filter((name) => /\.ya?ml$/u.test(name))
        .sort()
        .map((name) => [name, readFileSync(path.join(workflowDirectory, name), "utf8")]),
    ),
  );
  const vitest = await import(pathToFileURL(path.join(root, "vitest.workspace.ts")).href);
  validateVitestProjects(proposed, vitest.default);
  validateVitestProjects(source.policy, vitest.default);
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  validateTestPlacement(files, readJson(path.join(root, "ci/coverage-policy.json")));
  if (source.coverage) validateTestPlacement(files, source.coverage);
  const { findings, ...inventory } = validateTestInventory(
    source.policy,
    [...new Set(files)],
    (file) => readFileSync(path.join(root, file), "utf8"),
  );
  validateTestHygiene({ root, base: source.baseSha, findings });
  const result = {
    status: "passed",
    baseSha: source.baseSha,
    initialization: source.initialization,
    policySha256: source.policySha256,
    toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json")),
    ...inventory,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
