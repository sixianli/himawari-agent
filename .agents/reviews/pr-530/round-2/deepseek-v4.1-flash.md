结论：本轮增量里没有发现会改变模型请求、或会直接造成导出/导入数据错误的中高严重度问题；上一轮第 3 条（v4 归因）已按代码核对改好。发现三条低严重度问题，主要是测试覆盖缺口和作者说明/文案与代码不一致。

### 1. 低 | 新增反向用例无法证明“同一条提议依据和执行原样都读不出算 2”，按提议计数也能通过这两个断言

文件：`test/integration/data-export-owner-proposals.test.ts:310-329`（种子在 `:105-120`）

问题：用例先删所有 execution 载荷，断言计数为 1；再删所有 basis 载荷，断言计数为 3。但种子数据里 pid1 只有 basis、pid2 只有 execution、pid3 两者都没有、pid4 只有 basis，没有任何一条提议同时有两项。若实现改成“每条提议只要有一项读不出就 +1”，第一步仍是 1（只有 pid2），第二步仍是 3（pid1、pid2、pid4），两个断言照样通过。因此该用例没有守住作者说法 3 的“同一提议两项都读不出算 2”。

证据：

```ts
await seed(source, { id: pid(1), basis: "依据：主人说过早上才看提醒" });
await seed(source, {
  id: pid(2),
  status: "accepted",
  execStatus: "succeeded",
  execution: '{"original":"2026-11-12T00:00:00.000Z"}',
  ...
});
...
await seed(source, { id: pid(4), basis: SECRET_TEXT });
```

```ts
expect(only?.count).toBe(1);
...
expect(both?.count).toBe(3);
```

而实现确实是对每个字段单独调用：

```ts
basis: ownerProposalText(basisRef, ownerProposalBasisKey(id)),
execution: ownerProposalText(executionRef, ownerProposalExecutionKey(id)),
```

建议：新增一条同时带 basis 和 execution 的提议，删掉这两项后断言该条贡献 2；或直接按 proposal id 断言每个条目贡献的计数。这样反向用例才能区分“按文字项计数”和“按提议计数”。

### 2. 低 | `omitted` 原因里的“损坏”与 ADR 和作者说法“解密失败整份导出失败”不一致

文件：`packages/persistence-sqlite/src/data-export/export.ts:858-859`；对照 `docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md:36`

问题：写进清单、给主人看的原因是“库里的加密载荷已不可读（正在删除、已删除或损坏），导出里写成空”。但 ADR 和作者说法 1 都写“载荷存在却解不开时，整份导出照常失败”。读代码证实，非受限载荷解密失败会直接抛出，不会写空：

```ts
if (!restrictedRefs.has(ref)) texts.set(ref, await read());
else {
  const text = await read().catch(() => null);
  if (text === null) unreadableRestricted += 1;
  else texts.set(ref, text);
}
```

被 `.catch(() => null)` 吞掉解密错误的只有 `restrictedRefs`，而 `restrictedRefs` 只来自受限记忆的当前正文、历史正文和原话（`snapshot.ts:79-94`），正常不会与提议的依据/执行原样引用重合。

推测：如果“损坏”指的是 `storage_kind !== "sqlite_blob"` 的文件后端载荷，那么 `snapshot.ts:353-360` 会把它标记为 `unavailable`，导出写成 null 并计数，即使文件本身可读。不过当前生产组合使用的是 SQLite 内置存储（`durable-adapters.ts:314-319`、`sqlite-durable-operations.ts:1830-1846`），`HybridPayloadStore` 只见于测试，所以这条暂时是潜在问题，不是本轮可触发的故障。

建议：把原因文案改成与 ADR 相同的“正在删除、已删除、不存在”，或者在 `snapshot.ts` 支持文件后端载荷后再保留“损坏”的说法，免得主人以为所有损坏载荷都只是被计数。

### 3. 低 | 作者说明里的 `REQUIRED` 数字与当前提交不一致：说 139→140，实际 139→141

文件：`scripts/check-data-export.mjs:19`；新增用例在 `test/integration/data-export-owner-proposals.test.ts:294` 和 `:310`

问题：作者说明写“`REQUIRED` 从 139 提到 140”“新增用例”（单数）。当前提交的实际值是 141，而且从基线 `a87954` 到 `78c5cf9` 新增了两个 `[P1-6][reverse]` 用例：一个测 basis，一个测 execution/两项汇总。因此这份说明少记了一个用例和一次门槛提升。

证据：

```js
const REQUIRED = 141;
```

如果作者说明只针对第 1 轮的 `698494c5`，140 是对的；如果它描述的是当前 PR 530 的最终状态，就与代码不符。

建议：更新作者说明为“新增两个用例，`REQUIRED` 从 139 提到 141”，避免复核记录和实际门槛错位。

**读代码证实的**

- 增量没有改 `FORMAT_VERSION`；基线 `a87954` 的 `schemas.ts` 已经是 `himawari.data-export.v4`，v4 由更早的 commit `4740a0c73`（PR 527）引入。
- `ownerProposalText` 同时包住了 `basis` 和 `execution` 两处；引用为 null 时提前返回、不计数；只有 `exportedText` 返回 null 时 `unreadableOwnerProposalTexts` 加一。
- `omitted` 条目只在计数大于 0 时追加，`what`/`reason` 长度远小于 `MANIFEST_SCHEMA` 的 512 上限，`count` 是整数。
- `manifest.omitted` 的消费端：`verify.ts` 只按 schema 校验，不枚举 `what`；`admin-cli/src/data-command.ts:201` 原样输出；`production-data-export.ts:339` 只查找 `SHORT_TEXT_OMISSION_LABEL`，不受新条目影响。
- `docs/adr/0246` 的 `amended_by` 加了 0272 后，`check-adr-numbers.mjs` 的 `ADR_PATH_MENTION` 能分别匹配两个 `docs/adr/*.md` 路径，两份文件都存在；ADR 0272 的文件名、标题编号、链接目标也符合该脚本的检查规则。
- 上一轮第 3 条已改好：`docs/architecture-v0.1.md:433` 现在写“提议箱进入导出时格式升到 v4”，不再把 v4 归因于“读不出写空”；ADR 0272 背景也改为“这张表已经进了数据导出，本 ADR 补记那次的格式决定”。

**推测**

- 文件后端载荷（`ciphertext_file`）目前不会被数据导出读取，若将来生产启用该存储方式，提议的依据/执行原样会被当作不可读写空；这是旧快照逻辑的边界，不是本次增量直接引入，但会让 `omitted` 原因里的“损坏”说法变得有实际影响。
- 受限记忆引用与提议依据/执行引用发生全局 id 碰撞时，解密失败会被吞掉并计数而不是让整份导出失败；`payloads.ref` 是全局主键，正常写入路径不会产生这种碰撞，未找到实际触发路径。

**本轮查过的范围**

- 增量 `dab825db..78c5cf9`：`docs/adr/0272`、`docs/adr/0246`、`docs/architecture-v0.1.md`、`scripts/check-data-export.mjs`、`test/integration/data-export-owner-proposals.test.ts`，以及 `.agents/reviews` 下的记录文件（记录文件未读，git 拒绝了该路径）。
- 为核对作者说法的旧代码：`export.ts:93-235, 680-716, 775-866`、`snapshot.ts:55-125, 300-378`、`schemas.ts` 的 `FORMAT_VERSION`/`OWNER_PROPOSAL_SCHEMA`/`MANIFEST_SCHEMA`、`import.ts:355-389`、`verify.ts:148-169, 460-515`、`admin-cli/src/data-command.ts:175-203`、`production-data-export.ts:315-345`、`check-adr-numbers.mjs`。
- 没有运行任何测试命令（本轮工具限制），因此 `REQUIRED=141` 的实际通过数、以及新用例是否全绿未核实；以上结论来自代码和 diff 阅读。

**侧重检查**

- 错误路径：依据/执行原样引用为空时不计数；载荷不可用（不存在、正在删除、已删除、存储种类不是 `sqlite_blob`、密文为空）时写 null 并计数；非受限载荷解密失败时导出抛错；受限载荷解密失败被吞掉并分别计入 `unreadableRestricted` 和新增计数（碰撞时才影响提议计数）。结论：正常路径符合作者说法 1/2/3，边界存在上述潜在问题。
- 不合规范或不可信输入：新增的 `what`/`reason` 是固定文字，不接受外部输入；提议正文仍走原有的机密检查和封存流程，没有引入新的不可信解析。
- 安全：没有新增密钥、口令或日志输出；计数和固定文案不含敏感内容；封存原文逻辑未改。
- 资源耗尽：只增加一个整数计数器和一条固定长度清单项，没有额外读取载荷或按提议数量之外的放大。
- 不可撤销的操作：导出路径是只读的，没有新增写入、删除或状态迁移。
- 规则/文档一致性：v4 归因已修正；`REQUIRED` 数字说明和“损坏”文案存在不一致，见上面第 2、3 条。

**必答问题**

1. 不涉及。增量只改 ADR/架构文档、检查脚本门槛和集成测试，没有改系统提示、工具定义、历史消息或遮盖代码，也没有新增发给模型的内容；不存在“只在末尾追加”或“每轮变量放在最后一条消息”被破坏的地方。`export.ts` 的计数改动在增量基线之前，同样不进入模型请求。
2. 不涉及模型请求，也不会让同一段导出文字在不同请求里变成不同字节。新增的 `omitted` 条目在固定位置追加，内容由数据库当前状态确定，不依赖时间、对象遍历顺序或不可排序集合；对同一数据库重复导出仍走原有的确定性序列化。原有“同一数据库导出两次字节一致”的用例没有运行，未核实本轮执行结果。
3. 有对应自动检查：新增的两个 `[P1-6][reverse]` 用例覆盖 basis 和 execution 读不出时写 null 并计数，去掉 `ownerProposalText` 的计数后第一个断言会得到 undefined，确实会失败；`scripts/check-data-export.mjs` 的门槛也提高到了 141。但“同一提议两项都读不出算 2”没有被测试真正区分，见意见 1；测试是否全绿因不能运行而未核实。
4. 逐个值核对：`REQUIRED=141` 只被 `check-data-export.mjs` 自己使用；新的 `omitted` 条目通过 `MANIFEST_SCHEMA`（`what` 1–512、`count` 可空非负整数、`reason` 1–512），`verify.ts` 不枚举 `what`，admin CLI 原样输出，生产导出只按 `SHORT_TEXT_OMISSION_LABEL` 取值，都能接受；ADR 0246 的 `amended_by` 逗号列表被 `check-adr-numbers.mjs` 的正则分别匹配到两个存在的路径；`seeded(name)` 的默认参数保持原有调用兼容。未发现使用端拒绝新值的路径。
