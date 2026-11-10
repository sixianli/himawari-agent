# 复核报告：PR 345 记忆页网页导出

## 发现的问题（按严重度从高到低）

### 1.（中）主进程事件循环被导出的同步工作阻塞，文档只承认内存问题
- 文件:行：`packages/persistence-sqlite/src/data-export/snapshot.ts:39-44`、`packages/persistence-sqlite/src/data-export/export.ts:70-131`、`apps/agent-service/src/production-data-export.ts:118-125`
- 问题：`buildPortableExport` 里 `readSnapshot` 是 better-sqlite3 的同步调用（`database.prepare(sql).all(...)`），随后的占位扫描（`JSON.stringify` 六张表）、`jsonLines`、`sha256Hex`、`createStoredZip`（整包 memcpy）都是同步 CPU 工作，全部跑在承载全部生产流量的主进程事件循环上。读代码证实的部分：这些调用确实是同步的；推测的部分：数据接近 512 MB 上限时阻塞时长可能达到秒级，会卡住健康检查、推送和对话流式响应。
- 证据：`snapshot.ts:39` `const all = (sql: string): Row[] => database.prepare(sql).all(parameters) as Row[];`；`export.ts:120` `JSON.stringify([...])`；ADR 0200 只写“整份内容在内存里生成，所以限制总量 512 MB，同时只允许一个”（`docs/adr/0200-...md:87`），未提阻塞。
- 建议：在 ADR/走查里写明阻塞窗口的量级，或把导出移到 worker/子进程；至少在单并发之外加“导出期间降级其他请求”的说明。

### 2.（中）三语导入帮助文案仍指向网页导出已不再产生的 `himawari-memories.json`
- 文件:行：`apps/control-center/src/i18n/resources/zh-CN.ts:723`、`en.ts:766`、`ja.ts:773`
- 问题：导入面板（source 非 codex）的帮助文案说“选之前用‘导出全部记忆’下载的 himawari-memories.json”，但本改动把导出改成了 `himawari-export-YYYY-MM-DD.zip`，该 JSON 文件不再存在。文案与行为不一致；且命令行导出是目录格式，也不是这个文件——用户按文案操作必然失败。ADR 第 10 条说“导入不动”，但没发现它引用的来源文件被本次改动删掉了。
- 证据：`zh-CN.ts:723` `…other {选之前用"导出全部记忆"下载的 himawari-memories.json。}}`；新导出文件名在 `production-data-export.ts:134-135`（`himawari-export-${stamp}.zip`）。
- 建议：改三语文案（例如“选其他助手生成的 Himawari 格式 JSON”），或让导入也接受 zip。

### 3.（低）导出失败一律 500 且完全吞错，无任何服务端日志
- 文件:行：`apps/agent-service/src/production-data-export.ts:126-128`
- 问题：`catch { return reply.code(500).send(); }` 把 `DATA_EXPORT_PAYLOAD_UNAVAILABLE`、`DATA_EXPORT_TOO_LARGE`、数据库打开失败等全部压成无日志的 500，线上无法区分“数据不支持”和“程序 bug”。
- 证据：`try { … } catch { return reply.code(500).send(); }`。
- 建议：至少 `request.log.warn` 记录错误码。与 `production-gap-export.ts:177` 的静默风格一致，故只算低。

### 4.（低）`x-himawari-export-*` 两个响应头没有文档定义
- 文件:行：`apps/agent-service/src/production-data-export.ts:137-138`
- 问题：头的语义（memories = manifest.counts.memories；withheld = withheld.texts+memories+decisions 之和）只存在于代码和 `test/integration/data-export-http.test.ts:78-83` 的断言里，ADR 0200 第 9 条只说“显示被扣留的处数”。有测试兜底，可验证性尚可，但复核要求“可验证的定义”落在外部可读文档里。
- 建议：在 ADR 第 9 条补一句两个头的定义。

### 5.（低）客户端在响应头缺失时把数字显示为 0
- 文件:行：`apps/control-center/src/data-export.ts:20-22`
- 问题：`Number(response.headers.get(name))` 在头缺失时得 `NaN` → 回退 0，页面会显示“0 处敏感内容只留了占位符”，与事实可能相反（代理剥头、或未来服务端改版）。
- 建议：缺头时按未知处理而不是 0。

### 6.（低，部分推测）`check:data-export` 门槛是否真能“反向失败”未完全核实
- 文件:行：`scripts/check-data-export.mjs:9-15`
- 问题：读代码证实门槛包含新文件并把阈值 40→44；若旧文件实际通过数恰为 40，删掉新测试必然跌破 44。但 `data-export.test.ts:360` 的模板测试会按用例数动态展开，实际总数我没法不运行测试来确认；若动态展开后旧总数已 ≥44，删新测试仍能过门槛（推测）。
- 建议：跑一次 `npm run check:data-export` 记下实际条数，确认余量为 0。

### 7.（信息）几个不现实的边界
- `production-data-export.ts:65-66`：`MAXIMUM_ARCHIVE_BYTES` 只累计数据区，不含中央目录；`end.setUint16(8, entries.length)` 条目数 >65535 会溢出——在本格式固定文件清单下都达不到，不构成问题，但注释/常量语义（“总量 512MB”）与实际（数据区 512MB）有微小偏差。
- 认证前先查 `Sec-Fetch-Site`：未登录 + 跨站返回 403 而非 401。与 `registerProactiveRoutes`（`production-http-composition.ts:571-575`）完全一致，ADR 的表述略不精确。

## 读代码证实的正确点（作者说法逐条核对）
- 认证与主人校验与 `registerProactiveRoutes` 一致：同样的 `authenticateHttpRequest(...).catch(() => undefined)` + `ownerId` 比较 + 缺失 `sec-fetch-site` 时放行（`production-data-export.ts:106-112` vs `production-http-composition.ts:559-563, 571-573`）。属实。
- 并发标志复位：`running = true` 与检查之间无 await，`finally { running = false }` 覆盖所有异常路径，`database.close()` 在内层 `finally`（`:114-146`）。属实。
- zip 写法：UTF-8 标志 `0x0800` 在本地头偏移 6 和中央头偏移 8 都置位；CRC、压缩/原始长度、本地头偏移（42）、EOCD 的条目数/中央目录大小/偏移全部正确；条目按文件名排序，单请求内字节确定。有 `unzipSync` 反解测试（`data-export-http.test.ts:120-133`）。属实。
- 快照一致性：`readSnapshot` 用 `database.transaction(...)` 包住全部读（`snapshot.ts:43-44`），只读连接上构成一致读事务。属实。
- “导出库已有含机密只留占位符、无口令不带密封文件”：`export.ts:93-115, 395-408`（无 `sealPassphrase` 不写 `SEALED_FILE`），路由不传口令。属实。
- “本改动不发模型请求”：diff 全部是 HTTP 路由、UI、i18n、测试、文档，无任何 prompt/工具/消息路径。属实。

## 侧重检查
走的普通流程：登录主人 → 记忆页 → 点“导出全部记忆”（zh-CN.ts:717）→ ExportPanel → 点“下载导出文件” → `requestDataExport` fetch `/api/data-export/v1/archive` → 路由：Sec-Fetch-Site 检查 → 会话认证 + ownerId → 单并发标志 → `openReadOnlyDatabase`（readonly + busy_timeout）→ `buildPortableExport`（事务快照 → 逐条解密 → 掩盖 → JSONL/Markdown/manifest）→ `createStoredZip` → 200 + 头 → 浏览器 blob → `<a download>` → `exportDone` 文案。
结论：
- 有覆盖：正向下载（单测 + inject 测试 + 流程级测试 + 走查 `accept-memory-export`）、401/403（inject + 流程级 + 走查 `accept-export-requires-login`）、429（inject）、zip 反解与 manifest 校验、机密明文不出现。
- 无覆盖的路径：512MB 超限 `RangeError`→500（无测试、无走查）；429 时 UI 只走通用“导出失败”文案（单测只测了 401）；数据库文件打不开→500；`dosDateTime` 年份 <1980 钳制。
- 未核实：`check:data-export` 实际通过总数、作者声称的真实 Chromium 手动验证、进程级测试与走查的实际运行结果（需要上线包，本机无法运行）。

## 必答问题
1. **不会。** 发给模型的内容不受影响：diff 未触及系统提示、工具定义、历史消息或进模型的遮盖逻辑；生产组合的改动只是 import 排序加一条独立 HTTP 路由。新路由是纯出站下载，不进任何 prompt 组装路径，“只在末尾追加、每轮变化值都在最后一条消息”的性质未被触碰。
2. **不涉及模型请求字节。** zip 本身在同一请求内字节确定：条目排序、`exportedAt` 单值、占位编号由库内容决定（`export.ts:118-141`）；跨请求的 DOS 时间戳随 `exportedAt` 变化属预期产物差异，不进模型。
3. **有，且多数反向用例真实失败。** 401（匿名/换主人）、403（跨站）、429（并发）、401 的 UI 失败文案都有断言；门槛 44 含新文件。缺口见侧重检查（512MB→500、429 UI 文案无覆盖）；门槛余量是否为 0 未核实。
4. **逐项核对均能接受。** 路径 `/api/data-export/v1/archive`：服务端 `DATA_EXPORT_PATH` 与客户端 `DATA_EXPORT_URL` 一致，单测断言了调用参数；zip 根前缀与文件名：测试与走查正则双端校验；两个响应头：服务端产生处与客户端消费处由 `data-export-http.test.ts:78-83` 对 manifest 交叉验证；i18n 新 id 三语齐全、旧 id `memory.page.exportSensitive` 无残留引用；走查选择器与 zh-CN 文案一致。唯一两端不一致的是发现 2 的导入帮助文案（引用已消失的文件），建议修掉再合。
