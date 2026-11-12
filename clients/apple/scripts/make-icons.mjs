import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [packageDir, resourcesDir] = process.argv.slice(2);
if (!packageDir || !resourcesDir) {
  process.stderr.write(
    "usage: node make-icons.mjs <@tabler/icons package dir> <HimawariDesign Resources dir>\n",
  );
  process.exit(2);
}

const icons = JSON.parse(readFileSync(new URL("./icons.json", import.meta.url), "utf8"));
const catalog = join(resourcesDir, "Icons.xcassets");
rmSync(catalog, { recursive: true, force: true });
mkdirSync(catalog, { recursive: true });
writeFileSync(
  join(catalog, "Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);

function fromTabler(name, sourceName, spec) {
  const strokeWidth = typeof spec === "number" ? spec : spec.stroke;
  const drop = typeof spec === "number" ? [] : (spec.drop ?? []);
  const source = readFileSync(join(packageDir, "icons", "outline", `${sourceName}.svg`), "utf8");
  if (!source.includes('stroke-width="2"') || !source.includes('stroke="currentColor"')) {
    throw new Error(`unexpected outline icon format: ${name}`);
  }
  let trimmed = source;
  for (const path of drop) {
    const element = `<path d="${path}" />`;
    if (!trimmed.includes(element)) throw new Error(`path not found in ${name}: ${path}`);
    trimmed = trimmed.replace(
      new RegExp(`\\s*${element.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
      "",
    );
  }
  return trimmed
    .replace('stroke-width="2"', `stroke-width="${strokeWidth}"`)
    .replace('stroke="currentColor"', 'stroke="#000000"')
    .replace(/\s*class="[^"]*"/u, "");
}

for (const [key, spec] of Object.entries(icons)) {
  const [sourceName, variant] = key.split("@");
  const name = variant ? `${sourceName}-${variant}` : sourceName;
  const svg =
    typeof spec === "object" && spec.custom
      ? readFileSync(new URL(`./custom-icons/${spec.custom}`, import.meta.url), "utf8")
      : fromTabler(name, sourceName, spec);
  const set = join(catalog, `${name}.imageset`);
  mkdirSync(set);
  writeFileSync(join(set, `${name}.svg`), svg);
  writeFileSync(
    join(set, "Contents.json"),
    `${JSON.stringify(
      {
        images: [{ filename: `${name}.svg`, idiom: "universal" }],
        info: { author: "xcode", version: 1 },
        properties: {
          "preserves-vector-representation": true,
          "template-rendering-intent": "template",
        },
      },
      null,
      2,
    )}\n`,
  );
}

const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
mkdirSync(join(resourcesDir, "Licenses"), { recursive: true });
copyFileSync(join(packageDir, "LICENSE"), join(resourcesDir, "Licenses", "tabler-icons.txt"));
writeFileSync(join(resourcesDir, "Licenses", "tabler-icons.version"), `${pkg.version}\n`);
