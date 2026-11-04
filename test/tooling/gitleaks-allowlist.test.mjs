import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const text = readFileSync(join(import.meta.dirname, "../../ci/rules/gitleaks.toml"), "utf8");
const blocks = text
  .split("[[allowlists]]")
  .slice(1)
  .map((block) => ({
    target: block.match(/^targetRules = \[(.*)\]$/m)?.[1],
    condition: block.match(/^condition = "(.*)"$/m)?.[1],
    regexTarget: block.match(/^regexTarget = "(.*)"$/m)?.[1],
    paths: [...(block.match(/^paths = \[(.*)\]$/m)?.[1] ?? "").matchAll(/'''(.*?)'''/g)].map(
      (match) => new RegExp(match[1]),
    ),
    regexes: [...(block.match(/^regexes = \[(.*)\]$/m)?.[1] ?? "").matchAll(/'''(.*?)'''/g)].map(
      (match) => new RegExp(match[1]),
    ),
  }));
const realShapedKey = ["sk", "live", "9fK2mQ7xT4vB8nL1cZ6wR3yH5jD0aE"].join("_");
const matches = (patterns, value) => patterns.some((pattern) => pattern.test(value));

describe("[I-gitleaks-allowlist] Gitleaks 白名单只放行已审阅的形式", () => {
  const [hashLines, ...scoped] = blocks;

  it("文件名对应 40 或 64 位十六进制摘要的清单行被放行，其他值不放行", () => {
    expect(hashLines.target).toBe('"generic-api-key"');
    expect(hashLines.regexTarget).toBe("match");
    expect(hashLines.condition).toBe("AND");
    expect(matches(hashLines.paths, "/tmp/x/test/qualification/evidence/p1/frozen.json")).toBe(
      true,
    );
    expect(matches(hashLines.paths, ".agents/tasks/round2-tool-execution/evidence.jsonl")).toBe(
      true,
    );
    expect(matches(hashLines.paths, "src/config/server.json")).toBe(false);
    expect(matches(hashLines.regexes, `secret-reader.ts": "${"a".repeat(64)}"`)).toBe(true);
    expect(matches(hashLines.regexes, `credential.json": "${"b".repeat(40)}"`)).toBe(true);
    expect(matches(hashLines.regexes, `secret-reader.ts": "${realShapedKey}"`)).toBe(false);
    expect(matches(hashLines.regexes, `secret-reader.ts": "${"a".repeat(41)}"`)).toBe(false);
    expect(matches(hashLines.regexes, `apiKey = "${"a".repeat(64)}"`)).toBe(false);
  });

  it("其余每条白名单都同时限定规则、文件路径和值的形状", () => {
    expect(scoped).toHaveLength(6);
    for (const block of scoped) {
      expect(block.condition).toBe("AND");
      expect(block.regexTarget).toBe("secret");
      expect(block.target).toMatch(/^"[a-z-]+"$/);
      expect(block.paths).toHaveLength(1);
      expect(block.regexes).toHaveLength(1);
    }
  });

  it("反向：路径限定的白名单不覆盖别的文件，值的形状限定也不放过真实形状的密钥", () => {
    for (const block of scoped) {
      expect(matches(block.paths, "/tmp/work/src/other.ts")).toBe(false);
      expect(matches(block.paths, "docs/test/integration/other.test.ts")).toBe(false);
      expect(matches(block.regexes, realShapedKey)).toBe(false);
      expect(matches(block.regexes, `${realShapedKey}${realShapedKey}`)).toBe(false);
    }
  });

  it("反向：值的形状限定到已审阅的那一个值，同长度的别的值不放行", () => {
    const sameLength = (value) => value.replace(/[A-Za-z0-9]/g, (c) => (c === "Q" ? "R" : "Q"));
    for (const [index, sample] of [
      "BTBZMqHH6r4Tts7J_aSIgg",
      "F5u42Bd3HyW8KxkUqo2gRA",
      "R2T14BEARERVALUE0001",
      ["gh", "p_Zk3Qw8Lm2VxN9sTdR4bYf7HcJ1pUa6EoXe5G"].join(""),
      "tmpfs-size=1048576",
      "f504128e-d710-44e1-a304-6b61c370ef24",
    ].entries()) {
      expect(matches(scoped[index].regexes, sample)).toBe(true);
      expect(matches(scoped[index].regexes, sameLength(sample))).toBe(false);
    }
  });

  it("Web Push 测试向量只在两个已审阅的文件里被放行", () => {
    const block = scoped[0];
    expect(
      matches(block.paths, "/tmp/x/test/integration/production-web-push-control.test.ts"),
    ).toBe(true);
    expect(matches(block.paths, "packages/gateway-contracts/test/gateway-v2.fixture.ts")).toBe(
      true,
    );
    expect(matches(block.paths, "test/integration/production-web-push-control.test.ts.bak")).toBe(
      false,
    );
    expect(matches(block.regexes, "BTBZMqHH6r4Tts7J_aSIgg")).toBe(true);
    expect(matches(block.regexes, "BTBZMqHH6r4Tts7J_aSIgg1")).toBe(false);
  });
});
