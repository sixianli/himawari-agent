import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEMPLATE_PATH = fileURLToPath(
  new URL(
    "../../../scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json",
    import.meta.url,
  ),
);

describe("production configuration template concurrency", () => {
  it("allows at least two conversations to run at once and keeps a foreground slot", () => {
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as {
      concurrency: { totalRuns: number; foregroundReserved: number };
    };
    expect(template.concurrency.totalRuns).toBeGreaterThanOrEqual(2);
    expect(template.concurrency.foregroundReserved).toBeGreaterThanOrEqual(1);
    expect(template.concurrency.foregroundReserved).toBeLessThan(template.concurrency.totalRuns);
  });
});
