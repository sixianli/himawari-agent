import { Glyph, type GlyphName } from "./glyphs.js";

const glyphs = {
  panel: "panel",
  menu: "menu",
  pin: "pin",
  archive: "archive",
  trash: "trash",
  rename: "rename",
  settings: "settings",
  compose: "compose",
  search: "search",
  refresh: "refresh",
  manage: "manage",
  approvals: "shield",
  memory: "memory",
  reminders: "reminders",
  files: "files",
  more: "more",
} satisfies Record<string, GlyphName>;

export function SidebarIcon({ name }: { readonly name: keyof typeof glyphs }) {
  return <Glyph className="sidebar-icon" name={glyphs[name]} size={20} />;
}
