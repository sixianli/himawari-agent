// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  activeGrowers,
  growthRate,
  HimawariBrand,
  restingGrowth,
  SunflowerMark,
  seedCountFor,
  seedsAt,
} from "../src/components/brand.js";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const visible = (seeds: ReturnType<typeof seedsAt>) => seeds.filter((seed) => seed.r > 0);

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function stubMotion(reduce: boolean) {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("reduce"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return frames;
}

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, unmount: () => act(async () => root.unmount()) };
}

it("[UI-2] draws the brand mark as SVG circles with the wordmark beside it", () => {
  const markup = renderToStaticMarkup(createElement(HimawariBrand, { wordmark: true }));
  expect(markup).not.toContain("<img");
  expect(markup).toContain('class="himawari-mark"');
  expect(markup).toContain('<span class="himawari-wordmark-latin">Himawari</span>');
  expect(markup).toContain('<span class="himawari-wordmark-kana" lang="ja">ひまわり</span>');
});

it("[UI-2] uses fewer seeds on small marks and more on large ones, each tier fully drawn at rest", () => {
  expect([24, 28, 38, 48, 56, 58, 72, 120].map(seedCountFor)).toEqual([
    21, 21, 34, 55, 55, 89, 89, 144,
  ]);
  for (const seeds of [21, 34, 55, 89, 144])
    expect(visible(seedsAt(restingGrowth(seeds), seeds))).toHaveLength(seeds);
  const largest = (seeds: number) =>
    Math.max(...visible(seedsAt(restingGrowth(seeds), seeds)).map((seed) => seed.r));
  expect(largest(21)).toBeGreaterThan(largest(144));
});

it("[UI-2] takes the same time to grow a full disc at every size", () => {
  for (const seeds of [21, 34, 55, 89, 144])
    expect(seeds / growthRate(seeds, "busy")).toBeCloseTo(16);
  expect(growthRate(55, "idle")).toBeLessThan(growthRate(55, "busy"));
});

it("[UI-2] picks the seed count from the mark's rendered size", async () => {
  stubMotion(false);
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () => ({ width: 72, height: 72 }) as DOMRect;
  try {
    const { host, unmount } = await mount(createElement(SunflowerMark));
    expect(host.querySelector("svg")?.getAttribute("data-seeds")).toBe("89");
    expect(
      [...host.querySelectorAll("circle")].filter((c) => Number(c.getAttribute("r")) > 0),
    ).toHaveLength(89);
    await unmount();
  } finally {
    Element.prototype.getBoundingClientRect = original;
  }
});

it("[UI-2] places every seed on the golden-angle spiral and grows new seeds from the centre outward", () => {
  const growth = restingGrowth() + 0.5;
  const seeds = seedsAt(growth);
  const newest = Math.floor(growth);
  seeds.forEach((seed, slot) => {
    if (seed.r === 0) return;
    const angle = Math.atan2(seed.cy - 24, seed.cx - 24);
    const expected = Math.atan2(
      Math.sin((newest - slot) * GOLDEN_ANGLE),
      Math.cos((newest - slot) * GOLDEN_ANGLE),
    );
    expect(
      Math.abs(Math.atan2(Math.sin(angle - expected), Math.cos(angle - expected))),
    ).toBeLessThan(0.02);
  });
  const later = seedsAt(growth + 1);
  const distance = (seed: { cx: number; cy: number }) => Math.hypot(seed.cx - 24, seed.cy - 24);
  expect(distance(later[11] as never)).toBeGreaterThan(distance(seeds[10] as never));
});

it("[UI-2] marks the disc busy only while an answer is running", () => {
  expect(renderToStaticMarkup(createElement(HimawariBrand, { busy: true }))).toContain(
    'class="himawari-mark is-busy"',
  );
  expect(renderToStaticMarkup(createElement(HimawariBrand))).not.toContain("is-busy");
});

it("[UI-2] grows the seeds while busy and moves them between frames", async () => {
  const frames = stubMotion(false);
  const { host, unmount } = await mount(createElement(SunflowerMark, { busy: true }));
  expect(activeGrowers()).toBe(1);
  const before = host.querySelector("circle")?.getAttribute("cx");
  await act(async () => {
    frames.shift()?.(1000);
    frames.shift()?.(1040);
  });
  expect(host.querySelector("circle")?.getAttribute("cx")).not.toBe(before);
  await unmount();
  expect(activeGrowers()).toBe(0);
});

it("[UI-2] keeps finished answers, the sidebar and reduced-motion marks completely still", async () => {
  const frames = stubMotion(false);
  const still = await mount(createElement(HimawariBrand, { wordmark: true }));
  expect(activeGrowers()).toBe(0);
  expect(frames).toHaveLength(0);
  await still.unmount();

  const reducedFrames = stubMotion(true);
  const reduced = await mount(createElement(SunflowerMark, { busy: true, growing: true }));
  expect(activeGrowers()).toBe(0);
  expect(reducedFrames).toHaveLength(0);
  await reduced.unmount();
});
