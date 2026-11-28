import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ICON_SEEDS = 105;
export const APP_ICON_BACKGROUND = "#1e1d1d";
export const SEED_GOLD = [245, 178, 48];
export const NEWEST_SEED = [255, 236, 170];

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CENTER = 24;
const DISC_RADIUS = 19.7;
const BASE_SEEDS = 55;
const NEWEST_SHARE = 0.06;
const SMALLEST_SEED = 0.8;
const SEED_GROWTH = 1.33;
const IPHONE_SCALE = 0.8;
const MAC_SCALE = 0.64;
const WATCH_SCALE = 0.88;
const MAC_SIZES = [16, 32, 128, 256, 512];

const appleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = path.join(appleRoot, "App/Brand.xcassets");
const round = (value) => Math.round(value * 100) / 100;

export function appIconSeeds(count = APP_ICON_SEEDS) {
  const spacing = DISC_RADIUS / Math.sqrt(count);
  const seedScale = Math.sqrt(BASE_SEEDS / count);
  const growth = count + 8;
  return Array.from({ length: count }, (_, index) => {
    const age = index + 1;
    const order = growth - age;
    const share = age / count;
    const distance = spacing * Math.sqrt(age);
    const angle = order * GOLDEN_ANGLE;
    return {
      cx: round(CENTER + distance * Math.cos(angle)),
      cy: round(CENTER + distance * Math.sin(angle)),
      r: round((SMALLEST_SEED + SEED_GROWTH * Math.sqrt(share)) * seedScale),
      color: share < NEWEST_SHARE ? NEWEST_SEED : SEED_GOLD,
    };
  });
}

const grayOf = ([r, g, b]) => {
  const level = Math.round(Math.min(255, (0.2126 * r + 0.7152 * g + 0.0722 * b) * 1.25));
  return [level, level, level];
};

function disc({ scale, gray }) {
  const circles = appIconSeeds()
    .map(
      ({ cx, cy, r, color }) =>
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgb(${(gray ? grayOf(color) : color).join(",")})"/>`,
    )
    .join("");
  return `<g transform="translate(24 24) scale(${scale}) translate(-24 -24)">${circles}</g>`;
}

export function appIconSvg({
  background = APP_ICON_BACKGROUND,
  scale = IPHONE_SCALE,
  gray = false,
  mac = false,
} = {}) {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="1024" height="1024">`;
  if (!mac)
    return `${open}<rect width="48" height="48" fill="${background}"/>${disc({ scale, gray })}</svg>`;
  const inset = 48 * (100 / 1024);
  const side = 48 * (824 / 1024);
  const radius = 48 * (185.4 / 1024);
  return `${open}<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0.45" stdDeviation="0.55" flood-color="#000" flood-opacity="0.3"/></filter><clipPath id="c"><rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}"/></clipPath></defs><rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}" fill="${background}" filter="url(#s)"/><g clip-path="url(#c)">${disc({ scale, gray })}</g></svg>`;
}

export function appIconCatalog() {
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

async function shoot(page, svg, size, file, transparent = false) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body>`,
  );
  await page.screenshot({ path: file, omitBackground: transparent });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { chromium } = await import("playwright");
  for (const [file, json] of Object.entries(appIconCatalog())) {
    mkdirSync(path.dirname(path.join(catalog, file)), { recursive: true });
    writeFileSync(path.join(catalog, file), `${JSON.stringify(json, null, 2)}\n`);
  }
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  try {
    const page = await browser.newPage();
    const icons = path.join(catalog, "AppIcon.appiconset");
    await shoot(page, appIconSvg(), 1024, path.join(icons, "ios-light.png"));
    await shoot(page, appIconSvg(), 1024, path.join(icons, "ios-dark.png"));
    await shoot(
      page,
      appIconSvg({ background: "#000000", gray: true }),
      1024,
      path.join(icons, "ios-tinted.png"),
    );
    const macIcon = appIconSvg({ scale: MAC_SCALE, mac: true });
    for (const size of MAC_SIZES)
      for (const factor of [1, 2])
        await shoot(
          page,
          macIcon,
          size * factor,
          path.join(icons, `mac-${size * factor}.png`),
          true,
        );
    await shoot(
      page,
      appIconSvg({ scale: WATCH_SCALE }),
      1024,
      path.join(catalog, "WatchAppIcon.appiconset/watch.png"),
    );
  } finally {
    await browser.close();
  }
}
