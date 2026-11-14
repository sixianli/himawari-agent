import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { checkDesign, findViolations } from "../../clients/apple/scripts/check-design.mjs";
import { generate, parseColor } from "../../clients/apple/scripts/make-design-tokens.mjs";

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

const tokens = {
  color: {
    light: { bg: "#fcfcfb", fill: "rgba(37,41,33,0.06)" },
    dark: { bg: "#1e1e1e", fill: "rgba(228,228,225,0.08)" },
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

it("fails when page code has a literal and when generated tokens are stale", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "himawari-apple-design-"));
  try {
    const apple = path.join(repo, "clients/apple");
    await mkdir(path.join(apple, "Sources/HimawariChat"), { recursive: true });
    await mkdir(path.join(apple, "Sources/HimawariDesign/Generated"), { recursive: true });
    await mkdir(path.join(repo, "docs/assets/apple-clients/2026-11-12-v2"), { recursive: true });
    await writeFile(
      path.join(repo, "docs/assets/apple-clients/2026-11-12-v2/tokens.json"),
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
    expect(checkDesign(apple, repo).problems.map((p) => p.code)).toEqual(["number-literal"]);

    await rm(path.join(apple, "Sources/HimawariChat/Bad.swift"));
    await writeFile(
      path.join(repo, "docs/assets/apple-clients/2026-11-12-v2/tokens.json"),
      JSON.stringify({ ...tokens, radius: { card: 30 } }),
    );
    expect(checkDesign(apple, repo).problems.map((p) => p.code)).toEqual(["tokens-stale"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
