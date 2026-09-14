import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("preserves signer access and directory identity across runtime ownership handoff", () => {
  const result = execFileSync(
    "python3",
    ["-B", fileURLToPath(new URL("./fixtures/hermes-migration-check.py", import.meta.url))],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  expect(result).toBe("");
});
