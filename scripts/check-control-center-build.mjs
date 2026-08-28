import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = path.join(repositoryRoot, "apps/control-center/dist");
const assetsRoot = path.join(distributionRoot, "assets");
const maximumEntryGzipBytes = 150 * 1024;
const maximumTotalGzipBytes = 180 * 1024;

const indexHtml = await readFile(path.join(distributionRoot, "index.html"), "utf8");
const assetNames = await readdir(assetsRoot);
const sourceMapNames = assetNames.filter((name) => name.endsWith(".map"));
const javaScriptNames = assetNames.filter((name) => name.endsWith(".js"));
const cssNames = assetNames.filter((name) => name.endsWith(".css"));
const localeChunks = javaScriptNames.filter((name) => /^(en|ja)-/.test(name));
const entryChunks = javaScriptNames.filter((name) => name.startsWith("index-"));
const errors = [];

if (sourceMapNames.length > 0) errors.push(`source maps emitted: ${sourceMapNames.join(",")}`);
if (cssNames.length !== 1) errors.push(`expected one external CSS asset, found ${cssNames.length}`);
if (entryChunks.length !== 1) errors.push(`expected one entry chunk, found ${entryChunks.length}`);
if (localeChunks.length !== 2)
  errors.push(`expected en/ja locale chunks, found ${localeChunks.length}`);
if (!/<script\b[^>]*\bsrc=/.test(indexHtml)) errors.push("external module script missing");
if (!/<link\b[^>]*\brel=["']stylesheet["']/.test(indexHtml)) {
  errors.push("external stylesheet missing");
}
if (/<script\b(?![^>]*\bsrc=)[^>]*>/.test(indexHtml)) errors.push("inline script emitted");
if (/<style\b/i.test(indexHtml) || /\sstyle=["']/i.test(indexHtml)) {
  errors.push("inline style emitted");
}

const assets = [];
for (const name of [...javaScriptNames, ...cssNames].sort()) {
  const filePath = path.join(assetsRoot, name);
  const content = await readFile(filePath);
  const details = await stat(filePath);
  if (name.endsWith(".js")) {
    const source = content.toString("utf8");
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) {
      errors.push(`${name} contains dynamic code evaluation`);
    }
  }
  assets.push({ name, bytes: details.size, gzipBytes: gzipSync(content).byteLength });
}

const entry = assets.find(({ name }) => entryChunks.includes(name));
const totalGzipBytes = assets.reduce((total, asset) => total + asset.gzipBytes, 0);
if (entry && entry.gzipBytes > maximumEntryGzipBytes) {
  errors.push(`entry gzip budget exceeded: ${entry.gzipBytes} > ${maximumEntryGzipBytes}`);
}
if (totalGzipBytes > maximumTotalGzipBytes) {
  errors.push(`total gzip budget exceeded: ${totalGzipBytes} > ${maximumTotalGzipBytes}`);
}

const result = {
  schemaVersion: 1,
  status: errors.length === 0 ? "passed" : "failed",
  errors,
  assets,
  localeChunks,
  sourceMaps: sourceMapNames.length,
  inlineScripts: 0,
  inlineStyles: 0,
  budgets: { maximumEntryGzipBytes, maximumTotalGzipBytes, totalGzipBytes },
};

process.stdout.write(`${JSON.stringify(result)}\n`);
if (errors.length > 0) process.exitCode = 1;
