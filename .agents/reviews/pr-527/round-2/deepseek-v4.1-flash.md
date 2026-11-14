### 1. [中] 新增“篡改提议文件”反向用例在文件哈希校验处就失败，没有真正覆盖本轮的编号/时间校验

文件:行：`test/integration/data-export-owner-proposals.test.ts:238-249`

问题：`tamper()` 只替换了 `data/owner-proposals.jsonl` 的字节，没有同步更新清单里的 `bytes`/`sha256`。`parsePortable` 在解析行之前先调用 `verifyIntegrity`，所以三个篡改都会先撞上 `FILE_HASH_MISMATCH`，根本走不到本轮新增的 `OWNER_PROPOSAL_ID`、`STORED_TIME`、`decidedAt` 校验。即使删掉这些新校验，这个反向用例仍会通过。

证据：
```ts
// test/integration/data-export-owner-proposals.test.ts:245-248
return new Map(files).set(
  FILE,
  new TextEncoder().encode(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`),
);
```
```ts
// packages/persistence-sqlite/src/data-export/verify.ts:392-393
if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256)
  throw new DataExportError(DATA_EXPORT_ERROR_CODES.FILE_HASH_MISMATCH, entry.path);
```
`data-export.test.ts` 里同类用例用了 `rehash(files, ...)`，这个新用例没有。

建议：复用 `rehash` 或重新计算清单条目；并断言 `LINE_INVALID`，这样才真正验证编号格式、时间格式和 `pending`/`decidedAt` 的一致性。

### 2. [中] 载荷不可用时导出把 basis/execution 静默写成 null，导入后可能留下不可采纳或不可撤销的提议且报告不计数

文件:行：`packages/persistence-sqlite/src/data-export/export.ts:706-708`、`snapshot.ts:353-361`、`import.ts:347-360`、`apps/agent-service/src/production-proposals.ts:749-751`

问题：上一轮第 7 条没有被增量修改。`exportedText()` 在载荷缺失、`deletion_pending`/`deleted_verified` 或不是 `sqlite_blob` 时返回 `null`，导出行于是把 `basis`/`execution` 写成 `null`，看起来像“已按规则清掉”。导入端只在 `proposal.basis !== null` 时才检查原文能否还原；`null` 不会被计入 `ownerProposalsWithoutOriginal`。结果是报告说整条导入成功，但依据或撤销原样已经静默丢失。

进一步影响是代码里能读到的：待采纳提议导入后 `#readBasis(null)` 返回 `undefined`，采纳会报 `PROPOSAL_NOT_FOUND`；已成功提议若丢了 `execution`，`#undoOnce` 会报 `PROPOSAL_NOT_UNDOABLE`，但状态仍是 `succeeded`，界面仍会把它当成可撤销。

证据：
```ts
// export.ts:706-708
basis: basisRef === null ? null : exportedText(basisRef, ownerProposalBasisKey(id)),
execution:
  executionRef === null ? null : exportedText(executionRef, ownerProposalExecutionKey(id)),
```
```ts
// snapshot.ts:353-361
if (!row || row.storage_kind !== "sqlite_blob" || row.ciphertext === null ||
    row.lifecycle_state === "deletion_pending" || row.lifecycle_state === "deleted_verified") {
  payloads.set(ref, { unavailable: true });
  continue;
}
```
```ts
// import.ts:354-360
if ((proposal.basis !== null && basis === null) ||
    (proposal.execution !== null && execution === null)) {
  ownerProposalsWithout += 1;
  continue;
}
```
（代码路径已读实；实际触发取决于载荷是否真的进入这些状态，可达性属于推测。）

建议：导出时如果 `evidence_ref`/`execution_ref` 非空但载荷不可用，应直接报错或至少保留“存在但不可用”的标记；导入端不能把它当成“没有依据”，并应把 `succeeded` 且缺执行原样的提议降级或拒绝。同步更新文档中“每个字段都一样”的说法。

### 3. [低] 导入校验只覆盖表的 CHECK，未覆盖应用层的 type 文字清洗、日历时间合法性和执行状态不变量

文件:行：`packages/persistence-sqlite/src/data-export/verify.ts:138-160`、`schemas.ts:246-274`、`apps/agent-service/src/production-proposals.ts:199-205`

问题：本轮补上了提议编号格式，但 `type` 仍只按 `text(1, 64)` 校验；应用层 `propose()` 还要求 `shownText(input.type, TYPE_LENGTH) === input.type`，会去掉 Bidi 控制字符和控制字符。因此不可信导出文件可以写入应用自己不会接受的 `type`。`STORED_TIME` 只校验 24 个字符的形状，`0000-00-00T00:00:00.000Z` 这类日期也能通过；表 CHECK 只看 GLOB，同样会接受，不会在 `INSERT` 时失败，但应用里的时间语义已经不可信。校验也没有检查 `exec_status='succeeded'` 是否带执行原样/执行时间等应用不变量。

证据：
```ts
// verify.ts:143
if (!OWNER_PROPOSAL_ID.test(proposal.id)) return `${where}：编号不是提议箱用的格式`;
```
```ts
// schemas.ts:248-249
id: text(1, 128),
type: text(1, 64),
```
```ts
// production-proposals.ts:367-368
!sentence(input.type, TYPE_LENGTH) ||
shownText(input.type, TYPE_LENGTH) !== input.type ||
```
```ts
// verify.ts:139,151
const STORED_TIME = /^.{4}-.{2}-.{2}T.{2}:.{2}:.{2}\..{3}Z$/u;
if (value !== null && !STORED_TIME.test(value))
```

建议：在 `verify.ts` 复用或镜像应用层的 `shownText`/`sentence` 规则校验 `type`（至少拒绝控制字符和首尾空白）；用 `Date.parse` + `toISOString()` 相等校验时间；对 `succeeded`/`undone` 等状态补上执行原样、执行时间的交叉校验。这样导入的是应用能读、能操作的状态。

### 4. [低] 作者说明与代码/文档不一致：格式实际为 v4，且“每个字段都一样”不成立

文件:行：`packages/persistence-sqlite/src/data-export/schemas.ts:4`、`docs/architecture-v0.1.md:433`、`docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56`

问题：作者约束写“导出格式版本不变，仍是 v3”，代码实际已升到 `himawari.data-export.v4`，并且新增测试明确拒绝 v3。作者第 1 条“除来源对话、租约和进行中的执行状态外，每个字段都一样”也不成立：`summary`/`effect`/`sourceRef`/`sourceVersion` 含机密时只留不可恢复的占位（本轮文档已承认），载荷不可用时 `basis`/`execution` 还会变成 `null`（见第 2 条）。另外 ADR 0246 仍记录 v3，没有记录 v4 以及 v3 整份拒绝的决定。

证据：
```ts
// schemas.ts:4
export const FORMAT_VERSION = "himawari.data-export.v4" as const;
```
```ts
// docs/architecture-v0.1.md:433
说明、效果、来源和来源版本含机密时只留“已扣留”占位，原文不带……所以这几项导出再导入后可能和原来不同
```
```md
<!-- docs/adr/0246-...md:56 -->
4. **数据导出格式升到 `himawari.data-export.v3`。**
```

建议：修正作者说明；新增一段 ADR 或更新架构文档，写明 v4、v3 整份拒绝，以及“每个字段都一样”的例外清单。否则复核者/运维会按旧说明处理 v3 备份。

### 5. [低] 往返/反向测试仍缺少几处关键断言

文件:行：`test/integration/data-export-owner-proposals.test.ts:145-155`、`:158-174`、`:193-218`

问题：这一轮补了干跑和 `executed_unverified`，但仍有缺口：
- `rows()` 只查 `lease_id`，没查 `lease_expires_at`，无法证明租约两列都清空；
- seed 的 `thread_id` 永远为 `NULL`，没有验证“来源对话确实被置空”；
- `has_basis`/`has_execution` 只是布尔，没有解开新载荷比对原文，无法发现“把遮盖后的占位符重新加密”这类错误；
- 没有“依据能还原、执行原样不能还原”的单侧缺失用例；
- 没有断言导入后 `pending` 提议不能重新领取/执行。干跑也只比较 `imported`，没有比较 `skipped`。

证据：
```ts
// test/...:148-151
SELECT id, type, summary, effect, origin, thread_id, source_ref, source_version, version,
  fingerprint, evidence_ref IS NOT NULL AS has_basis, status, proposed_at, expires_at,
  decided_at, proposed_count, reject_count, exec_status, lease_id, attempts,
  requires_full_read, requires_presence, executed_at, execution_ref IS NOT NULL AS has_execution
```
```ts
// test/...:214
expect(dry.imported.ownerProposals).toBe(real.imported.ownerProposals);
```

建议：补查 `lease_expires_at`、用非空 `thread_id` 验证清空；解密导入后的 `evidence_ref`/`execution_ref` 与原文比对；补单侧缺失原文用例；对导入后的提议调用 `claim`，断言失败。反向用例按第 1 条修正后再断言具体错误码。

**上一轮意见核对**
1. 已改好：`FORMAT_VERSION` 升 v4，新增 v3 整份拒绝用例；但作者说明仍写 v3（见第 4 条）。
2. 已改好：新测试文件已加入 `scripts/check-data-export.mjs` 的 `FILES`，门槛从 113 提到 139；实际通过数未运行核实。
3. 已改好：`source_version` 已加入占位编号扫描，并有对应测试。
4. 已改好：文档和 `SHORT_TEXT_OMISSION_LABEL` 已承认短文字被替换为占位。
5. 部分改好：补了干跑和 `executed_unverified`，但新增的篡改反向用例无效（见第 1 条），单侧缺原文和不可再领取仍未覆盖。
6. 部分改好：编号格式已复查；`type` 文字清洗、时间日历合法性和执行状态不变量仍未校验（见第 3 条）。
7. 未改好：载荷不可用时仍静默变 `null`（见第 2 条）。

**侧重检查**
- 错误路径：读了 `parsePortable` → `verifyIntegrity` → `importPortableExport` 的失败顺序、`dryRun` 返回点、`assertEmptyTarget`、密封文件缺失/原文缺失分支。发现反向篡改用例被哈希提前拦截（第 1 条）。
- 不合规范/不可信输入：核对 `OWNER_PROPOSAL_SCHEMA`、`ownerProposalProblem` 与 `owner_proposals` 两段迁移里的 CHECK；长度、指纹、版本、次数、时间形状基本对齐，但 `type` 文字清洗、日历时间、执行状态不变量未对齐（第 3 条）。
- 安全：机密 `basis`/`execution` 走 `exportedText`，原文只进密封文件；`summary`/`effect`/`sourceRef`/`sourceVersion` 走 `safeString`。未发现新的明文泄漏；但 `type` 未过敏感文字检查，理由是目前 `type` 是代码常量而非主人文字（推测）。
- 资源耗尽：新增行受 `MAXIMUM_LINE_LENGTH` 限制；导出/导入仍按整表读取，和既有表一致，未见新增的无限循环或无序集合。
- 不可撤销操作：`running`/`executed_unverified` 导入为 `unknown`、租约置空，正确避免重新执行；但 `succeeded` 缺执行原样时仍保留成功状态，撤销会失败（第 2 条）。
- 规则/文档/代码一致：格式 v4 与作者说法、ADR 不一致（第 4 条）。

**必答问题**
1. 不改变模型已经见过的请求开头。本轮改动只在 `packages/persistence-sqlite/src/data-export/`、测试和文档，没有改系统提示、工具定义、历史消息或请求组装代码；新增的字段只是导出文件/数据库里的提议数据，不会插入模型请求。因此仍符合“只在末尾追加、每轮变化的值放最后一条消息”的规则（`.agents/instructions/prompt-prefix.md` 第 4 条）。
2. 不涉及模型请求。导出侧对提议使用 `ORDER BY proposed_at, id`，密封键由提议编号决定，占位编号基于本次扫描的固定顺序；同一数据库重复导出是确定的。占位编号会随库内已有占位号不同而不同，但这是导出文件层的语义，不进入模型请求，也不会让同一请求里的同一段文字因前后文改变。
3. 有自动检查，但反向覆盖不完整。v3 整份拒绝、目标非空、占位编号这几条反向/边界用例是有效的；新增“篡改提议文件”用例无效（第 1 条）。`npm run check:data-export` 的 `REQUIRED=139` 无法在本次复核中运行验证。单侧原文缺失、导入后不可再领取等仍无用例（第 5 条）。
4. 逐项核对了本轮产生/修改的值：
   - `FORMAT_VERSION=v4`：`MANIFEST_SCHEMA`、`SEALED_SCHEMA`、`readManifest`、`demo-pack` 和相关测试都用常量，已更新；ADR 文档未更新（第 4 条）。
   - `DATA_FILES.ownerProposals`、`OWNER_PROPOSAL_SCHEMA`：导出、导入、校验、demo pack 都引用同一常量，demo pack 也补了空文件和 0 条。
   - `PortableCounts.ownerProposals`：清单 schema 必填，`verify.ts` 逐键比较，导入报告、demo pack、`demo-data`/owner 测试均已补上。
   - `ownerProposalBasisKey`/`ownerProposalExecutionKey`：导出和导入共用同一函数；编号正则不允许 `/`，密封键不会歧义。
   - `skipped.ownerProposalsWithoutOriginal`：admin CLI 直接展开整个报告，测试已补；没有别的固定字段消费者。
   - 编号正则：与 `sqlite-owner-proposal-operations.ts` 的 `PROPOSAL_ID` 和应用层 `PROPOSAL_ID_PATTERN` 一致；`production-owner-rules.ts` 的 `rule-proposal:<32hex>` 也能通过。使用端都接受。
   唯一明确的两端不一致是文档/作者说明，不是类型或运行时校验拒绝。

**本轮查过的范围**
增量 `ab223ca1..8a8539ab`（实际代码提交 `4740a0c7`）：`schemas.ts`、`snapshot.ts`、`export.ts`、`import.ts`、`verify.ts`、`types.ts`、`demo-pack.ts`、`scripts/check-data-export.mjs`、owner-proposals 测试及版本相关测试、`docs/architecture-v0.1.md`。为核对两端还读了 `20261114151010_owner_proposals.sql`、`20261114163611_owner_proposals_execution.sql`、`sqlite-owner-proposal-operations.ts`、`production-proposals.ts`、`production-owner-rules.ts`、admin CLI 导入输出、ADR 0246 和 prompt-prefix 规则。未运行测试，因此测试通过数和实际覆盖率未核实。
