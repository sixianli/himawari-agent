# PR 400 复核结论（聊天记录导出，efd1796e）

## 读代码证实的问题（按严重度排列）

**1.（中）导出端不做自检，校验端有生成端可以超出的上限——同一份包，产品自己写得出来、`data inspect` 却会拒绝**
- 文件：`packages/persistence-sqlite/src/data-export/directory.ts:6-8,47-51`、`chats.ts:369-372`、`apps/agent-service/src/production-chat-export.ts:54`
- 证据：`readPortableDirectory`（inspect 的入口，`data-command.ts:117`）硬性限制 `MAXIMUM_FILES = 4096`、`MAXIMUM_TOTAL_BYTES = 512MB`（directory.ts:47 `files.size >= MAXIMUM_FILES` 即抛 `PATH_UNSAFE`）。而 `buildChatExport` 每个对话写一个 Markdown（chats.ts:369-372），对对话数量和总字节数没有任何上限；web 路径只在 zip 阶段有 512MB 上限（production-data-export.ts:19,87），CLI 目录导出连总大小上限都没有。
- 后果：对话超过约 4090 个，或正文总量超过 512MB 的库，导出成功、事后 `himawari-admin data inspect --from` 报 `PATH_UNSAFE` 拒绝——这正是 I-73 那类“产生端没问校验端接不接受”的问题。
- 建议：`buildChatExport` 在生成时对超过阈值的情形给出明确 `omitted`/错误，或放宽 inspect 对自有格式的文件数上限（现在一个对话一个文件，4096 很容易到）。

**2.（中）生成的导出从不跑 `verifyChatExport` 自检，schema 与数据库现实可能静默漂移**
- 文件：`chats.ts`（全文件无 verify 调用，grep 确认只有 `chats-verify.ts`、CLI、测试引用它）、`chat-schemas.ts:63`（`title: text(0,4096)`）
- 证据：标题长度没有数据库 CHECK 兜底（0015 迁移里 `title_ref` 只是指针，荷载长度不限），标题荷载超过 4096 字符时导出能写出，事后 inspect 才报 `LINE_INVALID`。`answer_locale`/`title_source`/`classification`/`message_status` 有 DB CHECK（0001:81,95,97、0015:5,14-15），和 schema 枚举一致（已逐个核对）；唯一没有 DB 兜底的就是标题长度。
- 建议：CLI/web 导出完成后对 `result.files` 跑一次 `verifyChatExport`（自产自收），或在写 `threads.jsonl` 前校验边界。

**3.（低）`data inspect` 的聊天分支用裸 `JSON.parse` 解析清单，坏 JSON 时错误码走通用映射**
- 文件：`apps/admin-cli/src/data-command.ts:118-121`
- 证据：`JSON.parse(new TextDecoder().decode(manifestBytes))` 没有 try/catch；而记忆路径的 `readManifest`（verify.ts:184-189）是 `try { JSON.parse } catch → MANIFEST_INVALID`。清单损坏时 inspect 报的是 `stableErrorCode(SyntaxError)` 的通用码，不是 `DATA_IMPORT_MANIFEST_INVALID`。行为上仍是非零退出（index.ts:806-809 有全局 catch），只是错误码口径不一致。
- 建议：复用 `readManifest` 式的 try/catch，或直接调 `verifyChatExport` 前包一层。

**4.（低）`verifyChatExport` 不核验 `withheld.texts` 和 `withheld.threads`，且 migrationSequence 口径与记忆导出相反**
- 文件：`chats-verify.ts:33`、`chats-verify.ts:89-97`、`verify.ts:211`
- 证据：核对清单里只比对 `declared.messages/threads/attachments/markdownThreads` 和 `withheld.messages`（89-97 行），`withheld.texts`（=封存原件数）、`withheld.threads` 与数据文件无关、重算哈希后可任意改。另外 chats-verify.ts:33 用 `manifest.migrationSequence > migrationSequence` 允许旧导出，而记忆导出 `verifyIntegrity`（verify.ts:211）要求 `!==` 即拒。两套并行格式的严格度不一致。
- 建议：在 threads.jsonl 里每行带 `withheld` 数即可核验 texts/threads；migration 口径二选一写进 ADR。

**5.（低）前端 `requestChatExport` 把缺失的响应头当成 0**
- 文件：`apps/control-center/src/data-export.ts:40-44`
- 证据：`Number(response.headers.get(name))`——header 不存在时 `Number(null) === 0`，`Number.isSafeInteger(0) && 0 >= 0` 为真，返回 0。若未来服务端漏发头，页面会显示“导出 0 个对话”而包照常下载。当前服务端恒发这三个头（production-chat-export.ts:64-66），所以现在不触发。
- 建议：`headers.get(name)` 为 null 时走失败分支而非 0。

**6.（低）`data-command.ts:132` 用字面量 `"sealed/sealed.enc"` 而不是导出的 `CHAT_SEALED_FILE` 常量**
- 证据：值目前一致（chat-schemas.ts:8），属重复定义，常量一改就会静默漂移。

## 未核实（无法在仓库内核实）

- `/mnt/project-files/multi-user-plan/integrated-plan.md` 第 139 行、Andy 在决定卡的选择、Claude 支持页内容（外部资料）。
- 性能数字（2.4 秒 / 129 MB / 400 MB）、「npm run check 除 gitleaks 和 security-review 外全过」、「真实浏览器里下载校验通过」——均为作者手工陈述，仓库内无对应产物；不过 21 条 `[多人7]` 用例我在三个测试文件里逐一数过：15（chat-export.test.ts）+ 4（chat-export-http.test.ts）+ 2（data-cli.test.ts）= 21，与 ADR 门槛 `REQUIRED = 21`（scripts/check-chat-export.mjs:14）一致。
- PR 393 本身的内容（本仓库基准里没有），但本改动对记忆导出代码的侵入仅是 `createStoredZip` 加了一个带默认值的参数（production-data-export.ts:44-48），默认行为不变，不构成冲突。

## 侧重检查（走过的流程与结论）

正常使用流程：主人打开记忆页 → 点「导出聊天记录」→ `ChatExportPanel`（memory-page.tsx）→ `requestChatExport()`（data-export.ts）→ `GET /api/data-export/v1/chats` → `production-chat-export.ts` 路由（Sec-Fetch-Site 检查 → 认证 → 单例标志 → 只读连接 → `buildChatExport` → `createStoredZip` → 三个响应头）→ 浏览器下载 → 事后 `data inspect`。

- 已覆盖：UI 交互（memory-interactions.unit.test.ts 新用例，含 401 失败路径）；路由行为（chat-export-http.test.ts：正例头与清单对齐、空库、401/403/429、失败重置标志）；导出/校验语义（chat-export.test.ts 15 条含 5 条篡改反例）；CLI（data-cli.test.ts：有密文须口令、inspect 识别新格式、空库反例）。
- **未覆盖的代码路径**：① `production-http-composition.ts:1175-1184` 的真实装配——进程级组合测试只打 `/api/data-export/v1/archive`（production-http-composition-process.test.ts:948），聊天路由的 HTTP 测试是自建 Fastify + stub 认证器，真实 `authenticateHttpRequest`、真实 protector、真实 cookie 对这条路由没有任何自动化覆盖；② `createStoredZip` 超过 512MB → 500 的分支（DATA_EXPORT_TOO_LARGE）无测试；③ 真实浏览器下载（作者称手工验证）。
- 文档与代码一致性：ADR 0235 的决定 1-9 逐条对照代码全部相符（包括“已归档”是 open 状态 + `archived_at`、archived 不是独立 status；清单字段、文件布局、扣留规则、`--out` 空目录、停服锁 `lockStoppedTarget`、`--allow-unsealed` 均在代码中找到对应实现）。`.claude/rules/prompt-prefix.md` 所关心的请求组装代码本 diff 完全未触及。

## 必答问题逐条回答

1. **不会改变模型见过的请求开头。** diff 里没有任何触碰提示组装、工具定义、历史写入或出口遮盖管线的文件；全部改动是新增导出路径（HTTP 路由、CLI 子命令、UI 面板、导出包生成/校验），且 `buildChatExport` 只读数据库、不写记忆（满足 ADR 0193 约束）。导出用的遮盖（`createDataExportTextPolicy` → `redactForExternalText`）只作用于导出文件，与发给模型的出口遮盖是两条管线。读代码证实。
2. **不会让同一段文字在不同请求里变成不同字节**——模型请求根本不经过此改动。导出件本身的确定性：键序由 `canonicalJson` 排序（canonical.ts:11-27）、行序由 `ORDER BY created_at, id` / `thread_id, sequence` 决定（chats.ts:109,128，且 id 唯一保证全序）、`[已扣留:N]` 编号和文件名冲突后缀按确定性遍历顺序分配，并有固定 `now` 的逐字节确定性测试（chat-export.test.ts:255-263）。每次请求的 `manifest.exportedAt` 不同——那是每份新文档的创建时间，属于合理变化，不违反“只追加”规则。
3. **有对应自动检查，反向用例会失败。** `check:chat-export` 已加入 `check:steps`（package.json），脚本按 `[多人7]` 标签跑三个测试文件并要求 ≥21 条通过；反例（改字节→FILE_HASH_MISMATCH、缺/多文件→FILE_LISTING_MISMATCH、清单数不符→FILE_COUNT_MISMATCH、重复/乱序→REFERENCE_BROKEN、他人数据不导出、机密不落明文层）在测试里真实存在。未实际运行，属“读代码证实 + 未运行”。
4. **逐个产生端/使用端核对过，基本都能接上**（format 常量、六个文件名、三个 HTTP 响应头与前端读取、CLI 动作名与分发、错误码、zip 根名 himawari-chats，两端一致，测试两头都断言了）。发现的不接洽处就是上面第 1、4 条：`readPortableDirectory` 的 4096 文件 / 512MB 上限对得上记忆导出但对不上聊天导出的“一对话一文件”结构；`withheld.texts/threads` 在校验端无对应物。
