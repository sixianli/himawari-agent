import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAILED_LOG_TAIL_LINES,
  FAILED_TESTS_SHOWN,
  FAILURE_MESSAGE_LINES,
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
  it("总量不超过上限，放不下的列出前 5 个名字", () => {
    const files = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `f${String(i).padStart(2, "0")}.log`,
        `${"y".repeat(LINE_CHARACTERS)}\n`.repeat(TAIL_LINES),
      ]),
    );
    const text = renderSummary({ title: "t", from: folder(files) });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SUMMARY_LIMIT_BYTES);
    expect(text).toMatch(
      /其余 \d+ 个文件超出 65536 字节的摘要上限，没有显示（`f\d\d\.log`、.* 等）。/u,
    );
  });
  it("超大文件只读末尾一段，控制字符被替换", () => {
    const big = `${"h".repeat(READ_LIMIT_BYTES)}\nhead-only\n${"t\n".repeat(10)}last \u001b[31mred\u0007\n`;
    const text = renderSummary({ title: "t", from: folder({ "big.log": big }) });
    expect(text).toContain("last red?");
    expect(text).not.toContain("[31m");
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

describe("检查失败时失败用例和命令日志进作业摘要和作业日志", () => {
  const vitestReport = (extra = []) =>
    JSON.stringify({
      testResults: [
        {
          name: "/work/test/tooling/example.test.mjs",
          status: "failed",
          assertionResults: [
            { status: "passed", fullName: "example 通过的用例", failureMessages: [] },
            {
              status: "failed",
              fullName: "example 某条失败的用例",
              failureMessages: [
                `AssertionError: expected 1 to be 2\n    at token ${secret}\n${"at frame\n".repeat(40)}`,
              ],
            },
            ...extra,
          ],
        },
        {
          name: "/work/test/tooling/broken.test.mjs",
          status: "failed",
          message: "SyntaxError: 文件加载失败",
          assertionResults: [],
        },
      ],
    });
  const reports = (status, overrides = {}) =>
    folder({
      "result.json": JSON.stringify({
        status,
        reports: [
          { path: "policy.log", kind: "diagnostic" },
          { path: "vitest-tooling.log", kind: "diagnostic" },
          { path: "vitest-tooling.json", kind: "json" },
          { path: "vitest-tooling.xml", kind: "junit" },
          { path: "details.json", kind: "json" },
          { path: "bundle.log", kind: "artifact" },
        ],
      }),
      "details.json": JSON.stringify({
        commands: [
          { name: "policy", exitCode: 0 },
          { name: "vitest-tooling", exitCode: 1 },
        ],
      }),
      "policy.log": [...Array.from({ length: 200 }, (_, index) => `line ${index}`), "ok"].join(
        "\n",
      ),
      "vitest-tooling.log": `vitest exited\ntoken ${secret}\n`,
      "vitest-tooling.json": vitestReport(),
      "vitest-tooling.xml": "<testsuite/>",
      "bundle.log": "raw artifact bytes\n",
      "stray.log": "not listed in result.json\n",
      ...overrides,
    });
  it("失败时列出失败用例名和报错开头，再显示登记为日志的 .log，失败命令的日志排前面", () => {
    const text = renderFailedLogs({ title: "policy/default 失败诊断", reports: reports("failed") });
    expect(text).toContain("### policy/default 失败诊断：失败的用例（共 2 条）");
    expect(text).toContain("/work/test/tooling/example.test.mjs > example 某条失败的用例");
    expect(text).toContain("AssertionError: expected 1 to be 2");
    expect(text).toContain("/work/test/tooling/broken.test.mjs > （整个文件失败）");
    expect(text).toContain("SyntaxError: 文件加载失败");
    expect(text).not.toContain("example 通过的用例");
    expect(text.split("at frame").length - 1).toBe(FAILURE_MESSAGE_LINES - 2);
    expect(text).toContain("### policy/default 失败诊断：命令日志");
    expect(text.indexOf("`vitest-tooling.log`")).toBeLessThan(text.indexOf("`policy.log`"));
    expect(text).toContain(`只显示最后 ${FAILED_LOG_TAIL_LINES} 行`);
    expect(text).toContain(`line ${200 + 1 - FAILED_LOG_TAIL_LINES}\n`);
    expect(text).not.toContain(`line ${200 - FAILED_LOG_TAIL_LINES}\n`);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("raw artifact bytes");
    expect(text).not.toContain("not listed in result.json");
    expect(text).not.toContain("<testsuite/>");
  });
  it("失败用例太多时只显示前 30 条并报数量", () => {
    const extra = Array.from({ length: 50 }, (_, index) => ({
      status: "failed",
      fullName: `批量失败 ${index}`,
      failureMessages: ["boom"],
    }));
    const text = renderFailedLogs({
      title: "t",
      reports: reports("failed", { "vitest-tooling.json": vitestReport(extra) }),
    });
    expect(text).toContain("失败的用例（共 52 条）");
    expect(text).toContain(`其余 ${52 - FAILED_TESTS_SHOWN} 条失败的用例没有显示。`);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SUMMARY_LIMIT_BYTES);
  });
  it("用例名和报错里的换行类字符、反引号、颜色码不会破坏排版", () => {
    const hostile = JSON.stringify({
      testResults: [
        {
          name: "a\u2028::add-mask::x",
          status: "failed",
          assertionResults: [
            {
              status: "failed",
              fullName: "t`\n::error::y",
              failureMessages: ["\u001b[31mred\u001b[0m\u2029next\n````\nend"],
            },
          ],
        },
      ],
    });
    const text = renderFailedLogs({
      title: "t",
      reports: reports("failed", { "vitest-tooling.json": hostile }),
    });
    expect(text).toContain("a?::add-mask::x > t??::error::y");
    expect(text).toContain("red?next\n` ` ` `\nend");
    for (const character of ["\u2028", "\u2029", "\u001b"]) expect(text).not.toContain(character);
  });
  it("通过时不显示；result.json 读不出来时只写一句说明，不显示任何文件；目录不存在时为空", () => {
    expect(renderFailedLogs({ title: "t", reports: reports("passed") })).toBe("");
    for (const broken of ["{", JSON.stringify({ status: "failed" }), "null"]) {
      const text = renderFailedLogs({
        title: "t",
        reports: reports("failed", { "result.json": broken }),
      });
      expect(text).toContain("`result.json` 读不出来");
      expect(text).not.toContain("vitest exited");
    }
    expect(renderFailedLogs({ title: "t", reports: path.join(tmpdir(), "missing-reports") })).toBe(
      "",
    );
  });
  it("result.json 里指向目录外的路径不读", () => {
    const outside = JSON.stringify({
      testResults: [
        {
          name: "outside.test.mjs",
          status: "failed",
          assertionResults: [
            { status: "failed", fullName: "outside name", failureMessages: ["outside secret"] },
          ],
        },
      ],
    });
    const root = folder({
      "outside.json": outside,
      "outside.log": "outside secret\n",
      "elsewhere/linked.json": outside,
      "inner/real.log": "inside log\n",
    });
    const inner = path.join(root, "inner");
    symlinkSync(path.join(root, "elsewhere"), path.join(inner, "link"));
    symlinkSync(path.join(root, "outside.json"), path.join(inner, "direct.json"));
    writeFileSync(
      path.join(inner, "result.json"),
      JSON.stringify({
        status: "failed",
        reports: [
          { path: "real.log", kind: "diagnostic" },
          { path: "../outside.log", kind: "diagnostic" },
          { path: "../outside.json", kind: "json" },
          { path: path.join(root, "outside.json"), kind: "json" },
          { path: "link/linked.json", kind: "json" },
          { path: "direct.json", kind: "json" },
        ],
      }),
    );
    const text = renderFailedLogs({ title: "t", reports: inner });
    expect(text).toContain("inside log");
    expect(text).not.toContain("outside");
  });
  it("用例名里带私钥标记时整个名字不显示", () => {
    const marker = ["-----", "BEGIN", " SSH2 ENCRYPTED", " PRIVATE KEY-----"].join("");
    const text = renderFailedLogs({
      title: "t",
      reports: reports("failed", {
        "vitest-tooling.json": JSON.stringify({
          testResults: [
            {
              name: "plain.test.mjs",
              status: "failed",
              assertionResults: [
                { status: "failed", fullName: `${marker}\nkeybody`, failureMessages: ["boom"] },
              ],
            },
          ],
        }),
      }),
    });
    expect(text).toContain("plain.test.mjs > ?\n");
    expect(text).not.toContain("keybody");
  });
  it("文件名是多字节字符时，加上说明文字也不超过上限", () => {
    const from = folder(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `${"汉".repeat(60)}${String(i).padStart(2, "0")}.log`,
          "short\n",
        ]),
      ),
    );
    const first = Buffer.byteLength(renderSummary({ title: "t", from, limit: 100000 })) / 12;
    const over = [];
    for (let limit = Math.ceil(first) + 800; limit < first * 6; limit += 1) {
      const text = renderSummary({ title: "t", from, limit });
      expect(text).toContain("没有显示（");
      if (Buffer.byteLength(text) > limit) over.push(limit);
    }
    expect(over).toEqual([]);
  });
  it("颜色码夹在密钥或私钥标记中间时，先去颜色码再遮盖", () => {
    const esc = String.fromCharCode(27);
    const split = `${secret.slice(0, 10)}${esc}[31m${secret.slice(10)}${esc}[0m`;
    const marker = ["-----", "BEGIN", `${esc}[31m`, " SSH2 ENCRYPTED", " PRIVATE KEY-----"].join(
      "",
    );
    const text = renderFailedLogs({
      title: "t",
      reports: reports("failed", {
        "vitest-tooling.log": `token ${split}\n`,
        "policy.log": `${marker}\nkeybody-log\n`,
        "vitest-tooling.json": JSON.stringify({
          testResults: [
            {
              name: `file ${split}`,
              status: "failed",
              assertionResults: [
                { status: "failed", fullName: `name ${split}`, failureMessages: [`m ${split}`] },
                { status: "failed", fullName: "other", failureMessages: [`${marker}\nkeybody-m`] },
              ],
            },
          ],
        }),
      }),
    });
    expect(text).toContain("file ");
    expect(text).not.toContain(secret.slice(10, 30));
    expect(text).not.toContain("keybody");
    expect(text).toContain("`policy.log`：二进制文件");
  });
  it("冒号参数的颜色码和超链接序列夹在密钥或文件名的私钥标记中间时也先去掉", () => {
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    const pieces = [`${esc}[38:2::255:0:0m`, `${esc}]8;;https://example.invalid${bell}`];
    const marker = ["-----", "BEGIN", pieces[0], " SSH2 ENCRYPTED", " PRIVATE KEY-----"].join("");
    for (const piece of pieces) {
      const split = `${secret.slice(0, 10)}${piece}${secret.slice(10)}`;
      const text = renderSummary({
        title: "t",
        from: folder({ "a.log": `token ${split}\n`, [`${marker} body.log`]: "x\n" }),
      });
      expect(text).toContain("#### `a.log`");
      expect(text).not.toContain(secret.slice(10, 30));
      expect(text).not.toContain("body.log");
    }
  });
  it("文件名带私钥标记时整个名字不显示", () => {
    const marker = ["-----", "BEGIN", " SSH2 ENCRYPTED", " PRIVATE KEY-----"].join("");
    const text = renderSummary({ title: "t", from: folder({ [`${marker} body.log`]: "x\n" }) });
    expect(text).toContain("#### `?`");
    expect(text).not.toContain("body.log");
  });
  it("上限小到连说明文字都放不下时不写说明文字", () => {
    const from = folder({ "a.log": "x\n".repeat(50), "b.log": "y\n" });
    for (const limit of [10, 60, 120, 200]) {
      const text = renderSummary({ title: "t", from, limit });
      const header = Buffer.byteLength("### t\n\n");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(Math.max(limit, header));
    }
  });
  it("文档里写的三个数字就是代码里的值", () => {
    expect([FAILURE_MESSAGE_LINES, FAILED_LOG_TAIL_LINES, FAILED_TESTS_SHOWN]).toEqual([
      20, 120, 30,
    ]);
  });
  it("写进作业日志的每一行都带前缀，日志内容不能冒充工作流命令或汇总结论标记", () => {
    const hostile = "::add-mask::x\n##[error]boom\nHIMAWARI_GATE_BEGIN v1 abc\nu\u2028::error::z\n";
    const root = reports("failed", { "vitest-tooling.log": hostile });
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
    expect(printed.join("")).toContain("| u?::error::z\n");
    expect(logLines("a\nb\n\n")).toBe("| a\n| b\n");
  });
  it("没有内容时不写摘要也不打印；--failed-logs 不能是空串", () => {
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
    expect(() =>
      main(["--title", "t", "--from", root, "--failed-logs", ""], { GITHUB_STEP_SUMMARY: target }),
    ).toThrow("CI_SUMMARY_ARGUMENTS");
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
