import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  applyBaseline,
  checkDesign,
  contrastRatio,
  findContrastProblems,
  findFontViolations,
  findViolations,
  findWebViolations,
} from "../../clients/apple/scripts/check-design.mjs";
import {
  generate,
  generateCss,
  parseColor,
} from "../../clients/apple/scripts/make-design-tokens.mjs";

it("rejects color literals in page code", () => {
  for (const line of [
    "Text(a).foregroundStyle(Color(red: 0.1, green: 0.2, blue: 0.3))",
    "Color(.sRGB, red: 1, green: 1, blue: 1)",
    ".background(Color.white)",
    ".foregroundStyle(.red)",
    "UIColor(red: 1, green: 0, blue: 0, alpha: 1)",
    "#colorLiteral(red: 1, green: 0, blue: 0, alpha: 1)",
    "Color(white: 0.2)",
    "NSColor.systemRed",
  ]) {
    expect(findViolations(line, "X.swift").map((v) => v.code)).toEqual(["color-literal"]);
  }
});

it("rejects scattered size numbers in page code", () => {
  for (const line of [
    ".font(.system(size: 17))",
    ".frame(width: 46, height: 46)",
    "RoundedRectangle(cornerRadius: 26)",
    ".frame(minHeight: 44)",
    ".lineSpacing(8)",
    ".cornerRadius(26)",
    ".opacity(0.5)",
    ".kerning(0.4)",
    ".frame(idealWidth: 120)",
  ]) {
    expect(findViolations(line, "X.swift").length).toBeGreaterThan(0);
  }
});

it("rejects direct calls to the system haptics in page code", () => {
  for (const line of [
    "UIImpactFeedbackGenerator(style: .light).impactOccurred()",
    "UINotificationFeedbackGenerator().notificationOccurred(.success)",
    "let engine = try CHHapticEngine()",
    ".sensoryFeedback(.success, trigger: done)",
  ]) {
    expect(findViolations(line, "X.swift").map((v) => v.code)).toEqual(["direct-haptics"]);
  }
  expect(findViolations("Haptics.shared.report(.messageSent)", "X.swift")).toEqual([]);
});

it("rejects plain buttons whose empty space cannot be tapped", () => {
  for (const line of [
    ".buttonStyle(.plain)",
    ".buttonStyle( .plain )",
    ".buttonStyle(PlainButtonStyle())",
    ".buttonStyle(.borderless)",
  ]) {
    expect(findViolations(line, "X.swift").map((v) => v.code)).toEqual(["plain-button"]);
  }
  expect(findViolations(".buttonStyle(.pressable)", "X.swift")).toEqual([]);
});

it("lets only the answer body use the system serif, New York, and still rejects custom fonts there", () => {
  const answer = "Sources/HimawariChat/AnswerFont.swift";
  expect(findFontViolations(".hmType(Self.voice, design: .serif)", answer)).toEqual([]);
  expect(
    findFontViolations(
      '.font(.custom("STSongti-SC-Regular", size: 18, relativeTo: .body))',
      answer,
    ).map((v) => v.code),
  ).toEqual(["custom-font"]);
  expect(
    findFontViolations(
      ".hmType(Self.voice, design: .serif)",
      "Sources/HimawariChat/AnswerText.swift",
    ).map((v) => v.code),
  ).toEqual(["custom-font"]);
});

it("rejects custom and serif fonts so text stays on the system font", () => {
  for (const line of [
    '.font(.custom("STSongti-SC-Regular", size: 18, relativeTo: .body))',
    "Font.custom(name, fixedSize: size)",
    ".font(.system(size: 17, weight: .medium, design: .serif))",
    "system.fontDescriptor.withDesign(.serif)",
    'UIFont(name: "STSongti-SC-Bold", size: 18)',
    "CTFontCreateWithName(name as CFString, 12, nil)",
  ]) {
    expect(findFontViolations(line, "X.swift").map((v) => v.code)).toEqual(["custom-font"]);
  }
  for (const line of [
    ".font(.system(.body, weight: .semibold))",
    ".font(.system(size: 13, weight: .regular, design: .rounded))",
    "decoder.dateDecodingStrategy = .custom(Self.timestamp)",
    "UIFont.systemFont(ofSize: size, weight: .semibold)",
  ]) {
    expect(findFontViolations(line, "X.swift")).toEqual([]);
  }
});

it("accepts token-based code", () => {
  for (const line of [
    ".hmType(DesignTokens.TypeScale.body)",
    ".frame(width: DesignTokens.Size.composerButton, height: DesignTokens.Size.composerButton)",
    "RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous)",
    ".foregroundStyle(Color.hmMuted)",
    ".padding(.horizontal, 20)",
    ".hmLineHeight(DesignTokens.TypeScale.answer.lineHeight)",
    ".opacity(DesignTokens.Opacity.disabled)",
  ]) {
    expect(findViolations(line, "X.swift")).toEqual([]);
  }
});

const readable = (bg, fg) =>
  Object.fromEntries(
    [
      "surface",
      "text",
      "muted",
      "sun",
      "danger",
      "success",
      "glyph",
      "onSpeak",
      "onText",
      "speak",
    ].map((name) => [name, ["surface", "onSpeak", "onText"].includes(name) ? bg : fg]),
  );
const tokens = {
  color: {
    light: { bg: "#fcfcfb", fill: "rgba(37,41,33,0.06)", ...readable("#fcfcfb", "#252921") },
    dark: { bg: "#1e1e1e", fill: "rgba(228,228,225,0.08)", ...readable("#1e1e1e", "#e4e4e1") },
  },
  shadow: { light: { lift: "0 2 10 rgba(0,0,0,0.07)" }, dark: { lift: "0 2 10 rgba(0,0,0,0.35)" } },
  glass: { blur: 22 },
  radius: { card: 28 },
  size: { switch: [52, 32] },
  type: { body: [17, 400, 1.35], title1: [34, 700, 44] },
  icon: { stroke: 1.6 },
  processRow: { gap: 10 },
};

it("generates every token and rejects themes that differ", () => {
  const swift = generate(tokens);
  expect(swift).toContain("public static let bg = PaletteToken(");
  expect(swift).toContain("public static let switchWidth: CGFloat = 52");
  expect(swift).toContain(
    "TypeToken(size: 17, weight: 400, lineHeight: 17 * 1.35, face: .system, tracking: 0)",
  );
  expect(swift).toContain(
    "TypeToken(size: 34, weight: 700, lineHeight: 44, face: .system, tracking: 0)",
  );
  expect(parseColor("rgba(1,2,3,0.5)")).toEqual([1, 2, 3, 0.5]);
  expect(() => generate({ ...tokens, color: { light: { bg: "#000000" }, dark: {} } })).toThrow(
    "DESIGN_TOKEN_THEMES_DIFFER",
  );
  expect(() => parseColor("blue")).toThrow("DESIGN_TOKEN_COLOR_INVALID");
});

it("flattens one nested level and names value ranges by their ends", () => {
  const swift = generate({
    ...tokens,
    avatar: {
      size: 48,
      fill: "color.speak",
      busyGlow: { inset: -14, opacity: [0.45, 0.95], scale: [0.92, 1.14], easing: "ease-in-out" },
    },
    her: { pagePadding: [58, 16, 40] },
    options: { padding: [10, 16] },
  });
  expect(swift).toContain("public enum Avatar {");
  expect(swift).toContain("public static let size: CGFloat = 48");
  expect(swift).toContain("public static let busyGlowInset: CGFloat = -14");
  expect(swift).toContain("public static let busyGlowOpacityMin: CGFloat = 0.45");
  expect(swift).toContain("public static let busyGlowScaleMax: CGFloat = 1.14");
  expect(swift).toContain("public static let pagePaddingBottom: CGFloat = 40");
  expect(swift).toContain("public static let paddingVertical: CGFloat = 10");
  expect(swift).toContain("public static let paddingHorizontal: CGFloat = 16");
  expect(swift).not.toContain("let fill: CGFloat");
  expect(swift).not.toContain("busyGlowEasing");
});

it("fails when page code has a literal and when generated tokens are stale", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "himawari-apple-design-"));
  try {
    const apple = path.join(repo, "clients/apple");
    await mkdir(path.join(apple, "Sources/HimawariChat"), { recursive: true });
    await mkdir(path.join(apple, "Sources/HimawariDesign/Generated"), { recursive: true });
    await mkdir(path.join(repo, "docs/assets/apple-clients/2026-11-25-v4"), { recursive: true });
    await writeFile(
      path.join(repo, "docs/assets/apple-clients/2026-11-25-v4/tokens.json"),
      JSON.stringify(tokens),
    );
    await writeFile(
      path.join(apple, "Sources/HimawariDesign/Generated/DesignTokens.swift"),
      generate(tokens),
    );
    await writeFile(
      path.join(apple, "Sources/HimawariChat/Good.swift"),
      ".hmType(DesignTokens.TypeScale.body)\n",
    );
    expect(checkDesign(apple, repo)).toEqual({ problems: [], tokensChecked: true });

    await writeFile(
      path.join(apple, "Sources/HimawariChat/Bad.swift"),
      ".font(.system(size: 17))\n",
    );
    expect(checkDesign(apple, repo).problems.map((p) => p.code)).toEqual([
      "fixed-font",
      "number-literal",
    ]);

    await rm(path.join(apple, "Sources/HimawariChat/Bad.swift"));
    await writeFile(
      path.join(repo, "docs/assets/apple-clients/2026-11-25-v4/tokens.json"),
      JSON.stringify({ ...tokens, radius: { card: 30 } }),
    );
    expect(checkDesign(apple, repo).problems.map((p) => p.code)).toEqual(["tokens-stale"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("rejects literal colors and sizes in the Safari panel and keeps its token CSS fresh", async () => {
  expect(findWebViolations("color: #fff;", "popup.css").map((v) => v.code)).toEqual([
    "web-color-literal",
  ]);
  expect(
    findWebViolations("el.style.color = 'rgba(0,0,0,1)'", "popup.js").map((v) => v.code),
  ).toEqual(["web-color-literal"]);
  expect(findWebViolations("padding: 14px;", "popup.css").map((v) => v.code)).toEqual([
    "web-number-literal",
  ]);
  expect(findWebViolations("padding: var(--handover-card-padding);", "popup.css")).toEqual([]);
  expect(findWebViolations("margin: 0; flex: 1 1 auto;", "popup.css")).toEqual([]);
  const css = generateCss(tokens);
  expect(css).toContain("--color-bg: rgba(252, 252, 251, 1);");
  expect(css).toContain("--size-switch: 52px 32px;");
  expect(css).toContain("--type-body-line-height: 1.35;");
  expect(css).toContain("--type-title-1-line-height: 44px;");
  expect(css).toMatch(
    /@media \(prefers-color-scheme: dark\) \{\n {2}:root \{\n {4}--color-bg: rgba\(30, 30, 30, 1\);/u,
  );

  const repo = await mkdtemp(path.join(os.tmpdir(), "himawari-apple-web-"));
  try {
    const apple = path.join(repo, "clients/apple");
    const web = path.join(apple, "App/SafariExtension/Resources");
    await mkdir(web, { recursive: true });
    await mkdir(path.join(apple, "Sources/HimawariDesign/Generated"), { recursive: true });
    await mkdir(path.join(repo, "docs/assets/apple-clients/2026-11-25-v4"), { recursive: true });
    await writeFile(
      path.join(repo, "docs/assets/apple-clients/2026-11-25-v4/tokens.json"),
      JSON.stringify(tokens),
    );
    await writeFile(
      path.join(apple, "Sources/HimawariDesign/Generated/DesignTokens.swift"),
      generate(tokens),
    );
    await writeFile(path.join(web, "tokens.css"), css);
    await writeFile(path.join(web, "popup.css"), "body { background: var(--color-bg); }\n");
    expect(checkDesign(apple, repo)).toEqual({ problems: [], tokensChecked: true });
    await writeFile(path.join(web, "tokens.css"), "");
    await writeFile(path.join(web, "popup.css"), "body { background: #fff; }\n");
    expect(
      checkDesign(apple, repo)
        .problems.map((p) => p.code)
        .sort(),
    ).toEqual(["tokens-stale", "web-color-literal"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it("rejects tap and long-press gestures that VoiceOver cannot reach", () => {
  expect(
    findViolations(".contentShape(Rectangle())\n.onTapGesture(perform: open)\n", "X.swift").map(
      (v) => v.code,
    ),
  ).toEqual(["gesture-without-button"]);
  expect(findViolations(".onLongPressGesture { start() }", "X.swift").map((v) => v.code)).toEqual([
    "gesture-without-button",
  ]);
  for (const source of [
    ".onTapGesture(perform: open)\n.accessibilityAction(named: Text(label), open)",
    ".onTapGesture { open() }\n.accessibilityAddTraits(.isButton)",
    ".onTapGesture { focus() }\n.gesture(\n  LongPressGesture()\n    .onEnded { _ in end() }\n)\n.accessibilityHidden(true)",
  ]) {
    expect(findViolations(source, "X.swift")).toEqual([]);
  }
  expect(
    findViolations(
      ".onTapGesture { open() }\n}\nText(a).accessibilityAddTraits(.isButton)",
      "X.swift",
    ).map((v) => v.code),
  ).toEqual(["gesture-without-button"]);
});

it("rejects a hidden system navigation bar, an app-only appearance and fixed font sizes", () => {
  for (const [line, code] of [
    ["toolbar(.hidden, for: .navigationBar)", "hidden-navigation-bar"],
    [".navigationBarHidden(true)", "hidden-navigation-bar"],
    [".toolbarVisibility(.hidden, for: .navigationBar)", "hidden-navigation-bar"],
    [".preferredColorScheme(.dark)", "app-color-scheme"],
    [".font(.system(size: DesignTokens.ProcessRow.fontSize))", "fixed-font"],
  ]) {
    expect(findViolations(line, "X.swift").map((v) => v.code)).toEqual([code]);
  }
  for (const line of [
    ".font(.custom(name, size: DesignTokens.TypeScale.body.size, relativeTo: .body))",
    ".font(.body)",
    ".toolbar(.hidden, for: .tabBar)",
  ]) {
    expect(findViolations(line, "X.swift")).toEqual([]);
  }
});

it("measures text contrast of the approved tokens in light and dark", () => {
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  const palette = {
    bg: "#ffffff",
    surface: "#ffffff",
    text: "#000000",
    muted: "#767676",
    sun: "#000000",
    danger: "#000000",
    success: "#000000",
    glyph: "#000000",
    onSpeak: "#ffffff",
    speak: "#000000",
    onText: "#ffffff",
  };
  expect(findContrastProblems({ color: { light: palette } })).toEqual([]);
  const low = findContrastProblems({ color: { light: { ...palette, muted: "#999999" } } });
  expect(low.map((p) => [p.appearance, p.fg, p.bg])).toEqual([
    ["light", "muted", "bg"],
    ["light", "muted", "surface"],
  ]);
  expect(low[0].ratio).toBeLessThan(4.5);
  expect(
    findContrastProblems({ color: { dark: { ...palette, glyph: "rgba(0,0,0,0.2)" } } }).map(
      (p) => p.fg,
    ),
  ).toEqual(["glyph", "glyph"]);
});

it("lets the baseline hold known debt but never more, and flags entries that went stale", () => {
  const found = [
    { file: "A.swift", line: 1, code: "fixed-font" },
    { file: "A.swift", line: 2, code: "fixed-font" },
    { file: "B.swift", line: 1, code: "fixed-font" },
  ];
  expect(
    applyBaseline(found, [{ file: "A.swift", code: "fixed-font", count: 2, why: "x" }]),
  ).toEqual([found[2]]);
  expect(
    applyBaseline(found, [{ file: "A.swift", code: "fixed-font", count: 1, why: "x" }]).length,
  ).toBe(3);
  expect(
    applyBaseline(found.slice(2), [
      { file: "A.swift", code: "fixed-font", count: 2, why: "x" },
    ]).map((p) => p.code),
  ).toEqual(["fixed-font", "baseline-stale"]);
  expect(
    applyBaseline(found.slice(0, 2), [{ file: "A.swift", code: "fixed-font", count: 2 }]).map(
      (p) => p.code,
    ),
  ).toEqual(["baseline-without-reason"]);
});
