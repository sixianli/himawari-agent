未发现阻断级/高危问题。以下按严重度排列；先列读代码能证实的问题，再列推测/未核实项。

## 读代码证实的问题

### 1【中】附件标签清理过严，非规范标签会把内部 `ref` 留在导出正文里

- 文件：`packages/persistence-sqlite/src/data-export/chats.ts:73`、`chats.ts:340`
- 问题：导出只识别带 `bytes` 和 `kind` 的固定格式标签：
  ```ts
  /\n?<file name="([^"<>\n]*)" ref="[^"<>\s]+" bytes="(\d+)" kind="([a-z]+)"( truncated="1")?\/>/g
  ```
  同一仓库里读取附件引用的正则允许任意可选属性：`packages/application/src/services/context-projection-service.ts:30`。如果历史消息里的标签是 `<file name="x" ref="..."/>` 或 `<file ... bytes="9"/>` 这类形式（测试夹具里就有：`test/integration/context-projection.test.ts:348`），导出不会把它变成附件清单，而是整段留在正文里，附件的内部 `ref` 也随之导出。这违反“附件只导出清单、去掉内部引用”。
- 建议：抽一个共享的附件标签解析器，兼容可选属性、属性顺序和旧标签；凡是 `<file ... ref=...>` 都应从正文移除。解析失败的标签至少要删除并计数，不能原样保留。补一条“缺失 kind / 额外属性”的反向测试。

### 2【中】`data inspect` 在识别格式前无条件 `JSON.parse`，非法清单变成裸异常

- 文件：`apps/admin-cli/src/data-command.ts:118`
- 问题：新增代码先解析清单再判断格式：
  ```ts
  const manifestBytes = files.get("manifest.json");
  const declaredFormat = manifestBytes
    ? (JSON.parse(new TextDecoder().decode(manifestBytes)) as { format?: unknown }).format
    : undefined;
  ```
  原来 `verifyIntegrity` 会捕获非法 JSON，返回 `DATA_IMPORT_MANIFEST_INVALID`。现在任何格式的非法清单都会在进入校验前抛出裸 `SyntaxError`；清单是 `null` 时还会抛 `TypeError`。这会影响现有记忆导出的 `data inspect`，与“不改记忆导出的代码”的说法不符。
- 建议：把这段包进 `try/catch` 并转成 `DataExportError(MANIFEST_INVALID)`，或直接复用已有的 `readManifest`。补一条“清单不是有效 JSON / 是 null”的反向测试。

### 3【中】`verifyChatExport` 没有完全做到“清单和实际文件一致”

- 文件：`packages/persistence-sqlite/src/data-export/chats-verify.ts:33`、`:74`、`:89`
- 问题：
  - 迁移序号只拒绝“比当前大”，接受更旧的值：
    ```ts
    if (manifest.migrationSequence > migrationSequence)
      throw failure("MIGRATION_MISMATCH", String(manifest.migrationSequence));
    ```
    记忆导出是要求完全相等（`verify.ts:211`）。
  - 只要求每个对话的 `file` 存在于文件集合里，不要求它是 Markdown，也不排除它指向 `data/threads.jsonl`、`manifest.json` 或 `sealed/sealed.enc`。
  - 没有校验 `CHATS.md` 和 `schema/threads.schema.json` 必须存在；只要清单里也不列它们，整份仍可通过。
  - 只校验了 `threads`、`markdownThreads`、`messages`、`attachments`、`withheld.messages`，没有校验 `withheld.texts`、`withheld.threads`、`sealedOriginals`。
- 建议：明确规定必需文件集合和角色；`thread.file` 必须是 Markdown 且不能与保留文件重名；迁移序号改为精确相等；把 `withheld.texts/threads`、`sealedOriginals` 也纳入一致性检查，或明确写入“无法校验”的说明。补“两个文件同时从清单和目录删掉仍应拒绝”的测试。

### 4【中低】大库会先在内存里物化全部内容，512 MB 上限来得太晚

- 文件：`packages/persistence-sqlite/src/data-export/chats.ts:268`、`:389`；`apps/agent-service/src/production-data-export.ts:87`
- 问题：`buildChatExport` 先把所有消息解密进内存，再同时生成 JSONL、Markdown 和 ZIP；`MAXIMUM_ARCHIVE_BYTES` 的检查在 `createStoredZip` 内，是全部内容已经生成之后才执行：
  ```ts
  if (offset > MAXIMUM_ARCHIVE_BYTES) throw new RangeError("DATA_EXPORT_TOO_LARGE");
  ```
  因此超大库可能在触发 500 之前就 OOM。网页聊天导出和记忆导出又各有独立锁，可以同时跑。另 `verifyChatExport` 没有逐行字节上限，且 `schema.ts:32` 用 `[...value].length` 统计最长可达 1 亿字符的文本，验证大文件本身也会吃内存。
- 建议：先做大小估算或按对话流式生成；没有口令时不要保留 `originals` 的明文；给验证器加逐行上限，降低单条文本上限或改用不展开字符串的长度统计。作者已在 ADR 里承认 400 MB 内存，但“超过 512 MB 返回 500”在实现上并不保证。

### 5【低】检查门槛只覆盖 21 条集成测试，UI 测试不在门槛里

- 文件：`scripts/check-chat-export.mjs:9`、`:14`；`apps/control-center/test/memory-interactions.unit.test.ts:1561`
- 问题：门槛只运行三个 integration 文件并要求 21 条通过，但 UI 的 `[多人7]` 测试在 control-center 单测里，没有被这个脚本执行。现有反向用例覆盖了鉴权、跨站、并发、空库、删除/受限、机密、哈希、文件清单、计数、顺序，但没有覆盖上面第 3 条的缺口，也没有 `--allow-unsealed`、归档对话、非法清单等用例。
- 建议：把 UI 测试加入门槛或去掉 `[多人7]` 标签，明确由哪一步运行；为验证器的缺口补反向用例。

### 6【低】清单/输出契约有几处说法与代码不一致

- 文件：`packages/persistence-sqlite/src/data-export/chats.ts:408`、`:435`；`apps/admin-cli/src/data-command.ts:132`、`:124`
- 问题：
  - ADR 说清单记录“每个文件的……行数”，但 schema、Markdown、封存文件都写 `lines: 0`，只有 `data/threads.jsonl` 是真实行数。
  - `data inspect` 对聊天导出直接硬编码 `"sealed/sealed.enc"`，没有复用 `CHAT_SEALED_FILE`。
  - 聊天导出的 `data.inspect` 输出仍是 `outputSchemaVersion: 1`、`command: "data.inspect"`，但 `counts` 和 `withheld` 的形状与记忆导出不同。按 I-73 的教训，任何依赖 `withheld.memories` 的消费者拿到聊天导出会得到 `undefined`。
- 建议：计算或明确约定 `lines` 的含义；用常量替代硬编码路径；给 inspect 输出加格式判别字段或提升 schema 版本，避免同一版本号承载两种形状。

## 推测/未核实

### 7【低，推测】HTTP 路径把 `created_at` 直接拼进 ZIP 路径，未在打包前做路径校验

- 文件：`chats.ts:368`
  ```ts
  const base = `chats/${created.slice(0, 7)}/${created.slice(0, 10)}-...`;
  ```
  正常数据不会出问题，CLI 写入前还有 `writePortableDirectory` 的 `assertSafePath`；但 HTTP 路由用 `createStoredZip` 直接打包，没有校验。如果数据库里的 `created_at` 被写成含 `/` 或 `..` 的值，ZIP 中可能出现越界条目。当前应用时钟写入的值是受控的，生产库是否可能出现异常值未核实。
- 建议：在生成 `file` 前校验或清洗 `created_at`，并在 HTTP 打包前调用一次生成的 `verifyChatExport` 或至少 `assertSafePath`。

### 8【低，推测】Markdown 正文没有转义，打开导出文件时可能触发外部请求或提示注入

- 文件：`chats.ts:231`、`:238`
- 问题：正文只是逐行加 `> `，标题只是 `foldText`，没有转义 Markdown 链接、图片或 HTML。消息里如果有 `![x](https://...)`，用 Markdown 渲染器打开时仍可能发起外部请求；把导出文件喂给模型时也可能被当作指令。文件里虽然写了“不是指令”，但那只是说明，不是技术隔离。实际风险取决于用户如何打开文件。
- 建议：对正文和标题做 Markdown 转义，或用围栏代码块输出原文；至少不要渲染远程图片/链接。

## 侧重检查

- **鉴权/跨站**：`apps/agent-service/src/production-chat-export.ts:31-45` 与现有 `/archive` 路由一致：未登录 401，跨站 403，并发 429，失败后重置标志。`Sec-Fetch-Site` 缺失时放行，这是沿用现有行为。
- **不可信输入**：检查了附件标签、Markdown 标题/正文、清单路径、线程文件路径、ZIP 路径、JSONL 行和超长文本。问题集中在第 1、3、4、7、8 条。
- **错误路径**：损坏载荷会使整次导出失败并返回 500，不会输出半份文件；清单非法时 `data inspect` 有第 2 条回归；命令行在写目录前拒绝未封存的机密，未见部分写出。
- **不可撤销操作**：实现只读数据库、只写导出目录；输出目录要求为空，文件权限 0600/目录 0700；没有导入和迁移，未发现破坏性写入。
- **资源耗尽**：见第 4 条。
- **规则/文档一致性**：本改动没有碰 `.claude/rules/prompt-prefix.md` 约束的提示词、工具定义和历史组装代码；文档与代码的偏差见第 5、6 条。

## 作者说法核对

- “21 条 `[多人7]` 测试通过”：集成测试里正好 21 条；UI 还有 1 条 `[多人7]`，但不在 `check:chat-export` 的 `FILES` 里。实际是否全部通过未运行，未核实。
- “不改记忆导出的代码”：不完全成立。改了 `production-data-export.ts` 的共享 ZIP 函数、`data-command.ts` 的 inspect 分支、`data-export/index.ts`；其中 inspect 分支带来了第 2 条的回归。
- “附件只导出清单、去掉内部引用”：对规范标签成立；对第 1 条提到的非规范/旧标签不成立。
- “清单记录每个文件的行数”：`data/threads.jsonl` 正确，其他文件为 0，与字面说法不一致。
- “真实浏览器下载校验、大库实测、`npm run check` 结果”：未核实，无法在当前环境运行。
- “不应和 PR 393 冲突”：无法核实 PR 393 内容；本改动确实碰了记忆导出共用的文件和 `package.json` 的检查清单，存在冲突面。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。diff 只改了导出、CLI、网页按钮/文案和注册路由，没有改系统提示、工具定义、历史消息、遮盖或 `prompt-catalog`。因此发给模型的内容没有新增内容，仍然不存在“头部变化”；每轮会变的 `exportedAt` 只进导出清单，不进模型请求。规则依据 `.claude/rules/prompt-prefix.md:27-28`、`:33-36`。

2. **同一段文字会不会在不同请求里变成不同字节？**
   模型请求：不会。导出包：会。`manifest.exportedAt`（`chats.ts:441`）、ZIP 时间戳/文件名（`production-data-export.ts:49`、`:57`）和封存文件的随机 salt/nonce（`seal.ts:43-44`）都会让每次导出的字节不同。正文、JSONL 和 Markdown 在“数据库相同、时钟固定”时是确定的；测试 `chat-export.test.ts:255` 用了固定 `NOW`，所以它证明的不是跨时间可复现。

3. **有没有自动检查，反向用例真的会失败吗？**
   有 `npm run check:chat-export`，运行 21 条集成测试并检查失败数和通过数。已覆盖鉴权、跨站、并发、空库、删除/受限、机密、哈希、文件清单、计数、重复/乱序等反向场景；这些用例在移除对应逻辑时通常会失败。未运行，无法证实实际结果。缺口是：UI 测试不在门槛、第 3 条的验证缺口没有反向用例、确定性测试只在固定时钟下成立。

4. **每个产生/修改的值，所有使用它的地方都能接受吗？**
   大部分一致：`format` 在生成、`verifyChatExport`、`inspect` 和 ADR 里一致；`role`、`status`、`classification`、`answerLocale` 与 `0001_initial_product_schema.sql:95-97`、`0015_thread_lifecycle_and_search.sql:5-15` 的 CHECK 约束一致；网页和清单都使用 `counts.threads/messages` 及 `withheld.messages`。
   不一致的地方是：`CHATS.md`/schema 不是 `verifyChatExport` 的必需文件；`thread.file` 没有限定为 Markdown；`withheld.texts/threads`、`sealedOriginals` 和 `omitted` 条数没有与数据交叉校验；`lines` 对非数据文件固定为 0；`data.inspect` 同一输出 schema 版本下有两种 `withheld`/`counts` 形状；`data-command.ts:132` 硬编码封存路径。按 I-73 的教训，这些正是“生成端的值没有被所有消费端的校验覆盖”的地方。
