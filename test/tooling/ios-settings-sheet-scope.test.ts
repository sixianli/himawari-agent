import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manage = new URL("../../clients/apple/Sources/HimawariManage/", import.meta.url);
const herPage = readFileSync(new URL("HerPage.swift", manage), "utf8");
const settingsParts = readFileSync(new URL("Settings/SettingsParts.swift", manage), "utf8");

function structBody(source: string, name: string): string {
  const start = source.indexOf(`struct ${name}`);
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe("the senses pages belong to the view that owns their state", () => {
  it("declares senses in HerPage and pushes each sense from its own navigation stack", () => {
    const root = structBody(herPage, "HerPage");
    expect(root).toContain("private let senses: HerSenses?");
    expect(root).toContain("case .sense(let item):");
    expect(root).toContain("senses.screen(item)");
    expect(root).not.toContain("sensesOpen");
  });

  it("does not use them inside the generic SettingsPage container", () => {
    const page = structBody(settingsParts, "SettingsPage<Content: View>");
    expect(page).not.toContain("sensesOpen");
    expect(page).not.toContain("senses");
  });
});
