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

  it("keeps haptics on wherever the session is activated", () => {
    const hits = execFileSync(
      "grep",
      ["-rln", "--include=*.swift", "setActive(true", new URL(".", sources).pathname],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(hits.map((path) => path.split("/").pop()).sort()).toEqual([
      "AudioCapture.swift",
      "TalkAudio.swift",
    ]);
    for (const path of hits) {
      const source = readFileSync(path, "utf8");
      let from = 0;
      for (;;) {
        const activate = source.indexOf("setActive(true", from);
        if (activate === -1) break;
        const before = source.slice(0, activate);
        const allow = before.lastIndexOf("setAllowHapticsAndSystemSoundsDuringRecording(true)");
        const category = before.lastIndexOf("setCategory(");
        expect(allow, path).toBeGreaterThan(category);
        from = activate + 1;
      }
    }
  });

  it("releases the session on stop, on teardown, on a replaced capture and when the capture is dropped", () => {
    expect(body(capture, "func stop(deactivate: Bool)")).toContain("setActive(false");
    expect(body(capture, "deinit")).toContain("setActive(false");
    const close = body(controller, "private func closeMicrophone()");
    expect(close).toContain("capture?.stop(deactivate: true)");
    expect(close).toContain("capture = nil");
    expect(body(controller, "private func tearDown()")).toContain("closeMicrophone()");
    expect(body(controller, "public func start() async")).toContain("openMicrophone()");
    const open = body(controller, "private func openMicrophone() async throws");
    const release = open.indexOf("closeMicrophone()");
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(open.indexOf("AudioCapture()"));
  });

  it("tracks whether the capture holds the session so a dropped capture releases it", () => {
    expect(body(capture, "func configureSession()")).toContain("holdsSession = true");
    expect(body(capture, "func restart()")).toContain("holdsSession = true");
    expect(body(capture, "func stop(deactivate: Bool)")).toContain("holdsSession = false");
    const dropped = body(capture, "deinit");
    const guarded = dropped.indexOf("if holdsSession");
    expect(guarded).toBeGreaterThan(-1);
    expect(dropped.indexOf("setActive(false")).toBeGreaterThan(guarded);
  });
});
