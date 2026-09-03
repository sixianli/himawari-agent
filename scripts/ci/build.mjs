import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateArtifactManifest } from "../generate-artifact-manifest.mjs";
import { packageNodeRuntime } from "../package-node-runtime.mjs";
import { collectArtifactFiles, contentDigest, digestFile } from "./artifact-files.mjs";
import { outputPath, verifyContext } from "./context.mjs";
import { fileSha256, parseArguments, repositoryRoot } from "./contracts.mjs";
import { execute } from "./execute.mjs";
import {
  assertArtifactRecord,
  runArchiveTool,
  sourceTreeDigest,
  verifyExtractedArtifact,
} from "./verify-artifact.mjs";

export async function build({ root = repositoryRoot, output, context } = {}) {
  verifyContext(context, { root });
  const destination = outputPath(output, root);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination, { recursive: false });
  const work = path.join(destination, "work");
  const payload = path.join(work, "payload");
  const compiled = path.join(work, "compiled");
  const runtimeRoot = path.join(payload, "runtime");
  const browserRoot = path.join(payload, "browser");
  await mkdir(payload, { recursive: true });
  const checks = [];
  const commandReports = [];
  const command = async (name, args, cwd = root, env = process.env) => {
    const log = path.join(destination, `${name}.log`);
    const outcome = await execute(process.execPath, args, { cwd, env, log, timeoutMs: 300_000 });
    commandReports.push({ path: log, kind: "diagnostic" });
    if (outcome.exitCode !== 0) throw new Error(`CI_COMMAND_FAILED:${name}:${outcome.exitCode}`);
    return log;
  };
  try {
    const before = await sourceTreeDigest(root);
    await command("compile-node", [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.node-build.json",
      "--outDir",
      compiled,
    ]);
    checks.push("fresh-node-compile");
    await packageNodeRuntime({ root, buildRoot: compiled, runtimeRoot });
    checks.push("runtime-dependency-closure");
    await command(
      "compile-browser",
      [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--outDir", browserRoot],
      path.join(root, "apps/control-center"),
    );
    checks.push("browser-build");
    const budgetLog = await command("browser-budget", [
      path.join(root, "scripts/check-control-center-build.mjs"),
      "--output-root",
      browserRoot,
    ]);
    const budget = JSON.parse((await readFile(budgetLog, "utf8")).split("\n")[0]);
    const budgetPath = path.join(destination, "browser-budget.json");
    await writeFile(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
    checks.push("browser-budget");
    await command(
      "native-probe",
      [
        "--no-global-search-paths",
        "--input-type=module",
        "-e",
        "import {createRequire} from 'node:module';const require=createRequire(process.cwd()+'/runtime-manifest.json');const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES(42)');if(db.prepare('SELECT value FROM probe').get().value!==42)process.exit(1);db.close();",
      ],
      runtimeRoot,
      { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    );
    checks.push("packaged-sqlite-read-write");
    await collectArtifactFiles(payload, { normalizeModes: true });
    const manifestPath = path.join(destination, "build-manifest.json");
    const buildManifest = await generateArtifactManifest({
      root,
      output: manifestPath,
      nodeRoot: runtimeRoot,
      browserRoot,
      requireBuiltArtifacts: true,
    });
    const files = await collectArtifactFiles(payload);
    const record = assertArtifactRecord({
      schemaVersion: 1,
      context,
      platform: { os: process.platform, arch: process.arch, abi: process.versions.modules },
      node: process.versions.node,
      lockSha256: fileSha256(path.join(root, "package-lock.json")),
      sourceTreeSha256: before,
      contentSha256: contentDigest(files),
      generatedAt: new Date().toISOString(),
      files,
      entrypoints: buildManifest.runtime.entrypoints,
      externalDependencyClosure: buildManifest.runtime.externalDependencyClosure,
      migrations: files
        .filter((file) =>
          /^runtime\/node_modules\/@himawari-agent\/persistence-sqlite\/dist\/migrations\/[^/]+\.sql$/u.test(
            file.path,
          ),
        )
        .map((file) => file.path),
    });
    await writeFile(
      path.join(payload, "artifact-record.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o644 },
    );
    await verifyExtractedArtifact(payload, { root, context });
    checks.push("complete-content-verification");
    const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
    const archive = path.join(
      destination,
      `${platform}-abi${process.versions.modules}-${context.testedSha}-${context.runId}-${context.attempt}.tar.gz`,
    );
    const stagingArchive = `${archive}.partial`;
    runArchiveTool("create", payload, stagingArchive);
    if ((await sourceTreeDigest(root)) !== before)
      throw new Error("BUILD_INPUT_CHANGED_DURING_BUILD");
    await rename(stagingArchive, archive);
    checks.push("immutable-archive");
    const sha256 = await digestFile(archive);
    const bytes = (await stat(archive)).size;
    const reportPath = path.join(destination, "build.json");
    const counts = {
      files: files.length,
      executed: checks.length,
      passed: checks.length,
      failed: 0,
      skipped: 0,
    };
    await writeFile(
      reportPath,
      `${JSON.stringify({ status: "passed", counts, checks, archiveSha256: sha256, archiveBytes: bytes, manifest: record }, null, 2)}\n`,
    );
    return {
      counts,
      projects: [],
      reports: [
        ...commandReports,
        { path: reportPath, kind: "json" },
        { path: manifestPath, kind: "json" },
        { path: budgetPath, kind: "json" },
        { path: archive, kind: "artifact" },
      ],
      artifact: { path: archive, sha256, platform },
      archive,
      manifest: record,
      sha256,
      bytes,
      platform,
      exitCode: 0,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function buildMain(
  argv = process.argv.slice(2),
  { root = repositoryRoot, stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const args = parseArguments(argv, ["--output", "--context"]);
    const result = await build({
      root,
      output: args["--output"],
      context: JSON.parse(await readFile(args["--context"], "utf8")),
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await buildMain();
}
