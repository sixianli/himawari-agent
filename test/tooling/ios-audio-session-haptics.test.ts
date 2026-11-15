import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sources = new URL("../../clients/apple/Sources/", import.meta.url);
const capture = readFileSync(new URL("HimawariListen/AudioCapture.swift", sources), "utf8");
const controller = readFileSync(
  new URL("HimawariListen/ListeningController.swift", sources),
  "utf8",
);

function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open, index + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

describe("the listening audio session never silences the phone's haptics", () => {
  it("allows system haptics while recording, set after the category and before activation", () => {
    const configure = body(capture, "func configureSession()");
    const category = configure.indexOf("setCategory(");
    const allow = configure.indexOf("setAllowHapticsAndSystemSoundsDuringRecording(true)");
    const activate = configure.indexOf("setActive(true");
    expect(category).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(category);
    expect(activate).toBeGreaterThan(allow);
  });

  it("is activated only by AudioCapture", () => {
    const hits = execFileSync(
      "grep",
      ["-rln", "--include=*.swift", "setActive(true", new URL(".", sources).pathname],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(hits.map((path) => path.split("/").pop())).toEqual(["AudioCapture.swift"]);
  });

  it("releases the session on stop, on teardown, on a replaced capture and when the capture is dropped", () => {
    expect(body(capture, "func stop(deactivate: Bool)")).toContain("setActive(false");
    expect(body(capture, "deinit")).toContain("setActive(false");
    const tearDown = body(controller, "private func tearDown()");
    expect(tearDown).toContain("capture?.stop(deactivate: true)");
    expect(tearDown).toContain("capture = nil");
    const start = body(controller, "public func start() async");
    expect(start.indexOf("capture?.stop(deactivate: true)")).toBeLessThan(
      start.indexOf("AudioCapture()"),
    );
  });
});
