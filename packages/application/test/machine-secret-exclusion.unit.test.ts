import {
  MACHINE_SECRET_RULE_IDS,
  assertMachineSecretFree,
  redactMachineSecrets,
  redactTracePayload,
  scanMachineSecrets,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const secretFixtures = Object.freeze([
  ["model", "sk-proj-abcdefghijklmnopqrstuvwxyz012345"],
  ["memory", "github_pat_abcdefghijklmnopqrstuvwxyz012345"],
  ["github", "Bearer webhook-secret-token-value"],
  ["worker", "access_token=worker-token-material-value"],
  ["identity", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature-material"],
] as const);

describe("machine-secret exclusion", () => {
  it("reports only stable rule identifiers and counts", () => {
    const input = secretFixtures.map(([surface, value]) => `${surface}:${value}`).join("\n");
    const findings = scanMachineSecrets(input);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(({ ruleId }) => MACHINE_SECRET_RULE_IDS.includes(ruleId))).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("secret-token-value");
    expect(() => assertMachineSecretFree(input)).toThrowError(
      expect.objectContaining({ code: "MACHINE_SECRET_EXCLUDED" }),
    );
  });

  it.each(secretFixtures)("removes the original %s secret before Trace persistence", (_, value) => {
    const redacted = redactMachineSecrets(value);
    expect(redacted).not.toContain(value);
    const traceValue = redactTracePayload({ body: value });
    expect(JSON.stringify(traceValue)).not.toContain(value);
  });
});
