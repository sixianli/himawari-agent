import type { SVGProps } from "react";

type GlyphLayer =
  | { readonly tone: "base" | "solid"; readonly d: string }
  | { readonly tone: "line"; readonly d: string; readonly width: number; readonly opacity: number };

const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}Z`;
const cc = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0Z`;
const base = (d: string): GlyphLayer => ({ tone: "base", d });
const solid = (d: string): GlyphLayer => ({ tone: "solid", d });
const line = (d: string, width = 2.4, opacity = 1): GlyphLayer => ({
  tone: "line",
  d,
  width,
  opacity,
});
const f = (n: number) => Math.round(n * 100) / 100;
const spokes = (cx: number, cy: number, r1: number, r2: number, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const a = ((360 / n) * i * Math.PI) / 180;
    return `M${f(cx + r1 * Math.sin(a))} ${f(cy - r1 * Math.cos(a))}L${f(cx + r2 * Math.sin(a))} ${f(cy - r2 * Math.cos(a))}`;
  }).join("");
const sheet =
  "M7 2.5h6.4a2 2 0 0 1 1.4.6l4.6 4.6a2 2 0 0 1 .6 1.4V19a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 19V5A2.5 2.5 0 0 1 7 2.5Z";
const pencil = "M14.6 6.4a1.9 1.9 0 0 1 2.7 2.7l-6.6 6.6-3.6.9.9-3.6Z";
const bell =
  "M12 3a6 6 0 0 1 6 6v4.2l1.5 2.3a1 1 0 0 1-.8 1.5H5.3a1 1 0 0 1-.8-1.5L6 13.2V9a6 6 0 0 1 6-6Z";
const bookLeft =
  "M12 6.5C10.4 5.2 8 4.7 5 5a1.4 1.4 0 0 0-1.3 1.4v10.8a1.4 1.4 0 0 0 1.6 1.4c2.8-.3 5 .2 6.7 1.5Z";
const bookRight =
  "M12 6.5C13.6 5.2 16 4.7 19 5a1.4 1.4 0 0 1 1.3 1.4v10.8a1.4 1.4 0 0 1-1.6 1.4c-2.8-.3-5 .2-6.7 1.5Z";
const square = rr(3, 3, 18, 18, 6);
const panelBox = rr(2.5, 4, 19, 16, 5);
export const glyphLayers = {
  compose: [base(square), solid(pencil)],
  rename: [base(rr(3, 14, 18, 7, 3.5)), solid("M15.6 3.6a2 2 0 0 1 2.8 2.8l-7.5 7.5-4 1 1-4Z")],
  search: [base(cc(10.5, 10.5, 7.5)), line(cc(10.5, 10.5, 4.6)), line("M16.2 16.2L19.8 19.8", 3.2)],
  memory: [
    base(cc(12, 12, 9.6)),
    line("M7 7.5l10 3M17 10.5L9 17.2M7 7.5l2 9.7", 1.6, 0.55),
    solid(cc(7, 7.5, 2.5)),
    solid(cc(17, 10.5, 2.8)),
    solid(cc(9, 17.2, 2.3)),
    solid(cc(18, 18, 1.4)),
  ],
  reminders: [base(bell), solid(rr(9, 18.6, 6, 2.9, 1.45)), solid(cc(17.8, 5.2, 2.8))],
  bell: [base(bell), solid(rr(9, 18.6, 6, 2.9, 1.45))],
  files: [
    base(rr(2.5, 5, 19, 15, 4.5)),
    solid("M2.5 9.6V7.5A2.5 2.5 0 0 1 5 5h3.6a2 2 0 0 1 1.5.7l1.4 1.6H19a2.5 2.5 0 0 1 2.5 2.3Z"),
  ],
  settings: [base(cc(12, 12, 9.2)), solid(cc(12, 12, 3.4)), line(spokes(12, 12, 6.4, 7.8, 6), 2.4)],
  panel: [base(panelBox), solid(rr(5, 6.5, 4.5, 11, 2.25))],
  widen: [base(panelBox), solid(rr(14.5, 6.5, 4.5, 11, 2.25))],
  menu: [line("M4.5 6.5h15M4.5 12h15M4.5 17.5h15")],
  more: [solid(cc(5.5, 12, 2)), solid(cc(12, 12, 2)), solid(cc(18.5, 12, 2))],
  pin: [
    base(
      "M8.6 3h6.8a1 1 0 0 1 1 1.2l-.9 4.6 3 3.2a1 1 0 0 1-.7 1.7H6.2a1 1 0 0 1-.7-1.7l3-3.2-.9-4.6A1 1 0 0 1 8.6 3Z",
    ),
    line("M12 14v7"),
  ],
  archive: [base(rr(4, 9, 16, 12, 3.5)), solid(rr(2.5, 3.5, 19, 5.5, 2.75)), line("M10 13.5h4")],
  trash: [
    base(rr(5, 7.5, 14, 13.5, 4)),
    solid(rr(3, 3.5, 18, 4, 2)),
    line("M10 11.5v6M14 11.5v6", 2.2),
  ],
  refresh: [
    base(cc(12, 12, 9.5)),
    line("M6.6 12.6A5.5 5.5 0 1 1 8.4 16.2"),
    solid("M4.3 11.2h4.6a.5.5 0 0 1 .4.8l-2.3 3a.5.5 0 0 1-.8 0l-2.3-3a.5.5 0 0 1 .4-.8Z"),
  ],
  manage: [
    base(square),
    line("M7 8.5h10M7 15.5h10", 2.2),
    solid(cc(10, 8.5, 2.4)),
    solid(cc(14, 15.5, 2.4)),
  ],
  shield: [
    base(
      "M11.3 2.7a2 2 0 0 1 1.4 0l6 2.3A2 2 0 0 1 20 6.9V12c0 4.9-5.3 8.3-7.2 9.3a1.7 1.7 0 0 1-1.6 0C9.3 20.3 4 16.9 4 12V6.9A2 2 0 0 1 5.3 5Z",
    ),
    line("M8.6 12l2.4 2.4 4.4-4.6"),
  ],
  copy: [base(rr(3, 3, 13, 13, 4)), solid(rr(8, 8, 13, 13, 4))],
  check: [line("M5 12.5l4.5 4.5L19 7.5", 2.6)],
  checkTwice: [line("M2 12.5l4.5 4.5L16 7.5M11 16.5l.5.5L21 7.5", 2.4)],
  fork: [
    solid(cc(6.5, 5.5, 2.8)),
    solid(cc(6.5, 18.5, 2.8)),
    solid(cc(17.5, 7.5, 2.8)),
    line("M6.5 8.3v7.4M17.5 10.3c0 3.7-3.4 4.4-8 6.4", 2.2, 0.5),
  ],
  chevron: [line("M9.5 6l6 6-6 6", 2.6)],
  back: [line("M14.5 6l-6 6 6 6", 2.6)],
  down: [line("M6 9.5l6 6 6-6", 2.6)],
  file: [base(sheet), solid("M13.5 2.6v4.4A1.5 1.5 0 0 0 15 8.5h4.4L13.5 2.6Z")],
  document: [base(sheet), solid(rr(8, 11.5, 8, 2.2, 1.1)), solid(rr(8, 15.5, 5.5, 2.2, 1.1))],
  write: [base(sheet), solid(rr(10.9, 10, 2.2, 9, 1.1)), solid(rr(7.5, 13.4, 9, 2.2, 1.1))],
  image: [
    base(panelBox),
    solid(
      "M2.5 15.6l4.3-3.9a1.5 1.5 0 0 1 2 0l3 2.6 2.6-2.2a1.5 1.5 0 0 1 2 0l5.1 4.7v.2A5 5 0 0 1 16.5 20h-9a5 5 0 0 1-5-4.4Z",
    ),
    solid(cc(9, 8.8, 1.9)),
  ],
  terminal: [base(panelBox), line("M7.2 9.5l2.8 2.5-2.8 2.5"), solid(rr(12, 14.1, 5, 2.4, 1.2))],
  stop: [solid(rr(6.5, 6.5, 11, 11, 3))],
  alert: [base(cc(12, 12, 9.5)), solid(rr(10.8, 6.6, 2.4, 7.6, 1.2)), solid(cc(12, 17, 1.45))],
  info: [base(cc(12, 12, 9.5)), solid(rr(10.8, 9.8, 2.4, 7.6, 1.2)), solid(cc(12, 7, 1.45))],
  external: [base(rr(3, 5.5, 15.5, 15.5, 4.5)), line("M13.5 3.8h6.7v6.7M20 4l-8 8")],
  arrowDown: [line("M12 5v13.5M6.5 13L12 18.5 17.5 13", 2.6)],
  send: [line("M12 18V6.5M7 11.5l5-5 5 5", 2.6)],
  plus: [line("M12 6v12M6 12h12", 2.6)],
  download: [base(rr(3, 13, 18, 8, 4)), line("M12 3.5v10M7.8 9.4l4.2 4.2 4.2-4.2")],
  upload: [base(rr(3, 13, 18, 8, 4)), line("M12 15V4.5M7.8 8.6L12 4.4l4.2 4.2")],
  expand: [base(square), line("M13.5 6.8h3.7v3.7M10.5 17.2H6.8v-3.7")],
  collapse: [base(square), line("M17.2 10.5h-3.7V6.8M6.8 13.5h3.7v3.7")],
  close: [line("M6.5 6.5l11 11M17.5 6.5l-11 11", 2.6)],
  mail: [base(rr(2.5, 4.5, 19, 15, 4.5)), line("M6.5 9.2l5.5 3.8 5.5-3.8")],
  globe: [
    base(cc(12, 12, 9.5)),
    line(
      "M12 2.7c-2.6 2.5-3.9 5.6-3.9 9.3s1.3 6.8 3.9 9.3c2.6-2.5 3.9-5.6 3.9-9.3S14.6 5.2 12 2.7Z",
      2,
    ),
    solid(rr(2.5, 11, 19, 2, 1)),
  ],
  grid: [
    solid(rr(3, 3, 8, 8, 3)),
    base(rr(13, 3, 8, 8, 3)),
    base(rr(3, 13, 8, 8, 3)),
    solid(rr(13, 13, 8, 8, 3)),
  ],
  table: [
    base(panelBox),
    solid("M2.5 9a5 5 0 0 1 5-5h9a5 5 0 0 1 5 5v.5h-19Z"),
    line("M9.5 9.5V19.5M4 14.7h16", 2, 0.55),
  ],
  code: [base(square), line("M9.5 8.6L6.2 12l3.3 3.4M14.5 8.6l3.3 3.4-3.3 3.4", 2.4)],
  lock: [
    line("M8 10.5V8a4 4 0 0 1 8 0v2.5"),
    base(rr(4.5, 10, 15, 11.5, 4)),
    solid(rr(10.8, 13.6, 2.4, 4.4, 1.2)),
  ],
  clock: [base(cc(12, 12, 9.5)), line("M12 7.4V12l3 2")],
  think: [
    base(
      "M12 4.6C11 3.2 8.8 3 7.6 4.2C6 4.2 4.8 5.4 4.8 7C3.6 7.6 3 9 3.4 10.4C2.8 11.4 2.9 13 3.8 14C3.8 15.8 5 17 6.6 17.2C7.4 18.6 9.4 19.2 10.8 18.4C11.3 18.8 11.7 18.9 12 18.9Z",
    ),
    base(
      "M12 4.6C13 3.2 15.2 3 16.4 4.2C18 4.2 19.2 5.4 19.2 7C20.4 7.6 21 9 20.6 10.4C21.2 11.4 21.1 13 20.2 14C20.2 15.8 19 17 17.4 17.2C16.6 18.6 14.6 19.2 13.2 18.4C12.7 18.8 12.3 18.9 12 18.9Z",
    ),
    line(
      "M7.4 8.6c1.6-.4 2.8.4 3.2 1.8M6.4 13.4c1.5.4 2.9-.1 3.8-1.2M9.4 15.8c.4-.6.5-1.3.3-2",
      1.7,
      0.85,
    ),
    line(
      "M16.6 8.6c-1.6-.4-2.8.4-3.2 1.8M17.6 13.4c-1.5.4-2.9-.1-3.8-1.2M14.6 15.8c-.4-.6-.5-1.3-.3-2",
      1.7,
      0.85,
    ),
  ],
  person: [
    solid(cc(12, 7.8, 4)),
    base("M4 20.2c.9-4 4.1-6.2 8-6.2s7.1 2.2 8 6.2a1 1 0 0 1-1 1.3H5a1 1 0 0 1-1-1.3Z"),
  ],
  database: [
    base("M3.5 6.2v11.6c0 1.8 3.8 3.2 8.5 3.2s8.5-1.4 8.5-3.2V6.2Z"),
    solid("M3.5 6.2C3.5 4.4 7.3 3 12 3s8.5 1.4 8.5 3.2-3.8 3.2-8.5 3.2-8.5-1.4-8.5-3.2Z"),
    line("M3.5 12.5c0 1.8 3.8 3.2 8.5 3.2s8.5-1.4 8.5-3.2", 2, 0.5),
  ],
  delegate: [
    solid(rr(2.5, 2.5, 8.5, 8.5, 3)),
    base(rr(13, 13, 8.5, 8.5, 3)),
    line("M6.8 13.5v2.2a2 2 0 0 0 2 2h1.7M17.2 10.5V8.3a2 2 0 0 0-2-2h-1.7", 2.2, 0.6),
  ],
  note: [
    base(
      "M6 3.5h12A2.5 2.5 0 0 1 20.5 6v9A2.5 2.5 0 0 1 18 17.5H9.2l-3.8 3.3a.6.6 0 0 1-1-.5V6A2.5 2.5 0 0 1 6 3.5Z",
    ),
    solid(rr(8, 8, 8, 2.2, 1.1)),
    solid(rr(8, 12, 5, 2.2, 1.1)),
  ],
  answer: [
    base(
      "M12 3c5 0 9 3.4 9 7.7s-4 7.7-9 7.7c-1 0-2-.1-2.9-.4L5 20.4a.6.6 0 0 1-.9-.6l.8-3.4A7.3 7.3 0 0 1 3 10.7C3 6.4 7 3 12 3Z",
    ),
    solid(cc(8.2, 10.8, 1.4)),
    solid(cc(12, 10.8, 1.4)),
    solid(cc(15.8, 10.8, 1.4)),
  ],
  browser: [base(rr(2.5, 3.5, 19, 17, 5)), solid("M2.5 8.5a5 5 0 0 1 5-5h9a5 5 0 0 1 5 5v.5h-19Z")],
  wrench: [
    base(cc(12, 12, 9.5)),
    solid(
      "M15.5 5.7a4.4 4.4 0 0 1 2.6.5l-2.6 2.6.4 1.9 1.9.4 2.6-2.6a4.4 4.4 0 0 1-5.6 5.6l-5.4 5.4a1.9 1.9 0 0 1-2.7-2.7l5.4-5.4a4.4 4.4 0 0 1 3.4-5.7Z",
    ),
  ],
  radar: [
    base(cc(12, 12, 9.5)),
    line(cc(12, 12, 6.2) + cc(12, 12, 3), 1.2, 0.45),
    base("M12 12L12 2.5A9.5 9.5 0 0 1 19.28 5.9Z"),
    line("M12 12V2.8", 1.8),
    solid(cc(16.2, 8.9, 1.15)),
    solid(cc(8, 15.6, 1)),
    solid(cc(12, 12, 1.4)),
  ],
  checklist: [
    base(rr(4.5, 4, 15, 17.5, 4)),
    solid(rr(8.5, 2.2, 7, 3.6, 1.8)),
    line("M7.8 10.6l1.3 1.3 2.2-2.5", 1.8),
    line("M7.8 15.4l1.3 1.3 2.2-2.5", 1.8),
    line("M13.6 11h3", 1.8, 0.55),
    line("M13.6 15.8h3", 1.8, 0.55),
  ],
  book: [
    base(bookLeft),
    base(bookRight),
    solid(
      "M12 7.6C13.4 6.6 15.6 6.2 18.2 6.4a.6.6 0 0 1 .6.6v9.4a.6.6 0 0 1-.7.6c-2.4-.2-4.4.2-6.1 1.2Z",
    ),
  ],
  penBook: [
    base(bookLeft),
    base(bookRight),
    solid(rr(6.6, 9.4, 3.6, 1.6, 0.8)),
    solid(rr(6.6, 13, 3.6, 1.6, 0.8)),
    line("M12.8 17.7h4.6", 1.8),
    solid("M17.4 9.6a1.52 1.52 0 0 1 2.16 2.16l-5.28 5.28-2.88.72.72-2.88Z"),
  ],
  sun: [base(cc(12, 12, 6.5)), solid(cc(12, 12, 3.6)), line(spokes(12, 12, 8.4, 9.8, 8), 2.2)],
  moon: [
    base(cc(12, 12, 9.5)),
    solid("M19.6 14.6a7.6 7.6 0 0 1-10.2-10.2 7.6 7.6 0 1 0 10.2 10.2Z"),
  ],
  monitor: [base(rr(2.5, 3.5, 19, 13.5, 4.5)), solid(rr(7.5, 18.8, 9, 2.4, 1.2))],
} satisfies Record<string, readonly GlyphLayer[]>;

export type GlyphName = keyof typeof glyphLayers;

function GlyphPath({ layer }: { readonly layer: GlyphLayer }) {
  if (layer.tone === "line") {
    return (
      <path
        d={layer.d}
        style={{
          fill: "none",
          stroke: "currentColor",
          strokeWidth: layer.width,
          strokeOpacity: layer.opacity,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
    );
  }
  return (
    <path
      d={layer.d}
      data-tone={layer.tone}
      style={{
        fill: "currentColor",
        fillOpacity: layer.tone === "base" ? "var(--glyph-base-opacity, 0.22)" : 1,
        stroke: "none",
      }}
    />
  );
}

export function Glyph({
  name,
  size,
  ...rest
}: {
  readonly name: GlyphName;
  readonly size?: number;
} & Omit<SVGProps<SVGSVGElement>, "name" | "viewBox" | "children">) {
  return (
    <svg
      {...rest}
      data-glyph={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {glyphLayers[name].map((layer) => (
        <GlyphPath key={`${layer.tone}${layer.d}`} layer={layer} />
      ))}
    </svg>
  );
}
