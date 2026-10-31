const box = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}Z`;

const ring = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0Z`;

const sheet = "M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8ZM14 3.5V8h4.5";

export const linePaths = {
  compose: "M12 20h8M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z",
  rename: "M12 20h8M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z",
  search: `${ring(11, 11, 6.5)}M16 16l4 4`,
  memory: "M7 3.5h10A1.5 1.5 0 0 1 18.5 5v15L12 16l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z",
  reminders: "M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 21h4",
  files: "M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z",
  settings: `${ring(12, 12, 3)}M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1V4a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z`,
  panel: `${box(3.5, 4.5, 17, 15, 3)}M9.5 4.5v15`,
  widen: `${box(3.5, 4.5, 17, 15, 3)}M14.5 4.5v15`,
  menu: "M4.5 7h15M4.5 12h15M4.5 17h15",
  more: `${ring(6, 12, 1)}${ring(12, 12, 1)}${ring(18, 12, 1)}`,
  pin: "M9 3.5h6l-1 5.5 3.5 3.5h-11L10 9ZM12 12.5v8",
  archive: `${box(3.5, 4, 17, 4.5, 1.5)}M5.5 8.5V18a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5M10 12.5h4`,
  refresh:
    "M20 4.5V10h-5.5M4 19.5V14h5.5M5.5 9a7 7 0 0 1 12.6-2.2L20 10M4 14l1.9 3.2A7 7 0 0 0 18.5 15",
  manage: `M4 7h3M11 7h9M4 17h9M17 17h3${ring(9, 7, 2)}${ring(15, 17, 2)}`,
  shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8.5 12l2.5 2.5 4.5-5",
  copy: `${box(8.5, 8.5, 12, 12, 2.5)}M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5`,
  check: "M5 12.5l4.5 4.5L19 7.5",
  checkTwice: "M1.5 12.5l4.5 4.5L15.5 7.5M10 16l1 1 9.5-9.5",
  fork: `${ring(6, 5.5, 2.2)}${ring(6, 18.5, 2.2)}${ring(18, 8, 2.2)}M6 7.7v8.6M18 10.2c0 4-6 3.5-11 6.4`,
  chevron: "M9.5 6l6 6-6 6",
  back: "M14.5 6l-6 6 6 6",
  down: "M6 9.5l6 6 6-6",
  file: sheet,
  document: `${sheet}M9 13h6M9 16.5h4`,
  write: `${sheet}M12 11v6M9 14h6`,
  image: `${box(3.5, 4.5, 17, 15, 3)}M4 16.5l4.5-4 4 3.5 3-2.5 4.5 4${ring(9, 9.5, 1.5)}`,
  terminal: `${box(3, 4.5, 18, 15, 3)}M7.5 9.5l3 2.5-3 2.5M13 15h4`,
  stop: box(7, 7, 10, 10, 2),
  alert: `${ring(12, 12, 9)}M12 7.5V13M12 16.5v.01`,
  info: `${ring(12, 12, 9)}M12 11v5.5M12 7.5v.01`,
  external:
    "M14 4.5h5.5V10M19.5 4.5l-8 8M18 13.5V17a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 17V8.5A2.5 2.5 0 0 1 7 6h3.5",
  arrowDown: "M12 5v14M6.5 13.5L12 19l5.5-5.5",
  send: "M12 19V5M6 11l6-6 6 6",
  plus: "M12 5v14M5 12h14",
  download: "M12 4.5v10M7.5 10l4.5 4.5 4.5-4.5M5 19.5h14",
  upload: "M12 15V4.5M7.5 9L12 4.5 16.5 9M5 19.5h14",
  expand: "M14.5 4.5h5v5M19.5 4.5L14 10M9.5 19.5h-5v-5M4.5 19.5L10 14",
  collapse: "M19.5 4.5L14 10M14 5.5V10h4.5M4.5 19.5L10 14M10 18.5V14H5.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 21h4",
  mail: `${box(3, 5, 18, 14, 3)}M3.5 7.5l8.5 6 8.5-6`,
  globe: `${ring(12, 12, 9)}M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18`,
  grid: `${box(4, 4, 7, 7, 2)}${box(13, 4, 7, 7, 2)}${box(4, 13, 7, 7, 2)}${box(13, 13, 7, 7, 2)}`,
  table: `${box(3.5, 5, 17, 14, 3)}M3.5 10h17M3.5 14.5h17M10 10v9`,
  code: "M8.5 8l-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13",
  lock: `${box(5, 11, 14, 9.5, 2.5)}M8 11V8a4 4 0 0 1 8 0v3`,
  clock: `${ring(12, 12, 8)}M12 8v4l2.5 2`,
  think:
    "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z",
  person: `${ring(12, 8.5, 3.5)}M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5`,
  database:
    "M3.5 6c0-1.7 3.8-3 8.5-3s8.5 1.3 8.5 3-3.8 3-8.5 3-8.5-1.3-8.5-3ZM3.5 6v12c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3V6M3.5 12c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3",
  delegate: `${box(2.5, 2.5, 7, 7, 2)}${box(14.5, 14.5, 7, 7, 2)}M6 9.5V18h8.5M18 14.5V6H9.5`,
  note: "M20.5 15a2 2 0 0 1-2 2H7.5l-4 3.5V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z",
  answer: "M4 19.5h16M6 16l9.5-9.5a2 2 0 0 1 3 3L9 19H6Z",
  browser: `${box(2.5, 3.5, 19, 17, 3)}M2.5 9h19M6.5 6.25h.01M9.5 6.25h.01`,
  wrench: "M14.5 6.5l3 3 3.5-3.5a6 6 0 0 1-8 8l-6.5 6.5a2.1 2.1 0 0 1-3-3l6.5-6.5a6 6 0 0 1 8-8Z",
  sun: `${ring(12, 12, 4)}M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4`,
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  monitor: `${box(3, 4, 18, 12.5, 2.5)}M8.5 20.5h7M12 16.5v4`,
} as const;

export type LinePath = keyof typeof linePaths;

export function LineGlyph({
  name,
  className,
  size,
}: {
  readonly name: LinePath;
  readonly className?: string;
  readonly size?: number;
}) {
  return (
    <svg
      className={className}
      data-line-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={linePaths[name]} />
    </svg>
  );
}
