export interface ControlCenterPreferences {
  readonly density: "comfortable" | "compact";
  readonly theme: "system" | "light" | "dark";
}

const KEY_PREFIX = "himawari.control-center.v1";
const CURSOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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

  readPreferences(): ControlCenterPreferences {
    const fallback: ControlCenterPreferences = { density: "comfortable", theme: "system" };
    const raw = this.storage.getItem(`${KEY_PREFIX}.preferences`);
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Partial<ControlCenterPreferences>;
      return {
        density: parsed.density === "compact" ? "compact" : "comfortable",
        theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : "system",
      };
    } catch {
      return fallback;
    }
  }

  savePreferences(preferences: ControlCenterPreferences): void {
    this.storage.setItem(`${KEY_PREFIX}.preferences`, JSON.stringify(preferences));
  }
}
