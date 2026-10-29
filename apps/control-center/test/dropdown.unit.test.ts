// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Dropdown } from "../src/components/primitives.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Language() {
  const [value, setValue] = useState<"zh-CN" | "en" | "ja">("zh-CN");
  return h(Dropdown<"zh-CN" | "en" | "ja">, {
    label: "界面语言",
    value,
    options: [
      { value: "zh-CN", label: "简体中文" },
      { value: "en", label: "English" },
      { value: "ja", label: "日本語" },
    ],
    onChange: setValue,
  });
}

const key = (target: Element, name: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

it("[UI-25] draws its own menu, moves with arrow keys and closes on Escape or outside", async () => {
  await act(async () => root.render(h(Language)));
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  if (!trigger) throw new Error("missing trigger");
  expect(container.querySelector("select")).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await key(trigger, "ArrowDown");
  const menu = container.querySelector('[role="listbox"]');
  if (!menu) throw new Error("menu did not open");
  expect(document.activeElement?.textContent).toBe("简体中文");
  await key(menu, "ArrowDown");
  expect(document.activeElement?.textContent).toBe("English");
  await key(menu, "ArrowUp");
  await key(menu, "ArrowUp");
  expect(document.activeElement?.textContent).toBe("日本語");
  await key(menu, "Escape");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => trigger.click());
  const japanese = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (option) => option.textContent === "日本語",
  );
  await act(async () => japanese?.click());
  expect(trigger.textContent).toBe("日本語");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
});
