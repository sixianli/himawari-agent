## 发现（按严重度）

### 1. 【读代码证实】中：一次性字样表会误伤合法的长期说法，同时仍漏掉其他“只指这一次”的说法

文件：`apps/agent-service/src/production-owner-rules.ts:78-96`、`:252-258`

```ts
const ONE_OFF_MARKERS = [
  "这封", "这一封", "这条", "这次", "这回", "本次",
  "今天", "今晚", "この", "今回", "今日", ...
].map(foldText);
...
return (
  STANDING_MARKERS.some((marker) => folded.includes(marker)) &&
  !ONE_OFF_MARKERS.some((marker) => folded.includes(marker))
);
```

只要整句里出现任意一个一次性词，即使同时有“以后/每次/必须”，也一律不算明说。例如主人说“从今天开始，以后每次收到入管局的邮件都必须提醒我”，或“这条规矩以后每次都执行”，都会被降级成提议，和 ADR 第 61 行“明说的直接生效”不一致。反过来，“刚才那封必须提醒我”“此邮件必须提醒我”没有命中表里的词，仍会被当成长期规则直接生效。

建议：按子句判断，只有“一次性词所在子句没有持续语义”时才否决；至少把“今天开始/从今天起/这条规矩”排除，并补齐“此次/这一次/此邮件/刚才那封”等常见指代；同时加正向用例“从今天开始，以后每次……”必须直接生效。

### 2. 【读代码证实】中：撤销跨两个存储、非原子；`latest` 读不到时仍谎报已停用

文件：`apps/agent-service/src/production-owner-rules.ts:671-692`

```ts
if (current.sourceMemoryId) await this.#archiveMemory(current.sourceMemoryId as MemoryId);
const latest = await this.#options.rules.read({ ...this.#scope(), ruleId });
if (latest && latest.status !== "retired") {
  const changed = await this.#options.rules.setStatus({ ..., expectedRevision: latest.revision, ... });
  if (!changed) throw new OwnerRuleError("RULE_UNAVAILABLE");
}
return Object.freeze({ ..., status: "retired", enforced: false, ... });
```

归档会先触发数据库触发器，把规则改成 `needs_review` 并加版本号（`0087_rule_book_memory_link.sql:301-360`），而 `needs_review` 仍然照常执行。此后若 `setStatus` 失败或进程崩溃，就会长期停在“记忆已归档、规则仍在执行”的状态；重试能修好，但没有自动对账。更糟的是 `read` 返回 `undefined` 时直接跳过停用，却仍返回 `status: "retired"`，界面会显示已撤销而实际规则还在。

建议：`latest === undefined` 应该抛错而不是返回成功；给撤销加可重试的待办/对账（或至少把“归档后未停用”作为可检测状态），并补失败注入测试。

### 3. 【读代码证实】中低：`reconfirm` 不检查、不恢复出处记忆，会留下“规则 active、出处记忆 archived”

文件：`apps/agent-service/src/production-owner-rules.ts:621-648`

```ts
const changed =
  current.status === "needs_review"
    ? await this.#options.rules.setStatus({ ..., status: "active", ... })
    : current;
```

`reconfirm` 只改规则状态，完全没碰 `sourceMemoryId`。如果记忆被归档（例如第 2 条的部分撤销、或主人在记忆页归档），触发器会把规则置为 `needs_review`；此时点“重新确认”，规则会回到 `active`，但出处记忆仍然是 `archived`，与“规则和规则类记忆一起恢复”的预期不一致。

建议：`reconfirm` 先读取 `sourceMemoryId` 对应记忆，`archived/trashed` 时先 `recover`，失败就拒绝确认；或明确禁止这种确认路径并返回可解释错误。

### 4. 【读代码证实】中低：新增的记忆恢复逻辑没有会失败的反向用例

文件：`test/integration/production-memory-capture.test.ts:1894-1903`

```ts
await command(..., { target: proposal["proposalId"], action: "confirm" }, "confirm-again");
expect((await listed()).find(({ ruleId }) => ruleId === confirmed?.ruleId)?.status).toBe(
  "active",
);
```

撤销后再确认只断言了规则状态，没有断言 `confirmed` 的 `sourceMemoryId` 已经回到 `active` 且内容可读。把 `production-owner-rules.ts:404-405` 的 `recover` 整段删掉，这个测试仍然通过。作者“撤销后再确认会恢复规则和记忆”的说法，代码实现了，但没有自动检查兜住。

建议：确认后重新读取该 `memoryId`，断言 `status === "active"` 和内容仍为原话；再补一个 `trashed` 的恢复用例。

### 5. 【读代码证实】低：`#archiveMemory` 吞掉了 `INVALID_OPERATION/NOT_FOUND`，与“归档失败就报错”不完全一致

文件：`apps/agent-service/src/production-owner-rules.ts:655-663`

```ts
if (error instanceof ApplicationPortError &&
    (error.code === PORT_ERROR_CODES.INVALID_OPERATION ||
     error.code === PORT_ERROR_CODES.NOT_FOUND))
  return;
```

记忆是 `trashed` 时，`archive` 的 `deactivate` 会抛 `INVALID_OPERATION`，这里直接当成功，随后规则照常停用。结果不是危险方向，但 ADR 第 61 行“归档失败就报错”对这种情况不成立；记忆也不会真的变成 `archived`。建议区分“已经归档/已删除”和真正的失败，至少记录日志或返回说明。

### 6. 【读代码证实】低：`validRuleSummary` 的长度口径与工具 schema、ADR 文案不一致

文件：`packages/application/src/rules/rule-types.ts:248-255`、`apps/agent-service/src/production-owner-rules.ts:158`

```ts
trimmed.length > 0 &&
trimmed.length <= OWNER_RULE_SUMMARY_LIMIT &&
```

`summary.length` 数的是 UTF-16 码元，工具 schema 的 `maxLength: 200` 按 JSON Schema 的码点计，ADR 写“最多 200 个字”。于是 101 个 emoji 在工具 schema 看来只有 101 个码点、可以发送，但服务端按 202 个码元拒绝；新增测试还把“100 个 emoji 通过”固化了。软偏好原先用 `Array.from(summary).length`，这次统一成码元后行为也变窄了。

建议：统一用码点（`Array.from(...).length`）并同步工具 schema 与文档，或明确把限制写成“UTF-16 长度”并让 schema 别放宽。

### 7. 【推测】低：`#writeMemory` 只恢复 `archived/trashed`，`deletion_pending/deleted_verified` 会带着将消失的记忆建规则

文件：`apps/agent-service/src/production-owner-rules.ts:404-405`；`packages/application/src/services/durable-memory-service.ts:391-396`

```ts
if (written.status === "archived" || written.status === "trashed")
  await this.#options.memory.recover(memoryId, generation);
```

`recover` 本身只接受 `trashed/archived`。如果主人在记忆页把这条规则记忆删到 `deletion_pending`，随后确认同一提议，`applyProposal` 会返回 `deletion_pending`，这里不恢复也不报错，规则仍会被创建/复活；删除完成时 `memory_rule_needs_review_on_delete` 再把规则改成 `needs_review`。这是边界路径，未实跑，标为推测。

### 8. 【读代码证实】低：同参数去重命中时，回执里的 `quote` 和 `summary` 可能来自不同提议

文件：`apps/agent-service/src/production-owner-rules.ts:450-462`

```ts
return Object.freeze({
  ...,
  ruleId: same.ruleId,
  summary: summaryOf(same.parameters).summary,
  quote: proposal.quote,
  ...
});
```

去重键现在是“类型+参数”，不含说明和原话；两句话参数相同但说明不同时，第二次确认返回第一条规则的 summary，却带回执里的新 quote。不是执行错误，但主人看到的回执可能自相矛盾。建议回执统一使用既有规则的 quote/summary，或明确只返回既有规则。

---

## 侧重检查

- 不可信/不合规输入：`quote`、`summary`、`type`、`params` 的写入校验、`confirm` 的 proposalId 正则、`undo/reconfirm` 的 ruleId 前缀和长度都看过了；`params` 只接受声明字段、拒不可见字符和正则，未发现新越权路径。粘贴别人的话仍会被当成主人原话，ADR 已承认，不是新问题。
- 错误路径：重点核了撤销的归档失败、归档后停用失败、`latest` 缺失、确认后的 `recover/revive` 失败；发现第 2、3、5 条问题。并发只做了代码推演，未实跑多请求交错。
- 资源耗尽：`MESSAGES_SCANNED=200` 在 `listMessages` 的 1..1000 限制内（`sqlite-thread-operations.ts:1389-1392`），真正解密的只有最近 6 条主人消息，单项上限 500 字，未发现新的明显放大。
- 不可撤销操作：规则写入/撤销都能通过再次确认或撤销恢复，没有物理删除；但撤销不是原子操作，见第 2 条。
- 规则/文档/代码一致性：ADR 0213:61 与实际实现对过；发现一次性字样表、归档失败语义、摘要长度口径、恢复测试覆盖四处不完全一致。
- 未核实：`.agents/reviews/pr-380/round-2/judgments.md` 本次读不到；SQLite 触发器在真实并发交错下的行为未实跑；`prompt-manifest.json` 的 sha256 是否正确未重算（但有 `prompt-catalog.unit.test.ts` 的清单校验兜底）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？

不会改变**已经发出**的历史。这个增量唯一会进模型请求头的是 `TOOL_RULE_SET.text` 的静态文字（`packages/prompt-catalog/src/tools.ts:231`），而 `.claude/rules/prompt-prefix.md:41-43` 规定系统提示和工具按对话冻结：改提示词文字只对新对话生效，老对话要手动 rebuild。本轮新增的一次性判断、摘要校验、去重键、扫描窗口都只在写入/判分时使用，不会改写历史。

会变的值仍然都在追加的消息/工具结果里：`ruleId`、`proposalId`、`quote`、`summary`、`updatedAt` 都出现在工具返回或回执中，没有进入系统提示或工具定义。需要注意两点：一是本 PR 整体新增了三个工具，老对话会在下一轮按 ADR 0165 换新一次（ADR 0213 前提 4 已接受）；二是改提示词文字后，老对话里冻结的旧文字不再在固定文字清单里，按 `prompt-prefix.md:53` 可能让遮盖字节变化一次，属于规则已写明的代价。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

没有发现新的不确定性。新逻辑都只依赖输入本身：`foldText`、`clausesOf` 是纯函数；proposalId 由 ownerId、归一化后的 `type/params`（数组已排序）、`summary`、`quote` 计算，不含时钟、随机数或数据库返回顺序。规则的 `list` 有 `ORDER BY updated_at DESC, rule_id`，也是确定的。

唯一相关的字节变化是第 1 条回答里的固定文字清单变化（旧冻结文字可能从“固定文字”退化成“外来内容”），这是 `prompt-prefix.md:53` 已记录的例外，不是本次新引入的每轮变化。

### 3. 有没有对应的自动检查？反向用例会不会真的失败？

有，但不齐。

会失败的：
- 一次性整句：`test/integration/production-memory-capture.test.ts:1855` 的 `"whole one-off clause"` 期望 `proposed`；去掉一次性检查会变成 `active`，测试失败。
- 摘要 U+2028 和长度：`packages/application/test/rule-type-mail-read-whole-thread.unit.test.ts:97-99`；去掉 Zl/Zp 或长度检查会失败。
- 提议去重：`production-memory-capture.test.ts:1866-1871`；把 proposalId 改回只含类型和参数会从 5 变 1，测试失败。
- 撤销时重新读版本号：撤销用例本身会失败，因为归档触发器已经把 revision 加一，不重读就会 `RULE_UNAVAILABLE`。

不会失败的：
- 记忆恢复：撤销后再确认只断言规则 `active`，删掉 `recover` 仍然通过（第 4 条）。
- 撤销的失败/并发路径没有注入用例。
- “从今天开始，以后每次……”这类合法长期说法没有正向用例。
- live eval 需要 `EVAL_CONFIRM_COST>0` 和外部网关，默认 `CAP_USD=0` 会直接失败，不属于常规 CI；它也没有对齐软偏好的 `validRuleSummary` 校验。

### 4. 每个新值/改动的所有使用点都能接受吗？

- `MESSAGES_SCANNED=200`：`listMessages` 限制是 1..1000，接受；取 `messageWatermark-200` 再 `sequence >` 的语义也对。
- `proposalId` 新格式仍是 `rule-proposal:` + 32 位十六进制：`confirm` 的正则、网关的 `machineString`、测试的正则都接受；长度 46，载荷引用也没超限。
- proposal 载荷现在多了 `quote/summary` 参与哈希，但载荷结构没变，`confirm` 仍能解析。
- `validRuleSummary` 已从 `packages/application/src/rules/index.ts` 导出，writer 和 `parseOwnerRuleParameters` 都引用同一个实现；软偏好和非软规则现在走同一校验，符合“统一校验”的说法。
- writer 选项新增 `recover`：`DurableMemoryService` 确实有该方法（`durable-memory-service.ts:387`），生产组合传的是完整 memory 服务，类型能接受。
- 不一致的地方：摘要长度的 UTF-16/码点口径（第 6 条）、读路径上的 Zl/Zp 新校验（当前 PR 新功能，旧数据风险低，未核实生产是否已有此类行）、`reconfirm` 没有对应的记忆状态校验（第 3 条）、以及撤销时吞掉的归档错误码（第 5 条）。
