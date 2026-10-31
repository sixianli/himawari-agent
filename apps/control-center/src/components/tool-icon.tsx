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
      <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" />
    </>
  ),
  write: (
    <>
      <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3.5V8h4.5M12 11v6M9 14h6" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h8" />
      <path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
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
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
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
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="m7.5 9.5 3 2.5-3 2.5M13 15h4" />
    </>
  ),
  memory: (
    <>
      <path d="M7 3.5h10A1.5 1.5 0 0 1 18.5 5v15L12 16l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z" />
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
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" />
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
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {symbols[category]}
    </svg>
  );
}
