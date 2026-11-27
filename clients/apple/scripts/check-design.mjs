import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, generateCss, parseColor } from "./make-design-tokens.mjs";

const appleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(appleRoot, "../..");

export const PAGE_DIRECTORIES = [
  "Sources/HimawariChat",
  "Sources/HimawariShell",
  "Sources/HimawariManage",
  "Sources/HimawariSenses",
  "Sources/HimawariShare",
  "Sources/HimawariActions",
  "Sources/HimawariListen",
  "Sources/HimawariListenUI",
  "Sources/HimawariMacUI",
  "Sources/HimawariWatchUI",
  "App",
];

export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-25-v4/tokens.json";
export const TOKENS_OUTPUT = "Sources/HimawariDesign/Generated/DesignTokens.swift";
export const WEB_DIRECTORY = "App/SafariExtension/Resources";
export const CSS_OUTPUT = `${WEB_DIRECTORY}/tokens.css`;
export const BASELINE = "scripts/design-baseline.json";

export const TEXT_CONTRAST = {
  minimum: 4.5,
  foregrounds: ["text", "muted", "sun", "danger", "success", "glyph"],
  backgrounds: ["bg", "surface"],
  pairs: [
    ["onSpeak", "speak"],
    ["onText", "text"],
  ],
};

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
    code: "plain-button",
    pattern:
      /\.buttonStyle\(\s*\.plain\s*\)|\bPlainButtonStyle\(\)|\.buttonStyle\(\s*\.borderless\s*\)/u,
  },
  {
    code: "hidden-navigation-bar",
    pattern:
      /\btoolbar\(\s*\.hidden\s*,\s*for:\s*\.navigationBar|\.navigationBarHidden\(\s*true|\btoolbarVisibility\(\s*\.hidden\s*,\s*for:\s*\.navigationBar/u,
  },
  {
    code: "app-color-scheme",
    pattern: /\.preferredColorScheme\(/u,
  },
  {
    code: "fixed-font",
    pattern: /\.font\(\s*\.system\(\s*size:/u,
  },
  {
    code: "screen-height-lock",
    pattern: /\.containerRelativeFrame\(\s*(?:\.vertical|\[[^\]]*\.vertical)/u,
  },
  {
    code: "number-literal",
    pattern:
      /\b(?:size|cornerRadius|width|height|minWidth|minHeight|maxWidth|maxHeight|idealWidth|idealHeight|lineSpacing|fontSize|radius)\s*:\s*-?\d|\.(?:lineSpacing|cornerRadius|opacity|kerning|tracking)\(\s*-?\d/u,
  },
];

const GESTURE = /\.on(?:Tap|LongPress)Gesture\b/u;
const GESTURE_ALTERNATIVE =
  /\.accessibilityAction\b|\.accessibilityAddTraits\(\s*\.(?:isButton|isLink)\b|\.accessibilityHidden\(\s*true\s*\)/u;

function modifierChain(lines, start) {
  let depth = 0;
  let text = "";
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && depth === 0 && !line.trim().startsWith(".")) break;
    text += `${line}\n`;
    for (const character of line) {
      if (character === "(" || character === "{" || character === "[") depth += 1;
      if (character === ")" || character === "}" || character === "]") depth -= 1;
    }
    if (depth < 0) break;
  }
  return text;
}

export const FONT_DIRECTORIES = ["Sources", "App"];

const FONT_RULE = {
  code: "custom-font",
  pattern:
    /(?:Font)?\.custom\([^)]*\b(?:size|fixedSize):|design:\s*\.serif\b|\.withDesign\(\s*\.serif\s*\)|\b(?:UIFont|NSFont)\(\s*name:|\bCTFontCreateWithName\b/u,
};

const PRONOUN_DIRECTORIES = ["Sources", "App"];
const PRONOUN_FILE = /\.(?:swift|strings|plist)$/u;
const PRONOUN_HAN = /她|彼女/u;
const PRONOUN_LITERAL = /"(?:[^"\\\n]|\\.)*"/gu;
const PRONOUN_ENGLISH = /\b(?:[Ss]he|[Hh]er|[Hh]ers|[Hh]erself)\b/u;

export function findPronounViolations(source, file) {
  const violations = [];
  source.split("\n").forEach((line, index) => {
    const prose = (line.match(PRONOUN_LITERAL) ?? []).filter((text) => /\s/u.test(text));
    if (PRONOUN_HAN.test(line) || prose.some((text) => PRONOUN_ENGLISH.test(text)))
      violations.push({ file, line: index + 1, code: "himawari-pronoun", text: line.trim() });
  });
  return violations;
}

function pronounFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return pronounFiles(full);
    return PRONOUN_FILE.test(entry) ? [full] : [];
  });
}

export function findFontViolations(source, file) {
  const violations = [];
  source.split("\n").forEach((line, index) => {
    if (FONT_RULE.pattern.test(line))
      violations.push({ file, line: index + 1, code: FONT_RULE.code, text: line.trim() });
  });
  return violations;
}

export function findViolations(source, file) {
  const violations = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line))
        violations.push({ file, line: index + 1, code: rule.code, text: line.trim() });
    }
    if (GESTURE.test(line) && !GESTURE_ALTERNATIVE.test(modifierChain(lines, index)))
      violations.push({ file, line: index + 1, code: "gesture-without-button", text: line.trim() });
  });
  return violations;
}

function luminance([red, green, blue]) {
  const channel = (value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function over(color, base) {
  const [red, green, blue, alpha = 1] = color;
  return [0, 1, 2].map((index) => [red, green, blue][index] * alpha + base[index] * (1 - alpha));
}

export function contrastRatio(foreground, background) {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

export function findContrastProblems(tokens, rule = TEXT_CONTRAST) {
  const problems = [];
  for (const [appearance, palette] of Object.entries(tokens.color ?? {})) {
    const base = parseColor(palette.bg).slice(0, 3);
    const solid = (name) => over(parseColor(palette[name]), base);
    const pairs = [
      ...rule.foregrounds.flatMap((fg) => rule.backgrounds.map((bg) => [fg, bg])),
      ...rule.pairs,
    ];
    for (const [fg, bg] of pairs) {
      if (palette[fg] === undefined || palette[bg] === undefined) {
        problems.push({ appearance, fg, bg, ratio: 0, missing: true });
        continue;
      }
      const ratio = contrastRatio(solid(fg), solid(bg));
      if (ratio < rule.minimum) problems.push({ appearance, fg, bg, ratio });
    }
  }
  return problems;
}

export function applyBaseline(problems, baseline) {
  const counted = new Map();
  for (const problem of problems) {
    const key = `${problem.file}|${problem.code}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  const allowed = new Map(baseline.map((entry) => [`${entry.file}|${entry.code}`, entry]));
  const remaining = problems.filter((problem) => {
    const entry = allowed.get(`${problem.file}|${problem.code}`);
    return !entry || counted.get(`${problem.file}|${problem.code}`) > entry.count;
  });
  const stale = baseline
    .filter(
      (entry) => !entry.why || (counted.get(`${entry.file}|${entry.code}`) ?? 0) < entry.count,
    )
    .map((entry) => ({
      file: BASELINE,
      line: 0,
      code: entry.why ? "baseline-stale" : "baseline-without-reason",
      text: `${entry.file} ${entry.code} allows ${entry.count}, found ${counted.get(`${entry.file}|${entry.code}`) ?? 0}`,
    }));
  return [...remaining, ...stale];
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
  for (const directory of FONT_DIRECTORIES) {
    for (const file of swiftFiles(path.join(root, directory))) {
      problems.push(...findFontViolations(readFileSync(file, "utf8"), path.relative(root, file)));
    }
  }
  for (const directory of PRONOUN_DIRECTORIES) {
    for (const file of pronounFiles(path.join(root, directory))) {
      problems.push(
        ...findPronounViolations(readFileSync(file, "utf8"), path.relative(root, file)),
      );
    }
  }
  const web = path.join(root, WEB_DIRECTORY);
  for (const file of webFiles(web)) {
    if (path.relative(root, file) === CSS_OUTPUT) continue;
    problems.push(...findWebViolations(readFileSync(file, "utf8"), path.relative(root, file)));
  }
  const baselineFile = path.join(root, BASELINE);
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : [];
  const swiftProblems = applyBaseline(problems.splice(0), baseline);
  problems.push(...swiftProblems);
  const tokens = path.join(repo, TOKENS_SOURCE);
  const output = path.join(root, TOKENS_OUTPUT);
  let tokensChecked = false;
  if (existsSync(tokens)) {
    tokensChecked = true;
    for (const low of findContrastProblems(JSON.parse(readFileSync(tokens, "utf8"))))
      problems.push({
        file: TOKENS_SOURCE,
        line: 0,
        code: low.missing ? "contrast-token-missing" : "text-contrast",
        text: `${low.appearance} ${low.fg} on ${low.bg} ${low.ratio.toFixed(2)}:1 < ${TEXT_CONTRAST.minimum}:1`,
      });
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
      "APPLE_DESIGN_FAILED page code must follow docs/ui-ux-design-guide.md#apple-clients: DesignTokens for colors and sizes, system buttons and navigation, Dynamic Type fonts, an accessible alternative for every gesture; regenerate tokens with clients/apple/scripts/make-design-tokens.mjs\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `APPLE_DESIGN_PASSED tokens=${tokensChecked ? "checked" : "source-not-in-repo"}\n`,
  );
}
