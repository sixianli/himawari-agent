我先查看当前仓库状态和两轮 diff 的范围。
## 综述

增量（`3b37a573..050577a1`）与作者说法基本一致：`fenced` 已从展开运算改为循环，新增 30 万段反引号用例，附件名和索引标题补了反向断言，ADR 和检查脚本都改成 37 条。未发现会改变模型请求开头的高危问题，但有 1 个资源边界风险和 3 个测试/文档方面的问题。

## 发现（按严重度）

### 1. 中：超长单段反引号仍可能把输出放大到约两倍，新增用例没有覆盖这个边界

- 文件: `packages/persistence-sqlite/src/data-export/chats.ts:249-253`
- 问题: 围栏长度取“全文最长反引号连续段 + 1”，于是输出至少包含围栏本身的长度。正文全部是反引号时，输出长度约为正文的两倍。新增用例只覆盖 `300_000` 个长度为 1 的反引号段，不覆盖单个超长连续段。
- 证据:

```ts
let longest = 0;
for (const run of text.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
const fence = "`".repeat(Math.max(3, longest + 1));
return `${fence}\n${text.replace(/\r\n?/gu, "\n")}\n${fence}`;
```

```ts
await seedThread(s, "t-1", { messages: [{ text: "` ".repeat(300_000) }] });
```

- 说明: “会在某个具体长度抛 `RangeError`”是推测，未实测；但“单个超长段会让围栏和正文各占一份、总量接近两倍”是读代码可确认的。命令行的 256 MiB 上限下，单个长反引号段可能逼近 V8 字符串长度上限，也会明显增加内存占用。原 `quote()` 只按行加前缀，没有这种成倍增长。
- 建议: 增加一个“单个超长反引号段”的边界用例；或者在构造围栏前先按长度设明确上限并返回稳定错误，避免在字符串拼接阶段才抛 `RangeError`；或者改用不依赖正文长度的缩进代码块方案。

### 2. 低：附件名的反向断言可能空过

- 文件: `test/integration/chat-export.test.ts:307-308`
- 问题: 找不到附件行时 `attachmentLine` 变成空字符串，`not.toMatch` 对空字符串必然通过。因此附件标签被误删、附件名没渲染出来时，这条新增断言仍然通过。
- 证据:

```ts
const attachmentLine = markdown.split("\n").find((line) => line.startsWith("- 附件：")) ?? "";
expect(attachmentLine).not.toMatch(/[[\]<>`]/u);
```

- 建议: 先断言 `attachmentLine` 非空，并断言其中确实出现了附件名净化后的内容，例如 `expect(attachmentLine).toContain("a.png")` 或同时核对 `thread.messages[0].attachments.length`。已有用例 `chat-export.test.ts:233`、`:256` 覆盖附件列表，但这条针对恶意名字的断言本身仍有空过风险。

### 3. 低：索引标题的反向断言也可能空过

- 文件: `test/integration/chat-export.test.ts:311-313`
- 问题: 只断言索引中不含 `![`、`<b>` 和反引号。如果索引漏掉了这个对话，或者标题没写进索引，断言同样通过；而 `verifyChatExport` 不解析 Markdown 内容，只校验文件存在、哈希和清单计数，无法补上这个检查。
- 证据:

```ts
const index = decoder.decode(files.get("CHATS.md"));
expect(index).not.toContain("![");
expect(index).not.toMatch(/<b>|`/u);
```

`chats-verify.ts:50-51` 只检查必需文件，`:112-125` 只核对清单里的条数，不检查 Markdown 内容。

- 建议: 增加正向断言，例如 `expect(index).toContain(thread.file)`，或断言索引中包含净化后的标题文本及“共 1 个对话”。

### 4. 低：ADR 里的 `[已扣留:N]` 与 Markdown 中的实际显示不一致

- 文件: `docs/adr/0235-chat-history-export.md:56`、`packages/persistence-sqlite/src/data-export/chats.ts:283,333`
- 问题: ADR 决定 4 写附件名含机密时换成 `[已扣留:N]`；但 `safeName()` 生成带方括号的值放进 `data/threads.jsonl` 后，渲染 Markdown 时又经过 `plainLine()`，方括号被替换成空格，所以可读 Markdown 里显示的是 ` 已扣留:N `，不是 `[已扣留:N]`。ADR 决定 1 要求附件名里的方括号换成空格，两条规则合在一起会得到这个结果，但文档没有说明“JSONL 保留方括号，Markdown 去掉方括号”。
- 证据:

```ts
return `[已扣留:${number}]`;
```

```ts
`- 附件：${plainLine(foldText(attachment.name))}（${attachment.kind}，${attachment.bytes} 字节，文件本体未导出）`
```

- 建议: 在 ADR 中明确区分机器文件与可读 Markdown 的占位形式；如果希望 Markdown 也显示 `[已扣留:N]`，则不要让 `plainLine` 处理这个占位符。

## 读代码证实的

- `fenced` 的实现确实已改为循环；30 万段用例确实存在，且每段长度为 1。
- ADR 第 51 行已补“索引里的标题”同样清洗；代码在 `chats.ts:451` 对索引标题调用 `plainLine`。
- `REQUIRED` 在 `scripts/check-chat-export.mjs:20` 是 37，ADR 第 62 行也是 37；仓库内按 `it("[多人7]...` 统计到 37 个用例。
- `chats.ts:470` 仍在清单中写入 `exportedAt: options.now()`；这是既有行为，不是本次增量新增。
- `verifyChatExport` 不解析 Markdown，因此围栏格式变化不会破坏校验；`manifest.files[].bytes/sha256` 在 Markdown 渲染后计算，内部一致。
- `safeName` 截到 1000 个 Unicode 码点，`ATTACHMENT_SCHEMA` 上限 1024，且 `schema.ts:32` 用 `[...value].length` 按码点计数，两端兼容。
- `slugOf` 最多 30 个码点，路径最长约 69 个码点，低于 schema 的 256，两端兼容。

## 推测/未核实

- 30 万段用例在旧实现上会因 `Math.max(0, ...array)` 超过 V8 参数上限而失败，这是读代码推断；本环境只能运行 git 命令，没有实际执行测试。
- 作者称 `Fast-mode-checks` 和 `check:chat-export（37 条）` 通过，未核实。
- `.agents/reviews/pr-403/round-1/judgments.md` 未读取成功（`git show` 对该记录路径被拒绝，diff 中显示为二进制），因此无法逐条核对第一轮意见的回应。
- 单段超长反引号达到 V8 字符串上限的具体阈值未实测，只知道输出量约为正文两倍。

## 侧重检查

- 错误路径: 看了 `fenced`、`plainLine`、`safeName`、`verifyChatExport`；非法 UTF-8、异常 `created_at`、超限导出都有既有用例。新增边界缺口是“单个超长反引号段”。
- 不合规范/不可信输入: 正文已放入代码围栏；标题、附件名、索引标题经过 `plainLine`，会去掉 `[ ] < >` 和反引号，能阻止 Markdown 图片、链接和 HTML 注入。附件行和索引行的新增断言存在空过风险。
- 安全: 没有新增网络请求、导入或命令执行；导出仍是只读。围栏能阻止阅读器渲染正文中的链接、图片和 HTML。
- 资源耗尽: 300k 个短段导致的展开运算问题已修；单个超长段的两倍输出和内存增长仍未受测试或显式上限保护。
- 不可撤销操作: 本次改动只涉及导出文件渲染，不删除或改写用户数据；没有新的不可撤销路径。
- 规则/文档与代码: 37 条门槛、索引标题清洗、围栏说明与代码一致；`[已扣留:N]` 在 Markdown 中的形式存在文档歧义。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本次增量只改 `data-export/chats.ts` 的导出 Markdown 生成，以及测试、ADR 和检查脚本。`buildChatExport` 的调用点只有 `apps/agent-service/src/production-chat-export.ts:50` 和 `apps/admin-cli/src/data-command.ts:273`，都是导出入口，不参与系统提示、工具定义、历史消息或出口遮盖的组装。生成的 `CHATS.md` 和各对话 Markdown 是用户下载的文件，代码里没有把它送进模型请求的路径。因此没有“请求开头变化”的问题；发给模型的内容仍应由原有提示组装逻辑控制，本次改动没有新增任何进入请求头的值。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

改动本身的 Markdown 渲染是确定的：围栏长度只取决于正文里的反引号段，`plainLine` 只取决于传入文字，不含时间、随机数或无序集合。标题、附件名、正文的遮盖也仍是逐条调用同一个策略，不依赖后文。

但整个导出包不是逐字节稳定的：`chats.ts:470` 的 `exportedAt: options.now()` 每次导出都会变，ZIP 的时间戳也会变；这是既有设计，不是本次增量引入。`safeName` 的编号依赖遍历顺序，在相同数据库顺序下也是确定的，但它是按导出过程分配的，不是内容哈希。若这里的“确定性”是要求整包跨请求逐字节一致，需要单独处理 `exportedAt`，不能只看 Markdown。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有门槛：`scripts/check-chat-export.mjs` 将 `REQUIRED` 改为 37，并把记忆页界面测试纳入 `browser` 组；仓库内确实有 37 个带 `[多人7]` 的用例。新增的 30 万段反引号用例针对旧的展开运算，按代码推断在旧实现上会失败；本环境未实际运行，不能确认作者所说的通过记录。

但反向断言有两处空过风险：附件行找不到时 `attachmentLine` 为空，索引断言不要求标题真的出现在索引里。也就是说，删除附件渲染或索引条目时，这两条断言不一定失败。另有一个覆盖缺口：没有测试单个超长反引号段，也没有测试接近命令行 256 MiB 上限时的内存/字符串长度边界。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？

- `fenced` 产生的围栏长度和格式: 只用于 Markdown 文件；`manifest` 的 `bytes` 和 `sha256` 在渲染后计算，`verifyChatExport` 按文件重新计算哈希，`files[].lines` 对 Markdown 按 ADR 记为 0，校验端只对数据文件检查行数，因此两端一致。
- `plainLine` 产生的标题、附件名和索引标签: 只进入人读的 Markdown；`data/threads.jsonl` 里仍是原始标题和 `safeName` 结果，二者没有被同一个校验器混用，没有发现“清单里的值过不了另一端校验”的情况。
- `REQUIRED = 37`: 检查脚本和 ADR 都是 37；按 `[多人7]` 统计的用例也是 37。没有发现其他仍写 36 或 34 的同类门槛。
- `safeName` 的 1000 码点与附件 schema 的 1024 上限: 兼容，因为 schema 用 `[...value].length` 按码点检查。
- `slugOf` 的 30 码点与路径 schema 的 256 上限: 兼容。
- `[已扣留:N]`: JSONL 中保留带方括号的形式；Markdown 中 `plainLine` 会去掉方括号。没有发现下游代码要求 Markdown 中必须保留方括号，但这属于 ADR 未说明清楚的展示差异，建议在文档中写清。
