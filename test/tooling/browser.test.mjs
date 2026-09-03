import { describe, expect, it } from "vitest";
import { browserCounts } from "../../scripts/ci/browser.mjs";

const report = () => ({
  status: "passed",
  scope: "fixture-only",
  engine: "chromium",
  profile: "chromium",
  browserVersion: "140.0",
  locales: ["zh-CN", "en", "ja"],
  keyboard: ["visible-focus", "settings-tabs-roving"],
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
