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
      <circle cx="10.5" cy="10.5" r="7.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  web: (
    <>
      <circle cx="12" cy="12" r="10" />
      <ellipse cx="12" cy="12" rx="4" ry="10" />
      <path d="M2 12h20" />
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
      <path d="m4 5 6 7-6 7m9 0h7" />
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
      <path d="M12 18V5a3 3 0 0 0-6-1 4 4 0 0 0-3 6 4 4 0 0 0 1 7 4 4 0 0 0 8 2m0-14a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1-1 7 4 4 0 0 1-8 2M6 9l-2 1m14-1 2 1" />
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
  if (/web|exa|fetch|browse/.test(value)) return "web";
  if (/grep|glob|find|search/.test(value)) return "search";
  if (/sql|database/.test(value)) return "database";
  if (/delegate|spawn|worker/.test(value)) return "delegate";
  return "unknown";
}
export function ToolIcon({
  name,
  thinking = false,
  review = false,
}: {
  name: string;
  thinking?: boolean;
  review?: boolean;
}) {
  const category = review ? "review" : thinking ? "thinking" : toolCategory(name);
  return (
    <svg
      className="tool-icon"
      data-tool-category={category}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {symbols[category]}
    </svg>
  );
}
