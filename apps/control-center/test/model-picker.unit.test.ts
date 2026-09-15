// @vitest-environment jsdom
import { act, useState, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { ModelPicker } from "../src/components/model-picker.js";
import type { AvailableModel } from "../src/gateway-client.js";
let root: Root, container: HTMLDivElement;
const models: AvailableModel[] = [
  {
    ref: "primary",
    provider: "fixture",
    model: "primary",
    name: "Configured primary",
    thinkingLevels: ["minimal", "medium", "high"],
  },
  {
    ref: "secondary",
    provider: "fixture",
    model: "secondary",
    name: "Configured secondary",
    thinkingLevels: ["off"],
  },
];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(available = models) {
  function View() {
    const [model, setModel] = useState("primary");
    const [thinking, setThinking] = useState("medium");
    return h(ModelPicker, {
      models: available,
      modelRef: model,
      thinkingLevel: thinking,
      onModelChange: setModel,
      onThinkingChange: setThinking,
      message: (id) => id,
    });
  }
  await act(async () => root.render(h(View)));
  const details = container.querySelector("details");
  if (!details) throw new Error("missing picker");
  details.open = true;
  return details;
}
it("keeps the model panel open when the selected option is removed by the same click", async () => {
  const details = await render();
  const button = container.querySelector<HTMLButtonElement>(".picker-model-name");
  await act(async () => button?.click());
  const second = container.querySelectorAll<HTMLButtonElement>(".model-options button")[1];
  await act(async () => second?.click());
  expect(details.open).toBe(true);
  expect(container.querySelector(".model-name")?.textContent).toBe("Configured secondary");
  expect(container.querySelector("input[type=range]")).toBeNull();
  expect(container.textContent).not.toContain("自动推理模型");
});
it("exposes only configured discrete levels and changes only the draft selection", async () => {
  await render();
  const slider = container.querySelector<HTMLInputElement>("input[type=range]");
  if (!slider) throw new Error("missing slider");
  expect([slider.min, slider.max, slider.step, slider.value]).toEqual(["0", "2", "1", "1"]);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "2");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(slider.getAttribute("aria-valuetext")).toBe("review.effort.high");
  expect(container.querySelector(".depth-label")?.textContent).toBe("review.effort.high");
});
it("does not invent a model submenu for a single configured model", async () => {
  await render(models.slice(0, 1));
  expect(container.querySelector("button.picker-model-name")).toBeNull();
  expect(container.querySelector(".picker-model-name")?.textContent).toBe("Configured primary");
  expect(container.querySelector(".model-options")).toBeNull();
});
