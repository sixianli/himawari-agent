# 复核报告：PR 444（感知记录、上传凭据、用量上限，iOS 第 3 批服务器部分）

## 侧重检查（我走过的流程）

我从两条最普通的使用流程各走了一遍：

**流程 A：设备直传一批感知记录（POST /api/device/v1/perception，签名路径）**
`registerDeviceApiRoutes` 的 onRequest 钩子做路由白名单校验（device-api-routes.ts:364 区域）→ 无凭据头 → `authenticate` 签名认证 → `perception().ingest()`（perception-service.ts）→ `#parseRecord` 逐条校验（形状、id 正则、类型白名单、时间上限+时钟偏移、confidence、text 依据类型定义 required/none/optional、speaker 仅限 hearing、evidence 按 `validatePerceptionFields` 白名单字段）→ 批量上限 `device.perception.batch_records` 413 → 关掉感官/暂停窗口判 `sense_off`/`paused` → `knownRecordIds` 去重 → `protectText`（payload admission，幂等键取自记录 id 摘要）→ `store.ingestRecords`（单事务：已知 id 判 duplicate → 按 lowValue/时间/id 排序 → `used()` 查当日已用量 → 逐条 `insertRecord`+`assignEpisode`+回填同窗口无主记录 → `recount` → `reserve()` 单条 SQL 占用）→ `#afterWrite`（warned_at 一次性告警 + 节流的 prune）。
这条路径上：解析、去重、上限、episode 合并、删除后计数（`setRecordStatus`→`recount`）、乱序到达（按 occurredAtMs 排序插入）都有集成测试覆盖（perception-records.test.ts、usage-limits.test.ts）。**未覆盖**：跨天 episode（见问题 5）、`protectText` 被拒/失败时 ingest 的失败路径（测试夹具如何接线未核实）。

**流程 B：后台上传（POST /uploads/begin → 凭据 → POST /perception|/track|/perception/media）**
`uploads/begin` 校验 purpose/sha256/bytes≤`device.upload.file_bytes`/id 区间或 batchId/媒体类型 → 建凭据（token 随机、库存 hash）→ 目标路由 onRequest 钩子在读正文**之前** `authorizeUpload`（存在→用途匹配路径→已用则 replay→过期 401），并 `authenticateStored(grant.deviceId)`；吊销时 revoke 语句直接 `DELETE FROM device_upload_grants`（sqlite-durable-operations.ts revoke 处），所以吊销后凭据失效 → `bodyLimit(request)` 切换为 grant.bytes，preParsing Transform 按字节截断 → 自定义 content parser 对上传请求直通流 → `receiveUpload`：replay 则丢弃正文返回首次结果；否则流式写临时文件（`flags:"wx"`）并算 sha256 → `consumeUpload`：`#consuming` 防并发、复查凭据、核对 bytes+sha256（422）、gzip 解流按 `device.upload.expanded_bytes` 封顶（#lines）、行数按 batch 上限 → perception/track 复用 ingest/track（含 idRange 区间校验）、media 按 `media:<sha256>` 记账并占用 `perception.media.daily_bytes`/`perception.server_asr.daily` → `completeUploadGrant` 写 result（`WHERE used_at IS NULL`，单条）→ finally `rm` 临时文件。
反向用例测试齐全且都会真实失败：摘要不符 422、超 grant 字节 413、错误路径 403、未知凭据 401、过期 401、吊销后 401、batch 复用 409、gzip 炸弹 413 且 incoming 目录为空、id 区间外 400（device-upload.test.ts）。

结论：两条流程的主干和反向分支都有测试覆盖；主要薄弱点是跨天 episode、真并发、超大单行/大文件（见下）。

## 发现的问题（按严重度从高到低）

1. **中等** · packages/platform-node/src/perception-service.ts（`#lines` 的 `take`）· **读代码证实**：`#lines` 按累计解压字节封顶（`device.upload.expanded_bytes`，默认 500MB）和行数封顶，但**对单行没有字节上限**。一行最大可到整个解压上限，然后整行交给 `JSON.parse`——一条 500MB 的行会被整体读入内存并解析（V8 字符串+对象放大），这是设备完全可控的输入。证据：`take(part)` 直接 `JSON.parse(line)`，循环里只有 `bytes > cap` 与 `lines.length >= maximumLines` 两个上限。**建议**：在 push 前限制单行字节数（例如 ≤1MB），超限按 413 拒绝；补一条“单行超长”反向测试。

2. **中等（推测，未核实）** · packages/platform-node/src/device-api-routes.ts（`route.bodyLimit` 钩子与 preParsing）· **推测**：onRoute 钩子把路由 bodyLimit 固定为 `DEVICE_HARD_LIMITS["device.request.body_bytes"].maximum`（16MiB），而凭据的 bytes 上限是 `device.upload.file_bytes`（默认 200MiB）。应用层 preParsing 按 grant.bytes 截断没问题，但**如果 Fastify 对自定义流式 parser 也执行路由级 bodyLimit**，超过 16MiB 的上传会被 Fastify 本身拒掉，与 200MiB 的默认文件上限矛盾。我未能读到已安装的 fastify 源码确认其行为，且本 PR 没有任何 >16MiB 的上传测试。**建议**：为上传路由把 bodyLimit 设为当次 grant.bytes（或至少 device.upload.file_bytes），并补一条大文件（>16MiB）真盘上传测试。

3. **低** · packages/persistence-sqlite/src/sqlite-perception-operations.ts（`op_recordMedia`）+ perception-service.ts（`id: \`media:${grant.sha256}\``）· **读代码证实**：媒体条目 id 只由内容摘要构成，是全局唯一主键，而所有查询（listMedia、usage）都按 owner/agent 过滤。若两个 owner 上传字节完全相同的媒体，第二个 owner 会在 `SELECT 1 FROM perception_media_items WHERE id = ?` 命中别人的行而被判 `duplicate:true`，自己的媒体静默不记账。当前单 owner 产品下影响极小，但产生端（全局 sha256 主键）与使用端（owner 过滤）语义不一致。**建议**：id 里并入 owner/agent 前缀，或 id 查询带 owner 条件。

4. **低** · packages/platform-node/src/perception-service.ts（`consumeUpload`）· **读代码证实**：过期检查只发生在 onRequest 阶段的 `authorizeUpload`；`consumeUpload` 里复查凭据时只查 `again.result !== null`，**不再查 expires_at**。一个在授权瞬间仍有效、但写入临时文件期间过期的凭据仍会被消费并写回结果。窗口很小且凭据单次有效，实际风险低。**建议**：consumeUpload 复查时一并校验过期（replay 除外）。

5. **低** · packages/persistence-sqlite/src/sqlite-perception-operations.ts（`dayRows`、`assignEpisode`）· **读代码证实**：episode 的 local_day 只在记录把 episode **向前**扩展时更新（`CASE WHEN ? < started_at_ms`）；午夜后到达的记录把 episode 扩到次日时，episode 仍记在前一天，而 day 列表的记录分支只取 `episode_id IS NULL` 的记录——于是这条发生在次日的记录在次日的列表里**完全不出现**（它藏在挂在前一天的 episode 里）。删除/乱序/静默切分的计数一致性有测试，跨天没有。**建议**：要么 episode 跨午夜时按天拆分展示，要么明确接受“episode 归属其开始日”并在文档写明；补一条午夜跨越测试。

6. **低** · packages/application/src/ports/usage-limits.ts（`perception.model_cost.daily`）· **读代码证实**：该键被定义、`adjustable: true`、出现在设备 config（`usageLimits`）和用量快照里，但全仓库**没有任何执行点**消费它（本 PR 里感知无模型调用；ingest/track/media/server_asr 各自用了自己的键）。也就是说“产生端”（定义、可调整、写 override、写 limit_change 决定）存在而“使用端”（真正限制什么）缺失——owner 改了它没有任何效果。这正是 I-73 类“只看改动本身”要抓的断点。**建议**：在 PR 描述/待办里明确它是给后续感知模型调用预留的，或暂时把它标为不可调。

7. **低** · packages/persistence-sqlite/src/sqlite-perception-operations.ts（`assignEpisode`）· **读代码证实**：新锚点在候选 episode 里只并入**距离最近的第一个**就返回；若两段既有 episode 都落在 silence 半径内，它们不会被这次到达合并成一段（记录数分布与“一次对话”语义可能有出入）。**推测**这是有意简化；无测试覆盖此场景。**建议**：确认设计意图并加一条双候选测试。

8. **信息** · test/integration/usage-limits.test.ts（"never lets concurrent reservations pass the limit"）· **读代码证实**：`Promise.all` 40 个 `reserveUsage` 在 better-sqlite3 的同步驱动上会被串行化，并非真正跨连接并发；不过 `reserve()` 确实是**单条原子 SQL**（`INSERT ... SELECT ... ON CONFLICT ... DO UPDATE ... WHERE limit_usage.used + excluded.used <= @limit`），检查与占用同语句，并发越限在存储层不成立。测试名夸大了它证明的东西。**建议**：改名或补一条真并发（两个连接/WAL 下）用例。

9. **信息** · packages/persistence-sqlite/src/migrations/0095_perception_records.sql · **读代码证实**：重建是完整的——drop 顺序满足外键拓扑（先 7 张子表再 decision_ledger）；`decision_ledger_push_source_key`、`decision_ledger_time_index`、payloads ref 索引、prereviews 4 个索引、signals/muse/source_insights 索引与既有迁移（0087/0088/0089/0091）逐一对应；`decision_prereviews_*`、`decision_signals_*` 四个不可变触发器都重建；全库 grep 确认除重建集合和新表 perception_suggestions 外没有别的表引用这批表。**未核实**：迁移引擎执行时的 pragma/事务包装（migration-engine.ts 的 diff 未读），以及"原有行不丢"是否有端到端断言（migration contract 测试的 diff 未读，只核对了 INSERT 列清单齐全，含 0076 加的 received_at、0073 加的 paired_message_id、push_class）。

## 作者说法逐条核对

1. **属实**：新表恰好 9 张（perception_settings、perception_episodes、perception_records、device_mirror_items、location_track_points、perception_suggestions、device_upload_grants、perception_media_items、limit_usage）；重建 decision_ledger 及其 7 张引用表；kind CHECK 由 0069 的 7 种扩为 9 种，新增的正是 limit_change、delivery_timing。迁移号占位未改——作者自己承认，需在合并前处理。
2. **属实**：见问题 8 的证据；并发“不会一起越过上限”成立，但测试并非真并发。
3. **属实**：五种拒绝路径全部读到对应代码且有会失败的反向测试；临时文件在 pipeline 失败（`catch → rm`）和 consumeUpload 的 `finally → rm` 双保险清理，replay 分支不落盘，测试断言 incoming 目录为空。
4. **属实**：diff 未触碰任何 prompt/工具/历史文件；grep 全仓库无任何模型路径读取感知记录；daily-review.ts 显式跳过 limit_change/delivery_timing 两种新 kind，避免它们渗入会喂给评审的内容。
5. **基本属实，有一处措辞差异**：命令侧确为 owner-only（controlPlane delegate 校验 `authentication.ownerId === ownerId` 且 subjectId 匹配 actor，`ProductionPerceptionControl.execute` 再校验 `actorType === "owner"`，非 owner 用例会抛 NOT_AUTHORITATIVE）；expectedRevision 冲突抛 PORT_CONFLICT（有测试）；改上限写 limit_change 决定（且 from===to 不写，有测试）。但 **query** 侧（status/day/episode/usage/suggestions 五个读）在 `ProductionPerceptionControl.query` 里**不校验 actor**，依赖网关层“登录身份必须等于配置 owner”+access.authorize——与既有 device.* 读一致，效果上仍是只有 owner 会话能查，但不是“每个操作里都有 owner 校验”。
6. **属实**：7 个新导出文件（schemas/snapshot/verify/manifest 全接线）；device_upload_grants 与 perception_media_items 不进快照，排除清单里有对应条目；import 用 `EMPTY_PERCEPTION_COUNTS`，不恢复。
7. **属实**：ci/operations-pending.json 新增恰好 7 条 perception.*。
8. **属实**：没有任何删除感知记录的 API；`setRecordStatus` 只是内部端口（测试用它模拟删除）。

## 必答问题

1. **会不会改变模型见过的请求开头？** 不会。本次 diff 没有触碰系统提示、工具定义、历史消息或任何遮盖结果；新数据（感知记录、镜像、轨迹、凭据）没有任何被模型调用读取的路径（grep 证实）；唯一的横切数据（decision_ledger 新 kind）在 daily-review 里被显式跳过。发给模型的内容在本 PR 中保持原样，“只在末尾追加”的约束没有被触碰。
2. **同一段文字会不会在不同请求里变成不同字节？** 没有发现。检查过的所有生成值都是确定的：episode id = 记录 id 的 sha256 截断；limit_change 决定 id = owner/agent/key/revision 的摘要；media id = sha256；导出行来自带 ORDER BY 的查询；`reached` 排序、disabledSenses 按 PERCEPTION_SENSES 顺序过滤、suggestion 列表按 created_at/id 排序。随机值（凭据 token、临时文件名）不进入任何语义路径。快照里的 `generatedAt` 是响应级时间字段，不是稳定内容的一部分。
3. **有没有自动检查、反向用例会不会真失败？** 有且大多会真失败：批量超限 413、上限触顶 limit_reached/次日恢复、值域拒绝（PERCEPTION_SETTINGS_INVALID）、stale revision PORT_CONFLICT、非 owner NOT_AUTHORITATIVE、摘要不符 422、gzip 炸弹 413+目录为空、吊销/过期/未知凭据 401、batch 复用 409、id 区间外 400、配置解析越界抛错（startup-configuration 单测）、limit_change 决定内容断言。薄弱处：并发用例非真并发（问题 8）；无 >16MiB 上传测试（问题 2，未核实是否会失败）；无跨天 episode 测试（问题 5）。
4. **每个新值/新键的产生端和使用端都核对了吗？** 逐对核对结果：kind 'limit_change'/'delivery_timing'（SQL CHECK ↔ DECISION_KINDS ↔ validateLedgerWrite ↔ insertLedgerRow ↔ 导出 schema ↔ daily-review 跳过）一致；10 个用量键的产生端（USAGE_LIMITS）与执行端一一对应，**例外是 perception.model_cost.daily 有定义无消费**（问题 6）；记录类型/感官名/建议动作与状态机/凭据 purpose/mediaKind/各种 id 正则，产生端（perception.ts 常量）与使用端（SQL CHECK 长度或前缀、路由表、网关 schema）一致，其中媒体 id 的 owner 语义不一致见问题 3；`device.upload.*` 等硬上限键在基线已存在（device-limits.ts），本 PR 只是接线，两端值域一致。发现的不一致均已列为问题 3、6。

**未核实项汇总**：fastify 对自定义流式 parser 的 bodyLimit 行为（问题 2）；迁移引擎的 pragma/事务包装与迁移数据保留的端到端断言；`.claude/rules/prompt-prefix.md`、`docs/incidents-and-gates.md`（I-73）、ADR 0230 的文档现状是否与代码一致；data-export-perception.test.ts、device-mirror.test.ts 主体、gateway-contracts 中 7 个 perception 消息的 payload schema 细节、service-main.ts / http-gateway-server.ts / schema-catalog.ts 的小段 diff。
