import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../clients/apple/App");
const project = readFileSync(path.join(app, "Himawari.xcodeproj/project.pbxproj"), "utf8");
const catalog = path.join(app, "Brand.xcassets");

const apps = [
  { target: "Himawari", plist: "iOS/Info.plist", icon: "AppIcon" },
  { target: "HimawariMac", plist: "macOS/Info.plist", icon: "AppIcon" },
  { target: "HimawariWatch", plist: "Watch/Info.plist", icon: "WatchAppIcon" },
];

function block(id) {
  const start = project.indexOf(`\n\t\t${id} `);
  expect(start, id).toBeGreaterThan(-1);
  return project.slice(start, project.indexOf("\n\t\t};", start));
}

function resourcesOf(target) {
  const native = [
    ...project.matchAll(/\t\t(\w+) \/\* (\w+) \*\/ = \{\n\t\t\tisa = PBXNativeTarget;/gu),
  ].find((match) => match[2] === target);
  expect(native, target).toBeDefined();
  const phase = block(native[1]).match(/(\w+) \/\* Resources \*\//u);
  expect(phase, `${target} has a resources phase`).not.toBeNull();
  return block(phase[1]);
}

function pngInfo(file) {
  const bytes = readFileSync(file);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

it("[UI-2] gives the iPhone, Mac and Watch apps a home-screen icon from Brand.xcassets", () => {
  for (const { target, plist, icon } of apps) {
    const configs = [...project.matchAll(/buildSettings = \{\n(.*?)\n\t\t\t\};/gsu)]
      .map((match) => match[1])
      .filter((settings) => settings.includes(`INFOPLIST_FILE = ${plist};`));
    expect(configs, target).toHaveLength(2);
    for (const settings of configs)
      expect(settings).toContain(`ASSETCATALOG_COMPILER_APPICON_NAME = ${icon};`);
    expect(resourcesOf(target)).toContain("Brand.xcassets in Resources");
    expect(existsSync(path.join(catalog, `${icon}.appiconset/Contents.json`))).toBe(true);
  }
});

it("[UI-2] ships every icon image the catalog names, at its stated pixel size, opaque for iPhone and Watch", () => {
  for (const set of ["AppIcon", "WatchAppIcon"]) {
    const dir = path.join(catalog, `${set}.appiconset`);
    const { images } = JSON.parse(readFileSync(path.join(dir, "Contents.json"), "utf8"));
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      const file = path.join(dir, image.filename);
      expect(existsSync(file), image.filename).toBe(true);
      const side =
        Number(image.size.split("x")[0]) * Number((image.scale ?? "1x").replace("x", ""));
      const { width, height, colorType } = pngInfo(file);
      expect([width, height], image.filename).toEqual([side, side]);
      if (image.idiom !== "mac") expect(colorType, `${image.filename} has no alpha`).toBe(2);
    }
  }
  const appearances = JSON.parse(
    readFileSync(path.join(catalog, "AppIcon.appiconset/Contents.json"), "utf8"),
  )
    .images.filter((image) => image.platform === "ios")
    .map((image) => image.appearances?.[0]?.value ?? "any");
  expect(appearances).toEqual(["any", "dark", "tinted"]);
});
