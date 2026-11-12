import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactText } from "./redact-text.mjs";

export const SUMMARY_LIMIT_BYTES = 64 * 1024;
export const TAIL_LINES = 40;
export const LINE_CHARACTERS = 500;
export const READ_LIMIT_BYTES = 256 * 1024;
const FOOTER_RESERVE_BYTES = 256;

function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile())
        files.push({
          relative: path.relative(root, full).split(path.sep).join("/"),
          full,
          size: stat.size,
        });
    }
  };
  walk(root);
  return files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

function readTail(file) {
  const length = Math.min(file.size, READ_LIMIT_BYTES);
  const bytes = Buffer.alloc(length);
  const handle = openSync(file.full, "r");
  try {
    if (readSync(handle, bytes, 0, length, file.size - length) !== length) return null;
  } finally {
    closeSync(handle);
  }
  return bytes;
}

function textTail(file) {
  let bytes = readTail(file);
  if (bytes === null || bytes.includes(0)) return null;
  if (file.size > bytes.length) {
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) return null;
    bytes = bytes.subarray(newline + 1);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const redacted = redactText(text);
  if (/-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----/u.test(redacted)) return null;
  const lines = redacted
    .replace(/\r\n?/gu, "\n")
    .replace(/\n$/u, "")
    .replace(/[^\P{Cc}\n\t]/gu, "?")
    .split("\n");
  const tail = lines
    .slice(-TAIL_LINES)
    .map((line) => (line.length > LINE_CHARACTERS ? `${line.slice(0, LINE_CHARACTERS)}…` : line))
    .join("\n");
  return {
    omitted: file.size > bytes.length || lines.length > TAIL_LINES,
    text: tail.replaceAll("````", "` ` ` `"),
  };
}

const safeName = (value) => redactText(value).replace(/[\p{Cc}`|]/gu, "?");

export function renderSummary({ title, from, limit = SUMMARY_LIMIT_BYTES }) {
  if (!existsSync(from)) return "";
  const files = listFiles(from);
  if (files.length === 0) return "";
  const header = `### ${title}\n\n`;
  const sections = [];
  let used = Buffer.byteLength(header);
  let shown = 0;
  for (const file of files) {
    const tail = textTail(file);
    const name = safeName(file.relative);
    const section =
      tail === null
        ? `- \`${name}\`：二进制文件，${file.size} 字节，内容不显示\n\n`
        : `#### \`${name}\`（${file.size} 字节${tail.omitted ? `，只显示最后 ${TAIL_LINES} 行` : ""}）\n\n\`\`\`\`text\n${tail.text}\n\`\`\`\`\n\n`;
    const remaining = files.length - shown - 1;
    const footer = `其余 ${files.length - shown} 个文件超出 ${limit} 字节的摘要上限，没有显示。\n`;
    const reserve = remaining > 0 ? FOOTER_RESERVE_BYTES : 0;
    if (used + Buffer.byteLength(section) + reserve > limit) {
      sections.push(footer);
      break;
    }
    sections.push(section);
    used += Buffer.byteLength(section);
    shown += 1;
  }
  return header + sections.join("");
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !["--title", "--from"].includes(argv[i]) ||
      Object.hasOwn(args, argv[i]) ||
      argv[i + 1] === undefined
    )
      throw new Error("CI_SUMMARY_ARGUMENTS");
    args[argv[i]] = argv[i + 1];
  }
  if (!args["--title"] || !args["--from"]) throw new Error("CI_SUMMARY_INPUT_REQUIRED");
  if (!env.GITHUB_STEP_SUMMARY) throw new Error("CI_SUMMARY_TARGET_REQUIRED");
  const text = renderSummary({ title: args["--title"], from: path.resolve(args["--from"]) });
  if (text) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
