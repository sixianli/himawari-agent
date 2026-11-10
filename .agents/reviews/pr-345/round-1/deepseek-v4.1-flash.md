## 结论

主体链路（会话认证 + 主人校验、只读连接、单并发、store-only zip、UTF-8 标志、CRC、偏移、文件排序）代码上基本成立，认证确实与 `registerProactiveRoutes` 同款。但这次改导出时没有同步处理既有的“Himawari 导出文件 → 导入”入口，直接把那条恢复路径打断了；另外“被扣留处数”的定义不成立，文案也没有说清健康/财务这类主题敏感记忆会明文导出。资源上限和几处边界也缺少自动检查。

---

## 问题（按严重度从高到低）

### 1. 中高 — 新导出让既有“Himawari 导出文件”导入入口变成死路

- 文件:行：`apps/control-center/src/i18n/resources/zh-CN.ts:723`、`apps/control-center/src/components/memory-page.tsx:2017`、`apps/control-center/src/memory-import.ts:156-157`
- 问题：导出已经从 `himawari-memories.json` 换成 `himawari-export-YYYY-MM-DD.zip`，但记忆页的“导入记忆 → Himawari 导出的文件”仍然要求选旧 JSON，文件选择框也只接受 `.json`。用户按页面提示无法恢复自己刚导出的内容。
- 证据（读代码证实）：
  - `zh-CN.ts:723`：`选之前用“导出全部记忆”下载的 himawari-memories.json。`
  - `memory-page.tsx:2017`：`accept={source === "codex" ? ".md,.txt" : ".json"}`
  - `memory-import.ts:156-157`：`const data = JSON.parse(text) ... if (!Array.isArray(data.memories)) throw new Error("MEMORY_EXPORT_INVALID");`
  - 服务端现在产出的是 zip：`production-data-export.ts:136` `attachment; filename="himawari-export-${stamp}.zip"`。
  - 英文、日文同样过期：`en.ts:766`、`ja.ts:773`。
- 建议：二选一，不要留在中间状态：
  1. 让网页导入支持新 zip（至少在浏览器里解出 `data/memories.jsonl` 或复用 `readPortableDirectory` 的格式），并加一条“导出→导入”回归用例；
  2. 明确网页不再支持恢复，隐藏/删除 `source === "himawari"` 这一入口，并同步三语文案和 ADR 第 10 条。

### 2. 中 — `x-himawari-export-withheld` 不是“处数”，会重复计数且漏计短文字占位

- 文件:行：`apps/agent-service/src/production-data-export.ts:129-132`、`packages/persistence-sqlite/src/data-export/export.ts:105-108,473-477`
- 问题：页面显示“{withheld} 处敏感内容只留了占位符”，但服务端把三个互相包含的集合直接相加：
  - 一条记忆正文被扣留时，`texts` 加 1，`memories` 也加 1，最终显示 2“处”；
  - 实体名、别名、来源编号这类短文字被换成 `[已扣留:n]` 时只增加 `replacedShortTexts`，完全不进 `withheld`，于是又漏计。
- 证据（读代码证实）：
  - `production-data-export.ts:129-132`：`withheld = texts + memories + decisions`
  - `export.ts:105-108`：命中机密时 `withheldKeys.add(key); owner?.set.add(owner.id);`
  - `export.ts:474-476`：`texts: withheldKeys.size, memories: withheldOwners.memories.size, decisions: withheldOwners.decisions.size`
  - 短文字走 `safeString` 只累加 `replacedShortTexts`（`export.ts:132-141`），不进 `withheld`。
  - 测试把同一个公式再算一遍（`data-export-http.test.ts:80-83`），所以这个错误用例是自证的，抓不到。
- 建议：定义一个可验证指标而不是相加：例如页面显示 `withheld.texts`（被扣留的正文/历史/引用段数），或新增 `withheld.places` 把“正文段 + 短文字占位”按同一种单位算清楚；同时让测试用固定夹具断言精确值（例如当前夹具应是 3，不是 6）。

### 3. 中低 — 文案没有说明敏感主题记忆会明文导出、回收站记忆也会导出

- 文件:行：`packages/persistence-sqlite/src/data-export/snapshot.ts:31,51-52`、`apps/control-center/src/i18n/resources/zh-CN.ts:742-743`
- 问题：旧界面默认排除 `dataClassification === "sensitive"` 的记忆，要用户勾选“包含敏感记忆（健康、财务等）”才导出；新流程一律导出，且只把“密码、证件号”类值遮掉。健康、财务等主题敏感记忆的正文会以明文进入 zip，回收站记忆也会进入，页面没有说明。
- 证据（读代码证实）：
  - `snapshot.ts:31`：`EXPORTABLE_STATUSES = "('active', 'archived', 'trashed')"`
  - `snapshot.ts:51-52`：只排除 `status NOT IN (...)` 和 `classification = 'restricted'`，没有排除 `sensitive_topic`。
  - 新文案 `zh-CN.ts:742-743` 只说“密码、证件号等敏感内容在文件里只留占位符”，没有说主题敏感原文会明文、回收站也会导出。
- 建议：在 `exportNote` 明确写出范围（含健康/财务等主题敏感原文、含回收站），或恢复一个“包含敏感主题记忆”的选择；ADR 中已经决定主题敏感放明文，文案必须跟上。

### 4. 中低 — 512MB 是打包阶段的上限，不是内存上限；同步读快照会阻塞事件循环

- 文件:行：`apps/agent-service/src/production-data-export.ts:82,92,119`、`packages/persistence-sqlite/src/data-export/export.ts:73`、`packages/persistence-sqlite/src/data-export/snapshot.ts:43-44`
- 问题：`buildPortableExport` 先把整库行、全部密文和全部明文/占位结果读进内存，之后 `createStoredZip` 才检查累计大小；因此超过 512MB 的库会在已经完整构建后被拒绝，峰值内存仍可能是数百 MB 到 1GB 以上。并且 `readSnapshot` 是同步事务，会阻塞整个 Node 事件循环。
- 证据（读代码证实）：
  - `export.ts:73`：`const snapshot = readSnapshot(...)`，在第一个 `await` 之前同步执行。
  - `snapshot.ts:43-44`：`return database.transaction((): PortableSnapshot => { ... }).deferred();`
  - `production-data-export.ts:82`：检查在循环内 `if (offset > MAXIMUM_ARCHIVE_BYTES) throw`
  - `production-data-export.ts:92`：最后再一次性分配完整 `archive`。
- 建议：在 `readSnapshot` 前先估算总字节/行数并拒绝超限；或把导出放到 worker thread / 子进程，避免阻塞正在进行的对话流；若要保留在进程内，至少把“内存峰值不受 512MB 约束、会阻塞事件循环”写进 ADR 的后果里。

### 5. 低 — 并发标志、512MB、生产 WAL 读这些边界没有自动检查

- 文件:行：`test/integration/data-export-http.test.ts:20-21,113-122`
- 问题：现有测试只证明“两个并发请求一个 200 一个 429”，没有证明一次 500 之后标志会复位；512MB 超限路径没有用例；正例先 `wal_checkpoint(TRUNCATE)`，没有覆盖生产里活跃 WAL 连接的真实状态。
- 证据（读代码证实）：
  - `data-export-http.test.ts:21` 先 checkpoint 再打开只读连接。
  - `running = false` 在 `production-data-export.ts:145-146` 的 `finally` 里，代码本身是对的，但没有对应用例。
- 建议：补三条反向用例：①让 `buildPortableExport` 抛错后，下一请求仍能 200；②伪造一个超过 512MB 的 `PortableFiles`，断言 500 且不会保持 429；③保持写连接打开、有未 checkpoint 的 WAL 时导出成功。

### 6. 低 — `migrationSequence` 直接写 `LATEST_MIGRATION_SEQUENCE`，没有校验库的实际 schema

- 文件:行：`apps/agent-service/src/production-data-export.ts:122`、`apps/admin-cli/src/data-command.ts:149,156`
- 问题：命令行导出先 `assertWritableSchema(database, LATEST_MIGRATION_SEQUENCE)`，网页导出没有这一步。若运行中的库因升级/回滚与二进制不一致，清单会声称最新迁移序号，导入端按最新版本校验时可能接受或拒绝错配的数据。
- 建议：复用 `assertWritableSchema`，或从库里读取实际迁移序号写入清单；至少加一条“库版本不符时拒绝导出”的测试。

### 7. 低 — 客户端和服务端各自硬编码同一个 URL，没有交叉检查

- 文件:行：`apps/control-center/src/data-export.ts:1`、`apps/agent-service/src/production-data-export.ts:16`
- 问题：`DATA_EXPORT_URL` 和 `DATA_EXPORT_PATH` 是两份独立的字面量；服务端改路径时客户端只会静默 404，测试里又硬编码了同一字符串，抓不到。
- 建议：把路径放进两边都能引用的 contracts 包，或加一条工具测试断言两者一致。

### 8. 低 — zip 用例的“标准解压器”其实是 fflate，UTF-8 标志和 CRC 没有独立验证（推测）

- 文件:行：`test/integration/data-export-http.test.ts:124-133`
- 问题：用例只用 `unzipSync` 还原文件名和内容。若 fflate 像不少 JS 库一样直接按 UTF-8 解文件名、忽略通用标志位，那么去掉 `0x0800` 这条用例依然会通过；CRC 是否被校验也不确定。
- 证据（推测）：我未能读取 `node_modules/fflate` 源码（仓库未安装依赖），所以这是推测，需实测确认。
- 建议：直接断言 zip 原始头的 `0x0800` 标志、CRC 字段和中央目录偏移；另加一条系统 `unzip`/`bsdtar` 的兼容性测试，避免只靠 fflate。

### 9. 低 — 所有异常被吞成 500，没有诊断信息

- 文件:行：`apps/agent-service/src/production-data-export.ts:143-144`
- 问题：`catch { return reply.code(500).send(); }` 丢弃了 `DATA_EXPORT_TOO_LARGE`、`DATA_EXPORT_PAYLOAD_UNAVAILABLE` 等具体原因。线上出问题时只能看到通用失败，无法判断是超限、库损坏还是解密失败。
- 建议：记录错误码/阶段（不含记忆正文），或写入服务诊断；页面仍可显示通用文案。

---

## 作者说法核对

- 属实：路由路径、store-only zip、只读连接、会话认证 + `ownerId` 校验、`Sec-Fetch-Site` 检查、单并发、512MB 常量、路由不传口令/证据、本改动不发模型请求、`check:data-export` 门槛 44 与脚本一致。
- 不准确：
  - “网页不提供导入（导入只能进空库）”：网页仍有导入面板（`memory-page.tsx:2281-2288`），且其 `himawari` 来源就是导入 Himawari 自己的导出；实现见 `memory-import.ts:151-182`。ADR 第 10 条（`docs/adr/0200...:63`）据此说“不动”，但该入口现在已失效。
  - “显示被扣留的处数”：见问题 2，实际是三个重叠集合的和。
  - “总量 512MB”：只是打包阶段的输出上限，不是构建前/内存上限，见问题 4。
  - “接口测试 4 条通过、Chromium 手动验证通过”：本复核只能用 git 读代码，未能运行，标为未核实。
  - 改动文件清单不全：实际还改了 `test/integration/product-path-browser.test.ts`、`production-http-composition-process.test.ts`、`apps/control-center/test/memory-interactions.unit.test.ts`、`release-walkthrough-*`、`scripts/delivery-mode/test_deploy.py` 等。

---

## 侧重检查

- 认证/主人校验：`authenticateHttpRequest(request, options).catch(() => undefined)` + `authentication.ownerId !== options.ownerId`（`production-data-export.ts:111-113`），与 `registerProactiveRoutes` 的 `production-http-composition.ts:559-564` 完全一致。未发现绕过。
- 不可信输入：GET 无 body/query；`Sec-Fetch-Site` 只用于精确拒绝，非法值一律 403；文件名由受信任时钟派生；数据库路径来自配置。未发现注入/路径穿越。
- 安全/隐私：未登录 401、跨域 403、无 sealed 文件、含密钥文字被遮。问题在于主题敏感记忆明文导出且文案未说明（问题 3）。
- 资源耗尽：单并发只防并发，不防单请求体积；同步快照阻塞事件循环，512MB 在完整构建后才检查（问题 4）。HEAD 请求也会触发完整生成（`app.get` 默认暴露 HEAD），但需要已认证。
- 不可撤销操作：没有写库、没有删除、没有外发模型；导出是只读的。
- 规则/文档一致性：`.claude/rules/prompt-prefix.md` 不受影响；ADR 的 44 条与脚本一致；但 ADR 第 10 条、三语导入文案与新导出行为不一致（问题 1、3）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本改动没有进入模型请求组装/发送路径：路由只做 `openReadOnlyDatabase` → `buildPortableExport` → zip，`buildPortableExport` 只读库和调用 `protector.unprotect`，不发模型请求；导出用的 `now()`（`exportedAt`）只进入 zip/manifest，不会进入任何系统提示、工具定义、历史消息或遮盖结果。发给模型的内容仍然只在末尾追加，每轮变化的值仍然只应放在最后一条用户消息里；本改动没有新增这类值。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求：不会，本改动不参与模型请求。对导出包：会，`manifest.exportedAt` 和 zip 的 DOS 时间每次导出都变，整个 zip 不是逐字节稳定的；但 `data/*.jsonl`、Markdown 等数据文件按现有测试是稳定的（`data-export.test.ts` 的“同一数据库导出两次数据文件相同”），zip 条目顺序也做了排序（`production-data-export.ts:45-47`）。遮盖按每条文字和库内已有占位编号决定，不受请求先后影响；但库里新增更大占位编号后，同一段文字的新导出可能得到不同占位编号，这是库状态变化，不是请求顺序导致。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：`check:data-export` 加入 `data-export-http.test.ts` 并把门槛提到 44；UI 单测覆盖成功/401 失败；进程级测试覆盖 200/401/403；浏览器验收新增 `accept-memory-export`、`accept-export-requires-login`；覆盖映射也更新了。认证反向、UI 失败反向、zip 非 ASCII 反向在实现被移除时应当会失败。但：`withheld` 断言是同一个公式的自证；500 后并发标志复位、512MB 超限、生产活跃 WAL 没有用例；zip 的 UTF-8 标志/CRC 依赖 fflate，是否真能反向失败未核实。

4. **改动产生或修改的每个值，使用它的一端都能接受吗？**
   - `DATA_EXPORT_PATH`/`DATA_EXPORT_ARCHIVE_ROOT`：服务端和测试、zip 内前缀能接受；客户端另写了一份字面量（问题 7）。
   - `content-disposition` 文件名：服务端产出 `himawari-export-YYYY-MM-DD.zip`，客户端正则 `[A-Za-z0-9._-]{1,80}` 能接受。
   - `x-himawari-export-memories`：服务端是 `manifest.counts.memories`，客户端按安全整数接受，OK。
   - `x-himawari-export-withheld`：客户端能接受数字，但数字定义不成立（问题 2）。
   - `memory.page.export*` 文案与 `MESSAGE_SAMPLE_VALUES`：三语和 message-ids 都补齐了，locale 检查应能通过；但 `fileHelp` 仍指向旧文件名（问题 1）。
   - `migrationSequence`：导入端按目标最新迁移序号校验；网页端没有先校验库版本（问题 6）。
   - `ExportPanel` 去掉 `overview` 属性：调用点和测试已同步，OK。
   - 旧的 `memory.page.exportSensitive`：已无残留引用，OK。
   - 未核实项：测试实际运行结果、上线走查在真实包中的结果、fflate 对 UTF-8 flag/CRC 的处理、生产活跃 WAL 下只读连接的实测表现。
