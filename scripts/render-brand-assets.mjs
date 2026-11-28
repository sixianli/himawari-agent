import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  restingGrowth,
  seedCountFor,
  seedsAt,
} from "../apps/control-center/src/components/brand-seeds.ts";

const BACKGROUND = "#1e1d1d";
const LIGHT_NEW_SEED = "#b8741a";
const APP_ICON_DIR = "clients/apple/App/Brand.xcassets";
const MAC_SIZES = [16, 32, 128, 256, 512];
const FAVICON_PATH = "apps/control-center/public/favicon.svg";
const FAVICON_DIAMETER = 16;

function seedCircles({ newSeed, gray = false } = {}) {
  return seedsAt(restingGrowth())
    .filter((seed) => seed.r > 0)
    .map((seed) => {
      const fill = seed.fresh && newSeed ? newSeed : seed.fill;
      return `  <circle cx="${seed.cx}" cy="${seed.cy}" r="${seed.r}" fill="${gray ? grayOf(fill) : fill}"/>`;
    })
    .join("\n");
}

function grayOf(fill) {
  const [r, g, b] = fill.match(/\d+/g).map(Number);
  const level = Math.round(Math.min(255, (0.2126 * r + 0.7152 * g + 0.0722 * b) * 1.25));
  return `rgb(${level},${level},${level})`;
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

function appIconSvg({ background, newSeed, gray = false, scale, mac = false }) {
  const disc = `<g transform="translate(24 24) scale(${scale}) translate(-24 -24)">\n${seedCircles({ newSeed, gray })}\n</g>`;
  if (!mac)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="1024" height="1024"><rect width="48" height="48" fill="${background}"/>${disc}</svg>`;
  const inset = 48 * (100 / 1024);
  const side = 48 * (824 / 1024);
  const radius = 48 * (185.4 / 1024);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="1024" height="1024"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0.45" stdDeviation="0.55" flood-color="#000" flood-opacity="0.3"/></filter><clipPath id="c"><rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}"/></clipPath></defs><rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}" fill="${background}" filter="url(#s)"/><g clip-path="url(#c)">${disc}</g></svg>`;
}

function appIconCatalog() {
  const ios = [
    {
      filename: "ios-light.png",
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    },
    {
      appearances: [{ appearance: "luminosity", value: "dark" }],
      filename: "ios-dark.png",
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    },
    {
      appearances: [{ appearance: "luminosity", value: "tinted" }],
      filename: "ios-tinted.png",
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    },
  ];
  const mac = MAC_SIZES.flatMap((size) =>
    [1, 2].map((factor) => ({
      filename: `mac-${size * factor}.png`,
      idiom: "mac",
      scale: `${factor}x`,
      size: `${size}x${size}`,
    })),
  );
  return {
    "Contents.json": { info: { author: "xcode", version: 1 } },
    "AppIcon.appiconset/Contents.json": {
      images: [...ios, ...mac],
      info: { author: "xcode", version: 1 },
    },
    "WatchAppIcon.appiconset/Contents.json": {
      images: [
        {
          filename: "watch.png",
          idiom: "universal",
          platform: "watchos",
          size: "1024x1024",
        },
      ],
      info: { author: "xcode", version: 1 },
    },
  };
}

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
  for (const [file, json] of Object.entries(appIconCatalog())) {
    mkdirSync(`${APP_ICON_DIR}/${file.split("/").slice(0, -1).join("/")}`, {
      recursive: true,
    });
    writeFileSync(`${APP_ICON_DIR}/${file}`, `${JSON.stringify(json, null, 2)}\n`);
  }
  const icons = `${APP_ICON_DIR}/AppIcon.appiconset`;
  await shoot(
    page,
    appIconSvg({ background: BACKGROUND, scale: 0.78 }),
    1024,
    `${icons}/ios-light.png`,
  );
  await shoot(
    page,
    appIconSvg({ background: BACKGROUND, scale: 0.78 }),
    1024,
    `${icons}/ios-dark.png`,
  );
  await shoot(
    page,
    appIconSvg({ background: "#000000", gray: true, scale: 0.78 }),
    1024,
    `${icons}/ios-tinted.png`,
  );
  const macIcon = appIconSvg({ background: BACKGROUND, scale: 0.62, mac: true });
  for (const size of MAC_SIZES)
    for (const factor of [1, 2])
      await shoot(page, macIcon, size * factor, `${icons}/mac-${size * factor}.png`, true);
  await shoot(
    page,
    appIconSvg({ background: BACKGROUND, scale: 0.86 }),
    1024,
    `${APP_ICON_DIR}/WatchAppIcon.appiconset/watch.png`,
  );
  await browser.close();
}
