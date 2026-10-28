import type { ReactNode } from "react";
const symbols = {
  review: (
    <>
      <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  read: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6m-6 8 3 3" />
      <circle cx="11" cy="13" r="3" />
    </>
  ),
  write: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 15h8m-4-4v8" />
    </>
  ),
  edit: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5m-11 7-1 4 4-1L22 9l-4-4Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  page: (
    <>
      <path d="M6.5 3.5h7l4 4v13h-11Z" />
      <path d="M13.5 3.5v4h4M9 12h6M9 15.5h6" />
    </>
  ),
  web: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5Z" />
    </>
  ),
  browser: (
    <>
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <path d="M2 9h20M6 6h.01M10 6h.01" />
    </>
  ),
  bash: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="m7.5 10 2.5 2-2.5 2M12.5 15h4" />
    </>
  ),
  memory: (
    <>
      <path d="M6.5 3.5h11v17l-5.5-4-5.5 4Z" />
      <path d="M12 7.2l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z" />
    </>
  ),
  answer: (
    <>
      <path d="M4 19.5h16" />
      <path d="M6 16l9.5-9.5a2 2 0 0 1 3 3L9 19H6Z" />
    </>
  ),
  you: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0" />
    </>
  ),
  delegate: (
    <>
      <rect x="2" y="2" width="7" height="7" rx="1" />
      <rect x="15" y="15" width="7" height="7" rx="1" />
      <path d="M5 9v9h10m0-13h4v10" />
    </>
  ),
  thinking: (
    <>
      <path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7Z" />
      <path d="M18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
    </>
  ),
  note: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </>
  ),
  unknown: (
    <>
      <path d="m14 6 4 4 4-4a7 7 0 0 1-9 9l-7 7-4-4 7-7a7 7 0 0 1 9-9Z" />
    </>
  ),
} satisfies Record<string, ReactNode>;
export function toolCategory(name: string): keyof typeof symbols {
  const value = name.toLowerCase().split(/[.:/]/).at(-1) ?? name;
  if (/^(read|read_file|readfile)$/.test(value)) return "read";
  if (/^(write|write_file|create_file)$/.test(value)) return "write";
  if (/^(edit|apply_patch|edit_file|patch)$/.test(value)) return "edit";
  if (/^(bash|exec|exec_command|shell|terminal)$/.test(value)) return "bash";
  if (/browser|navigate|screenshot/.test(value)) return "browser";
  if (/fetch|browse/.test(value)) return "page";
  if (/grep|glob|find|search/.test(value)) return "search";
  if (/web|exa/.test(value)) return "web";
  if (/^(memory|recall)$/.test(value)) return "memory";
  if (/sql|database|memory|recall/.test(value)) return "database";
  if (/delegate|spawn|worker/.test(value)) return "delegate";
  return "unknown";
}
export type ToolGlyph = keyof typeof symbols;
export function ToolIcon({ name, glyph }: { name: string; glyph?: ToolGlyph | undefined }) {
  const category = glyph ?? toolCategory(name);
  return (
    <svg
      className="tool-icon"
      data-tool-category={category}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {symbols[category]}
    </svg>
  );
}
