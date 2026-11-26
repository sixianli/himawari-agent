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
const VAULT_CIPHERTEXTS = [
  ["OJcMhbm3WDiSpM1vIJuD1qnNNVIJ0hTf75YUIS9f", "/c6Qo98Y9w4CnxSW0UGHkewWlVHlFpwsGvui/nsG"],
  ["tByJMmanrteJYrzRyAz6eC7I+9mY5n5X", "MjMmS01n940gxxayiFeZE/6q"],
  ["XGIcgad/HQpwhhB3ypIea5eB2sEm5ufB", "GncMjFIZKSwR44rKumK8mSkH"],
  ["uZP0fC70wm4e+scCIDFNsUTSMXyWlwzXpo70DxbK", "9KJ6kd4XjfSuZN9OQSvjdn9coV0ImLS4JBvMBl2U"],
].map((parts) => parts.join(""));
const matches = (patterns, value) => patterns.some((pattern) => pattern.test(value));

describe("[I-gitleaks-allowlist] Gitleaks 白名单只放行已审阅的形式", () => {
  const [, gitObjects, readback, ...scoped] = blocks;

  it("已删除证据清单里的 40 位 git 对象号行被放行，其他值和其他文件不放行", () => {
    expect(gitObjects.target).toBe('"generic-api-key"');
    expect(gitObjects.regexTarget).toBe("match");
    expect(gitObjects.condition).toBe("AND");
    expect(matches(gitObjects.paths, ".agents/tasks/round2-tool-execution/evidence.jsonl")).toBe(
      true,
    );
    expect(matches(gitObjects.paths, "test/qualification/evidence/other/frozen.json")).toBe(false);
    expect(matches(gitObjects.paths, "src/config/server.json")).toBe(false);
    expect(matches(gitObjects.regexes, `credential.json": "${"b".repeat(40)}"`)).toBe(true);
    expect(matches(gitObjects.regexes, `credential.json": "${"b".repeat(64)}"`)).toBe(false);
    expect(matches(gitObjects.regexes, `secret-reader.ts": "${realShapedKey}"`)).toBe(false);
    expect(matches(gitObjects.regexes, `secret-reader.ts": "${"a".repeat(41)}"`)).toBe(false);
    expect(matches(gitObjects.regexes, `apiKey = "${"b".repeat(40)}"`)).toBe(false);
  });

  it("回读文件里那一行摘要只在那个文件里按精确值放行", () => {
    const line = `p4-save-secrets-final.log": "0803b00889e1a37bf2645a12f203d89c5a695b27538e322db7e962339e6a416a"`;
    expect(readback.condition).toBe("AND");
    expect(readback.target).toBe('"generic-api-key"');
    expect(readback.regexTarget).toBe("match");
    expect(
      matches(
        readback.paths,
        "/tmp/x/test/qualification/evidence/workspace-authorization-lifecycle/p4-completion-01/archive-readback.json",
      ),
    ).toBe(true);
    expect(
      matches(
        readback.paths,
        "test/qualification/evidence/workspace-authorization-lifecycle/p0/archive-readback.json",
      ),
    ).toBe(false);
    expect(matches(readback.regexes, line)).toBe(true);
    expect(matches(readback.regexes, line.replace("0803", "0804"))).toBe(false);
  });

  it("其余每条白名单都同时限定规则、文件路径和值的形状", () => {
    expect(scoped).toHaveLength(18);
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
    const changeLast = (value) => `${value.slice(0, -1)}${value.endsWith("Q") ? "R" : "Q"}`;
    const changeFirst = (value) => `${value.startsWith("Q") ? "R" : "Q"}${value.slice(1)}`;
    const sameKindLast = (value) => {
      const last = value.at(-1);
      const other = /\d/.test(last) ? "01" : /[a-z]/.test(last) ? "ab" : "AB";
      return `${value.slice(0, -1)}${last === other[0] ? other[1] : other[0]}`;
    };
    for (const [index, sample, mutate] of [
      ["BTBZMqHH6r4Tts7J_aSIgg", changeLast],
      ["F5u42Bd3HyW8KxkUqo2gRA", changeFirst],
      ["R2T14BEARERVALUE0001", changeLast],
      [["gh", "p_Zk3Qw8Lm2VxN9sTdR4bYf7HcJ1pUa6EoXe5G"].join(""), changeLast],
      ["tmpfs-size=1048576", changeLast],
      ["f504128e-d710-44e1-a304-6b61c370ef24", changeLast],
      [["0123456789abcdef", "0123456789abcdef"].join(""), changeLast],
      [["sensitive", "interceptions", "clear", "01"].join("-"), changeLast],
      [
        ["0803b00889e1a37bf2645a12f203d89c", "5a695b27538e322db7e962339e6a416a"].join(""),
        changeFirst,
      ],
      [["-----BEGIN", "PRIVATE KEY----- is used ...`"].join(" "), changeLast],
      [["-----BEGIN", "ENCRYPTED PRIVATE KEY-----`、`DSA PRIVATE KEY` "].join(" "), changeLast],
      [
        ["-----BEGIN", "PRIVATE KEY----- $", '{"说明".repeat(5000)}']
          .join(" ")
          .replace("$ {", "${"),
        changeLast,
      ],
      [["MIIEvR2T14", "TAILBODY"].join(""), changeLast],
      [["abcdef", "123456"].join(""), changeLast],
      [["abcdef", "123456"].join(""), changeLast],
      [
        ["aeb13307a71acd8fe81861d94ad54ab6", "89df773318809eed3cbe794b4492dae4"].join(""),
        changeLast,
      ],
      [VAULT_CIPHERTEXTS[0], changeLast],
    ].map(([sample, mutate], index) => [index, sample, mutate])) {
      expect(matches(scoped[index].regexes, sample)).toBe(true);
      expect(matches(scoped[index].regexes, mutate(sample))).toBe(false);
      expect(matches(scoped[index].regexes, sameKindLast(sample))).toBe(false);
    }
  });

  it("PR 273 复核记录里的合成令牌只在第 1、4 轮的 DeepSeek 记录里被放行", () => {
    const block = scoped[6];
    expect(matches(block.paths, ".agents/reviews/pr-273/round-1/deepseek-v4.1-flash.md")).toBe(
      true,
    );
    expect(matches(block.paths, ".agents/reviews/pr-273/round-4/deepseek-v4.1-flash.md")).toBe(
      true,
    );
    expect(matches(block.paths, ".agents/reviews/pr-273/round-2/deepseek-v4.1-flash.md")).toBe(
      false,
    );
    expect(matches(block.paths, ".agents/reviews/pr-274/round-1/deepseek-v4.1-flash.md")).toBe(
      false,
    );
    expect(matches(block.paths, ".agents/reviews/pr-273/round-1/glm-5.3-flash.md")).toBe(false);
  });

  it("保险箱合约夹具里的四个密文只在那个夹具文件里按精确值放行", () => {
    const block = scoped[16];
    expect(block.regexTarget).toBe("secret");
    expect(
      matches(
        block.paths,
        "/tmp/x/clients/apple/Tests/HimawariCoreTests/Fixtures/vault-contract.json",
      ),
    ).toBe(true);
    expect(
      matches(block.paths, "clients/apple/Tests/HimawariCoreTests/Fixtures/other-contract.json"),
    ).toBe(false);
    expect(
      matches(
        block.paths,
        "clients/apple/Tests/HimawariCoreTests/Fixtures/vault-contract.json.bak",
      ),
    ).toBe(false);
    for (const value of VAULT_CIPHERTEXTS) {
      expect(matches(block.regexes, value)).toBe(true);
      expect(matches(block.regexes, `${value}A`)).toBe(false);
      expect(
        matches(
          block.regexes,
          value.replace(/^./, (first) => (first === "Q" ? "R" : "Q")),
        ),
      ).toBe(false);
    }
    expect(matches(block.regexes, "A".repeat(56))).toBe(false);
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
