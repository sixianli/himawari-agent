import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureGitleaks,
  formatGateResult,
  gitleaksCacheDirectory,
} from "../../scripts/check-gitleaks.mjs";

describe("check:gitleaks 入口", () => {
  it("缓存目录默认按锁定版本和平台分开，可用环境变量改到别处", () => {
    expect(gitleaksCacheDirectory({ env: {}, version: "8.30.0", platform: "linux-x64" })).toMatch(
      /\/\.cache\/himawari\/gitleaks\/8\.30\.0\/linux-x64$/,
    );
    expect(
      gitleaksCacheDirectory({
        env: { HIMAWARI_GITLEAKS_CACHE: "/srv/gitleaks" },
        version: "8.30.0",
        platform: "linux-x64",
      }),
    ).toBe("/srv/gitleaks");
  });
  it("锁文件里没有这个平台的 gitleaks 时直接失败，不去下载", async () => {
    await expect(
      ensureGitleaks({
        platform: "win32-x64",
        env: { HIMAWARI_GITLEAKS_CACHE: join("/nonexistent", "gitleaks") },
        fetch: () => {
          throw new Error("MUST_NOT_FETCH");
        },
      }),
    ).rejects.toThrow("GITLEAKS_PLATFORM_UNSUPPORTED:win32-x64");
  });
  it("失败时逐条列出位置和规则，并说明误报和真密钥各怎么处理", () => {
    const text = formatGateResult({
      status: "failed",
      currentFiles: 10,
      commits: 3,
      exceptedCount: 1,
      blocking: [
        {
          id: "generic-api-key",
          path: "a.ts",
          line: 4,
          scope: "history",
          commit: "a".repeat(40),
        },
      ],
    });
    expect(text).toContain(`GITLEAKS_FINDING history a.ts:4 generic-api-key ${"a".repeat(40)}`);
    expect(text).toContain("GITLEAKS_GATE_FAILED current=10 commits=3 excepted=1 blocking=1");
    expect(text).toContain("ci/rules/gitleaks.toml");
  });
  it("通过时只打一行汇总", () => {
    expect(
      formatGateResult({
        status: "passed",
        currentFiles: 10,
        commits: 3,
        exceptedCount: 0,
        blocking: [],
      }),
    ).toBe("GITLEAKS_GATE_PASSED current=10 commits=3 excepted=0 blocking=0");
  });
});
