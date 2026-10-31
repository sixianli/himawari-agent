import { LineGlyph, type LinePath } from "./line-icons.js";

const glyphs = {
  panel: "panel",
  menu: "menu",
  pin: "pin",
  archive: "archive",
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
} satisfies Record<string, LinePath>;

export function SidebarIcon({ name }: { readonly name: keyof typeof glyphs }) {
  return <LineGlyph className="sidebar-icon" name={glyphs[name]} size={20} />;
}
