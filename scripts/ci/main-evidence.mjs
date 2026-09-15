import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = "sixianli/himawari-agent";
const assert = (value, code) => {
  if (!value) throw new Error(code);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort();
const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const json = (filename) => JSON.parse(readFileSync(filename, "utf8"));
const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Fixed-origin, bounded read. Unavailable evidence always selects the full workflow. */
export async function githubJson(
  endpoint,
  { token = process.env.HIMAWARI_CI_GITHUB_TOKEN, fetcher = fetch } = {},
) {
  assert(endpoint.startsWith(`/repos/${repository}/`) && !endpoint.includes(".."), "MAIN_API_PATH");
  const response = await fetcher(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, "MAIN_API_UNAVAILABLE");
  const text = await response.text();
  assert(text.length <= 2_000_000, "MAIN_API_RESPONSE_LIMIT");
  return JSON.parse(text);
}

export function pushIdentity({ root = process.cwd(), env = process.env } = {}) {
  assert(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "push" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_REPOSITORY === repository,
    "MAIN_PUSH_REQUIRED",
  );
  const event = json(env.GITHUB_EVENT_PATH);
  assert(sha(event.before) && !/^0+$/.test(event.before) && sha(event.after), "MAIN_PUSH_IDENTITY");
  assert(
    event.after === env.GITHUB_SHA && git(root, ["rev-parse", "HEAD"]) === event.after,
    "MAIN_CHECKOUT_MISMATCH",
  );
  const parents = git(root, ["show", "-s", "--format=%P", event.after]).split(" ");
  // Squash/rebase, multi-merge pushes, and directly pushed commits take the full path.
  assert(parents.length === 2 && parents[0] === event.before, "MAIN_SINGLE_MERGE_REQUIRED");
  assert(
    !git(root, [
      "diff",
      "--name-only",
      event.before,
      event.after,
      "--",
      ".github",
      "ci",
      "scripts/ci",
    ]),
    "MAIN_VALIDATION_CHANGED",
  );
  return {
    before: event.before,
    after: event.after,
    head: parents[1],
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}

export async function discoverEvidence({ identity, api = githubJson, now = Date.now() }) {
  const prs = await api(`/repos/${repository}/commits/${identity.after}/pulls?per_page=100`);
  assert(Array.isArray(prs) && prs.length < 100, "MAIN_PR_LIST");
  const matches = prs.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === identity.after &&
      pr.base?.ref === "main" &&
      pr.base?.repo?.full_name === repository &&
      pr.head?.repo?.full_name === repository &&
      pr.head.sha === identity.head,
  );
  assert(matches.length === 1, "MAIN_MERGED_PR_REQUIRED");
  const pr = matches[0];
  assert(positive(pr.number), "MAIN_PR_ID");
  const data = await api(
    `/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=${identity.head}&per_page=100`,
  );
  assert(Array.isArray(data.workflow_runs), "MAIN_RUN_LIST");
  const run = data.workflow_runs.find(
    (r) =>
      r.event === "pull_request" &&
      r.status === "completed" &&
      r.conclusion === "success" &&
      r.path === ".github/workflows/ci.yml" &&
      r.repository?.full_name === repository &&
      r.head_sha === identity.head &&
      Date.parse(r.updated_at) <= now &&
      now - Date.parse(r.updated_at) < 24 * 3600_000,
  );
  assert(run && positive(run.id) && positive(run.run_attempt), "MAIN_SUCCESSFUL_PR_RUN_REQUIRED");
  const artifacts = await api(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
  assert(
    Array.isArray(artifacts.artifacts) && artifacts.artifacts.length < 100,
    "MAIN_ARTIFACT_LIST",
  );
  const gates = artifacts.artifacts.filter(
    (a) => a.name === `gate-${run.id}-${run.run_attempt}` && !a.expired,
  );
  assert(
    gates.length === 1 && positive(gates[0].id) && gates[0].size_in_bytes < 1_000_000,
    "MAIN_GATE_ARTIFACT_REQUIRED",
  );
  return {
    ...identity,
    pr: pr.number,
    runId: run.id,
    attempt: run.run_attempt,
    artifactId: gates[0].id,
  };
}

/** A previous gate is supporting evidence, never rewritten as a new full-CI success. */
export function verifyGate({
  candidate,
  identity,
  summary,
  context,
  testedCommit,
  policy,
  toolchainBytes,
}) {
  assert(
    candidate &&
      same(
        identity,
        Object.fromEntries(["before", "after", "head", "tree"].map((k) => [k, candidate[k]])),
      ),
    "MAIN_CANDIDATE_CHANGED",
  );
  assert(positive(candidate.runId) && positive(candidate.attempt), "MAIN_RUN_ID");
  const expected = policy.checks
    .filter((c) => c.id !== "required")
    .flatMap((c) => c.members.map((m) => `${c.id}/${m.key}`));
  assert(
    context.repository === repository &&
      context.event === "pull_request" &&
      context.initialization === false &&
      context.runId === String(candidate.runId) &&
      context.attempt === candidate.attempt &&
      context.baseSha === identity.before &&
      context.headSha === identity.head &&
      sha(context.testedSha),
    "MAIN_GATE_CONTEXT",
  );
  assert(context.policySha256 === hash(policy.bytes), "MAIN_POLICY_MISMATCH");
  assert(context.toolchainSha256 === hash(toolchainBytes), "MAIN_TOOLCHAIN_MISMATCH");
  for (const [key, value] of Object.entries(context))
    assert(summary[key] === value, "MAIN_SUMMARY_IDENTITY");
  assert(
    summary.schemaVersion === 1 &&
      summary.status === "passed" &&
      same(summary.missing, []) &&
      same(summary.failures, []) &&
      same(sorted(summary.expected), sorted(expected)) &&
      same(sorted(summary.observed), sorted(expected)) &&
      Array.isArray(summary.checks) &&
      summary.checks.length === expected.length &&
      same(sorted(summary.checks.map((c) => `${c.checkId}/${c.matrixKey}`)), sorted(expected)) &&
      summary.checks.every((c) => c.status === "passed" && same(c.reasons, [])),
    "MAIN_COMPLETE_GATE_REQUIRED",
  );
  assert(
    testedCommit.sha === context.testedSha &&
      testedCommit.tree?.sha === identity.tree &&
      same(
        testedCommit.parents?.map((p) => p.sha),
        [identity.before, identity.head],
      ),
    "MAIN_TESTED_TREE_MISMATCH",
  );
  return { schemaVersion: 1, mode: "light", ...candidate, testedSha: context.testedSha };
}

export async function main(
  argv = process.argv.slice(2),
  { root = process.cwd(), env = process.env, api = githubJson } = {},
) {
  const directory = path.join(root, ".ci-output/main-evidence");
  mkdirSync(directory, { recursive: true });
  let result = { mode: "full", reason: "evidence-unavailable" };
  try {
    const identity = pushIdentity({ root, env });
    if (argv[0] === "discover") {
      const candidate = await discoverEvidence({ identity, api });
      writeFileSync(path.join(directory, "candidate.json"), JSON.stringify(candidate));
      if (env.GITHUB_OUTPUT)
        appendFileSync(
          env.GITHUB_OUTPUT,
          `run_id=${candidate.runId}\nartifact_id=${candidate.artifactId}\n`,
        );
      return candidate;
    }
    assert(argv[0] === "verify", "MAIN_MODE");
    const candidate = json(path.join(directory, "candidate.json"));
    const context = json(path.join(directory, "gate/context.json"));
    const summary = json(path.join(directory, "gate/summary.json"));
    assert(sha(context.testedSha), "MAIN_TESTED_SHA");
    const testedCommit = await api(`/repos/${repository}/git/commits/${context.testedSha}`);
    const bytes = readFileSync(path.join(root, "ci/policy.json"));
    result = verifyGate({
      candidate,
      identity,
      context,
      summary,
      testedCommit,
      policy: { ...JSON.parse(bytes), bytes },
      toolchainBytes: readFileSync(path.join(root, "ci/toolchain-lock.json")),
    });
  } catch (error) {
    // Only a controlled reason is public; provider response bodies and credentials are not.
    result = {
      mode: "full",
      reason: /^MAIN_[A-Z_]+$/.test(error.message) ? error.message : "MAIN_EVIDENCE_UNAVAILABLE",
    };
  }
  writeFileSync(path.join(directory, "decision.json"), JSON.stringify(result, null, 2));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `mode=${result.mode}\n`);
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
