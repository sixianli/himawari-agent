import { parseDocument } from "yaml";
import { githubExpression as expression } from "./contracts.mjs";

const assert = (value, code) => {
  if (!value) throw new Error(`MAIN_WORKFLOW:${code}`);
};
export function validateMainWorkflow(source, lock) {
  const document = parseDocument(source, { uniqueKeys: true, maxAliasCount: 0 });
  assert(!document.errors.length, "YAML");
  const w = document.toJS({ maxAliasCount: 0 });
  assert(JSON.stringify(w.on) === JSON.stringify({ push: { branches: ["main"] } }), "events");
  assert(
    JSON.stringify(w.permissions) === JSON.stringify({ contents: "read", actions: "read" }),
    "permissions",
  );
  assert(
    w.concurrency?.["cancel-in-progress"] === false &&
      w.concurrency.group === `main-confirmation-${expression("github.run_id")}`,
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
  assert(!full.secrets && !full.permissions && !full.with, "full-inputs");
  assert(
    confirm.needs === "plan" &&
      confirm.if === "needs.plan.result == 'success' && needs.plan.outputs.mode == 'light'",
    "confirm-condition",
  );
  assert(
    plan.outputs?.mode === expression("steps.verify.outputs.mode") &&
      plan.outputs?.evidence === expression("steps.retain.outputs.artifact-id"),
    "outputs",
  );
  const actions = new Map(lock.actions.map((a) => [a.repository, a.sha]));
  for (const [id, job] of [
    ["plan", plan],
    ["confirm", confirm],
  ]) {
    assert(
      job["runs-on"] === "ubuntu-24.04" && job["timeout-minutes"] === (id === "plan" ? 5 : 15),
      "runtime",
    );
    assert(
      !job["continue-on-error"] && !job.permissions && !job.container && !job.environment,
      "boundary",
    );
    for (const step of job.steps) {
      if (step.run) assert(!step.run.includes("\u0024{"), "shell-expression");
      if (step.uses) {
        const [name, sha] = step.uses.split("@");
        assert(actions.get(name) === sha, "action-lock");
        if (name === "actions/checkout")
          assert(step.with?.["persist-credentials"] === false, "checkout");
      }
      if (step["continue-on-error"])
        assert(
          id === "plan" && step.uses?.startsWith("actions/download-artifact@"),
          "hidden-failure",
        );
    }
  }
  const discover = plan.steps.find((s) => s.id === "candidate");
  const verify = plan.steps.find((s) => s.id === "verify");
  const download = plan.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
  assert(
    discover?.run === "node scripts/ci/main-evidence.mjs discover" && !discover.if,
    "discover",
  );
  assert(
    verify?.run === "node scripts/ci/main-evidence.mjs verify" && verify.if === "always()",
    "verify",
  );
  assert(
    download?.with?.["run-id"] === expression("steps.candidate.outputs.run_id") &&
      download.with["artifact-ids"] === expression("steps.candidate.outputs.artifact_id") &&
      download.with["github-token"] === expression("github.token") &&
      download.with.path === ".ci-output/main-evidence/gate",
    "gate-download",
  );
  assert(
    confirm.steps.some(
      (s) =>
        s.run === ".ci-output/tools/bin/node scripts/ci/main-confirm.mjs" &&
        !s.if &&
        !s["continue-on-error"],
    ),
    "confirmation",
  );
  assert(!JSON.stringify(w).includes("secrets."), "secrets");
  return { jobs: 3 };
}
