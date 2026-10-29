import type { ReactNode } from "react";

const paths = {
  panel: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18m7-12-3 3 3 3" />
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
      <rect x="3.5" y="4" width="17" height="4.5" rx="1.2" />
      <path d="M5.5 8.5v10A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-10" />
      <path d="M12 11.5v5M9.8 14.3 12 16.5l2.2-2.2" />
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
      <path
        d="m9.2 3-.5 2.1-1.8 1.1-2.1-.6-2.8 4.8 1.6 1.5v2.1L2 15.5l2.8 4.8 2.1-.6 1.8 1.1.5 2.2h5.6l.5-2.2 1.8-1.1 2.1.6 2.8-4.8-1.6-1.5v-2.1l1.6-1.5-2.8-4.8-2.1.6-1.8-1.1-.5-2.1Z"
        transform="translate(1 0) scale(.92)"
      />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  compose: (
    <>
      <path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7" />
      <path d="m16 3 5 5M10 14l-1 4 4-1L22 8l-4-4Z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="7.5" />
      <path d="m16 16 5 5" />
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
  memory: (
    <>
      <path d="M6.5 3.5h11v17l-5.5-4-5.5 4Z" />
      <path d="M12 7.2l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z" />
    </>
  ),
  reminders: (
    <>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  files: <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />,
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
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
