import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const LINT_ARGS = ["lint", "--error-on-warnings", "--diagnostic-level=warn", "."];

const root = path.resolve(import.meta.dirname, "..");
const biome = path.join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
if (!existsSync(biome)) {
  console.error(`LINT_CHECK_UNAVAILABLE 找不到 ${path.relative(root, biome)}，先运行 npm ci`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [biome, ...LINT_ARGS], { cwd: root, stdio: "inherit" });
if (result.error) console.error(`LINT_CHECK_UNAVAILABLE ${result.error.message}`);
process.exit(result.status ?? 1);
