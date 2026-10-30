import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { restingGrowth, seedsAt } from "../apps/control-center/src/components/brand-seeds.ts";

const BACKGROUND = "#1e1d1d";

export function sunflowerSvg({ background, scale = 1 } = {}) {
  const seeds = seedsAt("full", restingGrowth("full")).filter((seed) => seed.r > 0);
  const circles = seeds
    .map((seed) => `  <circle cx="${seed.cx}" cy="${seed.cy}" r="${seed.r}" fill="${seed.fill}"/>`)
    .join("\n");
  const transform =
    scale === 1 ? "" : ` transform="translate(24 24) scale(${scale}) translate(-24 -24)"`;
  const back = background ? `  <rect width="48" height="48" fill="${background}"/>\n` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="512" height="512">\n  <title>Himawari</title>\n${back}  <g${transform}>\n${circles}\n  </g>\n</svg>\n`;
}

export function renderBrandSvg() {
  return sunflowerSvg();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  mkdirSync("assets/brand/himawari/v3", { recursive: true });
  writeFileSync("assets/brand/himawari/v3/logo-sunflower-disc.svg", renderBrandSvg());
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  const targets = [
    ["apps/control-center/public/icons/icon-192.png", 192, 1],
    ["apps/control-center/public/icons/icon-512.png", 512, 1],
    ["apps/control-center/public/icons/icon-maskable-512.png", 512, 0.78],
    ["apps/control-center/public/apple-touch-icon.png", 180, 1],
  ];
  for (const [path, size, scale] of targets) {
    await page.setViewportSize({ width: size, height: size });
    const svg = sunflowerSvg({ background: BACKGROUND, scale }).replace(
      /width="512" height="512"/,
      `width="${size}" height="${size}"`,
    );
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.screenshot({ path });
  }
  await browser.close();
}
