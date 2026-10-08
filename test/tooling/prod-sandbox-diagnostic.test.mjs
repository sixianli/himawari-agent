import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sandboxPreparationDiagnosticSchema } from "@himawari-agent/execution-contracts";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { afterEach, describe, it } from "vitest";
import {
  diagnosticFailureOutput,
  preparationDiagnosticOutput,
  productionDiagnosticRequest,
} from "../fixtures/prod-sandbox-readonly-diagnostic.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function nodeResolutionFixture() {
  const root = mkdtempSync(path.join(testTemporaryRoot(), "diagnostic-resolution-"));
  directories.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const stateRoot = path.join(root, "state");
  const configurationPath = path.join(root, "config.json");
  const marker = path.join(root, "ancestor-module-executed");
  const write = (filename, value) => {
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, value);
  };
  write(path.join(runtimeRoot, "package.json"), '{"type":"module"}');
  for (const [name, leaves] of [
    [
      "platform-node",
      ["payload-protector.js", "host-secret-source.js", "ciphertext-file-store.js"],
    ],
    ["execution-contracts", ["sandbox-execution-v2.js"]],
  ]) {
    const packageRoot = path.join(runtimeRoot, "node_modules", "@himawari-agent", name);
    write(path.join(packageRoot, "package.json"), '{"type":"module"}');
    for (const leaf of leaves) write(path.join(packageRoot, "dist", leaf), "export {};\n");
  }
  write(
    path.join(root, "node_modules", "better-sqlite3", "index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ancestor-module-executed");\nthrow new Error("synthetic ancestor module executed");\n`,
  );
  write(
    configurationPath,
    JSON.stringify({
      stateRoot,
      ownerId: "owner:synthetic-resolution",
      agentId: "agent:synthetic-resolution",
      secretReferences: [{ purpose: "payload-encryption", ref: "synthetic-key", version: "v1" }],
    }),
  );
  return {
    marker,
    request: {
      runtimeRoot,
      stateRoot,
      configurationPath,
      expectedOwnerId: "owner:synthetic-resolution",
      expectedAgentId: "agent:synthetic-resolution",
    },
  };
}

const detail = {
  code: "JOB_HOST_ENVIRONMENT_INVALID",
  command: "prepare",
  phase: "preparing",
  elapsedMs: 8000,
  messageAgeMs: null,
  deadlineRemainingMs: 5000,
  expectedSequence: 1,
  receivedSequence: null,
};
const diagnostic = {
  stage: "prepare",
  reasonCode: "SANDBOX_PREPARATION_FAILED",
  hostStage: "sdk_initialize",
  systemCode: "EACCES",
  hostDetail: detail,
};

describe("[R2-L4][prod-sandbox-D1-script] frozen diagnostic output", () => {
  it("validates with the product schema and exports only fixed enums and known field names", () => {
    const output = preparationDiagnosticOutput(
      {
        identity: { ownerId: "PRIVATE_SENTINEL" },
        PRIVATE_FIELD_SENTINEL: "PRIVATE_SENTINEL",
        ...diagnostic,
        hostDetail: { ...detail, PRIVATE_NESTED_FIELD_SENTINEL: "PRIVATE_SENTINEL" },
      },
      sandboxPreparationDiagnosticSchema,
    );
    assert.deepEqual(output, {
      stage: "prepare",
      reasonCode: "SANDBOX_PREPARATION_FAILED",
      hostStage: "sdk_initialize",
      systemCode: "EACCES",
      hostDetail: {
        code: "JOB_HOST_ENVIRONMENT_INVALID",
        command: "prepare",
        phase: "preparing",
      },
      fieldNames: ["stage", "reasonCode", "hostStage", "systemCode", "hostDetail"],
      hostDetailFieldNames: [
        "code",
        "command",
        "phase",
        "elapsedMs",
        "messageAgeMs",
        "deadlineRemainingMs",
        "expectedSequence",
        "receivedSequence",
      ],
    });
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE|8000|5000/);
  });

  it("retains schema-defined nulls without inventing host detail", () => {
    const output = preparationDiagnosticOutput(
      { ...diagnostic, hostStage: null, hostDetail: null },
      sandboxPreparationDiagnosticSchema,
    );
    assert.equal(output.hostStage, null);
    assert.equal(output.hostDetail, null);
    assert.deepEqual(output.hostDetailFieldNames, []);
  });

  it.each(["stage", "reasonCode", "hostStage", "systemCode"])(
    "rejects an unknown %s enum with a fixed code",
    (field) => {
      let failure;
      try {
        preparationDiagnosticOutput(
          { ...diagnostic, [field]: "PRIVATE_SENTINEL" },
          sandboxPreparationDiagnosticSchema,
        );
      } catch (error) {
        failure = diagnosticFailureOutput(error);
      }
      assert.deepEqual(failure, { errorCode: "DIAGNOSTIC_SCHEMA_INVALID" });
      assert.doesNotMatch(JSON.stringify(failure), /PRIVATE|stack|message/);
    },
  );

  it.each(["code", "command", "phase"])(
    "rejects an unknown hostDetail.%s enum with a fixed code",
    (field) => {
      let failure;
      try {
        preparationDiagnosticOutput(
          { ...diagnostic, hostDetail: { ...detail, [field]: "PRIVATE_SENTINEL" } },
          sandboxPreparationDiagnosticSchema,
        );
      } catch (error) {
        failure = diagnosticFailureOutput(error);
      }
      assert.deepEqual(failure, { errorCode: "DIAGNOSTIC_SCHEMA_INVALID" });
    },
  );

  it("requires the original numeric detail contract even though numbers are not exported", () => {
    const { elapsedMs, ...incomplete } = detail;
    assert.equal(elapsedMs, 8000);
    assert.throws(
      () =>
        preparationDiagnosticOutput(
          { ...diagnostic, hostDetail: incomplete },
          sandboxPreparationDiagnosticSchema,
        ),
      (error) => diagnosticFailureOutput(error).errorCode === "DIAGNOSTIC_SCHEMA_INVALID",
    );
  });

  it("does not trust an external error code, name, message, stack, or field name", () => {
    const error = Object.assign(new Error("PRIVATE_SENTINEL"), {
      code: "DIAGNOSTIC_DECRYPT_FAILED",
      PRIVATE_FIELD_SENTINEL: "PRIVATE_SENTINEL",
    });
    assert.deepEqual(diagnosticFailureOutput(error), { errorCode: "DIAGNOSTIC_READ_FAILED" });
  });

  it("accepts only the fixed production stdin target and rejects caller-selected paths or keys", () => {
    const request = productionDiagnosticRequest([]);
    assert.equal(request.runtimeRoot, "/opt/himawari/releases/2026-10-07-first/lib/himawari-agent");
    assert.equal(request.configurationPath, "/etc/himawari/config.json");
    assert.equal(request.stateRoot, "/var/lib/himawari/state");
    for (const args of [
      ["--state-root", "/private"],
      ["--operation-key", "PRIVATE_SENTINEL"],
    ]) {
      assert.throws(
        () => productionDiagnosticRequest(args),
        (error) => diagnosticFailureOutput(error).errorCode === "DIAGNOSTIC_ARGUMENT_INVALID",
      );
    }
  });

  it("covers the Node resolution boundary only and never executes an ancestor dependency when the installed dependency is absent", () => {
    const { marker, request } = nodeResolutionFixture();
    assert.equal(existsSync(marker), false);
    const reader = new URL("../fixtures/prod-sandbox-readonly-diagnostic.mjs", import.meta.url)
      .href;
    const probe = `import { readRestrictedDiagnostic, diagnosticFailureOutput } from ${JSON.stringify(reader)};\ntry { await readRestrictedDiagnostic(${JSON.stringify(request)}); process.stdout.write(JSON.stringify({ unexpectedSuccess: true })); } catch (error) { process.stdout.write(JSON.stringify(diagnosticFailureOutput(error))); }\n`;
    const child = spawnSync(
      process.execPath,
      ["--no-global-search-paths", "--input-type=module", "-e", probe],
      {
        encoding: "utf8",
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(
      child.status,
      0,
      `synthetic Node resolution probe stdout=${child.stdout}; stderr=${child.stderr}`,
    );
    assert.equal(child.stderr, "");
    assert.deepEqual(JSON.parse(child.stdout), { errorCode: "DIAGNOSTIC_RUNTIME_UNAVAILABLE" });
    assert.equal(existsSync(marker), false, "the ancestor module must never execute");
  });
});
