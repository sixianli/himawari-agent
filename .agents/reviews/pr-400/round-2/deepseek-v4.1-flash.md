## 范围说明

我按 `efd1796e..aa481374` 核对了 PR 400 的第 2 轮改动（`aa481374`），并用 `aa481374..fea466a3` 确认：聊天导出相关文件在合并 `main` 后没有继续变化；`efd..fea` 里其余大量文件来自其他 PR/`main` 合并，不属于本次 PR 400 增量，未作为本次结论依据。作者关于 `npm run check` 的说法无法运行验证，标为「未核实」；测试数量做了静态核对。

---

## 发现（按严重度）

### 中：413 只覆盖了 `CHAT_EXPORT_TOO_LARGE`，归档大小上限和单条文字上限仍会变成 500

- 文件：`apps/agent-service/src/production-chat-export.ts:75-85`、`apps/agent-service/src/production-data-export.ts:19,87`、`packages/persistence-sqlite/src/data-export/chats.ts:142-150`、`packages/persistence-sqlite/src/data-export/chat-schemas.ts:11`
- 问题：网页导出的 413 只匹配 `CHAT_EXPORT_TOO_LARGE`。但同一路径上还有两个「太大」来源不会得到 413：
  1. `createStoredZip` 在归档超过 512 MiB 时抛 `RangeError("DATA_EXPORT_TOO_LARGE")`；
  2. 单条消息/标题超过 JSON Schema 的 100,000,000 字符上限时，导出末尾自检抛 `DATA_IMPORT_LINE_INVALID`。
  两者都会走通用 catch，返回 500；前端只在 413 时显示「改用命令行」。
- 证据：
  - `production-chat-export.ts:76`：`if (error instanceof Error && error.message === CHAT_EXPORT_TOO_LARGE)`
  - `production-data-export.ts:19`：`const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;`
  - `production-data-export.ts:87`：`if (offset > MAXIMUM_ARCHIVE_BYTES) throw new RangeError("DATA_EXPORT_TOO_LARGE");`
  - `chat-schemas.ts:11`：`const text = (minLength = 0, maxLength = 100_000_000)`
  - ADR 0235 第 59 行写的是「超过 128 MiB 就返回 413」，与实际错误路径不完全一致。
- 建议：把「导出太大」统一成一个可识别的错误码（例如 `CHAT_EXPORT_TOO_LARGE` / `DATA_EXPORT_TOO_LARGE` 都映射 413），或让 `buildChatExport` 在入口就同时检查归档估算和单条文字上限。更彻底的做法是流式写 ZIP、边生成边计数。补两条反向测试：归档超 512 MiB、单条文字 100M～128MiB。

### 低：附件名解析没有长度上限，和 Schema 的 1024 不一致，会让整份导出失败

- 文件：`packages/persistence-sqlite/src/data-export/chats.ts:77,359-372,523`、`packages/persistence-sqlite/src/data-export/chat-schemas.ts:39-44`
- 问题：新的宽松解析对 `bytes` 做了安全整数检查、对 `kind` 做了 `{1,32}` 限制，但 `name` 仍然是无长度限制的 `[^"<>\n]*`。如果消息正文里有一个附件标签，名字超过 1024 个字符（用户自己输入/粘贴的标签也算），导出末尾的 `verifyChatExport` 会因 `ATTACHMENT_SCHEMA.name` 的 `maxLength: 1024` 抛 `DATA_IMPORT_LINE_INVALID`，导致整个网页导出 500、CLI 导出失败。
- 证据：
  - `chats.ts:77`：`const ATTACHMENT_TAG = /\n?<file name="([^"<>\n]*)" ...`
  - `chats.ts:365`：`name: safeName(name),`
  - `chat-schemas.ts:40`：`name: text(0, 1024),`
  - `chats.ts:523`：`verifyChatExport(files, options.migrationSequence);`
- 建议：比照 `bytes`/`kind` 做防御性归一化，例如超过 1024 字符的名字替换为占位符并计入 `omitted`；或统一放宽 Schema 上限。补一条「超长附件名仍能导出」的用例。

### 低：`data inspect` 的放宽作用于所有格式，且把最多 2 GiB 全量读进内存

- 文件：`apps/admin-cli/src/data-command.ts:138-141`、`packages/persistence-sqlite/src/data-export/directory.ts:38-62`
- 问题：`readPortableDirectory` 在识别格式之前就按 20 万个文件、2 GiB 读取；这对聊天导出是合理的，但同样放宽了记忆导出。`data import` 仍使用默认的 4096 个文件、512 MB，因此会出现「`data inspect` 认为可以、`data import` 拒绝」的清单/消费端不一致。
- 另外，`readPortableDirectory` 是 `new Uint8Array(await readFile(full))` 全量缓冲；2 GiB 的包会在 CLI 里占用数 GiB（UTF-8 解码成 JS 字符串后更大），有 OOM 风险。
- 证据：
  - `data-command.ts:138-141`：`readPortableDirectory(from, { maximumFiles: 200_000, maximumTotalBytes: 2 * 1024 * 1024 * 1024 })`
  - `directory.ts:62`：`files.set(relative, new Uint8Array(await readFile(full)));`
  - `data-command.ts:299`：导入路径仍为 `readPortableDirectory(from);`
  - ADR 0235 第 60 行写「对聊天导出放宽到 20 万个文件、总共 2 GiB（记忆导入仍是 4096 个、512 MB）」。
- 建议：先只读 `manifest.json` 判断格式，再按格式传不同上限；或对 inspect 改用流式读取/哈希。至少让 `data inspect` 对记忆导出继续使用 4096/512 MB，并在文档里写清内存风险。

### 低：`verifyChatExport` 遇到非法 UTF-8 的 `data/threads.jsonl` 会抛原始 `TypeError`，不是导出错误码

- 文件：`packages/persistence-sqlite/src/data-export/chats-verify.ts:17,54`、`apps/admin-cli/src/data-command.ts:146-153`
- 问题：`manifest.json` 的 `decoder.decode` 包在 `try/catch` 里，但 `data/threads.jsonl` 的解码没有包。`TextDecoder("utf-8", { fatal: true })` 对非法字节会抛原生 `TypeError`，`data inspect` 不会得到 `DATA_IMPORT_LINE_INVALID`，而是原始异常/内部错误。这属于本轮「清单损坏错误码」只修了清单、没覆盖数据文件的同一类错误路径。
- 证据：
  - `chats-verify.ts:17`：`const decoder = new TextDecoder("utf-8", { fatal: true });`
  - `chats-verify.ts:54`：`const raw = decoder.decode(data);`
- 建议：把该 decode 也包进 `try/catch`，统一抛 `LINE_INVALID`；补一条「篡改 threads.jsonl 为非法 UTF-8 并同步修正清单哈希」的反向用例。

---

## 读代码证实的与推测

**读代码证实的：**

- `buildChatExport` 返回前确实调用了 `verifyChatExport`（`chats.ts:523`）。
- 网页默认 128 MiB、命令行 256 MiB（`production-chat-export.ts:18,56`、`data-command.ts:254`）。
- 113 测试反向用例确实覆盖了：超限 413、必需文件缺失、扣留文字/对话数被篡改、`sealedOriginals` 被篡改、Markdown 路径指向非 `chats/*.md`、清单坏 JSON、>4096 文件 inspect。
- `CHAT_SEALED_FILE`、`withheld.texts/threads/messages`、`counts.sealedOriginals` 在生成端和校验端的公式一致；有/无口令两种情况下都能对上。
- `data inspect` 对聊天导出清单 JSON 损坏确实返回 `DATA_IMPORT_MANIFEST_INVALID`（`types.ts:66,83-91`）。
- 导出的 `file` 路径生成端已限定为 `chats/YYYY-MM/...md`，校验端有 `assertSafePath` + `chats/` 前缀 + `.md` 后缀检查，`writePortableDirectory` 还会再校验路径。

**推测（未运行、未实测）：**

- 归档超过 512 MiB 在 128 MiB 荷载下是否现实可触发，取决于消息里引号/控制字符导致 JSON 转义膨胀的程度；代码路径是确定的，触发概率未实测。
- 自检会在导出末尾重新解码、按行切分并 `JSON.parse` 整个 `data/threads.jsonl`，随后 `createStoredZip` 又全量缓冲 ZIP；峰值内存可能高于 ADR 0235 的约 0.8 GB 估计，但未测量。
- 作者说的 `npm run check` 和「check:chat-export 30 条通过」未核实；只能确认脚本 `REQUIRED = 30`，三个测试文件里的 `[多人7]` 用例正好 30 条。

---

## 侧重检查

- **错误路径**：检查了 413 映射、归档超限、CLI 超限、清单坏 JSON、非法 UTF-8、自检失败、`data inspect`/`data import` 上限差异。发现 413 覆盖不全和非法 UTF-8 未归一化。
- **不合规范/不可信输入**：检查了清单 Schema、重复对话/消息编号、消息顺序、路径穿越、Markdown 路径前缀/后缀、多余文件、非法 JSONL 行、构造的附件标签。除附件名长度问题外，路径和哈希校验完整。
- **安全**：导出只读数据库；HTTP 有登录、同源、并发锁；机密只在有口令时进入封存层，附件名会替换为占位符；响应不包含明文机密（有测试覆盖）；`content-disposition` 文件名来自固定格式。未发现新增泄密路径。
- **资源耗尽**：128 MiB 荷载检查在解密之前（代码路径确认）；但 `data inspect` 的 2 GiB 全量内存读取、归档缓冲、自检二次解析是剩余风险。
- **不可撤销操作**：本次只读导出，没有导入、删除或覆盖；`writePortableDirectory` 要求空目录且 `wx` 创建。未发现不可撤销操作。
- **规则/文档/代码一致**：ADR 0235 的 128/256 MiB、必需文件、迁移序号「只拒绝更新」、自检、扣留计数均与代码一致；不一致处是「413 覆盖所有超限」和「inspect 只对聊天导出放宽」这两处表述/实现细节。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。PR 400 的 `aa481374` 只改聊天导出的读库、序列化、校验、HTTP/CLI 和前端提示；`buildChatExport` 只有 `SELECT`（`chats.ts:112-137`），不写 `threads`/`thread_messages`，也不进入提示词组装。新增的附件标签正则和 `context-projection-service.ts:30` 的模型侧正则一致，但没有修改模型侧代码。发给模型的内容仍然是只追加，每轮变化的值仍只在最后一条消息；本改动没有往系统提示/工具定义/历史里加任何东西。注意：`efd..fea` 里还有来自 `main` 的其他 PR 改动，不属于 PR 400，本次未把它们当作本改动的一部分。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   对模型请求没有影响。对导出本身：同一数据库的导出是确定性的——对话显式 `ORDER BY created_at, id`，消息显式 `ORDER BY thread_id, sequence`，`canonicalJson` 对键排序，`manifest.files` 排序；遮盖只取决于被遮盖文字本身，附件占位编号按确定的遍历顺序生成。唯一每次不同的是 `manifest.exportedAt` 和 ZIP 时间戳（`now()`），这是导出元数据，不是模型可见内容。已有「export is deterministic for the same data」用例覆盖文件键和 SHA-256（`chat-export.test.ts:320-328`）。

3. **有没有对应的自动检查，反向用例会不会真的失败？**
   有：`check:chat-export`（`package.json` 第 27、53 行）要求至少 30 条 `[多人7]` 测试通过，实际静态计数正好 30 条。反向用例覆盖：网页 413 且空响应、`maximumBytes` 超限抛 `CHAT_EXPORT_TOO_LARGE`、缺必需文件、篡改扣留计数/`sealedOriginals`、Markdown 路径指向数据文件、清单坏 JSON 报 `DATA_IMPORT_MANIFEST_INVALID`、>4096 文件 inspect。缺口：CLI 256 MiB 上限没有用例；归档 512 MiB 上限没有用例；非法 UTF-8 的 `threads.jsonl` 没有用例；413 用例的名字说「什么都不解密」，但使用的是真实 protector，没有 spy，因此只证明了抛错，没有证明 `unprotect` 未被调用；超长附件名没有反向用例。作者「30 条通过」和 `npm run check` 的整体结果无法运行验证，标为未核实。

4. **每个新值/改动值的生成端和消费端都接受吗？**
   - `CHAT_EXPORT_TOO_LARGE`：生成端 `chats.ts:149`，消费端 HTTP 413（`production-chat-export.ts:76`）和前端字面量（`data-export.ts:43`、`memory-page.tsx:2147`）一致；但 ZIP 生成的 `DATA_EXPORT_TOO_LARGE` 没有被聊天路由接受，见发现 1。
   - `maximumBytes`：HTTP 128 MiB、CLI 256 MiB 传入，`readChatSnapshot` 只做 `total > maximumBytes`，两端一致；但 Schema 单条文字 100M 字符上限没有和 128 MiB 荷载对齐，见发现 1。
   - `ReadLimits`：`data-command.ts:138` 生成，`directory.ts:42-43` 消费；数值本身可用，但作用于所有格式，见发现 3。
   - `CHAT_SEALED_FILE`：生成端 `chats.ts`、校验端 `chats-verify.ts`、inspect 端 `data-command.ts:162` 都用同一常量 `sealed/sealed.enc`，一致。
   - `withheld.texts/threads/messages`：生成端用集合大小，校验端从行内 `withheld` 标记重算，CLI 用 `withheld.texts` 决定是否拒绝无口令导出；标题/消息两类一致。附件名机密按 ADR 不进入 `withheld.texts`，是有意设计。
   - `counts.sealedOriginals`：生成端是有口令时 `Object.keys(originals).length`，校验端要求有封存文件时等于 `withheldTexts`；无口令/无机密/仅有附件名机密三种情况都核对过，一致。
   - `file` 路径：生成端 `chats/YYYY-MM/<date>-<slug>-<hash>.md`；校验端 Schema 长度 256 + `assertSafePath` + `chats/` 前缀 + `.md` 后缀；写入端再次 `assertSafePath`，两端一致。
   - 附件 `bytes`/`kind`：生成端已归一化，Schema 接受；`name` 没有归一化，见发现 2。
   - `migrationSequence`：聊天校验只拒绝比当前新的，记忆导出要求完全相等；与 ADR 0235 第 57 行一致。
   - `manifest.files[].lines`：生成端只给 `data/threads.jsonl` 填真实行数，其余 0；校验端只核对数据文件行数，与 ADR 修改后的表述一致。

**总体建议**：合并前优先修「413/超限错误码不统一」这一条（成本低、直接关系到本轮新增的 413 承诺）；附件名长度和 `data inspect` 内存问题可以随后处理。
