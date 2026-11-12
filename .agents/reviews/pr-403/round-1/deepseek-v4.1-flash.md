## 侧重检查

我优先检查了错误路径、不可信输入、资源耗尽和文档一致性，结论如下：

- **不可信正文/标题/附件名**：正文已放进围栏；标题和附件名经 `plainLine` 去掉 `[ ] < > \``。我核对了 `renderThread`、`CHATS.md` 的生成和文件名 `slugOf`，未发现可提前闭合围栏或跳出 Markdown 链接标签的路径。残留风险见“发现”中的低项。
- **错误路径**：新 `fenced` 在反引号段极多时可能抛原始异常，绕过导出已有的稳定错误码，见发现 1。
- **资源耗尽**：反引号匹配会先物化成数组再展开，存在内存和实参上限风险，见发现 1；导出本身的 128/256 MiB 上限是既有的。
- **不可逆操作**：本次改动只读数据库、生成导出文件/临时报告，不改表、不写业务数据；`check-chat-export.mjs` 只写临时目录并在 `finally` 里删除。未见不可逆副作用。
- **规则/文档一致性**：改动没有碰提示词组装、系统提示、工具定义或遮盖代码。ADR 0235 的门槛和脚本一致；ADR 第 51 行有一处反引号格式问题，见发现 3。

## 发现

### 1. 中：反引号段很多时，导出可能抛原始异常

**文件:行**：`packages/persistence-sqlite/src/data-export/chats.ts:250`

**问题**：`fenced` 把所有反引号连续段先物化成数组，再展开成 `Math.max` 的实参：

```ts
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
```

**证据**：上面第 250 行。读代码可以确认：段数等于数组元素数，也会全部作为函数实参展开。推测（未在本仓库运行验证，因为只被允许执行 git 只读命令）：一条正文里若有十几万到几十万个反引号段（1 MB 级别的文本即可做到），可能触发 V8 的实参数量上限或先耗尽内存，结果是导出直接抛 `RangeError`/内存错误，而不是 `CHAT_EXPORT_TOO_LARGE` 一类稳定错误。消息正文来自用户或模型，属于不可信输入；现有负向测试没有覆盖这种输入。

**建议**：改成循环求最大值，不建数组、不展开：

```ts
let longest = 0;
for (const run of text.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
```

并加一条含大量反引号段的消息用例，断言导出要么成功、要么给出稳定错误。

### 2. 低：新增反向用例没有覆盖附件名和 `CHATS.md` 的完整净化

**文件:行**：`test/integration/chat-export.test.ts:291`，对应代码 `packages/persistence-sqlite/src/data-export/chats.ts:282`、`:450`

**问题**：作者说“标题、附件名里的 `[ ] < > \`` 换成空格”，代码确实对三处都用了 `plainLine`，但新测试只覆盖了正文围栏和对话文件标题：

- 测试里没有任何附件，因此把 `chats.ts:282` 的 `plainLine(foldText(attachment.name))` 改回旧的 `foldText(...)`，所有测试仍会通过。
- 对 `CHATS.md` 只断言 `not.toContain("![")`；旧代码本来就会删掉方括号，这条断言在旧代码上也成立。它没有检查 `<b>` 或反引号，所以把 `CHATS.md` 的 `plainLine` 退回旧写法，测试也不会失败。

**证据**：

```ts
const hostile =
  "看 ![x](https://evil.example/p.png) 和 <img src=x onerror=1> 还有 ```` 四个反引号";
await seedThread(s, "t-1", {
  title: "标题 ![y](https://evil.example/t.png) <b>",
  messages: [{ text: hostile }],
});
...
expect(decoder.decode(files.get("CHATS.md"))).not.toContain("![");
```

测试没有 `attachments`，`CHATS.md` 的断言也只覆盖 `![`。

**建议**：同一用例再加一个名字为 `"![x](https://evil.example/a.png) <b> \`"` 的附件，并断言附件行不含这些字符；对 `CHATS.md` 同时断言不含 `<b>` 和反引号。

### 3. 低：ADR 里列举“换成空格”的字符时反引号嵌套不配对

**文件:行**：`docs/adr/0235-chat-history-export.md:51`

**问题**：原文使用了不配对的嵌套反引号，阅读器里无法清楚显示“反引号也被替换”这一点。

**证据**：

```text
标题和附件名里的 `[ ] < > `` ` ``` 换成空格
```

这里的反引号连续段长度是 1、2、1、3，Markdown 代码跨度会把其中一部分当成代码、另一部分留下字面量，读者很难看出实际替换的是 `[ ] < > \`` 五个字符。

**建议**：改成不含歧义的写法，例如“把 `[`、`]`、`<`、`>` 和反引号换成空格”，或用 `<code>` 包住反引号字符。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 改动只在离线导出路径：`buildChatExport` 被网页导出端和 `himawari-admin` 调用，这个 diff 没有修改提示词组装、系统提示、工具定义、历史消息或出口遮盖代码。导出生成的 Markdown 只写进导出文件，不作为模型请求的一部分发送。因此规则第 4 条“已发内容只能在末尾追加”（`.claude/rules/prompt-prefix.md:35`）不受影响；每轮变化的值仍然只应出现在最后一条用户消息，而这次改动没有触碰这条路径。依据：`.claude/rules/prompt-prefix.md:27-28`、`:35`；diff 只涉及 ADR、`packages/persistence-sqlite/src/data-export/chats.ts`、`scripts/check-chat-export.mjs` 和测试。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**这次改动没有引入新的不确定性。** `fenced` 和 `plainLine` 都是只依赖输入文本的纯函数，不读时间、不读上下文、不遍历无序集合。围栏长度只取决于正文自身的反引号段；`plainLine` 的替换也是逐字符确定的。`fenced` 会把正文的 CRLF 规范化成 LF，但这是对同一输入的固定映射，而且只影响 Markdown 副本，`data/threads.jsonl` 保持原文。既有的 `exportedAt` 和清单排序不在本次改动范围内。

### 3. 有没有对应的自动检查，反向用例会真的失败吗？

**有新增检查，但覆盖不完整。**

- 新用例在旧实现下会失败：旧代码用 `> ` 引用，不会出现五连反引号，`expect(markdown).toContain("\`\`\`\`\`\n...")` 会失败；标题净化断言也会失败。
- `check-chat-export.mjs` 现在把浏览器项目文件纳入，`REQUIRED = 36` 与当前 `[多人7]` 用例数一致：集成项目 35 条（`chat-export.test.ts` 24、`chat-export-http.test.ts` 6、`data-cli.test.ts` 5），浏览器项目 1 条，共 36 条。`vitest.workspace.ts:61-67` 确实有 `browser` 项目且包含该测试文件。
- 但发现 2 指出的附件名和 `CHATS.md` 净化没有真正的反向断言。
- 作者声称的 `format`、`lint`、`typecheck`、`check:chat-export（36 条）` 运行结果：**未核实**，本次只能使用 git 只读命令，不能运行 npm/node。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- **Markdown 文件内容格式**：使用方是 `verifyChatExport`。它只检查路径安全、文件存在、字节数和 SHA-256，不解析 Markdown 正文（`chats-verify.ts:42-48`）；`CHATS.md` 只要求存在且在清单里（`chats-verify.ts:50-51`）。因此围栏格式和净化后的标题都能通过校验。
- **对话文件名**：文件名公式是 `chats/<年-月>/<日期>-<slug>-<id 摘要>.md`，其中 `slugOf` 自己会把非字母数字替换成 `-`（`chats.ts:243-247`），不依赖 `plainLine` 的输出，因此标题净化不会把不安全字符带进路径。
- **`CHATS.md` 的链接目标**：目标是程序生成的 `thread.file`，不是标题，且生成路径受 `slugOf` 和日期/摘要约束，`verifyChatExport` 还会检查 `chats/` 前缀和 `.md` 后缀。
- **`data/threads.jsonl`**：标题和正文仍写入原值，没有经过 `plainLine` 或 `fenced`；与作者“仍是完整原文”的说法一致。
- **`scripts/check-chat-export.mjs` 的 `GROUPS.project = "browser"` 和文件路径**：`vitest.workspace.ts:61-67` 的项目名和 include 规则都能接受这个路径；门槛 `REQUIRED = 36` 与 ADR 0235 第 62 行的 36 一致。
- **清单字段/配置键/迁移**：本次没有新增或修改清单字段、配置键或数据库表，不存在“新 id 过不了后端校验”的同类问题。
- **文档**：ADR 第 51 行有发现 3 的格式问题；内容层面“最多反引号段加一、至少三个”和代码一致。
