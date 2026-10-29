// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TextEditor } from "../src/components/memory-panel.js";
import type { MessageId } from "../src/i18n/message-ids.js";

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

const message = (id: MessageId) => id;

async function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(textarea: HTMLTextAreaElement, init: KeyboardEventInit) {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

it("keeps save off until the text changes, saves with Ctrl+Enter and cancels with Escape", async () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  await act(async () =>
    root.render(h(TextEditor, { initial: "喜欢美式", busy: false, message, onSave, onCancel })),
  );
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const save = container.querySelector<HTMLButtonElement>(".edit-save");
  const cancel = container.querySelector<HTMLButtonElement>(".action-button-secondary");
  expect(save?.textContent).toBe("memory.save");
  expect(cancel?.textContent).toBe("governed.cancel");
  expect(save?.disabled).toBe(true);
  await key(textarea, { key: "Enter", ctrlKey: true });
  expect(onSave).not.toHaveBeenCalled();
  await type(textarea, "喜欢美式 ");
  expect(save?.disabled).toBe(true);
  await type(textarea, "喜欢冰美式");
  expect(save?.disabled).toBe(false);
  await key(textarea, { key: "Enter", ctrlKey: true });
  expect(onSave).toHaveBeenCalledWith("喜欢冰美式");
  await key(textarea, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);
});
