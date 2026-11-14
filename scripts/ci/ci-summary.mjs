import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactText } from "./redact-text.mjs";

export const SUMMARY_LIMIT_BYTES = 64 * 1024;
export const TAIL_LINES = 40;
export const FAILED_LOG_TAIL_LINES = 120;
export const LINE_CHARACTERS = 500;
export const READ_LIMIT_BYTES = 256 * 1024;
const FOOTER_RESERVE_BYTES = 512;
const PRIVATE_KEY_MARKER = /-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u;
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI_SEQUENCE = new RegExp(
  `${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\))`,
  "gu",
);

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

function textTail(file, tailLines) {
  let bytes;
  try {
    bytes = readTail(file);
  } catch {
    return null;
  }
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
  const redacted = redactText(text.replace(ANSI_SEQUENCE, ""));
  if (PRIVATE_KEY_MARKER.test(redacted)) return null;
  const lines = redacted
    .replace(/\r\n?/gu, "\n")
    .replace(/\n$/u, "")
    .replace(/[^\P{Cc}\n\t]|[\p{Zl}\p{Zp}]/gu, "?")
    .split("\n");
  const tail = lines
    .slice(-tailLines)
    .map((line) => (line.length > LINE_CHARACTERS ? `${line.slice(0, LINE_CHARACTERS)}…` : line))
    .join("\n");
  return {
    omitted: file.size > bytes.length || lines.length > tailLines,
    text: tail.replaceAll("````", "` ` ` `"),
  };
}

function safeName(value) {
  const redacted = redactText(String(value).replace(ANSI_SEQUENCE, ""));
  if (PRIVATE_KEY_MARKER.test(redacted)) return "?";
  return redacted.replace(/[\p{Cc}\p{Zl}\p{Zp}`|]/gu, "?");
}

export function renderSummary({
  title,
  from,
  limit = SUMMARY_LIMIT_BYTES,
  tailLines = TAIL_LINES,
  only = () => true,
  first = () => false,
}) {
  if (!existsSync(from)) return "";
  const listed = listFiles(from).filter((file) => only(file.relative));
  const files = [
    ...listed.filter((file) => first(file.relative)),
    ...listed.filter((file) => !first(file.relative)),
  ];
  if (files.length === 0) return "";
  const header = `### ${title}\n\n`;
  const footerFrom = (start) => {
    const names = files
      .slice(start, start + 5)
      .map((entry) => `\`${safeName(entry.relative).slice(0, 40)}\``)
      .join("、");
    return `其余 ${files.length - start} 个文件超出 ${limit} 字节的摘要上限，没有显示（${names}${files.length - start > 5 ? " 等" : ""}）。\n`;
  };
  const sections = [];
  let used = Buffer.byteLength(header);
  let shown = 0;
  for (const file of files) {
    const tail = textTail(file, tailLines);
    const name = safeName(file.relative);
    const section =
      tail === null
        ? `- \`${name}\`：二进制文件，${file.size} 字节，内容不显示\n\n`
        : `#### \`${name}\`（${file.size} 字节${tail.omitted ? `，只显示最后 ${tailLines} 行` : ""}）\n\n\`\`\`\`text\n${tail.text}\n\`\`\`\`\n\n`;
    const reserve = shown + 1 < files.length ? Buffer.byteLength(footerFrom(shown + 1)) : 0;
    if (used + Buffer.byteLength(section) + reserve > limit) {
      const footer = footerFrom(shown);
      if (used + Buffer.byteLength(footer) <= limit) sections.push(footer);
      break;
    }
    sections.push(section);
    used += Buffer.byteLength(section);
    shown += 1;
  }
  return header + sections.join("");
}

export const FAILED_TESTS_SHOWN = 30;
export const FAILURE_MESSAGE_LINES = 20;
const REPORT_JSON_LIMIT_BYTES = 64 * 1024 * 1024;

function readJsonInside(reports, relative) {
  try {
    const full = path.join(reports, relative);
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > REPORT_JSON_LIMIT_BYTES) return null;
    if (!realpathSync(full).startsWith(`${realpathSync(reports)}${path.sep}`)) return null;
    return JSON.parse(readFileSync(full, "utf8"));
  } catch {
    return null;
  }
}

function publishedResult(reports) {
  const result = readJsonInside(reports, "result.json");
  return result && typeof result === "object" && Array.isArray(result.reports) ? result : null;
}

const reportPaths = (result, kind, extension) =>
  result.reports
    .filter(
      (report) =>
        report?.kind === kind && typeof report.path === "string" && report.path.endsWith(extension),
    )
    .map((report) => report.path.split(path.sep).join("/"))
    .filter((relative) => !path.isAbsolute(relative) && !relative.split("/").includes(".."));

function cleanLine(value) {
  const redacted = redactText(String(value).replace(ANSI_SEQUENCE, ""));
  if (PRIVATE_KEY_MARKER.test(redacted)) return "?";
  return redacted.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "?");
}

function failureMessage(value) {
  const redacted = redactText(String(value ?? "").replace(ANSI_SEQUENCE, ""));
  if (PRIVATE_KEY_MARKER.test(redacted)) return "";
  return redacted
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\P{Cc}\n\t]|[\p{Zl}\p{Zp}]/gu, "?")
    .split("\n")
    .slice(0, FAILURE_MESSAGE_LINES)
    .map((line) => (line.length > LINE_CHARACTERS ? `${line.slice(0, LINE_CHARACTERS)}…` : line))
    .join("\n")
    .replaceAll("````", "` ` ` `");
}

function failedTests(reports, result) {
  const failures = [];
  for (const relative of reportPaths(result, "json", ".json").sort()) {
    const report = readJsonInside(reports, relative);
    if (!Array.isArray(report?.testResults)) continue;
    for (const file of report.testResults) {
      const name = typeof file?.name === "string" ? file.name : "?";
      const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
      const failed = assertions.filter((assertion) => assertion?.status === "failed");
      for (const assertion of failed)
        failures.push({
          report: relative,
          file: name,
          test: assertion.fullName ?? assertion.title ?? "?",
          message: (Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [])[0],
        });
      if (file?.status === "failed" && failed.length === 0)
        failures.push({
          report: relative,
          file: name,
          test: "（整个文件失败）",
          message: file.message,
        });
    }
  }
  return failures;
}

function renderFailedTests({ title, reports, result, limit }) {
  const failures = failedTests(reports, result);
  if (failures.length === 0) return "";
  let text = `### ${title}：失败的用例（共 ${failures.length} 条）\n\n`;
  let shown = 0;
  for (const failure of failures) {
    const message = failureMessage(failure.message);
    const section = `- \`${safeName(cleanLine(failure.report))}\`：${cleanLine(failure.file).replaceAll("`", "?")} > ${cleanLine(failure.test).replaceAll("`", "?")}\n\n${message ? `\`\`\`\`text\n${message}\n\`\`\`\`\n\n` : ""}`;
    if (
      shown === FAILED_TESTS_SHOWN ||
      Buffer.byteLength(text) + Buffer.byteLength(section) + FOOTER_RESERVE_BYTES > limit
    )
      break;
    text += section;
    shown += 1;
  }
  if (shown < failures.length) text += `其余 ${failures.length - shown} 条失败的用例没有显示。\n\n`;
  return text;
}

function failedCommandLogs(reports) {
  const details = readJsonInside(reports, "details.json");
  return new Set(
    (Array.isArray(details?.commands) ? details.commands : [])
      .filter((command) => command?.exitCode !== 0 && typeof command?.name === "string")
      .map((command) => `${command.name}.log`),
  );
}

export function renderFailedLogs({ title, reports, limit = SUMMARY_LIMIT_BYTES }) {
  if (!existsSync(reports)) return "";
  const result = publishedResult(reports);
  if (result === null)
    return `### ${title}：命令日志\n\n\`result.json\` 读不出来，无法确定哪些文件是命令日志，没有显示。\n\n`;
  if (result.status === "passed") return "";
  const tests = renderFailedTests({ title, reports, result, limit: Math.floor(limit / 2) });
  const logs = new Set(reportPaths(result, "diagnostic", ".log"));
  const failedFirst = failedCommandLogs(reports);
  return (
    tests +
    renderSummary({
      title: `${title}：命令日志`,
      from: reports,
      limit: limit - Buffer.byteLength(tests),
      tailLines: FAILED_LOG_TAIL_LINES,
      only: (relative) => logs.has(relative),
      first: (relative) => failedFirst.has(path.posix.basename(relative)),
    })
  );
}

export const logLines = (text) =>
  text
    .replace(/\n+$/u, "")
    .split("\n")
    .map((line) => `| ${line}\n`)
    .join("");

export function main(
  argv = process.argv.slice(2),
  env = process.env,
  write = (text) => process.stdout.write(text),
) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !["--title", "--from", "--failed-logs"].includes(argv[i]) ||
      Object.hasOwn(args, argv[i]) ||
      !argv[i + 1]
    )
      throw new Error("CI_SUMMARY_ARGUMENTS");
    args[argv[i]] = argv[i + 1];
  }
  if (!args["--title"] || !args["--from"]) throw new Error("CI_SUMMARY_INPUT_REQUIRED");
  if (!env.GITHUB_STEP_SUMMARY) throw new Error("CI_SUMMARY_TARGET_REQUIRED");
  const text =
    renderSummary({ title: args["--title"], from: path.resolve(args["--from"]) }) +
    (args["--failed-logs"]
      ? renderFailedLogs({ title: args["--title"], reports: path.resolve(args["--failed-logs"]) })
      : "");
  if (text) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    write(logLines(text));
  }
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
