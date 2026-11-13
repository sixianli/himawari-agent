## 结论

本轮增量没有发现高、中严重度的问题。`firstChangedMessage` 的核心算法和 5026 这个期望值都对得上；I-99 的门槛文字也与当前测试一致。下面列出的都是低风险或信息级问题，以及一处作者描述与增量不符。

## 读代码证实的发现

### 1. 低：新用例没有覆盖“后一条更短/消息缺失”这两条你点名的路径

- 文件:行：`test/tooling/opencode-review.test.mjs:1986-2010`
- 问题：新用例只构造了“后一条更长、且差异藏在很长消息的尾部”的情况，并顺带断言纯追加返回空串；没有覆盖 `later.messages` 更短、或 `later.messages[index]` 缺失时提示是否仍然可读。我按代码推演这两条路径是正常的，但没有自动回归保护。
- 证据：

  ```js
  // test/tooling/opencode-review.test.mjs:2003-2009
  expect(message).toContain("message 1 of 2 changed (later request has 3)");
  expect(message).toContain("first difference at character 5026");
  ...
  firstChangedMessage(earlier, { messages: [...earlier.messages, { role: "user" }] }),
  ).toBe("");
  ```

  对于“更短”的情况，`findIndex` 会在 `later.messages[position] === undefined` 的位置命中差异，`after` 为 `"null"`；对于普通对象消息，提示正常。
- 建议：补两条断言：`later.messages` 截短到 1 条时包含 `later request has 1` 且显示被删消息的内容；`later.messages` 中途缺失时也能定位。

### 2. 信息：作者说“只改测试辅助、测试和文档”，但增量还新增了复核记录并改了账本

- 文件:行：`.agents/reviews/pr-482/round-4/deepseek-v4.1-flash.md`、`.agents/reviews/pr-482/round-4/deepseek-v4.1-flash.prompt.md`、`.agents/reviews/pr-482/round-4/judgments.md`、`.agents/reviews/pr-482/round-4/verdicts.jsonl`（均新增）、`.agents/reviews/pr-482/usage.jsonl`（修改）
- 问题：`0c7a1e972..ac1c9ffb3` 的实际文件清单除了测试辅助、测试、`docs/incidents-and-gates.md` 外，还包含上述复核记录和账本。把它们排除在“代码改动”之外可以理解，但“只改……”的字面说法不准确。
- 证据：

  ```text
  diff --git a/.agents/reviews/pr-482/round-4/deepseek-v4.1-flash.md b/.agents/reviews/pr-482/round-4/deepseek-v4.1-flash.md
  new file mode 100644
  ...
  diff --git a/.agents/reviews/pr-482/usage.jsonl b/.agents/reviews/pr-482/usage.jsonl
  ```

  这些文件在本环境被按规则隐藏：`git show ...:.agents/reviews/pr-482/round-4/judgments.md` 返回 `REVIEW_GIT_REFUSED records-path ...`，所以内容是否有敏感信息**未核实**。
- 建议：把作者描述改为“测试辅助、测试、文档和本轮复核记录/账本”；复核记录是否通过 I-86 的遮盖检查以合并门为准。

### 3. 极低（场景罕见）：消息本身为 `null` 且后一条缺失时，提示会说“有差异”但两边都显示 `null`

- 文件:行：`test/tooling/opencode-review.fixtures.mjs:186-193`
- 问题：`?? null` 把“后一条不存在”和“消息值为 `null`”都规范成字符串 `"null"`。若 `earlier.messages[index] === null`、`later.messages[index] === undefined`，`findIndex` 判定有差异，但 `before` 和 `after` 都变成 `"null"`，`at` 走到 4，最终输出“first difference at character 4 of 4 (later 4)”，两条内容却完全相同。模型消息实际都是对象，影响很小。
- 证据：

  ```js
  // test/tooling/opencode-review.fixtures.mjs:186-189
  const before = JSON.stringify(earlier.messages[index] ?? null);
  const after = JSON.stringify(later.messages[index] ?? null);
  let at = 0;
  while (at < before.length && before[at] === after[at]) at += 1;
  ```

- 建议：区分“位置不存在”和“值为 null”，例如缺失时显示 `<missing>`，或先判断 `later.messages[index] === undefined` 单独输出“later 缺少这条消息”。

## 推测

### 4. 极低：`at` 是 UTF-16 code unit 下标，遇到 emoji 时“字符位置”和窗口边界可能与肉眼不符

- 文件:行：`test/tooling/opencode-review.fixtures.mjs:188-191`
- 问题：`before[at]` 和 `slice` 都按 UTF-16 单元操作，不是 Unicode 码点；差异出现在代理对附近时，窗口可能从半个 emoji 开始，报告的位置也会比按码点计数多 1。中文本身通常是单个 code unit，不受影响。
- 证据：

  ```js
  while (at < before.length && before[at] === after[at]) at += 1;
  const start = Math.max(0, at - 300);
  const shown = (text) => `${start > 0 ? "…" : ""}${text.slice(start, at + 1200)}`;
  ```

- 建议：若在意，可改成 `Array.from`/码点计数，或至少在输出里写“UTF-16 位置”。这只是诊断文字，不影响判定。

### 5. 极低：诊断窗口扩大后，失败日志可能打印到消息更深处的内容

- 文件:行：`test/tooling/opencode-review.fixtures.mjs:190-195`
- 问题：旧实现固定打印每条消息前 2000 字符；新实现会打印差异点附近最多约 1500 字符，差异在消息尾部时会输出以前不会出现在日志里的片段。如果测试请求里含敏感样例，CI 日志的暴露面略增。CI 中 `execute` 会先对子进程输出跑 `redactText`，但只覆盖已知模式；本地 `npm test` 不经过这层遮盖。属于测试诊断路径，非生产请求。
- 证据：

  ```js
  const shown = (text) => `${start > 0 ? "…" : ""}${text.slice(start, at + 1200)}`;
  ```

- 建议：无需阻断；保持测试数据不含真实秘密即可。若担心，可在断言消息里再调用与 `redactText` 相同的遮盖。

## 侧重检查

- **错误路径**：读了 `firstChangedMessage` 的 `findIndex`、字符串逐字符比较和 `shown` 窗口。正常对象消息下，后一条更短/更长/缺失都不会抛错；追加型请求返回空串，符合 `expectAppendedTo` 的用法。仅 `earlier.messages` 本身不是数组时才会抛 TypeError，测试调用方都传数组。
- **不合规范/不可信输入**：函数只用于测试捕获到的请求，输出是 vitest 断言消息，不进入生产序列化；没有命令执行、路径拼接或 HTML 注入面。
- **资源耗尽**：失败路径会对整条消息做 `JSON.stringify`，与旧实现同一量级；输出被截到约 1500 字符/行，没有无界打印。大消息只增加一次性内存/时间，未发现新的耗尽点。
- **安全**：`RUNNER_TRACKING_ID` 不是凭据，`runnerTracking` 只接受非空字符串；它被加入 `execute`、两处 `git()`、`isolatedEnvironment` 和 Python 解包环境，都是环境变量注入，不参与命令拼接。未发现凭据泄漏；`.agents/reviews` 内容本环境不可读，未核实。
- **不可撤销操作**：本轮只改测试辅助、测试、文档和复核记录，没有删除、覆盖或迁移生产数据。
- **规则/文档与代码一致性**：I-99 新写的测试标题与 `test/tooling/runner.test.mjs:186` 完全一致；对 `test/tooling/toolchain.test.mjs:279-305` 的描述也与断言一致。`check-incident-gates` 只校验门槛文件路径存在（`test/tooling/incident-gates.test.mjs:52-59`），不会校验“用例标题”是否仍存在，因此标题以后被改仍可能静默过期。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个范围里没有改动组装模型请求的代码；增量是测试辅助、测试、文档和复核记录。整个 `8c8c895..ac1c9ff` 也没有 `packages/*` 的提示词/适配器改动，`apps/control-center` 只是把 `AttachmentKind` 类型从 `attachment-text.ts` 移到 `draft-attachments.ts`，是纯类型、无运行时字节。发给模型的内容仍由未改动的代码只在末尾追加；本轮没有新增“每轮会变的值”。测试辅助字符串和 CI 的 `RUNNER_TRACKING_ID` 都不进入模型请求。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会由本轮改动引起。`firstChangedMessage` 的输出只取决于传入的两条消息，`JSON.stringify` 和 `slice` 是确定性的，不含时间、随机数或无序集合；它本身也不写回请求。`runnerTracking()` 每个作业内取值固定，只进子进程环境，不进模型请求。控制中心的类型移动不改变任何序列化格式。

3. **有没有自动检查，反向用例是否真的会失败？**
   有新检查：`test/tooling/opencode-review.test.mjs:1986-2010`。按代码推断，如果把实现改回 `slice(0, 2000)`，用例会在 `first difference at character 5026`、`OLD`、`NEW` 三处失败；我没有实际运行测试（本环境只允许读文件和读 git），所以这是推断而非实测。缺失/更短路径没有反向用例，见发现 1。`RUNNER_TRACKING_ID` 的两条测试也有反向价值：去掉 `execute` 里的合并或 `isolatedEnvironment` 里的展开，断言会失败；同样未实际执行。文档文字没有自动校验，只有门槛文件路径存在性检查。

4. **每个产生或修改的值，使用它的人都能接受吗？**
   - `RUNNER_TRACKING_ID`：产生于 `scripts/ci/runner-tracking.mjs:1-4`，只接受非空字符串；使用于 `scripts/ci/execute.mjs:14`、`scripts/ci/check-security.mjs:80`、`scripts/ci/security-exceptions.mjs:30`、`scripts/ci/install-tools.mjs:361`、`scripts/ci/security-redaction.mjs:173`。这些位置都是传给 `spawn`/`spawnSync`/`execFileSync` 的环境对象，接受任意字符串，没有会拒绝该键的校验；我逐个核对了使用点。
   - `AttachmentKind`：从 `attachment-text.ts` 移到 `draft-attachments.ts`，`attachment-text.ts:3` 反向导入；全仓库搜索只有这两处 TypeScript 使用点，没有仍从 `attachment-text.ts` 导入该类型的文件，因此旧导出消失不会造成引用断裂。
   - 新增的错误文本格式（`coverage-model.mjs:242-248`）：使用方是 `test/tooling/coverage.test.mjs:336-348`，其中的 `branch 0 line 2 type "cond-expr" counts [1,-2]` 与实现和 `record()` 夹具一致，校验两端能对上。
   - 测试标题和文档文字：`docs/incidents-and-gates.md:133` 是唯一文档使用方，标题与 `runner.test.mjs:186` 一致；没有自动校验标题是否过期。
