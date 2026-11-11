import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const biome = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.cmd" : "biome",
);
if (!existsSync(biome)) {
  console.error(`FORMAT_CHECK_UNAVAILABLE 找不到 ${path.relative(root, biome)}，先运行 npm ci`);
  process.exit(1);
}
const result = spawnSync(biome, ["format", "."], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
