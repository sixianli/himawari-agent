import { Marked, type TokenizerAndRendererExtension } from "marked";

const CJK_PUNCTUATION = "，。；：！？（）【】《》「」『』、“”‘’—…·〈〉〔〕";
const OPEN = new RegExp(
  `^\\*\\*([${CJK_PUNCTUATION}][^\\n]*?[^\\s*]|[^\\s*][^\\n]*?[${CJK_PUNCTUATION}])\\*\\*`,
  "u",
);
const ENDS_WITH_CJK_PUNCTUATION = new RegExp(`[${CJK_PUNCTUATION}]$`, "u");
const STARTS_WITH_CJK_PUNCTUATION = new RegExp(`^[${CJK_PUNCTUATION}]`, "u");

const strongNextToCjkPunctuation: TokenizerAndRendererExtension = {
  name: "strong",
  level: "inline",
  start: (source) => source.indexOf("**"),
  tokenizer(source) {
    const match = OPEN.exec(source);
    const text = match?.[1];
    if (!match || text === undefined) return undefined;
    if (!STARTS_WITH_CJK_PUNCTUATION.test(text) && !ENDS_WITH_CJK_PUNCTUATION.test(text))
      return undefined;
    if (text.includes("**")) return undefined;
    return {
      type: "strong",
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  },
};

export const markdown = new Marked({ gfm: true, extensions: [strongNextToCjkPunctuation] });

const DELIMITER_CELL = /^:?-{3,}:?$/;
const FENCE = /^\s*(```|~~~)/;

function rebuildTable(line: string): string[] | undefined {
  const first = line.indexOf("|");
  if (first < 0) return undefined;
  const prefix = line.slice(0, first).trimEnd();
  const cells = line
    .slice(first)
    .split("|")
    .map((cell) => cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  const delimiterAt = cells.findIndex((cell) => DELIMITER_CELL.test(cell));
  if (delimiterAt < 2) return undefined;
  const header = cells.slice(0, delimiterAt).filter((cell) => cell !== "");
  cells.splice(0, delimiterAt, ...header);
  const start = header.length;
  let width = 0;
  while (DELIMITER_CELL.test(cells[start + width] ?? "")) width += 1;
  if (width !== start) return undefined;
  const body = cells.slice(start + width);
  const rows: string[][] = [];
  for (let index = 0; index < body.length; ) {
    if (body[index] === "") {
      index += 1;
      continue;
    }
    rows.push(body.slice(index, index + width));
    index += width;
  }
  const render = (row: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, column) => row[column] ?? "").join(" | ")} |`;
  return [
    ...(prefix ? [prefix, ""] : []),
    render(cells.slice(0, width)),
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...rows.map(render),
    "",
  ];
}

export function repairInlineTables(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .flatMap((line) => {
      if (FENCE.test(line)) fenced = !fenced;
      return fenced ? [line] : (rebuildTable(line) ?? [line]);
    })
    .join("\n");
}
