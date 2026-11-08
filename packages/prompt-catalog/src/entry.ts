export type PromptLayer =
  | "tools"
  | "system"
  | "appended-message"
  | "tool-result"
  | "last-user-message"
  | "background"
  | "embedding";

export type PromptSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "slot"; readonly name: string };

export interface PromptEntry {
  readonly id: string;
  readonly purpose: string;
  readonly usedBy: readonly string[];
  readonly layer: PromptLayer;
  readonly output: "free-text" | "json" | "structured-choice";
  readonly parser?: string;
  readonly segments: readonly PromptSegment[];
}

export function fixedPrompt<
  const Entry extends Omit<PromptEntry, "segments"> & { readonly text: string },
>(
  entry: Entry,
): Omit<Entry, "text"> & { readonly text: string; readonly segments: readonly PromptSegment[] } {
  const segments: readonly PromptSegment[] = Object.freeze([{ kind: "text", text: entry.text }]);
  return Object.freeze({ ...entry, text: entry.text as string, segments });
}

export const text = (value: string): PromptSegment => Object.freeze({ kind: "text", text: value });
export const slot = (name: string): PromptSegment => Object.freeze({ kind: "slot", name });

export function templatePrompt<const Entry extends PromptEntry>(entry: Entry): Entry {
  return Object.freeze({ ...entry, segments: Object.freeze([...entry.segments]) });
}

export function renderPrompt(
  entry: Pick<PromptEntry, "id" | "segments">,
  values: Readonly<Record<string, string>> = {},
): string {
  const expected = entry.segments.flatMap((segment) =>
    segment.kind === "slot" ? [segment.name] : [],
  );
  for (const name of Object.keys(values))
    if (!expected.includes(name)) throw new Error(`PROMPT_SLOT_UNKNOWN ${entry.id} ${name}`);
  return entry.segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      const value = values[segment.name];
      if (value === undefined) throw new Error(`PROMPT_SLOT_MISSING ${entry.id} ${segment.name}`);
      return value;
    })
    .join("");
}

export const TRUSTED_TEXT_MINIMUM_LENGTH = 24;

export function trustedPromptTexts(entries: readonly unknown[]): readonly string[] {
  const texts = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("segments" in entry)) continue;
    const segments = (entry as { readonly segments: unknown }).segments;
    if (!Array.isArray(segments)) continue;
    for (const segment of segments as readonly PromptSegment[])
      if (segment.kind === "text" && [...segment.text].length >= TRUSTED_TEXT_MINIMUM_LENGTH)
        texts.add(segment.text);
  }
  return Object.freeze(
    [...texts].sort(
      (left, right) => [...right].length - [...left].length || (left < right ? -1 : 1),
    ),
  );
}
