现在我来查看测试、覆盖检查脚本以及 I-73 事件文档。
# 复核报告：P1-6 数据导出（a75564ab vs 801ad699）

## 发现（按严重度从高到低）

**1. 中 · packages/persistence-sqlite/src/data-export/import.ts:396 — ADR 说导入留下「已关闭」线程，代码写入的是 `'open'`**
- 证据（读代码证实）：import.ts:394-398 `INSERT INTO threads (…, status, …) VALUES (?, ?, ?, 1, 'open', ?, ?)`；ADR 0200 后果第 1 条（docs/adr/0200…md:88）写「导入会留下一个空的、**已关闭**的线程……不显示在线程列表的活动区」。
- 推测：status 为 `open` 的空线程是否会出现在网页线程列表的活动区，我没有读线程列表查询，未核实；若会，用户导入后会看到名为 `data-import-thread-…` 的幽灵对话。
- 建议：改为 `'closed'` 或与 ADR 对齐后改 ADR，并加断言导入后线程状态与可见性的用例。

**2. 中 · packages/persistence-sqlite/src/data-export/snapshot.ts:211-218 — 文件态荷载（`ciphertext_file`）完全没有处理**
- 证据（读代码证实）：snapshot.ts:213 `row.storage_kind !== "sqlite_blob"` 即标记 `{ unavailable: true }`；export.ts:119 `requiredText` 对记忆正文遇到 unavailable 抛 `PAYLOAD_UNAVAILABLE`（整份导出失败）；export.ts:144-147 历史事件遇 unavailable 直接跳过，并被计进 export.ts:366-369 的 omitted 项，理由写成「**写入时原文已被删除**的历史版本和引用原话」——文件态不是被删除，理由失实。而 `ciphertext_file` 是产品支持的存储形态：ciphertext-file-store.ts:229-249 `HybridPayloadStore.put` 超过 `fileThresholdBytes` 就落文件；sqlite-durable-operations.ts:1697-1709、recovery-point/authority-transfer 都处理它。
- 推测：当前生产接线（apps/ 下）没有构造 `HybridPayloadStore`，全是 inline，所以现在不会触发；一旦上线按计划文档（2026-10-28 plan：大荷载落加密文件）接线，记忆正文超过阈值时导出会整体失败。
- 测试缺口：data-export-fixture.ts 所有荷载都是 `sqlite_blob`，此路径零覆盖。
- 建议：要么经文件存储读回，要么在清单 omitted 里如实单列「文件态荷载」条数，并补 fixture。

**3. 低 · apps/admin-cli/src/data-command.ts:121 — 硬编码 `"sealed/sealed.enc"`，未用 `SEALED_FILE` 常量**
- 证据（读代码证实）：schemas.ts:391 `SEALED_FILE = "sealed/sealed.enc"`；data-command import 了该包的其他常量却在这处写死字符串，路径一改 `inspect` 的 `sealed` 字段就静默失真。
- 建议：改用常量；同时 `inspect` 输出里的 `sealed` 字段没有任何测试断言（data-cli.test.ts:176-177 只断言 counts）。

**4. 低 · apps/admin-cli/src/data-command.ts — CLI 层若干分支无测试**
- 读代码证实的未覆盖路径：`--dry-run`（data-command.ts:193、251 走库层已测，CLI 层没有用例）；readPassphrase 的 `text.length < 12` 拒绝（data-command.ts:85，只测了 0o644 权限拒绝）；`requirePayloadKey` 的 0 个或多个 payload-encryption 密钥分支（data-command.ts:89-95）。
- 建议：补 CLI 用例或注明由库层测试覆盖的边界。

**5. 低 · packages/persistence-sqlite/src/data-export/import.ts:56-72 — `assertEmptyTarget` 只查 5 张主表**
- 证据（读代码证实）：EMPTY_TARGET_TABLES 只有 memory_records、decision_ledger、memory_people、memory_import_batches、memory_consolidation_runs；不含 payloads、memory_history_events、decision_signals、memory_person_aliases/entities/pins/provenance、source_insights 等 import 会写的表。
- 推测：这些表多有外键指向主表，孤儿行难以存在，残余风险低；但 payloads 有独立 owner_id，可能残留。
- 建议：至少在文档里写明「空库」的判定口径。

**6. 备忘 · 命名与余量**
- 读代码证实：types.ts:62-78 的 `DATA_EXPORT_ERROR_CODES` 里 10 个值是 `DATA_IMPORT_*` 前缀（仅外观不一致）；scripts/check-data-export.mjs:14 `REQUIRED = 35`，实际带 `[P1-6]` 标签的用例 36 条（data-export 31 + retrieval 2 + CLI 3），余量只有 1，再加正向用例时不加 REQUIRED 会静默漂移。

## 与作者说法的核对
- 「不碰发给模型的请求」：**属实**。diff 只新增 data-export 模块、export-text-policy.ts（仅被 admin-cli 和测试引用）、admin-cli `data` 命令、脚本与测试；runtime-pi/application/prompt-catalog/遮盖零改动。
- 「persistence-sqlite 不依赖 sensitive-capture」：**属实**（包内 grep 无引用；boundary-policy.mjs:28-37 允许清单里确实没有）。
- 「check:expensive-models 的 gpt-4o 失败是 main 已有」：secret-like.unit.test.ts:28 确为 `"gpt-4o"`，本 diff 未改该文件；是否真在 main 上失败无法运行验证（推测成立）。
- 其余验收说法（哈希/条数不符拒绝、Markdown 按编号可查、无明文机密、接入 npm run check）均与代码一致，见下。

## 侧重检查（普通使用流程走查）
流程：`himawari-admin data export --config … --secret-dir … --out … --passphrase-file …` → `data inspect --from …` → 停服后 `data import --confirm IMPORT_DATA_<agentId> …`。
路径覆盖：index.ts:780 路由 → parse → readPassphrase（权限测、长度未测）→ requirePayloadKey（未测分支）→ lockStoppedTarget（既有）→ openQualifiedDatabase/assertWritableSchema → buildPortableExport（充分覆盖）→ UNSEALED_WITHHELD 闸（已测）→ writePortableDirectory（库层已测）→ inspect（已测，`sealed` 字段未断言）→ import（确认短语、空库拒绝、篡改拒绝均已测；CLI `--dry-run` 未测）。**结论：核心链路覆盖良好，缺口集中在第 1、2、4 条发现列出的分支。** 文档与代码一致性：ADR/PRD/规则基本一致，唯一实质冲突是发现 1。

## 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会。改动全部在导出/导入、CLI、脚本和测试；`export-text-policy.ts` 用的 `redactForExternalText`（external.ts:76-84）每次调用新建 placeholder 映射，无状态，不与请求遮盖共享状态。发给模型的内容仍只追加；导入只是把记忆经既有 projection 流程对未来对话可见，不改任何既有对话的请求开头。每轮会变的值不涉及。

**2. 会不会同一段文字在不同请求里变成不同字节？** 不会影响模型请求。导出侧：`canonicalJson` 键排序（canonical.ts:15-27）、SQL 固定 ORDER BY，且有「同一库两次导出数据文件逐字节一致」的正向用例和「时间戳会破坏一致性」的反向用例。manifest 的 `exportedAt`（export.ts:401）和 sealed.enc 的随机盐/nonce 是每次导出必然不同的字节，但只存在于导出文件夹，不进模型请求。

**3. 有没有自动检查，反向用例会真失败吗？** 有：`check:data-export` 已挂进 `check:steps`（package.json），跑 vitest `-t \[P1-6\]` 要求 ≥35 通过且 0 失败。data-export.test.ts 有 12 个篡改反向用例（改字节、截断、条数、哈希、多/缺文件、路径逃逸、版本、迁移号、改枚举、断引用，均 `rejects.toMatchObject({code})` 并断言未写入），另有「关掉遮盖就搜出机密」「未建索引则检索指标必变」等反向用例，防线被移除即失败。我未实际运行（工具受限），结构上成立。

**4. 每个新值的两端都核对了吗？** 核对过的：`FORMAT_VERSION`（schemas.ts:3 ↔ verify/seal/manifest 同源）；egress gate 登记 `containsRestrictedIdentifier: 1` ↔ 实际 1 处调用（export-text-policy.ts:18）；coverage-manifest 新 id `V02-RULE-13A`/`V02-ACC-10A` 在 S0 覆盖表（设计文档 106/138/164 行）有归属 S1 的对应行，check-v0.2-coverage 双向比对可过；PRD 条款数 258→269（+11）与 PRD diff 新增列表条款数（1+6+4）相符；导入骨架行的列与真实迁移表结构由跑真迁移的集成测试覆盖。未核实：manifest 里 PRD 新 sha256 `0e0041…` 是否与文件实际摘要一致（无法计算哈希；门禁运行时会抓）。唯一发现的两端不一致是发现 1（ADR「closed」↔ 代码「open」）。
