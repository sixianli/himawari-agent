import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../clients/apple/Sources/HimawariManage/SettingsRootView.swift", import.meta.url),
  "utf8",
);

function structBody(name: string): string {
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

describe("the senses sheet is attached to the view that owns its state", () => {
  it("declares sensesOpen and senses in SettingsRootView and presents the sheet there", () => {
    const root = structBody("SettingsRootView");
    expect(root).toContain("@State private var sensesOpen");
    expect(root).toContain("private let senses");
    expect(root).toContain(".sheet(isPresented: $sensesOpen)");
  });

  it("does not use them inside the generic SettingsPage container", () => {
    const page = structBody("SettingsPage<Content: View>");
    expect(page).not.toContain("sensesOpen");
    expect(page).not.toContain("senses");
  });
});
