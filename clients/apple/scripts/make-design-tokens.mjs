import { readFileSync, writeFileSync } from "node:fs";

export function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/u.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`DESIGN_TOKEN_COLOR_INVALID ${value}`);
}

function parseShadow(value) {
  const match = /^(-?[\d.]+) (-?[\d.]+) ([\d.]+) (rgba\([^)]+\))$/u.exec(value);
  if (!match) throw new Error(`DESIGN_TOKEN_SHADOW_INVALID ${value}`);
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    blur: Number(match[3]),
    color: parseColor(match[4]),
  };
}

const number = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`DESIGN_TOKEN_NUMBER_INVALID ${value}`);
  return Number.isInteger(value) ? `${value}` : `${value}`;
};

const identifier = (name) => {
  if (!/^[a-z][A-Za-z0-9]*$/u.test(name)) throw new Error(`DESIGN_TOKEN_NAME_INVALID ${name}`);
  return name;
};

const rgba = ([r, g, b, a]) =>
  `RGBA(red: ${number(r)} / 255, green: ${number(g)} / 255, blue: ${number(b)} / 255, alpha: ${number(a)})`;

export function generate(tokens) {
  const lines = ["import CoreGraphics", "", "public enum DesignTokens {"];
  const light = tokens.color.light;
  const dark = tokens.color.dark;
  const lightNames = Object.keys(light).sort();
  const darkNames = Object.keys(dark).sort();
  if (lightNames.join() !== darkNames.join()) throw new Error("DESIGN_TOKEN_THEMES_DIFFER color");
  lines.push("    public enum Colors {");
  for (const name of lightNames) {
    lines.push(
      `        public static let ${identifier(name)} = PaletteToken(light: ${rgba(parseColor(light[name]))}, dark: ${rgba(parseColor(dark[name]))})`,
    );
  }
  for (const name of Object.keys(tokens.colorUse ?? {}).sort()) {
    const target = tokens.colorUse[name];
    if (!lightNames.includes(target)) throw new Error(`DESIGN_TOKEN_COLOR_USE_UNKNOWN ${name}`);
    if (lightNames.includes(name)) throw new Error(`DESIGN_TOKEN_COLOR_USE_SHADOWS ${name}`);
    lines.push(`        public static let ${identifier(name)} = ${identifier(target)}`);
  }
  lines.push("    }", "");
  const shadowNames = Object.keys(tokens.shadow.light).sort();
  if (shadowNames.join() !== Object.keys(tokens.shadow.dark).sort().join())
    throw new Error("DESIGN_TOKEN_THEMES_DIFFER shadow");
  lines.push("    public enum Shadows {");
  for (const name of shadowNames) {
    const l = parseShadow(tokens.shadow.light[name]);
    const d = parseShadow(tokens.shadow.dark[name]);
    lines.push(
      `        public static let ${identifier(name)} = ShadowToken(x: ${number(l.x)}, y: ${number(l.y)}, blur: ${number(l.blur)}, color: PaletteToken(light: ${rgba(l.color)}, dark: ${rgba(d.color)}))`,
    );
    if (l.x !== d.x || l.y !== d.y || l.blur !== d.blur)
      throw new Error(`DESIGN_TOKEN_SHADOW_GEOMETRY_DIFFERS ${name}`);
  }
  lines.push("    }", "");
  const scalars = (title, object, type = "CGFloat") => {
    lines.push(`    public enum ${title} {`);
    for (const name of Object.keys(object ?? {}).sort()) {
      const value = object[name];
      if (Array.isArray(value)) {
        const suffixes = name.endsWith("Padding")
          ? { 2: ["Vertical", "Horizontal"], 3: ["Top", "Horizontal", "Bottom"] }[value.length]
          : { 2: ["Width", "Height"] }[value.length];
        if (!suffixes) throw new Error(`DESIGN_TOKEN_LIST_INVALID ${name}`);
        suffixes.forEach((suffix, index) => {
          lines.push(
            `        public static let ${identifier(name)}${suffix}: ${type} = ${number(value[index])}`,
          );
        });
      } else if (typeof value === "number") {
        lines.push(`        public static let ${identifier(name)}: ${type} = ${number(value)}`);
      }
    }
    lines.push("    }", "");
  };
  scalars("Glass", tokens.glass);
  scalars("Radius", tokens.radius);
  scalars("Size", tokens.size);
  scalars("IconSize", tokens.icon);
  scalars("ProcessRow", tokens.processRow);
  scalars("Opacity", tokens.opacity, "Double");
  scalars("Pairing", tokens.pairing ?? {});
  scalars("Scanner", tokens.scanner ?? {});
  scalars("Handover", tokens.handover ?? {});
  scalars("Mac", tokens.mac ?? {});
  scalars("Watch", tokens.watch ?? {});
  lines.push("    public enum TypeScale {");
  for (const name of Object.keys(tokens.type).sort()) {
    const value = tokens.type[name];
    if (!Array.isArray(value)) continue;
    const [size, weight, ...rest] = value;
    let lineHeight = "nil";
    let face = ".system";
    let tracking = "0";
    for (const extra of rest) {
      if (typeof extra === "number")
        lineHeight = extra > 3 ? number(extra) : `${number(size)} * ${number(extra)}`;
      else if (extra === "himawari") face = ".himawari";
      else if (extra === "number") face = ".rounded";
      else if (/^字间距 [\d.]+$/u.test(extra)) tracking = number(Number(extra.split(" ")[1]));
      else throw new Error(`DESIGN_TOKEN_TYPE_EXTRA_UNKNOWN ${name} ${extra}`);
    }
    lines.push(
      `        public static let ${identifier(name)} = TypeToken(size: ${number(size)}, weight: ${number(weight)}, lineHeight: ${lineHeight}, face: ${face}, tracking: ${tracking})`,
    );
  }
  lines.push("    }", "}", "");
  return lines.join("\n");
}

const kebab = (name) => identifier(name).replace(/[A-Z0-9]+/gu, (part) => `-${part.toLowerCase()}`);

export function generateCss(tokens) {
  const block = (selector, entries) => [
    `${selector} {`,
    ...entries.map(([k, v]) => `  --${k}: ${v};`),
    "}",
  ];
  const colors = (theme) =>
    Object.keys(tokens.color[theme])
      .sort()
      .map((name) => {
        const [r, g, b, a] = parseColor(tokens.color[theme][name]);
        return [`color-${kebab(name)}`, `rgba(${r}, ${g}, ${b}, ${a})`];
      })
      .concat(
        Object.keys(tokens.shadow?.[theme] ?? {})
          .sort()
          .map((name) => {
            const { x, y, blur, color } = parseShadow(tokens.shadow[theme][name]);
            return [
              `shadow-${kebab(name)}`,
              `${number(x)}px ${number(y)}px ${number(blur)}px rgba(${color.join(", ")})`,
            ];
          }),
      );
  const scalars = (group, object) =>
    Object.keys(object ?? {})
      .sort()
      .flatMap((name) => {
        const value = object[name];
        if (typeof value === "number") return [[`${group}-${kebab(name)}`, `${number(value)}px`]];
        if (Array.isArray(value) && value.every((item) => typeof item === "number"))
          return [[`${group}-${kebab(name)}`, value.map((item) => `${number(item)}px`).join(" ")]];
        return [];
      });
  const type = Object.keys(tokens.type)
    .sort()
    .flatMap((name) => {
      const value = tokens.type[name];
      if (!Array.isArray(value)) return [];
      const [size, weight, ...rest] = value;
      const lineHeight = rest.find((extra) => typeof extra === "number");
      return [
        [`type-${kebab(name)}-size`, `${number(size)}px`],
        [`type-${kebab(name)}-weight`, number(weight)],
        [
          `type-${kebab(name)}-line-height`,
          lineHeight === undefined
            ? "normal"
            : lineHeight > 3
              ? `${number(lineHeight)}px`
              : number(lineHeight),
        ],
      ];
    });
  const fixed = [
    ...scalars("radius", tokens.radius),
    ...scalars("size", tokens.size),
    ...scalars("icon", tokens.icon),
    ...scalars("handover", tokens.handover),
    ...type,
  ];
  return [
    ...block(":root", [...colors("light"), ...fixed]),
    "@media (prefers-color-scheme: dark) {",
    ...block(":root", colors("dark")).map((line) => `  ${line}`),
    "}",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [input, output, cssOutput] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write(
      "usage: node make-design-tokens.mjs <tokens.json> <DesignTokens.swift> [tokens.css]\n",
    );
    process.exit(2);
  }
  const tokens = JSON.parse(readFileSync(input, "utf8"));
  writeFileSync(output, generate(tokens));
  if (cssOutput) writeFileSync(cssOutput, generateCss(tokens));
}
