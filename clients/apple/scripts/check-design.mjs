import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, generateCss } from "./make-design-tokens.mjs";

const appleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appleRoot, "../..");

export const PAGE_DIRECTORIES = [
  "Sources/HimawariChat",
  "Sources/HimawariShell",
  "Sources/HimawariManage",
  "Sources/HimawariShare",
  "Sources/HimawariMacUI",
  "Sources/HimawariWatchUI",
  "App",
];

export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-12-v2/tokens.json";
export const TOKENS_OUTPUT = "Sources/HimawariDesign/Generated/DesignTokens.swift";
export const WEB_DIRECTORY = "App/SafariExtension/Resources";
export const CSS_OUTPUT = `${WEB_DIRECTORY}/tokens.css`;

const WEB_RULES = [
  {
    code: "web-color-literal",
    files: /\.(?:css|js|html)$/u,
    pattern: /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/iu,
  },
  {
    code: "web-number-literal",
    files: /\.css$/u,
    pattern: /(?<![\w-])(?:[1-9]\d*|0?\.\d+)(?:\.\d+)?(?:px|pt|em|rem)\b/u,
  },
];

export function findWebViolations(source, file) {
  const violations = [];
  source.split("\n").forEach((line, index) => {
    for (const rule of WEB_RULES) {
      if (rule.files.test(file) && rule.pattern.test(line))
        violations.push({ file, line: index + 1, code: rule.code, text: line.trim() });
    }
  });
  return violations;
}

function webFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return webFiles(full);
    return /\.(?:css|js|html)$/u.test(entry) ? [full] : [];
  });
}

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
  const web = path.join(root, WEB_DIRECTORY);
  for (const file of webFiles(web)) {
    if (path.relative(root, file) === CSS_OUTPUT) continue;
    problems.push(...findWebViolations(readFileSync(file, "utf8"), path.relative(root, file)));
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
    if (existsSync(web)) {
      const parsed = JSON.parse(readFileSync(tokens, "utf8"));
      const css = path.join(root, CSS_OUTPUT);
      if (generateCss(parsed) !== (existsSync(css) ? readFileSync(css, "utf8") : ""))
        problems.push({ file: CSS_OUTPUT, line: 0, code: "tokens-stale", text: TOKENS_SOURCE });
    }
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
