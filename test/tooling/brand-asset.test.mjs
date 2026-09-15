import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

it(
  "fails the real browser build when a source archive omits the required brand asset",
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
      await copyFile(
        path.join(repositoryRoot, "apps/control-center/src/components/brand.tsx"),
        path.join(app, "src/components/brand.tsx"),
      );
      await writeFile(
        path.join(app, "index.html"),
        '<script type="module" src="/src/main.ts"></script>',
      );
      await writeFile(
        path.join(app, "src/main.ts"),
        'import {HimawariBrand} from "./components/brand"; console.log(HimawariBrand);',
      );
      const options = {
        root: app,
        configFile: false,
        logLevel: "silent",
        build: { write: true, minify: false },
      };
      await expect(build(options)).rejects.toThrow();
      const asset = "assets/brand/himawari/v1/logo-symbol-light.png";
      await mkdir(path.dirname(path.join(root, asset)), { recursive: true });
      await copyFile(path.join(repositoryRoot, asset), path.join(root, asset));
      await build(options);
      const emitted = (await readdir(path.join(app, "dist/assets"))).find((x) =>
        x.endsWith(".png"),
      );
      expect(emitted).toBeTruthy();
      expect(await readFile(path.join(app, "dist/assets", emitted))).toEqual(
        await readFile(path.join(root, asset)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
