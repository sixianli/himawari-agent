import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { srtVersionProblems } from "../../scripts/check-srt-version.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OLD = ["0", "0", "75"].join(".");
const helper = { x64: Buffer.from("x64 helper"), arm64: Buffer.from("arm64 helper") };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture({
  version = "0.0.81",
  lock = version,
  installed = version,
  files = {},
  pinned = {},
  workspaceLock = version,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "srt-version-"));
  roots.push(root);
  const write = (relative, text) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  };
  write(
    "packages/execution-contracts/src/sandbox-runtime-version.ts",
    `export const SANDBOX_RUNTIME_VERSION = "${version}" as const;\n`,
  );
  write(
    "packages/runtime-sandbox/package.json",
    JSON.stringify({ dependencies: { "@anthropic-ai/sandbox-runtime": version } }),
  );
  write(
    "package-lock.json",
    JSON.stringify({
      packages: {
        "packages/runtime-sandbox": {
          dependencies: { "@anthropic-ai/sandbox-runtime": workspaceLock },
        },
        "node_modules/@anthropic-ai/sandbox-runtime": {
          version: lock,
          resolved: `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-${lock}.tgz`,
        },
      },
    }),
  );
  write(
    "packages/runtime-sandbox/src/srt-runtime-identity.ts",
    `export const SRT_SECCOMP_HELPER_SHA256 = Object.freeze({\n  x64: "${pinned.x64 ?? digest(helper.x64)}",\n  arm64: "${pinned.arm64 ?? digest(helper.arm64)}",\n});\n`,
  );
  write(
    "node_modules/@anthropic-ai/sandbox-runtime/package.json",
    JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", version: installed }),
  );
  for (const [arch, bytes] of Object.entries(helper))
    write(`node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/${arch}/apply-seccomp`, bytes);
  write(".gitignore", "node_modules/\n");
  for (const [relative, text] of Object.entries(files)) write(relative, text);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

describe("SRT version single source", () => {
  it("passes the repository as checked in", () => {
    expect(srtVersionProblems(join(import.meta.dirname, "../.."))).toEqual([]);
  });

  it("passes when every mirror matches the constant", () => {
    expect(
      srtVersionProblems(
        fixture({
          files: {
            "scripts/start.mjs":
              'const q = { srtVersion: "0.0.81", runtimeIdentity: "srt:0.0.81" };\n',
          },
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ["scripts/operations/start.mjs", `    srtVersion: "${OLD}",\n`, `srtVersion: "${OLD}"`],
    ["scripts/template/fixture.py", `{'srtVersion': '${OLD}'}\n`, `srtVersion': '${OLD}'`],
    ["test/fixture.ts", `runtimeIdentity: "srt:${OLD}",\n`, `srt:${OLD}`],
    ["packages/probe.mjs", `        srt: "${OLD}",\n`, `srt: "${OLD}"`],
    [
      "packages/runtime-sandbox/src/policy.ts",
      `export const SRT_VERSION = "${OLD}" as const;\n`,
      `SRT_VERSION = "${OLD}"`,
    ],
    [
      "packages/contracts/version.ts",
      `export const SANDBOX_RUNTIME_VERSION = "${OLD}";\n`,
      `SANDBOX_RUNTIME_VERSION = "${OLD}"`,
    ],
    ["scripts/a.py", `srt_version = '${OLD}'\n`, `srt_version = '${OLD}'`],
    [
      "scripts/b.mjs",
      `const pin = "@anthropic-ai/sandbox-runtime@^${OLD}";\n`,
      `sandbox-runtime@^${OLD}`,
    ],
    ["scripts/c.yaml", `srt: ${OLD}\n`, `srt: ${OLD}`],
    ["scripts/d.yaml", `srt_version: ${OLD}\n`, `srt_version: ${OLD}`],
    ["src/a.ts", `const SRT_VERSION: string = "${OLD}";\n`, `SRT_VERSION: string = "${OLD}"`],
    ["src/b.ts", `  srtVersion?: "${OLD}";\n`, `srtVersion?: "${OLD}"`],
    ["src/c.ts", `const sandboxRuntimeVersion = "${OLD}";\n`, `sandboxRuntimeVersion = "${OLD}"`],
    ["scripts/e.env", `SRT_VERSION=${OLD}\n`, `SRT_VERSION=${OLD}`],
    ["scripts/f.yaml", `srtVersion: ${OLD}\n`, `srtVersion: ${OLD}`],
    [
      "scripts/g.mjs",
      `const deps = { '@anthropic-ai/sandbox-runtime': '${OLD}' };\n`,
      `'@anthropic-ai/sandbox-runtime': '${OLD}'`,
    ],
    [
      "scripts/install.sh",
      `npm i @anthropic-ai/sandbox-runtime@${OLD}\n`,
      `sandbox-runtime@${OLD}`,
    ],
  ])("fails on a stale version left in %s", (file, text, found) => {
    expect(srtVersionProblems(fixture({ files: { [file]: text } }))).toEqual([
      `SRT_VERSION_STALE ${file}:1 ${found}`,
    ]);
  });

  it("skips a tracked link to a directory instead of failing", () => {
    const root = fixture();
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "linked"));
    execFileSync("git", ["add", "-A"], { cwd: root });
    expect(srtVersionProblems(root)).toEqual([]);
  });

  it("still checks agent instructions outside the review records", () => {
    expect(
      srtVersionProblems(
        fixture({ files: { ".agents/instructions/sandbox.md": `SRT ${OLD} is current\n` } }),
      ),
    ).toEqual([`SRT_VERSION_STALE .agents/instructions/sandbox.md:1 SRT ${OLD}`]);
  });

  it("checks a Hermes start script that is not one of the frozen releases", () => {
    expect(
      srtVersionProblems(
        fixture({
          files: { "scripts/operations/hermes-new-release-start.mjs": `srt: "${OLD}"\n` },
        }),
      ),
    ).toEqual([
      `SRT_VERSION_STALE scripts/operations/hermes-new-release-start.mjs:1 srt: "${OLD}"`,
    ]);
  });

  it("fails when a frozen release start script no longer matches its pinned digest", () => {
    const file = "scripts/operations/hermes-harness-start.mjs";
    expect(srtVersionProblems(fixture({ files: { [file]: `srt: "${OLD}"\n` } }))).toEqual([
      `SRT_FROZEN_RELEASE_CHANGED ${file}`,
    ]);
  });

  it("leaves historical evidence alone", () => {
    expect(
      srtVersionProblems(
        fixture({
          files: {
            "test/qualification/evidence/old.json": `{ "srt": "${OLD}" }\n`,
            "docs/adr/0001.md": `SRT ${OLD} was used\n`,
            ".agents/reviews/pr-1/round-1/model.md": `the test wrote srt:${OLD}-other\n`,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("fails when the lockfile or the installed package is another version", () => {
    expect(srtVersionProblems(fixture({ lock: OLD }))).toEqual([
      `SRT_VERSION_LOCK_MISMATCH package-lock.json ${OLD}`,
    ]);
    expect(srtVersionProblems(fixture({ installed: OLD }))).toEqual([
      `SRT_VERSION_INSTALLED_MISMATCH ${OLD}`,
    ]);
  });

  it("fails when the lockfile still records the old version for the runtime-sandbox workspace", () => {
    expect(srtVersionProblems(fixture({ workspaceLock: OLD }))).toEqual([
      `SRT_VERSION_LOCK_MISMATCH package-lock.json packages/runtime-sandbox ${OLD}`,
    ]);
  });

  it("fails when a pinned seccomp helper digest does not match the installed helper", () => {
    expect(srtVersionProblems(fixture({ pinned: { arm64: "0".repeat(64) } }))).toEqual([
      `SRT_SECCOMP_HELPER_DIGEST_MISMATCH arm64 ${digest(helper.arm64)}`,
    ]);
  });
});
