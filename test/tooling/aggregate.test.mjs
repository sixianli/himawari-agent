import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregate, readReportEnvelopes } from "../../scripts/ci/aggregate.mjs";
import {
  expectedMembers,
  readJson,
  repositoryRoot,
  sha256,
  validateRecord,
} from "../../scripts/ci/contracts.mjs";

const policy = readJson(path.join(repositoryRoot, "ci/policy.json"));
const toolchainLock = {
  node: { baseline: "22.22.3", floor: "22.19.0" },
  npm: { version: "11.8.0" },
};
const context = {
  repository: "sixianli/himawari-agent",
  event: "pull_request",
  runId: "123",
  attempt: 2,
  testedSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseSha: "c".repeat(40),
  policySha256: "d".repeat(64),
  toolchainSha256: "e".repeat(64),
  initialization: false,
};
const count = () => ({ files: 1, executed: 2, passed: 2, failed: 0, skipped: 0 });
const archive = (platform) => Buffer.from(`verified ${platform} archive`);
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function positive() {
  const reports = expectedMembers(policy).map(({ check, member }) => {
    const projects = check.projects.map((id) => ({ id, counts: count() }));
    const counts = projects.length
      ? Object.fromEntries(
          Object.keys(count()).map((key) => [
            key,
            projects.reduce((sum, project) => sum + project.counts[key], 0),
          ]),
        )
      : count();
    const platform = check.id === "browser" ? "linux-x64" : member.key;
    const outputs = check.outputs.map((kind) => {
      const bytes = kind === "artifact" ? archive(platform) : Buffer.from(`real ${kind} report`);
      return { path: `report.${kind}`, kind, bytes: bytes.length, sha256: sha256(bytes) };
    });
    const artifacts = ["build", "test", "browser"].includes(check.id)
      ? [
          {
            role: check.id === "build" ? "produced" : "consumed",
            platform,
            path: "report.artifact",
            sha256: sha256(archive(platform)),
          },
        ]
      : [];
    return {
      source: `${check.id}/${member.key}/result.json`,
      result: {
        schemaVersion: 1,
        checkId: check.id,
        matrixKey: member.key,
        ...context,
        toolchain: {
          node: member.node,
          npm: "11.8.0",
          os: member.os,
          arch: member.arch,
          abi: "127",
          runnerImage: "20260901.1",
        },
        status: "passed",
        exitCode: 0,
        durationMs: 20,
        retryCount: 0,
        counts,
        projects,
        reports: outputs,
        artifacts,
      },
      artifacts: outputs.map(({ path: pathname, sha256: digest, bytes }) => ({
        path: pathname,
        sha256: digest,
        bytes,
      })),
    };
  });
  return {
    policy,
    toolchainLock,
    context: structuredClone(context),
    needs: Object.fromEntries(
      policy.checks
        .filter((check) => check.id !== "required")
        .map((check) => [check.id, { result: "success" }]),
    ),
    reports,
  };
}
const run = (mutate) => {
  const input = positive();
  mutate(input);
  return aggregate(input);
};
const selected = (input, id = "test", key = "linux-x64") =>
  input.reports.find((entry) => entry.result.checkId === id && entry.result.matrixKey === key);

describe("complete-attempt gate", () => {
  it("accepts the complete positive control and emits a closed GateSummary", () => {
    const result = aggregate(positive());
    expect(result.status).toBe("passed");
    expect(result.expected).toHaveLength(12);
    expect(result.failures).toEqual([]);
    expect(validateRecord("GateSummary", result)).toBe(result);
  });
  it.each([
    "failure",
    "cancelled",
    "skipped",
    "neutral",
    "timed_out",
    "action_required",
    "unknown",
    null,
  ])("refuses upstream %s even if all member reports say passed", (status) => {
    expect(
      run((input) => {
        input.needs.build.result = status;
      }).status,
    ).toBe("failed");
  });
  it.each([
    [
      "missing upstream",
      (input) => {
        delete input.needs.build;
      },
    ],
    [
      "unknown upstream",
      (input) => {
        input.needs.extra = { result: "success" };
      },
    ],
    [
      "missing needs",
      (input) => {
        input.needs = null;
      },
    ],
    [
      "missing matrix",
      (input) => {
        input.reports.pop();
      },
    ],
    [
      "duplicate matrix",
      (input) => {
        input.reports.push(structuredClone(input.reports[0]));
      },
    ],
    [
      "unknown matrix",
      (input) => {
        selected(input).result.matrixKey = "windows-x64";
      },
    ],
    [
      "empty JSON",
      (input) => {
        input.reports[0].result = {};
      },
    ],
    [
      "unknown result field",
      (input) => {
        input.reports[0].result.override = true;
      },
    ],
    [
      "unknown state",
      (input) => {
        input.reports[0].result.status = "skipped";
      },
    ],
    [
      "failed command",
      (input) => {
        input.reports[0].result.exitCode = 1;
      },
    ],
    [
      "failed result",
      (input) => {
        input.reports[0].result.status = "failed";
      },
    ],
    [
      "infrastructure failure",
      (input) => {
        input.reports[0].result.status = "infrastructure_failed";
      },
    ],
    [
      "no actual test",
      (input) => {
        selected(input).result.counts.executed = 0;
      },
    ],
    [
      "no actual file",
      (input) => {
        selected(input).result.counts.files = 0;
      },
    ],
    [
      "failed tests hidden",
      (input) => {
        selected(input).result.counts.failed = 1;
      },
    ],
    [
      "skipped tests",
      (input) => {
        selected(input).result.counts.skipped = 1;
      },
    ],
    [
      "contradictory totals",
      (input) => {
        selected(input).result.counts.passed += 1;
      },
    ],
    [
      "missing project",
      (input) => {
        selected(input).result.projects.pop();
      },
    ],
    [
      "duplicate project",
      (input) => {
        selected(input).result.projects[1].id = "unit";
      },
    ],
    [
      "empty project",
      (input) => {
        selected(input).result.projects[0].counts.executed = 0;
      },
    ],
    [
      "contradictory project totals",
      (input) => {
        selected(input).result.projects[0].counts.files += 1;
      },
    ],
    [
      "wrong Node",
      (input) => {
        selected(input).result.toolchain.node = "22.19.0";
      },
    ],
    [
      "wrong npm",
      (input) => {
        selected(input).result.toolchain.npm = "10.0.0";
      },
    ],
    [
      "wrong ABI",
      (input) => {
        selected(input).result.toolchain.abi = "999";
      },
    ],
    [
      "wrong OS",
      (input) => {
        selected(input).result.toolchain.os = "darwin";
      },
    ],
    [
      "wrong arch",
      (input) => {
        selected(input).result.toolchain.arch = "arm64";
      },
    ],
    [
      "missing evidence",
      (input) => {
        selected(input).artifacts = [];
      },
    ],
    [
      "byte modified",
      (input) => {
        selected(input).artifacts[0].sha256 = "f".repeat(64);
      },
    ],
    [
      "incorrect byte length",
      (input) => {
        selected(input).artifacts[0].bytes += 1;
      },
    ],
    [
      "duplicate report",
      (input) => {
        selected(input).result.reports.push(selected(input).result.reports[0]);
      },
    ],
    [
      "missing report kind",
      (input) => {
        selected(input).result.reports = selected(input).result.reports.filter(
          (report) => report.kind !== "junit",
        );
      },
    ],
    [
      "path traversal",
      (input) => {
        selected(input).result.reports[0].path = "../outside.json";
      },
    ],
    [
      "empty reports",
      (input) => {
        input.reports = [];
      },
    ],
    [
      "unbound build",
      (input) => {
        selected(input, "build").result.artifacts = [];
      },
    ],
    [
      "unbound consumer",
      (input) => {
        selected(input).result.artifacts = [];
      },
    ],
    [
      "substituted consumer platform",
      (input) => {
        selected(input).result.artifacts[0].platform = "macos-arm64";
      },
    ],
  ])("refuses %s", (_name, mutate) => {
    const result = run(mutate);
    expect(result.status).toBe("failed");
    expect(result.failures.length).toBeGreaterThan(0);
  });
  it.each([
    "repository",
    "event",
    "runId",
    "attempt",
    "testedSha",
    "headSha",
    "baseSha",
    "policySha256",
    "toolchainSha256",
    "initialization",
  ])("binds %s to the exact workflow context", (field) => {
    const result = run((input) => {
      const record = selected(input).result;
      record[field] =
        field === "attempt"
          ? 1
          : field === "initialization"
            ? true
            : field === "repository"
              ? "other/repo"
              : field === "event"
                ? "push"
                : field === "runId"
                  ? "321"
                  : "f".repeat(field.endsWith("Sha256") ? 64 : 40);
    });
    expect(result.status).toBe("failed");
    expect(result.failures.some((failure) => failure.reason.includes(field))).toBe(true);
  });
  it("requires a complete rerun and rejects mixed attempts", () => {
    const input = positive();
    input.context.attempt = 3;
    selected(input).result.attempt = 3;
    expect(aggregate(input).status).toBe("failed");
    for (const envelope of input.reports) envelope.result.attempt = 3;
    expect(aggregate(input).status).toBe("passed");
  });
  it("rejects a separately valid archive that differs from the platform build", () => {
    const input = positive();
    const report = selected(input);
    const newBytes = Buffer.from("different valid archive");
    for (const entry of [
      report.result.reports.find((item) => item.kind === "artifact"),
      report.artifacts.find((item) => item.path === "report.artifact"),
    ]) {
      entry.sha256 = sha256(newBytes);
      entry.bytes = newBytes.length;
    }
    report.result.artifacts[0].sha256 = sha256(newBytes);
    expect(
      aggregate(input).failures.some((failure) =>
        failure.reason.includes("Consumer artifact differs"),
      ),
    ).toBe(true);
  });
  it("measures actual report bytes and rejects tampering at the filesystem boundary", () => {
    const input = positive();
    const directory = mkdtempSync(path.join(os.tmpdir(), "ci-results-"));
    directories.push(directory);
    for (const envelope of input.reports) {
      const folder = path.join(directory, envelope.result.checkId, envelope.result.matrixKey);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "result.json"), JSON.stringify(envelope.result));
      for (const report of envelope.result.reports) {
        const platform =
          envelope.result.checkId === "browser" ? "linux-x64" : envelope.result.matrixKey;
        writeFileSync(
          path.join(folder, report.path),
          report.kind === "artifact"
            ? archive(platform)
            : Buffer.from(`real ${report.kind} report`),
        );
      }
    }
    input.reports = readReportEnvelopes(directory);
    expect(aggregate(input).status).toBe("passed");
    writeFileSync(path.join(directory, "test/linux-x64/report.json"), "tampered");
    input.reports = readReportEnvelopes(directory);
    expect(aggregate(input).status).toBe("failed");
  });
});
