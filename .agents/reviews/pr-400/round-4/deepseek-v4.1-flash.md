## 复核发现（按严重度）

### 1. 中 — 16 MiB 清单上限与“20 万个文件”的放宽互相矛盾，自己导出的合法大包无法被 inspect

- 文件：`apps/admin-cli/src/data-command.ts:141`、`apps/admin-cli/src/data-command.ts:155`、`packages/persistence-sqlite/src/data-export/chats.ts:434`、`packages/persistence-sqlite/src/data-export/chats.ts:463`、`docs/adr/0235-chat-history-export.md:60`
- 问题：`data inspect` 在读取目录前要求 `manifest.json` ≤ 16 MiB，否则报 `DATA_IMPORT_PATH_UNSAFE`；但聊天导出每个对话都会生成一个 Markdown 文件，并在 `manifest.files` 里对应一条记录。200,000 个文件对应的清单，即使按每条最小约 130 字节计算也超过 26 MB，必然大于 16 MiB。也就是说，ADR 承诺的“聊天导出放宽到 20 万个文件”在 inspect 这一侧实际不可达：`data export-chats` 能写出这样的包，`data inspect` 却会以“清单太大”拒绝。
- 证据（亲自读到）：
  - `data-command.ts:142-146`：`if (manifestStat && (!manifestStat.isFile() || manifestStat.size > 16 * 1024 * 1024)) throw new DataExportError(DATA_EXPORT_ERROR_CODES.PATH_UNSAFE, "manifest.json 不是普通文件或太大")`
  - `data-command.ts:155-159`：聊天格式放宽为 `{ maximumFiles: 200_000, maximumTotalBytes: 2 * 1024 * 1024 * 1024 }`
  - `chats.ts:434`：`for (const thread of threadLines) put(thread.file, "markdown", renderThread(thread), 0);`
  - `chats.ts:468-474`：`files: [...files.keys()].sort().map((path) => ({ path, role, bytes, lines, sha256 }))`
  - ADR 0235 第 60 行同时写了“不超过 16 MiB 的普通文件”和“放宽到 20 万个文件、总共 2 GiB”。
- 建议：让两个门槛自洽。可选：(a) 把清单上限按“文件条数 × 单条上界”推导或单独提高，并允许流式解析大清单；(b) 把文档中的 20 万改成 16 MiB 清单实际能支持的条数；(c) 至少增加一条“导出后 manifest >16 MiB 仍能 inspect”的用例，或明确写出超过该值会被拒绝。
- 标注：读代码证实（结构上每个 Markdown 必占一条清单记录；阈值冲突按最小条目长度算术即可确认）。

### 2. 低 — 压缩包上限没有把中央目录算进去，最终 zip 可以超过上限却仍返回 200

- 文件：`apps/agent-service/src/production-data-export.ts:88`、`apps/agent-service/src/production-data-export.ts:91`、`apps/agent-service/src/production-data-export.ts:98`；相关声明 `docs/adr/0235-chat-history-export.md:59`
- 问题：上限判断用的是本地文件头加内容的累计 `offset`，之后才计算 `directoryBytes` 并追加中央目录和 EOCD。因此最终 `archive.byteLength = offset + directoryBytes + 22`，可以超过 `maximumBytes`，但路由仍返回 200。ADR 写的是“打包后超过 512 MiB 同样返回 413”，这与实现不完全一致；文件越多，偏差越大（聊天导出最多 20 万文件，中央目录可达十几 MB）。
- 证据（亲自读到）：
  - `production-data-export.ts:88-89`：`offset += 30 + nameBytes.byteLength + content.byteLength; if (offset > maximumBytes) throw new RangeError(DATA_EXPORT_TOO_LARGE);`
  - `production-data-export.ts:91`：`const directoryBytes = directory.reduce((sum, part) => sum + part.byteLength, 0);`
  - `production-data-export.ts:98-99`：`const parts = [...chunks, ...directory, new Uint8Array(end.buffer)]; const archive = new Uint8Array(parts.reduce(...));`
- 建议：在循环中同步累计中央目录字节，判断 `offset + directoryBytes + 22 > maximumBytes`；或在组装前先算好总长度再分配。新增的 413 用例目前只覆盖“很早就超限”，没有覆盖“内容刚好在上限内、被中央目录顶超”的情况。
- 标注：读代码证实。

### 3. 低 — 清单预读是 `lstat` 后再 `readFile`，仍有 TOCTOU；且所有 `lstat` 错误被静默吞掉

- 文件：`apps/admin-cli/src/data-command.ts:141`、`apps/admin-cli/src/data-command.ts:147`
- 问题：这次修复的意图是“读之前先拒绝符号链接/设备/超大文件”。但 `lstat` 与 `readFile` 之间路径可被替换：检查时是普通小文件，真正读取时被换成符号链接（例如 `/dev/zero`）或 FIFO，仍会重新引入挂起/无界读取。另 `lstat(...).catch(() => undefined)` 把所有错误（EACCES、ELOOP 等）都当成“文件不存在”，随后在 `readPortableDirectory` 里变成另一条错误路径，和“清单不是有效的 JSON”的承诺不一致。ADR 明确说 inspect 只用于可信目录、不是安全边界，所以影响有限。
- 证据（亲自读到）：
  - `data-command.ts:141`：`const manifestStat = await lstat(manifestPath).catch(() => undefined);`
  - `data-command.ts:147`：`const peeked = manifestStat ? await readFile(manifestPath, "utf8") : "";`
- 建议：用 `open(path, O_RDONLY | O_NOFOLLOW)` 后对文件描述符 `fstat`，在同一个 fd 上限制大小并读取；`lstat` 只对 `ENOENT` 返回 undefined，其他错误转成稳定的 `PATH_UNSAFE`/`MANIFEST_INVALID`。
- 标注：机制读代码证实；是否能被利用取决于本地写权限，属条件性风险。

---

## 读代码证实的 vs 推测

- 读代码证实：上述三条的机制与代码路径；`REQUIRED=34` 与实际 34 条 `[多人7]` 测试一致；`DATA_EXPORT_TOO_LARGE`、`maximumArchiveBytes`、`PATH_UNSAFE` 的产生和使用两端一致（见必答 4）。
- 推测/条件性：第 3 条的 TOCTOU 需要攻击者能在 inspect 前写入该目录；第 1 条具体在多少对话数触发取决于条目实际长度（但 200,000 条无论如何超过 16 MiB）。
- 未核实：`.agents/reviews/pr-400/round-3-judgments.md` 等工作区是 sparse checkout，读不到第 3 轮原始意见；因此只能按代码核对“意见已改”的结果。

## 侧重检查

- 错误路径：不存在清单 → 走原 `MANIFEST_INVALID`；非法 JSON → `MANIFEST_INVALID`；符号链接/非普通文件/超大 → `PATH_UNSAFE`；`DataExportError` 通过 `stableErrorCode` 的 `.code` 输出，测试断言成立。`lstat` 的其它错误被吞掉是缺口（发现 3）。
- 不合规范/不可信输入：清单格式在 `verifyChatExport` 里做 schema、路径、哈希、数量校验；但“声明为聊天导出”只来自未校验的 `format` 字段，用来放宽到 2 GiB 内存读取。ADR 已写明这不是安全边界，我接受该取舍，但资源上限（全量读入内存）仍值得留意。
- 安全：聊天导出路由有登录主人校验、同源校验、并发 429、只读数据库；日志只记错误码，不记内容；新增代码没有引入外部输入进入命令或路径拼接。
- 资源耗尽：16 MiB 清单上限和 2 GiB 目录上限是本轮加的；但 2 GiB 是全量读入 `Map` 后校验，仍有 OOM 面；压缩上限少算中央目录（发现 2）。
- 不可撤销操作：本次增量只读/导出，`writePortableDirectory` 要求空目录并用 `wx` 创建，没有删除或覆盖；`export-chats` 仍需停服务、口令或 `--allow-unsealed`。
- 规则/文档一致性：ADR 的 34 条门槛与脚本一致；16 MiB 与 20 万文件不一致（发现 1）；“打包后 512 MiB”与实现少算中央目录不一致（发现 2）。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。本次增量只改 `data inspect`、`createStoredZip`、聊天导出路由、ADR 和测试；聊天导出只读数据库并写文件/下载，不组装模型请求。`now` 仅用于导出时间、zip 时间戳和诊断，不进入系统提示、工具定义或历史。因此“发给模型的内容只在末尾追加、每轮变化值只在最后一条消息”这一约束未被触碰。合并进来的 main 中提示相关提交不属于本 PR 自己的修复提交，未逐条核对。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求没有影响。对导出产物：同一数据库、同一 `now` 下，顺序（对话按 `created_at,id`、消息按 `thread_id,sequence`、清单按路径排序）和 JSON 规范化是确定的；遮罩只依赖当前文本，附件名编号依赖确定的遍历顺序，不依赖后文。不同次导出会因 `exportedAt`/zip 时间戳不同而整包字节不同，这是快照时间字段，不是模型可见内容，也不影响 KV 缓存。未见新增的“依赖前后文的遮盖”。

3. **有没有对应自动检查，反向用例真的会失败吗？**
   有，但只覆盖一部分。新增两条 `[多人7]`：`chat-export-http.test.ts:165` 的 zip 超限 413 用例、`data-cli.test.ts:447` 的符号链接清单用例；门槛从 32 提到 34，实际恰好 34 条。撤掉修复时：zip 用例会因忽略上限返回 200 而失败；符号链接用例会先读到 `/dev/zero` 而挂起/超时失败，确为有效反向用例。但 16 MiB 分支没有专门的超限用例，也没有“合法大清单仍可 inspect”的用例；中央目录顶超上限的情况也没有测试（发现 1、2）。

4. **每个新值/改动值的产生端和使用端是否都能接受？**
   - `maximumArchiveBytes`：仅测试构造传入，路由传给 `createStoredZip`；生产组装不传，走默认 512 MiB；类型和默认值一致，无越界使用。
   - `DATA_EXPORT_TOO_LARGE`：在 `production-data-export.ts:89` 产生，`production-chat-export.ts:80` 精确比较并映射 413；字符串一致，无冲突。
   - `PATH_UNSAFE`：在 `data-command.ts:143` 产生，`stableErrorCode` 读取 `DataExportError.code` 输出，测试断言 `DATA_IMPORT_PATH_UNSAFE`，两端一致。
   - `CHAT_FORMAT_VERSION`：导出写入 `manifest.format`，schema 用 `const` 校验，inspect 用它决定分支，三处一致。
   - `REQUIRED=34`：与三个测试文件中实际 34 条 `[多人7]` 一致。
   - **不一致项**：16 MiB 清单上限与 200,000 文件/2 GiB 的放宽不能同时成立（发现 1）；512 MiB 压缩上限未计入中央目录（发现 2）。

作者的说法逐条核对：`lstat` 预读、16 MiB/非普通文件报 `DATA_IMPORT_PATH_UNSAFE`、`DATA_EXPORT_TOO_LARGE` 提成常量、路由与 `createStoredZip` 可传上限、新增 413 用例、ADR 更新、门槛 34 条，均与代码一致；唯一未提及的是 16 MiB 与 20 万文件的上限冲突。
