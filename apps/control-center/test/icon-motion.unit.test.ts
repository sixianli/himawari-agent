import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ToolIcon, toolCategory } from "../src/components/tool-icon.js";

it("[ICON-MOTION-4] searching and reading the web share one icon, and file search keeps its own", () => {
  const glyph = (name: string) =>
    renderToStaticMarkup(createElement(ToolIcon, { name })).match(/data-glyph="(\w+)"/)?.[1];
  expect(glyph("web_search")).toBe("radar");
  expect(glyph("web_fetch")).toBe("radar");
  expect(glyph("read")).toBe("book");
  expect(glyph("write")).toBe("penBook");
  expect(glyph("grep")).toBe("search");
  expect(glyph("memory")).toBe("memory");
  expect(toolCategory("web_search")).toBe("web");
});
