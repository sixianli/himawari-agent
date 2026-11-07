import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findEgressViolations,
  findSensitiveGateViolations,
  REQUIRED_REDACTION_CALLS,
} from "../../scripts/check-egress-redaction.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "egress-"));
  roots.push(root);
  const files = {};
  for (const { file, required } of REQUIRED_REDACTION_CALLS)
    files[file] = `${files[file] ?? ""}\n${required}`;
  for (const [file, text] of Object.entries({ ...files, ...overrides })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  mkdirSync(join(root, "apps"), { recursive: true });
  return root;
}

describe("egress redaction check", () => {
  it("passes when every registered egress point redacts", () => {
    expect(findEgressViolations(fixture())).toEqual([]);
  });

  it("fails when a registered egress point stops redacting", () => {
    const root = fixture({ "packages/memory-engine/src/embedding.ts": "embed(text)" });
    expect(findEgressViolations(root).join("\n")).toContain("embedding.ts");
  });

  it("fails when the main chat stops putting restored values back", () => {
    const root = fixture({
      "packages/runtime-pi/src/pi-runtime-adapter.ts":
        "exchange.wrapFetch(options?.fetch ?? globalThis.fetch)",
    });
    expect(findEgressViolations(root).join("\n")).toContain("restoreModelStream(");
  });

  it("fails when code outside the egress module calls the redactor directly", () => {
    const root = fixture({
      "packages/application/src/services/other.ts": "redactForEgress(text)",
    });
    expect(findEgressViolations(root).join("\n")).toContain("other.ts");
  });

  it("fails on a new unregistered path to the model or an embedding provider", () => {
    const root = fixture({
      "packages/application/src/services/new-caller.ts":
        'await fetch(base + "/embeddings", { body });',
    });
    expect(findEgressViolations(root).join("\n")).toContain("new-caller.ts");
  });

  it("fails when a detection rule is written outside the sensitive-capture package", () => {
    const root = fixture({
      "apps/agent-service/src/memory.ts":
        "const RULE = /(?<![0-9])(?:[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])[0-9]{16,19})/u;",
      "packages/platform-node/src/token.ts": "const T = /\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b/g;",
      "packages/runtime-pi/src/pw.ts": "const P = /(?:密码|password)\\s*[:：]/u;",
    });
    const report = findEgressViolations(root).join("\n");
    expect(report).toContain(
      "apps/agent-service/src/memory.ts: 敏感信息识别规则（Chinese identity number）",
    );
    expect(report).toContain(
      "apps/agent-service/src/memory.ts: 敏感信息识别规则（card number run）",
    );
    expect(report).toContain(
      "packages/platform-node/src/token.ts: 敏感信息识别规则（AWS access key）",
    );
    expect(report).toContain(
      "packages/runtime-pi/src/pw.ts: 敏感信息识别规则（password or code keyword）",
    );
  });

  it("fails on the rules this package absorbed, written the way they were, in any source extension", () => {
    const root = fixture({
      "apps/control-center/src/memory-import.tsx":
        "const SECRET = /密码|口令|password|passwd|token|secret|api[ _-]?key|身份证|银行卡|卡号|ghp_|sk-|\\d{15,19}/i;",
      "packages/integration-web/src/untrusted-content.js":
        "const P = /(?:sk-[A-Za-z0-9_-]{12,}|(?:password|passwd|token)\\s*[:=]\\s*[^\\s,;]{4,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;",
      "packages/application/src/services/trace.cts":
        'const KEYS = new Set(["apikey", "accesstoken", "clientsecret", "password"]);',
      "packages/runtime-pi/src/observation.mjs":
        "const F = /authorization|cookie|token|api.?key|secret|password|credential/i;",
    });
    const report = findEgressViolations(root).join("\n");
    expect(report).toContain(
      "apps/control-center/src/memory-import.tsx: 敏感信息识别规则（password or code keyword）",
    );
    expect(report).toContain(
      "packages/integration-web/src/untrusted-content.js: 敏感信息识别规则（private key block）",
    );
    expect(report).toContain(
      "packages/integration-web/src/untrusted-content.js: 敏感信息识别规则（OpenAI key）",
    );
    expect(report).toContain(
      "packages/application/src/services/trace.cts: 敏感信息识别规则（sensitive key list）",
    );
    expect(report).toContain(
      "packages/runtime-pi/src/observation.mjs: 敏感信息识别规则（password or code keyword）",
    );
  });

  it("leaves date parsing and ordinary alternations alone", () => {
    const root = fixture({
      "packages/memory-engine/src/time-scope.ts":
        'const Y = new RegExp(`((?:19|20)[0-9]{2})\\\\s*年`, "u"); const W = /周一|周二|today|tomorrow/u;',
    });
    expect(findEgressViolations(root)).toEqual([]);
  });

  it("accepts detection rules inside the sensitive-capture package", () => {
    const root = fixture({
      "packages/sensitive-capture/src/machine-secrets.ts":
        "const T = /\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b/g;",
    });
    expect(findEgressViolations(root)).toEqual([]);
  });
});

describe("external egress registration", () => {
  it("accepts an external service request in its registered file", () => {
    const root = fixture({
      "packages/platform-node/src/exa-public-search.ts":
        'const endpoint = "https://mcp.exa.ai/mcp";',
    });
    expect(findEgressViolations(root)).toEqual([]);
  });

  it("fails when an external service request appears in an unregistered file", () => {
    const root = fixture({
      "apps/agent-service/src/new-search.ts": 'await fetch("https://mcp.exa.ai/mcp", init);',
      "packages/platform-node/src/review.ts": 'fetchImpl(base + "/v1/systemone", init);',
      "packages/platform-node/src/web.ts": 'post("/v1/tools/fetch", body);',
    });
    const report = findEgressViolations(root).join("\n");
    expect(report).toContain(
      "apps/agent-service/src/new-search.ts: 出现了没有登记的外部出口（Exa MCP request）",
    );
    expect(report).toContain(
      "packages/platform-node/src/review.ts: 出现了没有登记的外部出口（TypeSafe review request）",
    );
    expect(report).toContain(
      "packages/platform-node/src/web.ts: 出现了没有登记的外部出口（DeepSeek web tool request）",
    );
  });
});

describe("sensitive gate registration", () => {
  const registry = [
    {
      file: "packages/application/src/services/model-egress.ts",
      calls: { assertMachineSecretFree: 1 },
      decision: "保留",
      reason: "fixture",
    },
  ];

  function gateFixture(files) {
    const root = mkdtempSync(join(tmpdir(), "gates-"));
    roots.push(root);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return root;
  }

  it("passes on this repository", () => {
    expect(findSensitiveGateViolations()).toEqual([]);
  });

  it("passes when every call matches the registry", () => {
    const root = gateFixture({
      "packages/application/src/services/model-egress.ts": "assertMachineSecretFree(text);",
      "packages/application/test/model-egress.unit.test.ts": "scanMachineSecrets(text);",
      "packages/sensitive-capture/src/machine-secrets.ts": "scanMachineSecrets(text);",
      "apps/agent-service/src/plain.ts": "import { scanMachineSecrets } from 'x';",
    });
    expect(findSensitiveGateViolations(root, registry)).toEqual([]);
  });

  it("fails when a new file starts blocking whole content", () => {
    const root = gateFixture({
      "packages/application/src/services/model-egress.ts": "assertMachineSecretFree(text);",
      "apps/agent-service/src/new-tool.ts":
        "if (containsToolOutputSecret(output)) throw new Error();",
    });
    expect(findSensitiveGateViolations(root, registry).join("\n")).toContain(
      "apps/agent-service/src/new-tool.ts: 新增了整段拦下的调用（containsToolOutputSecret）",
    );
  });

  it("fails when a registered file adds another blocking call", () => {
    const root = gateFixture({
      "packages/application/src/services/model-egress.ts":
        "assertMachineSecretFree(text); scanMachineSecrets(text);",
    });
    expect(findSensitiveGateViolations(root, registry).join("\n")).toContain(
      "packages/application/src/services/model-egress.ts: 整段拦下的调用和登记不一致",
    );
  });

  it("fails when a registered call is gone but the registry still lists it", () => {
    const root = gateFixture({
      "packages/application/src/services/model-egress.ts": "redactForEgress(text);",
    });
    expect(findSensitiveGateViolations(root, registry).join("\n")).toContain(
      "packages/application/src/services/model-egress.ts: 登记里还有它，但已经没有整段拦下的调用了",
    );
  });
});
