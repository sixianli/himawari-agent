import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINE_CHARACTERS,
  main,
  READ_LIMIT_BYTES,
  renderSummary,
  SUMMARY_LIMIT_BYTES,
  TAIL_LINES,
} from "../../scripts/ci/ci-summary.mjs";
import { gateSummaryMarkdown } from "../../scripts/ci/required.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function folder(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-summary-test-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}
const secret = `ghp_${"A".repeat(36)}`;

describe("诊断写进作业摘要", () => {
  it("按路径排序，文本只留最后几行并先遮盖密钥，二进制只列名字和大小", () => {
    const lines = Array.from({ length: TAIL_LINES + 5 }, (_, i) => `line ${i}`);
    const root = folder({
      "z.log": `${lines.join("\n")}\ntoken ${secret}\n`,
      "a/trace.zip": Buffer.from([0x50, 0x4b, 0x00, 0x01]),
      "b.json": '{"status":"failed"}\n',
    });
    const text = renderSummary({ title: "build/linux-x64 失败诊断", from: root });
    expect(text.indexOf("a/trace.zip")).toBeLessThan(text.indexOf("b.json"));
    expect(text.indexOf("b.json")).toBeLessThan(text.indexOf("z.log"));
    expect(text).toContain("`a/trace.zip`：二进制文件，4 字节，内容不显示");
    expect(text).toContain('{"status":"failed"}');
    expect(text).not.toContain(secret);
    expect(text).not.toContain("line 0\n");
    expect(text).toContain(`line ${TAIL_LINES + 4}`);
    expect(text).toContain(`只显示最后 ${TAIL_LINES} 行`);
    expect(renderSummary({ title: "build/linux-x64 失败诊断", from: root })).toBe(text);
  });
  it("密钥被行长截断前就已遮盖", () => {
    const root = folder({ "long.log": `${"x".repeat(LINE_CHARACTERS - 10)} ${secret}\n` });
    const text = renderSummary({ title: "t", from: root });
    expect(text).not.toContain(secret.slice(0, 8));
  });
  it("总量不超过上限，放不下的只报数量", () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `f${String(i).padStart(2, "0")}.log`,
        `${"y".repeat(LINE_CHARACTERS)}\n`.repeat(TAIL_LINES),
      ]),
    );
    const text = renderSummary({ title: "t", from: folder(files) });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SUMMARY_LIMIT_BYTES);
    expect(text).toMatch(/其余 \d+ 个文件超出 65536 字节的摘要上限，没有显示。/u);
  });
  it("超大文件只读末尾一段，控制字符被替换", () => {
    const big = `${"h".repeat(READ_LIMIT_BYTES)}\nhead-only\n${"t\n".repeat(10)}last \u001b[31mred\u0007\n`;
    const text = renderSummary({ title: "t", from: folder({ "big.log": big }) });
    expect(text).toContain("last ?[31mred?");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).toContain(`只显示最后 ${TAIL_LINES} 行`);
    const noNewline = renderSummary({
      title: "t",
      from: folder({ "one-line.log": "x".repeat(READ_LIMIT_BYTES + 10) }),
    });
    expect(noNewline).toContain("二进制文件");
  });
  it("NUL 出现在文件末尾也按二进制处理", () => {
    const text = renderSummary({
      title: "t",
      from: folder({ "late.bin": Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]) }),
    });
    expect(text).toContain("`late.bin`：二进制文件");
  });
  it("最后一个文件放得下时不因预留的说明文字被挤掉", () => {
    const content = "z".repeat(200);
    const header = "### t\n\n";
    const section = `#### \`only.log\`（${content.length} 字节）\n\n\`\`\`\`text\n${content}\n\`\`\`\`\n\n`;
    const limit = Buffer.byteLength(header) + Buffer.byteLength(section);
    const text = renderSummary({ title: "t", from: folder({ "only.log": content }), limit });
    expect(text).toBe(header + section);
  });
  it("代码块里的四个反引号不会提前结束代码块", () => {
    const text = renderSummary({ title: "t", from: folder({ "x.md": "a\n````\nb\n" }) });
    expect(text.split("````").length).toBe(3);
  });
  it("没有诊断时什么都不写", () => {
    expect(renderSummary({ title: "t", from: path.join(tmpdir(), "missing-ci-summary") })).toBe("");
    expect(renderSummary({ title: "t", from: folder({}) })).toBe("");
  });
  it("命令行追加到作业摘要文件，缺参数或缺摘要文件时失败", () => {
    const root = folder({ "a.log": "hello\n" });
    const target = path.join(root, "summary.md");
    writeFileSync(target, "earlier\n");
    main(["--title", "policy/default 失败诊断", "--from", root], { GITHUB_STEP_SUMMARY: target });
    const written = readFileSync(target, "utf8");
    expect(written.startsWith("earlier\n### policy/default 失败诊断")).toBe(true);
    expect(() => main(["--title", "t", "--from", root], {})).toThrow("CI_SUMMARY_TARGET_REQUIRED");
    expect(() => main(["--from", root], { GITHUB_STEP_SUMMARY: target })).toThrow(
      "CI_SUMMARY_INPUT_REQUIRED",
    );
    expect(() => main(["--other", "x"], { GITHUB_STEP_SUMMARY: target })).toThrow(
      "CI_SUMMARY_ARGUMENTS",
    );
  });
});

describe("ci/required 的作业摘要表", () => {
  it("失败原因里的密钥、竖线和换行不会进表格", () => {
    const text = gateSummaryMarkdown({
      status: "failed",
      observed: ["build/linux-x64"],
      expected: ["build/linux-x64"],
      missing: [],
      checks: [
        {
          checkId: "build",
          matrixKey: "linux-x64",
          status: "failed",
          reasons: [`Unsafe report path: a|b\n| forged | row | ${secret}`],
        },
      ],
    });
    expect(text).not.toContain(secret);
    const rows = text.split("\n").filter((line) => line.startsWith("| build"));
    expect(rows).toHaveLength(1);
    expect(rows[0].split("|")).toHaveLength(5);
    expect(text).not.toContain("| forged |");
  });
});
