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
  { name: "private key block", pattern: /\/-----BEGIN/u },
  { name: "AWS access key", pattern: /\(\?:AKIA\|ASIA\)/u },
  { name: "GitHub token", pattern: /gh\[opsu\]_|github_pat_\[/u },
  { name: "JWT", pattern: /\\beyJ\[/u },
  { name: "OpenAI key", pattern: /sk-\(\?:proj/u },
  { name: "Chinese identity number", pattern: /\(\?:19\|20\)(?:\\d|\[0-9\])\{2\}\(\?:0\[1-9\]/u },
  { name: "card number run", pattern: /(?:\\d|\[0-9\])\{1[2-6],1[89]\}/u },
  { name: "Luhn checksum", pattern: /function luhn/iu },
  { name: "password keyword", pattern: /\(\?:密码\|/u },
  { name: "verification code keyword", pattern: /\(\?:验证码\|/u },
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

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(?:ts|mts)$/u.test(entry) && !/\.d\.ts$/u.test(entry)) found.push(full);
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
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findEgressViolations();
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  console.log("egress redaction check passed");
}
