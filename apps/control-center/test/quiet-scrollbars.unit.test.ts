// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installQuietScrollbars } from "../src/quiet-scrollbars.js";

afterEach(() => vi.useRealTimers());

it("[UI-13] shows a scrollbar only while that area is being scrolled", () => {
  vi.useFakeTimers();
  const area = document.createElement("div");
  const other = document.createElement("div");
  document.body.append(area, other);
  const uninstall = installQuietScrollbars(document);
  area.dispatchEvent(new Event("scroll"));
  expect(area.hasAttribute("data-scrolling")).toBe(true);
  expect(other.hasAttribute("data-scrolling")).toBe(false);
  vi.advanceTimersByTime(600);
  area.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(600);
  expect(area.hasAttribute("data-scrolling")).toBe(true);
  vi.advanceTimersByTime(400);
  expect(area.hasAttribute("data-scrolling")).toBe(false);
  uninstall();
  area.dispatchEvent(new Event("scroll"));
  expect(area.hasAttribute("data-scrolling")).toBe(false);
});
