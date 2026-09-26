import { describe, expect, it } from "vitest";
import { readMachineBootId } from "../src/machine-boot.ts";

describe("readMachineBootId", () => {
  it("reads the same boot identity of this running machine twice", async () => {
    const first = await readMachineBootId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await expect(readMachineBootId()).resolves.toBe(first);
  });

  it("refuses a platform without a supported boot identity", async () => {
    await expect(readMachineBootId("win32")).rejects.toThrow("MACHINE_BOOT_ID_UNAVAILABLE");
  });
});
