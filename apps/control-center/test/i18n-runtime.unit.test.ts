import { createIntl, createIntlCache } from "react-intl";
import { describe, expect, it } from "vitest";
import { ControlCenterBrowserStorage } from "../src/browser-storage.js";
import {
  MESSAGE_IDS,
  MESSAGE_SAMPLE_VALUES,
  type MessageCatalog,
} from "../src/i18n/message-ids.js";
import { bootstrapLoadingLabel, loadMessageCatalog, pseudoLocalize } from "../src/i18n/runtime.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

async function catalog(locale: "zh-CN" | "en" | "ja") {
  return await loadMessageCatalog(locale);
}

function assertCatalogFormats(locale: "zh-CN" | "en" | "ja", messages: MessageCatalog) {
  const errors: string[] = [];
  const intl = createIntl(
    {
      defaultLocale: locale,
      locale,
      messages,
      onError: (error) => errors.push(String(error)),
    },
    createIntlCache(),
  );
  for (const id of MESSAGE_IDS) {
    const formatted = intl.formatMessage({ id }, MESSAGE_SAMPLE_VALUES[id]);
    expect(formatted, `${locale}:${id}`).not.toBe(id);
    expect(formatted.trim(), `${locale}:${id}`).not.toBe("");
  }
  expect(errors).toEqual([]);
}

describe("control-center i18n runtime", () => {
  it("keeps bootstrap loading labels aligned with each locale catalog", async () => {
    for (const locale of ["zh-CN", "en", "ja"] as const) {
      expect(bootstrapLoadingLabel(locale)).toBe((await catalog(locale))["bootstrap.loading"]);
    }
  });

  it("ships the same complete key set and valid ICU messages for all three locales", async () => {
    for (const locale of ["zh-CN", "en", "ja"] as const) {
      const messages = await catalog(locale);
      expect(Object.keys(messages).sort()).toEqual([...MESSAGE_IDS].sort());
      assertCatalogFormats(locale, messages);
    }
  });

  it("executes plural branches and locale-aware number/date formatting", async () => {
    for (const locale of ["zh-CN", "en", "ja"] as const) {
      const intl = createIntl({ locale, messages: await catalog(locale) }, createIntlCache());
      const one = intl.formatMessage({ id: "objects.count" }, { count: 1 });
      const many = intl.formatMessage({ id: "objects.count" }, { count: 12 });
      expect(one).toContain("1");
      expect(many).toContain("12");
      expect(intl.formatDate("2026-08-28T03:00:00.000Z", { timeZone: "Asia/Tokyo" })).not.toBe("");
      expect(intl.formatNumber(1234567.89)).not.toBe("");
    }
  });

  it("initializes from browser preference, persists only locally and rejects invalid locale", () => {
    const raw = new MemoryStorage();
    const storage = new ControlCenterBrowserStorage(raw);
    expect(storage.readLocale(["fr-FR", "ja-JP"])).toBe("ja");
    storage.saveLocale("en");
    expect(storage.readLocale(["zh-CN"])).toBe("en");
    expect(raw.getItem("himawari.control-center.v1.locale")).toBe("en");
    expect(() => storage.saveLocale("fr" as never)).toThrow("CONTROL_CENTER_LOCALE_INVALID");
  });

  it("expands visible text for pseudo-localization without corrupting ICU arguments", () => {
    const source = "There are {count, plural, one {# item} other {# items}}";
    const pseudo = pseudoLocalize(source);
    expect(pseudo).toContain("{count, plural, one {# item} other {# items}}");
    expect(pseudo.length).toBeGreaterThan(source.length);
    expect(pseudo).toMatch(/^［.+］$/);
  });
});
