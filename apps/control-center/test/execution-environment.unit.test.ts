// @vitest-environment jsdom
import type { ThreadExecutionEnvironment } from "@himawari-agent/gateway-contracts";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionEnvironmentLine } from "../src/components/execution-environment.js";
import type { MessageId } from "../src/i18n/message-ids.js";
import { messages } from "../src/i18n/resources/zh-CN.js";

let root: Root, container: HTMLDivElement;
const message = (id: MessageId, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    messages[id] as string,
  );
const program = {
  threadId: "thread-1",
  kind: "background",
  toolName: "dev-server",
  startedAt: "2026-10-25T12:04:00.000Z",
} as ThreadExecutionEnvironment["programs"][number];

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

async function render(environment: ThreadExecutionEnvironment | undefined) {
  await act(async () =>
    root.render(
      h(ExecutionEnvironmentLine, {
        environment,
        threadTitle: () => "研究记录",
        onOpen: () => {},
        onOpenThread: () => {},
        message,
      }),
    ),
  );
  return container.querySelector<HTMLButtonElement>(".environment-line > button");
}

it("stays hidden in default mode while no background program runs", async () => {
  expect(await render(undefined)).toBeNull();
  expect(await render({ mode: "srt", programs: [], unavailableTools: [] })).toBeNull();
  expect(container.textContent).toBe("");
});

it("shows running background programs in default mode without static mode filler", async () => {
  const button = await render({ mode: "srt", programs: [program], unavailableTools: [] });
  expect(button?.textContent).toBe("1 个后台程序在运行");
  await act(async () => button?.click());
  const panel = container.querySelector(".environment-panel");
  expect(panel?.querySelector("h3")?.textContent).toBe("仍在运行的程序");
  expect(panel?.textContent).toContain("dev-server");
  expect(panel?.textContent).toContain(messages["chat.environment.srtMeaning"]);
  expect(panel?.textContent).not.toContain("页面上不能切换");
  expect(panel?.textContent).not.toContain("工具可用情况");
});

it("keeps strict mode visible with its unavailable tools", async () => {
  const button = await render({
    mode: "strict",
    programs: [],
    unavailableTools: [{ toolName: "bash", reasonCode: "SANDBOX_OPERATION_SRT_ONLY" }],
  });
  expect(button?.textContent).toBe("严格模式 · 没有后台程序在运行");
  await act(async () => button?.click());
  const panel = container.querySelector(".environment-panel");
  expect(panel?.textContent).toContain("没有正在运行的程序。");
  expect(panel?.textContent).toContain("bash");
  expect(panel?.textContent).toContain(messages["chat.environment.strictNote"]);
});
