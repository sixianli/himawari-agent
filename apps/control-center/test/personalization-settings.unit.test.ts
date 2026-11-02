// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AutoMemorySetting } from "../src/components/personalization-settings.js";
import type { MemoryModel } from "../src/memory.js";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const message = (id: string) => id;
const model = (overview: unknown, setPaused = vi.fn()) =>
  ({ overview, busy: false, setPaused }) as unknown as MemoryModel;

it("[UI-B15] hides the auto-memory switch until the real setting has been read", () => {
  act(() => root.render(h(AutoMemorySetting, { memory: model(undefined), message })));
  expect(container.querySelector("[role=switch]")).toBeNull();
  expect(container.textContent).toBe("");
});

it("[UI-B15] shows the read setting and flips it on click", () => {
  const setPaused = vi.fn();
  act(() =>
    root.render(
      h(AutoMemorySetting, { memory: model({ capturePaused: true }, setPaused), message }),
    ),
  );
  const toggle = container.querySelector<HTMLInputElement>("[role=switch]");
  expect(toggle?.checked).toBe(false);
  act(() => toggle?.click());
  expect(setPaused).toHaveBeenCalledWith(false);
});
