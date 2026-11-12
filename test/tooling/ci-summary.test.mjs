import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINE_CHARACTERS,
  main,
  renderSummary,
  SUMMARY_LIMIT_BYTES,
  TAIL_LINES,
} from "../../scripts/ci/ci-summary.mjs";

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
