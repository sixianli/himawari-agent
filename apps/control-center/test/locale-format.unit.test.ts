// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { type LocaleFormat, useLocaleFormat } from "../src/i18n/locale-format.js";

function formatted(locale: string, use: (format: LocaleFormat) => string): string {
  const element = document.createElement("div");
  const root = createRoot(element);
  function Probe() {
    return createElement("span", null, use(useLocaleFormat()));
  }
  act(() =>
    root.render(createElement(IntlProvider, { locale, messages: {} }, createElement(Probe))),
  );
  const text = element.textContent ?? "";
  act(() => root.unmount());
  return text;
}

describe("dates and times follow the interface language", () => {
  it("writes Chinese and Japanese dates without English month, weekday or AM/PM words", () => {
    const at = "2026-10-29T02:55:24Z";
    const english =
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun|AM|PM)/;
    for (const locale of ["zh-CN", "ja"]) {
      const texts = [
        formatted(locale, (format) => format.dayHeading(at)),
        formatted(locale, (format) => format.moment(at, new Date("2026-01-01T00:00:00Z"))),
        formatted(locale, (format) => format.clock(at)),
        formatted(locale, (format) => format.full(at)),
      ];
      for (const text of texts) expect(text).not.toMatch(english);
    }
    expect(formatted("en", (format) => format.dayHeading(at))).toMatch(/Thu/);
  });
});
