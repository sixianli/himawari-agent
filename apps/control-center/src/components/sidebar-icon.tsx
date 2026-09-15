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
      <path d="m16 3 5 5-4 1-2 5-3 1-3 5-1-1 3-5-1-3 5-2Z" />
      <path d="m3 21 6-6" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="3" width="18" height="5" rx="1" />
      <path d="M5 8v12h14V8m-9 4h4" />
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
