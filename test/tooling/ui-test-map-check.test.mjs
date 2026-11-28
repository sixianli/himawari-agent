import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkMap,
  checkRepository,
  ciTestRuns,
  demoScenes,
  runByCi,
  uiTestMethods,
} from "../../clients/apple/scripts/check-ui-test-map.mjs";

const fixtures = path.join(import.meta.dirname, "../fixtures/apple-ui-test-map");
const scenesAt = (name) => demoScenes(readFileSync(path.join(fixtures, `${name}.swift`), "utf8"));

const scrollTest = "HimawariUITests/DevicePageTests/testTheListScrollsToItsLastRow";
const uiTests = uiTestMethods([
  {
    source: `final class DevicePageTests: XCTestCase {\n    func testTheListScrollsToItsLastRow() {}\n}\nfinal class AccessibilityAuditTests: XCTestCase {\n    func testEveryDemoScene() throws {}\n}\n`,
  },
]);
const runs = ciTestRuns({
  workflows: [
    {
      file: "apple.yml",
      source: `jobs:\n  ui:\n    steps:\n      - run: >-\n          xcodebuild test-without-building\n          -only-testing:HimawariUITests\n          | tee log\n`,
    },
  ],
  readScript: () => undefined,
});
const audit = {
  test: "HimawariUITests/AccessibilityAuditTests/testEveryDemoScene",
  reason: "opens each scene once and audits it; it does not operate the page",
};

function mapOf(scenes, tested = new Map()) {
  return {
    notFunctionalTests: [audit],
    features: scenes.map((scene) =>
      tested.has(scene)
        ? { feature: scene, scenes: [scene], tests: [tested.get(scene)] }
        : { feature: scene, scenes: [scene], uncovered: "no UI test yet" },
    ),
  };
}

describe("iPhone feature to UI test map", () => {
  it("passes on this repository", () => {
    expect(checkRepository({ base: "HEAD" })).toEqual([]);
  });

  describe("the build 145 devices page that would not scroll", () => {
    const before = scenesAt("before-devices-page");
    const after = scenesAt("with-devices-page");
    const base = mapOf(before);

    it("is a scene b558851ad added", () => {
      expect(before).not.toContain("next-3-her-devices");
      expect(after).toContain("next-3-her-devices");
    });

    it("fails when the scene is added without touching the map", () => {
      const errors = checkMap({ map: base, scenes: after, tests: uiTests, runs, baseMap: base });
      expect(errors).toContain(
        "UI_MAP_SCENE_MISSING next-3-her-devices: add it to clients/apple/ui-test-map.json with the UI test that operates it",
      );
    });

    it("fails when the scene is added to the map as having no test", () => {
      const errors = checkMap({
        map: mapOf(after),
        scenes: after,
        tests: uiTests,
        runs,
        baseMap: base,
      });
      expect(errors.filter((error) => error.startsWith("UI_MAP_UNCOVERED_GREW"))).toEqual([
        expect.stringMatching(/^UI_MAP_UNCOVERED_GREW next-3-her\b/u),
        expect.stringMatching(/^UI_MAP_UNCOVERED_GREW next-3-her-privacy\b/u),
        expect.stringMatching(/^UI_MAP_UNCOVERED_GREW next-3-her-devices\b/u),
      ]);
    });

    it("fails when the only test named is the accessibility audit", () => {
      const tested = new Map(
        ["next-3-her", "next-3-her-privacy", "next-3-her-devices"].map((scene) => [
          scene,
          audit.test,
        ]),
      );
      const errors = checkMap({
        map: mapOf(after, tested),
        scenes: after,
        tests: uiTests,
        runs,
        baseMap: base,
      });
      expect(errors).toContain(
        `UI_MAP_TEST_NOT_FUNCTIONAL next-3-her-devices: ${audit.test} (${audit.reason})`,
      );
    });

    it("passes once each new scene names a UI test that CI runs", () => {
      const tested = new Map(
        ["next-3-her", "next-3-her-privacy", "next-3-her-devices"].map((scene) => [
          scene,
          scrollTest,
        ]),
      );
      expect(
        checkMap({ map: mapOf(after, tested), scenes: after, tests: uiTests, runs, baseMap: base }),
      ).toEqual([]);
    });
  });

  it("rejects a named test that does not exist or that no CI job runs", () => {
    const scenes = ["a"];
    const map = mapOf(scenes, new Map([["a", scrollTest]]));
    expect(checkMap({ map, scenes, tests: new Set(), runs, baseMap: map })).toEqual([
      `UI_MAP_TEST_MISSING a: ${scrollTest}`,
    ]);
    const onlyAudit = ciTestRuns({
      workflows: [
        {
          file: "apple.yml",
          source: `jobs:\n  ui:\n    steps:\n      - run: xcodebuild test -only-testing:HimawariUITests/AccessibilityAuditTests -skip-testing:HimawariUITests/DevicePageTests\n`,
        },
      ],
      readScript: () => undefined,
    });
    expect(checkMap({ map, scenes, tests: uiTests, runs: onlyAudit, baseMap: map })).toEqual([
      `UI_MAP_TEST_NOT_RUN_BY_CI a: ${scrollTest}`,
    ]);
  });

  it("reads the tests a workflow runs through a script, including a variable with a default", () => {
    const script = `only="\${HIMAWARI_E2E_ONLY:-HimawariUITests/EndToEndTests}"\nxcodebuild test-without-building \\\n  -only-testing:"$only" \\\n  -resultBundlePath x\n`;
    const found = ciTestRuns({
      workflows: [
        {
          file: "apple.yml",
          source: `jobs:\n  e2e:\n    steps:\n      - run: clients/apple/scripts/e2e.sh\n`,
        },
      ],
      readScript: (file) => (file === "clients/apple/scripts/e2e.sh" ? script : undefined),
    });
    expect(runByCi("HimawariUITests/EndToEndTests/testSending", found)).toBe(true);
    expect(runByCi(scrollTest, found)).toBe(false);
  });

  it("ignores builds that do not run tests and selectors it cannot resolve", () => {
    const found = ciTestRuns({
      workflows: [
        {
          file: "apple.yml",
          source: `jobs:\n  b:\n    steps:\n      - run: xcodebuild build-for-testing -scheme Himawari\n      - run: xcodebuild test -only-testing:"$UNKNOWN"\n`,
        },
      ],
      readScript: () => undefined,
    });
    expect(found).toEqual([]);
  });

  it("reports scenes that left the app and scenes listed twice", () => {
    const map = {
      notFunctionalTests: [],
      features: [
        { feature: "one", scenes: ["a", "gone"], uncovered: "none yet" },
        { feature: "two", scenes: ["a"], uncovered: "none yet" },
      ],
    };
    expect(checkMap({ map, scenes: ["a"], tests: uiTests, runs, baseMap: map })).toEqual([
      "UI_MAP_SCENE_TWICE a: one and two",
      "UI_MAP_SCENE_GONE gone: it is no longer a demo scene",
    ]);
  });
});
