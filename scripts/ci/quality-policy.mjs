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
const checks = ["scale", "thread-scale", "brands", "dependencies", "node-observation", "container"];
const timeouts = {
  scale: 60,
  "thread-scale": 60,
  brands: 30,
  dependencies: 15,
  "node-observation": 15,
  container: 30,
};
const CONTAINER_RUNTIME = {
  HIMAWARI_CONTAINER_DOCKER_CLI: "/usr/bin/docker",
  HIMAWARI_CONTAINER_DOCKER_HOST: "unix:///var/run/docker.sock",
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
    retentionDays: constant({ reports: 1, diagnostics: 1 }),
    securityFreshnessHours: constant(24),
    container: object({
      images: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: {
          type: "string",
          pattern: "^docker\\.io/library/[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$",
        },
      },
    }),
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
  const summary = (title, from) =>
    run(`${node} scripts/ci/ci-summary.mjs --title "${title}" --from ${from}`, { if: published });
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
          ...(check === "container"
            ? [
                run(policy.container.images.map((image) => `docker pull ${image}`).join("\n")),
                run(
                  'echo "HIMAWARI_CONTAINER_RUNNER_IMAGE_ID=$(docker build --pull=false --quiet packages/runtime-sandbox/runner-image | cut -d: -f2)" >> "$GITHUB_ENV"',
                ),
              ]
            : []),
          run(
            `${node} scripts/ci/quality.mjs --check ${check} --base "$CI_BASE" --tools .ci-output/tools --output .ci-output/quality${check === "brands" ? " --artifact-directory .ci-output/build" : ""}`,
            check === "container" ? { env: CONTAINER_RUNTIME } : {},
          ),
          run(
            `${node} scripts/ci/publish.mjs --mode quality --input .ci-output/quality --output .ci-output/public --tools .ci-output/tools`,
            { if: "always()", id: "publish" },
          ),
          summary(`${check} 检测结果`, ".ci-output/public/reports"),
          summary(`${check} 失败诊断`, ".ci-output/public/diagnostics"),
        ],
      },
    ]),
  );
  const expectedEvents = {
    workflow_dispatch: {
      inputs: {
        base_sha: { type: "string", required: true },
      },
    },
    ...(policy.schedule.enabled ? { schedule: [{ cron: policy.schedule.cron }] } : {}),
  };
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
