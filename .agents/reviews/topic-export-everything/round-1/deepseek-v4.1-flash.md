CLAIM|1|不一致|clients/apple/Sources/HimawariManage/SettingsRootView.swift:16|iPhone 设置页有一行“导出全部数据”|EmptyStateView(Text(PlaceholderText.notConnected))
CLAIM|2|一致|apps/agent-service/src/production-data-export.ts:412|经网关 v2 的 data.export.start|"data.export.start",
CLAIM|3|不一致|ci/operations-pending.json:5|iPhone 设置页有一行“导出全部数据”，经网关 v2 的 data.export.start 开始生成|"data.export.start": "iOS 原生设置页的导出全部数据：处理程序已实现并有测试（和网页 /api/data-export/v1/archive 同一套生成逻辑），调用方是 iOS 第 11 批（PR 426）的原生页，带网页会话调网关 v2，网页直接下载不走这条（缺：调用方）。check:operations 只扫 TypeScript，认不出 clients/apple 里的 Swift 调用方，第 11 批合并后手动移出名单",
CLAIM|4|一致|docs/adr/0235-chat-history-export.md:10|对话导出是 ADR 0235 定的另一个包|# ADR 0235：聊天记录可以导出（独立的包，只导出不导入）
CLAIM|5|不一致|apps/admin-cli/src/data-command.ts:52|只有网页的 GET /api/data-export/v1/chats 一个入口|  readonly action: "export" | "export-chats" | "inspect" | "import" | "demo-pack";
CLAIM|6|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:53|记忆导出不含对话。来源：ADR 0200 第 53 行：“不导出：……对话、事件段、检索索引。”|不导出：删除流程中和已验证删除的记忆、restricted 记忆（清单里写条数）、对话、事件段、检索索引。
CLAIM|7|一致|docs/adr/0235-chat-history-export.md:77|ADR 0235 当时放弃了“并进同一个包”，理由三条。来源：ADR 0235 第 77 行：“**并进记忆导出的同一个包。**会和正在改同一批文件的 PR 393 冲突，记忆包会变大，512 MB 的上限也会被聊天挤占。”|- **并进记忆导出的同一个包。**会和正在改同一批文件的 PR 393 冲突，记忆包会变大，512 MB 的上限也会被聊天挤占。
CLAIM|8|一致|docs/adr/0235-chat-history-export.md:88|对话导出在网页上限 128 MiB 荷载，是按内存实测定的|据此网页上限定为 128 MiB 荷载（峰值内存约 0.8 GB），超过返回 413 而不是冒着把服务撑爆的风险生成；
CLAIM|9|不一致|docs/adr/0235-chat-history-export.md:87|来源：ADR 0235 第 87 行：“据此网页上限定为 128 MiB 荷载（峰值内存约 0.8 GB），超过返回 413 而不是冒着把服务撑爆的风险生成”|- 零迁移。
CLAIM|10|一致|apps/agent-service/src/production-chat-export.ts:18|代码 apps/agent-service/src/production-chat-export.ts 第 18 行 CHAT_EXPORT_WEB_MAXIMUM_BYTES = 128 * 1024 * 1024|export const CHAT_EXPORT_WEB_MAXIMUM_BYTES = 128 * 1024 * 1024;
CLAIM|11|一致|apps/agent-service/src/production-data-export.ts:43|打包后的压缩包上限 512 MiB。来源：apps/agent-service/src/production-data-export.ts 第 43 行 MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024。|const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
CLAIM|12|一致|docs/adr/0235-chat-history-export.md:90|两种导出本来就可以同时跑、内存叠加。|- 网页聊天导出和记忆导出各有一个“同时只一份”的标志，两者可以同时跑，内存会叠加；单人使用时发生的可能性低，没有加共用的锁。
CLAIM|13|不一致|docs/adr/0235-chat-history-export.md:89|来源：ADR 0235 第 89 行：“网页聊天导出和记忆导出各有一个‘同时只一份’的标志，两者可以同时跑，内存会叠加”|- 没有口令时不在内存里保留机密原文。
CLAIM|14|一致|docs/product-vision.md:39|愿景要求数据可以完整带走。来源：docs/product-vision.md 第 39 行：“数据不落在任何第三方平台的 SaaS 里，且我可完整迁移、备份与删除。”|数据不落在任何第三方平台的 SaaS 里，且我可完整迁移、备份与删除。
CLAIM|15|一致|apps/admin-cli/src/data-command.ts:179|两个文件夹各有自己的清单，各自能用 himawari-admin data inspect 校验。|      const chats = verifyChatExport(files, LATEST_MIGRATION_SEQUENCE);
CLAIM|16|一致|apps/admin-cli/src/data-command.ts:191|各自能用 himawari-admin data inspect 校验|    const manifest = verifyIntegrity(files, LATEST_MIGRATION_SEQUENCE);
CLAIM|17|一致|packages/persistence-sqlite/src/data-export/verify.ts:329|不把对话塞进记忆导出的文件夹，因为记忆导出的校验会拒绝清单里没登记的文件。|      throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH, `未登记 ${path}`);
CLAIM|18|一致|apps/agent-service/src/production-data-export.ts:32|网页的“导出”（GET /api/data-export/v1/archive）|export const DATA_EXPORT_PATH = "/api/data-export/v1/archive";
CLAIM|19|一致|apps/agent-service/src/production-data-export.ts:529|和网关的 data.export.start 用的是同一个生成函数|        built = await options.jobs.buildNow();
CLAIM|20|一致|apps/agent-service/src/production-data-export.ts:267|和网关的 data.export.start 用的是同一个生成函数|    void this.buildNow({
CLAIM|21|一致|apps/agent-service/src/production-data-export.ts:368|所以网页这个包也带上对话。|      const conversations = await buildChatExport({
CLAIM|22|一致|apps/agent-service/src/production-chat-export.ts:16|网页原来的 GET /api/data-export/v1/chats 保留|export const CHAT_EXPORT_PATH = "/api/data-export/v1/chats";
CLAIM|23|一致|apps/control-center/src/components/memory-page.tsx:2190|网页的记忆页还在用它。|      const result = await requestChatExport();
CLAIM|24|一致|apps/agent-service/src/production-data-export.ts:42|对话部分沿用 128 MiB 的荷载上限。|export const DATA_EXPORT_CONVERSATIONS_MAXIMUM_BYTES = 128 * 1024 * 1024;
CLAIM|25|一致|apps/agent-service/src/production-data-export.ts:43|整个压缩包仍不超过 512 MiB。|const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
CLAIM|26|一致|.claude/rules/owner-standing-rules.md:33|界面上的数字要有可验证的定义（.claude/rules/owner-standing-rules.md 的“界面上的数字和验收”）|- 界面上给 Andy 看的每个数字和判断词（例如“找到 3 条相关记忆”“命中”“推荐”“成功 N 条”）都要有可以验证的定义和门槛，没有就不显示（起因是界面上“找到 3 条相关记忆”永远凑满 3 条）。
CLAIM|27|不一致|.claude/rules/owner-standing-rules.md:33|进度用真实计数而不是估算百分比，是本项目的长期规则|- 界面上给 Andy 看的每个数字和判断词（例如“找到 3 条相关记忆”“命中”“推荐”“成功 N 条”）都要有可以验证的定义和门槛，没有就不显示（起因是界面上“找到 3 条相关记忆”永远凑满 3 条）。
CLAIM|28|一致|packages/persistence-sqlite/src/data-export/verify.ts:329|记忆导出的校验（verifyIntegrity）会把清单里没登记的文件当成错误，整份拒绝|      throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH, `未登记 ${path}`);
CLAIM|29|一致|git:075dd4a6|PR 393 早已合并，冲突不再存在|075dd4a6 Merge pull request #393 from sixianli/claude/project-thread-zh3mvt
CLAIM|30|一致|apps/agent-service/src/production-data-export.ts:43|512 MiB 的上限仍在|const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
CLAIM|31|一致|apps/agent-service/src/production-data-export.ts:42|对话部分另有 128 MiB 荷载上限|export const DATA_EXPORT_CONVERSATIONS_MAXIMUM_BYTES = 128 * 1024 * 1024;
CLAIM|32|一致|apps/agent-service/src/production-data-export.ts:368|网页记忆页的“导出”现在也带对话|      const conversations = await buildChatExport({
CLAIM|33|一致|apps/agent-service/src/production-data-export.ts:538|对话荷载超过 128 MiB 的库，网页上的这个导出会失败（返回 413）|          return reply.code(413).send();
CLAIM|34|一致|apps/admin-cli/src/data-command.ts:52|只能用命令行分别导出|  readonly action: "export" | "export-chats" | "inspect" | "import" | "demo-pack";
CLAIM|35|一致|test/integration/data-export-http.test.ts:347|test/integration/data-export-http.test.ts 里带 [iOS] 的用例|  it("[iOS] 经网关开始导出、查进度、取结果：和网页直接下载用同一套生成逻辑", async () => {
CLAIM|36|一致|test/integration/data-export-http.test.ts:654|覆盖包里两个文件夹各自校验通过|    const chats = verifyChatExport(conversations, side.migrationSequence);
CLAIM|37|一致|test/integration/data-export-http.test.ts:655|覆盖包里两个文件夹各自校验通过|    expect(verifyIntegrity(memories, side.migrationSequence).counts.memories).toBe(
CLAIM|38|一致|test/integration/data-export-http.test.ts:659|对话和消息个数等于对话清单|    expect(ready.result.conversations).toBe(chats.counts.threads);
CLAIM|39|一致|test/integration/data-export-http.test.ts:660|对话和消息个数等于对话清单|    expect(ready.result.messages).toBe(chats.counts.messages);
CLAIM|40|一致|test/integration/data-export-http.test.ts:674|进度先记忆后对话且已读数是真实计数|  it("[iOS] 生成中的进度是真实计数：先记忆、后对话，读完前面一段才开始后面一段，结束后不再给进度", async () => {
CLAIM|41|一致|test/integration/data-export-http.test.ts:722|生成中取消后不再解密且不会变回 ready|  it("[iOS] 取消正在生成的导出：状态变成 cancelled，放开后也不会变回 ready；重发取消是 replayed，之后能重新开始", async () => {
CLAIM|42|一致|test/integration/data-export-http.test.ts:807|打包快结束时取消|  it("[iOS] 打包快结束时取消，生成完的结果也不会把状态改回 ready", async () => {
CLAIM|43|一致|test/integration/data-export-http.test.ts:765|已生成的取消后下载 404|    expect(dropped.statusCode).toBe(404);
CLAIM|44|一致|test/integration/data-export-http.test.ts:768|取消不认识的编号 404|  it("[iOS] 反向：取消不认识的编号是 404，取消已失败的是冲突，不是主人发的被拒", async () => {
CLAIM|45|一致|test/integration/data-export-http.test.ts:786|取消已失败的冲突|    await expect(cancel(failed)).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
CLAIM|46|一致|test/integration/data-export-http.test.ts:790|对话超过上限整份失败且网页 413|  it("[iOS] 对话太多超过上限时整份导出失败并说明原因，网页直接下载得到 413，不交出缺了对话的包", async () => {
CLAIM|47|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:59|packages/gateway-contracts/test/data-export-gateway.contract.test.ts 覆盖进度和取消的契约正反用例|  it("accepts real progress while running: a section not started yet has no total", () => {
CLAIM|48|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:113|packages/gateway-contracts/test/data-export-gateway.contract.test.ts 覆盖进度和取消的契约正反用例|  ])("rejects a snapshot with %s", (_name, overrides) => {
CLAIM|49|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:117|packages/gateway-contracts/test/data-export-gateway.contract.test.ts 覆盖进度和取消的契约正反用例|  it("accepts a cancel command for one export and rejects it without a valid id", () => {
CLAIM|50|一致|docs/adr/0235-chat-history-export.md:78|ADR 0235 的“放弃的做法”第 1 条原文不改，在那里加了指向本文的说明。|  - 后续：本条已被 [ADR 0263](0263-export-everything-in-one-job-with-progress-and-cancel.md) 部分取代：“导出全部数据”在一个任务里同时生成记忆和对话，压缩包里两个文件夹并列，各自的格式和清单不变。本条原文不改。

未核对：Google Takeout 的页面原话和 iOS 设计线程的回复属于外部资料；网页导出同时含记忆与对话时的实际耗时、内存叠加也没有实测数据。
