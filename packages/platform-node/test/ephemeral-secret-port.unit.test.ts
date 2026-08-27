import type { ClockPort, IdGeneratorPort, SecretPort } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { EphemeralSecretPort } from "../src/index.js";

describe("EphemeralSecretPort", () => {
  it("stores only scoped metadata and revokes handles in process", async () => {
    let sequence = 0;
    const ids: IdGeneratorPort = { next: (namespace) => `${namespace}:${++sequence}` };
    const clock: ClockPort = { now: () => "2026-08-27T00:00:00.000Z" };
    const port: SecretPort & { clear(): void } = new EphemeralSecretPort({ ids, clock });
    const handle = await port.issueHandle({
      ownerId: "owner-ephemeral" as never,
      agentId: "agent-ephemeral" as never,
      runId: "run-ephemeral" as never,
      secretRef: "provider-key",
      secretVersion: "v1",
      purpose: "model-auth",
      scopeRef: "invocation-ephemeral",
      expiresAt: "2026-08-27T00:01:00.000Z",
    });

    expect(handle).toMatchObject({
      ref: "secret-handle:1",
      secretRef: "provider-key",
      secretVersion: "v1",
      purpose: "model-auth",
      scopeRef: "invocation-ephemeral",
      revokedAt: null,
    });
    expect(JSON.stringify(handle)).not.toContain("secretValue");
    await expect(port.inspectHandle(handle.ref)).resolves.toEqual(handle);
    await expect(port.revokeHandle(handle.ref, "2026-08-27T00:00:30.000Z")).resolves.toMatchObject({
      revokedAt: "2026-08-27T00:00:30.000Z",
    });
    await expect(port.inspectHandle(handle.ref)).resolves.toMatchObject({
      revokedAt: "2026-08-27T00:00:30.000Z",
    });
    port.clear();
    await expect(port.inspectHandle(handle.ref)).resolves.toBeUndefined();
  });

  it("rejects malformed or expired lifetimes", async () => {
    const port = new EphemeralSecretPort({
      ids: { next: (namespace) => namespace },
      clock: { now: () => "2026-08-27T00:00:00.000Z" },
    });
    const request = {
      ownerId: "owner-ephemeral" as never,
      agentId: "agent-ephemeral" as never,
      runId: "run-ephemeral" as never,
      secretRef: "provider-key",
      secretVersion: "v1",
      purpose: "model-auth",
      scopeRef: "invocation-ephemeral",
      expiresAt: "2026-08-27T00:00:00.000Z",
    };
    await expect(port.issueHandle(request)).rejects.toThrow("SECRET_HANDLE_EXPIRED");
    await expect(port.issueHandle({ ...request, expiresAt: "not-a-date" })).rejects.toThrow(
      "SECRET_HANDLE_EXPIRED",
    );
  });
});
