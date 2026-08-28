import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IntlProvider, useIntl } from "react-intl";
import { CONTROL_CENTER_UI_LOCALES, type ControlCenterUiLocale } from "../browser-storage.js";
import type { MessageCatalog, MessageId } from "./message-ids.js";
import { messages as zhCNMessages } from "./resources/zh-CN.js";

export type UiLocale = ControlCenterUiLocale;
export const UI_LOCALES = CONTROL_CENTER_UI_LOCALES;

const catalogLoaders: Readonly<
  Record<UiLocale, () => Promise<{ readonly messages: MessageCatalog }>>
> = {
  en: () => import("./resources/en.js"),
  ja: () => import("./resources/ja.js"),
  "zh-CN": async () => ({ messages: zhCNMessages }),
};

const BOOTSTRAP_LOADING_LABELS: Readonly<Record<UiLocale, string>> = {
  en: "Loading Control Center",
  ja: "コントロールセンターを読み込み中",
  "zh-CN": zhCNMessages["bootstrap.loading"],
};

export function bootstrapLoadingLabel(locale: UiLocale): string {
  return BOOTSTRAP_LOADING_LABELS[locale];
}

export async function loadMessageCatalog(locale: UiLocale): Promise<MessageCatalog> {
  return (await catalogLoaders[locale]()).messages;
}

export interface ControlCenterIntlProviderProps {
  readonly children: ReactNode;
  readonly locale: UiLocale;
  readonly loadingLabel: string;
}

export function ControlCenterIntlProvider({
  children,
  loadingLabel,
  locale,
}: ControlCenterIntlProviderProps) {
  const [loaded, setLoaded] = useState<{
    readonly locale: UiLocale;
    readonly messages: MessageCatalog;
  }>(() => ({ locale: "zh-CN", messages: zhCNMessages }));
  const requestSequence = useRef(0);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
    if (loaded.locale === locale) return;
    const sequence = ++requestSequence.current;
    void loadMessageCatalog(locale).then((messages) => {
      if (sequence === requestSequence.current) setLoaded({ locale, messages });
    });
  }, [loaded.locale, locale]);

  if (loaded.locale !== locale) {
    return (
      <output aria-busy="true" aria-live="polite" className="bootstrap-status">
        {loadingLabel}
      </output>
    );
  }
  return (
    <IntlProvider
      defaultLocale={locale}
      locale={locale}
      messages={loaded.messages}
      onError={(error) => {
        throw error;
      }}
    >
      {children}
    </IntlProvider>
  );
}

export function useControlCenterIntl() {
  const intl = useIntl();
  const message = useCallback(
    (id: MessageId, values?: Record<string, string | number | boolean | Date>) =>
      intl.formatMessage({ id }, values),
    [intl],
  );
  return useMemo(
    () => ({
      dateTime: intl.formatDate,
      message,
      number: intl.formatNumber,
    }),
    [intl.formatDate, intl.formatNumber, message],
  );
}

export function pseudoLocalize(message: string): string {
  const substitutions: Readonly<Record<string, string>> = {
    a: "à",
    e: "ë",
    i: "ï",
    o: "ö",
    u: "ü",
    A: "À",
    E: "Ë",
    I: "Ï",
    O: "Ö",
    U: "Ü",
  };
  let depth = 0;
  let expanded = "";
  for (const character of message) {
    if (character === "{") {
      depth += 1;
      expanded += character;
      continue;
    }
    if (character === "}") {
      expanded += character;
      depth = Math.max(0, depth - 1);
      continue;
    }
    expanded += depth > 0 ? character : (substitutions[character] ?? character);
  }
  return `［${expanded}～～～～］`;
}
