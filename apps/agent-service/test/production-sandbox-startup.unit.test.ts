import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ load: vi.fn(), verify: vi.fn() }));
vi.mock("@himawari-agent/platform-node", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CapabilityDeploymentSnapshotLoader: class {
    load = fixture.load;
  },
  verifySandboxHost: fixture.verify,
}));

import { createProductionSandboxServices } from "../src/production-sandbox-services.js";

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
    expect(fixture.verify).toHaveBeenCalledWith({ binding, qualification, hostId: binding.hostId }),
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
  expect(fixture.verify).toHaveBeenNthCalledWith(2, {
    binding: secondBinding,
    qualification,
    hostId: binding.hostId,
  });
  expect(repositoryAccess).toHaveBeenCalledOnce();
});
