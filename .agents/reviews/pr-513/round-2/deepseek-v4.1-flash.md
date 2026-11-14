## 范围与结论

本轮只核对增量 `6c2772d..cfbcf9c`：`apps/agent-service/src/owner-intent-gate.ts` 与 `test/integration/tool-action-registry.test.ts` 的改动（`.agents/reviews/**` 为评审记录，按规则不作为代码评估）。为核对证据跟进了：`packages/application/src/ports/persistence.ts`、`packages/persistence-sqlite/src/sqlite-worker.ts` 的 `replayExisting`/`commitStateAndEvents`、`durable-adapters.ts` 与 `sqlite-durable-operations.ts` 的审计写入、`ports/observability.ts` 的 `AuditRecord`、`owner-scope-authorization.ts:219` 调用点、`production-runtime-tools.ts:687-707` 错误处理、ADR-0257 第 233 行、以及新测试的 setup。未整份重读未被增量触及的旧代码。

**上一轮第 1 条（中高）已真正修好。** 依据：`confirm` 现在返回 `this.#record(...)`（`owner-intent-gate.ts:111`），`#record` 写完冲突后会回读持久记录并用 `persisted.value["confirmed"]` 作为返回值与审计结果（`:203-221`）。我按并发两种先后次序推演（A 真/B 假、B 假/A 真）：后写者 `commitStateAndEvents` 抛 `PORT_CONFLICT`（`sqlite-worker.ts:627-640` 的 `replayExisting` 对指纹不同直接 `applicationFailure`；或 `:760-771` 的 revision 冲突），被 `.catch` 吞掉后回读到先写者的不可变记录，返回值和审计都取自该记录，动作与记录不再相反。竞争条件只在同一 key 首次写入时发生，之后 `:108-109` 直接读记录，记录不会被覆盖，因此不存在“读完记录后又变”的窗口。

## 意见

### 1. 低 · 吞掉所有持久化错误并用笼统的 `OWNER_INTENT_RECORD_MISSING` 代替，丢失真正的失败原因
文件：`apps/agent-service/src/owner-intent-gate.ts:202、208`

问题：`.catch(() => undefined)` 会把 `PORT_NOT_AUTHORITATIVE`（权威栅栏丢失）、磁盘余量不足、`PORT_INVALID_OPERATION` 等**所有**提交错误一并吞掉，随后若回读不到记录就抛一个普通 `Error("OWNER_INTENT_RECORD_MISSING")`。改动前这些错误会原样抛出。结果的安全语义仍是失败关闭（`production-runtime-tools.ts:687-707` 的 `#ownerScopeGate` 捕获任意异常并转成 `DENY / authorization_component_error`），但诊断里 `cause` 只能记成 `"Error"`，原本可区分的 `PORT_*` 原因丢失。

证据：
```ts
202:      .catch(() => undefined);
203:    const persisted = await state.readScopedState(
...
208:    if (!persisted) throw new Error("OWNER_INTENT_RECORD_MISSING");
```
```ts
690:        const cause =
691:          error instanceof ApplicationPortError
692:            ? error.code
693:            : error instanceof Error
694:              ? error.name
695:              : "unknown";
```

建议：只吞掉真正的并发/重放冲突（`PORT_CONFLICT` 中指纹或 revision 冲突、`PORT_DUPLICATE`），其它错误保留原样抛出；或在 `OWNER_INTENT_RECORD_MISSING` 上挂 `{ cause: error }`，并补一个“提交失败且无记录”的测试断言其被转成 DENY 而非放行。

### 2. 低 · 新增竞争用例只注入了“竞争的提交”，没有覆盖本次修复针对的审计去重路径
文件：`test/integration/tool-action-registry.test.ts:1164-1199`、`apps/agent-service/src/owner-intent-gate.ts:212-220`

问题：用例是在闸门自己的 `commitStateAndEvents` 里抢先写一条 `confirmed:false` 的记录，只验证了“动作跟随先写记录”。这次改动同时把审计 id 改成只含意图编号（`:213`）、`occurredAt` 改成记录里的时间（`:210-211,219`），目的是让两个真实并发 `confirm`→`#record` 都追加**同一条**审计而不因 id/时间不同报错；但用例并未制造两个 `#record` 都执行 `appendAuditRecord` 的场景，`appendAuditRecord`（`owner-policy-authorization.ts:20-33`）的“重复且内容相同则容忍”分支没有被覆盖。此外“提交失败且无记录”这条新错误路径也没有测试（现有 `markFaults` 只作用于 ownerScope 的 `markState`，闸门用的是直连 `repository`，见 `:144` 与 `:166`）。

证据：
```ts
1170:    vi.spyOn(s.repository, "commitStateAndEvents").mockImplementation(async (input) => {
1171:      if (input.command.commandType === "authorization.owner_intent.checked" && !raced) {
...
1180:        });
1181:      }
1182:      return original(input);
```
```ts
213:      id: `owner-intent:${digest([input.intent.id])}`,
219:      occurredAt: recordedAt,
```

建议：再加一个用例，让两次 `confirm` 真正并发（或用可控闸门让两个 `#record` 都进入 `appendAuditRecord`），断言最终只有一条 `authorization.owner_intent.checked` 审计、其 `outcome`/`occurredAt` 与持久记录一致；并补提交失败且读不到记录的用例。

### 3. 低（推测，需脏数据） · `checkedAt` 非字符串时两个后写者会各自回退到本地时间，导致同 id 审计内容不同而报重复
文件：`apps/agent-service/src/owner-intent-gate.ts:210-219`

问题：审计 id 现在对同一意图是固定的，`occurredAt` 优先取持久记录的 `checkedAt`。如果竞争产生的记录里 `checkedAt` 不是字符串（脏数据/旧格式/被其它写入者破坏），两个并发的 `#record` 会各自用本地的 `checkedAt`，于是同一个审计 id 携带不同的 `occurredAt`；`appendAuditRecord` 发现“重复但内容不同”会重新抛错，其中一个请求被 DENY。这是条件性的，仅在记录缺字段时成立，正常写入者（本文件）总会写 `checkedAt`。未找到其它写 `owner-intent-check:` key 的代码。

证据：
```ts
210:    const recordedAt =
211:      typeof persisted.value["checkedAt"] === "string" ? persisted.value["checkedAt"] : checkedAt;
```
```ts
28:    if (
29:      !existing ||
30:      !(Object.keys(record) as (keyof AuditRecord)[]).every((key) => existing[key] === record[key])
31:    )
32:      throw error;
```
建议：要么在回退时也以持久记录的稳定信息（如 `intentId`）为准、不把本地时间写进审计；要么对“重复但仅时间不同”的审计做幂等处理；至少加注释说明该回退的假设。

## 侧重检查

- **错误路径**：已查 `.catch` 吞错→回读→`OWNER_INTENT_RECORD_MISSING`→`#ownerScopeGate` 统一转 DENY（`production-runtime-tools.ts:687-707`）。结论：失败关闭，无放行风险；问题仅是可诊断性（意见 1）。
- **不可信/不合规范输入**：回读值用 `persisted.value["confirmed"] === true` 严格判定，非布尔值一律当 false；`checkedAt` 做字符串类型校验后才使用。结论：对畸形记录是失败关闭。
- **安全**：记录写入后不可变（同 key 仅 `expectedRevision:null` 首次创建，后续早退），动作判定取回读值，消除了动作与记录相反；无新增外发或不可撤销操作。
- **资源耗尽**：并发下仍可能各自调用一次 `check.check`（增量前已如此），增量未新增循环或无界重试；仅多一次回读。
- **规则/文档一致性**：ADR-0257 第 233 行写“同一个动作意图只写一次；写不进去也不影响结果（再读一次，读不到才报错）”，与 `#record` 新行为一致；`owner_intent_confirmed` 事实与内置规则未在增量中改动。
- **产生/修改值的消费端（I-73）**：`confirm` 的布尔返回只被 `owner-scope-authorization.ts:219` 使用（`if (... confirm(...))`），类型未变。审计 id 仍为 `owner-intent:<sha256 十六进制>`；后端表 `audit_records.id TEXT PRIMARY KEY`（`0001_initial_product_schema.sql:287-296`）、`outcome` 的 CHECK 含 `completed`/`rejected`、`occurred_at TEXT NOT NULL`，新值均能通过。`occurredAt` 类型为 `string`（`observability.ts:116`）。新的 `OWNER_INTENT_RECORD_MISSING` 字符串由 `#ownerScopeGate` 兜底，无专用错误码依赖。

## 必答问题

1. **是否改变模型已见过的请求开头？** 不涉及。增量只在授权闸门读/写作用域状态与审计，返回布尔给 `owner-scope-authorization.ts:219` 决定是否加 `owner_intent_confirmed` 事实；不发往模型，不触碰 system、工具定义、历史消息或遮盖结果。模型请求仍只在末尾追加、变动值在最后一条消息，这一点在增量路径上没有被改变。
2. **同一段文字会不会变成不同字节？** 对模型请求不涉及。增量新增的 `checkedAt` 是持久化/审计时间字段，不进入模型请求；写入的 `externalSources` 在 `owner-scope-authorization.ts:252` 已 `sort()` 去重；审计 id 现在对同一意图确定。故模型可见字节无新增非确定性。
3. **有无自动检查、反向用例是否真会失败？** 有新集成用例（`tool-action-registry.test.ts:1164-1199`）。按旧代码推演：旧 `confirm` 返回 `result.confirmed=true`，动作会继续执行、`reminders` 会被调用，而用例断言 `awaiting_approval` 且 `reminders` 未调用，因此旧代码下该用例会失败、新代码下通过——反向用例逻辑上成立。**未实际运行测试**（只读环境，无法执行），也未核实新增测试是否覆盖意见 2、3 的场景（结论：不覆盖）。
4. **每个产生/修改的值，使用端都能接受吗？** 逐项核对：`#record` 返回类型 `void→boolean` 仅内部使用；`confirm` 返回布尔消费端只有 `owner-scope-authorization.ts:219`，可接受；审计 `id` 仍符合 `TEXT PRIMARY KEY` 且 `appendAuditRecord` 能处理重复相同记录；`occurredAt` 为字符串，满足 `TEXT NOT NULL`；`outcome` 仅在 `completed`/`rejected` 间切换，满足 CHECK；新的错误串被上层兜底为 DENY。唯一需要注意的接受端是 `appendAuditRecord` 的“重复但内容不同即抛错”，在正常不可变记录下不会触发，脏数据下见意见 3。
