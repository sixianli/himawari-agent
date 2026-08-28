export interface ControlCenterPreferences {
  readonly density: "comfortable" | "compact";
  readonly detailPanePercent: number;
  readonly listPanePercent: number;
  readonly theme: "system" | "light" | "dark";
}

export const CONTROL_CENTER_UI_LOCALES = ["zh-CN", "en", "ja"] as const;
export type ControlCenterUiLocale = (typeof CONTROL_CENTER_UI_LOCALES)[number];

const KEY_PREFIX = "himawari.control-center.v1";
const CURSOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface PendingThreadMutation {
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly threadId: string;
}

export interface PendingGovernanceMutation {
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly objectRef: string;
  readonly expectedRevision: number;
}

export const THREAD_CURSOR_STORAGE_KEY = `${KEY_PREFIX}.threadLastCursor`;
export const GOVERNANCE_MUTATION_STORAGE_PREFIX = `${KEY_PREFIX}.governanceMutation.`;

export class ControlCenterBrowserStorage {
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  readDraft(threadId: string): string {
    return this.storage.getItem(`${KEY_PREFIX}.draft.${threadId}`) ?? "";
  }

  saveDraft(threadId: string, draft: string): void {
    if (!CURSOR_PATTERN.test(threadId) || draft.length > 64 * 1024) {
      throw new Error("CONTROL_CENTER_DRAFT_INVALID");
    }
    if (draft.length === 0) this.storage.removeItem(`${KEY_PREFIX}.draft.${threadId}`);
    else this.storage.setItem(`${KEY_PREFIX}.draft.${threadId}`, draft);
  }

  readLastCursor(): string | null {
    const value = this.storage.getItem(`${KEY_PREFIX}.lastCursor`);
    return value && CURSOR_PATTERN.test(value) ? value : null;
  }

  saveLastCursor(cursor: string): void {
    if (!CURSOR_PATTERN.test(cursor)) throw new Error("CONTROL_CENTER_CURSOR_INVALID");
    this.storage.setItem(`${KEY_PREFIX}.lastCursor`, cursor);
  }

  clearLastCursor(): void {
    this.storage.removeItem(`${KEY_PREFIX}.lastCursor`);
  }

  readThreadLastCursor(): string | null {
    const value = this.storage.getItem(THREAD_CURSOR_STORAGE_KEY);
    return value && CURSOR_PATTERN.test(value) ? value : null;
  }

  saveThreadLastCursor(cursor: string): void {
    if (!CURSOR_PATTERN.test(cursor)) throw new Error("CONTROL_CENTER_CURSOR_INVALID");
    this.storage.setItem(THREAD_CURSOR_STORAGE_KEY, cursor);
  }

  clearThreadLastCursor(): void {
    this.storage.removeItem(THREAD_CURSOR_STORAGE_KEY);
  }

  readPendingThreadMutation(operationKey: string): PendingThreadMutation | null {
    if (!CURSOR_PATTERN.test(operationKey)) return null;
    const raw = this.storage.getItem(`${KEY_PREFIX}.mutation.${operationKey}`);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<PendingThreadMutation>;
      if (
        value.operationKey !== operationKey ||
        !CURSOR_PATTERN.test(value.idempotencyKey ?? "") ||
        !CURSOR_PATTERN.test(value.commandType ?? "") ||
        !CURSOR_PATTERN.test(value.threadId ?? "")
      ) {
        return null;
      }
      return value as PendingThreadMutation;
    } catch {
      return null;
    }
  }

  savePendingThreadMutation(mutation: PendingThreadMutation): void {
    if (
      !CURSOR_PATTERN.test(mutation.operationKey) ||
      !CURSOR_PATTERN.test(mutation.idempotencyKey) ||
      !CURSOR_PATTERN.test(mutation.commandType) ||
      !CURSOR_PATTERN.test(mutation.threadId)
    ) {
      throw new Error("CONTROL_CENTER_MUTATION_IDENTITY_INVALID");
    }
    this.storage.setItem(
      `${KEY_PREFIX}.mutation.${mutation.operationKey}`,
      JSON.stringify(mutation),
    );
  }

  clearPendingThreadMutation(operationKey: string): void {
    if (!CURSOR_PATTERN.test(operationKey)) return;
    this.storage.removeItem(`${KEY_PREFIX}.mutation.${operationKey}`);
  }

  readPendingGovernanceMutation(operationKey: string): PendingGovernanceMutation | null {
    if (!CURSOR_PATTERN.test(operationKey)) return null;
    const raw = this.storage.getItem(`${GOVERNANCE_MUTATION_STORAGE_PREFIX}${operationKey}`);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<PendingGovernanceMutation>;
      if (
        value.operationKey !== operationKey ||
        !CURSOR_PATTERN.test(value.idempotencyKey ?? "") ||
        !CURSOR_PATTERN.test(value.commandType ?? "") ||
        !CURSOR_PATTERN.test(value.objectRef ?? "") ||
        !Number.isSafeInteger(value.expectedRevision) ||
        (value.expectedRevision as number) < 1
      ) {
        return null;
      }
      return value as PendingGovernanceMutation;
    } catch {
      return null;
    }
  }

  savePendingGovernanceMutation(mutation: PendingGovernanceMutation): void {
    if (
      !CURSOR_PATTERN.test(mutation.operationKey) ||
      !CURSOR_PATTERN.test(mutation.idempotencyKey) ||
      !CURSOR_PATTERN.test(mutation.commandType) ||
      !CURSOR_PATTERN.test(mutation.objectRef) ||
      !Number.isSafeInteger(mutation.expectedRevision) ||
      mutation.expectedRevision < 1
    ) {
      throw new Error("CONTROL_CENTER_MUTATION_IDENTITY_INVALID");
    }
    this.storage.setItem(
      `${GOVERNANCE_MUTATION_STORAGE_PREFIX}${mutation.operationKey}`,
      JSON.stringify(mutation),
    );
  }

  clearPendingGovernanceMutation(operationKey: string): void {
    if (!CURSOR_PATTERN.test(operationKey)) return;
    this.storage.removeItem(`${GOVERNANCE_MUTATION_STORAGE_PREFIX}${operationKey}`);
  }

  readPreferences(): ControlCenterPreferences {
    const fallback: ControlCenterPreferences = {
      density: "comfortable",
      detailPanePercent: 24,
      listPanePercent: 26,
      theme: "system",
    };
    const raw = this.storage.getItem(`${KEY_PREFIX}.preferences`);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Partial<ControlCenterPreferences>;
      return {
        density: parsed.density === "compact" ? "compact" : "comfortable",
        detailPanePercent: boundedPanePercent(parsed.detailPanePercent, 24),
        listPanePercent: boundedPanePercent(parsed.listPanePercent, 26),
        theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : "system",
      };
    } catch {
      return fallback;
    }
  }

  savePreferences(preferences: ControlCenterPreferences): void {
    this.storage.setItem(
      `${KEY_PREFIX}.preferences`,
      JSON.stringify({
        ...preferences,
        detailPanePercent: boundedPanePercent(preferences.detailPanePercent, 24),
        listPanePercent: boundedPanePercent(preferences.listPanePercent, 26),
      }),
    );
  }

  readLocale(preferredLanguages: readonly string[] = []): ControlCenterUiLocale {
    const stored = this.storage.getItem(`${KEY_PREFIX}.locale`);
    if (isUiLocale(stored)) return stored;
    for (const language of preferredLanguages) {
      const normalized = normalizeLocale(language);
      if (normalized) return normalized;
    }
    return "zh-CN";
  }

  saveLocale(locale: ControlCenterUiLocale): void {
    if (!isUiLocale(locale)) throw new Error("CONTROL_CENTER_LOCALE_INVALID");
    this.storage.setItem(`${KEY_PREFIX}.locale`, locale);
  }
}

function boundedPanePercent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(40, Math.max(18, Math.round(value)))
    : fallback;
}

function isUiLocale(value: unknown): value is ControlCenterUiLocale {
  return CONTROL_CENTER_UI_LOCALES.includes(value as ControlCenterUiLocale);
}

function normalizeLocale(value: string): ControlCenterUiLocale | null {
  const normalized = value.toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-cn") || normalized.startsWith("zh-hans")) {
    return "zh-CN";
  }
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  return null;
}
