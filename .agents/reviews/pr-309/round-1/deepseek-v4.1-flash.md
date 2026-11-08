# 复核结论（d911557a vs 01873f5c）

## 一、读代码证实的问题（按严重度）

### 1. 高 — 没真正发出去的推送也会被算成“被忽略”
- 文件:行：`packages/persistence-sqlite/src/proactive-push-backoff.ts:44-52`
- 问题：`countIgnoredPushes` 用 `LEFT JOIN web_push_feedback`，却用 `COALESCE(feedback.first_sent_at, insight.updated_at)` 当发送时间。没有订阅、发送失败等没有 feedback 记录的推送，会退回用 `insight.updated_at`，满 24 小时后就 `ignored += 1`。
- 证据：
  - `proactive-push-backoff.ts:44-52`：`COALESCE(feedback.first_sent_at, insight.updated_at) AS at ... LEFT JOIN web_push_feedback ... AND COALESCE(...) > ?`
  - `packages/persistence-sqlite/src/sqlite-web-push-operations.ts:434-446`：feedback 只在 `if (recorded && input.status === "sent")` 时插入。
  - ADR 0184:66 写的是“被忽略只看网页推送的点开和提醒评价，没有订阅或发送失败的推送不计”，代码正好相反。
  - ADR 0182:45 也明确“排进待发队列但没有订阅或发送失败的不算”。
- 后果：用户从没开通知、或某段时间推送全失败时，系统仍会按“你连续忽略了 N 条”降频甚至暂停；恢复前还会显示从未收到过的提醒数。
- 建议：只统计确有 feedback 行的推送（`feedback.first_sent_at IS NOT NULL`），发送时间一律取 `first_sent_at`；并补一个“无订阅/发送失败不计数”的反向用例。

### 2. 高 — 计数单位是 insight，不是 push；一次合并推送可能被算成 N 次
- 文件:行：`packages/persistence-sqlite/src/proactive-push-backoff.ts:46-55`，`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:857-866`
- 问题：同一推送给多个 insight 写同一个 `push_source_key`，计数 SQL 没有按 `source_key` 去重/分组，同一通知里同一域名的 3 条提醒会被算成 3 次忽略，第一次被忽略就可能直接进第 1 台阶，甚至很快进第 2 台阶。
- 证据：
  - `sqlite-proactive-operations.ts:866`：`for (const id of pushed) setKey.run(\`proactive:${input.push.id}\`, id);`（同一次 push 的所有 insight 共用同一 key）
  - `proactive-push-backoff.ts:46-53`：逐行 `insight` 计数，没有 `GROUP BY insight.push_source_key`。
  - 静默期还会复用 pending push：`proactive-mail-check-service.ts:1250-1253`，跨检查的 insight 也会共用同一个 push id。
- 建议：以 `push_source_key` 为单位聚合（每个 push 只算一次；任一 insight 点开即重置，任一评价“不需要”即算一次），并增加“同一检查里同域名多封邮件”的测试。

### 3. 中 — reset/restore 与进行中的检查存在竞态，恢复可能被覆盖，卡在暂停
- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:979-984`、`1252-1306`；`apps/agent-service/src/production-proactive.ts:205-216`、`417`
- 问题：`previewBackoff` 是独立 read，之后 `#finish` 里还有 `pendingPush`、逐条 `seal` 等 await，最后才在 `store.record` 的事务里写 `applyBackoffWrites`。这期间 `proactive.backoff.restore` 可以执行并把 stage 清 0，随后检查再按旧 preview 写回 stage 2，恢复被覆盖。
- 证据：
  - `proactive-mail-check-service.ts:979`：`const previews = await this.#options.store.previewBackoff(...)`
  - `proactive-mail-check-service.ts:1306`：`const result = await store.record({... backoff: input.backoff ...})`
  - `production-proactive.ts:205-216` 的 `#running` 只串行化 `tick()`；`execute()`（417 行）不参与该锁。
- 建议：把 preview 和写入放进同一个写事务（在 `recordCheck` 内按 `now` 重新计算），或写入时带 `updated_at`/`restored_at` 的 CAS 条件，避免旧 preview 覆盖恢复。

### 4. 中 — 断开 Gmail 时不清降频状态，旧账号的明文域名和台阶残留
- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:443-477`、`479-506`
- 问题：`clearRecords` 会删 `proactive_push_backoff`，但 `removeSource` 只删 `source_insights`、`proactive_processed_messages`、`proactive_connections` 和 pending push，不删降频表。断开后旧域名（明文）和 stage 仍在；重新连接别的账号时，同一域名会被继续降频/暂停。
- 证据：
  - `removeSource` 的删除列表：`sqlite-proactive-operations.ts:450-467`，没有 `proactive_push_backoff`。
  - `clearRecords` 的删除列表：`484-491`，包含 `proactive_push_backoff`。
- 建议：`removeSource` 一并删除该 source 相关的降频状态，或把 class key 绑定到连接/账号版本；同时在 ADR 的数据生命周期里写明。

### 5. 中 — `ignored_count` 产出的值没有上限，表却有 `<= 1000` 校验
- 文件:行：`packages/persistence-sqlite/src/migrations/0081_proactive_push_backoff.sql:17`，`packages/persistence-sqlite/src/proactive-push-backoff.ts:59-63,95`
- 问题：`countIgnoredPushes` 返回的 ignored 没有上限，直接写入 `ignored_count`；超过 1000 时 CHECK 失败，整个 `store.record` 事务回滚，检查会反复失败，推送和决策记录都写不进去。
- 证据：
  - `0081:17`：`ignored_count INTEGER NOT NULL CHECK (ignored_count >= 0 AND ignored_count <= 1000)`
  - `proactive-push-backoff.ts:59-61`：`ignored += 1` 无上限；`95` 行把 `ignored` 放进 preview。
- 建议：写入前 `Math.min(ignored, 1000)`，或把上限与配置/表约束统一；补一个超限用例。

### 6. 低 — 降频原因码可能与 verdict 矛盾，偏离 ADR 的“silent”
- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:955-958`、`878-883`
- 问题：`#reason` 把 `PUSH_BACKED_OFF`/`PUSH_SUPPRESSED` 放在 `verdict === "pushed"` 之前。同一检查里一个类被压、另一个类正常推送时，会记录 `verdict: "pushed"` + `reasonCode: "PUSH_SUPPRESSED"`（或 `PUSH_BACKED_OFF`），而 ADR 0184 第 5 条说被压的检查“结论用已有的 silent”。
- 证据：
  - `proactive-mail-check-service.ts:955-958`：先返回 backoff 原因，再判断 `deferred`/`pushed`。
  - `proactive-mail-check-service.ts:878-883`：`verdict` 由 gating 后的 `counts.pushed` 决定，可为 `pushed`。
- 建议：只在 `verdict` 为 `silent`/`deferred` 时用这两个原因码，或把“本次是否有推送”与“本次是否降频”拆成两个字段。

### 7. 低 — 恢复后的第一条推送因严格 `>` 永远不计入
- 文件:行：`packages/persistence-sqlite/src/proactive-push-backoff.ts:52`、`180-184`
- 问题：恢复把 `since_at` 设为当前时刻，计数条件是 `> since_at`。恢复后同一时刻发出的第一条推送 `first_sent_at == since_at`，以后永远不会被计入被忽略数，实际需要 N+1 次才会再次降频。
- 证据：
  - `proactive-push-backoff.ts:52`：`AND COALESCE(feedback.first_sent_at, insight.updated_at) > ?`
  - `proactive-push-backoff.ts:180`：`SET stage = 0, since_at = ? ...`
- 建议：改为 `>=`，或把 `since_at` 设为 `now - 1ms`；补“恢复后再连续忽略 N 次再次降频”的测试。

### 8. 低 — `source_insights` 登记为 payload_reference，却新增明文域名
- 文件:行：`packages/persistence-sqlite/src/schema-catalog.ts:883-889`，`packages/persistence-sqlite/src/migrations/0081_proactive_push_backoff.sql:1-2`
- 问题：`schemaCatalog` 把 `source_insights` 分类为 `payload_reference`，描述只说“one row per source thread with a result”，但新增的 `push_class` 保存明文发件人域名。分类/说明与代码不一致，隐私审查可能漏掉这处明文。
- 证据：
  - `schema-catalog.ts:884-888`：`"source_insights" ... "payload_reference" ... "one row per source thread with a result"`
  - `0081:1-2`：`ADD COLUMN push_class TEXT ...`
- 建议：更新 catalog 描述/分类（或把域名单独放到已按 metadata_only 登记的表中），并在 ADR 里明确该列是明文元数据及保留期。

### 9. 低 — `senderDomain` 对不可信的 `fromAddress` 没有校验
- 文件:行：`packages/application/src/services/proactive-rules.ts:14-16`，`packages/application/src/services/proactive-mail-check-service.ts:111-113`
- 问题：`senderDomain` 直接取最后一个 `@` 后的整串。若上游解析出的 `fromAddress` 不含 `@`（或包含异常头文本），整串会被当作域名明文存进 `push_class` 并展示；`slice(0,128)` 还可能把不同长域名截断成同一类。
- 证据：
  - `proactive-rules.ts:15`：`return address.slice(address.lastIndexOf("@") + 1).toLowerCase();`
  - `proactive-mail-check-service.ts:112`：``return `due:${senderDomain(fromAddress)}`.slice(0, 128);``
- 建议：在上游解析处保证 `fromAddress` 是合法地址；在 `proactivePushClass` 里校验域名非空、无空白/控制字符，非法则不分类（`pushClass = null`）。

### 10. 低 — “点开清零”的反向用例实际上覆盖不到清零
- 文件:行：`test/integration/proactive-mail-check.test.ts:861-869`
- 问题：测试只先累计 2 次忽略（N=3）就插入一条已点开的推送，然后断言下一次仍推送。即使“遇到点开就停止计数”的逻辑被删掉，只要已点开的记录不被算成忽略，测试仍然通过。
- 证据：`ignoredPushes(h, 2);` → 推送并 `sent(..., openedAt)` → 断言 `after-open` 为 `pushed`。
- 建议：先累计满 N 次忽略，再插入一条已点开的推送、再断言下一次仍推送；或直接断言 `ignoredCount` 归零。

### 11. 低 — 0081 没有任何“旧库升级/数据保留/回滚”测试
- 文件:行：`packages/persistence-sqlite/test/migration-engine.contract.test.ts`（本次只把 80 改成 81）
- 问题：diff 里只更新了 `CURRENT_SCHEMA_SEQUENCE` 和期望序列号，没有验证从 schema 80（含 `source_insights` 旧行）升级后：旧行保留、`push_class` 为 NULL、索引存在、失败时回滚。
- 证据：`git diff` 中该文件只改了序列号数组和 `CURRENT_SCHEMA_SEQUENCE`。
- 建议：加一个从 80 升级的 contract 用例，插入旧 `source_insights` 行后执行 0081，断言数据与列。

### 12. 低 — 快照契约新增必填 `backoff`，新旧组件不兼容
- 文件:行：`packages/gateway-contracts/src/validation.ts:163-173`，`packages/gateway-contracts/src/contracts-v2.ts:419-427`
- 问题：`object()` 严格拒绝未知字段并要求所有字段存在。新 control-center 遇到旧 agent-service 的快照（没有 `backoff`）会解析失败；旧 control-center 遇到新快照（多出 `backoff`）也会因 unknown field 失败。
- 证据：`validation.ts:163-165`：遍历 `Object.keys(record)`，不在 `expectedKeySet` 里就 `fail(... "unknown field")`；`169` 行缺字段就 `missing required field`。
- 建议：如果存在滚动升级/多版本共存，把 `backoff` 设为可缺省（解析时补 `[]`），或提升 schemaVersion 并做双版本解析。

## 二、推测 / 需实测

- **竞态的实际触发概率**：代码结构上 `previewBackoff` 与 `recordCheck` 分离，`execute` 不受 `#running` 保护（见问题 3），但实际是否覆盖恢复取决于命令与检查的调度时机、模型调用耗时；建议用并发测试确认。
- **`ignored_count > 1000` 的触发条件**：产出的值确实无上限，但是否真能超过 1000 取决于历史推送数量、阈值配置和批量大小，属于低频但可导致检查反复回滚的路径。
- **旧库升级安全性**：0081 是纯 `ALTER TABLE ADD COLUMN` + 新表 + 部分索引，单条迁移在事务里执行（`migration-engine.ts:897-907`），失败会回滚；但没有专门的数据升级测试，实际旧库行为标“未核实”。
- **回滚后果**：迁移后 `minimum_writer_sequence` 会被写成 81（`migration-engine.ts:808`），旧二进制会被 `WRITER_TOO_OLD` 拒绝；没有自动 downgrade，回滚只能恢复迁移前快照。ADR 0184 没写这一点。
- **明文域名的实际泄露面**：域名明文是有意设计（ADR 0184），且只在 owner 自己的提醒页展示；但断开连接后仍保留（问题 4）、`source_insights` 分类未更新（问题 8），这两点需要产品/隐私确认。

## 三、侧重检查

- **错误路径**：`previewBackoff`/`restoreBackoff` 都走 `this.time()` 校验时间；恢复不存在的类抛 `PROACTIVE_RECORD_NOT_FOUND`（`production-proactive.ts:530`），测试覆盖。迁移每个文件在事务中执行，失败只回滚该迁移。
- **不可信输入**：唯一新增的不可信输入是邮件 `fromAddress` → `senderDomain` → `push_class`（问题 9）。命令里的 `classKey` 只作为 SQL 绑定参数，未见注入风险；长度由契约和 DB 双重限制。
- **安全/权限**：`execute` 校验 `actorType === "owner"` 且 owner/agent 匹配（`production-proactive.ts:419-427`），恢复操作不会跨 owner；`classKey: null` 会恢复该 owner 下全部类别，属于 owner 权限内的批量操作。
- **资源耗尽**：首次进入台阶前没有状态行，`sinceAt = EPOCH`，每次检查对该类扫描全部历史 `source_insights` 并按 `at` 排序（`proactive-push-backoff.ts:81,53`）；有 `(owner_id, agent_id, push_class)` 部分索引，但排序仍可能随时间变慢。另有 `ignored_count` 上限问题（问题 5）。
- **不可撤销操作**：恢复本身可逆（只是重置状态）；真正不可逆的是 `clear_records`（会删决策记录和降频状态）和迁移回滚（只能恢复快照）。
- **规则/文档一致性**：ADR 0184:66 与计数 SQL 不一致（问题 1）；ADR 说被压检查用 `silent`，但原因码优先级可能产出 `pushed` + `PUSH_SUPPRESSED`（问题 6）；`schemaCatalog` 与新增明文列不一致（问题 8）；ADR 声称“中间点开过”有反向用例，但该用例覆盖不足（问题 10）。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变。改动只在模型判定之后做推送门控（`proactive-mail-check-service.ts:853-874`），`proactivePrompt` 的组装（`proactive-mail-check-service.ts:377-386`）没有变，`push_class` 没有进入 prompt、系统提示、工具定义或历史。发给模型的内容仍然是在末尾追加；每轮会变的 `now` 仍只在最后（第 385 行）。diff 也没有改 `packages/prompt-catalog`。**结论：没有改变请求开头。**

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。新增的 `new Set(...).sort()` 只用于 DB 查询参数顺序，不进入模型请求；没有新增依赖前后文的遮盖、时间字段或无序集合进入 prompt。域名字符串本身是确定性的。唯一需要确认的是存储层 `push_class` 的明文域名，但它不参与模型输入。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有基本的集成/生产/UI/配置测试，但覆盖有缺口：
   - 会失败：N=3 的第 4 次被压、差 1 次、阈值 0、地板规则、别的域名、按“不需要”计数、恢复、stage1 每天 1 条、stage2 暂停。
   - 不会失败（覆盖不足）：问题 10 的“点开清零”用例（先只忽略 2 次）；没有“一次推送含同域名多条提醒”的用例（问题 2）；没有“无订阅/发送失败不计数”的用例（问题 1）；没有恢复与检查并发的用例（问题 3）；没有 0081 旧库数据升级用例（问题 11）。因此上述 1/2/3/7 类回归，现有测试很可能照样通过。

4. **每个新值的使用两端都能接受吗？**
   - `push_class`：生产者 `proactivePushClass` 截到 128（`proactive-mail-check-service.ts:112`）；DB 列 CHECK 1–128（`0081:1-2`）；overview 契约 `classKey`/`domain` 都是 `boundedString(128)`。长度两端一致，但 catalog 分类仍是 `payload_reference`（问题 8）。
   - `reason_code`：`PUSH_BACKED_OFF`/`PUSH_SUPPRESSED` 都是普通字符串，`decision_ledger.reason_code` 只校验长度 1–64（`0069_decision_ledger.sql:19`），能接受；但 UI 的 `failureLine` 只在 `verdict === "failed"` 时使用原因码，这两类不会展示（问题 6 的语义问题）。
   - 命令 `proactive.backoff.restore`：已加入 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、`PRODUCTION_PROACTIVE_OPERATIONS`，control-center 的测试配置也加了；路由按 `proactive.` 前缀分发，能接受。
   - 配置键 `runPolicy.proactive.backoffThreshold`：parser 用 `integer(..., 0, 10)`，缺省 3（`strict-configuration.ts:1043`），0 能正确覆盖默认值；与 ADR 一致。
   - 契约字段 `backoff`：服务端生产、测试 fixture、e2e fixture 都已补齐；但它是严格 schema 的必填字段，存在新旧版本不兼容风险（问题 12）。
   - `ignoredCount`：overview 契约是 `integer(0)`（无上限），DB 是 `<= 1000`，生产端无上限——生产端与 DB 端不一致（问题 5）。

**隐私结论（第 6 问）**：域名明文存储是有意的，且只在 owner 自己的提醒页通过 React 文本展示，未见 XSS；但断开 Gmail 后 `proactive_push_backoff` 仍保留明文域名（问题 4），`source_insights` 的加密分类也未更新（问题 8），这两点与“断开即清理邮件派生数据”的预期不一致，建议至少做到断开时清除或明确写入 ADR 的生命周期说明。
