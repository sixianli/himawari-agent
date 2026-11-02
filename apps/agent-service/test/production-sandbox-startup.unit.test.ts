import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ load: vi.fn(), verify: vi.fn() }));
vi.mock("@himawari-agent/platform-node", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CapabilityDeploymentSnapshotLoader: class {
    load = fixture.load;
  },
  verifySandboxHost: fixture.verify,
}));

import { JOB_HOST_MAXIMUM_SESSION_MS } from "@himawari-agent/runtime-sandbox/job-host-limits";
import {
  createProductionSandboxServices,
  sandboxEnvironmentDeadline,
  sandboxPrewarmEnvironmentDeadline,
} from "../src/production-sandbox-services.js";
import { srtEnvironmentRotationReason } from "../src/production-task-environments.js";

const binding = { hostId: "host:test" };
const qualification = { qualificationRef: "qualification:test" };
const repositoryAccess = vi.fn(() => {
  throw new Error("REPOSITORY_INITIALIZATION_REACHED");
});
// The snapshot loader and repository are external boundaries. Stop at the first
// repository access to prove verification completes before service composition.
const options = {
  configuration: { capabilityDeployment: {}, modelDescriptors: [] },
  repository: { sandboxJobJournal: repositoryAccess },
} as unknown as Parameters<typeof createProductionSandboxServices>[0];

beforeEach(() => {
  fixture.load.mockReset().mockResolvedValue({
    snapshot: {
      capabilities: [
        { binding: { kind: "sandbox", value: binding }, qualification: { sandbox: qualification } },
      ],
    },
  });
  fixture.verify.mockReset().mockResolvedValue(undefined);
  repositoryAccess.mockClear();
});

it("waits for installation verification before initializing sandbox services", async () => {
  let finish: (() => void) | undefined;
  fixture.verify.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const startup = createProductionSandboxServices(options);
  const result = expect(startup).rejects.toThrow("REPOSITORY_INITIALIZATION_REACHED");
  await vi.waitFor(() =>
    expect(fixture.verify).toHaveBeenCalledWith(
      { binding, qualification, hostId: binding.hostId },
      { deferContentAudit: true },
    ),
  );
  expect(repositoryAccess).not.toHaveBeenCalled();
  finish?.();
  await result;
  expect(repositoryAccess).toHaveBeenCalledOnce();
});

it("fails startup when the installed sandbox cannot be verified", async () => {
  fixture.verify.mockRejectedValue(new Error("SANDBOX_HOST_ARTIFACT_CHANGED"));
  await expect(createProductionSandboxServices(options)).rejects.toThrow(
    "SANDBOX_HOST_ARTIFACT_CHANGED",
  );
  expect(repositoryAccess).not.toHaveBeenCalled();
});

it("does not introduce sandbox work for a deployment without sandbox capabilities", async () => {
  fixture.load.mockResolvedValue({ snapshot: { capabilities: [] } });
  await expect(createProductionSandboxServices(options)).resolves.toBeUndefined();
  expect(fixture.verify).not.toHaveBeenCalled();
});

it("does not read inventory when sandbox deployment is absent", async () => {
  const { capabilityDeployment: _deployment, ...configuration } = options.configuration;
  await expect(
    createProductionSandboxServices({
      ...options,
      configuration,
    }),
  ).resolves.toBeUndefined();
  expect(fixture.load).not.toHaveBeenCalled();
  expect(repositoryAccess).not.toHaveBeenCalled();
});

it.each(["ambiguous", "missing-host", "unqualified"])(
  "refuses %s sandbox installation before repository initialization",
  async (kind) => {
    const entries = [
      {
        binding: { kind: "sandbox", value: { hostId: kind === "missing-host" ? "" : "host:test" } },
        qualification: { sandbox: kind === "unqualified" ? undefined : qualification },
      },
    ];
    if (kind === "ambiguous")
      entries.push({
        binding: { kind: "sandbox", value: { hostId: "host:other" } },
        qualification: { sandbox: qualification },
      });
    fixture.load.mockResolvedValue({ snapshot: { capabilities: entries } });
    await expect(createProductionSandboxServices(options)).rejects.toThrow(
      kind === "ambiguous" ? "SANDBOX_HOST_BINDING_AMBIGUOUS" : "SANDBOX_HOST_BINDING_UNAVAILABLE",
    );
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(repositoryAccess).not.toHaveBeenCalled();
  },
);

it("verifies every sandbox capability and ignores non-sandbox inventory", async () => {
  const secondBinding = { hostId: binding.hostId, profileRef: "second-profile" };
  fixture.load.mockResolvedValue({
    snapshot: {
      capabilities: [
        { binding: { kind: "program", value: {} }, qualification: {} },
        { binding: { kind: "sandbox", value: binding }, qualification: { sandbox: qualification } },
        {
          binding: { kind: "sandbox", value: secondBinding },
          qualification: { sandbox: qualification },
        },
      ],
    },
  });
  await expect(createProductionSandboxServices(options)).rejects.toThrow(
    "REPOSITORY_INITIALIZATION_REACHED",
  );
  expect(fixture.verify).toHaveBeenCalledTimes(2);
  expect(fixture.verify).toHaveBeenNthCalledWith(
    2,
    { binding: secondBinding, qualification, hostId: binding.hostId },
    { deferContentAudit: true },
  );
  expect(repositoryAccess).toHaveBeenCalledOnce();
});

it("[BG-8] keeps a Run's sandbox environment alive for a bash command started at the end of the answer", () => {
  const answerDeadline = "2026-09-06T00:05:00.000Z";
  const lastCommandDeadline = new Date(Date.parse(answerDeadline) + 1_800_000).toISOString();
  expect(sandboxEnvironmentDeadline(answerDeadline, "2026-09-07T00:00:00.000Z", 1_800_000)).toBe(
    lastCommandDeadline,
  );
  expect(sandboxEnvironmentDeadline(answerDeadline, "2026-09-06T00:10:00.000Z", 1_800_000)).toBe(
    "2026-09-06T00:10:00.000Z",
  );
  expect(sandboxEnvironmentDeadline(answerDeadline, "2026-09-07T00:00:00.000Z", 0)).toBe(
    answerDeadline,
  );
});

it("[BG-10] a prewarmed environment is accepted by the job host and covers a bash command started within 30 minutes", () => {
  const backgroundMs = 1_800_000;
  const prewarmAt = Date.parse("2026-10-31T15:52:22.000Z");
  const grantExpires = "2026-11-30T00:00:00.000Z";
  const prewarm = sandboxPrewarmEnvironmentDeadline(
    new Date(prewarmAt).toISOString(),
    grantExpires,
  );
  expect(Date.parse(prewarm) - prewarmAt).toBeLessThanOrEqual(JOB_HOST_MAXIMUM_SESSION_MS);
  for (const gapMs of [0, 5_000, 300_000, 1_799_000]) {
    const commandStart = prewarmAt + gapMs;
    const commandDeadline = new Date(commandStart + backgroundMs).toISOString();
    expect(
      srtEnvironmentRotationReason({
        existingDeadlineAt: prewarm,
        existingPolicyDigest: "digest-1",
        requestedDeadlineAt: commandDeadline,
        policyDigest: "digest-1",
        now: new Date(commandStart).toISOString(),
      }),
    ).toBeNull();
  }
});

it("[BG-10] a bash command that starts more than 30 minutes after the prewarm still gets a new environment", () => {
  const prewarmAt = Date.parse("2026-10-31T15:52:22.000Z");
  const prewarm = sandboxPrewarmEnvironmentDeadline(
    new Date(prewarmAt).toISOString(),
    "2026-11-30T00:00:00.000Z",
  );
  const commandStart = prewarmAt + 1_860_000;
  expect(
    srtEnvironmentRotationReason({
      existingDeadlineAt: prewarm,
      existingPolicyDigest: "digest-1",
      requestedDeadlineAt: new Date(commandStart + 1_800_000).toISOString(),
      policyDigest: "digest-1",
      now: new Date(commandStart).toISOString(),
    }),
  ).toBe("expansion");
});

it("[BG-10] the prewarmed environment is still capped by the directory grant", () => {
  expect(
    sandboxPrewarmEnvironmentDeadline("2026-10-31T15:52:22.000Z", "2026-10-31T16:00:00.000Z"),
  ).toBe("2026-10-31T16:00:00.000Z");
});
