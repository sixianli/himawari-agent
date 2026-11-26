import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_REDACTION_CALLS = Object.freeze([
  {
    file: "packages/runtime-pi/src/pi-runtime-adapter.ts",
    required: "exchange.wrapFetch(options?.fetch ?? globalThis.fetch)",
  },
  { file: "packages/runtime-pi/src/pi-runtime-adapter.ts", required: "restoreModelStream(" },
  { file: "packages/runtime-pi/src/pi-model-transport.ts", required: "exchange.wrapFetch(" },
  { file: "packages/memory-engine/src/embedding.ts", required: "exchange.wrapFetch(" },
]);

export const REDACTOR_ONLY_FILES = Object.freeze([
  "packages/sensitive-capture/src/redaction.ts",
  "packages/sensitive-capture/src/external.ts",
  "packages/sensitive-capture/src/restoration.ts",
  "packages/sensitive-capture/src/identifiers.ts",
  "packages/application/src/services/model-egress.ts",
  "packages/application/src/services/perception-extraction.ts",
  "packages/platform-node/src/files/pi-output-export.ts",
  "apps/agent-service/src/export-masking.ts",
]);

export const SENSITIVE_RULE_PACKAGE = "packages/sensitive-capture/src/";

export const SENSITIVE_RULE_SIGNATURES = Object.freeze([
  { name: "private key block", pattern: /-----BEGIN/u },
  { name: "AWS access key", pattern: /AKIA\|ASIA|AKIA\[/u },
  { name: "GitHub token", pattern: /gh\[[a-z]+\]_|ghp_\[|github_pat_\[/u },
  { name: "JWT", pattern: /eyJ\[/u },
  { name: "OpenAI key", pattern: /sk-\[|sk-\(/u },
  { name: "Bearer token", pattern: /Bearer\\s/u },
  { name: "credential assignment", pattern: /api\[[^\]]*\]\??key|access\[[^\]]*\]\??token/iu },
  {
    name: "password or code keyword",
    pattern:
      /(?:^|[|(/:])(?:password|passwd|密码|口令|验证码|身份证|银行卡|卡号)\||\|(?:password|passwd|密码|口令|验证码)\b/imu,
  },
  {
    name: "Chinese identity number",
    pattern: /\(\?:19\|20\)(?:\\d|\[0-9\])\{2\}\(\?:0\[1-9\]/u,
  },
  { name: "card number run", pattern: /\{1[2-6],1[89]\}|\{1[2-9],\}/u },
  { name: "Luhn checksum", pattern: /\bluhn/iu },
  {
    name: "sensitive key list",
    pattern: /["'](?:clientsecret|accesstoken|refreshtoken|privatekey)["']/u,
  },
]);

export const EGRESS_PATTERNS = Object.freeze([
  { name: "model stream call", pattern: /\bmodelRuntime\.stream\(/u },
  { name: "embeddings request", pattern: /\/embeddings`|\/embeddings["']/u },
  { name: "chat completions request", pattern: /\/chat\/completions["'`]/u },
]);

export const ALLOWED_EGRESS_FILES = Object.freeze(
  new Map([
    ["packages/runtime-pi/src/pi-model-transport.ts", ["model stream call"]],
    ["packages/memory-engine/src/embedding.ts", ["embeddings request"]],
    ["packages/platform-node/src/local-onnx-embedding.ts", ["embeddings request"]],
    [
      "packages/application/src/services/model-egress.ts",
      ["embeddings request", "chat completions request"],
    ],
  ]),
);

export const EXTERNAL_EGRESS_PATTERNS = Object.freeze([
  { name: "TypeSafe review request", pattern: /\/v1\/systemone/u },
  { name: "AI Gateway decision request", pattern: /\/decisions[`"']/u },
  { name: "Exa MCP request", pattern: /https:\/\/mcp\.exa\.ai\/mcp/u },
  { name: "DeepSeek web tool request", pattern: /\/v1\/tools\/(?:search|fetch)/u },
  { name: "DashScope speech request", pattern: /multimodal-generation\/generation/u },
]);

export const ALLOWED_EXTERNAL_EGRESS_FILES = Object.freeze(
  new Map([
    ["packages/platform-node/src/typesafe-jev-transport.ts", ["TypeSafe review request"]],
    ["packages/platform-node/src/exa-public-search.ts", ["Exa MCP request"]],
    ["packages/platform-node/src/deepseek-web-provider.ts", ["DeepSeek web tool request"]],
    ["packages/platform-node/src/speech-synthesis.ts", ["DashScope speech request"]],
    [
      "packages/platform-node/src/memory-import-duplicate-decision.ts",
      ["AI Gateway decision request"],
    ],
    ["packages/platform-node/src/owner-intent-decision.ts", ["AI Gateway decision request"]],
  ]),
);

export const EXTERNAL_REDACTION_FUNCTIONS = Object.freeze([
  "redactForExternalText",
  "redactForExternalUrl",
]);

export const REQUIRED_EXTERNAL_REDACTION_CALLS = Object.freeze(
  new Map([
    ["packages/platform-node/src/typesafe-jev-transport.ts", ["redactForExternalText"]],
    ["packages/platform-node/src/memory-import-duplicate-decision.ts", ["redactForExternalText"]],
    ["packages/platform-node/src/owner-intent-decision.ts", ["redactForExternalText"]],
    [
      "packages/platform-node/src/exa-public-search.ts",
      ["redactForExternalText", "redactForExternalUrl"],
    ],
    [
      "packages/platform-node/src/deepseek-web-provider.ts",
      ["redactForExternalText", "maskedPublicFetchUrl"],
    ],
    ["packages/platform-node/src/speech-synthesis.ts", ["redactForExternalText"]],
  ]),
);

export const SENSITIVE_GATE_FUNCTIONS = Object.freeze([
  "scanMachineSecrets",
  "containsToolOutputSecret",
  "assertMachineSecretFree",
  "containsRestrictedIdentifier",
]);

const KEEP = "保留";
const MASK = "改成发往外部时遮值";
const PASS = "改成原样放行";

export const SENSITIVE_GATE_CALLS = Object.freeze([
  {
    file: "packages/application/src/services/model-egress.ts",
    calls: { assertMachineSecretFree: 1, scanMachineSecrets: 1 },
    decision: KEEP,
    reason: "遮完之后的自检：遮盖出 bug、仍有密钥时不发；数据网址里认出密钥时改按文字遮",
  },
  {
    file: "packages/platform-node/src/trusted-model-provider.ts",
    calls: { assertMachineSecretFree: 1 },
    decision: KEEP,
    reason: "只检查请求里的编号和引用，不含正文",
  },
  {
    file: "packages/platform-node/src/strict-configuration.ts",
    calls: { assertMachineSecretFree: 1 },
    decision: KEEP,
    reason: "配置文件只许放密钥引用，密钥放钥匙串",
  },
  {
    file: "packages/platform-node/src/export-text-policy.ts",
    calls: { containsRestrictedIdentifier: 1 },
    decision: KEEP,
    reason:
      "数据导出：含机密的整段文字不进明文文件；正文原文只放进加密封存文件，明文层放遮盖后的文字或占位符；短文字（名称、编号）只留编号占位",
  },
  {
    file: "apps/agent-service/src/production-mcp-sync.ts",
    calls: { scanMachineSecrets: 1 },
    decision: KEEP,
    reason:
      "不是发给模型的出口：其他 agent 经 MCP 批量同步的记忆和项目笔记正文里有令牌、私钥这类机器密钥时，这一条拒收，密钥不该当成记忆存下（ADR 0228 决定 3）",
  },
  {
    file: "apps/agent-service/src/production-mcp-memory-writer.ts",
    calls: { scanMachineSecrets: 1 },
    decision: KEEP,
    reason:
      "不是发给模型的出口：其他 agent 经 MCP 提议的记忆正文里有令牌、私钥这类机器密钥时拒收，密钥不该当成记忆存下（ADR 0228 决定 3）",
  },
  {
    file: "apps/agent-service/src/production-memory-control.ts",
    calls: { containsRestrictedIdentifier: 1 },
    decision: KEEP,
    reason:
      "不是发给模型的出口：导入预览里像密码、证件号的条目只标成“默认不导入”、按机密级别存引用、不交给分类模型；用户仍可以手动勾选导入，不整段拒收",
  },
  {
    file: "packages/platform-node/src/files/pi-output-export.ts",
    calls: { containsToolOutputSecret: 1 },
    decision: MASK,
    reason: "完整输出先遮文字再 base64 编码",
  },
]);

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(entry) && !/\.d\.ts$/u.test(entry))
      found.push(full);
  }
  return found;
}

export function findEgressViolations(root = repositoryRoot) {
  const violations = [];
  for (const file of ALLOWED_EXTERNAL_EGRESS_FILES.keys())
    if (!REQUIRED_EXTERNAL_REDACTION_CALLS.get(file)?.length)
      violations.push(
        `${file}: 登记的外部出口要在 REQUIRED_EXTERNAL_REDACTION_CALLS 里写明发出前调用哪个遮盖函数（${EXTERNAL_REDACTION_FUNCTIONS.join("、")}）`,
      );
  for (const { file, required } of REQUIRED_REDACTION_CALLS) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (!text.includes(required))
      violations.push(`${file}: 送模型前必须经过脱敏，缺少 ${required}`);
  }
  for (const base of ["packages", "apps"]) {
    for (const full of sourceFiles(path.join(root, base))) {
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!relative.includes("/src/")) continue;
      const text = readFileSync(full, "utf8");
      if (!relative.startsWith(SENSITIVE_RULE_PACKAGE))
        for (const { name, pattern } of SENSITIVE_RULE_SIGNATURES)
          if (pattern.test(text))
            violations.push(
              `${relative}: 敏感信息识别规则（${name}）只能写在 ${SENSITIVE_RULE_PACKAGE}，请改为调用 @himawari-agent/sensitive-capture`,
            );
      if (/\bredactForEgress\(/u.test(text) && !REDACTOR_ONLY_FILES.includes(relative))
        violations.push(
          `${relative}: 只有出口模块能直接调用 redactForEgress，请改走 ModelEgress（packages/application/src/services/model-egress.ts）`,
        );
      for (const { name, pattern } of EGRESS_PATTERNS) {
        if (!pattern.test(text)) continue;
        if (ALLOWED_EGRESS_FILES.get(relative)?.includes(name)) continue;
        violations.push(
          `${relative}: 出现了没有登记的送模型出口（${name}），请接入脱敏器并登记到 scripts/check-egress-redaction.mjs`,
        );
      }
      for (const { name, pattern } of EXTERNAL_EGRESS_PATTERNS) {
        if (!pattern.test(text)) continue;
        if (ALLOWED_EXTERNAL_EGRESS_FILES.get(relative)?.includes(name)) {
          for (const required of REQUIRED_EXTERNAL_REDACTION_CALLS.get(relative) ?? [])
            if (!new RegExp(`\\b${required}\\(`, "u").test(text))
              violations.push(
                `${relative}: 发往外部服务（${name}）前要先遮敏感值，缺少 ${required}(…) 调用`,
              );
          continue;
        }
        violations.push(
          `${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
        );
      }
    }
  }
  return violations;
}

const GATE_NAMES = SENSITIVE_GATE_FUNCTIONS.join("|");
const GATE_CALL = new RegExp(`\\b(${GATE_NAMES})\\s*(?:\\?\\.\\s*)?\\(`, "gu");
const GATE_ALIAS = new RegExp(
  `\\b(?:import|export)\\s*(?:type\\s+)?\\{[^}]*\\b(${GATE_NAMES})\\s+as\\s+[A-Za-z_$][\\w$]*`,
  "gu",
);
const GATE_DECISIONS = new Set([KEEP, MASK, PASS]);

function gateCallCounts(text) {
  const counts = {};
  for (const match of text.matchAll(GATE_CALL)) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  return counts;
}

function gateCalls(entry) {
  return entry.calls !== null && typeof entry.calls === "object" ? entry.calls : {};
}

function registryViolations(registry) {
  const violations = [];
  const files = new Set();
  for (const entry of registry) {
    if (typeof entry.file !== "string" || entry.file === "")
      violations.push("SENSITIVE_GATE_CALLS 每一行都要写文件路径");
    else if (files.has(entry.file))
      violations.push(`${entry.file}: SENSITIVE_GATE_CALLS 里重复登记了这个文件`);
    else files.add(entry.file);
    if (!GATE_DECISIONS.has(entry.decision))
      violations.push(
        `${entry.file}: SENSITIVE_GATE_CALLS 的结论只能是 ${[...GATE_DECISIONS].join("、")}`,
      );
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      violations.push(`${entry.file}: SENSITIVE_GATE_CALLS 要写明理由`);
    const calls = gateCalls(entry);
    const names = Object.keys(calls);
    if (
      names.length === 0 ||
      names.some(
        (name) =>
          !SENSITIVE_GATE_FUNCTIONS.includes(name) ||
          !Number.isInteger(calls[name]) ||
          calls[name] < 1,
      )
    )
      violations.push(`${entry.file}: SENSITIVE_GATE_CALLS 的调用数要写成 { 函数名: 正整数 }`);
  }
  return violations;
}

function sameCounts(left, right) {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const name of names) if ((left[name] ?? 0) !== (right[name] ?? 0)) return false;
  return true;
}

export function findSensitiveGateViolations(
  root = repositoryRoot,
  registry = SENSITIVE_GATE_CALLS,
) {
  const violations = registryViolations(registry);
  const registered = new Map(registry.map((entry) => [entry.file, entry]));
  const seen = new Set();
  for (const base of ["packages", "apps"]) {
    const directory = path.join(root, base);
    if (!existsSync(directory)) continue;
    for (const full of sourceFiles(directory)) {
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!relative.includes("/src/") || relative.startsWith(SENSITIVE_RULE_PACKAGE)) continue;
      const text = readFileSync(full, "utf8");
      for (const match of text.matchAll(GATE_ALIAS))
        violations.push(
          `${relative}: 给整段拦下的函数 ${match[1]} 起了别名，检查会数漏；请直接用原名调用`,
        );
      const counts = gateCallCounts(text);
      if (Object.keys(counts).length === 0) continue;
      seen.add(relative);
      const entry = registered.get(relative);
      if (entry === undefined) {
        violations.push(
          `${relative}: 新增了整段拦下的调用（${Object.keys(counts).join("、")}）。敏感值只在发往外部时遮掉，不整段拦下；确实要保留的，登记到 scripts/check-egress-redaction.mjs 的 SENSITIVE_GATE_CALLS 并写明理由`,
        );
        continue;
      }
      if (!sameCounts(counts, gateCalls(entry)))
        violations.push(
          `${relative}: 整段拦下的调用和登记不一致，实际 ${JSON.stringify(counts)}，登记 ${JSON.stringify(entry.calls)}；请同时更新 SENSITIVE_GATE_CALLS`,
        );
    }
  }
  for (const entry of registry)
    if (!seen.has(entry.file))
      violations.push(
        `${entry.file}: 登记里还有它，但已经没有整段拦下的调用了；请从 SENSITIVE_GATE_CALLS 删掉这一行`,
      );
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = [...findEgressViolations(), ...findSensitiveGateViolations()];
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log("egress redaction check passed");
}
