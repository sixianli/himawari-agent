import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HimawariBrand, sunflowerSeeds } from "../src/components/brand.js";

it("[UI-2] draws the sunflower disc as 96 seeds in twelve rings without any image file", () => {
  const markup = renderToStaticMarkup(createElement(HimawariBrand, { wordmark: true }));
  expect(markup.match(/<circle /g)).toHaveLength(96);
  expect(markup).not.toContain("<img");
  expect(markup).toContain('class="himawari-mark"');
  expect(markup).toContain('<span class="himawari-wordmark-latin">Himawari</span>');
  expect(markup).toContain('<span class="himawari-wordmark-kana" lang="ja">ひまわり</span>');
  expect(new Set(sunflowerSeeds.map((seed) => seed.ring))).toEqual(
    new Set(Array.from({ length: 12 }, (_, ring) => ring)),
  );
});

it("[UI-2] marks the disc busy only while an answer is running", () => {
  expect(renderToStaticMarkup(createElement(HimawariBrand, { busy: true }))).toContain(
    'class="himawari-mark is-busy"',
  );
  expect(renderToStaticMarkup(createElement(HimawariBrand))).not.toContain("is-busy");
});
