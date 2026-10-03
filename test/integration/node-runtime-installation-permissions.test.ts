import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { digestSandboxRuntime as digestSourceRuntime } from "../../packages/platform-node/src/capabilities/sandbox-host-verifier.js";
import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let expectedRuntimeFiles: { path: string; sha256: string; bytes: number; mode: number }[];
const [{ assertArtifactRecord }, artifactFiles] = await Promise.all([
  import(pathToFileURL(path.join(repositoryRoot, "scripts/ci/verify-artifact.mjs")).href),
  import(pathToFileURL(path.join(repositoryRoot, "scripts/ci/artifact-files.mjs")).href),
]);
const contentDigest: (files: typeof expectedRuntimeFiles) => string = artifactFiles.contentDigest;

async function installationModes(root: string) {
  const entries: { path: string; directory: boolean; mode: number }[] = [];
  const visit = async (filename: string) => {
    const info = await lstat(filename);
    entries.push({
      path: path.relative(root, filename) || ".",
      directory: info.isDirectory(),
      mode: info.mode & 0o777,
    });
    if (info.isDirectory())
      for (const name of (await readdir(filename)).sort()) await visit(path.join(filename, name));
  };
  await visit(root);
  return entries;
}

async function createSourceFixture(source: string) {
  const inputs = [
    {
      path: "runtime-manifest.json",
      content: JSON.stringify({
        entrypoints: { himawari: "main.js", agentService: "main.js", executionWorker: "main.js" },
      }),
      mode: 0o644,
    },
    { path: "package.json", content: JSON.stringify({ type: "module" }), mode: 0o644 },
    { path: "main.js", content: "process.stdout.write('fixture runtime');\n", mode: 0o644 },
    { path: "assets/nested/data.txt", content: "original fixture data\n", mode: 0o644 },
    {
      path: "tools/nested/run.sh",
      content: "#!/bin/sh\nprintf 'fixture executable\\n'\n",
      mode: 0o755,
    },
  ];
  for (const input of inputs) {
    const filename = path.join(source, input.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, input.content);
    await chmod(filename, input.mode);
  }
  const sourceModes = await installationModes(source);
  for (const entry of sourceModes.filter((entry) => entry.directory))
    await chmod(path.join(source, entry.path), entry.path.startsWith("tools") ? 0o777 : 0o775);
  return inputs.map(({ path: relative, content, mode }) => ({
    path: relative,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    mode,
  }));
}

beforeAll(async () => {
  if (!process.env["HIMAWARI_TEST_ARTIFACT"] || !process.env["HIMAWARI_TEST_CONTEXT"])
    throw new Error("INSTALL_PERMISSIONS_TEST_REQUIRES_PREBUILT_ARTIFACT");
  const startedAt = Date.now();
  const record = spawnSync(
    process.env["HIMAWARI_CI_PYTHON"] as string,
    [
      "-B",
      "-c",
      "import sys,tarfile\nwith tarfile.open(sys.argv[1],'r|gz') as tar:\n member=tar.next()\n assert member is not None and member.name=='artifact-record.json' and member.isfile()\n sys.stdout.buffer.write(tar.extractfile(member).read())\n",
      process.env["HIMAWARI_TEST_ARTIFACT"],
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(record.status, record.stderr).toBe(0);
  const manifest = assertArtifactRecord(JSON.parse(record.stdout));
  expect(manifest.context).toEqual(
    JSON.parse(await readFile(process.env["HIMAWARI_TEST_CONTEXT"], "utf8")),
  );
  expectedRuntimeFiles = manifest.files
    .filter((file: { path: string }) => file.path.startsWith("runtime/"))
    .map((file: { path: string; sha256: string; bytes: number; mode: number }) => ({
      ...file,
      path: file.path.slice("runtime/".length),
    }));
  const diagnostics = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
  if (diagnostics)
    await writeFile(
      path.join(diagnostics, "installation-original-artifact.json"),
      JSON.stringify({
        elapsedMs: Date.now() - startedAt,
        runtimeFiles: expectedRuntimeFiles.length,
      }),
      { mode: 0o600 },
    );
});

describe("runtime permissions through full artifacts and small source fixtures", () => {
  it("[R2-D15] rejects linked source roots without changing source directories or the existing runtime", async () => {
    const temporary = await mkdtemp(path.join(testTemporaryRoot(), "install-linked-source-"));
    try {
      const source = path.join(temporary, "source");
      await createSourceFixture(source);
      const originalModes = await installationModes(source);
      const linkedSource = path.join(temporary, "linked-source");
      await symlink(source, linkedSource, "dir");
      const prefix = path.join(temporary, "prefix");
      const existingRuntime = path.join(prefix, "lib/himawari-agent");
      await mkdir(existingRuntime, { recursive: true });
      await writeFile(path.join(existingRuntime, "preserved.txt"), "existing runtime\n");
      const installed = spawnSync(
        process.execPath,
        [
          path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
          "--prefix",
          prefix,
          "--source",
          linkedSource,
        ],
        { encoding: "utf8", env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" } },
      );
      const sourceModes = await installationModes(source);
      const diagnostics = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
      if (diagnostics)
        await writeFile(
          path.join(diagnostics, "installation-linked-source.json"),
          JSON.stringify(
            {
              status: installed.status,
              stdout: installed.stdout,
              stderr: installed.stderr,
              originalModes,
              sourceModes,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      expect(sourceModes).toEqual(originalModes);
      expect(installed.status).not.toBe(0);
      expect(installed.stderr).toContain("ARTIFACT_LINK_FORBIDDEN");
      expect(await readFile(path.join(existingRuntime, "preserved.txt"), "utf8")).toBe(
        "existing runtime\n",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it.each([
    ["artifact", "0002", "new"],
    ["source", "0002", "new"],
    ["artifact", "0077", "new"],
    ["source", "0077", "new"],
    ["artifact", "0002", "0700"],
    ["source", "0002", "0770"],
    ["source", "0002", "0700"],
    ["source", "0077", "0700"],
    ["source", "0077", "0770"],
    ["source", "0002", "private-parent"],
  ])(
    "[R2-D15] %s installation is accepted by the product verifier under umask %s with prefix %s",
    async (kind, mask, prefixMode) => {
      const temporary = await mkdtemp(path.join(testTemporaryRoot(), "install-modes-"));
      const requestedPrefix =
        prefixMode === "private-parent"
          ? `${temporary}/private/missing/../prefix`
          : path.join(temporary, "new-parent/inner/prefix");
      const prefix = path.resolve(requestedPrefix);
      try {
        if (prefixMode === "private-parent") {
          await mkdir(path.join(temporary, "private"));
          await chmod(path.join(temporary, "private"), 0o700);
        }
        if (["0700", "0770"].includes(prefixMode)) {
          for (const directory of [prefix, path.join(prefix, "lib"), path.join(prefix, "bin")]) {
            await mkdir(directory, { recursive: true });
            await chmod(directory, Number.parseInt(prefixMode, 8));
          }
        }
        const source = path.join(temporary, "source");
        const originalFiles =
          kind === "source" ? await createSourceFixture(source) : expectedRuntimeFiles;
        const originalSourceModes = kind === "source" ? await installationModes(source) : undefined;
        const args =
          kind === "artifact"
            ? [
                "--artifact",
                process.env["HIMAWARI_TEST_ARTIFACT"] as string,
                "--context",
                process.env["HIMAWARI_TEST_CONTEXT"] as string,
              ]
            : ["--source", source];
        const installed = spawnSync(
          "/bin/sh",
          [
            "-c",
            'umask "$1"; shift; exec "$@"',
            "install-under-umask",
            mask,
            process.execPath,
            path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
            "--prefix",
            requestedPrefix,
            ...args,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
          },
        );
        expect(installed.status, installed.stderr).toBe(0);
        const modes = await installationModes(prefix);
        const diagnostics = process.env["HIMAWARI_TEST_DIAGNOSTIC_OUTPUT"];
        if (diagnostics)
          await writeFile(
            path.join(diagnostics, `installation-modes-${kind}-${mask}-${prefixMode}.json`),
            JSON.stringify(
              {
                kind,
                mask,
                prefixMode,
                prefix,
                stdout: installed.stdout,
                modes,
                originalFiles,
                originalSourceModes,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
        const runtime = path.join(prefix, "lib/himawari-agent");
        const expectedInstallationFiles = originalFiles.map((file) => ({
          ...file,
          path: `lib/himawari-agent/${file.path}`,
        }));
        for (const command of ["himawari", "himawari-agent-service", "himawari-execution-worker"]) {
          const relative = `bin/${command}`;
          const bytes = await readFile(path.join(prefix, relative));
          expectedInstallationFiles.push({
            path: relative,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            mode: 0o755,
          });
        }
        expectedInstallationFiles.sort((a, b) => a.path.localeCompare(b.path));
        const digestSandboxRuntime =
          kind === "source"
            ? digestSourceRuntime
            : (
                await import(
                  pathToFileURL(
                    path.join(
                      runtime,
                      "node_modules/@himawari-agent/platform-node/dist/capabilities/sandbox-host-verifier.js",
                    ),
                  ).href
                )
              ).digestSandboxRuntime;
        await expect(
          digestSandboxRuntime(prefix),
          JSON.stringify(modes.filter((entry) => (entry.mode & 0o022) !== 0)),
        ).resolves.toBe(contentDigest(expectedInstallationFiles));
        expect(
          modes
            .filter((entry) => entry.directory)
            .every((entry) => {
              const existing =
                ["0700", "0770"].includes(prefixMode) && [".", "lib", "bin"].includes(entry.path);
              const expected = existing ? Number.parseInt(prefixMode, 8) & ~0o022 : 0o755;
              return entry.mode === expected;
            }),
        ).toBe(true);
        expect((await lstat(temporary)).mode & 0o777).toBe(0o700);
        if (prefixMode === "private-parent") {
          expect((await lstat(path.join(temporary, "private"))).mode & 0o777).toBe(0o700);
          await expect(lstat(path.join(temporary, "private/missing"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          for (const relative of ["new-parent", "new-parent/inner"])
            expect((await lstat(path.join(temporary, relative))).mode & 0o777).toBe(0o755);
        }
        expect(
          modes
            .filter((entry) => !entry.directory)
            .every((entry) => [0o644, 0o755].includes(entry.mode)),
        ).toBe(true);
        expect(
          modes.filter((entry) => entry.path.startsWith("bin/")).map((entry) => entry.mode),
        ).toEqual([0o755, 0o755, 0o755]);
        expect(
          modes
            .filter((entry) => !entry.directory)
            .map(({ path, mode }) => ({ path, mode }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ).toEqual(expectedInstallationFiles.map(({ path, mode }) => ({ path, mode })));
        if (originalSourceModes)
          expect(await installationModes(source)).toEqual(originalSourceModes);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
});
