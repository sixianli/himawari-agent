## 侧重检查

- 错误路径：计划过期/未知计划、未知设备/未知 episode、非法日期、payload 删除失败、原始文件 `rm` 失败、启动续做失败、`remaining` 非空时的续做循环。结论见下面第 1、3、5、7 条。
- 不可信输入：`kind/ids/types/episodeId/day/deviceId`、`planId`、`uploads/begin.recordIds`、`GET perception/deletions?after=`。大部分形状、数量、格式都校验了；缺口见第 4、7 条。
- 安全/越权：删除 SQL 基本都带 `owner_id/agent_id`；但媒体关联和媒体删除缺少设备/存在性校验，见第 4 条；`plan` 是 query 层却写库，见第 8 条。
- 资源耗尽：计划行、删除范围行都没有清理；每次 ingest 都扫描该 owner 的全部删除范围，见第 8 条；分页只返回 200 行，见第 6 条。
- 不可撤销操作：记录是硬删除，payload 分块删，原始文件在事务外删；失败可能被吞掉或留下孤儿文件，见第 3 条；删除还可能被重传“复活”，见第 2 条。
- 规则/文档一致性：改动不触及 prompt 组装；作者“按服务器收到时间固定范围”的说法对 episode 和轨迹点不成立，见第 1 条；`ci/operations-pending.json` 的描述是复制来的，见第 10 条。
- 未核实：iPhone 客户端行为（不在本仓库/本 PR 范围）；多进程共享 SQLite 时第 5 条是否可达；生产实际时钟偏差。

### 1. 高：按 episode 删除不受计划时刻限制，会删掉计划之后收到的记录（轨迹点同理）

文件:行：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1166-1171`、`:1172-1186`、`:1197-1201`、`:1281`、`:1327`

问题：作者说“计划按服务器收到时间固定范围（`received_at_ms <= 计划时刻`）”，但 episode 分支完全没有 `received_at_ms <= @bound`；轨迹点用的是 `occurred_at_ms <= @bound`，不是收到时间。`planDeletion` 和 `startDeletion` 都重新调用同一个函数，因此计划预览之后、启动删除之前新进来的记录也会被删，receipt 与 plan 不一致。

证据：

```ts
case "episode":
  return rows(
    `SELECT id FROM perception_records
      WHERE owner_id = @ownerId AND agent_id = @agentId AND episode_id = @episode ORDER BY id`,
    { episode: target.episodeId },
  );
...
return `owner_id = @ownerId AND agent_id = @agentId AND occurred_at_ms <= @bound
  ...
```

现有测试只对 `day` 类型验证了“计划后数据不删”（`test/integration/perception-deletion.test.ts:223-245`），没有 episode/轨迹点的反向用例。具体可复现：计划时某 episode 有 2 条，计划后同一 episode 再进 1 条，执行删除会删 3 条。

建议：episode 分支加 `received_at_ms <= @bound`；轨迹点要么在计划时固定要删的点（主键集合），要么增加收到时间列；补 episode 和晚到轨迹点的反向测试。

### 2. 高/中：按天/类型删除按 `received_at` 选记录，但抑制按 `occurred_at` 判断，删除可被重传复活

文件:行：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1172-1186`、`:1081-1087`、`:1127-1135`、`:1378`；`packages/platform-node/src/perception-service.ts:389-392`

问题：`day/types` 删除用 `received_at_ms <= bound`；删除范围只对 `records/episode` 保存 `record_ids`（`:1378`），`day/types` 保存空数组。抑制旧记录时却用 `bound_ms >= occurred_at_ms`。设备时间最多可比服务器快 `signatureToleranceSeconds`（默认 60 秒，`perception-service.ts:390`），所以存在 `received_at <= bound < occurred_at` 的记录：它会被删除，但重传时 `occurred_at > bound`，不会被 `suppressed_by_deletion` 拦下，于是又被存回。删除因此不是持久的。

证据：

```ts
// 删除范围
AND received_at_ms <= @bound
// 抑制范围
WHERE owner_id = ? AND agent_id = ? AND bound_ms >= ?
...
if (row.kind === "day" && row.day === record.localDay) return true;
```

测试 `perception-deletion.test.ts:247-278` 只覆盖了 `occurred_at <= bound` 的旧记录。

建议：对所有删除范围都保存被删记录 id，抑制时优先按 id 判断；或者让删除和抑制使用同一时间谓词。补“`occurred_at > bound` 但在允许偏差内”的重传反向用例。

### 3. 中：payload 删除失败被静默吞掉，`verified` 回执可能不真实；文件删除在事务之外

文件:行：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1424-1430`、`:1432-1444`；`packages/platform-node/src/perception-service.ts:736-750`

问题：`cleanDeletion` 对每条 ref 的 `DELETE FROM payloads` 用了 `catch { continue; }`，无论失败原因是什么，该 ref 都不会留在 `rest` 里；随后把 `pending_refs` 更新为 `rest`，`remaining` 为 0 时直接标成 `verified`。这样数据库里的密文可能仍在，但回执显示删完了。文件 `rm` 发生在数据库事务提交、`pending_refs` 已前移之后；`rm` 抛错或进程崩溃后，重试不会再拿到这个路径，文件会永久留在磁盘上。

证据：

```ts
try {
  this.database.prepare("DELETE FROM payloads WHERE ref = ?").run(ref);
  if (payload.path) paths.push(payload.path);
} catch {
  continue;
}
...
this.database.prepare(
  "UPDATE perception_deletions SET pending_refs = ?, attempts = attempts + 1 WHERE id = ?",
).run(JSON.stringify(rest), input.id);
```

建议：只有删除成功才从 pending 移除；记录失败原因并保留 ref 以便重试/告警；不要用 `attempts` 只计数不设上限；把待删文件路径持久化，删除文件也要可重试，确认成功后再标 `verified`。补 DELETE/rm 失败的反向用例。

### 4. 中：媒体关联跨设备复用且 `recordIds` 不校验归属，可能删掉另一台设备仍在使用的原始文件

文件:行：`packages/platform-node/src/perception-service.ts:987-995`、`:1193-1201`；`packages/persistence-sqlite/src/sqlite-perception-operations.ts:900-918`、`:1217-1232`、`:1351-1356`；`packages/persistence-sqlite/src/migrations/20261114151212_perception_records.sql:161-172`

问题：媒体 id 是全局 `media:<sha256>`。设备 B 上传与设备 A 相同字节的文件时，`recordMedia` 按 `owner+agent` 判重，会走 duplicate 分支，并把 B 的 `recordIds` 链到 A 已有的 media item 上。若 A 的原始上传没有 `recordIds`（本 PR 之前的所有媒体、以及尚未接 `recordIds` 的客户端），A 的记录就没有 link；之后删除 B 的记录，`deletionMedia` 认为没有其他存活记录使用它，就会删除这个 media item，`#sweepMedia` 再删掉文件——A 的媒体也被删了。`uploads/begin` 只校验 `recordIds` 格式/数量/去重，不校验记录是否存在、是否属于该设备。

证据：

```ts
// recordIds 只做格式和数量校验
!linked.every((id) => typeof id === "string" && PERCEPTION_RECORD_ID_PATTERN.test(id)) ||
new Set(linked).size !== linked.length
...
// duplicate 分支
if (this.database.prepare(
  "SELECT 1 FROM perception_media_items WHERE id = ? AND owner_id = ? AND agent_id = ?",
).get(input.item.id, input.ownerId, input.agentId)) {
  link();
  return ...duplicate: true...
}
```

现有测试只验证同一设备两条记录共享媒体（`perception-deletion.test.ts:280-320`），没有跨设备共享。

建议：`recordIds` 校验存在性和 `deviceId` 归属；媒体链接/删除判定按设备区分；`NOT EXISTS` 子查询补 `owner_id/agent_id`（最好也补 `device_id`）；跨设备相同内容不要只靠一个全局 media id 复用。

### 5. 中（可达性为推测）：`remaining` 非空时仍返回 `progressed: true`，续做可能死循环并卡住启动

文件:行：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1437-1449`；`packages/platform-node/src/perception-service.ts:735-758`；`apps/agent-service/src/production-http-composition.ts:1336`

问题：`cleanDeletion` 只检查 `remaining`，从不再次删除 `remaining`；但当 `rest.length === 0` 时 `progressed` 仍为 `true`。`#finishDeletion` 在 `status === running && progressed` 时无条件 `for (;;)`；`resumeDeletions` 又在启动时逐个 await。一旦有记录逃过 start 删除（多进程写者、系统时钟回拨导致新记录 `received_at <= bound` 等），状态永远无法变 `verified`，删除命令不返回，启动续做也可能永远不返回。单进程内 store 调用是同步事务，正常路径下不易触发，所以我把可达性标为推测。

证据：

```ts
if (rest.length === 0) {
  const remaining = this.deletionRecordIds(input, deletion.target, deletion.boundMs);
  if (remaining.length === 0)
    this.database.prepare("UPDATE ... status = 'verified' ...").run(now, input.id);
}
...
progressed: take.length > 0 || rest.length === 0,
```

建议：`remaining.length > 0` 时要么重新执行删除，要么进入可观测的失败/阻塞状态并停止循环；`progressed` 不应在仍有 remaining 时为 true；给续做加尝试次数/时间上限。补“pending 已空但 remaining 非空”的用例。

### 6. 中/低：删除 feed 的 `revision` 是全局最大值而不是本页最后一条，分页可能跳条

文件:行：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1464-1505`（`LIMIT` 在 `:1470`，`MAX(revision)` 在 `:1482-1488`）；`packages/platform-node/src/device-api-routes.ts:646-674`

问题：查询按 `revision > after ORDER BY revision LIMIT 200` 返回一页，但响应里的 `revision` 是该 owner 的最大 revision。范围超过 200 条时，客户端若把响应 `revision` 当下一页 `after`，会跳过中间未返回的 scope。测试 `perception-deletion.test.ts:386-390` 用的是 `body.scopes[0].revision`，所以没覆盖这种误用；iPhone 客户端还没实现，实际影响属推测。

证据：

```ts
WHERE owner_id = ? AND agent_id = ? AND revision > ? ORDER BY revision LIMIT ?
...
const revision = (SELECT MAX(revision) FROM perception_deletion_scopes WHERE ...)
```

建议：响应区分 `nextAfter`（本页最后一条 revision）和 `revision`（当前最大），或者让 `revision` 明确只能用于“是否有新数据”；补超过一页的分页测试。

### 7. 低：形如 `2026-02-30` 的日期会抛 `RangeError`（500）而不是参数错误（400）

文件:行：`packages/platform-node/src/perception-service.ts:667-673`；测试 `test/integration/perception-deletion.test.ts:204`

问题：`DAY_PATTERN` 只检查数字形状，`new Date(\`${target.day}T00:00:00.000Z\`).toISOString()` 对 `2026-13-40`、`2026-02-30` 这类值会得到 Invalid Date，`toISOString()` 抛 `RangeError`。测试只断言 `rejects.toThrow()`，所以即使错误类型不是 `INVALID_OPERATION` 也能通过；网关层可能把它当内部错误。

证据：

```ts
!DAY_PATTERN.test(target.day ?? "") ||
new Date(`${target.day}T00:00:00.000Z`).toISOString().slice(0, 10) !== target.day
```

建议：先 `const parsed = Date.parse(...)`，`Number.isFinite(parsed)` 不成立就走 `#deletionInvalid("day")`；测试断言错误码。

### 8. 低：`perception.deletion.plan` 是 query 层却写数据库，过期计划/删除范围没有清理上限

文件:行：`packages/gateway-contracts/src/client-capabilities.ts:157-159`；`packages/persistence-sqlite/src/sqlite-perception-operations.ts:1297-1311`、`:1454-1461`、`:1079-1086`

问题：`plan` 注册为 read/query，但会 `INSERT INTO perception_deletions`。`openDeletions` 只捞 `running`，过期的 `planned` 行和已完成的删除行/scope 行没有删除路径；`scopeMatch` 每次 ingest 都查该 owner 的全部 scope 且只按 `owner/agent` 过滤。长期使用后表和每次 ingest 的开销都会单调增长；读权限调用方也能持续制造计划行。

建议：把 plan 明确归为 change 写入，或把临时计划与正式删除范围分开并定期清理；给每个 owner 的未完成计划设上限；给 scope 的匹配查询加更合适的索引/保留策略。

### 9. 低：轨迹点被删除范围抑制时计入 `duplicates`，与记录路径的 `suppressed_by_deletion` 语义不一致

文件:行：`packages/persistence-sqlite/src/sqlite-perception-operations.ts:784-787`

问题：记录上传有专门的 `suppressed_by_deletion` outcome；轨迹点被同一删除范围拦下时只增加 `duplicates`。设备端无法区分“本来就有”和“因为删除被拒绝”，日志/重试语义也不同。设备上传响应结构本身接受这个值（只有计数），所以不是崩溃问题。

建议：如果设备端需要知道，给 track 结果也加一个明确的 suppressed 计数；否则在文档/测试里写清这是有意的。

### 10. 低：`ci/operations-pending.json` 的三个新描述是复制来的，与 PR 说明不一致

文件:行：`ci/operations-pending.json:28-30`

问题：三条描述都写“iOS 第 3 批已实现后端和测试……iPhone 页面接上后移出名单”，但本 PR 明确“iPhone 客户端”在范围外；这些是删除操作，不属于“感知到的/用量页”那批。规则文件/说明与代码不一致，会误导后续判断“谁还缺调用方”。

建议：按实际状态改写三条描述（后端已安装、无客户端调用方、计划中的批次）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本改动只落在持久化、设备 API、网关 v2 和 agent-service 控制层；没有修改 `packages/prompt-catalog`、上下文组装、工具定义或历史存储。删除只影响未来从库里选出的感知内容；即使被选进上下文，也只会出现在最后一条用户消息（本轮资料）里，不属于请求头，也不会改写已存历史。`prompt-prefix.md` 的“只追加”规则没有被触碰。结论：发给模型的内容仍然只在末尾追加，本改动没有把每轮变化的值放进系统提示/工具定义/历史。

2. **不会让模型请求里的同一段文字变成不同字节。** 新增的 `created_at/bound_ms/revision/generatedAt` 只出现在 `perception.deletion.snapshot`、设备 config 和 `GET perception/deletions`，不进入模型请求；`ids/types` 在服务层排序，`recordIds` 读取有 `ORDER BY record_id`，删除范围 feed 有 `ORDER BY revision`，都是确定的。删除会让未来上下文的内容（而非同一请求/历史的字节）变化，属于最后一条消息的数据变化，不是请求头变化。

3. **有自动检查，但反向覆盖不完整。** 已有：`test/integration/perception-deletion.test.ts` 覆盖 records/episode/day/types、非法输入、计划 TTL、重传抑制、共享媒体、崩溃续做、feed 分页和 `recordIds` 校验；`test/integration/production-perception-control.test.ts` 覆盖网关查询/命令/owner 校验；还有 composition 操作清单、gateway fixture/schema 等。确实会失败的反向用例：删除后重传（`:247-278`）、共享媒体部分删除（`:280-320`）、非法 `recordIds`（`:400-423`）、过期计划（`:223-245`）、非 owner 命令（`production-perception-control.test.ts:264-313`）。但**没有**覆盖：episode 的 `received_at` 边界、`occurred_at > bound` 的复活、跨设备共享媒体、payload 删除失败/`rm` 失败、`remaining` 非空死循环、feed 超过 200 条、非法日期错误码。因此第 1、2、4、5、6、7 条的问题不会被现有测试抓到。

4. **逐个值核对结论：**
   - 三个操作 id：同时出现在 `PRODUCTION_PERCEPTION_OPERATIONS`、`CLIENT_CAPABILITY_TABLE`、`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、fixture 和 `operations-pending.json`；composition 测试断言了安装列表，网关契约测试会校验 schema，**这条链能对上**。
   - `status`（planned/running/verified）和 `kind`（records/episode/day/types）：application、contracts、SQL CHECK 三处一致。
   - `planId`：服务生成 32 位 hex，DB `length(id) BETWEEN 16 AND 64`，snapshot `machineString`，读/删都用参数绑定；未知计划会返回 null/`NOT_FOUND`，**可用**。
   - `uploads/begin.recordIds`：格式/数量/去重校验和数据库 CHECK 匹配，`readUploadGrant` 读取排序，`recordMedia` 接受；**但没校验存在性、归属设备或删除范围**，见第 4 条；媒体上传本身不抑制已删除记录（作者已说明“原始文件入库拦截不做”）。
   - `suppressed_by_deletion`：已加入 `PerceptionIngestOutcome`/`PerceptionOutcome`，服务端只会聚合成 counts，能接受；轨迹点路径返回 `duplicates`，见第 9 条；iPhone 侧未更新，作者已声明不在范围。
   - `deletionRevision`：契约是 `integer(0)`，设备 config 是自由 JSON，Swift 客户端尚未消费（未核实）；作为分页游标存在第 6 条的歧义。
   - 新表 `perception_deletions/perception_deletion_scopes/perception_media_links/device_upload_grant_records`：都加了 schema-catalog 条目；导出代码没有选择这些表；迁移只包含 `CREATE TABLE/INDEX`，没有 `ALTER/DROP`，**满足只增不减**。
   - 新增配置键 `deletionPlanTtlSeconds/deletionChunk/deletionMaxIds/deletionFeedRows`：都有默认值和范围，`strict-configuration` 按 defaults 的 key 遍历校验，测试夹具也用 defaults，**能接受**。
   - `keptElsewhere`：固定数组，snapshot schema 是 `array(machineString)`，格式可用；“是否完整覆盖 conversation_summaries/backups/model_provider_logs/offline_devices”未核实。
