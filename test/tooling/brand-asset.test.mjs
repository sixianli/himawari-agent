import {
  copyFile,
  readFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { restingGrowth, seedsAt } from "../../apps/control-center/src/components/brand-seeds.ts";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

it(
  "[UI-2] builds the brand mark without any image asset, so no PNG reaches the browser bundle",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "himawari-brand-build-"));
    try {
      await symlink(
        path.join(repositoryRoot, "node_modules"),
        path.join(root, "node_modules"),
        "dir",
      );
      const app = path.join(root, "apps/control-center");
      await mkdir(path.join(app, "src/components"), { recursive: true });
      for (const file of ["brand.tsx", "brand-seeds.ts"])
        await copyFile(
          path.join(repositoryRoot, "apps/control-center/src/components", file),
          path.join(app, "src/components", file),
        );
      await writeFile(
        path.join(app, "index.html"),
        '<script type="module" src="/src/main.ts"></script>',
      );
      await writeFile(
        path.join(app, "src/main.ts"),
        'import {HimawariBrand} from "./components/brand"; console.log(HimawariBrand);',
      );
      await build({
        root: app,
        configFile: false,
        logLevel: "silent",
        build: { write: true, minify: false },
      });
      const emitted = await readdir(path.join(app, "dist/assets"));
      expect(emitted.some((name) => name.endsWith(".js"))).toBe(true);
      expect(emitted.filter((name) => /\.(png|jpe?g|webp)$/.test(name))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("[UI-2] keeps the v4 brand asset at the same seed positions as the interface mark", async () => {
  const asset = await readFile(
    path.join(repositoryRoot, "assets/brand/himawari/v4/logo-sunflower-disc.svg"),
    "utf8",
  );
  const circles = [...asset.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(
    ([, cx, cy, r]) => ({ cx: Number(cx), cy: Number(cy), r: Number(r) }),
  );
  const seeds = seedsAt(restingGrowth())
    .filter((seed) => seed.r > 0)
    .map(({ cx, cy, r }) => ({ cx, cy, r }));
  expect(circles).toEqual(seeds);
});
