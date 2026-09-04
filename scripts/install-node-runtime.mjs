import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectArtifactFiles, contentDigest, digestFile } from "./ci/artifact-files.mjs";
import { parseArguments } from "./ci/contracts.mjs";
import { verifyArtifact } from "./ci/verify-artifact.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function installNodeRuntime({
  prefix,
  source = path.join(repositoryRoot, "dist/node-runtime"),
  archive,
  context,
  expectedSha256,
  root = repositoryRoot,
} = {}) {
  if (!prefix || !path.isAbsolute(prefix))
    throw new Error("--prefix requires an absolute installation target");
  let temporary;
  let archiveDigest;
  let verifiedFiles;
  const libDirectory = path.join(prefix, "lib/himawari-agent");
  const binDirectory = path.join(prefix, "bin");
  await mkdir(path.dirname(libDirectory), { recursive: true });
  try {
    if (archive) {
      temporary = await mkdtemp(path.join(path.dirname(libDirectory), ".himawari-install-"));
      const verified = await verifyArtifact({
        archive,
        context,
        expectedSha256,
        root,
        extractTo: path.join(temporary, "payload"),
      });
      archiveDigest = verified.sha256;
      verifiedFiles = verified.manifest.files
        .filter((file) => file.path.startsWith("runtime/"))
        .map((file) => ({ ...file, path: file.path.slice("runtime/".length) }));
      source = path.join(verified.root, "runtime");
    }
    const runtime = JSON.parse(await readFile(path.join(source, "runtime-manifest.json"), "utf8"));
    const sourceFiles = verifiedFiles ?? (await collectArtifactFiles(source));
    for (const entry of Object.values(runtime.entrypoints))
      if (!sourceFiles.some((file) => file.path === entry))
        throw new Error("INSTALL_ENTRYPOINT_MISSING");
    await rm(libDirectory, { recursive: true, force: true });
    if (archive) await rename(source, libDirectory);
    else {
      await cp(source, libDirectory, { recursive: true });
      if (contentDigest(await collectArtifactFiles(libDirectory)) !== contentDigest(sourceFiles))
        throw new Error("INSTALL_CONTENT_CHANGED");
    }
    await mkdir(binDirectory, { recursive: true });
    const entries = {
      himawari: "himawari",
      "himawari-agent-service": "agentService",
      "himawari-execution-worker": "executionWorker",
    };
    for (const [command, key] of Object.entries(entries)) {
      const target = path.join(binDirectory, command);
      const modulePath = path.join(libDirectory, runtime.entrypoints[key]);
      await writeFile(
        target,
        `#!/bin/sh\nunset NODE_PATH\nexec node --no-global-search-paths ${quote(modulePath)} "$@"\n`,
        { mode: 0o755 },
      );
      await chmod(target, 0o755);
    }
    if (archive && (await digestFile(archive)) !== archiveDigest)
      throw new Error("INSTALL_ARCHIVE_CHANGED");
    return { prefix, files: sourceFiles.length, archiveSha256: archiveDigest ?? null };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2), [
      "--prefix",
      "--source",
      "--artifact",
      "--context",
      "--expected-sha256",
    ]);
    if (args["--source"] && args["--artifact"])
      throw new Error("Provide exactly one runtime source");
    const context = args["--context"]
      ? JSON.parse(await readFile(args["--context"], "utf8"))
      : undefined;
    const result = await installNodeRuntime({
      prefix: args["--prefix"],
      source: args["--source"],
      archive: args["--artifact"],
      context,
      expectedSha256: args["--expected-sha256"],
    });
    console.log(`Himawari Node runtime installed under ${result.prefix}`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
