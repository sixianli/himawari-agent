import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeSourceProblems } from "../../scripts/check-probe-sources.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (text) => createHash("sha256").update(text).digest("hex");
const BOOTSTRAP = "scripts/delivery-mode/packet-template/measurement/probe/bootstrap.mjs";
const SOURCE = "packages/runtime-sandbox/src/job-host-main.ts";
const BUILT = "a".repeat(64);

function fixture({
  source = "export const host = 1;\n",
  recordedSource,
  bootstrapBuilt = BUILT,
  extraBootstrap = "",
  aroundBootstrap = "",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "probe-sources-"));
  roots.push(root);
  const write = (relative, text) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  };
  write(SOURCE, source);
  write(
    BOOTSTRAP,
    `${aroundBootstrap}const originals = {\n  "job-host-main.js": "${bootstrapBuilt}",\n${extraBootstrap}};\n${aroundBootstrap}`,
  );
  write(
    "scripts/delivery-mode/probe-sources.json",
    JSON.stringify({
      bootstrap: BOOTSTRAP,
      files: [
        {
          built: "job-host-main.js",
          builtSha256: BUILT,
          source: SOURCE,
          sourceSha256: recordedSource ?? digest(source),
        },
      ],
    }),
  );
  return root;
}

describe("probe source digests", () => {
  it("passes on the repository as committed", () => {
    expect(probeSourceProblems(repository)).toEqual([]);
  });

  it("passes when sources and bootstrap match the record", () => {
    expect(probeSourceProblems(fixture())).toEqual([]);
  });

  it("[probe-digest-stale] fails when a sandbox source changes after the digests were recorded", () => {
    const root = fixture({ recordedSource: digest("export const host = 0;\n") });
    expect(probeSourceProblems(root)).toEqual([
      expect.stringMatching(
        /^PROBE_SOURCE_CHANGED packages\/runtime-sandbox\/src\/job-host-main\.ts /,
      ),
    ]);
  });

  it("fails when the bootstrap digest is updated without the record", () => {
    const root = fixture({ bootstrapBuilt: "b".repeat(64) });
    expect(probeSourceProblems(root)).toEqual([
      expect.stringMatching(/^PROBE_BUILT_DIGEST_MISMATCH job-host-main\.js /),
    ]);
  });

  it("fails when the bootstrap instruments a file the record does not list", () => {
    const root = fixture({ extraBootstrap: `  "sandbox-sdk.js": "${"c".repeat(64)}",\n` });
    expect(probeSourceProblems(root)).toEqual(["PROBE_SOURCE_UNLISTED sandbox-sdk.js"]);
  });

  it("fails when a bootstrap entry has an unusual name the packet check cannot read", () => {
    const root = fixture({ extraBootstrap: `  "Sandbox_SDK2.js": "${"c".repeat(64)}",\n` });
    expect(probeSourceProblems(root)).toEqual([
      `PROBE_BOOTSTRAP_ENTRY_FORMAT "Sandbox_SDK2.js": "${"c".repeat(64)}",`,
    ]);
  });

  it("fails when a recorded bootstrap entry has no trailing comma", () => {
    const root = fixture();
    writeFileSync(
      join(root, BOOTSTRAP),
      `const originals = {\n  "job-host-main.js": "${BUILT}"\n};\n`,
    );
    expect(probeSourceProblems(root)).toEqual([
      `PROBE_BOOTSTRAP_ENTRY_FORMAT "job-host-main.js": "${BUILT}"`,
      expect.stringMatching(/^PROBE_BUILT_DIGEST_MISMATCH job-host-main\.js bootstrap=absent /),
    ]);
  });

  it("ignores digest-like strings outside the originals block", () => {
    const root = fixture({
      aroundBootstrap: `const other = { "job-host-main.js": "${"d".repeat(64)}" };\n`,
    });
    expect(probeSourceProblems(root)).toEqual([]);
  });

  it("reads entries outside the originals block the way the packet check does", () => {
    const root = fixture();
    writeFileSync(
      join(root, BOOTSTRAP),
      `const originals = {\n  "job-host-main.js": "${BUILT}",\n};\nconst more = {\n  "sandbox-sdk.js": "${"c".repeat(64)}",\n};\n`,
    );
    expect(probeSourceProblems(root)).toEqual(["PROBE_SOURCE_UNLISTED sandbox-sdk.js"]);
  });

  it("fails when the originals block names a file twice", () => {
    const root = fixture({ extraBootstrap: `  "job-host-main.js": "${BUILT}",\n` });
    expect(probeSourceProblems(root)).toEqual(["PROBE_BOOTSTRAP_DUPLICATE_NAME"]);
  });

  it("fails when the bootstrap has no originals block", () => {
    const root = fixture();
    writeFileSync(join(root, BOOTSTRAP), `const table = { "job-host-main.js": "${BUILT}" };\n`);
    expect(probeSourceProblems(root)).toEqual([`PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND ${BOOTSTRAP}`]);
  });

  it("fails when multi-line entries remain but the originals declaration is gone", () => {
    const root = fixture();
    writeFileSync(
      join(root, BOOTSTRAP),
      `const table = {\n  "job-host-main.js": "${BUILT}",\n};\n`,
    );
    expect(probeSourceProblems(root)).toEqual([`PROBE_BOOTSTRAP_DIGESTS_NOT_FOUND ${BOOTSTRAP}`]);
  });

  it("fails when the bootstrap has Windows line endings the packet check reads differently", () => {
    const root = fixture();
    writeFileSync(
      join(root, BOOTSTRAP),
      `const originals = {\r\n  "job-host-main.js": "${BUILT}",\r\n};\r\n`,
    );
    expect(probeSourceProblems(root)).toEqual([`PROBE_BOOTSTRAP_LINE_ENDINGS ${BOOTSTRAP}`]);
  });

  it("fails when a recorded source is a directory", () => {
    const root = fixture();
    rmSync(join(root, SOURCE));
    mkdirSync(join(root, SOURCE));
    expect(probeSourceProblems(root)).toEqual([`PROBE_SOURCE_UNREADABLE ${SOURCE}`]);
  });

  const entry = {
    built: "job-host-main.js",
    builtSha256: BUILT,
    source: SOURCE,
    sourceSha256: BUILT,
  };
  it.each([
    [{ ...entry, built: "Job_Host.js" }],
    [{ ...entry, source: "packages/other/src/job-host-main.ts" }],
    [{ ...entry, source: "packages/runtime-sandbox/src/../../../outside.ts" }],
    [{ ...entry, source: "packages/runtime-sandbox/src/..\\..\\outside.ts" }],
    [{ ...entry, source: "packages/runtime-sandbox/src/" }],
    [{ ...entry, source: "packages/runtime-sandbox/src/sandbox-sdk.ts" }],
  ])("rejects a record entry the packet check could not use %#", (file) => {
    const root = fixture();
    writeFileSync(
      join(root, "scripts/delivery-mode/probe-sources.json"),
      JSON.stringify({ bootstrap: BOOTSTRAP, files: [file] }),
    );
    expect(probeSourceProblems(root)).toEqual(["PROBE_SOURCES_RECORD_INVALID files[0]"]);
  });

  it("rejects an absolute source path even when it points inside the sandbox sources", () => {
    const root = fixture();
    writeFileSync(
      join(root, "scripts/delivery-mode/probe-sources.json"),
      JSON.stringify({ bootstrap: BOOTSTRAP, files: [{ ...entry, source: join(root, SOURCE) }] }),
    );
    expect(probeSourceProblems(root)).toEqual(["PROBE_SOURCES_RECORD_INVALID files[0]"]);
  });

  it.each([
    ["{not json", "PROBE_SOURCES_RECORD_INVALID json"],
    [
      JSON.stringify({ bootstrap: BOOTSTRAP, files: [entry, entry] }),
      "PROBE_SOURCES_RECORD_INVALID duplicate built",
    ],
    [JSON.stringify({ bootstrap: BOOTSTRAP, files: [] }), "PROBE_SOURCES_RECORD_INVALID files"],
    [
      JSON.stringify({ bootstrap: "../outside.mjs", files: [{}] }),
      "PROBE_SOURCES_RECORD_INVALID bootstrap",
    ],
    [
      JSON.stringify({ bootstrap: BOOTSTRAP, files: [{ built: "job-host-main.js" }] }),
      "PROBE_SOURCES_RECORD_INVALID files[0]",
    ],
  ])("fails clearly on a broken record %#", (text, problem) => {
    const root = fixture();
    writeFileSync(join(root, "scripts/delivery-mode/probe-sources.json"), text);
    expect(probeSourceProblems(root)).toEqual([problem]);
  });

  it("fails clearly when the record is not a plain file", () => {
    const root = fixture();
    const record = join(root, "scripts/delivery-mode/probe-sources.json");
    rmSync(record);
    mkdirSync(record);
    expect(probeSourceProblems(root)).toEqual([
      "PROBE_SOURCES_RECORD_UNREADABLE scripts/delivery-mode/probe-sources.json",
    ]);
  });

  it("exits non-zero from the command line when the record is broken", () => {
    const root = fixture();
    writeFileSync(join(root, "scripts/delivery-mode/probe-sources.json"), "{not json");
    const run = spawnSync(
      process.execPath,
      [join(repository, "scripts/check-probe-sources.mjs"), root],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("PROBE_SOURCES failed");
  });

  it("reminds on success that built digests are checked only by the packet check", () => {
    const run = spawnSync(
      process.execPath,
      [join(repository, "scripts/check-probe-sources.mjs"), fixture()],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PROBE_SOURCES_NOTE");
  });
});
