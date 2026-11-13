import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [svgPath, outDir, ...sizes] = process.argv.slice(2);
if (!svgPath || !outDir || sizes.length === 0) {
  process.stderr.write(
    "usage: node make-safari-icons.mjs <sunflower.svg> <images dir> <size>...\n",
  );
  process.exit(2);
}
const svg = readFileSync(svgPath, "utf8");
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
try {
  for (const size of sizes.map(Number)) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
    );
    await page.screenshot({ path: path.join(outDir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
