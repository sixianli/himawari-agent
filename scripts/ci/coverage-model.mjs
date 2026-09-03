import path from "node:path";
import ts from "typescript";
import { safeRelativePath, sha256, validateRecord } from "./contracts.mjs";

export const metricNames = ["lines", "branches", "functions", "statements"];
export const mappingIdentity = "ast-v8-to-istanbul@1.0.5:original-locations-v1";
const assert = (condition, message) => {
  if (!condition) throw new Error(`COVERAGE_INVALID: ${message}`);
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keysEqual = (left, right) =>
  JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort());
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};

export const coverageDigest = (value) => sha256(JSON.stringify(canonical(value)));

export function strategyDigest(policy) {
  const { baseline: _baseline, thresholds: _thresholds, ...strategy } = policy;
  for (const key of ["projects", "include", "exclude"]) strategy[key] = [...strategy[key]].sort();
  return coverageDigest(strategy);
}

export function validateCoveragePolicy(policy, { enforceScope = true } = {}) {
  validateRecord("CoveragePolicy", policy);
  if (enforceScope)
    assert(
      JSON.stringify([...policy.projects].sort()) ===
        JSON.stringify(["contracts", "tooling", "unit"]),
      "collection must use unit/contracts/tooling",
    );
  const includes = [
    "apps/*/src/**/*.ts",
    "apps/*/src/**/*.tsx",
    "packages/*/src/**/*.ts",
    "packages/*/src/**/*.tsx",
    "scripts/ci/**/*.mjs",
  ];
  if (enforceScope)
    assert(
      JSON.stringify([...policy.include].sort()) === JSON.stringify(includes.sort()),
      "production include set changed",
    );
  if (enforceScope)
    assert(
      JSON.stringify([...policy.exclude].sort()) ===
        JSON.stringify(["**/*.d.ts", "packages/testing/**"].sort()),
      "production exclude set changed",
    );
  if (policy.baseline)
    for (const [group, metrics] of Object.entries(policy.baseline.groups)) {
      for (const name of metricNames) {
        const value = metrics[name];
        assert(
          value.covered <= value.total &&
            Math.abs(metric(value.covered, value.total).pct - value.pct) < 0.000001,
          `contradictory baseline metric ${group}/${name}`,
        );
      }
    }
  return policy;
}

export function inCoverageScope(filename, policy) {
  return (
    safeRelativePath(filename) &&
    policy.include.some((glob) => path.matchesGlob(filename, glob)) &&
    !policy.exclude.some((glob) => path.matchesGlob(filename, glob))
  );
}

export function groupFor(filename) {
  return filename.startsWith("scripts/ci/")
    ? "scripts/ci"
    : filename.split("/").slice(0, 2).join("/");
}

export function metric(covered, total) {
  return { total, covered, pct: total ? Math.floor((covered * 100000000) / total) / 1000000 : 100 };
}

function hasExecutableSyntax(source, filename) {
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  assert(ast.parseDiagnostics.length === 0, `source syntax cannot be mapped: ${filename}`);
  const runtime = (node) => {
    if (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
      return false;
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isEmptyStatement(node)
    )
      return false;
    if (ts.isFunctionDeclaration(node)) return Boolean(node.body);
    if (ts.isModuleDeclaration(node)) return node.body ? runtime(node.body) : false;
    if (ts.isModuleBlock(node) || ts.isSourceFile(node)) return node.statements.some(runtime);
    return true;
  };
  return runtime(ast);
}

function normalizePath(filename, root) {
  assert(
    typeof filename === "string" && !filename.includes("\\") && !filename.includes("\0"),
    "invalid source path",
  );
  const relative = path.isAbsolute(filename)
    ? path.relative(root, filename).split(path.sep).join("/")
    : filename;
  assert(safeRelativePath(relative), `source path escaped repository: ${filename}`);
  return relative;
}

const emptyLocation = (loc) =>
  object(loc) &&
  keysEqual(loc, { start: 0, end: 0 }) &&
  object(loc.start) &&
  object(loc.end) &&
  Object.keys(loc.start).length === 0 &&
  Object.keys(loc.end).length === 0;

function rejectCoverageIgnores(source, filename) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    )
      assert(
        !/\b(?:v8|c8|istanbul)\s+ignore\b/u.test(scanner.getTokenText()),
        `unreviewed coverage ignore: ${filename}`,
      );
}

function position(value, lines, filename, end = false) {
  assert(
    object(value) &&
      Number.isSafeInteger(value.line) &&
      value.line >= 1 &&
      value.line <= lines.length &&
      ((end && value.column === null) ||
        (integer(value.column) && value.column <= lines[value.line - 1].length)),
    `source-map position outside source: ${filename}`,
  );
}

function location(value, lines, filename) {
  assert(object(value), `missing source-map location: ${filename}`);
  position(value.start, lines, filename);
  // ast-v8-to-istanbul uses Infinity for the end of a mapped line. JSON encodes it as null.
  position(value.end, lines, filename, true);
  assert(
    value.end.line > value.start.line ||
      (value.end.line === value.start.line &&
        (value.end.column === null || value.end.column >= value.start.column)),
    `reversed source-map location: ${filename}`,
  );
}

function mapAndHits(map, hits, filename, kind) {
  assert(
    object(map) && object(hits) && keysEqual(map, hits),
    `${kind} map/count identities differ: ${filename}`,
  );
}

export function analyzeCoverage({ coverage, sources, policy, root }) {
  validateCoveragePolicy(policy);
  assert(object(coverage) && Object.keys(coverage).length > 0, "coverage report is empty");
  assert(sources instanceof Map && sources.size > 0, "production source inventory is empty");
  const files = {};
  for (const [key, record] of Object.entries(coverage)) {
    assert(object(record), "invalid file coverage record");
    const filename = normalizePath(key, root);
    assert(
      filename === normalizePath(record.path, root),
      `source-map identity differs: ${filename}`,
    );
    assert(
      inCoverageScope(filename, policy) && sources.has(filename),
      `unexpected coverage file: ${filename}`,
    );
    assert(!Object.hasOwn(files, filename), `duplicate coverage file: ${filename}`);
    const source = sources.get(filename);
    rejectCoverageIgnores(source, filename);
    const lines = source.split(/\r?\n/u);
    mapAndHits(record.statementMap, record.s, filename, "statement");
    mapAndHits(record.fnMap, record.f, filename, "function");
    mapAndHits(record.branchMap, record.b, filename, "branch");
    const lineHits = new Map();
    for (const [id, loc] of Object.entries(record.statementMap)) {
      location(loc, lines, filename);
      assert(integer(record.s[id]), `invalid statement hit count: ${filename}`);
      lineHits.set(loc.start.line, Math.max(lineHits.get(loc.start.line) ?? 0, record.s[id]));
    }
    for (const [id, fn] of Object.entries(record.fnMap)) {
      location(fn.loc, lines, filename);
      location(fn.decl, lines, filename);
      assert(integer(record.f[id]), `invalid function hit count: ${filename}`);
    }
    for (const [id, branch] of Object.entries(record.branchMap)) {
      location(branch.loc, lines, filename);
      assert(
        Array.isArray(branch.locations) &&
          branch.locations.length > 0 &&
          Array.isArray(record.b[id]) &&
          record.b[id].length === branch.locations.length,
        `branch map/count arity differs: ${filename}`,
      );
      for (const [index, loc] of branch.locations.entries()) {
        // The pinned mapper emits precisely this placeholder for an implicit else.
        if (
          branch.type === "if" &&
          index === 1 &&
          branch.locations.length === 2 &&
          emptyLocation(loc)
        )
          continue;
        location(loc, lines, filename);
      }
      assert(record.b[id].every(integer), `invalid branch hit count: ${filename}`);
    }
    assert(
      Object.keys(record.statementMap).length + Object.keys(record.fnMap).length > 0 ||
        !hasExecutableSyntax(source, filename),
      `empty executable denominator: ${filename}`,
    );
    const statements = Object.values(record.s);
    const functions = Object.values(record.f);
    const branches = Object.values(record.b).flat();
    files[filename] = {
      sourceSha256: sha256(source),
      metrics: {
        lines: metric([...lineHits.values()].filter((hits) => hits > 0).length, lineHits.size),
        branches: metric(branches.filter((hits) => hits > 0).length, branches.length),
        functions: metric(functions.filter((hits) => hits > 0).length, functions.length),
        statements: metric(statements.filter((hits) => hits > 0).length, statements.length),
      },
      lineHits: Object.fromEntries(lineHits),
      statementMap: record.statementMap,
      fnMap: record.fnMap,
      functionHits: record.f,
      branchMap: record.branchMap,
      branchHits: record.b,
    };
  }
  for (const filename of sources.keys())
    assert(Object.hasOwn(files, filename), `production file missing from coverage: ${filename}`);
  const groups = {};
  for (const [filename, file] of Object.entries(files)) {
    const group = groupFor(filename);
    groups[group] ??= Object.fromEntries(metricNames.map((name) => [name, metric(0, 0)]));
    for (const name of metricNames)
      groups[group][name] = metric(
        groups[group][name].covered + file.metrics[name].covered,
        groups[group][name].total + file.metrics[name].total,
      );
  }
  assert(
    Object.values(groups).some((group) => group.statements.total > 0),
    "all production executable denominators are empty",
  );
  const sourceTreeSha256 = sha256(
    Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filename, file]) => `${filename}\0${file.sourceSha256}\n`)
      .join(""),
  );
  return { files, groups, sourceTreeSha256 };
}

export function verifyLcov(text, analysis, root) {
  assert(typeof text === "string" && text.length > 0, "LCOV report missing");
  assert(text.trim().endsWith("end_of_record"), "truncated LCOV record");
  const observed = new Set();
  for (const block of text.split("end_of_record")) {
    const lines = block.trim().split(/\r?\n/u);
    if (lines.length === 1 && !lines[0]) continue;
    const fields = new Map();
    const rows = { FN: [], FNDA: [], DA: [], BRDA: [] };
    for (const line of lines) {
      const colon = line.indexOf(":");
      assert(colon > 0, "malformed LCOV field");
      const key = line.slice(0, colon);
      assert(
        ["TN", "SF", "LF", "LH", "FNF", "FNH", "BRF", "BRH", ...Object.keys(rows)].includes(key),
        `unknown LCOV field ${key}`,
      );
      if (rows[key]) rows[key].push(line.slice(colon + 1));
      if (["SF", "LF", "LH", "FNF", "FNH", "BRF", "BRH"].includes(key)) {
        assert(!fields.has(key), `duplicate LCOV field ${key}`);
        fields.set(key, line.slice(colon + 1));
      }
    }
    const filename = normalizePath(fields.get("SF"), root);
    assert(
      analysis.files[filename] && !observed.has(filename),
      `unexpected or duplicate LCOV file: ${filename}`,
    );
    observed.add(filename);
    const file = analysis.files[filename];
    const expectedRows = {
      FN: Object.values(file.fnMap).map((fn) => `${fn.decl.start.line},${fn.name}`),
      FNDA: Object.entries(file.fnMap).map(([id, fn]) => `${file.functionHits[id]},${fn.name}`),
      DA: Object.entries(file.lineHits).map(([line, hits]) => `${line},${hits}`),
      BRDA: Object.entries(file.branchMap).flatMap(([id, branch]) =>
        file.branchHits[id].map((hits, index) => `${branch.loc.start.line},${id},${index},${hits}`),
      ),
    };
    for (const key of Object.keys(rows))
      assert(
        JSON.stringify(rows[key].sort()) === JSON.stringify(expectedRows[key].sort()),
        `LCOV/JSON ${key} locations or hits differ: ${filename}`,
      );
    for (const [name, total, covered] of [
      ["lines", "LF", "LH"],
      ["functions", "FNF", "FNH"],
      ["branches", "BRF", "BRH"],
    ]) {
      assert(
        /^\d+$/u.test(fields.get(total)) && /^\d+$/u.test(fields.get(covered)),
        `missing LCOV metric: ${filename}/${name}`,
      );
      const expected = analysis.files[filename].metrics[name];
      assert(
        Number(fields.get(total)) === expected.total &&
          Number(fields.get(covered)) === expected.covered,
        `LCOV/JSON metrics differ: ${filename}/${name}`,
      );
    }
  }
  assert(observed.size === Object.keys(analysis.files).length, "LCOV file set differs from JSON");
  return { files: observed.size };
}

const overlaps = (loc, ranges) =>
  ranges.some(({ start, end, kind }) =>
    kind === "deletion-context"
      ? loc.start.line <= start && loc.end.line > start
      : loc.start.line <= end && loc.end.line >= start,
  );
const contains = (outer, inner) =>
  outer.start.line <= inner.start.line &&
  outer.end.line >= inner.end.line &&
  (outer.start.line !== inner.start.line || outer.start.column <= inner.start.column) &&
  (outer.end.line !== inner.end.line ||
    (outer.end.column ?? Infinity) >= (inner.end.column ?? Infinity));

export function changedMetrics(analysis, changed) {
  const lines = [];
  const functions = [];
  const branches = [];
  const unlocatedBranches = [];
  for (const [filename, ranges] of Object.entries(changed)) {
    if (!analysis.files[filename]) continue;
    const file = analysis.files[filename];
    const selectedLines = new Set();
    for (const loc of Object.values(file.statementMap))
      if (
        overlaps(
          loc,
          ranges.filter((range) => range.kind !== "deletion-context"),
        )
      )
        selectedLines.add(loc.start.line);
    for (const line of selectedLines)
      lines.push({ file: filename, line, covered: file.lineHits[line] > 0 });
    const changedFunctions = Object.entries(file.fnMap).filter(
      ([, fn]) => overlaps(fn.loc, ranges) || overlaps(fn.decl, ranges),
    );
    for (const [id, fn] of changedFunctions)
      functions.push({ file: filename, id, name: fn.name ?? "anonymous", location: fn.loc });
    for (const [id, branch] of Object.entries(file.branchMap)) {
      if (
        !changedFunctions.some(
          ([, fn]) =>
            contains(fn.loc, branch.loc) || branch.locations.some((loc) => contains(fn.loc, loc)),
        )
      )
        continue;
      for (const [index, loc] of branch.locations.entries()) {
        if (emptyLocation(loc)) {
          unlocatedBranches.push({
            file: filename,
            id,
            index,
            reason: "pinned mapper implicit else has no original source location",
          });
          continue;
        }
        branches.push({
          file: filename,
          id,
          index,
          location: loc,
          covered: file.branchHits[id][index] > 0,
        });
      }
    }
  }
  const lineMetric = metric(lines.filter((line) => line.covered).length, lines.length);
  const branchMetric = metric(branches.filter((branch) => branch.covered).length, branches.length);
  return {
    changedLines: {
      ...lineMetric,
      status: lines.length ? "measured" : "not_applicable",
      reason: lines.length ? null : "diff contains no source-mapped executable statement location",
      locations: lines,
    },
    changedFunctionBranches: {
      ...branchMetric,
      status: branches.length ? "measured" : "not_applicable",
      reason: branches.length
        ? null
        : functions.length
          ? "changed functions contain no source-mapped branch locations"
          : "diff intersects no source-mapped function",
      functions,
      locations: branches,
      unlocatedBranches,
    },
  };
}

export function evaluateCoverage({
  acceptedPolicy,
  proposedPolicy,
  analysis,
  changed,
  deleted = [],
  initialization,
  comparison,
}) {
  validateCoveragePolicy(proposedPolicy);
  if (!initialization) {
    validateCoveragePolicy(acceptedPolicy, { enforceScope: false });
    assert(acceptedPolicy.baseline !== null, "accepted baseline has no measurement");
    if (strategyDigest(acceptedPolicy) !== strategyDigest(proposedPolicy) && !comparison)
      throw new Error(
        "COVERAGE_INCOMPARABLE: provider, mapping, include/exclude, projects or thresholds changed; remeasure accepted and candidate sources with the same reviewed strategy",
      );
  }
  const policy = initialization ? proposedPolicy : acceptedPolicy;
  if (comparison) {
    assert(
      !initialization &&
        comparison.sourceTreeSha256 === acceptedPolicy.baseline.sourceTreeSha256 &&
        comparison.strategySha256 === strategyDigest(proposedPolicy),
      "comparison does not identify old baseline under candidate strategy",
    );
    validateCoveragePolicy({
      ...proposedPolicy,
      baseline: { ...acceptedPolicy.baseline, groups: comparison.groups },
    });
  }
  const incremental = changedMetrics(analysis, changed);
  const failures = [];
  for (const [name, threshold] of Object.entries(policy.thresholds)) {
    const value = incremental[name];
    if (value.total > 0 && value.covered * 100 < threshold * value.total)
      failures.push({
        code: name,
        required: threshold,
        actual: value.pct,
        message: `${name} coverage is below ${threshold}%`,
      });
  }
  const removedGroups = [];
  if (!initialization) {
    for (const [group, actual] of Object.entries(analysis.groups)) {
      if (Object.hasOwn(comparison?.groups ?? policy.baseline.groups, group)) continue;
      const proposed = proposedPolicy.baseline?.groups[group];
      if (
        !proposed ||
        metricNames.some((name) => coverageDigest(proposed[name]) !== coverageDigest(actual[name]))
      )
        failures.push({
          code: "new-group-baseline",
          group,
          message: "new production workspace requires an explicitly measured candidate baseline",
        });
    }
  }
  if (!initialization)
    for (const [group, baseline] of Object.entries(comparison?.groups ?? policy.baseline.groups)) {
      const actual = analysis.groups[group];
      if (!actual) {
        if (deleted.some((filename) => groupFor(filename) === group)) removedGroups.push(group);
        else
          failures.push({
            code: "missing-group",
            group,
            message: "accepted production workspace disappeared without a source deletion",
          });
        continue;
      }
      for (const name of metricNames) {
        const old = baseline[name];
        const next = actual[name];
        if (
          next.total > 0 &&
          (old.total
            ? next.covered * old.total < old.covered * next.total
            : next.covered < next.total)
        )
          failures.push({
            code: "baseline-regression",
            group,
            metric: name,
            required: old.pct,
            actual: next.pct,
            message: `${group}/${name} regressed`,
          });
      }
    }
  return {
    status: failures.length ? "failed" : "passed",
    initialization,
    groups: analysis.groups,
    removedGroups,
    ...incremental,
    failures,
  };
}
