## 结论摘要

本轮增量 `fea466a3..92e3ea7a` 中属于 PR 400 的实际改动只有 `81970d7e`（其余是 PR 397 合并进来的 CI 改动）。作者说的六项里，附件名截短、threads.jsonl 非法 UTF-8、检查门槛 32 条与代码一致；**打包超限 413 没有对应测试**；**data inspect 的"先读清单"引入了一个绕过目录安全检查的回归**；"单条文字上限和网页/命令行荷载上限一致"的说法与代码不符。

---

## 侧重检查

我按"不可信输入 / 资源耗尽 / 错误路径 / 文档与代码一致"逐条查了：

- **不可信输入**：`data inspect --from` 的 `manifest.json` 现在用裸 `readFile` 读（`apps/admin-cli/src/data-command.ts:140`），而 `readPortableDirectory` 对每个子项做 `lstat`、拒绝非普通文件、限制单文件 512 MiB 和总量（`packages/persistence-sqlite/src/data-export/directory.ts:50,57-61`）。这是本次新增的唯一一处绕过。
- **资源耗尽**：同一处 peek 无大小上限；ZIP 打包 512 MiB 上限在 `production-data-export.ts:87`，新增 413 分支在 `production-chat-export.ts:76-81`。
- **错误路径**：`LINE_INVALID` 映射到 `DATA_IMPORT_LINE_INVALID`（`types.ts:73`），CLI 用 `stableErrorCode` 输出 `.code`（`service-runtime.ts:45-53`），两端能对上；`MANIFEST_INVALID` 路径有测试。
- **安全**：网页导出的鉴权、同源、单实例锁、413 空响应本轮未改；新增日志只记错误码，不含用户内容。未发现新的密钥泄露路径。
- **不可撤销操作**：inspect/export 都是只读；导出写到必须为空的目录，不覆盖。无此类风险。
- **规则/文档一致**：ADR 0235 的 32 条、512 MiB 413、只对聊天放宽 20 万/2 GiB 与代码基本一致；但 commit message 的"单条文字上限和网页、命令行荷载上限一致"与 `2_000_000_000` 不符。

---

## 发现（按严重度）

### 1.【中】【证实】`data inspect` 的清单预读绕过目录安全检查，可被符号链接/FIFO/超大文件拖死

- 位置：`apps/admin-cli/src/data-command.ts:140`
- 问题：新增的格式预读直接读 `path.join(from, "manifest.json")`，没有 `lstat`，没有大小上限，也不经过 `readPortableDirectory` 的普通文件校验。
- 证据：
  - `apps/admin-cli/src/data-command.ts:140`：`const peeked = await readFile(path.join(from, "manifest.json"), "utf8").catch(() => "");`
  - 原本的目录读取会拒绝非普通文件和超限文件：`packages/persistence-sqlite/src/data-export/directory.ts:50` `const stat = await lstat(full);`，`:57` `if (!stat.isFile() || stat.size > MAXIMUM_FILE_BYTES || files.size >= fileLimit) throw ...`。
- 后果：`--from` 指向的归档里把 `manifest.json` 做成：
  - 指向 `/dev/zero` 或大文件的符号链接：`readFile` 会把整个目标读进内存，可 OOM；
  - FIFO：`readFile` 会一直等写端，inspect 挂住；
  - 符号链接还会读到 `--from` 目录之外的文件（虽然内容只用于取 `format`，但读取本身已发生）。
  目录读取随后会拒绝该符号链接，但为时已晚。
- 建议：先 `lstat` 并只接受普通文件、限制清单大小（例如几 MiB），或用 `O_NOFOLLOW` 打开；补一条 `manifest.json` 为符号链接/FIFO/超大文件的失败用例。

### 2.【中】【证实】"打包超限返回 413"没有任何自动检查，且依赖裸字符串耦合

- 位置：`apps/agent-service/src/production-chat-export.ts:76-81`
- 问题：新分支靠 `error.message === "DATA_EXPORT_TOO_LARGE"` 识别打包超限；全仓库该字符串只出现在生产者 `production-data-export.ts:87` 和这个消费者，没有任何测试制造该错误。
- 证据：
  - 现有唯一 413 用例 `test/integration/chat-export-http.test.ts:163-170` 传的是 `maximumBytes=50`，会在 `buildChatExport` 的荷载预检就抛 `CHAT_EXPORT_TOO_LARGE`（`chats.ts:149`），根本到不了 `createStoredZip`。
  - `DATA_EXPORT_TOO_LARGE` 的 grep 结果只有源码两处，无测试。
- 后果：如果以后 `createStoredZip` 改错误消息、或 chat 路由的 catch 被改动，声称的 413 会静默退化成 500，现有测试不会红。另外 `production-data-export.ts` 对同一错误仍返回 500（既有行为），两端处理不一致。
- 建议：把 `"DATA_EXPORT_TOO_LARGE"` 提成 `production-data-export.ts` 导出的常量；给 `createStoredZip` 增加可注入上限或单独测试"超限时抛该常量"，并让 chat 路由对该常量的映射有直接用例。

### 3.【低】【证实+推测】"只对聊天导出放宽上限"依赖归档自己声明的 format，不构成资源边界

- 位置：`apps/admin-cli/src/data-command.ts:147-152`
- 证据：`:149` `declaredFormat === CHAT_FORMAT_VERSION ? { maximumFiles: 200_000, maximumTotalBytes: 2 * 1024 * 1024 * 1024 } : {}`，而 `declaredFormat` 来自归档里的 `manifest.json`（`:140-143`）。
- 后果：恶意归档只要写 `"format":"himawari.chat-export.v1"`，就能让 inspect 先按 20 万文件 / 2 GiB 读满，之后 `verifyChatExport` 才失败。相比基线的"所有格式都放宽"不是退步，但新注释/ADR 暗示的"只对聊天放宽"不是安全边界。
- 建议：无论声明什么格式，都设一个统一的读取上限；或在文档里写明这是"减少误放宽"而非安全控制。

### 4.【低】【证实+推测】非聊天导出的 inspect 上限被收紧，可能检查不了自己刚导出的记忆包

- 位置：`apps/admin-cli/src/data-command.ts:147-152`
- 证据：非聊天分支传 `{}`，即 `readPortableDirectory` 默认的 4096 个文件 / 512 MiB（`directory.ts` 的 `MAXIMUM_FILES`、`MAXIMUM_TOTAL_BYTES`）；基线是 20 万 / 2 GiB。
- 后果：记忆导出本身没有对应的文件数/总大小上限（`writePortableDirectory` 只拒绝非空目录），若某个记忆包超过 4096 个文件或 512 MiB，`data inspect` 现在会以 `DATA_IMPORT_PATH_UNSAFE` 失败。`data import` 本来就用默认上限，所以两边现在至少一致，但 ADR 只写了"记忆导入仍是 4096 个、512 MB"，没写 inspect 也被收紧。
- 未核实：真实记忆包是否可能超过该上限（按 `MARKDOWN_LINES_PER_FILE=500` 分文件，文件数一般不大；总量取决于记忆条数）。
- 建议：在 ADR 0235 里补一句 inspect 的默认上限；若认为 inspect 只读、可以更宽松，则单独给非聊天 inspect 一个明确上限而不是复用导入默认值。

### 5.【低】【证实】"单条文字上限和网页、命令行荷载上限一致"与代码不符

- 位置：`packages/persistence-sqlite/src/data-export/chat-schemas.ts:11`
- 证据：`const text = (minLength = 0, maxLength = 2_000_000_000)`；而 ADR 0235 写的网页上限是 128 MiB、命令行上限是 256 MiB，`CHAT_EXPORT_WEB_MAXIMUM_BYTES = 128 * 1024 * 1024`。2e9 字符远大于这两个数。
- 后果：功能上不会出错（上限更松），但提交说明的"一致"不成立；同时没有测试覆盖 >1 亿字符的边界。另需注意 `schema.ts:32` 用 `[...value].length` 校验长度，接近上限的单条文字会产生与字符数等量的临时数组，属于既有实现，不是本次引入。
- 建议：要么把上限写成与真实荷载上限对应的值/从常量推导，要么在提交说明和 ADR 里改成"放宽到实际不可能达到，避免合法大消息让整份导出失败"。

### 6.【信息】【证实】附件名 1000 与 schema 1024 是两处独立魔数

- 位置：`packages/persistence-sqlite/src/data-export/chats.ts:322`、`chat-schemas.ts:40`
- 证据：截短到 1000 个 code point（`Array.from(name).slice(0, 1000).join("")`），schema `name: text(0, 1024)`，校验器按 code point 计数（`schema.ts:32` `const length = [...value].length`）。
- 结论：当前实现正确——1000 < 1024，且 `Array.from` 不会劈开代理对。新增测试只用 BMP 字符 `"长".repeat(3000)`，若以后有人改成 `name.slice(0,1000)`，该测试不会发现孤立的代理项。
- 建议：把 1000/1024 收成一个共享常量，并补一条 emoji（astral）附件名用例。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（本轮增量不涉及模型请求）。** `fea466a3..92e3ea7a` 中属于 PR 400 的改动只碰聊天导出、admin CLI、schema、测试和文档；没有修改系统提示、工具定义、历史消息、遮盖或 `runtime-pi`/prompt-catalog。聊天导出生成的 Markdown 只是文件，不会自动进入模型请求。

因此"发给模型的内容仍然只在末尾追加、每轮会变的值都在最后一条消息里"这一条没有被本改动触动。宽范围 `65d39ca..head` 里的 prompt 相关文件来自合并进来的 main（PR 397 等），不是本 PR 的 `81970d7e`，我未逐行核对这些外部改动（**未核实**）。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**对模型请求：不会，理由同上。** 对导出本身：

- 线程、消息、文件顺序固定（SQL `ORDER BY`、`files.keys().sort()`、canonical JSON），附件名截短和机密遮盖只取决于输入本身，是确定的。
- 但 `manifest.exportedAt = options.now()`、ZIP 时间戳随导出时刻变化，所以"相同数据两次导出"不是逐字节相同；测试 `[多人7] export is deterministic` 固定了 `NOW` 才成立。这与提示缓存无关，属于导出格式的正常时间字段。

### 3. 有没有对应的自动检查，反向用例真的会失败？

| 改动 | 测试 | 结论 |
|---|---|---|
| 附件名截短 | `chat-export.test.ts:278` | **有**。修复前 3000 字符会撞 schema 1024 使 `verifyChatExport` 抛 `LINE_INVALID`，用例会红；当前截到 1000 可通过。仅覆盖 BMP。 |
| threads.jsonl 非法 UTF-8 | `chat-export.test.ts:463` | **有且有效**。`fixedUp` 同步了 bytes/sha256，修复前 `decoder.decode` 抛原始 TypeError，取不到 `LINE_INVALID`，用例会红。 |
| 打包超限 413 | 无 | **缺**。现有 413 用例走的是 `maximumBytes=50` 的预检分支（`chats.ts:149`），没有触发 `DATA_EXPORT_TOO_LARGE`。 |
| inspect 只对聊天放宽 | `data-cli.test.ts:447`（4100 文件） | **只覆盖正向**：聊天包 >4096 能读；没有"非聊天包 >4096/ >512 MiB 被拒"的反向用例，也没有清单为符号链接/FIFO/超大文件的用例。 |
| 单条文字上限 2e9 | 无 | **缺**（实际也很难构造）。 |
| 门槛 32 条 | `scripts/check-chat-export.mjs:14` | 三份测试里带 `[多人7]` 的 `it` 恰好 32 条，`REQUIRED=32` 与 ADR 一致。**未运行**，无法确认"32 条通过"的实际结果。 |

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `"DATA_EXPORT_TOO_LARGE"` | `production-data-export.ts:87` | `production-chat-export.ts:78` → 413；`production-data-export.ts` 的 catch → 500（既有） | 聊天端接受；但两端是裸字符串，建议常量化（见发现 2） |
| `LINE_INVALID` → `DATA_IMPORT_LINE_INVALID` | `chats-verify.ts:58` | 测试 `chat-export.test.ts:467`；CLI `stableErrorCode`（`service-runtime.ts:45-53`）读 `.code` | 接受，`stableErrorCode` 的正则也允许该值 |
| `CHAT_FORMAT_VERSION` | `chat-schemas.ts`，导出清单 | `data-command.ts:149,153`、`verifyChatExport` | 同一常量，接受 |
| `200_000` / `2 GiB` | `data-command.ts:150` | `readPortableDirectory` | 接受；但格式自报，见发现 3 |
| 文字上限 `2_000_000_000` | `chat-schemas.ts:11` | `validateAgainst`、导出自检、inspect | 接受；与作者说法不一致，见发现 5 |
| 附件名 1000 | `chats.ts:322` | schema `name` 上限 1024（`chat-schemas.ts:40`）、Markdown 渲染 | 接受（1000 code point < 1024） |
| `REQUIRED = 32` | `check-chat-export.mjs:14` | ADR 0235 决定 8、32 条 `[多人7]` 用例 | 一致 |

## 未核实

- `.agents/reviews/pr-400/round-2-judgments.md` 和 round-2 复核原文：工作树里没有 `.agents/reviews/`，`git show` 被记录路径规则拒绝，未能核对作者"逐条判断"的内容。
- 测试是否真的全绿：本轮只读代码，未运行 `check:chat-export` / `data-cli` 测试。
- 真实聊天数据能否在 128 MiB 荷载内让打包结果超过 512 MiB（决定 413 分支的实际触发概率）；按换行密集文本的两份副本估算接近或略超，但未实测。
