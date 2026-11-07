import { readdirSync, readFileSync, statSync } from "node:fs";
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
  "packages/application/src/services/model-egress.ts",
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
    [
      "packages/application/src/services/model-egress.ts",
      ["embeddings request", "chat completions request"],
    ],
  ]),
);

export const EXTERNAL_EGRESS_PATTERNS = Object.freeze([
  { name: "TypeSafe review request", pattern: /\/v1\/systemone/u },
  { name: "Exa MCP request", pattern: /https:\/\/mcp\.exa\.ai\/mcp/u },
  { name: "DeepSeek web tool request", pattern: /\/v1\/tools\/(?:search|fetch)/u },
]);

export const ALLOWED_EXTERNAL_EGRESS_FILES = Object.freeze(
  new Map([
    ["packages/platform-node/src/typesafe-jev-transport.ts", ["TypeSafe review request"]],
    ["packages/platform-node/src/exa-public-search.ts", ["Exa MCP request"]],
    ["packages/platform-node/src/deepseek-web-provider.ts", ["DeepSeek web tool request"]],
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
    calls: { assertMachineSecretFree: 1 },
    decision: KEEP,
    reason: "遮完之后的自检：遮盖出 bug、仍有密钥时不发",
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
    file: "packages/application/src/services/automatic-memory-service.ts",
    calls: { scanMachineSecrets: 4 },
    decision: MASK,
    reason: "记忆存原文，发给模型时由出口遮盖遮值",
  },
  {
    file: "packages/application/src/services/host-file-read-service.ts",
    calls: { scanMachineSecrets: 1 },
    decision: MASK,
    reason: "读到的文件发给模型时由出口遮盖遮值",
  },
  {
    file: "packages/application/src/services/reflection-service.ts",
    calls: { assertMachineSecretFree: 1 },
    decision: MASK,
    reason: "反思结果存原文",
  },
  {
    file: "packages/application/src/services/thread-checkpoint-service.ts",
    calls: { scanMachineSecrets: 3 },
    decision: MASK,
    reason: "检查点存原文，发给模型时遮值",
  },
  {
    file: "packages/application/src/services/workspace-copy-service.ts",
    calls: { scanMachineSecrets: 1 },
    decision: PASS,
    reason: "复制文件要求字节原样",
  },
  {
    file: "packages/platform-node/src/deepseek-web-provider.ts",
    calls: { scanMachineSecrets: 2 },
    decision: MASK,
    reason: "查询词先遮再发；结果发给模型时由出口遮盖遮值",
  },
  {
    file: "packages/platform-node/src/exa-public-search.ts",
    calls: { scanMachineSecrets: 4 },
    decision: MASK,
    reason: "查询词和网址先遮再发；结果发给模型时由出口遮盖遮值",
  },
  {
    file: "packages/platform-node/src/files/pi-host-publication.ts",
    calls: { containsToolOutputSecret: 2, scanMachineSecrets: 3 },
    decision: MASK,
    reason: "工具结果发给模型时由出口遮盖遮值",
  },
  {
    file: "packages/platform-node/src/files/pi-output-export.ts",
    calls: { containsToolOutputSecret: 1 },
    decision: MASK,
    reason: "完整输出先遮文字再 base64 编码",
  },
  {
    file: "packages/platform-node/src/files/sandboxed-coding-operations.ts",
    calls: { scanMachineSecrets: 1 },
    decision: MASK,
    reason: "读给模型的内容由出口遮盖遮值，编辑用真实内容",
  },
  {
    file: "packages/platform-node/src/typesafe-jev-transport.ts",
    calls: { assertMachineSecretFree: 2 },
    decision: MASK,
    reason: "请求先遮再发；回复存原文",
  },
  {
    file: "packages/runtime-pi/src/host-read-only-executor.ts",
    calls: { assertMachineSecretFree: 1 },
    decision: MASK,
    reason: "读到的文件发给模型时由出口遮盖遮值",
  },
  {
    file: "apps/agent-service/src/capability-programs/host-file-read.ts",
    calls: { scanMachineSecrets: 1 },
    decision: MASK,
    reason: "读到的文件发给模型时由出口遮盖遮值",
  },
  {
    file: "apps/agent-service/src/capability-programs/pi-coding-request.ts",
    calls: { containsToolOutputSecret: 1 },
    decision: MASK,
    reason: "后台命令输出发给模型时由出口遮盖遮值",
  },
  {
    file: "apps/agent-service/src/production-coding-workflow.ts",
    calls: { scanMachineSecrets: 1 },
    decision: MASK,
    reason: "搜索词先遮再发",
  },
  {
    file: "apps/agent-service/src/production-file-preparation.ts",
    calls: { scanMachineSecrets: 1, containsToolOutputSecret: 1 },
    decision: PASS,
    reason: "编辑读真实内容；结果发给模型时由出口遮盖遮值",
  },
  {
    file: "apps/agent-service/src/production-host-read.ts",
    calls: { scanMachineSecrets: 1, containsToolOutputSecret: 1 },
    decision: MASK,
    reason: "读到的内容发给模型时由出口遮盖遮值",
  },
  {
    file: "apps/agent-service/src/production-memory-capture.ts",
    calls: { containsRestrictedIdentifier: 1, scanMachineSecrets: 1 },
    decision: MASK,
    reason: "照常整理记忆，发给模型时遮值",
  },
  {
    file: "apps/agent-service/src/production-memory-control.ts",
    calls: { scanMachineSecrets: 1, containsRestrictedIdentifier: 1 },
    decision: MASK,
    reason: "主人建的记忆存原文",
  },
  {
    file: "apps/agent-service/src/production-muse-intake.ts",
    calls: { scanMachineSecrets: 1, containsRestrictedIdentifier: 2, containsToolOutputSecret: 1 },
    decision: MASK,
    reason: "Muse 条目存原文，只在页面显示",
  },
  {
    file: "apps/agent-service/src/production-reminder-writer.ts",
    calls: { scanMachineSecrets: 1, containsRestrictedIdentifier: 1 },
    decision: MASK,
    reason: "提醒存原文",
  },
  {
    file: "apps/agent-service/src/production-sandbox-control.ts",
    calls: { scanMachineSecrets: 1 },
    decision: MASK,
    reason: "沙箱诊断存原文",
  },
  {
    file: "apps/agent-service/src/production-sandbox-services.ts",
    calls: { scanMachineSecrets: 1 },
    decision: MASK,
    reason: "恢复的工具结果发给模型时由出口遮盖遮值",
  },
  {
    file: "apps/agent-service/src/production-thread-titles.ts",
    calls: { assertMachineSecretFree: 2 },
    decision: MASK,
    reason: "标题提示由出口遮盖遮值，标题存原文",
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
        if (ALLOWED_EXTERNAL_EGRESS_FILES.get(relative)?.includes(name)) continue;
        violations.push(
          `${relative}: 出现了没有登记的外部出口（${name}），发出前要遮敏感值，并登记到 scripts/check-egress-redaction.mjs`,
        );
      }
    }
  }
  return violations;
}

function gateCallCounts(text) {
  const counts = {};
  const pattern = new RegExp(`\\b(${SENSITIVE_GATE_FUNCTIONS.join("|")})\\(`, "gu");
  for (const match of text.matchAll(pattern)) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  return counts;
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
  const violations = [];
  const registered = new Map(registry.map((entry) => [entry.file, entry]));
  const seen = new Set();
  for (const base of ["packages", "apps"]) {
    const directory = path.join(root, base);
    let files = [];
    try {
      files = sourceFiles(directory);
    } catch {
      continue;
    }
    for (const full of files) {
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!relative.includes("/src/") || relative.startsWith(SENSITIVE_RULE_PACKAGE)) continue;
      const counts = gateCallCounts(readFileSync(full, "utf8"));
      if (Object.keys(counts).length === 0) continue;
      seen.add(relative);
      const entry = registered.get(relative);
      if (entry === undefined) {
        violations.push(
          `${relative}: 新增了整段拦下的调用（${Object.keys(counts).join("、")}）。敏感值只在发往外部时遮掉，不整段拦下；确实要保留的，登记到 scripts/check-egress-redaction.mjs 的 SENSITIVE_GATE_CALLS 并写明理由`,
        );
        continue;
      }
      if (!sameCounts(counts, entry.calls))
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
