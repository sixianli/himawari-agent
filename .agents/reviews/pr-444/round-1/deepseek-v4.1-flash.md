## 发现（按严重度）

### 高

**1. [读代码证实] 超出每日记录上限的文字仍会先写进内容存储，上限挡不住磁盘增长**
- 位置：`packages/platform-node/src/perception-service.ts:497-529`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:299-327`
- 问题：服务在调用 `ingestRecords` 之前，先对所有候选记录逐条 `protectText` 生成 `contentRef`；真正的上限判断在 store 里，超限记录只返回 `limit_reached`，不会插入 `perception_records`。于是这些文字成为没有任何行引用的加密 payload。
- 证据：`perception-service.ts:499-508` 在入库前执行 `await this.#options.protectText(...)`；`sqlite-perception-operations.ts:300-309` 对超限记录只 `outcomes.set(record.id, "limit_reached")` 并 `continue`，没有删除 payload；`prune` 也只删记录/轨迹/凭据（`:1050-1086`），没有无引用 payload 的清理。
- 影响：设备每次换新记录 id、发送大量文本，即使全部被 `perception.records.daily` 拒绝，payload 仍持续落盘；每日记录上限不能限制磁盘占用，敏感文本也会长期残留。
- 建议：先由 store 完成准入/预留，再只对已准入记录做保护；或在 `limit_reached` 路径删除对应 payload，并增加无引用 payload 的定期回收；补反向用例证明超限批次不增加 payload。

**2. [读代码证实] 原始媒体文件和 `perception_media_items` 从不清理，吊销设备也不删文件**
- 位置：`packages/platform-node/src/perception-service.ts:586-604`、`packages/platform-node/src/perception-service.ts:950-981`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1050-1086`
- 问题：媒体文件被 `rename` 到 `device-uploads/media/<sha256>` 后，没有任何处理或保留期删除逻辑；`prune` 只清轨迹点、过期周围情境记录和过期上传凭据，不清媒体行或文件。设备吊销时外键级联删除 `perception_media_items` 行，但磁盘文件仍留着。
- 证据：`prune` 的删除语句只有 `location_track_points`、`perception_records`、`device_upload_grants`（`:1053-1084`）；媒体只在 `:979` `rename(upload.file, path.join(this.#media(), grant.sha256))` 写入，之后无 `rm`。导出说明还声称“原始材料处理完就删”（`packages/persistence-sqlite/src/data-export/export.ts:655-659`），与当前代码不符。
- 影响：默认 `perception.media.daily_bytes` 为 2 GiB/天，长期运行会无限增长；设备吊销后原始音视频仍留在磁盘，违反不可撤销操作后的清理预期。
- 建议：为媒体增加处理完成/过期保留期清理，删除文件时按内容哈希做引用计数（跨设备/跨主人同一哈希共用文件时不能误删）；吊销/删除设备时同时清理媒体文件；补反向用例。

### 中

**3. [读代码证实] `perception.images.daily` 从未被占用，图片张数上限实际不生效**
- 位置：`packages/application/src/ports/usage-limits.ts:79-85`、`packages/platform-node/src/perception-service.ts:962-977`
- 问题：媒体上传只预留 `perception.media.daily_bytes` 和音频的 `perception.server_asr.daily`，没有按 `mediaKind === "image" | "screen"` 预留 `perception.images.daily`；该键却出现在用量页、设备配置和可调上限里。
- 证据：`usage-limits.ts:79-85` 定义了 `"perception.images.daily"`；`perception-service.ts:962-977` 的 `reservations` 只有 `perception.media.daily_bytes` 与可选的 `perception.server_asr.daily`。
- 影响：主人以为设置了 500 张/天，实际只受字节数约束；这个值在任何生产路径上都不会增加。
- 建议：图片/屏幕媒体上传时预留图片张数，或在功能上线前从 `USAGE_LIMIT_KEYS`/可调项中移除，避免显示一个不生效的上限；补生产路径用例。

**4. [读代码证实] 去重查询漏了 owner/agent，跨主人可探测甚至吞掉数据**
- 位置：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:213-223`、`:864-869`
- 问题：`knownRecordIds` 只 `WHERE id IN (...)`，传入的 `ownerId/agentId` 完全没用；`recordMedia` 的重复判断也只 `WHERE id = ?`。两个主人使用同一记录 id 或同一媒体摘要时，第二个主人会得到 `duplicate`，不会入库；也可作为跨主人存在性探测。
- 证据：`:218-221`：
  ```sql
  SELECT id FROM perception_records
   WHERE id IN (SELECT value FROM json_each(?))
  ```
  `:866-868`：
  ```sql
  SELECT 1 FROM perception_media_items WHERE id = ?
  ```
- 影响：同一 `sha256` 的媒体在两个主人之间只会有一条 `perception_media_items` 记录，第二个主人的上传被静默丢弃；记录 id 可被用来判断别的 owner 是否已有该记录。
- 建议：两处都加 `owner_id = ? AND agent_id = ?`（媒体 id 若确实要做全局内容寻址，也应至少按 owner 建独立行）；补“两个 owner 使用同一 id/sha”的反向用例。

**5. [读代码证实，跨天规则未在设计文档找到] 一段经历跨主人日时，后一天的列表和 `todayCount` 会漏掉记录**
- 位置：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:436-449`、`:488-493`、`:90-97`
- 问题：锚点记录找同段经历时没有 `local_day` 条件，静默期内的跨午夜语句会并入同一段；`local_day` 只会在新记录更早时改成更早的日期。按天列表对 `types = null` 的查询是“episodes + 没有 episode 的 records”（`:90-97`），已在 episode 里的后一天记录既不单独出现，也不会因为 episode 的 `local_day` 是前一天而出现在后一天。
- 证据：`:440-444` 候选查询只有时间范围和 owner/agent；`:489-490` 只有 `CASE WHEN ? < started_at_ms` 才改 `local_day`；`:94-96` records 条件含 `episode_id IS NULL`。
- 影响：同一段经历里的记录在“感知到的”按天页和 `status.todayCount` 里可能凭空少掉，按天计数与记录不一致。
- 建议：明确跨天策略——要么按主人本地零点切断 episode，要么按天查询时按每条记录自己的 `local_day`/时间范围把 episode 展开；补 23:59/00:01 附近的用例。

**6. [读代码证实] 上传和解压内容整包读入内存，且没有全局/每设备并发上限**
- 位置：`packages/platform-node/src/perception-service.ts:851-894`、`:904-908`、`packages/application/src/ports/device-limits.ts:49-55`
- 问题：`#lines` 把解压后的整个文件逐行 `JSON.parse` 后存进 `lines` 数组，最多可到默认 500 MiB 解压上限；`#consuming` 只按单个 token 防重入，不限制同一设备同时发起多个上传，也不限制临时文件总大小。镜像同步同样只有单批 1000 条限制，没有总量上限。
- 证据：`:857` `const lines: unknown[] = []`，`:866` `lines.push(JSON.parse(line))`；`:904-908` 仅 `this.#consuming.has(grant.tokenHash)`；`device-limits.ts:52` 默认 `524_288_000`。
- 影响：被拿下的已配对设备或恶意客户端可用多个并发上传/长期 delta 镜像把内存或磁盘耗尽；每批限制挡不住累计量。
- 建议：流式逐行处理并限制单行/累计内存，增加每设备上传并发和临时目录配额；镜像增加每 owner/device 的总条数或总字节上限。

**7. [读代码证实] 媒体数据库提交与文件 `rename` 非原子，失败后无法自愈**
- 位置：`packages/platform-node/src/perception-service.ts:950-981`、`packages/persistence-sqlite/src/sqlite-perception-operations.ts:864-901`
- 问题：`recordMedia` 事务先插入 `pending` 行并预留用量，提交后才 `rename` 文件；如果 `rename` 失败（磁盘满、权限、目标异常），临时文件在 `finally` 删除，而媒体行已存在。重试时 `recordMedia` 只按 id 判重，返回 `duplicate: true`，不会再次 `rename`，文件永远缺失。
- 证据：`:950-978` 先 `recordMedia`，`:979` 才 `rename`；`:987` 返回 duplicate 时 `stored` 为 false，`:979` 的 `if (stored.stored)` 不会执行。
- 影响：错误路径会留下“有行、无文件”的 pending 媒体，后续处理会永久失败，且没有对账修复。
- 建议：先把文件放到临时目标并完成原子 rename，再提交数据库；或 `recordMedia` 发现重复行时检查文件存在并补 rename；失败时删除媒体行并回滚预留。

### 低

**8. [读代码证实] 已完成的凭据过期后仍可重放，和“过期会拒绝”的说法不一致**
- 位置：`packages/platform-node/src/perception-service.ts:844-847`
- 证据：`if (grant.result !== null) return ... replay` 发生在 `if (grant.expiresAt <= this.#now().toISOString()) throw ... EXPIRED` 之前。
- 影响：拿到过 token 的人在凭据过期后仍能通过重放拿到第一次的结果（不会写入新数据），直到 `prune` 删除该行；作者说法 3“过期…都会拒绝”不成立，实际是“已成功的重放优先于过期检查”。
- 建议：先检查过期再决定 replay，或明确把“过期后仍可重放已存结果”写进规则；补过期后重放的用例。

**9. [推测，未运行测试] 现有迁移契约测试很可能因 0095 新增 kind 而失败；0095 也没有数据保留反向用例**
- 位置：`packages/persistence-sqlite/test/consolidation-hold-migration.contract.test.ts:42-53`、`:186-188`；`packages/persistence-sqlite/test/migration-engine.contract.test.ts:21`
- 问题：`consolidation-hold` 测试在迁移 88 处取 `before`，应用全部迁移后要求 `dump(database)` 与 `before` 完全相等，而 `dump` 包含 `decision_ledger` 的建表 SQL；0095 把 kind 清单增加了 `'limit_change', 'delivery_timing'`（`0095_perception_records.sql:21-26,64-75`），归一化只去掉 `, 'hold'`，没有去掉新增 kind。按代码看该断言会失败。
- 影响：CI 可能红；即使不红，也没有任何用例证明“0095 重建前后原有 decision_ledger 行、索引、触发器不丢”。
- 建议：更新该测试的期望/归一化，并新增 0095 专项迁移测试：先在 0094 库里种入 decision_ledger、decision_prereviews、source_insights 等行，再应用 0095，核对行数、外键、索引和两个不可变触发器；同时保留一个“删掉新 kind 后测试必须失败”的反向用例。

**10. [读代码证实] 文档、用法清单与实现有若干不一致**
- `docs/execution/specs/2026-11-11-apple-device-body-design.md:566` 把 `perception.read.result` 列为上限键，但 `usage-limits.ts` 没有这个键；
- 同文档 `:715` 列出决策类别 `device_action`，`DECISION_KINDS` 只有 `limit_change`/`delivery_timing`，没有 `device_action`（本 PR 也没有产生者）；
- `export.ts:655-659` 声称“原始材料处理完就删”，但代码没有处理/删除逻辑（见发现 2）。
- 建议：按当前 PR 范围修正文档，或把缺失项标记为后续批次；不要让用量页/导出说明承诺未实现的行为。

## 作者说法核对

- 说法 1（迁移重建不丢行）：从 SQL 结构和旧表 CHECK 对比看，新增 kind 只放宽约束，理论上不丢行；但未被测试覆盖，且现有 `consolidation-hold` 测试很可能因建表 SQL 变化失败。
- 说法 2（检查与占用是单条语句）：不准确。`reserve()` 的 `INSERT ... WHERE used + amount <= limit` 确实是单条语句（`sqlite-perception-operations.ts:244-261`），但 `ingestRecords`、`insertTrackPoints`、`recordMedia` 都先用 `this.used()` 单独 SELECT 算剩余额度，再调用 `reserve`（`:289-327`、`:749-784`、`:870-882`）。在单 connection/事务下不会越过上限，但并发竞争时会以 `PORT_CONFLICT` 失败，而不是原子地按剩余额度部分准入。
- 说法 3（过期、用过、超字节、摘要不符、gzip 超限都拒绝）：过期/摘要/gzip/超字节路径成立；但“用过”实际返回第一次结果（200），且已完成凭据在过期后仍可重放（发现 8）。
- 说法 4（不改任何发给模型的内容）：本 diff 内成立。没有提示词、工具定义、历史或出口遮盖改动；`perception` 只出现在设备接口、网关快照、导出和 daily-review 过滤里。
- 说法 5（7 个操作只有主人能调）：命令路径在 `ProductionPerceptionControl.execute` 检查 `actorType === "owner"` 和 scope；查询路径本身不查 actor，但 `AgentGatewayV2Service.authorize` 在网关层校验认证 owner 与 `message.scope`、`actor.actorId`。在本仓库的网关装配下成立，但 `ProductionPerceptionControl.query` 自己不做 owner 检查，属于依赖调用方，补一条非 owner 查询的反向用例更稳。
- 说法 6（导出 7 个文件、不导出凭据/媒体、导入不恢复）：成立，测试也覆盖了。
- 说法 7（7 个操作记在 `ci/operations-pending.json`）：成立。
- 说法 8（删除感知记录另开 PR）：本 PR 无网关删除操作，成立。

## 侧重检查

- **错误路径**：检查了过期/已用/吊销/错误路径/摘要不符/超字节/解压超限/启动清理临时目录；过期重放和媒体 `rename` 失败后不可自愈是缺陷（发现 7、8）。`prepareDirectories` 会清空 `incoming`（`perception-service.ts:198-203`），临时文件路径基本正确。
- **不可信输入**：逐项核对记录 shape、id/type/captureSource/speaker/evidence、坐标、镜像字段、上限键和保留键；这些入口的枚举/范围校验基本完整。仍有两类信任缺口：跨主人去重未加 scope（发现 4），以及设备自报的 `durationMs`/媒体 `durationMs` 决定音频类上限（代码无法核验真实时长，属于设计上可被低报的边界，未发现服务器端替代校验）。
- **安全/越权**：上传凭据在 `onRequest` 中先校验 token，再用 `authenticateStored(grant.deviceId)` 取设备身份，scope 来自凭据对应设备，不能借 token 写别的 owner；签名在授权上传路径上按设计被 token 取代。导出查询按 owner/agent 限定，`readText` 用本 scope 的 payload store。主要问题是跨主人 dedupe。
- **资源耗尽**：确认媒体文件/行无清理（发现 2）、超限文本先落 payload（发现 1）、`#lines` 整包入内存且无上传并发上限（发现 6）、镜像总量无上限（发现 6）。
- **不可撤销操作**：吊销会删除上传凭据（`sqlite-durable-operations.ts:5039-5045`、`sqlite-paired-device-operations.ts:289-291`），但不会删除已落盘的原始媒体文件（发现 2）。本 PR 没有记录删除 API，作者说法 8 成立。
- **规则文件/文档与代码一致性**：无注释规则未发现新增代码注释；SQLite 工作线程文件只用 `import type` 从 application 导入、本地导入带 `.ts` 后缀（`sqlite-perception-operations.ts:2-23`）。文档与实现的偏差见发现 10。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本 PR 不会。发给模型的内容没有新增系统提示、工具定义、历史或遮盖逻辑；感知记录只进 payload 存储、网页网关快照和导出，未被任何模型调用读取。`daily-review.ts:364` 还明确跳过新增的 `limit_change`/`delivery_timing`，避免后台回顾调用多出新条目。因此仍符合“只在末尾追加、每轮变化值放最后一条消息”；但未来若加入 `perception_read`/感知抽取，需要按设计文档的排序和遮盖规则另做检查，本 PR 未实现、未核实。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求没有影响，因为本 PR 没有把感知文字送进模型。存储/导出层面：`validatePerceptionFields` 按规则表固定键序，列表查询都有明确 `ORDER BY`，导出使用 canonical JSON；但 `protectText` 的 payloadRef 由 `authenticationRef + 记录 id` 决定，同一段文字从不同会话/设备上传会得到不同存储引用和密文（不进入模型前缀）。若将来用于模型抽取，需要遵守文档要求的固定排序和单向遮盖，当前未实现、未核实。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：上传过期/吊销/错误路径/摘要/gzip 超限、记录/镜像/轨迹校验、用量上限与并发预留、设置范围、导出 7 文件和导入不恢复，都有集成测试和若干反向断言。缺口是：跨主人 dedupe、媒体清理、图片上限、跨天 episode 没有反向用例；迁移只更新了序号，没有 0095 数据保留/触发器用例，且 `consolidation-hold` 的完整 SQL 比较很可能失败（发现 9）。另外“用过”的测试断言的是返回第一次结果，不是拒绝。

4. **每个新值的产生端和使用端都接受吗？**
   - 记录类型：服务按 `PERCEPTION_RECORD_TYPES` 校验后写库；数据库只校验长度；导出用 `text(1,64)`；网关 UI 用 `PERCEPTION_RECORD_TYPES[type]`。当前只有服务写入，基本一致；若库中出现未知 type，UI 会抛错，但没有导入恢复路径。
   - 感官名：服务/设置校验 `PERCEPTION_SENSES`，DB 只校验 JSON 数组，导出按数组输出；生产写入路径一致。
   - 上限键：`USAGE_LIMITS` 是唯一来源，`changeSettings`、`usage`、设备配置都按它校验；但 `perception.images.daily` 无占用路径，文档还多出 `perception.read.result`（发现 3、10）。
   - 状态值：记录、建议、用量状态在 DB CHECK、contracts 枚举、应用常量之间一致；`delivery_timing` 只有定义没有产生者，文档提到的 `device_action` 未实现。
   - 标识/格式：记录、episode、suggestion、media id 的 pattern 与 DB 长度/前缀基本一致；上传 batch/摘要格式在 `beginUpload` 校验，DB 只做长度/十六进制约束。
   - 配置键：`parsePerception` 的默认值和范围与 `PERCEPTION_CONFIGURATION_RANGES` 一致；`ownerVoiceQualified` 在生产装配中未传入，因此 `origin` 永远走 `other`，这与文档“门槛未达标前永远不过”的当前阶段一致，不是 bug。
   - 决策新值：`limit_change` 在产生、`validateLedgerWrite`、DB CHECK、导出枚举、网关契约之间一致；`delivery_timing` 暂无产生者，不影响当前运行。

总体结论：核心只追加/上限/凭据绑定思路成立，但合并前至少应处理“超限文本落盘”“媒体永不清理”“跨主人去重”三项高/中风险，并补齐 0095 迁移和上述反向用例；作者说法 2、3 需要按代码修正。
