import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { parseDocument } from "yaml";
import {
  fileSha256,
  githubExpression,
  parseArguments,
  readJson,
  repositoryRoot,
  safeRelativePath,
  sha256,
  validateRecord,
} from "./contracts.mjs";

const sorted = (values) => [...values].sort();
const sameSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const unique = (values, label) =>
  assert(new Set(values).size === values.length, `Duplicate ${label}`);
const jobIds = [
  "policy",
  "static",
  "build",
  "test",
  "node-floor",
  "browser",
  "coverage",
  "security",
  "required",
];
const mainProjects = ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"];

export function validatePolicy(policy) {
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
    "Policy must declare exactly nine required jobs",
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
      project.id !== "integration" || project.fileParallelism === false,
      "Integration files must execute serially",
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
    test: ["policy", "build"],
    "node-floor": ["policy"],
    browser: ["build"],
    coverage: ["policy"],
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
    assert(
      check.timeoutMinutes ===
        (check.id === "required"
          ? 5
          : ["build", "test", "node-floor", "browser"].includes(check.id)
            ? 30
            : 15),
      `Unexpected timeout: ${check.id}`,
    );
    const requiredProjects = ["test", "node-floor"].includes(check.id)
      ? mainProjects.filter((id) => id !== "tooling")
      : check.id === "coverage"
        ? ["unit", "contracts", "tooling"]
        : check.id === "policy"
          ? ["tooling"]
          : [];
    assert(sameSet(check.projects, requiredProjects), `Incomplete project selection: ${check.id}`);
    const requiredKeys = ["build", "test"].includes(check.id)
      ? ["linux-x64", "macos-arm64"]
      : check.id === "browser"
        ? ["chromium", "firefox", "webkit"]
        : ["default"];
    assert(
      sameSet(
        check.members.map((member) => member.key),
        requiredKeys,
      ),
      `Incomplete matrix: ${check.id}`,
    );
    for (const member of check.members) {
      const mac = member.key === "macos-arm64";
      assert(
        member.os === (mac ? "darwin" : "linux") &&
          member.arch === (mac ? "arm64" : "x64") &&
          member.runner === (mac ? "macos-15" : "ubuntu-24.04"),
        `Incorrect platform: ${check.id}/${member.key}`,
      );
      assert(
        check.id === "browser" ? member.browser === member.key : member.browser === undefined,
        `Incorrect browser identity: ${check.id}`,
      );
    }
    visit(check.id, new Set());
  }
  return policy;
}

function requireReadPermissions(permissions, label, root = false) {
  assert(
    permissions && typeof permissions === "object" && !Array.isArray(permissions),
    `${label}: permissions must be explicit`,
  );
  assert(
    Object.entries(permissions).every(
      ([key, value]) => ["contents", "actions"].includes(key) && value === "read",
    ),
    `${label}: write or unknown permissions`,
  );
  assert(!root || permissions.contents === "read", "Workflow requires contents: read");
}

export function validateWorkflow(policy, source, toolchain) {
  validatePolicy(policy);
  const document = parseDocument(source, { uniqueKeys: true, maxAliasCount: 0 });
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
  assert(sameSet(Object.keys(workflow.on), policy.events), "Unexpected workflow events");
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
      "edited",
    ]),
    "PR activity types are incomplete",
  );
  assert(
    sameSet(workflow.on.push?.branches ?? [], [policy.defaultBranch]),
    "Push must target the default branch",
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
  ]
    .map(githubExpression)
    .join("-");
  assert(
    workflow.concurrency.group === concurrencyGroup,
    "Concurrency must identify the actual workflow, event, PR/ref, and unique push run",
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
    else assert(job.if === undefined, `Required job cannot be conditional: ${check.id}`);
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
        sameSet(matrix.include.map(canonical), check.members.map(canonical)),
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
        assert(actions.get(match[1]) === match[2], `Action is not toolchain-locked: ${step.uses}`);
        if (match[1] === "actions/checkout")
          assert(
            step.with?.["persist-credentials"] === false,
            "Checkout must not persist credentials",
          );
      }
    }
    if (check.id === "coverage") {
      const executions = job.steps.filter((step) => step.run?.includes("scripts/ci/run.mjs"));
      assert(
        executions.length === 1 &&
          executions[0].if === undefined &&
          executions[0].run ===
            '.ci-output/tools/bin/node scripts/ci/run.mjs --check coverage --matrix "$CI_MATRIX" --base "$CI_BASE" --tools .ci-output/tools --output .ci-output/check --baseline-candidate initial-only',
        "Coverage must use the shared runner with the initial-only baseline candidate option",
      );
    }
  }
  assert(!JSON.stringify(workflow).includes("secrets."), "Required CI cannot reference secrets");
  return {
    jobs: policy.checks.length,
    members: policy.checks.reduce((total, check) => total + check.members.length, 0),
  };
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
  const roots = new Map();
  const namespaces = new Set();
  const rootNames = new Set(globals.keys());
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "vitest") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(checker.getSymbolAtLocation(bindings.name));
      rootNames.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) {
        if (
          ["describe", "suite", "it", "test"].includes(item.propertyName?.text ?? item.name.text)
        ) {
          roots.set(checker.getSymbolAtLocation(item.name), [
            item.propertyName?.text ?? item.name.text,
          ]);
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
  let declarations = 0;
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
  return { declarations, modifiers, emptySuites };
}

export function validateTestInventory(policy, files, readSource) {
  validatePolicy(policy);
  unique(files, "inventory file");
  const tests = files.filter((file) => /(?:\.test|\.spec|\.type-test)\.[cm]?[jt]sx?$/u.test(file));
  const counts = Object.fromEntries(policy.testProjects.map((project) => [project.id, 0]));
  const registered = new Map(policy.registeredTests.map((entry) => [entry.path, entry]));
  for (const registration of policy.registeredTests)
    assert(tests.includes(registration.path), `Stale test registration: ${registration.path}`);
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
    if (registration?.kind === "type-check") continue;
    const inspection = inspectTestSource(readSource(filename), filename);
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
  }
  for (const [id, count] of Object.entries(counts)) assert(count > 0, `Empty project: ${id}`);
  return { files: tests.length, projects: counts };
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
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
  const policy = validatePolicy(JSON.parse(bytes));
  const coverage = hasCoverage ? JSON.parse(git(["show", `${baseSha}:${coveragePath}`])) : null;
  assert(
    !hasCoverage || (coverage && typeof coverage === "object" && !Array.isArray(coverage)),
    "Damaged coverage policy at base",
  );
  if (hasCoverage) {
    validateRecord("CoveragePolicy", coverage);
    assert(coverage.baseline !== null, "Accepted coverage policy has no measured baseline");
  }
  return { policy, policySha256: sha256(bytes), coverage, baseSha, initialization: !hasPolicy };
}

export function validateToolchain(policy, lock, packageManifest) {
  assert(lock.schemaVersion === 1, "Unknown toolchain schema");
  assert(
    /^\d+\.\d+\.\d+$/u.test(lock.node?.baseline) && /^\d+\.\d+\.\d+$/u.test(lock.node?.floor),
    "Node versions must be exact",
  );
  assert(
    packageManifest.packageManager === `npm@${lock.npm?.version}`,
    "npm identity differs from toolchain",
  );
  for (const check of policy.checks)
    for (const member of check.members)
      assert(
        member.node === (check.id === "node-floor" ? lock.node.floor : lock.node.baseline),
        `Node identity drift: ${check.id}`,
      );
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
  const workflow = path.resolve(root, args["--workflow"] ?? ".github/workflows/ci.yml");
  validateWorkflow(proposed, readFileSync(workflow, "utf8"), lock);
  // The accepted contract also has to hold: proposed changes cannot excuse their own failures.
  validateWorkflow(source.policy, readFileSync(workflow, "utf8"), lock);
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
  const inventory = validateTestInventory(source.policy, [...new Set(files)], (file) =>
    readFileSync(path.join(root, file), "utf8"),
  );
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
