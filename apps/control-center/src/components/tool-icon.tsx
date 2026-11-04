import { Glyph, type GlyphName } from "./glyphs.js";

const symbols = {
  review: "checklist",
  read: "book",
  write: "penBook",
  edit: "compose",
  search: "search",
  page: "radar",
  web: "radar",
  browser: "browser",
  bash: "terminal",
  memory: "memory",
  answer: "answer",
  you: "person",
  database: "database",
  delegate: "delegate",
  thinking: "think",
  note: "note",
  unknown: "wrench",
} satisfies Record<string, GlyphName>;
export function toolCategory(name: string): keyof typeof symbols {
  const value = name.toLowerCase().split(/[.:/]/).at(-1) ?? name;
  if (/^(read|read_file|readfile)$/.test(value)) return "read";
  if (/^(write|write_file|create_file)$/.test(value)) return "write";
  if (/^(edit|apply_patch|edit_file|patch)$/.test(value)) return "edit";
  if (/^(bash|exec|exec_command|shell|terminal)$/.test(value)) return "bash";
  if (/browser|navigate|screenshot/.test(value)) return "browser";
  if (/fetch|browse/.test(value)) return "page";
  if (/web|exa/.test(value)) return "web";
  if (/grep|glob|find|search/.test(value)) return "search";
  if (/^(memory|recall)$/.test(value)) return "memory";
  if (/sql|database|memory|recall/.test(value)) return "database";
  if (/delegate|spawn|worker/.test(value)) return "delegate";
  return "unknown";
}
export type ToolGlyph = keyof typeof symbols;
export function ToolIcon({ name, glyph }: { name: string; glyph?: ToolGlyph | undefined }) {
  const category = glyph ?? toolCategory(name);
  return <Glyph className="tool-icon" data-tool-category={category} name={symbols[category]} />;
}
