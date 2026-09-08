import { describe, expect, it } from "vitest";
import { sandboxHostBindingSchema, sandboxRuntimeQualificationSchema } from "../src/index.ts";

const qualification = {
  schemaVersion: "sandbox-runtime-qualification.v1",
  qualificationRef: "qualification:test",
  hostId: "host:test",
  profileRef: "host-readonly.v1",
  srtVersion: "0.0.75",
  platform: "darwin",
  architecture: "arm64",
  osRelease: "27.0.0",
  runtimeDigest: "a".repeat(64),
  runnerDigest: "b".repeat(64),
  evidenceDigest: "c".repeat(64),
  resourceMode: "observe_and_stop",
  terminationMode: "best_effort",
  guarantees: [
    "filesystem_default_deny",
    "network_allowlist",
    "clean_environment",
    "bounded_output",
    "wall_clock_stop",
    "resource_observation",
    "durable_start_admission",
    "unknown_quarantine",
    "restart_reconciliation",
    "best_effort_stop",
  ],
  limitations: ["detached_descendants_may_survive_stop"],
};
const binding = {
  schemaVersion: "sandbox-host-binding.v1",
  capabilityRef: "cap:test",
  capabilityVersion: "1.0.0",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  hostId: "host:test",
  profileRef: "host-readonly.v1",
  runtimeRoot: "/opt/runtime",
  runtimeDigest: "a".repeat(64),
  executable: { path: "/usr/bin/node", sha256: "d".repeat(64) },
  runner: { path: "/opt/runtime/runner.js", sha256: "b".repeat(64) },
  privateRoot: "/var/private-jobs",
  roots: [
    { canonicalRootId: "root:test", canonicalPath: "/work/project", device: "1", inode: "2" },
  ],
  readOnlyToolchainPaths: ["/usr/bin"],
  protectedPaths: ["/work/project/.env"],
  allowedDomains: ["example.com"],
  maximumResourceCeiling: {
    maxWallTimeMs: 1000,
    maxCpuTimeMs: 1000,
    maxMemoryBytes: 1024,
    maxOutputBytes: 1024,
    maxProgressEvents: 10,
  },
};
describe("sandbox host qualification", () => {
  it("retains Mac limitations and requires stronger Linux guarantees", () => {
    expect(sandboxRuntimeQualificationSchema.parse(qualification)).toEqual(qualification);
    expect(() =>
      sandboxRuntimeQualificationSchema.parse({ ...qualification, platform: "linux" }),
    ).toThrow();
    expect(
      sandboxRuntimeQualificationSchema.parse({
        ...qualification,
        platform: "linux",
        terminationMode: "verified_tree",
        guarantees: [
          ...qualification.guarantees.filter((value) => value !== "best_effort_stop"),
          "task_tree_termination",
          "worker_crash_cleanup",
        ],
        limitations: [],
      }),
    ).toMatchObject({ platform: "linux" });
  });
  it.each([
    { limitations: [] },
    { terminationMode: "verified_tree" },
    { resourceMode: "hard_limits" },
    { guarantees: qualification.guarantees.filter((value) => value !== "restart_reconciliation") },
    { guarantees: [...qualification.guarantees, "task_tree_termination"] },
    { srtVersion: "0.0.76" },
    { guarantees: [...qualification.guarantees, "best_effort_stop"] },
    { extra: true },
  ])("rejects unsupported or omitted evidence: %j", (override) => {
    expect(() =>
      sandboxRuntimeQualificationSchema.parse({ ...qualification, ...override }),
    ).toThrow();
  });
  it("accepts only literal separated host inventory", () => {
    expect(sandboxHostBindingSchema.parse(binding)).toEqual(binding);
  });
  it.each([
    { runtimeRoot: "/" },
    { executable: { ...binding.executable, path: "/work/project/node" } },
    {
      roots: [
        ...binding.roots,
        {
          ...binding.roots[0],
          canonicalRootId: "root:other",
          canonicalPath: "/work/project/nested",
        },
      ],
    },
    { privateRoot: "/work/project/jobs" },
    { runtimeRoot: "/work/project/runtime" },
    { runner: { ...binding.runner, path: "/work/project/runner.js" } },
    { allowedDomains: ["*.example.com"] },
    { allowedDomains: ["127.0.0.1"] },
    { allowedDomains: ["example.123"] },
    { allowedDomains: ["example.com", "example.com"] },
    { privateRoot: "/tmp/../private" },
    { privateRoot: "/tmp/with\nnewline" },
    { readOnlyToolchainPaths: ["/work"] },
  ])("rejects unsafe host binding: %j", (override) => {
    expect(() => sandboxHostBindingSchema.parse({ ...binding, ...override })).toThrow();
  });
});
