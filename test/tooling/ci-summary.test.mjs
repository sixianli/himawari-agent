import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAILED_LOG_TAIL_LINES,
  LINE_CHARACTERS,
  logLines,
  main,
  READ_LIMIT_BYTES,
  renderFailedLogs,
  renderSummary,
  SUMMARY_LIMIT_BYTES,
  TAIL_LINES,
} from "../../scripts/ci/ci-summary.mjs";
import { gateSummaryMarkdown, publicGate } from "../../scripts/ci/required.mjs";

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
  it("截断切开私钥时整份文件不显示", () => {
    const body = Array.from({ length: 30 }, (_, i) => `KEYBODY${i}${"Q".repeat(56)}`).join("\n");
    const marker = (kind) => ["-----", kind, " PRIVATE", " KEY-----"].join("");
    const big = `${"p".repeat(READ_LIMIT_BYTES)}\n${marker("BEGIN")}\n${"R".repeat(READ_LIMIT_BYTES)}\n${body}\n${marker("END")}\n`;
    const text = renderSummary({ title: "t", from: folder({ "key.log": big }) });
    expect(text).not.toContain("KEYBODY");
    expect(text).toContain("`key.log`：二进制文件");
  });
  it("遮盖规则不认的私钥标签也让整份文件不显示", () => {
    const marker = ["-----", "BEGIN", " SSH2 ENCRYPTED", " PRIVATE KEY-----"].join("");
    const text = renderSummary({
      title: "t",
      from: folder({ "ssh2.log": `${marker}\nBODYLINE\n` }),
    });
    expect(text).not.toContain("BODYLINE");
  });
  it("截断点落在多字节字符中间时从下一行开始显示", () => {
    const big = `${"字".repeat(READ_LIMIT_BYTES / 3 + 1)}\n尾行内容\n`;
    const text = renderSummary({ title: "t", from: folder({ "wide.log": big }) });
    expect(text).toContain("尾行内容");
    expect(text).not.toContain("二进制文件");
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
    main(
      ["--title", "policy/default 失败诊断", "--from", root],
      { GITHUB_STEP_SUMMARY: target },
      () => {},
    );
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

describe("检查失败时命令日志进作业摘要和作业日志", () => {
  const failing = [
    ...Array.from({ length: 200 }, (_, index) => `line ${index}`),
    " FAIL  test/tooling/example.test.mjs > 某条用例",
    `token ${secret}`,
  ].join("\n");
  const reports = (status) =>
    folder({
      "result.json": JSON.stringify({ status }),
      "unit.log": failing,
      "junit.xml": "<testsuite/>",
      "nested/build.log": "build ok\n",
    });
  it("失败时显示每个 .log 的最后 120 行，遮盖像密钥的内容，不显示别的报告", () => {
    const text = renderFailedLogs({ title: "policy/default 失败诊断", reports: reports("failed") });
    expect(text).toContain("### policy/default 失败诊断：命令日志");
    expect(text).toContain("FAIL  test/tooling/example.test.mjs > 某条用例");
    expect(text).toContain(`只显示最后 ${FAILED_LOG_TAIL_LINES} 行`);
    expect(text).toContain(`line ${200 + 2 - FAILED_LOG_TAIL_LINES}\n`);
    expect(text).not.toContain(`line ${200 + 1 - FAILED_LOG_TAIL_LINES}\n`);
    expect(text).toContain("`nested/build.log`");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("junit.xml");
    expect(text).not.toContain("result.json");
  });
  it("通过时不显示日志；结果文件缺失或读不懂时按失败显示", () => {
    expect(renderFailedLogs({ title: "t", reports: reports("passed") })).toBe("");
    expect(renderFailedLogs({ title: "t", reports: folder({ "a.log": "x\n" }) })).toContain(
      "`a.log`",
    );
    expect(
      renderFailedLogs({ title: "t", reports: folder({ "result.json": "{", "a.log": "x\n" }) }),
    ).toContain("`a.log`");
    expect(renderFailedLogs({ title: "t", reports: path.join(tmpdir(), "missing-reports") })).toBe(
      "",
    );
  });
  it("写进作业日志的每一行都带前缀，日志内容不能冒充工作流命令或汇总结论标记", () => {
    const hostile = "::add-mask::x\n##[error]boom\nHIMAWARI_GATE_BEGIN v1 abc\n";
    const root = reports("failed");
    writeFileSync(path.join(root, "unit.log"), hostile);
    const target = path.join(root, "summary.md");
    writeFileSync(target, "");
    const printed = [];
    const text = main(
      ["--title", "t", "--from", path.join(root, "none"), "--failed-logs", root],
      { GITHUB_STEP_SUMMARY: target },
      (chunk) => printed.push(chunk),
    );
    expect(readFileSync(target, "utf8")).toBe(text);
    const lines = printed.join("").split("\n").slice(0, -1);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => line.startsWith("| "))).toBe(true);
    expect(printed.join("")).toContain("| ::add-mask::x\n");
    expect(logLines("a\nb\n")).toBe("| a\n| b\n");
  });
  it("没有内容时不写摘要也不打印", () => {
    const root = reports("passed");
    const target = path.join(root, "summary.md");
    writeFileSync(target, "");
    const printed = [];
    main(
      ["--title", "t", "--from", path.join(root, "none"), "--failed-logs", root],
      { GITHUB_STEP_SUMMARY: target },
      (chunk) => printed.push(chunk),
    );
    expect(readFileSync(target, "utf8")).toBe("");
    expect(printed).toEqual([]);
  });
});

describe("ci/required 的作业摘要表", () => {
  it("打印进日志的汇总结论先遮盖像密钥的字符串", () => {
    const gate = publicGate({
      context: { runId: 1, headSha: "a".repeat(40) },
      summary: { status: "failed", checks: [{ reasons: [`path ${secret}`] }] },
    });
    expect(JSON.stringify(gate)).not.toContain(secret);
    expect(gate.context).toEqual({ runId: 1, headSha: "a".repeat(40) });
    expect(gate.summary.checks[0].reasons[0]).toBe("path [REDACTED]");
  });
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
