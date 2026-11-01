import { expect, it, vi } from "vitest";

const verify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@himawari-agent/platform-node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@himawari-agent/platform-node")>()),
  verifySandboxHost: verify,
}));

import { verifyWorkerSandboxHostAtStartup } from "../src/production-worker-composition.js";

it("starts the worker without waiting for the whole sandbox runtime content audit", async () => {
  const binding = { hostId: "host:test" } as never;
  const qualification = { qualificationRef: "qualification:test" } as never;
  await verifyWorkerSandboxHostAtStartup(binding, qualification);
  expect(verify).toHaveBeenCalledExactlyOnceWith(
    { binding, qualification, hostId: "host:test" },
    { deferContentAudit: true },
  );
});
