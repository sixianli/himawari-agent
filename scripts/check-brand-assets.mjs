import { readFileSync } from "node:fs";
import { FAVICON_PATH, renderBrandSvg, renderFaviconSvg } from "./render-brand-assets.mjs";

const expected = [
  ["assets/brand/himawari/v4/logo-sunflower-disc.svg", renderBrandSvg()],
  [FAVICON_PATH, renderFaviconSvg()],
];
const stale = expected.filter(([path, svg]) => {
  try {
    return readFileSync(path, "utf8") !== svg;
  } catch {
    return true;
  }
});
if (stale.length) {
  for (const [path] of stale)
    console.error(
      `${path} no longer matches the seeds drawn by apps/control-center/src/components/brand-seeds.ts; run node scripts/render-brand-assets.mjs --svg-only and commit the result.`,
    );
  process.exit(1);
}
console.log("Brand asset check passed.");
