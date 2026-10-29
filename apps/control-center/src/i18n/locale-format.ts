import { useContext, useMemo } from "react";
import { IntlContext } from "react-intl";

type Moment = string | number | Date;

export const DEFAULT_UI_LOCALE = "zh-CN";

export function localeFormat(locale: string) {
  const date = (value: Moment, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(new Date(value));
  return {
    locale,
    day: (value: Moment) => date(value, { year: "numeric", month: "numeric", day: "numeric" }),
    dayHeading: (value: Moment) => date(value, { month: "long", day: "numeric", weekday: "short" }),
    moment: (value: Moment, now: Date = new Date()) =>
      date(value, {
        ...(new Date(value).getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    full: (value: Moment) =>
      date(value, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    clock: (value: Moment) =>
      date(value, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    clockShort: (value: Moment) => date(value, { hour: "2-digit", minute: "2-digit" }),
    number: (value: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale, options).format(value),
  };
}

export type LocaleFormat = ReturnType<typeof localeFormat>;

export function useLocaleFormat(): LocaleFormat {
  const locale = useContext(IntlContext)?.locale ?? DEFAULT_UI_LOCALE;
  return useMemo(() => localeFormat(locale), [locale]);
}
