import type { ReactNode } from "react";

const paths = {
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  pin: (
    <>
      <path d="M9 3.5h6l-1 5.5 3.5 3.5h-11L10 9Z" />
      <path d="M12 12.5v8" />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4" width="17" height="4.5" rx="1.5" />
      <path d="M5.5 8.5v9.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),
  rename: (
    <>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m14.5 7.5 3 3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1V4a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  compose: (
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
  refresh: (
    <>
      <path d="M20 7V2m0 5h-5M4 17v5m0-5h5" />
      <path d="M4 8a8.5 8.5 0 0 1 14-4l2 3M4 17l2 3a8.5 8.5 0 0 0 14-4" />
    </>
  ),
  manage: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
  approvals: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  memory: <path d="M7 3.5h10A1.5 1.5 0 0 1 18.5 5v15L12 16l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z" />,
  reminders: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15Z" />
      <path d="M10 21h4" />
    </>
  ),
  files: (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export function SidebarIcon({ name }: { readonly name: keyof typeof paths }) {
  return (
    <svg
      className="sidebar-icon"
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
