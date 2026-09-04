import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectSources,
  createSnapshot,
  main,
  mapLineToTested,
  parseDiffHunks,
  resolveCoverageDiff,
  sourceTreeDigest,
  verifyComparison,
  verifyCoverageTools,
  verifyReportProvenance,
  verifySnapshot,
  verifyTestRun,
} from "../../scripts/ci/check-coverage.mjs";
import { resolvePolicySource } from "../../scripts/ci/check-policy.mjs";
import { readJson, repositoryRoot, sha256 } from "../../scripts/ci/contracts.mjs";
import {
  analyzeCoverage,
  changedMetrics,
  evaluateCoverage,
  groupFor,
  inCoverageScope,
  mappingIdentity,
  metric,
  strategyDigest,
  validateCoveragePolicy,
  verifyLcov,
} from "../../scripts/ci/coverage-model.mjs";

const policy = () => ({
  ...readJson(path.join(repositoryRoot, "ci/coverage-policy.json")),
  baseline: null,
});
const testPolicy = readJson(path.join(repositoryRoot, "ci/policy.json"));
const filename = "packages/example/src/choose.ts";
const source = "export function choose(flag) {\n  return flag ? 1 : 0;\n}\n";
const loc = (start, end = start, column = 0, endColumn = null) => ({
  start: { line: start, column },
  end: { line: end, column: endColumn },
});
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function put(root, name, contents) {
  const target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof contents === "string" ? contents : `${JSON.stringify(contents)}\n`);
  return target;
}
function record(name = filename, hits = 1) {
  return {
    path: name,
    statementMap: { 0: loc(2) },
    s: { 0: hits },
    fnMap: { 0: { name: "choose", decl: loc(1, 1, 16, 22), loc: loc(1, 3) } },
    f: { 0: hits },
    branchMap: {
      0: {
        type: "cond-expr",
        line: 2,
        loc: loc(2),
        locations: [loc(2, 2, 16, 17), loc(2, 2, 20, 21)],
      },
    },
    b: { 0: [hits, hits] },
  };
}
function analyze(
  records = { [filename]: record() },
  sources = new Map([[filename, source]]),
  selectedPolicy = policy(),
  root = repositoryRoot,
) {
  return analyzeCoverage({ coverage: records, sources, policy: selectedPolicy, root });
}
function lcov(records) {
  return Object.entries(records)
    .map(([name, rec]) => {
      const lines = new Map();
      for (const [id, position] of Object.entries(rec.statementMap))
        lines.set(position.start.line, Math.max(lines.get(position.start.line) ?? 0, rec.s[id]));
      const branches = Object.values(rec.b).flat();
      return [
        "TN:",
        `SF:${name}`,
        ...Object.values(rec.fnMap).map((fn) => `FN:${fn.decl.start.line},${fn.name}`),
        `FNF:${Object.keys(rec.f).length}`,
        `FNH:${Object.values(rec.f).filter((v) => v > 0).length}`,
        ...Object.entries(rec.fnMap).map(([id, fn]) => `FNDA:${rec.f[id]},${fn.name}`),
        ...[...lines].map(([line, hits]) => `DA:${line},${hits}`),
        `LF:${lines.size}`,
        `LH:${[...lines.values()].filter((v) => v > 0).length}`,
        ...Object.entries(rec.b).flatMap(([id, hits]) =>
          hits.map(
            (hit, index) => `BRDA:${rec.branchMap[id].loc.start.line},${id},${index},${hit}`,
          ),
        ),
        `BRF:${branches.length}`,
        `BRH:${branches.filter((v) => v > 0).length}`,
        "end_of_record",
      ].join("\n");
    })
    .join("\n");
}
function baseline(analysis, selectedPolicy = policy()) {
  return {
    ...selectedPolicy,
    baseline: {
      sourceSha: "a".repeat(40),
      sourceTreeSha256: analysis.sourceTreeSha256,
      reportSha256: "b".repeat(64),
      groups: analysis.groups,
    },
  };
}
const changed = { [filename]: [{ start: 2, end: 2, kind: "added" }] };
function tests(root) {
  const names = [
    "packages/example/test/a.unit.test.ts",
    "packages/example/test/a.contract.test.ts",
    "test/tooling/a.test.mjs",
  ];
  for (const name of names) put(root, name, "export {};\n");
  return {
    success: true,
    numTotalTests: 3,
    numPassedTests: 3,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: names.map((name) => ({
      name: path.join(root, name),
      status: "passed",
      assertionResults: [{ status: "passed" }],
    })),
  };
}
function fixture(initialization = true) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "himawari-coverage-")));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Coverage fixture");
  git(root, "config", "user.email", "coverage@example.invalid");
  put(root, ".gitignore", "node_modules/\n.ci-output/\n");
  put(root, "README.md", "synthetic coverage fixture\n");
  if (!initialization) {
    put(root, filename, source);
    put(root, "ci/policy.json", testPolicy);
    put(root, "ci/coverage-policy.json", baseline(analyze()));
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture base");
  const baseSha = git(root, "rev-parse", "HEAD");
  put(root, filename, source);
  put(root, "ci/policy.json", testPolicy);
  put(root, "ci/coverage-policy.json", initialization ? policy() : baseline(analyze()));
  put(root, "ci/toolchain-lock.json", { fixture: true });
  put(root, "package.json", { private: true });
  put(root, "vitest.workspace.ts", "export default {};\n");
  const tools = { vitest: "4.1.9", "@vitest/coverage-v8": "4.1.9", "ast-v8-to-istanbul": "1.0.5" };
  put(root, "package-lock.json", {
    packages: Object.fromEntries(
      Object.entries(tools).map(([name, version]) => [`node_modules/${name}`, { version }]),
    ),
  });
  for (const [name, version] of Object.entries(tools))
    put(root, `node_modules/${name}/package.json`, { version });
  const testRun = tests(root);
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture candidate");
  const headSha = git(root, "rev-parse", "HEAD");
  const accepted = resolvePolicySource({ root, base: baseSha });
  const context = {
    repository: "example/coverage",
    event: "push",
    runId: "1",
    attempt: 1,
    headSha,
    testedSha: headSha,
    baseSha,
    initialization,
    policySha256: accepted.policySha256,
    toolchainSha256: sha256(readFileSync(path.join(root, "ci/toolchain-lock.json"))),
  };
  const coverage = { [filename]: record() };
  const manifest = {
    root,
    context: ".ci-output/context.json",
    snapshot: ".ci-output/snapshot.json",
    report: ".ci-output/coverage-final.json",
    lcov: ".ci-output/lcov.info",
    tests: ".ci-output/tests.json",
  };
  put(root, manifest.context, context);
  put(root, manifest.report, coverage);
  put(root, manifest.lcov, lcov(coverage));
  put(root, manifest.snapshot, createSnapshot({ root, context, policy: policy() }));
  testRun.startTime = Date.now();
  testRun.coverageMap = coverage;
  put(root, manifest.tests, testRun);
  const args = [
    "--root",
    root,
    "--context",
    path.join(root, manifest.context),
    "--snapshot",
    path.join(root, manifest.snapshot),
    "--report",
    path.join(root, manifest.report),
    "--lcov",
    path.join(root, manifest.lcov),
    "--tests",
    path.join(root, manifest.tests),
    "--output",
    path.join(root, ".ci-output/result.json"),
  ];
  return { root, context, coverage, manifest, args, testRun };
}

describe("source-mapped coverage contract", () => {
  it("counts all production files including unimported code and preserves exact zero denominators", () => {
    const missing = "apps/unimported/src/main.ts";
    const records = {
      [filename]: record(),
      [missing]: record(missing, 0),
      "packages/types/src/index.ts": {
        path: "packages/types/src/index.ts",
        statementMap: {},
        s: {},
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    };
    const sources = new Map([
      [filename, source],
      [missing, source],
      ["packages/types/src/index.ts", "export interface OnlyType {}\n"],
    ]);
    const actual = analyze(records, sources);
    expect(actual.groups["apps/unimported"].lines).toEqual(metric(0, 1));
    expect(actual.groups["packages/types"].branches).toEqual(metric(0, 0));
    expect(verifyLcov(lcov(records), actual, repositoryRoot)).toEqual({ files: 3 });
    expect(inCoverageScope("packages/testing/src/fixture.ts", policy())).toBe(false);
    expect(inCoverageScope("apps/a/src/a.d.ts", policy())).toBe(false);
    expect(groupFor("scripts/ci/check.mjs")).toBe("scripts/ci");
    expect(() => analyze({ [filename]: record() }, sources)).toThrow("production file missing");
  });
  it("rejects invalid identities, source maps, hit arrays, empty execution and ignored code", () => {
    for (const mutate of [
      (value) => {
        value.path = "../escape.ts";
      },
      (value) => {
        value.path = "apps/other/src/file.ts";
      },
      (value) => {
        value.statementMap[0].start.line = 99;
      },
      (value) => {
        value.statementMap[0].start.column = 99;
      },
      (value) => {
        value.statementMap[0].end = { line: 1, column: 0 };
      },
      (value) => {
        value.s[1] = 1;
      },
      (value) => {
        value.s[0] = -1;
      },
      (value) => {
        value.f[0] = 0.5;
      },
      (value) => {
        value.b[0] = [1];
      },
      (value) => {
        value.branchMap[0].locations[0] = { start: {}, end: {} };
      },
      (value) => {
        value.b[0][0] = -1;
      },
    ]) {
      const value = record();
      mutate(value);
      expect(() => analyze({ [filename]: value })).toThrow();
    }
    const empty = {
      path: filename,
      statementMap: {},
      s: {},
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    };
    expect(() => analyze({ [filename]: empty })).toThrow("empty executable denominator");
    expect(() =>
      analyze({ [filename]: empty }, new Map([[filename, "export type Nothing = string;\n"]])),
    ).toThrow("all production executable denominators");
    expect(() => analyze({}, new Map())).toThrow("report is empty");
    expect(() =>
      analyze({ [filename]: record() }, new Map([[filename, `${source}// v8 ignore next\n`]])),
    ).toThrow("unreviewed coverage ignore");
  });
  it("checks LCOV locations and counts, not just believable summaries", () => {
    const records = { [filename]: record() },
      actual = analyze(records),
      text = lcov(records);
    for (const bad of [
      "",
      text.replace("end_of_record", ""),
      text.replace("DA:2,1", "DA:3,1"),
      text.replace("FNDA:1,choose", "FNDA:0,choose"),
      text.replace("BRDA:2,0,0,1", "BRDA:2,0,0,0"),
      text.replace("LF:1", "LF:2"),
      text.replace("SF:", "XX:"),
      `${text}\n${text}`,
    ])
      expect(() => verifyLcov(bad, actual, repositoryRoot)).toThrow();
  });
  it("applies incremental 90/85 even during initialization and reports exact inapplicable reasons", () => {
    const value = record();
    value.s[0] = 0;
    value.b[0][1] = 0;
    const actual = analyze({ [filename]: value });
    const result = evaluateCoverage({
      proposedPolicy: policy(),
      acceptedPolicy: null,
      analysis: actual,
      changed,
      initialization: true,
    });
    expect(result.status).toBe("failed");
    expect(result.failures.map((f) => f.code)).toEqual(["changedLines", "changedFunctionBranches"]);
    const unchanged = changedMetrics(actual, {});
    expect(unchanged.changedLines.reason).toContain("no source-mapped executable");
    expect(unchanged.changedFunctionBranches.reason).toContain("no source-mapped function");
    const noBranches = record();
    noBranches.branchMap = {};
    noBranches.b = {};
    const noBranchResult = changedMetrics(analyze({ [filename]: noBranches }), changed);
    expect(noBranchResult.changedFunctionBranches.reason).toContain("changed functions contain no");
    expect(
      changedMetrics(actual, { [filename]: [{ start: 2, end: 2, kind: "deletion-context" }] })
        .changedLines.total,
    ).toBe(0);
    for (const boundary of [0, 3])
      expect(
        changedMetrics(actual, {
          [filename]: [{ start: boundary, end: boundary, kind: "deletion-context" }],
        }).changedFunctionBranches.total,
      ).toBe(0);
    expect(
      changedMetrics(actual, { [filename]: [{ start: 2, end: 2, kind: "deletion-context" }] })
        .changedFunctionBranches.total,
    ).toBe(2);
  });
  it("does not invent a source location for the pinned mapper's implicit else", () => {
    const value = record();
    value.branchMap[0].type = "if";
    value.branchMap[0].locations[1] = { start: {}, end: {} };
    value.b[0][1] = 0;
    const actual = analyze({ [filename]: value });
    expect(actual.groups["packages/example"].branches.pct).toBe(50);
    const result = changedMetrics(actual, changed);
    expect(result.changedFunctionBranches.total).toBe(1);
    expect(result.changedFunctionBranches.pct).toBe(100);
    expect(result.changedFunctionBranches.unlocatedBranches).toHaveLength(1);
  });
  it("uses accepted workspace baselines and accepted stricter thresholds over proposed reductions", () => {
    const accepted = baseline(analyze());
    accepted.thresholds.changedLines = 95;
    const lowered = baseline(analyze({ [filename]: record(filename, 0) }));
    const result = evaluateCoverage({
      acceptedPolicy: accepted,
      proposedPolicy: lowered,
      analysis: analyze({ [filename]: record(filename, 0) }),
      changed,
      initialization: false,
    });
    expect(result.status).toBe("failed");
    expect(result.failures.find((f) => f.code === "changedLines").required).toBe(95);
    expect(result.failures.filter((f) => f.code === "baseline-regression")).toHaveLength(4);
    expect(() =>
      evaluateCoverage({
        acceptedPolicy: policy(),
        proposedPolicy: policy(),
        analysis: analyze(),
        changed: {},
        initialization: false,
      }),
    ).toThrow("no measurement");
    const malformed = baseline(analyze());
    malformed.baseline.groups["packages/example"].lines.pct = 3;
    expect(() => validateCoveragePolicy(malformed)).toThrow("contradictory baseline");
    const scope = policy();
    scope.exclude.push("apps/**");
    expect(() => validateCoveragePolicy(scope)).toThrow("exclude set changed");
  });
  it("requires comparable old-source measurements before policy migration", () => {
    const actual = analyze(),
      accepted = baseline(actual);
    accepted.provider.mapping = "previous-reviewed-mapping";
    expect(() =>
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: policy(),
        analysis: actual,
        changed,
        initialization: false,
      }),
    ).toThrow("COVERAGE_INCOMPARABLE");
    const comparison = {
      sourceTreeSha256: actual.sourceTreeSha256,
      strategySha256: strategyDigest(policy()),
      groups: actual.groups,
    };
    expect(
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: policy(),
        analysis: actual,
        changed,
        initialization: false,
        comparison,
      }).status,
    ).toBe("passed");
    expect(() =>
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: policy(),
        analysis: actual,
        changed,
        initialization: false,
        comparison: { ...comparison, sourceTreeSha256: "0".repeat(64) },
      }),
    ).toThrow("comparison does not identify");
    const reorder = policy();
    reorder.include.reverse();
    expect(strategyDigest(reorder)).toBe(strategyDigest(policy()));
  });
  it("allows a truly deleted workspace but rejects an unexplained missing group", () => {
    const accepted = baseline(analyze());
    accepted.baseline.groups["apps/deleted"] = structuredClone(
      accepted.baseline.groups["packages/example"],
    );
    expect(
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: policy(),
        analysis: analyze(),
        changed: {},
        initialization: false,
      }).status,
    ).toBe("failed");
    expect(
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: policy(),
        analysis: analyze(),
        changed: {},
        deleted: ["apps/deleted/src/main.ts"],
        initialization: false,
      }).removedGroups,
    ).toEqual(["apps/deleted"]);
  });
  it("requires a measured baseline for a new workspace so later deleted tests cannot bypass the ratchet", () => {
    const newName = "apps/new/src/choose.ts";
    const actual = analyze(
      { [filename]: record(), [newName]: record(newName) },
      new Map([
        [filename, source],
        [newName, source],
      ]),
    );
    const accepted = baseline(analyze());
    expect(
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: policy(),
        analysis: actual,
        changed: {},
        initialization: false,
      }).failures[0].code,
    ).toBe("new-group-baseline");
    expect(
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: baseline(actual),
        analysis: actual,
        changed: {},
        initialization: false,
      }).status,
    ).toBe("passed");
  });
});

describe("coverage evidence and Git boundaries", { timeout: 60000 }, () => {
  it("binds the coverage map and test start time to the prior snapshot", () => {
    const coverage = { [filename]: record() },
      capturedAt = Date.now();
    const report = { startTime: capturedAt, coverageMap: coverage };
    expect(() => verifyReportProvenance(report, coverage, { capturedAt })).not.toThrow();
    expect(() =>
      verifyReportProvenance({ ...report, startTime: capturedAt - 1 }, coverage, { capturedAt }),
    ).toThrow("predates");
    expect(() =>
      verifyReportProvenance(report, { [filename]: record(filename, 0) }, { capturedAt }),
    ).toThrow("differs from measured");
    expect(() => verifySnapshot({ capturedAt: 0 }, { capturedAt })).toThrow("capture time");
    expect(() => verifySnapshot({}, { capturedAt })).toThrow("snapshot fields");
  });
  it("verifies complete tests and rejects failures, skips, omitted and duplicated files", () => {
    const f = fixture();
    expect(verifyTestRun(f.testRun, testPolicy, f.root).map((p) => p.id)).toEqual([
      "unit",
      "contracts",
      "tooling",
    ]);
    for (const mutate of [
      (r) => {
        r.success = false;
      },
      (r) => {
        r.numPendingTests = 1;
      },
      (r) => {
        r.numTotalTests = 4;
      },
      (r) => {
        r.testResults.pop();
      },
      (r) => {
        r.testResults.push(r.testResults[0]);
      },
      (r) => {
        r.testResults[0].assertionResults[0].status = "pending";
      },
      (r) => {
        r.testResults[0].name = "../escape.ts";
      },
    ]) {
      const value = structuredClone(f.testRun);
      mutate(value);
      expect(() => verifyTestRun(value, testPolicy, f.root)).toThrow();
    }
    put(f.root, "packages/example/test/missing.unit.test.ts", "export {};\n");
    expect(() => verifyTestRun(f.testRun, testPolicy, f.root)).toThrow("inventory is incomplete");
  });
  it("snapshots source, test inputs, tool versions and rejects dirty source or escaped links", () => {
    const f = fixture(),
      p = policy();
    const snapshot = createSnapshot({ root: f.root, context: f.context, policy: p });
    expect(verifySnapshot(readJson(path.join(f.root, f.manifest.snapshot)), snapshot)).toBe(true);
    expect(sourceTreeDigest(collectSources(f.root, p))).toBe(snapshot.sourceTreeSha256);
    put(f.root, filename, `${source}// changed\n`);
    expect(() => createSnapshot({ root: f.root, context: f.context, policy: p })).toThrow(
      "differs from tested commit",
    );
    const working = createSnapshot({
      root: f.root,
      context: f.context,
      policy: p,
      sourceState: "working-tree",
    });
    expect(() => verifySnapshot(snapshot, working)).toThrow("snapshot changed");
    put(f.root, filename, source);
    put(f.root, "test/tooling/a.test.mjs", "export const changed = true;\n");
    expect(() =>
      verifySnapshot(snapshot, createSnapshot({ root: f.root, context: f.context, policy: p })),
    ).toThrow("inputs");
    symlinkSync(os.tmpdir(), path.join(f.root, "packages/escape"));
    expect(() => collectSources(f.root, p)).toThrow("symbolic link");
  });
  it("rejects missing or incompatible toolchain evidence", () => {
    const f = fixture(),
      p = policy();
    expect(verifyCoverageTools(f.root, p).vitest).toBe("4.1.9");
    p.provider.version = "4.2.0";
    expect(() => verifyCoverageTools(f.root, p)).toThrow("incomparable");
    p.provider.version = "4.1.9";
    p.provider.mapping = "unknown";
    expect(() => verifyCoverageTools(f.root, p)).toThrow("incomparable");
    p.provider.mapping = mappingIdentity;
    put(f.root, "node_modules/vitest/package.json", { version: "4.1.8" });
    expect(() => verifyCoverageTools(f.root, p)).toThrow("installed coverage tool differs");
    put(f.root, "package-lock.json", { packages: {} });
    expect(() => verifyCoverageTools(f.root, p)).toThrow("locked coverage tool differs");
    put(f.root, "ci/toolchain-lock.json", {});
    expect(() => createSnapshot({ root: f.root, context: f.context, policy: p })).toThrow(
      "toolchain does not match",
    );
  });
  it("uses exact push/manual bases and merge-base for a diverged PR", () => {
    const f = fixture(),
      sources = collectSources(f.root, policy());
    const diff = resolveCoverageDiff({ root: f.root, context: f.context, sources });
    expect(diff.baseSha).toBe(f.context.baseSha);
    expect(diff.changed[filename][0]).toMatchObject({ start: 1, kind: "added" });
    expect(
      resolveCoverageDiff({
        root: f.root,
        context: { ...f.context, event: "workflow_dispatch" },
        sources,
      }).sha256,
    ).toBe(diff.sha256);
    expect(() =>
      resolveCoverageDiff({
        root: f.root,
        context: { ...f.context, baseSha: "0".repeat(40) },
        sources,
      }),
    ).toThrow();
    git(f.root, "checkout", "--detach", f.context.baseSha);
    put(f.root, "README.md", "base diverged\n");
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "base advance");
    const advanced = git(f.root, "rev-parse", "HEAD");
    git(f.root, "checkout", "--detach", f.context.headSha);
    const pr = resolveCoverageDiff({
      root: f.root,
      context: { ...f.context, event: "pull_request", baseSha: advanced },
      sources,
    });
    expect(pr.baseSha).toBe(f.context.baseSha);
    put(f.root, "apps/new/src/index.ts", source);
    const dirty = resolveCoverageDiff({
      root: f.root,
      context: f.context,
      sources: collectSources(f.root, policy()),
      sourceState: "working-tree",
    });
    expect(dirty.changed["apps/new/src/index.ts"][0].start).toBe(1);
  });
  it("maps merge offsets, retains deletion context and rejects ambiguous or binary patches", () => {
    const hunks = parseDiffHunks("@@ -2,0 +3,2 @@ inserted\n@@ -8,2 +10 @@ replaced\n");
    expect(mapLineToTested(2, hunks)).toBe(2);
    expect(mapLineToTested(3, hunks)).toBe(5);
    expect(mapLineToTested(10, hunks)).toBe(11);
    expect(() => mapLineToTested(8, hunks)).toThrow("COVERAGE_INCOMPARABLE");
    expect(parseDiffHunks("@@ -4 +3,0 @@ deleted\n")[0].newCount).toBe(0);
    expect(() => parseDiffHunks("@@ broken")).toThrow("malformed");
    expect(() => parseDiffHunks("Binary files a and b differ")).toThrow("binary");
  });
  it("maps committed text containing binary marker literals without treating source as Git metadata", () => {
    const f = fixture(),
      baseSha = f.context.headSha;
    put(
      f.root,
      filename,
      'export const prefix = "Binary files ";\nexport const summary = "Binary files a and b differ";\nexport const patch = "GIT binary patch";\n',
    );
    git(f.root, "add", filename);
    git(f.root, "commit", "-qm", "add textual binary markers");
    const testedSha = git(f.root, "rev-parse", "HEAD");
    const diff = resolveCoverageDiff({
      root: f.root,
      context: { ...f.context, baseSha, headSha: testedSha, testedSha },
      sources: collectSources(f.root, policy()),
    });
    expect(diff.changed[filename]).toEqual(
      [1, 2, 3].map((line) => ({ start: line, end: line, kind: "added" })),
    );
    expect(
      parseDiffHunks(
        "@@ -1,3 +1,3 @@ Binary files a and b differ\n Binary files a and b differ\n-GIT binary patch\n+GIT binary patch\n",
      ),
    ).toEqual([{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }]);
  });
  it("rejects actual Git binary additions and changes in summary and binary-patch formats", () => {
    const f = fixture();
    put(f.root, filename, `${source}\0`);
    git(f.root, "add", filename);
    git(f.root, "commit", "-qm", "add binary production bytes");
    const testedSha = git(f.root, "rev-parse", "HEAD");
    for (const baseSha of [f.context.baseSha, f.context.headSha]) {
      const summary = git(f.root, "diff", baseSha, testedSha, "--", filename);
      expect(summary).toMatch(/^Binary files .+ and .+ differ$/mu);
      expect(() => parseDiffHunks(summary)).toThrow("binary production source cannot be mapped");
      const patch = git(f.root, "diff", "--binary", baseSha, testedSha, "--", filename);
      expect(patch).toMatch(/^GIT binary patch$/mu);
      expect(() => parseDiffHunks(patch)).toThrow("binary production source cannot be mapped");
      expect(() =>
        resolveCoverageDiff({
          root: f.root,
          context: { ...f.context, baseSha, headSha: testedSha, testedSha },
          sources: collectSources(f.root, policy()),
        }),
      ).toThrow("binary production source cannot be mapped");
    }
  });
  it("uses remaining-function deletion boundaries and preserves deleted source identities", () => {
    const f = fixture(false),
      baseSha = f.context.headSha;
    put(f.root, filename, "export function choose(flag) {\n}\n");
    git(f.root, "add", filename);
    git(f.root, "commit", "-qm", "remove return");
    let testedSha = git(f.root, "rev-parse", "HEAD");
    const removal = resolveCoverageDiff({
      root: f.root,
      context: { ...f.context, baseSha, headSha: testedSha, testedSha },
      sources: collectSources(f.root, policy()),
    });
    expect(removal.changed[filename]).toEqual([{ start: 1, end: 1, kind: "deletion-context" }]);
    rmSync(path.join(f.root, filename));
    put(f.root, "apps/retained/src/main.ts", source);
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "remove workspace source");
    testedSha = git(f.root, "rev-parse", "HEAD");
    const deleted = resolveCoverageDiff({
      root: f.root,
      context: { ...f.context, baseSha, headSha: testedSha, testedSha },
      sources: collectSources(f.root, policy()),
    });
    expect(deleted.deleted).toContain(filename);
    expect(deleted.changed).not.toHaveProperty(filename);
  });
  it("excludes merge-only inserted lines and rejects merge changes inside a PR hunk", () => {
    const f = fixture();
    put(f.root, filename, source.replace("  return", "  // target-only line\n  return"));
    git(f.root, "add", filename);
    git(f.root, "commit", "-qm", "tested merge insertion");
    let testedSha = git(f.root, "rev-parse", "HEAD");
    const context = { ...f.context, event: "pull_request", testedSha };
    const diff = resolveCoverageDiff({
      root: f.root,
      context,
      sources: collectSources(f.root, policy()),
    });
    expect(diff.changed[filename].map((range) => range.start)).toEqual([1, 3, 4]);
    put(f.root, filename, source.replace("? 1 : 0", "? 2 : 0"));
    git(f.root, "add", filename);
    git(f.root, "commit", "-qm", "tested merge edits head body");
    testedSha = git(f.root, "rev-parse", "HEAD");
    expect(() =>
      resolveCoverageDiff({
        root: f.root,
        context: { ...context, testedSha },
        sources: collectSources(f.root, policy()),
      }),
    ).toThrow("COVERAGE_INCOMPARABLE");
  });
  it("runs the CLI contract without rewriting the reviewed baseline and explicitly measures only valid reports", () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const f = fixture(),
      before = readFileSync(path.join(f.root, "ci/coverage-policy.json"), "utf8");
    expect(main(f.args).status).toBe("passed");
    expect(readFileSync(path.join(f.root, "ci/coverage-policy.json"), "utf8")).toBe(before);
    rmSync(path.join(f.root, ".ci-output/result.json"));
    expect(
      main([
        ...f.args,
        "--mode",
        "measure",
        "--baseline-output",
        path.join(f.root, "ci/coverage-policy.json"),
      ]).status,
    ).toBe("passed");
    expect(
      readJson(path.join(f.root, "ci/coverage-policy.json")).baseline.groups["packages/example"]
        .lines.pct,
    ).toBe(100);
    expect(() =>
      main(["--mode", "measure", "--context", "missing", "--output", "missing"]),
    ).toThrow("baseline output");
    expect(() =>
      main([...f.args, "--baseline-output", path.join(f.root, "ci/coverage-policy.json")]),
    ).toThrow("only explicit");
  });
  it("measures an initial candidate from the same bound reports without rewriting policy or evidence", () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const f = fixture();
    const retained = [
      "ci/coverage-policy.json",
      ...Object.values(f.manifest).filter((name) => name.startsWith(".ci-output/")),
    ];
    const before = retained.map((name) => readFileSync(path.join(f.root, name)));
    const candidate = path.join(f.root, ".ci-output/initial-coverage-baseline.json");
    const result = main([...f.args, "--mode", "measure", "--baseline-output", candidate]);
    expect(result).toMatchObject({ status: "passed", initialization: true, sourceState: "commit" });
    expect(readJson(candidate).baseline).toMatchObject({
      sourceSha: f.context.testedSha,
      sourceState: "commit",
      sourceTreeSha256: result.sourceTreeSha256,
      reportSha256: sha256(readFileSync(path.join(f.root, f.manifest.report))),
      lcovSha256: sha256(readFileSync(path.join(f.root, f.manifest.lcov))),
      groups: result.groups,
    });
    expect(retained.map((name) => readFileSync(path.join(f.root, name)))).toEqual(before);
  });
  it("retains a failed incremental measurement without creating a candidate or changing the existing baseline", () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const f = fixture();
    const policyBefore = readFileSync(path.join(f.root, "ci/coverage-policy.json"));
    const uncovered = { [filename]: record(filename, 0) };
    put(f.root, f.manifest.report, uncovered);
    put(f.root, f.manifest.lcov, lcov(uncovered));
    put(f.root, f.manifest.tests, { ...f.testRun, coverageMap: uncovered });
    const candidate = path.join(f.root, ".ci-output/initial-coverage-baseline.json");
    expect(main([...f.args, "--mode", "measure", "--baseline-output", candidate]).status).toBe(
      "failed",
    );
    expect(readJson(path.join(f.root, ".ci-output/result.json"))).toMatchObject({
      status: "failed",
      initialization: true,
    });
    expect(existsSync(candidate)).toBe(false);
    expect(readFileSync(path.join(f.root, "ci/coverage-policy.json"))).toEqual(policyBefore);
  });
  it.each(["source", "snapshot", "tests", "JSON", "LCOV"])(
    "refuses a baseline candidate when its bound %s evidence changes",
    (changedEvidence) => {
      const f = fixture();
      const candidate = path.join(f.root, ".ci-output/initial-coverage-baseline.json");
      if (changedEvidence === "source") put(f.root, filename, `${source}\n`);
      if (changedEvidence === "snapshot") {
        const snapshot = readJson(path.join(f.root, f.manifest.snapshot));
        snapshot.files[filename] = "0".repeat(64);
        put(f.root, f.manifest.snapshot, snapshot);
      }
      if (changedEvidence === "tests")
        put(f.root, f.manifest.tests, { ...f.testRun, success: false });
      if (changedEvidence === "JSON")
        put(f.root, f.manifest.report, { [filename]: record(filename, 0) });
      if (changedEvidence === "LCOV")
        put(f.root, f.manifest.lcov, lcov(f.coverage).replace("DA:2,1", "DA:2,0"));
      expect(() =>
        main([...f.args, "--mode", "measure", "--baseline-output", candidate]),
      ).toThrow();
      expect(existsSync(candidate)).toBe(false);
    },
  );
  it("refuses a stale/failed report, context mismatch, missing reports and unsafe output", () => {
    const f = fixture();
    put(f.root, f.manifest.tests, { ...f.testRun, success: false });
    expect(() => main(f.args)).toThrow("test run failed");
    put(f.root, f.manifest.tests, f.testRun);
    put(f.root, f.manifest.context, { ...f.context, policySha256: "0".repeat(64) });
    expect(() => main(f.args)).toThrow("accepted policy");
    put(f.root, f.manifest.context, f.context);
    rmSync(path.join(f.root, f.manifest.report));
    expect(() => main(f.args)).toThrow();
    const snapshotArgs = [
      "--root",
      f.root,
      "--mode",
      "snapshot",
      "--context",
      path.join(f.root, f.manifest.context),
      "--output",
      path.join(f.root, "ci/escaped.json"),
    ];
    expect(() => main(snapshotArgs)).toThrow("output must be inside");
    snapshotArgs[snapshotArgs.length - 1] = path.join(f.root, ".ci-output/new-snapshot.json");
    expect(main(snapshotArgs).status).toBe("passed");
    expect(() => main(snapshotArgs)).toThrow("already exists");
  });
  it("verifies isolated comparable migration evidence and rejects wrong or mutable old sources", () => {
    const f = fixture(false),
      accepted = baseline(analyze());
    accepted.provider.mapping = "previous-reviewed-mapping";
    const comparison = verifyComparison({
      root: repositoryRoot,
      policy: policy(),
      acceptedPolicy: accepted,
      testPolicy,
      manifest: f.manifest,
    });
    expect(
      evaluateCoverage({
        acceptedPolicy: accepted,
        proposedPolicy: policy(),
        analysis: analyze(),
        changed,
        initialization: false,
        comparison,
      }).status,
    ).toBe("passed");
    const wrong = structuredClone(accepted);
    wrong.baseline.sourceTreeSha256 = "0".repeat(64);
    expect(() =>
      verifyComparison({
        root: repositoryRoot,
        policy: policy(),
        acceptedPolicy: wrong,
        testPolicy,
        manifest: f.manifest,
      }),
    ).toThrow("source tree differs");
    expect(() =>
      verifyComparison({
        root: f.root,
        policy: policy(),
        acceptedPolicy: accepted,
        testPolicy,
        manifest: f.manifest,
      }),
    ).toThrow("isolated checkout");
    expect(() =>
      verifyComparison({
        root: repositoryRoot,
        policy: policy(),
        acceptedPolicy: accepted,
        testPolicy,
        manifest: { ...f.manifest, report: "../escape" },
      }),
    ).toThrow("evidence must be under");
    put(f.root, f.manifest.snapshot, {
      ...readJson(path.join(f.root, f.manifest.snapshot)),
      sourceState: "working-tree",
    });
    expect(() =>
      verifyComparison({
        root: repositoryRoot,
        policy: policy(),
        acceptedPolicy: accepted,
        testPolicy,
        manifest: f.manifest,
      }),
    ).toThrow("committed baseline sources");
  });
});
