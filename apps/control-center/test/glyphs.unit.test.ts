import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Glyph, type GlyphName, glyphLayers } from "../src/components/glyphs.js";

const names = Object.keys(glyphLayers) as GlyphName[];
const withoutBase = new Set<GlyphName>([
  "fork",
  "check",
  "checkTwice",
  "chevron",
  "back",
  "down",
  "close",
  "plus",
  "send",
  "arrowDown",
  "menu",
  "more",
  "stop",
]);

it("[UI-45] every rounded glyph paints its shapes with an inline fill so page CSS cannot hollow it out", () => {
  for (const name of names) {
    const markup = renderToStaticMarkup(h(Glyph, { name }));
    expect(markup, name).toContain(`data-glyph="${name}"`);
    expect(markup, name).toContain('viewBox="0 0 24 24"');
    for (const [, tone, style] of markup.matchAll(/data-tone="(\w+)" style="([^"]*)"/g)) {
      expect(style, `${name} ${tone}`).toContain("fill:currentColor");
    }
  }
});

it("[UI-45] every glyph has a soft base shape unless it is a small inline mark", () => {
  const missing = names.filter((name) => !glyphLayers[name].some((layer) => layer.tone === "base"));
  expect(new Set(missing)).toEqual(withoutBase);
  for (const name of names) {
    expect(
      glyphLayers[name].some((layer) => layer.tone !== "base"),
      `${name} needs a solid or line detail`,
    ).toBe(true);
  }
});
