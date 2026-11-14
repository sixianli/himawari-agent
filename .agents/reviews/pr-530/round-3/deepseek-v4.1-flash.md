## 范围

本轮对照了 `1ebf8a7a7..d5d173e9b` 和 `78c5cf9df..d5d173e9b`。PR 530 在这一段的实际增量是 `c56ce9cb3`（原因文案）、`8c2d72e81`（补测试）、`de124de4c`（撤回文案改动、删掉一条断言）；`export.ts`、ADR 0272、架构文档、`check-data-export.mjs` 在 `78c5cf9df..HEAD` 内没有变化。`78c5cf9df..HEAD` 里另一大块是 `origin/main` 上 PR 526 的合并（感知搜索、迁移等），它已在 `.agents/reviews/pr-526` 单独复核，本次只确认它是合并进来的同期代码，没有重读；`d5d173e9b` 与 `1ebf8a7a7` 相比的 PR 530 代码也没有出入。

读过：`export.ts` 的导出主流程、`snapshot.ts` 的 payload 可用性判断、`schemas.ts`/`verify.ts`/`import.ts` 的清单与 owner-proposals 校验、`data-export-owner-proposals.test.ts`、`check-data-export.mjs`、ADR 0272、ADR 0246 的 `amended_by`、`architecture-v0.1.md` 第 433 行、`production-proposals.ts` 中 basis/execution 载荷的生成路径，以及 `prompt-prefix.md`。

## 侧重检查

- **错误路径**：`snapshot.ts` 把 `!row`、`storage_kind !== "sqlite_blob"`、`ciphertext === null`、`deletion_pending`、`deleted_verified` 都标成 `{ unavailable: true }`（`packages/persistence-sqlite/src/data-export/snapshot.ts:353-361`）。`exportedText` 对 `undefined`、`unavailable`、`text === undefined` 返回 `null`（`export.ts:156-158`），新计数只包住这个返回值。
- **解密失败**：非受限引用在 `export.ts:121` 直接 `await read()`，`unprotect` 或 UTF-8 解码失败会抛出，整份导出失败，不会被计成“读不出”；限制引用在 `export.ts:123` 被 `catch` 成 null，但 proposal 的 basis/execution ref 由 `production-proposals.ts:384` 的 `${proposalId}:${digest}` 和 `:527` 的 `${proposalId}:x${digest}` 生成，正常不会和受限记忆的 ref 重合（未核实是否存在极端数据能让两者重合）。
- **不可信输入**：导入端用 `MANIFEST_SCHEMA` 重新校验清单（`verify.ts:367`），`omitted` 的 `what`/`count`/`reason` 有长度和类型限制（`schemas.ts:696-703`）；owner proposals 的 `basis`/`execution` 是 `nullableText`，null 被接受（`schemas.ts:274-275`、`verify.ts:148-169`）。新条目不会引入未校验的字段。
- **安全**：新 `omitted` 条目只含固定文案和数字，不含载荷 ref、密文或原文，不泄露秘密。
- **资源**：新增的是一个 O(1) 计数器和每行两次已有函数调用，没有新增数据库查询或整表读取。
- **不可撤销**：执行原样读不出时导出写 null，导入后撤销会因 `!execution` 报 `PROPOSAL_NOT_UNDOABLE`（`apps/agent-service/src/production-proposals.ts:749-752`）；这一点只由清单 `omitted` 文案提示，没有标到具体提议。
- **文档一致**：ADR 0272 的 `amends`、ADR 0246 的 `amended_by`、架构文档都补上了 v4；但清单原因文案和 ADR/架构/作者说明的“不可读”范围不一致，见下。

## 意见

### 1. 低 原因文案写“损坏”，但 ADR/架构只列“正在删除、已删除、不存在”，且解密失败实际会让整份导出失败

文件:行：`packages/persistence-sqlite/src/data-export/export.ts:858-859`

问题：清单里新增的 `omitted` 原因写“正在删除、已删除或损坏”。ADR 0272 决定 4 和架构文档只列“正在删除、已删除、不存在”，并明确写“载荷存在却解不开时，整份导出照常失败，不静默写空”。这会让人以为解密失败也会被静默计数。

证据（读代码证实）：

```ts
// export.ts:858-859
"库里的加密载荷已不可读（正在删除、已删除或损坏），导出里写成空；撤销用的原样丢了的提议导入后不能撤销",
```

```md
<!-- docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md:36 -->
依据或执行原样对应的加密载荷已不可读（正在删除、已删除、不存在）时，导出里这一项写 null……
载荷存在却解不开时，整份导出照常失败，不静默写空。
```

```md
<!-- docs/architecture-v0.1.md:433 -->
依据或执行原样的加密载荷已不可读（正在删除、已删除、不存在）时，导出里写空……
```

而代码对非受限引用是直接 `await read()`，失败就抛出（`export.ts:113-121`），不会计数。`snapshot.ts:353-361` 确实也会把 `storage_kind !== "sqlite_blob"`、`ciphertext === null` 标成不可用，所以“损坏”可能想指这类结构性损坏，但 ADR 没有这样写。第 2 轮曾把文案改成“不存在”并加断言 `expect(both?.reason).not.toContain("损坏")`（`8c2d72e81`），随后 `de124de4c` 又撤回并删掉断言。

建议：要么把原因文案改回“正在删除、已删除、不存在”；要么在 ADR 0272 和架构文档里明确写出“损坏”指存储方式不是内联或密文为空这类结构性不可读，并继续写明解密失败会让整份导出失败。作者说明第 1 条也应同步成同一口径。

### 2. 低 作者说明里的 `REQUIRED` 还是 140，最终代码是 141

文件:行：`scripts/check-data-export.mjs:19`

问题：作者说明写“`REQUIRED` 从 139 提到 140”，但最终分支已经是 141；如果按说明核对会以为多改了一条或数字不对。

证据（读代码证实）：

```js
// scripts/check-data-export.mjs:19
const REQUIRED = 141;
```

历史提交 `698494c5f` 是 139→140（新增第一条用例），`6457ad665` 是 140→141（新增第二条用例）；最终文件里也确实有两条带 `[P1-6]` 的新用例（`test/integration/data-export-owner-proposals.test.ts:294`、`:310`）。这是说明过时，不是代码错误。

建议：更新 PR 描述/作者说明为 141，并说明两条用例分别覆盖“依据/执行原样读不出”和“同一提议两项都读不出按 2 计”。

### 3. 低（检查缺口）新增反向用例只覆盖 `deleted_verified`，没有覆盖 `deletion_pending`、不存在的行，也没有覆盖“载荷存在但解密失败时整份导出失败”

文件:行：`test/integration/data-export-owner-proposals.test.ts:294-337`

问题：作者说明第 1 条把“正在删除、已删除、不存在”三种状态和解密失败都算进约束，但新增测试只把 `lifecycle_state` 改成 `deleted_verified`（`:298`、`:321`、`:330`）。`deletion_pending` 和不存在的行走的是同一类 `unavailable` 分支，风险低；解密失败走的是另一条会抛错的路径，新测试完全没有覆盖。

证据（读代码证实）：

```ts
// test:298 / 321 / 330
"UPDATE payloads SET lifecycle_state = 'deleted_verified' WHERE ref LIKE ..."
```

```ts
// export.ts:108,158
if ("unavailable" in payload) { ... continue; }
if (payload === undefined || "unavailable" in payload || text === undefined) return null;
```

```ts
// export.ts:113-121
const read = async () => decoder.decode(await options.protector.unprotect({...}));
...
texts.set(ref, await read());   // 非受限引用失败会抛出，整份导出失败
```

建议：补一条 `deletion_pending` 或删除 payload 行的用例；再补一条让 `protector.unprotect` 对 basis/execution 抛错、断言 `buildPortableExport` 整体拒绝而不是写 null 的用例。是否已有其他通用用例覆盖解密失败，未核实。

## 结论

第 1 轮提出的两条低问题确实改好了：依据和执行原样两处都经过 `ownerProposalText`（`export.ts:680-686`、`:713-714`），读不出时会计数并写进 `omitted`（`:854-860`）；ADR 0272 已新增，ADR 0246 的 `amended_by` 和架构文档已同步。第 2 轮增量把测试补成“同一提议两项都读不出算 2”，按种子数据核对 `2` 和 `5` 是正确的，没有发现新的行为错误。

本轮没有会出错的高/中问题。剩余的是原因文案与 ADR/架构/作者说明的口径不一致（低）、作者说明的 `REQUIRED` 数字过时（低）、以及解密失败/删除中/不存在路径的检查缺口（低）。测试没有实际运行，本结论基于读代码和种子数据推算。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。这段改动只在 `buildPortableExport` 里组装数据导出文件和清单（`export.ts:720-917`），没有组装或修改任何系统提示、工具定义、历史消息或遮盖结果，也没有新的模型调用。发给模型的内容仍然只在末尾追加、每轮变化值只在最后一条消息里——这一点没有被本改动触碰。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及模型请求。新增的 `count` 和 `reason` 只取决于当前数据库状态和固定文案；同一数据库状态下重复导出，条目内容和追加位置相同。导出清单本来就有 `exportedAt`（`now`），但那是导出元数据，不是模型输入，也不是本轮新增。

3. **有没有对应自动检查，反向用例真的会失败吗？** 有。`test/integration/data-export-owner-proposals.test.ts:294` 和 `:310` 是两条 `[P1-6][reverse]` 用例，`scripts/check-data-export.mjs:19` 把门槛提到 141。读代码可以确认：如果去掉计数和 `omitted.push`，`manifest.omitted.find(...)` 返回 `undefined`，`entry?.count` 不等于 1/2/5，用例会失败；如果错误地把 null ref 也计数，第一条用例末尾“干净导出没有该条目”的断言会失败；如果按提议而不是按文字项计数，第二条用例的 `2` 和 `5` 会失败。测试未实际执行；另外如意见 3 所述，删除中/不存在/解密失败三条路径没有各自的用例。

4. **每个新值的生产端和消费端都能接受吗？** 能。生产端是 `export.ts:854-860` 的 `{ what, count, reason }`；消费端：`MANIFEST_SCHEMA` 接受 `what` 1–512 字符、`count` 非负整数或 null、`reason` 1–512 字符（`schemas.ts:696-703`），导入前 `verify.ts:367` 会用该 schema 校验；`admin-cli` 只是把 `manifest.omitted` 原样输出（`apps/admin-cli/src/data-command.ts:201`），`production-data-export.ts:339` 只按固定 label 查另一条条目，不受影响。owner proposals 文件里的 `basis`/`execution` 为 null 也符合 `nullableText`（`schemas.ts:274-275`），导入端接受 null 并把提议写入空表（`import.ts:362-389`）。本轮没有新增导出的函数、配置键或序列化格式；测试里的 `pid(6)` 只在该测试内使用，`REQUIRED` 只被检查脚本自己读取。

**作者说法核对：** 第 1 条基本成立但不完整——除 `deletion_pending`/`deleted_verified`/不存在外，`snapshot.ts:353-361` 还把非 `sqlite_blob` 存储和 `ciphertext === null` 算作不可用；对非受限引用，解密失败会让整份导出失败，但受限引用在 `export.ts:123` 会被吞掉（proposal ref 正常不会命中，属推测/未核实）。第 2 条成立：`ref === null` 直接返回 null（`export.ts:682`），干净导出用例也覆盖了没有依据/执行原样的提议。第 3 条成立：每调用一次 `ownerProposalText` 计一次，`export.ts:713-714` 两处都调用，同一提议两项都读不出计 2。作者说明中的 `REQUIRED` 数字与最终代码不一致，见意见 2。
