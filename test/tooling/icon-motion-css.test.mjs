import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { glyphLayers } from "../../apps/control-center/src/components/glyphs.tsx";

const source = (name) =>
  readFileSync(join(import.meta.dirname, "../../apps/control-center/src", name), "utf8");
const rounded = source("rounded.css");
const reviewV4 = source("review-v4.css");
const motion = rounded.slice(
  rounded.indexOf("@media (prefers-reduced-motion: no-preference)"),
  rounded.indexOf("@keyframes icon-twist"),
);
const rules = [];
for (const [, selector] of motion.matchAll(/([^{}]*\.is-running \.tool-icon[^{}]*)\{/g)) {
  for (const part of selector.split(",")) {
    const found = part.match(/\[data-glyph="(\w+)"\][^,]*path:nth-of-type\(([^)]+)\)/);
    if (found) rules.push([found[0], found[1], found[2]]);
  }
}
const animationNames = [...motion.matchAll(/animation(?:-name)?:\s*(icon-[\w-]+)/g)].map(
  (match) => match[1],
);

it("[ICON-MOTION-1] every running-icon rule points at a glyph and a path layer that exist", () => {
  expect(rules.length).toBeGreaterThanOrEqual(30);
  for (const [, glyph, index] of rules) {
    const layers = glyphLayers[glyph];
    expect(layers, `glyph ${glyph}`).toBeDefined();
    const position = Number(index.replace(/^n\s*\+\s*/, ""));
    expect(position, `${glyph} nth-of-type(${index})`).toBeLessThanOrEqual(layers.length);
  }
});

it("[ICON-MOTION-2] the old spinning ring around the icon tile and the whole-icon pulse are gone", () => {
  expect(rounded).not.toContain("process-ring-spin");
  expect(rounded).not.toMatch(/\.row-icon::after/);
  expect(reviewV4).not.toContain("process-step-running");
});

it("[ICON-MOTION-3] icon motion only runs when the system allows motion, and a static mark remains otherwise", () => {
  expect(motion.length).toBeGreaterThan(1000);
  expect(rounded).not.toMatch(/animation:[^;]*icon-[^;]*!important/);
  const reduced = rounded.slice(rounded.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reduced).toMatch(/\.is-running \.row-icon \{[^}]*background: color-mix/);
  const unguarded = rounded.replace(motion, "");
  expect(unguarded).not.toMatch(/\.is-running \.tool-icon\[data-glyph/);
});

it("[ICON-MOTION-7] every animation name used by the icon rules has a keyframes block", () => {
  expect(animationNames.length).toBeGreaterThanOrEqual(20);
  for (const name of new Set(animationNames)) {
    expect(rounded, name).toContain(`@keyframes ${name}`);
  }
});
