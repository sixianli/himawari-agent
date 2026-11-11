## 复核结论（按严重度从高到低）

### 1.（低，推测的运行时风险，代码逻辑是读代码证实的）
- **文件：行**：`packages/persistence-sqlite/src/data-export/chats.ts:250`
- **问题**：`fenced()` 用 `Math.max(0, ...[...text.matchAll(/`+/gu)].map(...))` 求最长反引号连续段。若一条消息里反引号连续段非常多（例如几十万段、约几百 KB 的正文即可达到），把超大数组展开成 `Math.max` 的参数会抛 `RangeError: Maximum call stack size exceeded`，`buildChatExport` 整体失败，网页端表现为 500（`apps/agent-service/src/production-chat-export.ts:88-90` 只把稳定错误码外的错误归为 `CHAT_EXPORT_FAILED`）。改动前的 `quote()` 没有这个问题，属于本次引入的健壮性回退；消息写入侧是否有长度上限未核实。
- **证据**：chats.ts:249-252（`const longest = Math.max(0, ...[...text.matchAll(...)]...)`）。
- **建议**：改成 for 循环求最大值，顺手加一条“反引号段极多”的 `[多人7]` 用例。

### 2.（信息，文档略窄于代码）
- **文件：行**：`docs/adr/0235-chat-history-export.md:51` vs `chats.ts:450`
- **问题**：ADR 只说“标题和附件名里的 `[ ] < > ` 换成空格”，但代码对 `CHATS.md` 索引里的标题标签也做了同样的清洗（旧代码只清 `[ ]`，这次扩到 `< > 和反引号`）。行为更安全，但文档没提。
- **建议**：ADR 那句补上“索引里的标题同样清洗”。

### 3.（信息）
- **文件：行**：`chats.ts:260,282`
- **问题**：`plainLine` 只清 `[ ] < > ` 和反引号；标题/附件名里的 `*`、`_`、`~` 仍可能被阅读器渲染成强调/删除线。不违反本次声称的目标（链接、图片、HTML），只是目标本身有限。**读代码证实行为，是否要修属判断题。**

### 核对通过、无问题的（读代码证实）
- **围栏构造正确**：`fenced`（chats.ts:249-253）取正文最长反引号段 +1、至少 3 个；开栏、正文、闭栏各占一行，闭栏不可能被正文里更短的反引号段提前闭合。`\r\n` 在 Markdown 里归一为 `\n`，`data/threads.jsonl` 由 `exportText`/`jsonLines` 独立生成，仍是原文——与作者说法一致。
- **清洗范围与 ADR 一致**：标题（chats.ts:260）、附件名（chats.ts:282）、索引标签（chats.ts:450）都过 `plainLine`；首行为空时回退“（没有标题）”（chats.ts:262）。
- **门槛 34→36 的计数**：`[多人7]` 用例逐条数：chat-export.test.ts 24 条（含新增反例，test/integration/chat-export.test.ts:291）、chat-export-http.test.ts 6 条、data-cli.test.ts 5 条，共 35；浏览器项目 memory-interactions.unit.test.ts:1561 有 1 条，合计恰好 36，`REQUIRED = 36`（scripts/check-chat-export.mjs:20）成立。ADR 0235 第 62 行与脚本一致。
- **新反例对旧代码确实会失败**：旧代码是 `> ` 引用、无围栏、标题不清洗，新用例的三条断言（五连反引号围栏、首行无 `[]<>` 和反引号、CHATS.md 无 `![`）至少前两条必然失败。这是推理证实，未实际运行。
- **浏览器分组可运行**：vitest.workspace.ts:61-67 定义 `browser` 项目包含该文件；文件首行 `// @vitest-environment jsdom` 自带环境，fetch/URL 全部 mock，不依赖真实服务。
- **脚本状态传递正确**：每组 vitest 非零退出都会把 `status` 置非零（check-chat-export.mjs:47），报告缺失时通过数不足 36 也会失败，改动没有引入“静默放过”。

## 侧重检查（流程走查）

普通流程：记忆页点“导出聊天记录”（memory-interactions.unit.test.ts:1561，有覆盖）→ `GET /api/data-export/v1/chats`（production-chat-export.ts:37，鉴权/限流/413 由 chat-export-http.test.ts 6 条覆盖）→ `buildChatExport`（chats.ts:289）→ `readChatSnapshot` 只读 SQL → 解密 payload → `renderThread`/`fenced`/`plainLine`（本次改动，正例在 chat-export.test.ts:146、反例 :291，有覆盖）→ 打包 zip → 响应头/清单数字（chats-verify.ts 只校验哈希与计数、不解析 Markdown 正文，chats-verify.ts:42-48，故格式改动对 inspect/verify 消费端无影响）。命令行走 `data export-chats`（data-cli.test.ts 覆盖）。
**无覆盖的路径**：`fenced` 的极端输入（正文以反引号结尾、CRLF、超长反引号段——第 1 条）；`scripts/check-chat-export.mjs` 脚本本身在 `test/tooling/` 下没有任何测试（grep 无命中），门槛数字全靠人肉同步。
作者声称的 format/lint/typecheck/36 条通过：无法运行验证，**未核实**；但 diff 里没有明显会挂格式检查的写法。

## 必答问题

1. **不会改变模型见过的请求开头。** 改动只有 4 个文件（ADR、chats.ts、check 脚本、集成测试），全部在聊天导出/工具链路径；`buildChatExport` 的调用方只有 `production-chat-export.ts:50`（HTTP 下载）和 `admin-cli/src/data-command.ts:273`（CLI），`renderThread`/`fenced`/`plainLine` 均为模块内私有（grep 证实），不在任何模型请求构造链路上。发给模型的内容 untouched，谈不上破坏“只在末尾追加”。
2. **不会。** `fenced`/`plainLine` 是纯函数，无时间、无集合顺序依赖（`matchAll` 顺序确定）；同一数据导出字节确定的性质由既有用例守住（chat-export.test.ts:351 "export is deterministic"）。遮盖逻辑（`exportText`/policy.mask）本次未改。
3. **有，且反向用例会真失败。** 新用例挂在 `[多人7]` 标签下，被 `check:chat-export`（package.json:27、53）纳入 `npm run check`；对旧代码（`quote()` 引用式、标题不清洗）新用例的围栏断言和首行断言必然失败——推理证实，未实际运行。脚本本身无自动化测试（上面侧重检查已列）。
4. **能接受。** 本次没有产生新的标识、字段、配置键或清单项；被修改的“值”是 Markdown 文件的字节格式，其唯一机器消费方 `verifyChatExport`（chats-verify.ts）只校验路径安全、哈希和计数（chats-verify.ts:42-48、112-125），不解析正文，网页端和 CLI 两条产出路径用的都是同一 `renderThread`，两端一致。清单的行数记法（Markdown 记 0）未变。未核实：消息写入侧长度限制（影响第 1 条的实际可达性）。
