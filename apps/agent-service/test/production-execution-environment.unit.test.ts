import type { RunPolicyConfiguration } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { strictModeUnavailableTools } from "../src/production-execution-environment.ts";

const route = (capabilityRef: string) => ({
  hostId: "host",
  workerInstanceId: "worker",
  grantId: "grant",
  capabilityRef,
  capabilityVersion: "1.0.0",
  maximumBytes: 4096,
});
const policy = (patch: Partial<RunPolicyConfiguration>): RunPolicyConfiguration => ({
  version: "policy-v1",
  systemInstruction: "instruction",
  memoryLimit: 1,
  maxSelectedMemories: 1,
  maxMemoryClassification: "private",
  ...patch,
});
const refusals =
  (refused: Record<string, "SANDBOX_OPERATION_SRT_ONLY" | "SANDBOX_BINDING_SRT_ONLY">) =>
  async (input: { capabilityRef: string; capabilityVersion: string; operation: string }) => {
    calls.push(`${input.capabilityRef}@${input.capabilityVersion}/${input.operation}`);
    return refused[`${input.capabilityRef}/${input.operation}`] ?? null;
  };
let calls: string[] = [];

describe("strict-mode unavailable tools", () => {
  it("checks each configured tool against its own capability and lists refused ones once", async () => {
    calls = [];
    await expect(
      strictModeUnavailableTools({
        runPolicy: policy({
          fileRead: route("host.file.read"),
          coding: { ...route("coding"), enabledTools: ["bash", "edit"] },
          publicSearch: { ...route("search"), scopeSource: "private_temp" },
        }),
        refusal: refusals({
          "host.file.read/read": "SANDBOX_BINDING_SRT_ONLY",
          "host.file.read/inspect": "SANDBOX_BINDING_SRT_ONLY",
          "coding/bash": "SANDBOX_OPERATION_SRT_ONLY",
        }),
      }),
    ).resolves.toEqual([
      { toolName: "read", reasonCode: "SANDBOX_BINDING_SRT_ONLY" },
      { toolName: "bash", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" },
    ]);
    expect(calls).toEqual([
      "host.file.read@1.0.0/inspect",
      "coding@1.0.0/bash",
      "coding@1.0.0/edit",
      "search@1.0.0/web_search",
    ]);
  });

  it("reports the built-in read when only its second operation is refused", async () => {
    calls = [];
    await expect(
      strictModeUnavailableTools({
        runPolicy: policy({ fileRead: route("host.file.read") }),
        refusal: refusals({ "host.file.read/read": "SANDBOX_OPERATION_SRT_ONLY" }),
      }),
    ).resolves.toEqual([{ toolName: "read", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" }]);
    expect(calls).toEqual(["host.file.read@1.0.0/inspect", "host.file.read@1.0.0/read"]);
  });

  it("uses the coding read instead of the built-in read when coding enables it", async () => {
    calls = [];
    await expect(
      strictModeUnavailableTools({
        runPolicy: policy({
          fileRead: route("host.file.read"),
          coding: { ...route("coding"), enabledTools: ["read"] },
        }),
        refusal: refusals({
          "host.file.read/read": "SANDBOX_BINDING_SRT_ONLY",
          "coding/read": "SANDBOX_OPERATION_SRT_ONLY",
        }),
      }),
    ).resolves.toEqual([{ toolName: "read", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" }]);
    expect(calls).toEqual(["coding@1.0.0/read"]);
  });

  it("lists nothing when no sandbox tools are configured", async () => {
    calls = [];
    await expect(
      strictModeUnavailableTools({ runPolicy: undefined, refusal: refusals({}) }),
    ).resolves.toEqual([]);
    await expect(
      strictModeUnavailableTools({ runPolicy: policy({}), refusal: refusals({}) }),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});
