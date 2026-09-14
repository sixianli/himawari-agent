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
