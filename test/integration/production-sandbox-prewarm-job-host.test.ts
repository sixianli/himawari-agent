import { parseJobHostSessionRequest } from "@himawari-agent/runtime-sandbox/job-host-protocol";
import { expect, it } from "vitest";
import { sandboxPrewarmEnvironmentDeadline } from "../../apps/agent-service/src/production-sandbox-services.js";

it("[BG-10] the job host accepts a session that lives as long as the prewarmed environment", () => {
  const request = (deadlineAt: string) => ({
    jobId: "job-prewarm",
    attemptId: "attempt-prewarm",
    policy: { workspace: null, privateDirectory: "/tmp/private" },
    policyDigest: "a".repeat(64),
    executable: "/bin/echo",
    args: [],
    deadlineAt,
    maxOutputBytes: 4096,
    cleanupTimeoutMs: 100,
  });
  const prewarm = sandboxPrewarmEnvironmentDeadline(
    new Date().toISOString(),
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  expect(parseJobHostSessionRequest(request(prewarm)).deadlineAt).toBe(prewarm);
  const tooLong = new Date(Date.now() + 75 * 60_000).toISOString();
  expect(() => parseJobHostSessionRequest(request(tooLong))).toThrow("JOB_HOST_DEADLINE_INVALID");
});
