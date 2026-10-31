import { expect, it } from "vitest";
import { viewportState } from "../src/viewport-sync.js";

it("[UI-43] follows the visual viewport only while the keyboard covers the page", () => {
  expect(
    viewportState({ layoutHeight: 852, visualHeight: 852, visualOffsetTop: 0, scale: 1 }),
  ).toEqual({ keyboardOpen: false, height: 852, shift: 0 });
  expect(
    viewportState({ layoutHeight: 852, visualHeight: 510, visualOffsetTop: 0, scale: 1 }),
  ).toEqual({ keyboardOpen: true, height: 510, shift: 0 });
  expect(
    viewportState({ layoutHeight: 852, visualHeight: 510, visualOffsetTop: 120, scale: 1 }),
  ).toEqual({ keyboardOpen: true, height: 510, shift: 120 });
});

it("[UI-43] does not treat a pinch zoom or a small browser bar change as a keyboard", () => {
  expect(
    viewportState({ layoutHeight: 852, visualHeight: 420, visualOffsetTop: 0, scale: 2 })
      .keyboardOpen,
  ).toBe(false);
  expect(
    viewportState({ layoutHeight: 852, visualHeight: 800, visualOffsetTop: 0, scale: 1 })
      .keyboardOpen,
  ).toBe(false);
});
