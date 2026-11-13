CLAIM|1|找不到|-|iOS 第 11 批正在做的 iPhone 设置页（还没合并）有一行“导出全部数据”|-
CLAIM|2|找不到|-|它要经网关 v2 的 `data.export.start` 开始生成|-
CLAIM|3|一致|packages/gateway-contracts/src/contracts-v2.ts:142|网关 v2 有 `data.export.start`|`"data.export.start",`
CLAIM|4|一致|docs/adr/0235-chat-history-export.md:10|对话导出是 ADR 0235 定的另一个包|`# ADR 0235：聊天记录可以导出（独立的包，只导出不导入）`
CLAIM|5|一致|apps/agent-service/src/production-chat-export.ts:16|网页上有 `GET /api/data-export/v1/chats` 一个入口|`export const CHAT_EXPORT_PATH = "/api/data-export/v1/chats";`
CLAIM|6|一致|apps/admin-cli/src/data-command.ts:270|另有命令行 `himawari-admin data export-chats`|`if (action === "export-chats") {`
CLAIM|7|一致|packages/gateway-contracts/src/contracts-v2.ts:142|网关上没有（独立的对话导出）|`"data.export.start",`
CLAIM|8|找不到|-|iOS 设计线程要求手机上这一行导出的就是全部数据，并且要有真实计数的进度和取消|-
CLAIM|9|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:53|记忆导出不含对话。来源：ADR 0200 第 53 行：“不导出：……对话、事件段、检索索引。”|`不导出：删除流程中和已验证删除的记忆、restricted 记忆（清单里写条数）、对话、事件段、检索索引。`
CLAIM|10|一致|docs/adr/0235-chat-history-export.md:77|ADR 0235 当时放弃了“并进同一个包”，理由三条。来源：ADR 0235 第 77 行：“**并进记忆导出的同一个包。**会和正在改同一批文件的 PR 393 冲突，记忆包会变大，512 MB 的上限也会被聊天挤占。”|`- **并进记忆导出的同一个包。**会和正在改同一批文件的 PR 393 冲突，记忆包会变大，512 MB 的上限也会被聊天挤占。`
CLAIM|11|一致|docs/adr/0235-chat-history-export.md:88|对话导出在网页上限 128 MiB 荷载，是按内存实测定的。来源：ADR 0235 第 88 行：“据此网页上限定为 128 MiB 荷载（峰值内存约 0.8 GB），超过返回 413 而不是冒着把服务撑爆的风险生成”|`据此网页上限定为 128 MiB 荷载（峰值内存约 0.8 GB），超过返回 413 而不是冒着把服务撑爆的风险生成；Markdown 副本让包大小约为正文的两倍。`
CLAIM|12|一致|apps/agent-service/src/production-chat-export.ts:18|代码 `apps/agent-service/src/production-chat-export.ts` 第 18 行 `CHAT_EXPORT_WEB_MAXIMUM_BYTES = 128 * 1024 * 1024`|`export const CHAT_EXPORT_WEB_MAXIMUM_BYTES = 128 * 1024 * 1024;`
CLAIM|13|一致|apps/agent-service/src/production-data-export.ts:43|打包后的压缩包上限 512 MiB。来源：`apps/agent-service/src/production-data-export.ts` 第 43 行 `MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024`|`const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;`
CLAIM|14|一致|docs/adr/0235-chat-history-export.md:90|两种导出本来就可以同时跑、内存叠加。来源：ADR 0235 第 90 行：“网页聊天导出和记忆导出各有一个‘同时只一份’的标志，两者可以同时跑，内存会叠加”|`网页聊天导出和记忆导出各有一个“同时只一份”的标志，两者可以同时跑，内存会叠加；单人使用时发生的可能性低，没有加共用的锁。`
CLAIM|15|一致|docs/product-vision.md:39|愿景要求数据可以完整带走。来源：`docs/product-vision.md` 第 39 行：“数据不落在任何第三方平台的 SaaS 里，且我可完整迁移、备份与删除。”|`数据不落在任何第三方平台的 SaaS 里，且我可完整迁移、备份与删除。`
CLAIM|16|找不到|-|设计线程的选择（2026-11-13，iOS 设计线程回复本线程的原话）：“选 A。手机上那一行叫‘导出全部数据’，包里就应该是全部，对话不能另走一个口……结果给出对话个数和消息条数，进度里加一段‘对话’。包变大、耗时变长没关系，有进度和取消就行。”|-
CLAIM|17|一致|apps/agent-service/src/production-data-export.ts:33|`himawari-export/` 是 ADR 0200 的记忆导出|`export const DATA_EXPORT_ARCHIVE_ROOT = "himawari-export";`
CLAIM|18|一致|apps/agent-service/src/production-chat-export.ts:17|`himawari-chats/` 是 ADR 0235 的对话导出|`export const CHAT_EXPORT_ARCHIVE_ROOT = "himawari-chats";`
CLAIM|19|一致|apps/admin-cli/src/data-command.ts:179|两个文件夹各有自己的清单，各自能用 `himawari-admin data inspect` 校验（对话部分）|`const chats = verifyChatExport(files, LATEST_MIGRATION_SEQUENCE);`
CLAIM|20|一致|apps/admin-cli/src/data-command.ts:191|两个文件夹各有自己的清单，各自能用 `himawari-admin data inspect` 校验（记忆部分）|`const manifest = verifyIntegrity(files, LATEST_MIGRATION_SEQUENCE);`
CLAIM|21|一致|packages/persistence-sqlite/src/data-export/verify.ts:329|不把对话塞进记忆导出的文件夹，因为记忆导出的校验会拒绝清单里没登记的文件|`throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_LISTING_MISMATCH, \`未登记 ${path}\`);`
CLAIM|22|一致|apps/agent-service/src/production-data-export.ts:222|网页的“导出”和网关的 `data.export.start` 用的是同一个生成函数|`return await (this.#options.build ?? ((given) => this.#build(given)))(control);`
CLAIM|23|一致|apps/agent-service/src/production-data-export.ts:386|所以网页这个包也带上对话|`{ root: DATA_EXPORT_CONVERSATIONS_ROOT, files: conversations.files },`
CLAIM|24|一致|apps/control-center/src/data-export.ts:2|网页原来的 `GET /api/data-export/v1/chats` 保留|`export const CHAT_EXPORT_URL = "/api/data-export/v1/chats";`
CLAIM|25|一致|apps/control-center/src/components/memory-page.tsx:2190|网页的记忆页还在用它|`const result = await requestChatExport();`
CLAIM|26|一致|apps/agent-service/src/production-data-export.ts:42|对话部分沿用 128 MiB 的荷载上限|`export const DATA_EXPORT_CONVERSATIONS_MAXIMUM_BYTES = 128 * 1024 * 1024;`
CLAIM|27|一致|test/integration/data-export-http.test.ts:797|超过时整份导出失败，失败原因是 `CHAT_EXPORT_TOO_LARGE`|`failureCode: "CHAT_EXPORT_TOO_LARGE",`
CLAIM|28|一致|apps/agent-service/src/production-data-export.ts:538|网页直接下载返回 413|`return reply.code(413).send();`
CLAIM|29|一致|apps/agent-service/src/production-data-export.ts:43|整个压缩包仍不超过 512 MiB|`const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;`
CLAIM|30|一致|apps/agent-service/src/production-data-export.ts:397|`conversations`（对话个数）等于包里对话清单的 `counts.threads`|`conversations: conversations.manifest.counts.threads,`
CLAIM|31|一致|apps/agent-service/src/production-data-export.ts:398|`messages`（消息条数）等于包里对话清单的 `counts.messages`|`messages: conversations.manifest.counts.messages,`
CLAIM|32|一致|apps/agent-service/src/production-data-export.ts:550|网页下载的响应头多了 `x-himawari-export-conversations`|`.header("x-himawari-export-conversations", String(built.conversations))`
CLAIM|33|一致|apps/agent-service/src/production-data-export.ts:551|网页下载的响应头多了 `x-himawari-export-messages`|`.header("x-himawari-export-messages", String(built.messages))`
CLAIM|34|一致|apps/agent-service/src/production-data-export.ts:403|“被扣留的处数”（`withheld`）把对话部分扣留的文字也算进去|`conversations.manifest.withheld.texts,`
CLAIM|35|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:108|进度是真实计数，不估算百分比|`["a percentage instead of counts", { state: "running", result: null, progress: { ...progress, percent: 40 } }],`
CLAIM|36|一致|apps/agent-service/src/production-data-export.ts:445|`data.export.status.snapshot` 在生成中多一个 `progress`|`progress: view.state === "running" ? view.progress : null,`
CLAIM|37|一致|apps/agent-service/src/production-data-export.ts:366|`stage` 是 `memories`|`onProgress: progressOf("memories"),`
CLAIM|38|一致|apps/agent-service/src/production-data-export.ts:378|`stage` 是 `conversations`|`onProgress: progressOf("conversations"),`
CLAIM|39|一致|apps/agent-service/src/production-data-export.ts:380|`stage` 是 `packing`（正在打包）|`report("packing");`
CLAIM|40|一致|apps/agent-service/src/production-data-export.ts:346|`sections` 按记忆、对话的固定顺序各一项|`sections: (["memories", "conversations"] as const).map((section) => ({`
CLAIM|41|一致|apps/agent-service/src/production-data-export.ts:352|给“已读出几段文字、一共几段”（`textsRead`、`textsTotal`）|`counted[section] = { textsRead, textsTotal };`
CLAIM|42|一致|packages/persistence-sqlite/src/data-export/chats.ts:298|一段文字是一个加密荷载，例如一条记忆的正文、一个对话标题或一条消息|`for (const [ref, payload] of snapshot.payloads) {`
CLAIM|43|一致|apps/agent-service/src/production-data-export.ts:340|还没开始的那一段 `textsTotal` 是 `null`、`textsRead` 是 0|`memories: { textsRead: 0, textsTotal: null },`
CLAIM|44|一致|apps/agent-service/src/production-data-export.ts:275|生成结束（成功、失败或取消）后 `progress` 是 `null`|`job.progress = null;`
CLAIM|45|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:80|契约拒绝已读数大于总数|`["more texts read than the total", { state: "running", result: null, progress: withSection(0, { textsRead: 6 }) }],`
CLAIM|46|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:84|契约拒绝总数未知却已读|`["texts read before the total is known", { state: "running", result: null, progress: withSection(1, { textsRead: 1 }) }],`
CLAIM|47|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:88|契约拒绝段的顺序不对|`"sections out of order",`
CLAIM|48|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:77|契约拒绝非生成中却带进度|`["progress after the export is ready", { progress }],`
CLAIM|49|一致|packages/gateway-contracts/src/contracts-v2.ts:812|取消命令 `data.export.cancel`，带导出编号|`payload: object({ exportId: dataExportIdSchema }),`
CLAIM|50|一致|apps/agent-service/src/production-data-export.ts:308|生成中取消：状态立即变成 `cancelled`|`job.state = "cancelled";`
CLAIM|51|一致|packages/persistence-sqlite/src/data-export/chats.ts:299|读荷载的循环在下一段文字前停下，不再解密|`options.signal?.throwIfAborted();`
CLAIM|52|一致|apps/agent-service/src/production-data-export.ts:274|之后生成即使结束也不会把状态改回 `ready`|`if (job.state !== "running") return;`
CLAIM|53|一致|apps/agent-service/src/production-data-export.ts:524|已生成的取消：结果立即作废，下载口返回 404|`if (view.state !== "ready" || !view.built) return reply.code(404).send();`
CLAIM|54|一致|apps/agent-service/src/production-data-export.ts:304|重发取消返回 `replayed`|`if (job.state === "cancelled") return { exportId, replayed: true };`
CLAIM|55|一致|packages/platform-node/src/http-gateway-server.ts:888|取消不认识或已过期的编号返回 404|`? 404`
CLAIM|56|一致|packages/platform-node/src/http-gateway-server.ts:891|取消已失败的返回冲突（409）|`: 409;`
CLAIM|57|一致|apps/agent-service/src/production-data-export.ts:251|取消之后可以马上重新开始（前一次还在收尾的那几毫秒里开始会得到 `DATA_EXPORT_BUSY`）|`if (this.#building) throw new Error(DATA_EXPORT_BUSY);`
CLAIM|58|一致|packages/gateway-contracts/src/contracts-v2.ts:812|取消不要求最近验证身份|`payload: object({ exportId: dataExportIdSchema }),`
CLAIM|59|一致|.claude/rules/owner-standing-rules.md:33|依据是本项目的长期规则“界面上给 Andy 看的每个数字……都要有可以验证的定义和门槛，没有就不显示”|`界面上给 Andy 看的每个数字和判断词（例如“找到 3 条相关记忆”“命中”“推荐”“成功 N 条”）都要有可以验证的定义和门槛，没有就不显示（起因是界面上“找到 3 条相关记忆”永远凑满 3 条）。`
CLAIM|60|一致|075dd4a6|PR 393 早已合并|`075dd4a6 Merge pull request #393 from sixianli/claude/project-thread-zh3mvt`
CLAIM|61|一致|apps/agent-service/src/production-data-export.ts:43|512 MiB 的上限仍在，对话部分另有 128 MiB 荷载上限|`const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;`
CLAIM|62|一致|apps/agent-service/src/production-data-export.ts:386|网页记忆页的“导出”现在也带对话|`{ root: DATA_EXPORT_CONVERSATIONS_ROOT, files: conversations.files },`
CLAIM|63|找不到|-|耗时和内存是两者之和|-
CLAIM|64|一致|test/integration/data-export-http.test.ts:801|对话荷载超过 128 MiB 的库，网页上的这个导出会失败（返回 413）|`expect(direct.statusCode).toBe(413);`
CLAIM|65|一致|apps/admin-cli/src/data-command.ts:270|只能用命令行分别导出|`if (action === "export-chats") {`
CLAIM|66|一致|test/integration/data-export-http.test.ts:637|`test/integration/data-export-http.test.ts` 里带 `[iOS]` 的用例|`it("[iOS] 导出全部数据也带对话：结果给对话和消息个数，和包里对话部分的清单一致", async () => {`
CLAIM|67|一致|test/integration/data-export-http.test.ts:654|覆盖包里两个文件夹各自校验通过|`const chats = verifyChatExport(conversations, side.migrationSequence);`
CLAIM|68|一致|test/integration/data-export-http.test.ts:659|对话和消息个数等于对话清单|`expect(ready.result.conversations).toBe(chats.counts.threads);`
CLAIM|69|一致|test/integration/data-export-http.test.ts:689|进度先记忆后对话且已读数是真实计数|`expect(running.progress.stage).toBe("conversations");`
CLAIM|70|一致|test/integration/data-export-http.test.ts:745|生成中取消后不再解密且不会变回 `ready`|`expect(paused.calls()).toBe(callsAtCancel);`
CLAIM|71|一致|test/integration/data-export-http.test.ts:807|打包快结束时取消|`it("[iOS] 打包快结束时取消，生成完的结果也不会把状态改回 ready", async () => {`
CLAIM|72|一致|test/integration/data-export-http.test.ts:765|已生成的取消后下载 404|`expect(dropped.statusCode).toBe(404);`
CLAIM|73|一致|test/integration/data-export-http.test.ts:781|取消不认识的编号 404|`await expect(cancel("data-export:AAAAAAAAAAAAAAAAAAAAAA")).rejects.toMatchObject({`
CLAIM|74|一致|test/integration/data-export-http.test.ts:786|取消已失败的冲突|`await expect(cancel(failed)).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });`
CLAIM|75|一致|test/integration/data-export-http.test.ts:797|对话超过上限整份失败且网页 413|`failureCode: "CHAT_EXPORT_TOO_LARGE",`
CLAIM|76|一致|packages/gateway-contracts/test/data-export-gateway.contract.test.ts:59|`packages/gateway-contracts/test/data-export-gateway.contract.test.ts` 覆盖进度和取消的契约正反用例|`it("accepts real progress while running: a section not started yet has no total", () => {`
CLAIM|77|一致|docs/adr/0235-chat-history-export.md:78|ADR 0235 的“放弃的做法”第 1 条原文不改，在那里加了指向本文的说明|`- 后续：本条已被 [ADR 0263](0263-export-everything-in-one-job-with-progress-and-cancel.md) 部分取代：“导出全部数据”在一个任务里同时生成记忆和对话，压缩包里两个文件夹并列，各自的格式和清单不变。本条原文不改。`

仓库是稀疏检出（65%），iOS 客户端与设计线程原话不在工作区，相关 4 条标为找不到；性能上的“耗时和内存是两者之和”没有读到实测数据，也标为找不到。Google Takeout 等外部网站按规则未核对。
