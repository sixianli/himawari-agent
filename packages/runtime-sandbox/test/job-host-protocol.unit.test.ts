import { describe, expect, it } from "vitest";
import {
  JOB_HOST_NAMESPACE_STATES,
  jobHostCommandSettled,
  parseJobHostRequest,
  parseJobHostRun,
  parseJobHostSessionRequest,
  type JobHostCommandOutcome,
} from "../src/job-host-protocol.ts";

const DIGEST = "a".repeat(64);
const POLICY = {
  workspace: "/workspace",
  privateDirectory: "/private-job",
  writable: true,
  readOnlyToolchainPaths: [],
  protectedPaths: [],
  allowedDomains: [],
};
const SESSION_DEADLINE_MS = 60000;

function sessionRequest(): Record<string, unknown> {
  return {
    jobId: "job-entry",
    attemptId: "attempt-entry",
    policy: { ...POLICY },
    policyDigest: DIGEST,
    executable: "/bin/echo",
    args: ["task input"],
    deadlineAt: new Date(Date.now() + SESSION_DEADLINE_MS).toISOString(),
    maxOutputBytes: 4096,
    cleanupTimeoutMs: 100,
  };
}

function session(): {
  policyDigest: string;
  deadlineAt: string;
  maxOutputBytes: number;
} {
  const request = sessionRequest();
  return {
    policyDigest: String(request["policyDigest"]),
    deadlineAt: String(request["deadlineAt"]),
    maxOutputBytes: Number(request["maxOutputBytes"]),
  };
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: "attempt-1",
    sequence: 1,
    policyDigest: DIGEST,
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
    maxOutputBytes: 512,
    inputBase64: Buffer.from("input").toString("base64"),
    resourceLimits: { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 },
    ...overrides,
  };
}

describe("[R2-P2] Job Host session protocol", () => {
  it("[R2-P2] accepts a valid command and returns the same frozen fields", () => {
    const input = run();
    const parsed = parseJobHostRun(input, session(), 0);
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("[R2-P2] rejects a command with a missing or extra key", () => {
    expect(() => parseJobHostRun({ ...run(), extra: true }, session(), 0)).toThrow(
      "JOB_HOST_RUN_INVALID",
    );
    const missing: Record<string, unknown> = { ...run() };
    Reflect.deleteProperty(missing, "attemptId");
    expect(() => parseJobHostRun(missing, session(), 0)).toThrow("JOB_HOST_RUN_INVALID");
  });

  it("[R2-P2] requires the next command sequence", () => {
    for (const sequence of [2, 4, 0])
      expect(() => parseJobHostRun(run({ sequence }), session(), 2)).toThrow(
        "JOB_HOST_RUN_INVALID",
      );
  });

  it("[R2-P2] requires the session policy digest on every command", () => {
    expect(() => parseJobHostRun(run({ policyDigest: "b".repeat(64) }), session(), 0)).toThrow(
      "JOB_HOST_RUN_INVALID",
    );
  });

  it("[R2-P2] bounds the command attempt id", () => {
    for (const attemptId of ["bad id", "x".repeat(201)])
      expect(() => parseJobHostRun(run({ attemptId }), session(), 0)).toThrow(
        "JOB_HOST_RUN_INVALID",
      );
  });

  it("[R2-P2] bounds the command deadline inside the session", () => {
    const base = session();
    for (const deadlineAt of [
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() + 5000).toISOString().replace("Z", "+00:00"),
      new Date(Date.parse(base.deadlineAt) + 1000).toISOString(),
    ])
      expect(() => parseJobHostRun(run({ deadlineAt }), base, 0)).toThrow(
        "JOB_HOST_DEADLINE_INVALID",
      );
    expect(() => parseJobHostRun(run({ deadlineAt: base.deadlineAt }), base, 0)).not.toThrow();
  });

  it("[R2-P2] bounds the command output limit inside the session", () => {
    const base = session();
    for (const maxOutputBytes of [0, base.maxOutputBytes + 1, 1.5])
      expect(() => parseJobHostRun(run({ maxOutputBytes }), base, 0)).toThrow(
        "JOB_HOST_LIMIT_INVALID",
      );
    expect(() =>
      parseJobHostRun(run({ maxOutputBytes: base.maxOutputBytes }), base, 0),
    ).not.toThrow();
  });

  it("[R2-P2] bounds the command input", () => {
    for (const inputBase64 of ["bad base64", "Zg", Buffer.alloc(49153).toString("base64")])
      expect(() => parseJobHostRun(run({ inputBase64 }), session(), 0)).toThrow(
        "JOB_HOST_STDIN_INVALID",
      );
    expect(() =>
      parseJobHostRun(run({ inputBase64: Buffer.alloc(49152).toString("base64") }), session(), 0),
    ).not.toThrow();
  });

  it("[R2-P2] requires two positive command resource limits", () => {
    for (const resourceLimits of [
      { maxCpuTimeMs: 1000 },
      { maxCpuTimeMs: 1000, maxMemoryBytes: 100, extra: 1 },
      { maxCpuTimeMs: 0, maxMemoryBytes: 100 },
    ])
      expect(() => parseJobHostRun(run({ resourceLimits }), session(), 0)).toThrow(
        "JOB_HOST_RESOURCE_LIMIT_INVALID",
      );
  });

  it("[R2-P2] accepts a session request without per-command fields", () => {
    expect(parseJobHostSessionRequest(sessionRequest())).toMatchObject({ jobId: "job-entry" });
  });

  it.each(["stdinBase64", "resourceLimits"])(
    "[R2-P2] rejects the session request field %s",
    (field) => {
      const value = {
        ...sessionRequest(),
        [field]:
          field === "stdinBase64"
            ? Buffer.from("input").toString("base64")
            : { maxCpuTimeMs: 1000, maxMemoryBytes: 10000 },
      };
      expect(parseJobHostRequest(value)).toBeDefined();
      expect(() => parseJobHostSessionRequest(value)).toThrow("JOB_HOST_SESSION_MODE_INVALID");
    },
  );

  it("[R2-P2] rejects a session request carrying readiness", () => {
    const value = {
      ...sessionRequest(),
      policy: { ...POLICY, allowedUnixSockets: ["/private-job/ready.sock"] },
      readiness: {
        kind: "unix_http",
        ref: "ready",
        socketName: "ready.sock",
        path: "/health",
        expectedStatus: 200,
        timeoutMs: 1000,
      },
    };
    expect(parseJobHostRequest(value)).toBeDefined();
    expect(() => parseJobHostSessionRequest(value)).toThrow("JOB_HOST_SESSION_MODE_INVALID");
  });

  it("[R2-P2] keeps the original request error code for an invalid session request", () => {
    expect(() =>
      parseJobHostSessionRequest({ ...sessionRequest(), policyDigest: "not-a-digest" }),
    ).toThrow("JOB_HOST_DIGEST_INVALID");
  });

  it("[R2-P2] names the four namespace states", () => {
    expect(JOB_HOST_NAMESPACE_STATES).toEqual(["released", "alive", "unknown", "not_applicable"]);
  });

  it("[R2-P2] settles a command only when every condition holds", () => {
    const settled: Pick<
      JobHostCommandOutcome,
      "taskProcessExited" | "stdioClosed" | "processGroupGone" | "cleanedUp" | "namespace"
    > = {
      taskProcessExited: true,
      stdioClosed: true,
      processGroupGone: true,
      cleanedUp: true,
      namespace: "released",
    };
    expect(jobHostCommandSettled(settled)).toBe(true);
    for (const key of [
      "taskProcessExited",
      "stdioClosed",
      "processGroupGone",
      "cleanedUp",
    ] as const)
      expect(jobHostCommandSettled({ ...settled, [key]: false })).toBe(false);
    for (const namespace of ["alive", "unknown", "not_applicable"] as const)
      expect(jobHostCommandSettled({ ...settled, namespace })).toBe(false);
  });
});
