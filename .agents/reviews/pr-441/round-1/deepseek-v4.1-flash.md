## 结论概览

改动本身不触碰模型请求组装，因此不影响已发前缀；`| ` 前缀能挡住 GitHub 工作流命令和 `ci/required` 的标记伪造。主要问题在功能面上：**只挑 `.log`，而 vitest 的失败用例名/断言详情在 `reports/<id>.json`/`<id>.xml` 里**，加上 64 KiB 全局预算可能把真正的失败日志整体挤掉；触发本 PR 的那条 `2503 passed, 1 failed` 很可能仍然看不到用例名。

---

## 读代码证实的问题

### 1. [高] `--failed-logs` 只显示 `.log`，把结构化失败详情排除；对 vitest 失败很可能仍查不到用例名

- 文件：`scripts/ci/ci-summary.mjs:134-141`、`scripts/ci/run.mjs:206-224`、`scripts/ci/publish.mjs:92-118`
- 问题：失败日志筛选条件是文件名后缀 `.log`，而 vitest 的用例名、`failureMessages` 在 JSON/JUnit 报告里，这两份文件被发布到同一个 `reports/` 目录，但不会进入 `--failed-logs`。
- 证据（亲自读到）：

```js
// scripts/ci/ci-summary.mjs:134-141
export function renderFailedLogs({ title, reports }) {
  if (!existsSync(reports) || !checkFailed(reports)) return "";
  return renderSummary({
    title: `${title}：命令日志`,
    from: reports,
    tailLines: FAILED_LOG_TAIL_LINES,
    only: (relative) => relative.endsWith(".log"),
  });
}
```

```js
// scripts/ci/run.mjs:208-224
const filename = path.join(directory, `${id}.json`);
const junit = path.join(directory, `${id}.xml`);
const args = [
  ...
  "--reporter=json",
  "--reporter=junit",
  `--outputFile.json=${filename}`,
  `--outputFile.junit=${junit}`,
];
files.push({ path: filename, kind: "json" }, { path: junit, kind: "junit" });
```

```js
// scripts/ci/publish.mjs:92-118
const diagnostic = /\.(?:png|jpe?g|webp|zip)$/u.test(report.path);
const target = path.join(diagnostic ? diagnostics : reports, report.path);
...
const binary = diagnostic || report.kind === "artifact";
if (binary) copyFileSync(source, target);
else writeFileSync(target, redactReport(...), { flag: "wx" });
...
if (!diagnostic) retained.push(reportEntry(target, report.kind, reports));
```

- 结论：`<id>.json` 和 `<id>.xml` 确实在 `reports/` 里，但 `--failed-logs` 明确只读 `.log`。因此本 PR 举的例子（`policy` 的 `vitest-tooling` 失败）即使 `.log` 里没有失败用例名，代码也不会去读有名字的 JSON/JUnit。
- 建议：不要只按扩展名扫目录；读 `result.json.reports` 里 `kind` 为 `json`/`junit` 的条目，从 `assertionResults[].failureMessages` 或 JUnit `<failure>` 中只渲染失败的用例名和首段错误，再补充 `.log` 尾巴。或者给 `run.mjs` 的 vitest 命令显式加 `--reporter=default`，让 `.log` 本身包含可读失败信息（见下方推测）。

### 2. [中] 全局 64 KiB 预算会让排序靠后的失败日志整体消失，footer 只报数量不报名

- 文件：`scripts/ci/ci-summary.mjs:108-121`、`scripts/ci/ci-summary.mjs:15-19`
- 问题：每个 `.log` 最多 120 行、每行最多 500 字符，单文件 section 可达约 60 KiB；而 `renderSummary` 对整个 failed-logs 只给 64 KiB。文件按路径排序，靠前的大日志会耗尽预算，真正失败的日志会整段被省略，footer 只写“其余 N 个文件……没有显示”，不列文件名。
- 证据：

```js
// scripts/ci/ci-summary.mjs:111
: `#### \`${name}\`（${file.size} 字节${tail.omitted ? `，只显示最后 ${tailLines} 行` : ""}）\n\n\`\`\`\`text\n${tail.text}\n\`\`\`\`\n\n`;
// scripts/ci/ci-summary.mjs:112-118
const remaining = files.length - shown - 1;
const footer = `其余 ${files.length - shown} 个文件超出 ${limit} 字节的摘要上限，没有显示。\n`;
const reserve = remaining > 0 ? FOOTER_RESERVE_BYTES : 0;
if (used + Buffer.byteLength(section) + reserve > limit) {
  sections.push(footer);
  break;
}
```

- 影响：`policy` 的日志排序是 `policy.log`、`toolchain.log`、`vitest-tooling.log`，失败详情在最后；前两个一旦偏大，真正要看的 vitest 日志就完全看不到。
- 建议：至少列出被省略的文件名；按文件分配预算而不是全局一个上限；优先显示 `details.json` 中 `commands[].exitCode !== 0` 的命令对应日志。`details.json` 已经在 `reports/` 且包含每个命令的退出码（`scripts/ci/run.mjs` 的 `details.commands.push({ name, ...outcome })`）。

### 3. [低] `.log` 判据用扩展名而不是已校验的 `result.json` 元数据；理论上有未遮盖的 `.log` artifact 被打印

- 文件：`scripts/ci/publish.mjs:91-118`、`scripts/ci/ci-summary.mjs:140`
- 问题：`publish` 对 `report.kind === "artifact"` 的文件走 `copyFileSync`，不经过 `redactReport`；而 `--failed-logs` 只按 `.log` 后缀挑文件。如果以后出现一个被声明为 artifact、路径又以 `.log` 结尾的报告，会把未遮盖字节直接打进作业日志。
- 证据：

```js
// scripts/ci/publish.mjs:95-98
const binary = diagnostic || report.kind === "artifact";
if (binary) copyFileSync(source, target);
else writeFileSync(target, redactReport(readFileSync(source, "utf8"), report.kind, sentinels), ...);
```

- 现状：当前 artifact 是构建归档（`.tar.gz`/`.zip` 一类），因此这条目前大概率不会触发，属于条件性风险。
- 建议：按 `result.json.reports` 里的 `kind`/`classification` 选择文本日志，而不是看扩展名；这也符合 I-73 的教训——两端都用同一份已校验元数据。

### 4. [低] U+2028/U+2029 没有被清理；不影响 runner 命令和 gate 解析，但可在摘要/日志可视化里伪造成“没有 `| ` 的新行”

- 文件：`scripts/ci/ci-summary.mjs:74-78`、`scripts/ci/gate-log.mjs:28`
- 问题：`textTail` 只把 Cc 类控制字符换成 `?`，U+2028（Zl）和 U+2029（Zp）不是 Cc，会保留。
- 证据：

```js
// scripts/ci/ci-summary.mjs:74-78
const lines = redacted
  .replace(/\r\n?/gu, "\n")
  .replace(/\n$/u, "")
  .replace(/[^\P{Cc}\n\t]/gu, "?")
  .split("\n");
```

```js
// scripts/ci/gate-log.mjs:26-29
const lines = log
  .replace(/^﻿/u, "")
  .split(/\r?\n/u)
  .map((line) => line.replace(TIMESTAMP, ""));
```

- 结论：GitHub Actions 的 runner 按 `\n` 切分进程输出（外部行为，未在本仓库验证），`gate-log.mjs` 只按 `\r?\n` 切分，所以 U+2028 不能用来注入工作流命令或伪造 gate 标记；但作业摘要 Markdown 和某些日志查看器可能把 U+2028 当换行，人眼会看到一行没有 `| ` 前缀的内容。
- 建议：把 `\p{Zl}\p{Zp}` 也替换成 `?`，并补一条反向用例。

### 5. [低] 自动化用例用的是合成失败日志，缺少“publish 产物 → ci-summary 实际输出”的端到端用例

- 文件：`test/tooling/ci-summary.test.mjs:145-170`、`test/tooling/policy.test.mjs:685-700`
- 问题：测试里的 `" FAIL  test/tooling/example.test.mjs > 某条用例"` 是手写的，不能证明真实 vitest 日志里会出现这一行；`policy.test` 只校验 workflow 命令字符串逐字一致，不能证明 `.ci-output/public/reports` 真的会被 `publish` 写成那个布局。
- 证据：

```js
// test/tooling/ci-summary.test.mjs:147-150
const failing = [
  ...Array.from({ length: 200 }, (_, index) => `line ${index}`),
  " FAIL  test/tooling/example.test.mjs > 某条用例",
  `token ${secret}`,
].join("\n");
```

- 建议：加一条集成用例：构造失败的 `CheckResult`，跑 `publish`，再对发布后的 `reports/` 跑 `renderFailedLogs`，断言能读到失败用例名；再加一条真实 reporter 输出的样本用例。

### 6. [低] 文档与代码的小不一致

- 文件：`docs/adr/0243-ci-uses-no-github-artifacts.md:58-59`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:250`、`scripts/ci/ci-summary.mjs:135`
- 问题：
  - ADR 第 4 条标题仍是“**诊断只写进作业摘要**”，但补充说明已经改成“同时打印到作业日志”，标题和首句自相矛盾。
  - 设计文档写“**检查失败时**……和失败诊断一起写进作业摘要”，但 `ci.yml` 的 diagnostics 部分在检查成功时也会打印到日志（`main` 只要有 `text` 就写）。
  - 作者说法“`result.json` 读不出来按失败显示”，代码里 `reports` 目录不存在时是直接返回空字符串，不是按失败显示（`if (!existsSync(reports) || !checkFailed(reports)) return ""`）。
- 建议：把 ADR 第 4 条标题/首句改成“诊断和失败命令日志写入作业摘要，并打印到作业日志”；设计文档改成“诊断始终显示，命令日志仅在失败时显示”；明确 `reports` 缺失时不显示。

---

## 推测 / 未核实

1. **vitest 的 `.log` 可能根本不包含失败用例名。** `run.mjs` 只启用了 `--reporter=json` 和 `--reporter=junit`（`scripts/ci/run.mjs:219-220`），两份结果都写文件。仓库自己的 Hermes 脚本为了留下可读日志，显式加了 `--reporter=default`：

```bash
# scripts/delivery-mode/hermes/run-release-walkthrough.sh:45
-t 'release acceptance in a real browser' --reporter=default --reporter=json --outputFile="$walk/vitest.json" > "$walk/vitest.log" 2>&1
```

   另外 `scripts/check-prompt-prefix.mjs:27-36` 用 `--reporter=json` 时直接忽略 stdout、只读 JSON 文件。由此推断 CI 的 `vitest-tooling.log` 可能几乎是空的；但没有在本环境实际跑 vitest 验证，标为**未核实**。如果属实，上面第 1 条就是本 PR 目标未达成的直接原因。

2. **U+2028 在 GitHub 日志查看器/摘要 Markdown 中的换行表现**未在本仓库验证；只确认了代码没有清理它，以及 `gate-log.mjs` 不按它切分。

3. **是否存在 `.log` 后缀的 artifact**：当前构建/浏览器归档都是 `.tar.gz`/`.zip`，未发现 `.log` artifact；第 3 条属于条件性风险。

---

## 侧重检查

- **错误路径**：`result.json` 缺失、不是 JSON、`status` 非 `passed` 都按失败显示，测试覆盖（`test/tooling/ci-summary.test.mjs:172-181`）。`reports` 目录缺失时返回空，不按失败显示，与作者说法有出入。检查在 `publish` 之前就失败的情况（如装依赖失败）仍不会产生摘要，这是改动前就存在的限制，本 PR 未覆盖。
- **不合规范/不可信输入**：日志内容来自 PR 测试输出，经过 `execute` 的 `redactText`、`publish` 的 `redactReport`，以及 `renderSummary` 的再次 `redactText`；`publish` 的 `assertPublicArtifacts` 还会校验发布文件本身已无匹配模式的敏感串。私钥开始/结束标记、NUL、非 UTF-8、控制字符都有处理（`scripts/ci/ci-summary.mjs:60-73`）。残余风险是正则覆盖不到的密钥，以及上面第 3、4 条。
- **安全/注入**：`| ` 前缀加在每个 `\n` 分隔行首（`scripts/ci/ci-summary.mjs:144-149`），`::xxx::`、`##[xxx]` 不再位于行首，按 GitHub Actions 的命令解析规则不会被执行；`gate-log.mjs` 只读 `ci/required` 作业日志，且只按 `\r?\n` 切分、要求恰好一段标记（`scripts/ci/gate-log.mjs:30-32`），检查作业的日志不会进入该解析。没有发现能伪造 gate 标记的路径。
- **资源耗尽**：每个 `.log` 最多读 256 KiB（`READ_LIMIT_BYTES`）、最多 120 行、每行最多 500 字符；每个 `renderSummary` 最多 64 KiB，诊断和失败日志两段合计约 128 KiB，远低于 GitHub 作业摘要 1 MiB 限制，作业日志也不会被显著撑大。`result.json` 整文件读取，但它是 `publish` 生成的固定结构，不随测试数量膨胀。
- **不可撤销操作**：改动只追加 `GITHUB_STEP_SUMMARY` 并写 stdout，没有删除/覆盖；但日志一旦包含未被规则识别的秘密，进入作业日志后 3 天内不可撤回，这一点依赖现有遮盖和 `assertPublicArtifacts`。
- **规则/说明文档和代码一致性**：`check-policy.mjs` 与 `policy.test.mjs` 的逐字命令已同步 `--failed-logs`；ADR 第 6 条、设计文档已同步；第 4 条标题和“检查失败时”的措辞仍与代码不一致（见第 6 条）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。本次 diff 只改了 `.github/workflows/*.yml`、`scripts/ci/*.mjs`、测试和文档，没有触碰系统提示、工具定义、历史消息或模型请求的遮盖逻辑。按 [prompt-prefix.md](../.claude/rules/prompt-prefix.md) 的“只追加”规则，新增的日志内容如果被代理读取，也是作为新的资料/消息追加，不会改写已发内容；每轮变化的值（这次失败日志）位于新追加的末尾，不在请求开头。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会影响模型请求的序列化。CI 输出本身在给定文件集和 `result.json` 状态下是确定的：文件按相对路径排序（`scripts/ci/ci-summary.mjs:38`），没有时间字段，遮盖只依赖当前文本（`redact-text.mjs`）。唯一的“不同”是：同一段日志在 `status === "passed"` 时不显示、失败时显示——这是设计上的状态门控，不是模型请求字节的不确定性。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，但不完整：
- `test/tooling/ci-summary.test.mjs:134-215` 覆盖 120 行尾巴、密钥遮盖、`result.json` 通过/缺失/损坏、`| ` 前缀、无内容不输出。
- `test/tooling/policy.test.mjs:685-700` 和 `scripts/ci/check-policy.mjs:558-564` 逐字校验六个检查作业的 `--failed-logs` 命令；删掉或改掉这个参数会因字符串不相等而失败，缺失/重复摘要步骤也会失败。
- 缺口：没有 U+2028/U+2029 用例；没有 `publish` 产物到 `ci-summary` 的端到端用例；没有真实 vitest 日志样本，无法证明生产日志里真的有失败用例名。以上反向用例即使补上，也应确保“真实失败日志没被打印”时会失败。

**4. 每个新值/路径/状态，产生它的地方和使用它的地方是否都接受？**

- `--failed-logs`：workflow 产生，`ci-summary.mjs` 的参数白名单接受（`scripts/ci/ci-summary.mjs:159`），`check-policy.mjs` 和 `policy.test.mjs` 校验通过，已更新。
- `.ci-output/public/reports`：路径由 `publish.mjs` 的 `--output .ci-output/public` 加 `reports/` 产生，`result.json` 和 `.log` 都在其中（`publish.mjs:93,122-123`）；`ci-summary` 读取。两端能对上，但校验只靠 workflow 字符串逐字比对，没有测试证明 `publish` 的布局变化会让这条检查失败。
- `result.json.status`：生产者是 `run.mjs` 的 `CheckResult`，schema 枚举为 `passed/failed/infrastructure_failed`（`ci/result.schema.json:112`），消费者只把 `"passed"` 当成功，其他都当失败，合理；缺失/坏 JSON 也当失败，符合作者说法（但 `reports` 目录整个缺失时例外）。
- `FAILED_LOG_TAIL_LINES = 120`：只在 `ci-summary.mjs` 内部和测试使用，消费端一致。
- `.log` 后缀：生产端 `publish` 按 `report.kind`/扩展名决定是否遮盖，消费端按扩展名挑选；两端判据不完全同源，是第 3 条的风险点。建议改用 `result.json.reports` 的 `kind`/`classification`。
- stdout 文字：workflow 里没有其他步骤解析 `ci-summary` 的 stdout；`main-evidence.mjs` 只下载名为 `ci/required` 的作业日志（`scripts/ci/main-evidence.mjs:162-172`），而 `ci/required` 的日志由 `required.mjs` 直接写 gate（`scripts/ci/required.mjs:77`），不受 `ci-summary` 影响。`main.yml` 两个作业打印摘要不会污染 PR 运行的 `ci/required` 日志，所以 `main-evidence.mjs discover` 不受影响。
