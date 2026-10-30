// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  activeGrowers,
  HimawariBrand,
  restingGrowth,
  SEED_COUNTS,
  SunflowerMark,
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

it("[UI-2] draws the resting sunflower from seeds only: 233 in the large mark, 89 in the small one", () => {
  const markup = renderToStaticMarkup(createElement(HimawariBrand, { wordmark: true }));
  expect(markup).not.toContain("<img");
  expect(markup).toContain('class="himawari-mark"');
  expect(markup).toContain('<span class="himawari-wordmark-latin">Himawari</span>');
  expect(markup).toContain('<span class="himawari-wordmark-kana" lang="ja">ひまわり</span>');
  expect(visible(seedsAt("full", restingGrowth("full")))).toHaveLength(SEED_COUNTS.full);
  expect(visible(seedsAt("compact", restingGrowth("compact")))).toHaveLength(SEED_COUNTS.compact);
});

it("[UI-2] places every seed on the golden-angle spiral and grows new seeds from the centre outward", () => {
  const growth = restingGrowth("full") + 0.5;
  const seeds = seedsAt("full", growth);
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
  const later = seedsAt("full", growth + 1);
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
  const reduced = await mount(
    createElement(SunflowerMark, { busy: true, detail: "full", growing: true }),
  );
  expect(activeGrowers()).toBe(0);
  expect(reducedFrames).toHaveLength(0);
  await reduced.unmount();
});
