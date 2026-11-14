## 结论概览

本轮增量（`d0bfe3669..e0b7b9d17`）的核心改动是：媒体按摘要串行、感知文字按 owner/agent 串行、媒体写行失败后的文件清理、拿掉建议表、给 `decision_ledger` 增加 `proposal`。迁移重建本身与串行锁的基本语义大体成立，但我发现 1 个可导致已入库媒体文件被误删的并发路径，以及 `proposal` 在 UI/测试消费者处没有补齐；另外新增的并发测试并不能真正复现它声称修复的缺陷。

---

## 问题（按严重度）

### 1. 高：媒体无主文件清扫可在上传提交后删掉刚入库的文件

**文件:行**：`packages/platform-node/src/perception-service.ts:871-876`（清扫）与 `:990-1042`（上传放置）；触发链 `:552-588`、`:590-608`

**问题**：`#sweepMedia` 先读取目录、再查数据库摘要集合，最后才检查 `#placing`。`#placing` 在上传的 `recordMedia` 返回后立即删除；而 `knownMediaDigests` 走读 worker、`recordMedia` 走写 worker（`packages/persistence-sqlite/src/product-state-repository.ts:738-768` 把读请求分发到独立 `readContexts`，写请求走 `:771-779` 的写通道）。因此可能出现：

1. 上传 A 已 `rename` 到最终文件，`#placing` 含 A；
2. 清扫读到目录（含 A），随后查 `knownMediaDigests`，此时 A 的行尚未提交，集合里没有 A；
3. A 的 `recordMedia` 提交，`finally` 删除 `#placing` 中的 A；
4. 清扫循环此时才检查 `!known.has(A) && !#placing.has(A)`，条件为真，删除 A 的最终文件。

结果：数据库中已有 `perception_media_items` 行，上传也返回 `stored: true`，但磁盘文件已丢；设备会认为上传成功并可能删除本地副本，属于不可逆的数据丢失。

**证据**：

```ts
const names = (await readdir(this.#media())).filter(...);
const known = new Set(await this.#options.store.knownMediaDigests({ digests: names }));
for (const name of names)
  if (!known.has(name) && !this.#placing.has(name))
    await rm(path.join(this.#media(), name), { force: true });
```

```ts
this.#placing.add(grant.sha256);
try {
  await rename(upload.file, final);
  const outcome = await this.#options.store.recordMedia({ ... });
  ...
} finally {
  this.#placing.delete(grant.sha256);
}
```

**性质**：读代码可确认存在这个窗口；具体触发需要特定交错，我未实际复现（未运行测试），属于“读代码证实的竞态 + 推测的触发时序”。

**建议**：让清扫与放置共用同一把按摘要的锁，例如清扫对每个 `name` 取 `#exclusive(\`media:${name}\`)` 后再查 `known` 并删除；或者不要在 `known` 之前一次性快照，而是在持锁状态下逐文件“查库 + 查 `#placing` + 删除”。更稳妥的是把“正在放置”持久化（例如先写 pending 行或落一个 `.placing` 标记文件，清扫只删超过宽限期的无主文件）。同时补一个并发用例：上传进行中触发 `prune`，断言最终文件仍在。

---

### 2. 中：`proposal` 没有补齐控制中心的文案与测试，现有自动检查会失败

**文件:行**：`packages/application/src/ports/decision-ledger.ts:32-43`、`packages/gateway-contracts/src/contracts-v2.ts:1424-1434`、`test/integration/calibration-group-copy.test.ts:27-34`、`apps/control-center/src/i18n/resources/zh-CN.ts:1040`、`:1291-1292`

**问题**：`DECISION_KINDS` 加入了 `proposal`，v2 合约枚举也加了，但控制中心的 `decision.chain.kind` 和 `weekly.check.rowsMissing` 的 `{k, select, ...}` 中没有 `proposal` 分支。`calibration-group-copy.test.ts` 对每个 `DECISION_KINDS` 要求两个文案都包含 `" <kind> {"`，因此该测试会失败；同时 `ledger-observation` 的 `countsFor` 会按所有 `decision_ledger.kind` 计数（`sqlite-observation-operations.ts:281-296`），将来 `proposal` 行数减少时 `rows_missing` 的 `kind` 会是 `proposal`，页面会落到 `other` 分支显示“决策”。

**证据**：

```ts
for (const key of ["decision.chain.kind", "weekly.check.rowsMissing"] as const)
  for (const kind of DECISION_KINDS)
    expect(messages[key], `${key} ${kind}`).toContain(` ${kind} {`);
```

```ts
`{k, select, proactive {系统主动提醒} ... rule_review {硬规则待重审} other {其他}}`
```

**性质**：读代码可确定该断言会失败（未实际运行测试）；`limit_change`、`delivery_timing` 在更早的提交中加入时也没有补文案，所以这个测试在当前 PR 中可能早已是红的，`e0b7` 又新增了一个缺失值，并未恢复绿色。

**建议**：在三种语言的 `decision.chain.kind` 和 `weekly.check.rowsMissing` 中补 `proposal`（最好连同 `limit_change`、`delivery_timing` 一起补），或明确在测试中排除不出现在该界面的类别并写明原因。若保留测试，应让测试与 `DECISION_KINDS` 的“UI 可见子集”保持一致，而不是直接遍历全量。

---

### 3. 中：新增的同字节并发测试不是真正的反向用例，其他并发修复也没有对应测试

**文件:行**：`test/integration/device-upload.test.ts:224-256`；`packages/persistence-sqlite/src/sqlite-perception-operations.ts:869-883`；`packages/platform-node/src/perception-service.ts:1032-1039`

**问题**：

- 新增测试“keeps the file when the same bytes arrive twice at once”没有设置任何上限，两次上传都是 `mediaKind: "image"`。`recordMedia` 先检查重复行，再检查上限；同一摘要的第二次写会在第一次提交后直接返回 `duplicate`，不会进入 `!stored && !duplicate` 的删除分支。即使去掉 `#exclusive`，该断言也很可能通过，因此它不是能失败的反向用例。
- 作者声称修复的原始场景需要“其中一张凭据被上限拒绝”；同一摘要的不同凭据可以带不同的 `mediaKind` 或 `durationMs`，从而产生不同的预留量。新测试没有制造这种差异。
- 第 3 条“写行出错且库里没有行时删文件”的 `catch` 路径（`:1034-1039`）没有测试；没有任何用例让 `recordMedia` 抛错并断言“有行时保留、无行时删除”。
- `#sweepMedia` 与上传的并发、同一条记录文字并发入库、`daily-review` 排除 `proposal` 都没有新增测试。

**证据**：

```ts
const bytes = Buffer.from("the-same-picture");
... mediaKind: "image" ...
const results = await Promise.all(targets.map((target) => upload(h, target, bytes)));
expect(...).toEqual([[true, false], [false, true]]);
```

```ts
if (!outcome.stored && !outcome.duplicate) await rm(final, { force: true });
```

**性质**：读代码可确定新测试没有覆盖删除分支；是否“去掉锁后必过”取决于执行顺序，但至少它不是能稳定证明修复的用例。

**建议**：构造同一摘要、不同 `mediaKind`/`durationMs` 的两张凭据，并设置 `perception.images.daily` 或 `perception.media.daily_bytes` 使其中一张被拒；断言被拒方不删除另一方的文件。再加一个可注入失败的 `store` 包装，验证 `knownMediaDigests` 为空/非空两种情况下文件的去留；并为清扫与上传并发、同记录文字并发补测试。

---

### 4. 低：`0095` 迁移被原地修改，已应用旧版本的环境会因摘要不一致拒绝启动

**文件:行**：`packages/persistence-sqlite/src/migrations/0095_perception_records.sql:23-28`、`:82-84`；`packages/persistence-sqlite/src/migration-engine.ts:873-887`

**问题**：`e0b7` 在原有 `0095` 文件里加入了 `proposal`，而不是新增 `0096`。迁移引擎会校验已应用迁移的 `digest`；任何已经应用过 `d0bfe` 版本 `0095` 的数据库（开发库、评审环境）再次启动会得到 `SQLITE_MIGRATION_DIGEST_MISMATCH`。

**证据**：

```ts
definition.digest !== record.digest
  ? throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH, ...
```

**性质**：读代码可确定；仅在“该库已经应用过旧 0095”时发生，未发布的 PR 分支可重置数据库规避。

**建议**：合并前统一重置开发库，或改为新增 `0096` 迁移（重建 decision_ledger 或在 0095 之后做一次受控重建）。如果团队允许在未发布 PR 内原地改迁移，至少要在 PR 描述里明确要求删除本地库。

---

### 5. 低：设计说明和运维清单元数据仍引用已删除的“建议”

**文件:行**：`docs/execution/specs/2026-11-11-apple-device-body-design.md:339`、`:732`；`ci/operations-pending.json`（五个 `perception.*` 条目的描述）

**问题**：设计文档仍写着表 `perception_suggestions`，并引用已删除的 `test/integration/perception-suggestions.test.ts`；`ci/operations-pending.json` 中五个感知操作的说明文字仍写“感知记录、用量和建议的查询与命令”。代码、合约、导出、目录、迁移里已无残留引用，但文档/元数据与代码不一致。

**证据**：

```md
**建议**。表 `perception_suggestions`：...
| 建议的编号 `suggestion:` 和状态 | ... | `test/integration/perception-suggestions.test.ts` |
```

**性质**：读代码/文档可确定。

**建议**：把设计文档中建议表相关内容改为“后续通用提议机制”，或标记为已移出本 PR；同步清理 `ci/operations-pending.json` 的描述文字。

---

### 6. 低：`releaseContent` 在 `finally` 中失败会把成功的入库变成错误响应

**文件:行**：`packages/platform-node/src/perception-service.ts:527-531`

**问题**：`#exclusive` 回调中，`ingestRecords` 成功后仍会 `await releaseContent`；如果这个 DELETE 因数据库错误失败，整个 `ingest` 会 reject，尽管记录已经提交。随后 `#afterWrite` 和上传凭据的 `completeUploadGrant` 都不会执行，调用方会看到失败并重试（重试通常得到 duplicate，不会丢数据，但语义上把成功变成了失败）。

**证据**：

```ts
} finally {
  await this.#options.store.releaseContent({
    ...scope,
    refs: prepared.flatMap(({ contentRef }) => (contentRef === null ? [] : [contentRef])),
  });
}
```

**性质**：读代码可确定；只有 `releaseContent` 本身失败时触发，未实际复现。

**建议**：区分“主操作结果”和“清理结果”：清理失败应记录告警/留给后续清理，而不是覆盖已成功的入库结果；若产品要求失败关闭，则至少要让错误信息明确是清理失败，并保证重试幂等。

---

## 侧重检查

- **错误路径 / 不可信输入**：核对了 `beginUpload` 的字段与绑定校验（`:742-837`）、`consumeUpload` 的 grant 重读、字节/摘要比对（`:947-952`）、`#lines` 的解压后字节上限与按字节的行长度（`:908-931`）、`#parseRecord` 的字段/时间/说话人校验（`:339-455`）。未发现新的越权或路径穿越：媒体最终文件名来自 `SHA256_PATTERN` 校验过的 `grant.sha256`。
- **错误路径 / 媒体**：`recordMedia` 抛错时 `knownMediaDigests(...).catch(() => [grant.sha256])` 是保守方向：读库失败时保留文件，可能留下无主文件，但不会误删已入库文件。问题在清扫侧（见问题 1）。
- **安全 / 隐私**：`releaseContent` 的 DELETE 同时限定 `owner_id`/`agent_id`，并只删不被 `perception_records.content_ref` 引用的 payload；入库串行化使同一 owner/agent 的文字保护、入库、释放不会互相踩踏。未发现文字被并发误删的路径。
- **资源耗尽**：`#queues` 在最后一个等待者完成后删除条目（`:856-868`），不会永久增长；但锁是进程内锁，若同一状态目录被多个进程使用则不能跨进程串行（未核实部署是否多进程）。“每台设备同时上传数”仍缺失，作者已列为下一 PR。
- **不可撤销操作**：迁移重建的数据/索引/触发器/外键保留由 `consolidation-hold-migration.contract.test.ts` 的 `dump()` 对比覆盖（`:38-66`、`:196-225`：`sqlite_master` SQL 比较 + `foreign_key_check`）；`decision_ledger` 的 7 个子表都被重建，重建顺序和触发器与 0089/0091 一致。未发现 `perception_suggestions` 的外键/索引残留（全仓仅设计文档残留）。
- **规则 / 文档一致性**：`prompt-prefix` 规则要求请求头固定、只在末尾追加；本改动没有修改提示词目录、工具定义或模型请求组装代码，`perception.extract` 的后台模型调用尚未实现（设计文档 `:393` 只是后续设计）。文档一致性问题见问题 5。
- **自动检查**：迁移引擎序列 94→95 已更新；`consolidation-hold` 测试新增 `DECISION_OUTCOMES.proposal` 全量插入与非法 outcome/kind 拒绝（`:204-218`），这部分是有效的反向用例。`calibration-group-copy` 则是会失败但未更新的消费者（见问题 2）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加、每轮会变的值是否都在最后一条消息里？

不会。本轮 diff 涉及的是感知入库、文件放置/清扫、决策账本 schema、数据导出和 UI 文案，没有改动系统提示、工具定义、历史消息或出口遮盖的组装代码；也没有新增模型调用（`perception.extract` 属于后续 PR）。因此对模型请求仍然是“只在末尾追加”，没有把新的每轮变化值放进请求头。依据 [prompt-prefix.md#append-only](../../.claude/rules/prompt-prefix.md#append-only)：已经发出的内容不得改动，只能追加。

**未核实**：没有运行 `npm run check:prompt-prefix`（本环境不能执行测试），上述结论来自 diff 和代码阅读。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会（对本轮改动而言）。`#exclusive` 只改变执行顺序，不改变序列化内容；感知文字的 payload ref 由 `authenticationRef + perception-content:<sha256(recordId)>` 决定（`production-http-composition.ts:532-534`），同一记录/会话下稳定；`releaseContent` 的删除条件是确定性的数据库引用关系。`DECISION_KINDS` 的追加在数组末尾，导出 schema 和合约枚举顺序固定。媒体文件不是模型输入。

真正涉及“同批感知记录被模型抽取”时的确定性要求在设计文档 `:654-655`，但该抽取调用尚未在本 PR 实现。

### 3. 有没有对应的自动检查？反向用例是否真的会失败？

部分有，但强度不足：

- **迁移**：有。`consolidation-hold-migration.contract.test.ts:204-218` 已验证 `proposal` 的 10 个 outcome 都能插入，`proposal/changed`、`limit_change/deferred`、未知 kind 会被 CHECK 拒绝；这是会失败的反向用例。数据/索引/触发器/外键保留也有 `dump()` 对比。
- **同字节并发**：没有真正的反向用例。新增测试没有上限、没有不同 mediaKind/duration，不能进入删除文件的 `!stored && !duplicate` 分支，去掉 `#exclusive` 也很可能通过。
- **媒体写行出错删文件（claim 3）**：没有测试；`catch`/`knownMediaDigests` 分支未被覆盖。
- **清扫与上传并发**：没有测试；问题 1 的竞态不会被现有测试发现。
- **同一记录文字并发入库**：没有测试。
- **`proposal` 排除每日复盘**：只有类型/过滤代码，没有测试；同时 `calibration-group-copy.test.ts` 反而会因为缺少 `proposal` 文案而失败。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐个核对结果：

- **`proposal` kind**：DB CHECK（`0095:23-28`）、`DECISION_KINDS`（`decision-ledger.ts:42`）、`DECISION_OUTCOMES.proposal`（10 个值，顺序与 DB 一致）、`validateLedgerWrite`/`insertLedgerRow`（`sqlite-decision-ledger-operations.ts:53-60`）、数据导出 `DECISION_SCHEMA`（`schemas.ts:295`）、v2 `decision.chain.snapshot` 枚举（`contracts-v2.ts:1433`）都能接受；`daily-review` 明确排除，`proactiveReviewKinds`/`calibrationGroupSchema` 不包含它也与“每日复盘不显示”一致。
- **未接受的消费者**：控制中心 `decision.chain.kind` / `weekly.check.rowsMissing` 文案缺少 `proposal`，导致 `calibration-group-copy.test.ts` 失败、页面回退到“其他/决策”（见问题 2）。`ledger-observation` 的 `rowsKept` 会把 `proposal` 作为可能缺失的 kind 返回，虽然 facts 是自由字段、不会让合约校验失败，但文案仍会落到兜底分支。
- **`perception_suggestions` 删除**：代码、合约、导出、`schema-catalog`、迁移中已无引用；测试文件已删除。仅设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:339,732` 仍引用表和已删除测试，属于文档残留。
- **上传/媒体值**：`mediaKind`、`sha256`、`bytes`、`durationMs` 在 `beginUpload` 校验后写入 grant，`recordMedia` 再次使用；`knownMediaDigests` 只按摘要查询，`recordMedia` 的 duplicate 以 `id = media:<sha>` 判断；两端校验一致。文件路径使用已验证的 sha，没有路径注入。
- **`releaseContent` 的 refs**：来自本批 `prepared`，限定同一 owner/agent，并由 `perception_records.content_ref` 是否引用来决定去留；与入库记录的使用端一致。
