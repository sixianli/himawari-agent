import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { browserCounts, browserReportFiles } from "../../scripts/ci/browser.mjs";

const report = () => ({
  status: "passed",
  scope: "fixture-only",
  engine: "chromium",
  profile: "chromium",
  browserVersion: "140.0",
  locales: ["zh-CN", "en", "ja"],
  keyboard: ["visible-focus", "settings-keyboard-navigation"],
  axeViolations: 0,
  keyboardFocus: { visible: true, accessibleName: "Navigation" },
  journeys: ["chat"],
  routeStates: ["loading"],
  sse: ["reconnect"],
  responsive: ["mobile"],
  surfaces: [{ label: "chat" }],
});
describe("browser execution evidence", () => {
  it("counts named executed scenarios and records fixture scope", () => {
    expect(browserCounts(report(), "chromium").executed).toBe(10);
  });
  it.each([
    [
      "missing locale",
      (value) => {
        value.locales.pop();
      },
    ],
    [
      "missing keyboard",
      (value) => {
        value.keyboard.pop();
      },
    ],
    [
      "page failure",
      (value) => {
        value.status = "failed";
      },
    ],
    [
      "axe failure",
      (value) => {
        value.axeViolations = 1;
      },
    ],
    [
      "invisible focus",
      (value) => {
        value.keyboardFocus.visible = false;
      },
    ],
    [
      "wrong engine",
      (value) => {
        value.engine = "webkit";
      },
    ],
    [
      "empty scenarios",
      (value) => {
        value.journeys = [];
      },
    ],
    [
      "production claim",
      (value) => {
        value.scope = "production";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = report();
    mutate(value);
    expect(() => browserCounts(value, "chromium")).toThrow();
  });
});

describe("browser report collection", () => {
  it("publishes nested report files and never a directory", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "browser-reports-"));
    try {
      writeFileSync(path.join(root, "browser.json"), "{}");
      mkdirSync(path.join(root, "execution-chain"));
      writeFileSync(path.join(root, "execution-chain", "journey.png"), "");
      expect(await browserReportFiles(root)).toEqual([
        { path: path.join(root, "browser.json"), kind: "json" },
        { path: path.join(root, "execution-chain", "journey.png"), kind: "diagnostic" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
