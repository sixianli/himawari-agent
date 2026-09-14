import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCapabilitiesCommand } from "../src/capabilities-command.ts";

const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  snapshot: vi.fn(),
  open: vi.fn(),
  deployment: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@himawari-agent/platform-node", () => ({
  JsonFileConfigurationPort: class {
    load = boundary.load;
  },
  loadCapabilityDeploymentSnapshot: boundary.snapshot,
}));
vi.mock("@himawari-agent/persistence-sqlite", () => ({
  SqliteProductStateRepository: { open: boundary.open },
}));
const digest = `sha256:${"c".repeat(64)}`;
const args = [
  "capabilities",
  "register",
  "--config",
  "/configuration/himawari.json",
  "--confirm",
  digest,
];
const configuration = () => ({
  ownerId: "owner-register",
  agentId: "agent-register",
  deploymentId: "deployment-register",
  stateRoot: "/state",
  capabilityDeployment: { sha256: digest },
});
const declaration = { operations: ["read"], dataClassifications: ["private"] };
const record = (ref: string) => ({
  ref,
  lifecycle: "active",
  declaration: structuredClone(declaration),
});
beforeEach(() => {
  vi.resetAllMocks();
  boundary.load.mockResolvedValue(configuration());
  boundary.snapshot.mockResolvedValue({
    snapshotDigest: digest,
    manifests: [{ reviewedBy: "owner-register" }],
    records: [record("first"), record("second")],
  });
  boundary.deployment.mockResolvedValue({
    status: "active",
    ownerId: "owner-register",
    agentId: "agent-register",
  });
  boundary.open.mockResolvedValue({
    deploymentAuthorityPort: () => ({ read: boundary.deployment }),
    capabilityStore: () => ({ get: boundary.get, create: boundary.create }),
    auditLedger: () => ({ append: boundary.audit }),
    close: boundary.close,
  });
});

describe("owner-confirmed capability registration", () => {
  it.each(
    [
      [],
      ["capabilities"],
      [...args, "extra"],
      args.map((value, index) => (index === 1 ? "install" : value)),
      args.map((value, index) => (index === 2 ? "--other" : value)),
      args.map((value, index) => (index === 3 ? "relative.json" : value)),
      args.map((value, index) => (index === 4 ? "--force" : value)),
    ].map((args) => ({ args })),
  )("rejects malformed arguments $args before reading configuration", async ({ args }) => {
    await expect(runCapabilitiesCommand(args)).rejects.toThrow("ADMIN_CAPABILITIES_INPUT_INVALID");
    expect(boundary.load).not.toHaveBeenCalled();
    expect(boundary.open).not.toHaveBeenCalled();
  });
  it.each(["missing-installation", "wrong-confirmation", "different-reviewer"])(
    "refuses %s before opening writable state",
    async (reason) => {
      if (reason === "missing-installation")
        boundary.load.mockResolvedValue({ ...configuration(), capabilityDeployment: undefined });
      if (reason === "different-reviewer")
        boundary.snapshot.mockResolvedValue({
          manifests: [{ reviewedBy: "another-owner" }],
          records: [record("first")],
        });
      await expect(
        runCapabilitiesCommand(
          reason === "wrong-confirmation" ? [...args.slice(0, 5), "unconfirmed"] : args,
        ),
      ).rejects.toThrow("ADMIN_CAPABILITIES_INPUT_INVALID");
      expect(boundary.open).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    { status: "inactive", ownerId: "owner-register", agentId: "agent-register" },
    { status: "active", ownerId: "another", agentId: "agent-register" },
    { status: "active", ownerId: "owner-register", agentId: "another" },
  ])("requires this owner's active deployment (%j)", async (deployment) => {
    boundary.deployment.mockResolvedValue(deployment);
    await expect(runCapabilitiesCommand(args)).rejects.toThrow("ADMIN_CAPABILITIES_INPUT_INVALID");
    expect(boundary.create).not.toHaveBeenCalled();
    expect(boundary.close).toHaveBeenCalledOnce();
  });
  it("registers only missing declarations and audits each created capability", async () => {
    boundary.get.mockImplementation(async (ref) => (ref === "first" ? record(ref) : undefined));
    expect(await runCapabilitiesCommand(args)).toEqual({
      snapshotDigest: digest,
      created: ["second"],
      existing: 1,
    });
    expect(boundary.create).toHaveBeenCalledExactlyOnceWith(record("second"));
    expect(boundary.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ownerId: "owner-register",
        agentId: "agent-register",
        action: "owner.capability.register",
        targetRef: "second",
        outcome: "completed",
      }),
    );
    expect(boundary.close).toHaveBeenCalledOnce();
  });
  it.each(["revoked", "changed-declaration"])(
    "validates every existing declaration before any write (%s)",
    async (reason) => {
      boundary.get.mockImplementation(async (ref) =>
        ref === "first"
          ? undefined
          : {
              ...record(ref),
              ...(reason === "revoked"
                ? { lifecycle: "revoked" }
                : { declaration: { operations: ["write"] } }),
            },
      );
      await expect(runCapabilitiesCommand(args)).rejects.toThrow(
        "ADMIN_CAPABILITY_REVIEW_REQUIRED",
      );
      expect(boundary.create).not.toHaveBeenCalled();
      expect(boundary.audit).not.toHaveBeenCalled();
      expect(boundary.close).toHaveBeenCalledOnce();
    },
  );
  it.each(["read", "create", "audit"])(
    "closes state and propagates a %s failure without claiming success",
    async (phase) => {
      (phase === "read"
        ? boundary.get
        : phase === "create"
          ? boundary.create
          : boundary.audit
      ).mockRejectedValue(new Error("fixture-storage-failure"));
      await expect(runCapabilitiesCommand(args)).rejects.toThrow("fixture-storage-failure");
      expect(boundary.close).toHaveBeenCalledOnce();
    },
  );
});
