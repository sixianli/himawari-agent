import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

const require = createRequire(
  path.resolve(import.meta.dirname, "../apps/control-center/package.json"),
);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const { version } = JSON.parse(readFileSync(path.join(pdfjsRoot, "package.json"), "utf8")) as {
  readonly version: string;
};

export const PDFJS_ASSET_DIRECTORY = `assets/pdfjs-${version}`;

export function pdfjsAssets(): Plugin {
  return {
    name: "himawari-pdfjs-assets",
    generateBundle() {
      for (const folder of ["cmaps", "standard_fonts"]) {
        for (const name of readdirSync(path.join(pdfjsRoot, folder))) {
          this.emitFile({
            type: "asset",
            fileName: `${PDFJS_ASSET_DIRECTORY}/${folder}/${name}`,
            source: readFileSync(path.join(pdfjsRoot, folder, name)),
          });
        }
      }
    },
    config() {
      return { define: { __PDFJS_ASSET_DIRECTORY__: JSON.stringify(PDFJS_ASSET_DIRECTORY) } };
    },
  };
}
