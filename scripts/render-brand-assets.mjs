import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  restingGrowth,
  seedCountFor,
  seedsAt,
} from "../apps/control-center/src/components/brand-seeds.ts";

const BACKGROUND = "#1e1d1d";
const LIGHT_NEW_SEED = "#b8741a";
const FAVICON_PATH = "apps/control-center/public/favicon.svg";
const FAVICON_DIAMETER = 16;

function seedCircles() {
  return seedsAt(restingGrowth())
    .filter((seed) => seed.r > 0)
    .map((seed) => `  <circle cx="${seed.cx}" cy="${seed.cy}" r="${seed.r}" fill="${seed.fill}"/>`)
    .join("\n");
}

export function sunflowerSvg({ background, scale = 1 } = {}) {
  const transform =
    scale === 1 ? "" : ` transform="translate(24 24) scale(${scale}) translate(-24 -24)"`;
  const back = background ? `  <rect width="48" height="48" fill="${background}"/>\n` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="512" height="512">\n  <title>Himawari</title>\n${back}  <g${transform}>\n${seedCircles()}\n  </g>\n</svg>\n`;
}

export function renderBrandSvg() {
  return sunflowerSvg();
}

export function renderFaviconSvg() {
  const seeds = seedCountFor(FAVICON_DIAMETER);
  const circles = seedsAt(restingGrowth(seeds), seeds)
    .filter((seed) => seed.r > 0)
    .map(
      (seed) =>
        `  <circle${seed.fresh ? ' class="n"' : ""} cx="${seed.cx}" cy="${seed.cy}" r="${seed.r}" fill="${seed.fill}"/>`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">\n  <style>@media (prefers-color-scheme: light) { .n { fill: ${LIGHT_NEW_SEED}; } }</style>\n${circles}\n</svg>\n`;
}

export { FAVICON_PATH };

async function shoot(page, svg, size, path, transparent = false) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body>`,
  );
  await page.screenshot({ path, omitBackground: transparent });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  mkdirSync("assets/brand/himawari/v4", { recursive: true });
  writeFileSync("assets/brand/himawari/v4/logo-sunflower-disc.svg", renderBrandSvg());
  writeFileSync(FAVICON_PATH, renderFaviconSvg());
  if (process.argv.includes("--svg-only")) process.exit(0);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  const targets = [
    ["apps/control-center/public/icons/icon-192.png", 192, 1],
    ["apps/control-center/public/icons/icon-512.png", 512, 1],
    ["apps/control-center/public/icons/icon-maskable-512.png", 512, 0.78],
    ["apps/control-center/public/apple-touch-icon.png", 180, 1],
  ];
  for (const [path, size, scale] of targets)
    await shoot(page, sunflowerSvg({ background: BACKGROUND, scale }), size, path);
  await browser.close();
}
