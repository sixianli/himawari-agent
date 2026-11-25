import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  downloadArtifact,
  extractArchive,
  loadToolchainLock,
} from "../../scripts/ci/install-tools.mjs";

const repositoryConfig = readFileSync(join(process.cwd(), "ci/rules/gitleaks.toml"), "utf8");
const EVIDENCE = "test/qualification/evidence/workspace-authorization-lifecycle/p0";

const hex = (seed) => createHash("sha256").update(seed).digest("hex");
const githubToken = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const body = [...randomBytes(36)].map((byte) => alphabet[byte % alphabet.length]).join("");
  return ["gh", "p_", body].join("");
};

const SYNTHETIC_TOKEN = ["0123456789abcdef", "0123456789abcdef"].join("");
const CLEAR_KEY = ["sensitive", "interceptions", "clear", "01"].join("-");
const READBACK_DIGEST = [
  "0803b00889e1a37bf2645a12f203d89c",
  "5a695b27538e322db7e962339e6a416a",
].join("");
const REVIEWS = ".agents/reviews/pr-273";
const PUSH_DEVICE = ["F5u42Bd3HyW8Kxk", "Uqo2gRA"].join("");
const PUSH_TEST = "apps/agent-service/test/production-reminder-push.unit.test.ts";
const PUSH_SIBLING = ["F5u42Bd3HyW8Kxk", "Uqo2gRB"].join("");
const PUSH_SIBLING_TEST = `sibling/${PUSH_TEST}`;

const DEEPSEEK_TEST = "packages/platform-node/test/deepseek-web-provider.unit.test.ts";
const DEEPSEEK_SIBLING_TEST = "packages/platform-node/test/other-web-provider.unit.test.ts";
const DEEPSEEK_URL = (value) =>
  `await provider().fetch({ url: "https://user:pw@example.org/a?token=${value}" });\n`;

const REVIEW_316_RECORD = ".agents/reviews/pr-316/round-1/glm-5.3-flash.md";
const REVIEW_316_SIBLING = ".agents/reviews/pr-316/round-2/glm-5.3-flash.md";
const REVIEW_316_SAME_ROUND_OTHER = ".agents/reviews/pr-316/round-1/other.md";
const REVIEW_ALLOWED_RECORDS = [
  ".agents/reviews/pr-312/round-3/judgments.md",
  ".agents/reviews/pr-316/round-1/deepseek-v4.1-flash.md",
  ".agents/reviews/pr-316/round-1/deepseek-v4.1-flash.prompt.md",
  ".agents/reviews/pr-316/round-1/glm-5.3-flash.prompt.md",
  ".agents/reviews/pr-319/round-1/glm-5.3-flash.md",
];
const REVIEW_316_LINE = `- 命中 \`token=${["abcdef", "123456"].join("")}\`\n`;

const REVIEW_274 = ".agents/reviews/pr-274/round-7/deepseek-v4.1-flash.md";
const REVIEW_274_SIBLING = ".agents/reviews/pr-274/round-8/deepseek-v4.1-flash.md";
const REVIEW_274_OTHER_TEXT = ".agents/reviews/pr-274/round-9/deepseek-v4.1-flash.md";
const PEM_BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const PEM_BEGIN_ENCRYPTED = ["-----BEGIN", "ENCRYPTED", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "PRIVATE KEY-----"].join(" ");
const KEY_TAIL_TEST = "apps/agent-service/test/pi-coding-program.unit.test.ts";
const KEY_TAIL = ["MIIEvR2T14", "TAILBODY"].join("");
const KEY_TAIL_OTHER = ["MIIEvR2T14", "TAILBODZ"].join("");
const PADDING = "\u7701\u7565\u8bf4\u660e".repeat(20);
const REVIEW_274_PROSE = `1. ${PEM_BEGIN} is used ...\`${PADDING}${PEM_END}\n2. \`${PEM_BEGIN_ENCRYPTED}\`\u3001\`DSA PRIVATE KEY\` ${PADDING}${PEM_END}\n`;
const keyTailLine = (tail) =>
  `["[R2-T14] key tail", \`${tail}\\n\${["-----END", "PRIVATE KEY-----\\n"].join(" ")}\`],\n`;

const TOKENIZER_DIGEST = [
  "aeb13307a71acd8fe81861d94ad54ab6",
  "89df773318809eed3cbe794b4492dae4",
].join("");
const TOKENIZER_DIGEST_LINE = (digest) => `            "tokenizer.json": "${digest}",\n`;

const VAULT_FIXTURE = "clients/apple/Tests/HimawariCoreTests/Fixtures/vault-contract.json";
const VAULT_SIBLING = "clients/apple/Tests/HimawariCoreTests/Fixtures/other-contract.json";
const VAULT_WRAPPED_KEY = [
  "OJcMhbm3WDiSpM1vIJuD1qnNNVIJ0hTf75YUIS9f",
  "/c6Qo98Y9w4CnxSW0UGHkewWlVHlFpwsGvui/nsG",
].join("");
const VAULT_PASSWORD = ["tByJMmanrteJYrzRyAz6eC7I+9mY5n5X", "MjMmS01n940gxxayiFeZE/6q"].join("");
const VAULT_LINE = `    {\n      "wrappedKey": "${VAULT_WRAPPED_KEY}",\n      "password": "${VAULT_PASSWORD}"\n    }\n`;

const FIXTURES = {
  [REVIEW_316_RECORD]: REVIEW_316_LINE,
  [REVIEW_316_SIBLING]: REVIEW_316_LINE,
  [REVIEW_316_SAME_ROUND_OTHER]: REVIEW_316_LINE,
  ...Object.fromEntries(REVIEW_ALLOWED_RECORDS.map((path) => [path, REVIEW_316_LINE])),
  [DEEPSEEK_TEST]: DEEPSEEK_URL("abcdef123456"),
  [DEEPSEEK_SIBLING_TEST]: DEEPSEEK_URL("abcdef123456"),
  "packages/platform-node/test/other-value.unit.test.ts": DEEPSEEK_URL("abcdef123457"),
  [REVIEW_274]: REVIEW_274_PROSE,
  [REVIEW_274_SIBLING]: REVIEW_274_PROSE,
  [REVIEW_274_OTHER_TEXT]: `${PEM_BEGIN} followed by ${PADDING}${PEM_END}\n`,
  [KEY_TAIL_TEST]: keyTailLine(KEY_TAIL),
  "apps/agent-service/test/other-key-tail.unit.test.ts": keyTailLine(KEY_TAIL),
  "apps/agent-service/test/key-tail-variant.unit.test.ts": keyTailLine(KEY_TAIL_OTHER),
  [`${REVIEWS}/round-4/deepseek-v4.1-flash.md`]: `- blame → \`tokenValue: "${SYNTHETIC_TOKEN}"\`\n`,
  [`${REVIEWS}/round-2/deepseek-v4.1-flash.md`]: `- blame → \`tokenValue: "${SYNTHETIC_TOKEN}"\`\n`,
  "apps/agent-service/test/production-http-composition.unit.test.ts": `const headers = {\n  "idempotency-key": "${CLEAR_KEY}",\n};\n`,
  "test/tooling/gitleaks-allowlist.test.mjs": `const line = \`p4-save-secrets-final.log": "${READBACK_DIGEST}"\`;\n`,
  [`${EVIDENCE}/input-freeze.json`]: `{\n  "packages/application/src/ports/recent-authentication.ts": "${hex("digest-1")}",\n  "packages/application/src/ports/auth-session.ts": "${hex("digest-2")}"\n}\n`,
  [`${EVIDENCE}/token.json`]: `{\n  "token": "${githubToken()}"\n}\n`,
  [`${EVIDENCE}/api.json`]: `{\n  "apiKey": "${hex("api-key")}"\n}\n`,
  [`${EVIDENCE}/mixed.json`]: `{"packages/a/auth.ts": "${hex("digest-3")}", "apiKey": "${hex("api-key-2")}"}\n`,
  [PUSH_TEST]: `const SECRET = JSON.stringify({ deviceKey: "${PUSH_DEVICE}", encryptionKey: KEY });\nexpect(url).toBe("https://api.day.app/${PUSH_DEVICE}");\n`,
  "apps/agent-service/test/other-push.unit.test.ts": `const SECRET = JSON.stringify({ deviceKey: "${PUSH_DEVICE}", encryptionKey: KEY });\n`,
  [PUSH_SIBLING_TEST]: `const SECRET = JSON.stringify({ deviceKey: "${PUSH_SIBLING}", encryptionKey: KEY });\n`,
  "test/fixtures/digest-map.json": `{\n  "packages/application/src/ports/recent-authentication.ts": "${hex("digest-4")}"\n}\n`,
  "scripts/embedding-models/build-artifact.py": TOKENIZER_DIGEST_LINE(TOKENIZER_DIGEST),
  "scripts/embedding-models/other-artifact.py": TOKENIZER_DIGEST_LINE(TOKENIZER_DIGEST),
  "scripts/embedding-models/build-artifact-copy.py": TOKENIZER_DIGEST_LINE(TOKENIZER_DIGEST),
  [VAULT_FIXTURE]: VAULT_LINE,
  [VAULT_SIBLING]: VAULT_LINE,
};

const EXPECTED_WITH_REPOSITORY_CONFIG = [
  `${REVIEW_316_SIBLING} generic-api-key`,
  `${REVIEW_316_SAME_ROUND_OTHER} generic-api-key`,
  `${DEEPSEEK_SIBLING_TEST} generic-api-key`,
  "packages/platform-node/test/other-value.unit.test.ts generic-api-key",
  `${REVIEW_274_SIBLING} private-key`,
  `${REVIEW_274_OTHER_TEXT} private-key`,
  "apps/agent-service/test/other-key-tail.unit.test.ts generic-api-key",
  "apps/agent-service/test/key-tail-variant.unit.test.ts generic-api-key",
  `${REVIEWS}/round-2/deepseek-v4.1-flash.md generic-api-key`,
  `${EVIDENCE}/api.json generic-api-key`,
  "apps/agent-service/test/other-push.unit.test.ts generic-api-key",
  `${PUSH_SIBLING_TEST} generic-api-key`,
  `${EVIDENCE}/mixed.json generic-api-key`,
  `${EVIDENCE}/token.json github-pat`,
  "test/fixtures/digest-map.json generic-api-key",
  "scripts/embedding-models/other-artifact.py generic-api-key",
  "scripts/embedding-models/build-artifact-copy.py generic-api-key",
  `${VAULT_SIBLING} generic-api-key`,
].sort();

function gitleaksOnPath(version) {
  const probe = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === version ? "gitleaks" : undefined;
}

async function lockedGitleaks() {
  const tool = loadToolchainLock().tools.gitleaks;
  const installed = gitleaksOnPath(tool.version);
  if (installed) return installed;
  const expected = tool.artifacts[`${process.platform}-${process.arch}`];
  const prefix = join(homedir(), ".cache", `himawari-gitleaks-${tool.version}`);
  const binary = join(prefix, "gitleaks");
  if (!existsSync(binary))
    extractArchive(await downloadArtifact(expected, join(prefix, "downloads")), prefix);
  return binary;
}

let binary;
let root;
let repository;

beforeAll(async () => {
  binary = await lockedGitleaks();
  root = mkdtempSync(join(tmpdir(), "gitleaks-config-"));
  repository = join(root, "repository");
  for (const [path, content] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), content);
  }
  const git = (...args) =>
    execFileSync("git", ["-C", repository, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "pipe",
    });
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
}, 180000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function scan(configText) {
  const scratch = mkdtempSync(join(root, "scan-"));
  const config = join(scratch, "gitleaks.toml");
  writeFileSync(config, configText);
  const common = [
    "--config",
    config,
    "--ignore-gitleaks-allow",
    "--gitleaks-ignore-path",
    join(scratch, "no-gitleaks-ignore"),
    "--no-banner",
    "--no-color",
    "--log-level",
    "error",
    "--report-format",
    "json",
    "--redact=0",
  ];
  const run = (scope, args) => {
    const report = join(scratch, `${scope}.json`);
    const result = spawnSync(
      binary,
      [...args.slice(0, 1), ...common, "--report-path", report, ...args.slice(1)],
      {
        encoding: "utf8",
      },
    );
    expect([0, 1], result.stderr).toContain(result.status);
    return [
      ...new Set(
        JSON.parse(readFileSync(report, "utf8")).map(
          (finding) => `${finding.File.replace(`${repository}/`, "")} ${finding.RuleID}`,
        ),
      ),
    ].sort();
  };
  return {
    current: run("current", ["dir", repository]),
    history: run("history", ["git", "--log-opts", "--full-history --no-ext-diff HEAD", repository]),
  };
}

describe("gitleaks repository configuration", () => {
  it("still reports every fixture with the plain default rules", () => {
    const findings = scan("[extend]\nuseDefault = true\n");
    for (const scope of ["current", "history"])
      expect(findings[scope]).toEqual(
        [
          ...EXPECTED_WITH_REPOSITORY_CONFIG,
          `${EVIDENCE}/input-freeze.json generic-api-key`,
          `${REVIEWS}/round-4/deepseek-v4.1-flash.md generic-api-key`,
          "apps/agent-service/test/production-http-composition.unit.test.ts generic-api-key",
          "test/tooling/gitleaks-allowlist.test.mjs generic-api-key",
          `${PUSH_TEST} generic-api-key`,
          `${DEEPSEEK_TEST} generic-api-key`,
          `${REVIEW_316_RECORD} generic-api-key`,
          ...REVIEW_ALLOWED_RECORDS.map((path) => `${path} generic-api-key`),
          `${REVIEW_274} private-key`,
          `${KEY_TAIL_TEST} generic-api-key`,
          "scripts/embedding-models/build-artifact.py generic-api-key",
          `${VAULT_FIXTURE} generic-api-key`,
        ].sort(),
      );
  }, 120000);

  it("lets only path-to-digest lines in the evidence folder through, in both scan scopes", () => {
    const findings = scan(repositoryConfig);
    expect(findings.current).toEqual(EXPECTED_WITH_REPOSITORY_CONFIG);
    expect(findings.history).toEqual(EXPECTED_WITH_REPOSITORY_CONFIG);
  }, 120000);

  it.each([
    ["condition OR", 'condition = "AND"', 'condition = "OR"'],
    ["no targetRules", 'targetRules = ["generic-api-key"]\n', ""],
    ["no regexTarget", 'regexTarget = "line"\n', ""],
    [
      "any path",
      "'''(?:^|/)test/qualification/evidence/workspace-authorization-lifecycle/'''",
      "'''.*'''",
    ],
    [
      "pr274 any path",
      "'''(?:^|/)\\.agents/reviews/pr-274/round-7/deepseek-v4\\.1-flash\\.md$'''",
      "'''.*'''",
    ],
    [
      "pr274 any text",
      "'''^-----BEGIN PRIVATE KEY----- is used \\.\\.\\.`'''",
      "'''^-----BEGIN [A-Z ]*PRIVATE KEY-----''',",
      [
        "'''(?:^|/)\\.agents/reviews/pr-274/round-7/deepseek-v4\\.1-flash\\.md$'''",
        "'''(?:^|/)\\.agents/reviews/pr-274/'''",
      ],
    ],
    [
      "key tail any path",
      "'''(?:^|/)apps/agent-service/test/pi-coding-program\\.unit\\.test\\.ts$'''",
      "'''(?:^|/)apps/agent-service/test/.*\\.ts$'''",
    ],
    [
      "key tail any value",
      "'''^MIIEvR2T14TAILBODY$'''",
      "'''^MIIEvR2T14TAILBOD[A-Z]$'''",
      [
        "'''(?:^|/)apps/agent-service/test/pi-coding-program\\.unit\\.test\\.ts$'''",
        "'''(?:^|/)apps/agent-service/test/.*\\.ts$'''",
      ],
    ],
    ["push value", "'''^F5u42Bd3HyW8KxkUqo2gRA$'''", "'''^F5u42Bd3HyW8Kxk[A-Za-z0-9_-]{7}$'''"],
    [
      "deepseek any path",
      "'''(?:^|/)packages/platform-node/test/deepseek-web-provider\\.unit\\.test\\.ts$'''",
      "'''(?:^|/)packages/platform-node/test/.*\\.ts$'''",
    ],
    [
      "review record any path",
      "'''(?:^|/)\\.agents/reviews/(?:pr-312/round-3/judgments\\.md|pr-316/round-1/(?:deepseek-v4\\.1-flash|glm-5\\.3-flash)(?:\\.prompt)?\\.md|pr-319/round-1/glm-5\\.3-flash\\.md)$'''",
      "'''(?:^|/)\\.agents/reviews/pr-[0-9]+/round-[0-9]+/[^/]+\\.md$'''",
    ],
    [
      "review record same round any file",
      "'''(?:^|/)\\.agents/reviews/(?:pr-312/round-3/judgments\\.md|pr-316/round-1/(?:deepseek-v4\\.1-flash|glm-5\\.3-flash)(?:\\.prompt)?\\.md|pr-319/round-1/glm-5\\.3-flash\\.md)$'''",
      "'''(?:^|/)\\.agents/reviews/(?:pr-312/round-3/judgments\\.md|pr-316/round-1/[^/]+\\.md|pr-319/round-1/glm-5\\.3-flash\\.md)$'''",
    ],
    [
      "vault fixture any path",
      "'''(?:^|/)clients/apple/Tests/HimawariCoreTests/Fixtures/vault-contract\\.json$'''",
      "'''(?:^|/)clients/apple/Tests/HimawariCoreTests/Fixtures/[^/]+\\.json$'''",
    ],
    [
      "deepseek any value",
      "'''^abcdef123456$'''",
      "'''^abcdef12345[0-9]$'''",
      [
        "'''(?:^|/)packages/platform-node/test/deepseek-web-provider\\.unit\\.test\\.ts$'''",
        "'''(?:^|/)packages/platform-node/test/.*\\.ts$'''",
      ],
    ],
  ])(
    "fails the check when the allowlist is widened: %s",
    (_name, from, to, pathWidening) => {
      expect(repositoryConfig).toContain(from);
      let base = repositoryConfig;
      if (pathWidening) {
        expect(base).toContain(pathWidening[0]);
        base = base.replaceAll(pathWidening[0], () => pathWidening[1]);
      }
      const findings = scan(base.replaceAll(from, () => to));
      expect([findings.current, findings.history]).not.toEqual([
        EXPECTED_WITH_REPOSITORY_CONFIG,
        EXPECTED_WITH_REPOSITORY_CONFIG,
      ]);
      if (pathWidening) {
        const pathOnly = scan(base);
        expect([findings.current, findings.history]).not.toEqual([
          pathOnly.current,
          pathOnly.history,
        ]);
      }
    },
    120000,
  );
});
