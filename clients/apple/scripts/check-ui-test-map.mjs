import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const appleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appleRoot, "../..");

export const MAP_PATH = "clients/apple/ui-test-map.json";
export const SCENES_PATH = "clients/apple/Sources/HimawariShell/DemoScenes.swift";
export const UI_TESTS_DIRECTORY = "clients/apple/App/UITests";
export const UI_TEST_TARGET = "HimawariUITests";
export const WORKFLOWS_DIRECTORY = ".github/workflows";

export function demoScenes(source) {
  const start = source.search(/enum\s+DemoScene\s*:\s*String\b[^{]*\{/u);
  if (start < 0) throw new Error(`UI_MAP_SCENES_UNREADABLE no DemoScene enum in ${SCENES_PATH}`);
  let depth = 0;
  let end = -1;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const body = source.slice(start, end);
  const scenes = [...body.matchAll(/^\s*case\s+\w+\s*=\s*"([^"]+)"/gmu)].map((match) => match[1]);
  if (scenes.length === 0) throw new Error(`UI_MAP_SCENES_UNREADABLE DemoScene has no cases`);
  return scenes;
}

export function uiTestMethods(files) {
  const tests = new Set();
  for (const { source } of files) {
    for (const block of source.split(/(?=\bclass\s+\w+\s*:)/u)) {
      const owner = /^class\s+(\w+)\s*:/u.exec(block);
      if (!owner) continue;
      for (const method of block.matchAll(/\bfunc\s+(test\w*)\s*\(/gu))
        tests.add(`${UI_TEST_TARGET}/${owner[1]}/${method[1]}`);
    }
  }
  return tests;
}

function shellDefaults(script) {
  const values = new Map();
  for (const match of script.matchAll(/^\s*(\w+)="\$\{\w+:-([^}"]*)\}"\s*$/gmu))
    values.set(match[1], match[2]);
  for (const match of script.matchAll(/^\s*(\w+)="([^"$`]*)"\s*$/gmu))
    if (!values.has(match[1])) values.set(match[1], match[2]);
  return values;
}

function selectors(command, flag, values) {
  const found = [];
  for (const match of command.matchAll(new RegExp(`-${flag}:("[^"]*"|\\S+)`, "gu"))) {
    const raw = match[1].replace(/^"|"$/gu, "");
    const resolved = raw.replace(/\$\{?(\w+)\}?/gu, (_, name) =>
      values.has(name) ? values.get(name) : "\u0000",
    );
    if (!resolved.includes("\u0000")) found.push(resolved);
  }
  return found;
}

function testInvocations(text, values) {
  const invocations = [];
  for (const piece of text.split(/(?=\bxcodebuild\b)/u)) {
    if (!/^xcodebuild\b/u.test(piece)) continue;
    const command = piece.replace(/\\\n/gu, " ").split(/\n\s*\n|;\s*$|\|/mu)[0] ?? "";
    if (!/\s(?:test|test-without-building)(?:\s|$)/u.test(command)) continue;
    const only = selectors(command, "only-testing", values);
    const onlyMentioned = /-only-testing:/u.test(command);
    if (onlyMentioned && only.length === 0) continue;
    invocations.push({
      only: onlyMentioned ? only : [UI_TEST_TARGET],
      skip: selectors(command, "skip-testing", values),
    });
  }
  return invocations;
}

export function ciTestRuns({ workflows, readScript }) {
  const runs = [];
  for (const { file, source } of workflows) {
    const workflow = parse(source) ?? {};
    for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
      for (const step of definition?.steps ?? []) {
        if (typeof step?.run !== "string") continue;
        for (const invocation of testInvocations(step.run, new Map()))
          runs.push({ ...invocation, where: `${file} ${job}` });
        for (const match of step.run.matchAll(/\b(clients\/apple\/scripts\/[\w./-]+\.sh)\b/gu)) {
          const script = readScript(match[1]);
          if (script === undefined) continue;
          for (const invocation of testInvocations(script, shellDefaults(script)))
            runs.push({ ...invocation, where: `${file} ${job} ${match[1]}` });
        }
      }
    }
  }
  return runs;
}

function covers(selector, test) {
  return test === selector || test.startsWith(`${selector}/`);
}

export function runByCi(test, runs) {
  return runs.some(
    (run) =>
      run.only.some((selector) => covers(selector, test)) &&
      !run.skip.some((selector) => covers(selector, test)),
  );
}

function sceneStatus(map) {
  const status = new Map();
  for (const feature of map?.features ?? [])
    for (const scene of feature.scenes ?? [])
      status.set(scene, (feature.tests ?? []).length > 0 ? "tested" : "uncovered");
  return status;
}

export function checkMap({ map, scenes, tests, runs, baseMap }) {
  const errors = [];
  const excluded = new Map((map.notFunctionalTests ?? []).map((entry) => [entry.test, entry]));
  for (const entry of map.notFunctionalTests ?? [])
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      errors.push(`UI_MAP_EXCLUSION_WITHOUT_REASON ${entry.test}`);
  const seen = new Map();
  for (const feature of map.features ?? []) {
    const name = feature.feature;
    if (typeof name !== "string" || name.trim() === "") {
      errors.push(`UI_MAP_FEATURE_UNNAMED scenes=${(feature.scenes ?? []).join(",")}`);
      continue;
    }
    const featureTests = feature.tests ?? [];
    const uncovered = typeof feature.uncovered === "string" && feature.uncovered.trim() !== "";
    if (featureTests.length === 0 && !uncovered)
      errors.push(`UI_MAP_FEATURE_WITHOUT_TEST ${name}: name a UI test or say why it has none`);
    if (featureTests.length > 0 && feature.uncovered !== undefined)
      errors.push(`UI_MAP_FEATURE_BOTH ${name}: it names tests and also says it has none`);
    for (const test of featureTests) {
      if (excluded.has(test))
        errors.push(`UI_MAP_TEST_NOT_FUNCTIONAL ${name}: ${test} (${excluded.get(test).reason})`);
      else if (!tests.has(test)) errors.push(`UI_MAP_TEST_MISSING ${name}: ${test}`);
      else if (!runByCi(test, runs)) errors.push(`UI_MAP_TEST_NOT_RUN_BY_CI ${name}: ${test}`);
    }
    for (const scene of feature.scenes ?? []) {
      if (seen.has(scene))
        errors.push(`UI_MAP_SCENE_TWICE ${scene}: ${seen.get(scene)} and ${name}`);
      seen.set(scene, name);
    }
  }
  const current = new Set(scenes);
  for (const scene of scenes)
    if (!seen.has(scene))
      errors.push(
        `UI_MAP_SCENE_MISSING ${scene}: add it to ${MAP_PATH} with the UI test that operates it`,
      );
  for (const scene of seen.keys())
    if (!current.has(scene))
      errors.push(`UI_MAP_SCENE_GONE ${scene}: it is no longer a demo scene`);
  const before = sceneStatus(baseMap);
  for (const [scene, status] of sceneStatus(map))
    if (status === "uncovered" && before.get(scene) !== "uncovered")
      errors.push(
        `UI_MAP_UNCOVERED_GREW ${scene}: scenes without a UI test may only go away; this one ${before.has(scene) ? "had a test on the base" : "is new"}, so it needs a UI test that CI runs`,
      );
  return errors;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function baseMapSource(base) {
  const ref = base ?? git(["merge-base", "HEAD", "origin/main"]);
  try {
    return git(["show", `${ref}:${MAP_PATH}`]);
  } catch {
    return undefined;
  }
}

function readRepository(relative) {
  const file = path.join(repositoryRoot, relative);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function listFiles(relative, pattern) {
  const directory = path.join(repositoryRoot, relative);
  return readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => ({
      file: `${relative}/${name}`,
      source: readFileSync(path.join(directory, name), "utf8"),
    }));
}

export function checkRepository({ base } = {}) {
  const map = JSON.parse(readRepository(MAP_PATH));
  let baseSource;
  try {
    baseSource = baseMapSource(base);
  } catch (error) {
    return [`UI_MAP_BASE_UNAVAILABLE ${String(error.message).split("\n")[0]}`];
  }
  return checkMap({
    map,
    scenes: demoScenes(readRepository(SCENES_PATH)),
    tests: uiTestMethods(listFiles(UI_TESTS_DIRECTORY, /\.swift$/u)),
    runs: ciTestRuns({
      workflows: listFiles(WORKFLOWS_DIRECTORY, /\.ya?ml$/u),
      readScript: readRepository,
    }),
    baseMap: baseSource === undefined ? map : JSON.parse(baseSource),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseIndex = process.argv.indexOf("--base");
  const errors = checkRepository({
    base: baseIndex > 0 ? process.argv[baseIndex + 1] : process.env.UI_MAP_BASE,
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(`UI_MAP_FAILED ${errors.length}`);
    process.exit(1);
  }
  const map = JSON.parse(readRepository(MAP_PATH));
  const status = sceneStatus(map);
  const tested = [...status.values()].filter((value) => value === "tested").length;
  console.log(
    `UI_MAP_PASSED scenes=${status.size} tested=${tested} uncovered=${status.size - tested}`,
  );
}
