import { readFileSync } from "node:fs";
import { renderBrandSvg } from "./render-brand-assets.mjs";

const path = "assets/brand/himawari/v4/logo-sunflower-disc.svg";
if (readFileSync(path, "utf8") !== renderBrandSvg()) {
  console.error(
    `${path} no longer matches the seeds drawn by apps/control-center/src/components/brand-seeds.ts; run node scripts/render-brand-assets.mjs and commit the result.`,
  );
  process.exit(1);
}
console.log("Brand asset check passed.");
