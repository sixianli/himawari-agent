import { createHash } from "node:crypto";
import type {
  CapabilityInvocationRequest,
  SandboxExecutionPlan,
} from "@himawari-agent/application";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createBrokerSandboxExecution } from "../src/broker-sandbox-execution.js";
import type { createProductSandboxHostSession } from "../src/product-job-host.js";

const boundary = vi.hoisted(() => ({
  load: vi.fn(),
  revalidate: vi.fn(),
  verify: vi.fn(),
  prepare: vi.fn(),
  session: vi.fn(),
  broker: vi.fn(),
}));
vi.mock("@himawari-agent/platform-node", () => ({
  CapabilityDeploymentSnapshotLoader: class {
    load = boundary.load;
  },
  revalidateCapabilityDeploymentSnapshot: boundary.revalidate,
  verifySandboxHost: boundary.verify,
}));
vi.mock("@himawari-agent/runtime-sandbox", () => ({ prepareJobPolicy: boundary.prepare }));
vi.mock("../src/product-job-host.js", () => ({
  createProductSandboxHostSession: boundary.session,
}));
vi.mock("../src/broker-sandbox-execution.js", () => ({
  createBrokerSandboxExecution: boundary.broker,
}));

import { createProductionSandboxWorker } from "../src/production-sandbox-worker.js";

const now = "2026-09-14T00:00:00.000Z";
const plan = {
  capabilityRef: "capability",
  capabilityVersion: "1",
  identity: { hostId: "host", jobId: "job" },
  executionLease: { authorityLeaseId: "lease", authorityFencingToken: 7 },
  operation: "read",
  authorizationRef: "authorization",
  modelRef: "model",
} as SandboxExecutionPlan;
const invocation = { invocationId: "invocation" } as CapabilityInvocationRequest;
function fixture() {
  const binding = {
    profileRef: "profile",
    allowedDomains: ["example.test:443"],
    roots: [{ canonicalRootId: "root", canonicalPath: "/workspace" }],
    privateRoot: "/private",
    runtimeRoot: "/runtime",
    readOnlyToolchainPaths: ["/toolchain"],
    protectedPaths: ["/protected"],
    executable: { path: "/runtime/node" },
    runner: { path: "/runtime/runner" },
    hostId: "host",
  };
  const entry = {
    manifest: { ref: "capability", version: "1" },
    binding: { kind: "sandbox", value: binding },
    qualification: { sandbox: { qualified: true } },
  };
  const loaded = { snapshot: { capabilities: [entry] } };
  const scope = {
    operation: "read",
    authorizationRef: "authorization",
    modelRef: "model",
    profileRef: "profile",
    networkAuthorizationRef: null as string | null,
    directoryGrant: { canonicalRootId: "root", operations: ["read"] },
  };
  const resolved = { scope, allowedDomains: [] as string[] };
  const payloads = {
    readSandboxScope: vi.fn(async () => resolved),
    readInput: vi.fn(async () => new TextEncoder().encode("input")),
    writeOutput: vi.fn(async () => "protected-output"),
  };
  const configuration = {
    deploymentId: "deployment",
    capabilityDeployment: { snapshotPath: "/snapshot", snapshotSha256: "a".repeat(64) },
  };
  const peer = {
    authorityEpoch: 2,
    fencingToken: 3,
    agentServiceInstanceId: "agent-instance",
    agentServiceBootId: "agent-boot",
    workerInstanceId: "worker-instance",
    workerBootId: "worker-boot",
  };
  boundary.load.mockResolvedValue(loaded);
  boundary.revalidate.mockResolvedValue(loaded);
  boundary.verify.mockResolvedValue(undefined);
  boundary.prepare.mockResolvedValue({
    policy: { name: "compiled-policy" },
    compiled: { policyDigest: "digest" },
  });
  boundary.session.mockReturnValue({ session: "owned-host" });
  boundary.broker.mockReturnValue({ broker: "owned-broker" });
  createProductionSandboxWorker({
    configuration,
    peer,
    payloads,
    clock: { now: () => now },
  } as unknown as Parameters<typeof createProductionSandboxWorker>[0]);
  const brokerCall = boundary.broker.mock.calls[0];
  if (!brokerCall) throw new Error("Expected broker composition");
  const hooks = brokerCall[0] as Parameters<typeof createBrokerSandboxExecution>[0];
  return { binding, entry, loaded, resolved, payloads, hooks };
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("production sandbox Worker composition", () => {
  it("requires a pinned deployment before creating a broker or host", () => {
    expect(() =>
      createProductionSandboxWorker({
        configuration: {},
        peer: {},
        payloads: {},
        clock: {},
      } as Parameters<typeof createProductionSandboxWorker>[0]),
    ).toThrow("SANDBOX_DEPLOYMENT_UNAVAILABLE");
    expect(boundary.broker).not.toHaveBeenCalled();
    expect(boundary.session).not.toHaveBeenCalled();
  });
  it("binds execution authority to the authenticated peer and prepared lease", () => {
    const f = fixture();
    expect(f.hooks.authority(plan)).toEqual({
      product: { deploymentId: "deployment", authorityEpoch: 2, fencingToken: 3 },
      lease: { leaseId: "lease", fencingToken: 7 },
      agentServiceInstanceId: "agent-instance",
      agentServiceBootId: "agent-boot",
      workerInstanceId: "worker-instance",
      workerBootId: "worker-boot",
    });
    expect(f.hooks.now()).toBe(now);
  });
  it.each(["missing", "version", "binding", "qualification"])(
    "refuses a %s installed host",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.loaded.snapshot.capabilities = [];
      if (kind === "version") f.entry.manifest.version = "2";
      if (kind === "binding") f.entry.binding.kind = "program";
      if (kind === "qualification") Object.assign(f.entry.qualification, { sandbox: undefined });
      await expect(f.hooks.verify(plan)).rejects.toThrow("SANDBOX_HOST_UNAVAILABLE");
      expect(boundary.verify).not.toHaveBeenCalled();
      expect(boundary.session).not.toHaveBeenCalled();
    },
  );
  it("does not prepare a host after inventory revalidation fails", async () => {
    const f = fixture();
    boundary.revalidate.mockRejectedValueOnce(new Error("snapshot changed"));
    await expect(f.hooks.prepareHost(plan, invocation)).rejects.toThrow("snapshot changed");
    expect(f.payloads.readSandboxScope).not.toHaveBeenCalled();
    expect(boundary.prepare).not.toHaveBeenCalled();
  });
  it.each(["operation", "authorizationRef", "modelRef", "profileRef"])(
    "refuses a substituted %s scope before reading input",
    async (key) => {
      const f = fixture();
      Object.assign(f.resolved.scope, { [key]: "other" });
      await expect(f.hooks.prepareHost(plan, invocation)).rejects.toThrow("SANDBOX_SCOPE_CHANGED");
      expect(f.payloads.readInput).not.toHaveBeenCalled();
      expect(boundary.session).not.toHaveBeenCalled();
    },
  );
  it.each(["unapproved-domain", "no-network-authority"])(
    "refuses %s before compiling a policy",
    async (kind) => {
      const f = fixture();
      f.resolved.allowedDomains = [
        kind === "unapproved-domain" ? "other.test:443" : "example.test:443",
      ];
      if (kind === "unapproved-domain")
        f.resolved.scope.networkAuthorizationRef = "network-authority";
      await expect(f.hooks.prepareHost(plan, invocation)).rejects.toThrow("SANDBOX_SCOPE_CHANGED");
      expect(boundary.prepare).not.toHaveBeenCalled();
    },
  );
  it("refuses a directory that is no longer in the installed root inventory", async () => {
    const f = fixture();
    f.resolved.scope.directoryGrant.canonicalRootId = "other";
    await expect(f.hooks.prepareHost(plan, invocation)).rejects.toThrow("SANDBOX_ROOT_UNAVAILABLE");
    expect(f.payloads.readInput).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "uses only the authenticated filesystem and network scope (writable=%s)",
    async (writable) => {
      const f = fixture();
      if (writable) {
        f.resolved.scope.directoryGrant.operations.push("update");
        f.resolved.allowedDomains = ["example.test:443"];
        f.resolved.scope.networkAuthorizationRef = "network-authority";
      }
      await f.hooks.prepareHost(plan, invocation);
      expect(boundary.verify).toHaveBeenCalledWith({
        binding: f.binding,
        qualification: f.entry.qualification.sandbox,
        hostId: "host",
        plan,
      });
      expect(boundary.prepare).toHaveBeenCalledExactlyOnceWith({
        workspace: "/workspace",
        writable,
        jobId: "job",
        privateRoot: "/private",
        readOnlyToolchainPaths: ["/runtime", "/toolchain"],
        protectedPaths: ["/protected"],
        allowedDomains: writable ? ["example.test:443"] : [],
      });
      const args = boundary.session.mock.calls[0] as Parameters<
        typeof createProductSandboxHostSession
      >;
      expect(args[1]).toEqual({
        policy: { name: "compiled-policy" },
        policyDigest: "digest",
        executable: "/runtime/node",
        args: ["/runtime/runner", "host", "worker-instance"],
        stdinBase64: Buffer.from("input").toString("base64"),
        cleanupTimeoutMs: 5000,
      });
      const stdout = new TextEncoder().encode("actual output bytes");
      const result = await args[2]({ stdout } as Parameters<(typeof args)[2]>[0]);
      expect(f.payloads.writeOutput).toHaveBeenCalledExactlyOnceWith(
        invocation,
        stdout,
        "application/octet-stream",
      );
      expect(result).toEqual({
        outputRef: "protected-output",
        outputDigest: createHash("sha256").update(stdout).digest("hex"),
      });
    },
  );
  it.each([49152, 49153])("enforces the protected input limit at %i bytes", async (size) => {
    const f = fixture();
    f.payloads.readInput.mockResolvedValueOnce(new Uint8Array(size));
    if (size === 49152) {
      await f.hooks.prepareHost(plan, invocation);
      expect(boundary.session).toHaveBeenCalledOnce();
    } else {
      await expect(f.hooks.prepareHost(plan, invocation)).rejects.toThrow(
        "SANDBOX_INPUT_TOO_LARGE",
      );
      expect(boundary.session).not.toHaveBeenCalled();
    }
  });
});
