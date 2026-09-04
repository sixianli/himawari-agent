import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import { parseDocument } from "yaml";
import { githubExpression } from "./contracts.mjs";

const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const constant = (value) => ({ const: value });
const checks = ["scale", "thread-scale", "brands", "dependencies", "node-observation"];
const timeouts = {
  scale: 60,
  "thread-scale": 60,
  brands: 30,
  dependencies: 15,
  "node-observation": 15,
};
const distribution = object({
  filename: { type: "string", pattern: "^[A-Za-z0-9._-]+$" },
  url: { type: "string", pattern: "^https://nodejs\\.org/" },
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
});
const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(
  object({
    schemaVersion: constant(1),
    defaultBranch: constant("main"),
    schedule: object({
      enabled: { type: "boolean" },
      cron: constant("23 3 * * *"),
      timezone: constant("UTC"),
    }),
    checks: constant(checks),
    brands: constant(["chrome", "edge"]),
    timeoutsMinutes: constant(timeouts),
    retentionDays: constant({ reports: 30, diagnostics: 7 }),
    securityFreshnessHours: constant(24),
    nodeObservation: object({
      version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
      scope: { type: "string", minLength: 1 },
      testFiles: constant([
        "test/tooling/context.test.mjs",
        "test/tooling/policy.test.mjs",
        "test/tooling/aggregate.test.mjs",
        "test/tooling/coverage.test.mjs",
      ]),
      artifacts: {
        type: "object",
        properties: { "linux-x64": distribution, "darwin-arm64": distribution },
        additionalProperties: false,
      },
    }),
  }),
);

export function validateQualityPolicy(policy) {
  if (!validate(policy))
    throw new Error(`CI_QUALITY_POLICY_INVALID:${ajv.errorsText(validate.errors)}`);
  return policy;
}

export function validateQualityWorkflow(policy, source, toolchain) {
  validateQualityPolicy(policy);
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error("CI_QUALITY_WORKFLOW_INVALID_YAML");
  const workflow = document.toJS({ maxAliasCount: 0 });
  const same = (actual, expected, label) => {
    if (!isDeepStrictEqual(actual, expected))
      throw new Error(`CI_QUALITY_WORKFLOW_MISMATCH:${label}`);
  };
  const actions = new Map(toolchain.actions.map(({ repository, sha }) => [repository, sha]));
  const action = (repository, options = {}) => {
    const sha = actions.get(repository);
    if (!/^[a-f0-9]{40}$/u.test(sha ?? ""))
      throw new Error(`CI_QUALITY_ACTION_LOCK_MISSING:${repository}`);
    return { uses: `${repository}@${sha}`, ...options };
  };
  const node = ".ci-output/tools/bin/node";
  const branch = githubExpression(`github.ref == 'refs/heads/${policy.defaultBranch}'`);
  const published = githubExpression("always() && steps.publish.outcome == 'success'");
  const run = (command, options = {}) => ({ run: command, ...options });
  const installation = () => [
    action("actions/checkout", { with: { "fetch-depth": 0, "persist-credentials": false } }),
    action("actions/setup-node", { with: { "node-version": toolchain.node.baseline } }),
    run("node scripts/ci/install-tools.mjs --directory .ci-output/tools"),
    run(
      "node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation",
    ),
  ];
  const upload = (name, artifactPath, retention, missing, options = {}) =>
    action("actions/upload-artifact", {
      ...options,
      with: { name, path: artifactPath, "if-no-files-found": missing, "retention-days": retention },
    });
  const runIdentity = `${githubExpression("github.run_id")}-${githubExpression("github.run_attempt")}`;
  const expectedJobs = Object.fromEntries(
    policy.checks.map((check) => [
      check,
      {
        "runs-on": "ubuntu-24.04",
        if: branch,
        "timeout-minutes": policy.timeoutsMinutes[check],
        steps: [
          ...installation(),
          ...(check === "brands"
            ? [
                run(
                  `${node} scripts/ci/context.mjs --base "$CI_BASE" --output .ci-output/context.json`,
                ),
                run(
                  `${node} scripts/ci/build.mjs --context .ci-output/context.json --output .ci-output/build`,
                ),
                run(`${node} node_modules/playwright/cli.js install --with-deps chrome msedge`),
              ]
            : []),
          run(
            `${node} scripts/ci/quality.mjs --check ${check} --base "$CI_BASE" --tools .ci-output/tools --output .ci-output/quality${check === "brands" ? " --artifact-directory .ci-output/build" : ""}`,
          ),
          run(
            `${node} scripts/ci/publish.mjs --mode quality --input .ci-output/quality --output .ci-output/public --tools .ci-output/tools`,
            { if: "always()", id: "publish" },
          ),
          upload(
            `quality-${runIdentity}-${check}`,
            ".ci-output/public/reports/",
            policy.retentionDays.reports,
            "error",
            { if: published },
          ),
          upload(
            `quality-diagnostic-${runIdentity}-${check}`,
            ".ci-output/public/diagnostics/",
            policy.retentionDays.diagnostics,
            "ignore",
            { if: published },
          ),
        ],
      },
    ]),
  );
  expectedJobs.handoff = {
    "runs-on": "ubuntu-24.04",
    if: githubExpression(
      `github.ref == 'refs/heads/${policy.defaultBranch}' && inputs.ci_run_id != ''`,
    ),
    "timeout-minutes": 15,
    permissions: { contents: "read", actions: "read" },
    env: { CI_RUN_ID: githubExpression("inputs.ci_run_id") },
    steps: [
      ...installation(),
      run(
        `${node} scripts/ci/export-evidence.mjs --mode metadata --run-id "$CI_RUN_ID" --output .ci-output/run-metadata.json`,
        {
          id: "metadata",
          env: { GITHUB_TOKEN: githubExpression("github.token") },
        },
      ),
      ...[
        {
          pattern: `report-${githubExpression("inputs.ci_run_id")}-${githubExpression("steps.metadata.outputs.attempt")}-*`,
          path: ".ci-output/reports",
        },
        {
          name: `gate-${githubExpression("inputs.ci_run_id")}-${githubExpression("steps.metadata.outputs.attempt")}`,
          path: ".ci-output/gate",
        },
      ].map((selection) =>
        action("actions/download-artifact", {
          with: {
            "github-token": githubExpression("github.token"),
            "run-id": githubExpression("inputs.ci_run_id"),
            ...selection,
          },
        }),
      ),
      run(
        `${node} scripts/ci/export-evidence.mjs --metadata .ci-output/run-metadata.json --reports .ci-output/reports --gate .ci-output/gate --output .ci-output/handoff/evidence.json`,
      ),
      upload(
        `handoff-${runIdentity}`,
        ".ci-output/handoff/evidence.json",
        policy.retentionDays.reports,
        "error",
      ),
    ],
  };
  const expectedEvents = {
    workflow_dispatch: {
      inputs: {
        base_sha: { type: "string", required: true },
        ci_run_id: { type: "string", required: false },
      },
    },
    ...(policy.schedule.enabled ? { schedule: [{ cron: policy.schedule.cron }] } : {}),
  };
  // Names and descriptions are presentation; all execution-bearing fields remain exact.
  for (const input of Object.values(workflow?.on?.workflow_dispatch?.inputs ?? {}))
    delete input.description;
  for (const job of Object.values(workflow?.jobs ?? {}))
    for (const step of job.steps ?? []) delete step.name;
  same(workflow?.on, expectedEvents, "events");
  same(workflow?.jobs, expectedJobs, "jobs");
  same(
    { ...workflow, name: undefined, on: undefined, jobs: undefined },
    {
      name: undefined,
      on: undefined,
      jobs: undefined,
      permissions: { contents: "read" },
      concurrency: {
        group: ["github.workflow", "github.event_name", "github.ref"]
          .map(githubExpression)
          .join("-"),
        "cancel-in-progress": false,
      },
      defaults: { run: { shell: "bash" } },
      env: {
        CI_BASE: githubExpression(
          "github.event_name == 'schedule' && github.sha || inputs.base_sha",
        ),
        PLAYWRIGHT_BROWSERS_PATH: `${githubExpression("github.workspace")}/.ci-output/browsers`,
      },
    },
    "workflow",
  );
  return true;
}
