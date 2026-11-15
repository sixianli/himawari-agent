import { describe, expect, it } from "vitest";

import { grantDetailLines } from "../src/services/grant-detail-lines.js";

const base = {
  exactResourceRef: null,
  resourceIdentities: [],
  resourcePrefixes: [],
  recipients: [],
  uses: 0,
  maxUses: 1,
  spentCostMicros: 0,
  maxTotalCostMicros: 0,
  maxCostMicrosPerUse: 0,
  expiresAt: "2026-12-12T03:00:00.000Z",
  affectedTaskCount: 0,
};

describe("grantDetailLines", () => {
  it("lists scope, uses, cost, expiry and affected tasks in three languages", () => {
    const lines = grantDetailLines({
      ...base,
      resourceIdentities: ["a", "b"],
      recipients: ["r"],
      uses: 3,
      maxUses: 5,
      spentCostMicros: 500_000,
      maxTotalCostMicros: 2_000_000,
      affectedTaskCount: 2,
    });
    expect(lines["zh-CN"]).toEqual([
      "范围：2 项",
      "收件对象：1 个",
      "已用 3/5 次",
      "费用上限 $2.00，已花 $0.50",
      "到期：2026-12-12",
      "会影响 2 个任务",
    ]);
    expect(lines.en).toContain("Used 3 of 5");
    expect(lines.ja).toContain("3/5 回使用");
  });

  it("counts a resource once when the exact reference is also listed as an identity", () => {
    const lines = grantDetailLines({
      ...base,
      exactResourceRef: "resource:a",
      resourceIdentities: ["resource:a"],
    });
    expect(lines["zh-CN"][0]).toBe("范围：1 项");
    expect(lines.en[0]).toBe("Scope: 1 item");
  });

  it("omits scope, cost and affected-task lines when there is nothing to show", () => {
    const lines = grantDetailLines(base);
    expect(lines["zh-CN"]).toEqual(["已用 0/1 次", "到期：2026-12-12"]);
    expect(lines.en).toEqual(["Used 0 of 1", "Expires: 2026-12-12"]);
  });
});
