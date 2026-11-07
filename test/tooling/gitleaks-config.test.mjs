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

const FIXTURES = {
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
  "test/fixtures/digest-map.json": `{\n  "packages/application/src/ports/recent-authentication.ts": "${hex("digest-4")}"\n}\n`,
};

const EXPECTED_WITH_REPOSITORY_CONFIG = [
  `${REVIEWS}/round-2/deepseek-v4.1-flash.md generic-api-key`,
  `${EVIDENCE}/api.json generic-api-key`,
  "apps/agent-service/test/other-push.unit.test.ts generic-api-key",
  `${EVIDENCE}/mixed.json generic-api-key`,
  `${EVIDENCE}/token.json github-pat`,
  "test/fixtures/digest-map.json generic-api-key",
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
  ])(
    "fails the check when the allowlist is widened: %s",
    (_name, from, to) => {
      expect(repositoryConfig).toContain(from);
      const findings = scan(repositoryConfig.replace(from, to));
      expect([findings.current, findings.history]).not.toEqual([
        EXPECTED_WITH_REPOSITORY_CONFIG,
        EXPECTED_WITH_REPOSITORY_CONFIG,
      ]);
    },
    120000,
  );
});
