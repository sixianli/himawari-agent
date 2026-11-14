import { parseDocument } from "yaml";
import { githubExpression as expression, linuxRunnerLabel } from "./contracts.mjs";

const assert = (value, code) => {
  if (!value) throw new Error(`MAIN_WORKFLOW:${code}`);
};
const permissionRank = { none: 0, read: 1, write: 2 };
const parseWorkflow = (source) => {
  const document = parseDocument(source, { uniqueKeys: true, maxAliasCount: 0 });
  assert(!document.errors.length, "YAML");
  return document.toJS({ maxAliasCount: 0 });
};

export function validateCallerGrantsCalledPermissions(mainSource, ciSource) {
  const main = parseWorkflow(mainSource);
  const ci = parseWorkflow(ciSource);
  const mapping = (permissions) => {
    assert(
      permissions === undefined ||
        (permissions !== null && typeof permissions === "object" && !Array.isArray(permissions)),
      "full-grants-invalid",
    );
    return permissions ?? {};
  };
  const granted = mapping(main.jobs?.full?.permissions ?? main.permissions);
  const requested = [
    ci.permissions,
    ...Object.values(ci.jobs ?? {}).map((job) => job?.permissions),
  ];
  for (const permissions of requested)
    for (const [scope, level] of Object.entries(mapping(permissions)))
      assert(
        (permissionRank[granted[scope]] ?? 0) >= (permissionRank[level] ?? 3),
        `full-grants-${scope}-${level}`,
      );
  return { scopes: Object.keys(granted).length };
}
export function validateMainWorkflow(source, lock) {
  const w = parseWorkflow(source);
  assert(JSON.stringify(w.on) === JSON.stringify({ push: { branches: ["main"] } }), "events");
  assert(
    JSON.stringify(w.permissions) ===
      JSON.stringify({ contents: "read", actions: "read", "pull-requests": "read" }),
    "permissions",
  );
  assert(
    w.concurrency?.["cancel-in-progress"] === false && w.concurrency.group === "main-confirmation",
    "concurrency",
  );
  assert(Object.keys(w.jobs).sort().join(",") === "confirm,full,plan", "jobs");
  const { plan, full, confirm } = w.jobs;
  assert(
    full.uses === "./.github/workflows/ci.yml" &&
      full.needs === "plan" &&
      full.if ===
        "always() && (needs.plan.result != 'success' || needs.plan.outputs.mode != 'light')",
    "fallback",
  );
  assert(!full.secrets && !full.with && !full.permissions, "full-inputs");
  assert(
    confirm.needs === "plan" &&
      confirm.if === "needs.plan.result == 'success' && needs.plan.outputs.mode == 'light'",
    "confirm-condition",
  );
  assert(
    JSON.stringify(plan.outputs) ===
      JSON.stringify({ mode: expression("steps.verify.outputs.mode") }),
    "outputs",
  );
  const actions = new Map(lock.actions.map((a) => [a.repository, a.sha]));
  for (const [id, job] of [
    ["plan", plan],
    ["confirm", confirm],
  ]) {
    assert(
      job["runs-on"] === linuxRunnerLabel && job["timeout-minutes"] === (id === "plan" ? 15 : 90),
      "runtime",
    );
    assert(
      !job["continue-on-error"] && !job.permissions && !job.container && !job.environment,
      "boundary",
    );
    for (const step of job.steps) {
      assert(!/^actions\/(?:upload|download)-artifact@/u.test(step.uses ?? ""), "github-artifact");
      if (step.run) assert(!step.run.includes("\u0024{"), "shell-expression");
      if (step.uses) {
        const [name, sha] = step.uses.split("@");
        assert(actions.get(name) === sha, "action-lock");
        if (name === "actions/checkout")
          assert(step.with?.["persist-credentials"] === false, "checkout");
      }
      assert(!step["continue-on-error"], "hidden-failure");
    }
  }
  const discover = plan.steps.find((s) => s.id === "candidate");
  const verify = plan.steps.find((s) => s.id === "verify");
  assert(
    discover?.run === "node scripts/ci/main-evidence.mjs discover" && !discover.if,
    "discover",
  );
  assert(
    verify?.run === "node scripts/ci/main-evidence.mjs verify" && verify.if === "always()",
    "verify",
  );
  assert(
    discover.env?.HIMAWARI_CI_GITHUB_TOKEN === expression("github.token") &&
      verify.env?.HIMAWARI_CI_GITHUB_TOKEN === expression("github.token"),
    "evidence-token",
  );
  const rediscover = confirm.steps.findIndex(
    (s) =>
      s.run === "node scripts/ci/main-evidence.mjs discover" &&
      !s.if &&
      s.env?.HIMAWARI_CI_GITHUB_TOKEN === expression("github.token"),
  );
  const confirmation = confirm.steps.findIndex(
    (s) => s.run === ".ci-output/tools/bin/node scripts/ci/main-confirm.mjs" && !s.if,
  );
  assert(rediscover >= 0 && confirmation > rediscover, "confirmation");
  for (const [job, command] of [
    [
      plan,
      'node scripts/ci/ci-summary.mjs --title "main 路径选择" --from .ci-output/main-evidence',
    ],
    [
      confirm,
      '.ci-output/tools/bin/node scripts/ci/ci-summary.mjs --title "main 确认报告" --from .ci-output/main-public',
    ],
  ])
    assert(job.steps.at(-1)?.run === command && job.steps.at(-1).if === "always()", "job-summary");
  assert(!JSON.stringify(w).includes("secrets."), "secrets");
  return { jobs: 3 };
}
