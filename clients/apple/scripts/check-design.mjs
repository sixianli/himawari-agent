import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./make-design-tokens.mjs";

const appleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appleRoot, "../..");

export const PAGE_DIRECTORIES = [
  "Sources/HimawariChat",
  "Sources/HimawariShell",
  "Sources/HimawariManage",
  "Sources/HimawariMacUI",
  "Sources/HimawariWatchUI",
  "App",
];

export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-12-v2/tokens.json";
export const TOKENS_OUTPUT = "Sources/HimawariDesign/Generated/DesignTokens.swift";

const RULES = [
  {
    code: "color-literal",
    pattern:
      /#colorLiteral|\b(?:UIColor|NSColor)\s*\.\w|\b(?:Color|UIColor|NSColor)\s*(?:\.(?:white|black|red|green|blue|yellow|orange|gray|grey|pink|purple|brown|cyan|mint|indigo|teal)\b|\(\s*(?:\.sRGB|\.displayP3|red:|white:|hue:|displayP3|hex|"#))|\b(?:foregroundStyle|foregroundColor|background|fill|stroke|strokeBorder|tint)\(\s*\.(?:white|black|red|green|blue|yellow|orange|gray|grey|pink|purple|brown|cyan|mint|indigo|teal)\b/u,
  },
  {
    code: "direct-haptics",
    pattern:
      /\b(?:UIImpactFeedbackGenerator|UINotificationFeedbackGenerator|UISelectionFeedbackGenerator|CHHapticEngine|WKInterfaceDevice|sensoryFeedback)\b/u,
  },
  {
    code: "number-literal",
    pattern:
      /\b(?:size|cornerRadius|width|height|minWidth|minHeight|maxWidth|maxHeight|idealWidth|idealHeight|lineSpacing|fontSize|radius)\s*:\s*-?\d|\.(?:lineSpacing|cornerRadius|opacity|kerning|tracking)\(\s*-?\d/u,
  },
];

export function findViolations(source, file) {
  const violations = [];
  source.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line))
        violations.push({ file, line: index + 1, code: rule.code, text: line.trim() });
    }
  });
  return violations;
}

function swiftFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return swiftFiles(full);
    return entry.endsWith(".swift") ? [full] : [];
  });
}

export function checkDesign(root = appleRoot, repo = repositoryRoot) {
  const problems = [];
  for (const directory of PAGE_DIRECTORIES) {
    for (const file of swiftFiles(path.join(root, directory))) {
      problems.push(...findViolations(readFileSync(file, "utf8"), path.relative(root, file)));
    }
  }
  const tokens = path.join(repo, TOKENS_SOURCE);
  const output = path.join(root, TOKENS_OUTPUT);
  let tokensChecked = false;
  if (existsSync(tokens)) {
    tokensChecked = true;
    const expected = generate(JSON.parse(readFileSync(tokens, "utf8")));
    const actual = existsSync(output) ? readFileSync(output, "utf8") : "";
    if (expected !== actual)
      problems.push({ file: TOKENS_OUTPUT, line: 0, code: "tokens-stale", text: TOKENS_SOURCE });
  }
  return { problems, tokensChecked };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, tokensChecked } = checkDesign();
  for (const problem of problems) {
    process.stdout.write(
      `APPLE_DESIGN_VIOLATION ${problem.code} ${problem.file}:${problem.line} ${problem.text}\n`,
    );
  }
  if (problems.length) {
    process.stdout.write(
      "APPLE_DESIGN_FAILED page code must use DesignTokens or Layout for colors and sizes; regenerate tokens with clients/apple/scripts/make-design-tokens.mjs\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `APPLE_DESIGN_PASSED tokens=${tokensChecked ? "checked" : "source-not-in-repo"}\n`,
  );
}
