export const SHEET_ROW_LIMIT = 2000;
export const SHEET_COLUMN_LIMIT = 100;

export interface SheetCellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly color?: string;
  readonly background?: string;
  readonly fontSize?: number;
  readonly align?: "left" | "center" | "right" | "justify";
  readonly verticalAlign?: "top" | "middle" | "bottom";
  readonly wrap?: boolean;
  readonly borderTop?: string;
  readonly borderRight?: string;
  readonly borderBottom?: string;
  readonly borderLeft?: string;
}

export interface SheetCell {
  readonly column: number;
  readonly text: string;
  readonly rowSpan: number;
  readonly colSpan: number;
  readonly style: SheetCellStyle;
}

export interface SheetRow {
  readonly number: number;
  readonly height: number | undefined;
  readonly cells: readonly SheetCell[];
}

export interface SheetColumn {
  readonly number: number;
  readonly name: string;
  readonly width: number;
}

export interface SheetView {
  readonly name: string;
  readonly columns: readonly SheetColumn[];
  readonly rows: readonly SheetRow[];
  readonly frozenRows: number;
  readonly truncated: boolean;
}

interface WorkbookColor {
  readonly argb?: string;
  readonly theme?: number;
  readonly tint?: number;
}

interface WorkbookBorder {
  readonly style?: string;
  readonly color?: WorkbookColor;
}

interface WorkbookStyle {
  readonly font?: {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underline?: unknown;
    readonly strike?: boolean;
    readonly size?: number;
    readonly color?: WorkbookColor;
  };
  readonly fill?: {
    readonly type?: string;
    readonly pattern?: string;
    readonly fgColor?: WorkbookColor;
  };
  readonly alignment?: {
    readonly horizontal?: string;
    readonly vertical?: string;
    readonly wrapText?: boolean;
  };
  readonly border?: Partial<Record<"top" | "right" | "bottom" | "left", WorkbookBorder>>;
}

export interface WorkbookCell {
  readonly value: unknown;
  readonly numFmt?: string | undefined;
  readonly style?: WorkbookStyle;
}

export interface WorkbookSheet {
  readonly name: string;
  readonly state?: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly views?: readonly { readonly state?: string; readonly ySplit?: number }[];
  readonly model?: { readonly merges?: readonly string[] };
  readonly properties?: { readonly defaultColWidth?: number; readonly defaultRowHeight?: number };
  getRow(row: number): { readonly height?: number; readonly hidden?: boolean };
  getColumn(column: number): { readonly width?: number; readonly hidden?: boolean };
  findCell(row: number, column: number): WorkbookCell | undefined;
}

const OFFICE_THEME = [
  "FFFFFF",
  "000000",
  "E7E6E6",
  "44546A",
  "4472C4",
  "ED7D31",
  "A5A5A5",
  "FFC000",
  "5B9BD5",
  "70AD47",
];

const EMPTY_CELL: WorkbookCell = { value: null };
const DEFAULT_COLUMN_CHARACTERS = 8.43;
const DEFAULT_ROW_POINTS = 15;
const DEFAULT_FONT_POINTS = 11;

export function columnName(column: number): string {
  let name = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26))
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  return name;
}

function cellReference(reference: string): { row: number; column: number } | undefined {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(reference.trim().toUpperCase());
  if (!match?.[1] || !match[2]) return undefined;
  const column = [...match[1]].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
  return { row: Number(match[2]), column };
}

function tinted(hex: string, tint: number): string {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const adjusted = channels.map((value) =>
    Math.round(tint < 0 ? value * (1 + tint) : value + (255 - value) * tint),
  );
  return `#${adjusted.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function colorOf(color: WorkbookColor | undefined): string | undefined {
  if (!color) return undefined;
  if (typeof color.argb === "string" && /^[0-9A-Fa-f]{8}$/.test(color.argb))
    return `#${color.argb.slice(2).toUpperCase()}`;
  if (typeof color.theme === "number") {
    const base = OFFICE_THEME[color.theme];
    if (!base) return undefined;
    return tinted(base, typeof color.tint === "number" ? color.tint : 0);
  }
  return undefined;
}

function borderOf(border: WorkbookBorder | undefined): string | undefined {
  if (!border?.style) return undefined;
  const width =
    border.style === "thick"
      ? 3
      : border.style.startsWith("medium") || border.style === "double"
        ? 2
        : 1;
  const line =
    border.style === "double"
      ? "double"
      : border.style.includes("dash")
        ? "dashed"
        : border.style.includes("dot") || border.style === "hair"
          ? "dotted"
          : "solid";
  return `${border.style === "double" ? 3 : width}px ${line} ${colorOf(border.color) ?? "#000000"}`;
}

const HORIZONTAL: Readonly<Record<string, SheetCellStyle["align"]>> = {
  left: "left",
  center: "center",
  centerContinuous: "center",
  right: "right",
  justify: "justify",
  distributed: "justify",
};

const VERTICAL: Readonly<Record<string, SheetCellStyle["verticalAlign"]>> = {
  top: "top",
  middle: "middle",
  center: "middle",
  bottom: "bottom",
};

function styleOf(cell: WorkbookCell, numeric: boolean): SheetCellStyle {
  const style = cell.style ?? {};
  const font = style.font ?? {};
  const fill = style.fill;
  const alignment = style.alignment ?? {};
  const border = style.border ?? {};
  const entries: [keyof SheetCellStyle, unknown][] = [
    ["bold", font.bold || undefined],
    ["italic", font.italic || undefined],
    ["underline", font.underline ? true : undefined],
    ["strike", font.strike || undefined],
    ["color", colorOf(font.color)],
    [
      "background",
      fill?.type === "pattern" && fill.pattern === "solid" ? colorOf(fill.fgColor) : undefined,
    ],
    [
      "fontSize",
      typeof font.size === "number" && font.size !== DEFAULT_FONT_POINTS && font.size !== 10
        ? font.size
        : undefined,
    ],
    [
      "align",
      (alignment.horizontal ? HORIZONTAL[alignment.horizontal] : undefined) ??
        (numeric ? "right" : undefined),
    ],
    ["verticalAlign", alignment.vertical ? VERTICAL[alignment.vertical] : undefined],
    ["wrap", alignment.wrapText || undefined],
    ["borderTop", borderOf(border.top)],
    ["borderRight", borderOf(border.right)],
    ["borderBottom", borderOf(border.bottom)],
    ["borderLeft", borderOf(border.left)],
  ];
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as SheetCellStyle;
}

function plainValue(value: unknown): unknown {
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  if ("result" in record) return plainValue(record["result"]);
  if (Array.isArray(record["richText"]))
    return (record["richText"] as readonly { readonly text?: unknown }[])
      .map((run) => (typeof run.text === "string" ? run.text : ""))
      .join("");
  if ("text" in record) return plainValue(record["text"]);
  if (typeof record["error"] === "string") return record["error"];
  if ("formula" in record || "sharedFormula" in record) return undefined;
  return undefined;
}

function firstSection(
  format: string,
  value: number,
): { readonly section: string; readonly sign: string } {
  const sections = format.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (value < 0 && sections[1]) return { section: sections[1], sign: "" };
  if (value === 0 && sections[2]) return { section: sections[2], sign: "" };
  return { section: sections[0] ?? "", sign: value < 0 ? "-" : "" };
}

function literal(part: string): string {
  return part
    .replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, "$1")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/_./g, "")
    .replace(/\*./g, "")
    .replace(/"([^"]*)"/g, "$1")
    .replace(/\\(.)/g, "$1");
}

const DATE_TOKEN = /yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P/gi;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isDateFormat(format: string): boolean {
  const bare = format
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare) && !/[#0?]/.test(bare.replace(/\.0+/g, ""));
}

function formatDate(date: Date, format: string): string {
  const section = literal(format.split(";")[0] ?? "");
  const tokens = [...section.matchAll(DATE_TOKEN)].map((match) => match[0].toLowerCase());
  const twelveHour = tokens.includes("am/pm") || tokens.includes("a/p");
  const pad = (value: number) => String(value).padStart(2, "0");
  let index = 0;
  return section.replace(DATE_TOKEN, (token) => {
    const lower = token.toLowerCase();
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    index += 1;
    const hours = date.getUTCHours();
    const minuteContext = (previous?.startsWith("h") ?? false) || (next?.startsWith("s") ?? false);
    switch (lower) {
      case "yyyy":
        return String(date.getUTCFullYear());
      case "yy":
        return pad(date.getUTCFullYear() % 100);
      case "mmmm":
        return MONTHS[date.getUTCMonth()] ?? "";
      case "mmm":
        return (MONTHS[date.getUTCMonth()] ?? "").slice(0, 3);
      case "mm":
        return minuteContext ? pad(date.getUTCMinutes()) : pad(date.getUTCMonth() + 1);
      case "m":
        return minuteContext ? String(date.getUTCMinutes()) : String(date.getUTCMonth() + 1);
      case "dddd":
        return DAYS[date.getUTCDay()] ?? "";
      case "ddd":
        return (DAYS[date.getUTCDay()] ?? "").slice(0, 3);
      case "dd":
        return pad(date.getUTCDate());
      case "d":
        return String(date.getUTCDate());
      case "hh":
        return pad(twelveHour ? hours % 12 || 12 : hours);
      case "h":
        return String(twelveHour ? hours % 12 || 12 : hours);
      case "ss":
        return pad(date.getUTCSeconds());
      case "s":
        return String(date.getUTCSeconds());
      case "am/pm":
        return hours < 12 ? "AM" : "PM";
      default:
        return hours < 12 ? "A" : "P";
    }
  });
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function formatNumber(value: number, format: string): string {
  if (!format || /^general$/i.test(format) || format === "@") {
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toPrecision(11)));
  }
  if (isDateFormat(format))
    return formatDate(new Date(EXCEL_EPOCH_MS + value * 86_400_000), format);
  const { section, sign } = firstSection(format, value);
  const pattern = /[#0?][#0?,]*(\.[#0?]+)?/.exec(
    section.replace(/"[^"]*"/g, (quoted) => "\u0000".repeat(quoted.length)),
  );
  if (!pattern) return sign + literal(section);
  const prefix = literal(section.slice(0, pattern.index));
  const suffix = literal(section.slice(pattern.index + pattern[0].length));
  const percent = suffix.includes("%");
  const decimals = (pattern[1] ?? "").replace(/[^0]/g, "").length;
  const optional = (pattern[1] ?? "").replace(/[^#?]/g, "").length;
  const scaled = Math.abs(value) * (percent ? 100 : 1);
  const digits = fixedDigits(scaled, decimals, decimals + optional, pattern[0].includes(","));
  return `${sign}${prefix}${digits}${suffix}`;
}

function fixedDigits(value: number, minimum: number, maximum: number, grouping: boolean): string {
  const [whole = "0", fraction = ""] = value.toFixed(maximum).split(".");
  let kept = fraction;
  while (kept.length > minimum && kept.endsWith("0")) kept = kept.slice(0, -1);
  const grouped = grouping ? whole.replace(/\B(?=(\d{3})+$)/g, ",") : whole;
  return kept ? `${grouped}.${kept}` : grouped;
}

export function cellText(cell: WorkbookCell): string {
  const value = plainValue(cell.value);
  if (value === undefined || value === null) return "";
  if (value instanceof Date)
    return Number.isNaN(value.getTime())
      ? ""
      : formatDate(value, cell.numFmt && isDateFormat(cell.numFmt) ? cell.numFmt : "yyyy-mm-dd");
  if (typeof value === "number") return formatNumber(value, cell.numFmt ?? "");
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function isNumeric(cell: WorkbookCell): boolean {
  const value = plainValue(cell.value);
  return typeof value === "number" || value instanceof Date;
}

export function sheetView(sheet: WorkbookSheet): SheetView {
  const rowCount = Math.min(sheet.rowCount, SHEET_ROW_LIMIT);
  const columnCount = Math.min(Math.max(sheet.columnCount, 1), SHEET_COLUMN_LIMIT);
  const merges = new Map<string, { rows: number; columns: number }>();
  const covered = new Set<string>();
  for (const range of sheet.model?.merges ?? []) {
    const [startText, endText] = range.split(":");
    const start = startText ? cellReference(startText) : undefined;
    const end = endText ? cellReference(endText) : undefined;
    if (!start || !end) continue;
    merges.set(`${start.row}:${start.column}`, {
      rows: end.row - start.row + 1,
      columns: end.column - start.column + 1,
    });
    for (let row = start.row; row <= end.row; row += 1)
      for (let column = start.column; column <= end.column; column += 1)
        if (row !== start.row || column !== start.column) covered.add(`${row}:${column}`);
  }
  const defaultWidth = sheet.properties?.defaultColWidth ?? DEFAULT_COLUMN_CHARACTERS;
  const columns: SheetColumn[] = [];
  for (let number = 1; number <= columnCount; number += 1) {
    const column = sheet.getColumn(number);
    if (column.hidden) continue;
    columns.push({
      number,
      name: columnName(number),
      width: Math.round((column.width ?? defaultWidth) * 7 + 5),
    });
  }
  const shown = new Set(columns.map((column) => column.number));
  const rows: SheetRow[] = [];
  for (let number = 1; number <= rowCount; number += 1) {
    const row = sheet.getRow(number);
    if (row.hidden) continue;
    const cells: SheetCell[] = [];
    for (const column of columns) {
      const key = `${number}:${column.number}`;
      if (covered.has(key)) continue;
      const cell = sheet.findCell(number, column.number) ?? EMPTY_CELL;
      const merge = merges.get(key);
      let colSpan = 1;
      if (merge)
        for (let offset = 1; offset < merge.columns; offset += 1)
          if (shown.has(column.number + offset)) colSpan += 1;
      cells.push({
        column: column.number,
        text: cellText(cell),
        rowSpan: Math.max(1, Math.min(merge?.rows ?? 1, rowCount - number + 1)),
        colSpan,
        style: styleOf(cell, isNumeric(cell)),
      });
    }
    rows.push({
      number,
      height:
        typeof row.height === "number" &&
        row.height !== (sheet.properties?.defaultRowHeight ?? DEFAULT_ROW_POINTS)
          ? Math.round((row.height * 4) / 3)
          : undefined,
      cells,
    });
  }
  const frozen = sheet.views?.find((view) => view.state === "frozen")?.ySplit ?? 0;
  return {
    name: sheet.name,
    columns,
    rows,
    frozenRows: Math.max(0, Math.min(frozen, rows.length)),
    truncated: sheet.rowCount > SHEET_ROW_LIMIT || sheet.columnCount > SHEET_COLUMN_LIMIT,
  };
}

export function workbookViews(sheets: readonly WorkbookSheet[]): readonly SheetView[] {
  return sheets.filter((sheet) => !sheet.state || sheet.state === "visible").map(sheetView);
}
