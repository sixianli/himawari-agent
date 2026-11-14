以下第 1–6 条为读代码核实；第 7 条是推测。

### 1. [高] 新增 `owner_proposals` 却保持 `FORMAT_VERSION=v3`，旧 v3 备份会以清单错误整份拒绝，新旧 v3 互不兼容

文件:行：`packages/persistence-sqlite/src/data-export/schemas.ts:4`、`schemas.ts:651`、`schemas.ts:678`、`schemas.ts:683`、`packages/persistence-sqlite/src/data-export/verify.ts:349-361`

问题：作者说“导出格式版本不变，仍是 v3”。但本次把 `ownerProposals` 同时加进了清单的必填字段和 `additionalProperties: false` 的结构里，还新增了必带的数据文件和结构文件。结果是：旧版生成的 v3 清单没有 `ownerProposals`，`readManifest()` 先通过格式检查，再在 `MANIFEST_SCHEMA` 校验时失败，报 `DATA_IMPORT_MANIFEST_INVALID`，而不是明确的“版本不支持”；反过来，新版 v3 包交给旧程序时，旧 `MANIFEST_SCHEMA` 也因多出 `ownerProposals` 而报清单错误。同一个版本号下出现两种不兼容形状。

证据：

```ts
// schemas.ts:4
export const FORMAT_VERSION = "himawari.data-export.v3" as const;
// schemas.ts:651 / 678 / 683
ownerProposals: integer(0),
...
"ownerProposals",
...
additionalProperties: false,
```

```ts
// verify.ts:352-360
if (... format !== FORMAT_VERSION)
  throw new DataExportError(DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED, ...);
const problem = validateAgainst(MANIFEST_SCHEMA, value);
if (problem !== null)
  throw new DataExportError(DATA_EXPORT_ERROR_CODES.MANIFEST_INVALID, problem);
```

项目已有明确先例：`docs/adr/0246-external-proposals-join-the-data-export-and-web.md:73`：“新数据进导出时升格式版本，旧文件整份拒绝，不让 Andy 以为东西都带过来了。”同 ADR 决定 4 也写明 v1/v2 导入应报 `DATA_IMPORT_FORMAT_UNSUPPORTED`。

建议：按先例升到 `himawari.data-export.v4`，让 v1–v3 在 `readManifest()` 阶段明确报 `DATA_IMPORT_FORMAT_UNSUPPORTED`；如果确实要保留 v3 兼容，则应把 `ownerProposals` 和对应文件做成可选、缺省按 0/空文件处理，而不是维持当前这种既没兼容也没换版本的中间状态。

### 2. [中] 新测试没有接入数据导出门槛，`npm run check:data-export` 不会运行这三条用例

文件:行：`scripts/check-data-export.mjs:9-18`、`scripts/check-data-export.mjs:35`、`test/integration/data-export-owner-proposals.test.ts:153-197`

问题：新增了测试文件，但专用门槛脚本的 `FILES` 列表没有它，且脚本用 `-t "\\[P1-6\\]"` 过滤。新测试的 `describe` 是 `[owner-proposals]`，三个 `it` 标题也都不含 `[P1-6]`。因此 `check:data-export` 完全不会跑到它们，`REQUIRED` 仍是 113，CI 可以在不验证新功能的情况下通过。

证据：

```js
// scripts/check-data-export.mjs
const FILES = [
  "test/integration/data-export.test.ts",
  ...
  "test/integration/data-export-perception.test.ts",
];
const REQUIRED = 113;
...
"-t",
"\\[P1-6\\]",
```

```ts
// data-export-owner-proposals.test.ts:153
describe("[owner-proposals] the owner's proposal box travels with the data export", () => {
  it("round-trips rows, ...", ...)
  it("keeps secret-looking basis text ...", ...)
  it("[reverse] refuses to import into a target that already has proposals", ...)
```

建议：把 `test/integration/data-export-owner-proposals.test.ts` 加入 `FILES`，给用例加 `[P1-6]` 标签，并把 `REQUIRED` 从 113 提到 116（或按实际通过数调整）。这与 ADR 0246 决定 10 要求的“新增测试文件并提高下限”一致。

### 3. [中] `source_version` 参与脱敏但没进占位编号上限扫描，导入后再导出可能和别的原文撞占位号

文件:行：`packages/persistence-sqlite/src/data-export/export.ts:188`、`export.ts:686`、`export.ts:200-208`、`packages/persistence-sqlite/src/data-export/schemas.ts:254`

问题：`source_version` 和 `summary`、`effect`、`source_ref` 一样走 `safeOptional`/`safeString`，会被替换成 `[已扣留:n]`。但在计算“库里已有占位的最大编号”时，只把 `summary`、`effect`、`source_ref` 放进了扫描，漏了 `source_version`。导入过一次的库再导出时，`source_version` 里已经存在的 `[已扣留:n]` 不会被计入上限，后续 `safeString` 可能给另一段不同原文分配同一个编号，违背 ADR 0246 决定 6“算上已有占位，免得两个不同原文用了同一个占位”的要求。

证据：

```ts
// export.ts:188
snapshot.ownerProposals.map((row) => [row["summary"], row["effect"], row["source_ref"]]),
```

```ts
// export.ts:686
sourceVersion: safeOptional(optionalString(row["source_version"])),
```

```ts
// export.ts:200-208
const safeString = (value: string): string => {
  if (!options.policy.hasSecret(value)) return value;
  replacedShortTexts += 1;
  let number = shortTextNumbers.get(value);
  if (number === undefined) {
    number = existingPlaceholderMax + shortTextNumbers.size + 1;
```

建议：把 `row["source_version"]` 也加入占位扫描；更稳妥的是把本文件里所有会走 `safeString` 的字段集中列一份清单，扫描和导出共用，避免以后再漏。

### 4. [低] 含机密的 `summary`/`effect`/`sourceRef`/`sourceVersion` 被换成不可恢复的占位，违背“每个字段都一样”的说法，清单说明也没覆盖

文件:行：`packages/persistence-sqlite/src/data-export/export.ts:682-686`、`export.ts:200-208`、`packages/persistence-sqlite/src/data-export/types.ts:109-110`

问题：`summary`、`effect`、`sourceRef`、`sourceVersion` 命中机密时，`safeString` 只写 `[已扣留:n]`，原文既不在明文文件，也不在封存文件。导出再导入后这些字段与导出前不同。作者说法 1“除来源对话、租约和进行中的执行状态外，每个字段都一样”在这些值上不成立。同时 `omitted` 里的短文字说明只写“实体名、人物名、别名、来源编号和决定记录里的短文字”，没有说提议的 `summary`/`effect`/`source_version` 也会这样丢失。

证据：

```ts
// export.ts:682-686
summary: safeString(str(row["summary"])),
effect: safeString(str(row["effect"])),
...
sourceRef: safeOptional(optionalString(row["source_ref"])),
sourceVersion: safeOptional(optionalString(row["source_version"])),
```

```ts
// types.ts:109-110
export const SHORT_TEXT_OMISSION_LABEL =
  "含机密的实体名、人物名、别名、来源编号和决定记录里的短文字";
```

建议：如果这些是主人需要看到的说明文字，应像 `basis`/`execution` 一样把原文放进密封文件并在导入时恢复；如果仍按短文字规则丢弃原文，则至少更新 `SHORT_TEXT_OMISSION_LABEL` 和架构文档，并修正作者说法 1，避免主人以为导出再导入后说明文字还在。

### 5. [低] 新增校验没有反向用例；dryRun、单侧原文缺失、`executed_unverified`、导入后不可再领取都没测

文件:行：`test/integration/data-export-owner-proposals.test.ts:153-197`、`packages/persistence-sqlite/src/data-export/verify.ts:140-160`

问题：新测试只有三条：正常回环、机密原文跳过、目标非空拒绝。现有 `[reverse]` 用例是有效的——如果从 `EMPTY_TARGET_TABLES` 里删掉 `owner_proposals`，它会失败。但 `ownerProposalProblem()` 里的每个新校验（时间格式、待采纳不能有处理时间、拒绝过必须有最近拒绝时间、有版本不能没来源、待采纳不能有执行记录）都没有对应的反向测试；`dryRun` 计数、依据能还原而执行原样不能还原、`executed_unverified → unknown`、导入后不会被 `listExpiredLeases()` 捡起这些路径也都没有测试。

证据：测试文件三个 `it` 全部列在上面；`verify.ts:140-160` 新增的五个分支没有任何测试引用（`grep` 只在 `verify.ts` 和测试的 `ownerProposalsWithoutOriginal` 处出现）。

建议：至少补这几类反向/边界用例：篡改 `data/owner-proposals.jsonl` 触发每个 `ownerProposalProblem` 分支；`dryRun` 与真实导入的 `imported.ownerProposals`、`skipped.ownerProposalsWithoutOriginal` 一致；一个提议只有 `basis` 或只有 `execution` 可还原时整条跳过；`executed_unverified` 导入为 `unknown`；导入后调用 `listExpiredLeases()` 不返回该提议。

### 6. [低] 导入没有重新套用应用层的 `id` 格式和文字清洗约束，不可信文件可写入 App 永远读不到或含控制字符的提议

文件:行：`packages/persistence-sqlite/src/data-export/schemas.ts:248-250`、`packages/persistence-sqlite/src/data-export/verify.ts:494-506`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:14`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:110-113`、`apps/agent-service/src/production-proposals.ts:25`、`production-proposals.ts:184-205`、`production-proposals.ts:365-372`

问题：导出 schema 对 `id` 只要求长度 1–128，对 `summary`/`effect`/`type` 只要求长度。应用正常提议路径还要求 `id` 匹配 `PROPOSAL_ID_PATTERN`，并且 `type`/`summary`/`effect` 经过 `shownText` 去控制符后仍等于原文。导入只走 schema 和 `ownerProposalProblem`，没有重新套用这些约束。不可信的导出文件可以写入一个长度合法但不符合应用 `id` 格式的行；之后 `ownerProposal.read()`/`decide()`/`claim()` 都会因 `PROPOSAL_ID` 不匹配而拒绝，列表里却可能显示它。带方向控制符或换行的 `summary`/`effect` 也能绕过正常入口的清洗。

证据：

```ts
// schemas.ts:248-250
id: text(1, 128),
type: text(1, 64),
summary: text(1, 200),
```

```ts
// production-proposals.ts:25
const PROPOSAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$/u;
// sqlite-owner-proposal-operations.ts:110-113
private proposalId(value: unknown): string {
  if (typeof value !== "string" || !PROPOSAL_ID.test(value))
    this.invalid("Owner proposal id is invalid");
```

建议：在 `OWNER_PROPOSAL_SCHEMA` 或 `ownerProposalProblem()` 里加上与应用一致的 `id` 正则，并对 `type`/`summary`/`effect` 复用 `shownText` 的约束；至少要在导入时拒绝 App 后续操作一定拒绝的编号。

### 7. [低]（推测）导出遇到不可用 payload 会把非空的 `evidence_ref`/`execution_ref` 静默变成 null

文件:行：`packages/persistence-sqlite/src/data-export/export.ts:151-173`、`export.ts:701-703`、`packages/persistence-sqlite/src/data-export/import.ts:348-360`

问题：`exportedText()` 在 payload 不存在、被标记 `unavailable` 或文字读不到时返回 `null`。owner proposal 的 `basis`/`execution` 直接使用它，没有像 `memory` 的正文那样用 `requiredText()` 抛错。于是一个 `evidence_ref`/`execution_ref` 非空但密文缺失/已删除的提议，会被导出成 `basis: null`/`execution: null`；导入侧又把 null 当作“载荷已按规则清掉”，不会跳过整条。结果可能是待采纳提议导入后变成无法采纳（`#readBasis` 返回 undefined），或已成功提议丢失撤销原样。正常流程里清掉依据时会同时把引用置空（`docs/architecture-v0.1.md:425`），所以这更像数据库不一致时的边缘情况，标为推测。

证据：

```ts
// export.ts
const text = texts.get(ref);
if (payload === undefined || "unavailable" in payload || text === undefined) return null;
...
basis: basisRef === null ? null : exportedText(basisRef, ownerProposalBasisKey(id)),
execution:
  executionRef === null ? null : exportedText(executionRef, ownerProposalExecutionKey(id)),
```

```ts
// import.ts
if (
  (proposal.basis !== null && basis === null) ||
  (proposal.execution !== null && execution === null)
) {
  ownerProposalsWithout += 1;
  continue;
}
```

建议：对非空引用使用类似 `requiredText()` 的检查，导出直接报 `PAYLOAD_UNAVAILABLE`；或者至少把这部分计入 `omitted`，不要静默降级成 null。

## 侧重检查

- **错误路径与不可撤销操作**：`assertEmptyTarget()`（`import.ts:101-109`、`132`）在构造计划、调用 `protect()` 和写库之前执行；真正写入在 `database.transaction(...).immediate()` 里（`import.ts:451`、`882-883`）。目标已有提议时确实什么都不写；中途任何一条 INSERT/CHECK 失败会整事务回滚。缺原文时整条跳过并计数；依据和执行原样只有一个可还原时也整条跳过，判断本身是安全的。未发现“导入到一半留下半套数据”的路径。
- **不合规范/不可信输入**：逐项对照了 `owner_proposals` 两个迁移里的 CHECK 与 `OWNER_PROPOSAL_SCHEMA`/`ownerProposalProblem()`：长度（id/type/summary/effect/source_ref/source_version）、时间格式、指纹 64 位、version/proposed_count/reject_count/attempts、pending 与 decided_at、reject_count 与 last_rejected_at、source_version 与 source_ref，均没有“verify 放过、INSERT 违反 CHECK”的缺口。`requiresFullRead`/`requiresPresence` 由布尔转 0/1，符合 `IN (0,1)`。未覆盖的是应用层格式约束（见第 6 条）。
- **安全与机密**：`basis`/`execution` 走 `exportedText()`，命中 `hasSecret` 时明文层只放遮罩/占位，原文进 `originals`，只有提供口令才写 `sealed` 文件；`summary`/`effect`/`sourceRef`/`sourceVersion` 走 `safeString`。新测试确认 `SECRET_BANK_CARD` 不出现在除 `sealed/sealed.enc` 外的文件里。依据载荷的生产方 `#writeBasis`/`#writeExecution` 最高只标 `sensitive`（`classificationWithIdentifiers(body, "private")`），没有发现 `restricted` 依据 payload 的正常生产路径，因此未把“受限记忆正文经提议泄露”当作已证实问题。占位编号扫描遗漏见第 3 条。
- **资源耗尽**：导出会把所有 owner proposal 的依据/执行原样读入内存，并把每条提议写成一行；`MAXIMUM_LINE_LENGTH` 只在导入侧 `parseLines()` 检查，导出侧没有像规则那样显式检查 owner proposal 单行长度（`export.ts:732-737` 只检查规则）。理论上超大的依据会让导出包自己导不回去；实际 64MB 上限下风险低，故未单列为意见。
- **规则文件/说明文档与代码一致性**：架构文档新增的一段与代码在“目标空、来源对话置空、租约置空、running/executed_unverified→unknown”上一致；`DATA_IMPORT_TARGET_NOT_EMPTY` 文案也与 `types.ts` 一致。不一致之处是 ADR 0246/0233 的格式版本先例（第 1 条）和短文字说明未覆盖提议说明字段（第 4 条）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动范围只有 `packages/persistence-sqlite/src/data-export/`、测试和文档，没有碰系统提示、工具定义、历史消息、模型请求组装或遮盖结果；这一改动不发任何模型请求。发给模型的内容仍然只由原有路径在末尾追加，本轮没有变化。此问题对本 PR 不适用，而不是“改了但只追加”。
2. **同一段文字会不会在不同请求里变成不同字节？** 对模型请求不会：本 PR 不参与模型请求序列化。对数据导出本身，`exportedAt` 是既有的时间字段；`safeString` 的占位编号依赖同一次导出里的其他行，本身是上下文相关但确定性的（同一数据集重复导出稳定）。本次把 owner proposal 的 `summary`/`effect`/`source_ref` 放进了占位扫描，且漏了 `source_version`（第 3 条），所以同一段文字在“导出内容不同”的两个包里可能得到不同占位编号；这不是模型请求字节变化。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有测试文件，但**没有接入** `npm run check:data-export` 门槛（第 2 条），专用门禁不会跑它们。已有的“目标已有提议”反向用例是有效的：删掉 `EMPTY_TARGET_TABLES` 里的 `owner_proposals` 后，导入会成功而不是报 `TARGET_NOT_EMPTY`，该用例会失败。`verify.ts` 新增的五个校验、dryRun、单侧原文缺失、`executed_unverified` 映射都没有反向用例，无法证明改坏时会失败（第 5 条）。
4. **每个新值和每个使用它的地方是否都能对上？** 清单计数 `ownerProposals` 的产生处（`export.ts:867`、`demo-pack.ts:198`、`verify.ts:648`、`import.ts:393`）和使用处（`MANIFEST_SCHEMA` 必填字段、`verify.ts:653-658` 的逐项比对）都对上了；`PortableCounts` 的四个对象字面量都已补字段；`DATA_FILES.ownerProposals` 在 export/verify/import/demo 四处都被消费，`grep` 未发现别处硬编码文件清单。`ownerProposalBasisKey`/`executionKey` 的导出和导入使用同一函数，键不会错位。schema 与表 CHECK 的长度/时间/指纹/版本约束没有发现会让 INSERT 中途失败的缺口。`thread_id`、`lease_id`、`lease_expires_at` 是有意不导出并在导入时置 NULL，架构文档也写明了，未发现别处依赖它们。问题在版本消费端：清单结构新增必填字段但版本号没变（第 1 条）；不可信输入的 id 格式/控制字符没有在导入端复查（第 6 条）；`source_version` 的占位扫描遗漏（第 3 条）。
