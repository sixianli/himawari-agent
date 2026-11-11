# 复核报告（f7c79dd，对比 cb56223）

总体结论：没有发现高危问题。核心选择逻辑、决策记录、去重和记忆页提示与验收 1～4 基本对应；主要问题集中在**文档与代码不一致**、**置顶保证在“改过类别”的记忆上不成立**，以及**反向测试的边界覆盖不足**。

## 一、读代码证实的问题

### 1. 中：决策记录写入约定文档没有同步，且该文档明确要求新增字段时必须先改它
- 文件:行：`docs/execution/specs/2026-11-09-decision-record-write-convention.md:35`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:130-136`；`packages/application/src/ports/decision-ledger.ts:95,253`
- 问题：约定文档仍写着“其他种类只落 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds` 四个键，其余字段在入库前被丢掉”，并且说 `context_truncation` 走 `DecisionLedgerPort.append`。改动实际已让 `insertLedgerRow` 持久化 `profileBudget`，并新增了 `appendIfChanged` 路径，但这份规范性文档没有更新。该文档还明确要求“要让这些种类也记下别的字段，先改 `insertLedgerRow` 和它的校验，再改这份约定”，本次只做了前半。
- 证据：
  - 文档：`“目前只落 memoryIds、ruleIds、batchId、resultMemoryIds 四个键……其余字段在入库前被丢掉。”`
  - 代码：`JSON.stringify({ memoryIds: ..., ruleIds: ..., batchId: ..., resultMemoryIds: ..., ...(write.inputs.profileBudget ? { profileBudget: write.inputs.profileBudget } : {}) })`
  - 端口：`readonly profileBudget?: ProfileBudget | null;`、`appendIfChanged(input: { readonly write ...; readonly reasonCodes ... }): Promise<boolean>;`
- 建议：更新该约定，列出 `profileBudget`，说明 `context_truncation` 现在有 `appendIfChanged` 路径，并写清该路径的 `memoryIds` 是“被挤掉”的编号，不是实际放进上下文的编号。顺带检查 `docs/adr/0143...:38` 的“inputs 只放 memoryIds 和 ruleIds”以及 `docs/adr/0112...:68`、`docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:108` 的“总长仍然 2000 字/超出按重要度截断”是否也需要标注被 ADR 0214 修改。

### 2. 中：置顶承诺对“改过类别”的记忆不成立，新提示也会漏报
- 文件:行：`packages/application/src/services/owner-profile-service.ts:208-216,217-219`；`apps/agent-service/src/production-memory-control.ts:64-71,783-805`；`test/integration/production-memory-capture.test.ts:1805-1813`；`apps/control-center/src/components/memory-page.tsx:1284-1292`
- 问题：`#select` 的 `factLines` 只接收 `rule` 之外且类别在 `PROFILE_SECTIONS` 里的条目；`PROFILE_SECTIONS` 只有身份、偏好、人际、目标、进行中的事。置顶检查只在“打开开关”时限制类别，但之后允许把已置顶的记忆改到 `event`/`health`/`finance`/`other`，改动后 pin 仍在，却不再进入规则块或档案块，也不计入 `usage.pinned`。因此 ADR/作者说法“置顶条目永远不挤掉”在这条路径上不成立，记忆页的“共多少字”也会少算，甚至不显示超限提示。
- 证据：
  - `owner-profile-service.ts:210-213`：`(pinned.has(memory.id) || ...) && PROFILE_SECTIONS.some(([category]) => memory.attributes?.category === category)`
  - `owner-profile-service.ts:217-219`：`pinnedUsed` 只累加 `ruleLines` 和 `factLines`
  - 现成测试已证明 pin 可以保留到 `event`：`expect(eventMemory).toMatchObject({ category: "event", profilePin: "on" });`（`production-memory-capture.test.ts:1813`）
  - 提示只看 `usage.pinned > usage.limit`（`memory-page.tsx:1284`），而 `usage.pinned` 不含这类记忆
- 建议：三选一并写进 ADR/测试：①把“所有当前有效、模型可见且置顶”的记忆都纳入档案选择（可单独成节）；②改类别到不可携带类别时自动清掉 pin 或拒绝该操作；③至少让 `usage.pinned` 和提示基于真正的 pin 集合，而不是仅基于已进入 `ruleLines/factLines` 的条目。当前状态下“置顶永远不挤掉”应降级为“在可携带类别内永远不挤掉”。

### 3. 低：记忆页反向用例没有覆盖 `0 < pinned <= limit`，边界条件可能被漏检
- 文件:行：`test/integration/memory-source-browser.test.ts:85,166-172`；`test/e2e/fixtures/control-center-browser-server.mjs:816-818`
- 问题：反向用例使用默认 fixture，`pinnedCharacters` 为 `0`；正向用例是 `2150 > 2000`。如果实现误写成 `usage.pinned > 0`，正向仍通过、反向（0）也通过，两个用例都发现不了。没有覆盖 `pinned = 2000`（等于上限）和 `0 < pinned < 2000`。
- 证据：`await serve("0")`、`await serve("2150")`；反向断言是 `toHaveCount(0)`；fixture 的 `pinned: pinnedCharacters`。
- 建议：增加 `pinned = 2000`（不提示）和 `pinned = 100`（不提示）两个浏览器/组件用例，并加一个 `pinned = 2001` 的精确边界。

### 4. 低：去重键包含原因码，同一批被挤条目但原因码翻转会再记一条，比验收第 2 条更宽
- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:343-348`；`packages/application/src/services/context-formation-service.ts:355-356`
- 问题：验收第 2 条说“被挤掉的条目变了，才再记一条”。实现只有在“原因码相同且编号集合相同”时才跳过；如果同一批 `memoryIds` 不变、但 `pinned` 与 `limit` 的关系翻转（原因码从 `profile_budget_exceeded` 变成 `profile_pinned_over_budget`，或反向），仍会再写一条。需要确认这是有意为之，还是验收文字需要收紧。
- 证据：`if (latest?.reasonCode === write.reasonCode) { ... if (before?.length === now.length && new Set([...before, ...now]).size === now.length) return false; }`；原因码由 `usage.pinned > usage.limit ? PROFILE_PINNED_OVER_BUDGET : PROFILE_BUDGET_EXCEEDED` 决定。
- 建议：在 ADR 和测试里把这个行为写清楚，或改为“编号集合相同就跳过，原因码变化只更新/另记一条固定说明”，避免验收和实现各自解释。

## 二、推测 / 未核实

### 5. 低（推测）：用 `checked_at` 判断“最新一条”，并发或时钟回拨时不一定等于“最后写入”
- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:335-339`；`packages/application/src/services/context-formation-service.ts:353`
- 说明：查询是 `ORDER BY checked_at DESC, id DESC`，而 `checked_at` 来自每个 run 自己的 `decidedAt: clock.now()`。同一 owner/agent 的多个线程并发时，若时钟不完全单调或同一毫秒多条记录，可能选到不是最后插入的那条，导致重复记录或错误抑制。未核实生产时钟保证和多进程部署方式。
- 建议：若并发是真实场景，按插入顺序（`rowid` 或独立自增序列）取“最新”，或把去重范围限定到同一 thread/run。

### 6. 低（推测）：去重跨线程，只按 owner+agent，thread B 可能被 thread A 的同组记录抑制
- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:335-340`
- 说明：查询过滤 `owner_id`、`agent_id`、`kind`，不包含 thread/run。若两个线程在同一时刻被挤掉同一组记忆，第二条不会写入，且已有记录的 `subjectRef` 指向第一次的 run。ADR 只写了“同一主人、同一类型”，没有明确跨线程是否可接受。未确认这是有意取舍。

### 7. 低（未核实）：`>200` 个被挤条目时，只记前 200 个，后 200 个变化不会触发新记录
- 文件:行：`packages/application/src/services/context-formation-service.ts:359`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:343-347`
- 说明：`.sort().slice(0, 200)` 与去重都只看这 200 个。ADR 写了“最多 200 个”，但没有说明“第 201 个以后变化时不重记”的副作用。属于有界记录设计的可接受限制，但应写明。

## 侧重检查

- **错误路径**：决策记录写入是尽力而为，失败被 `.catch(() => undefined)` 吞掉（`context-formation-service.ts:346-370`）。因此验收第 1 条在磁盘满、端口失败等情况下只是“多数情况下满足”，不是硬保证；这与 ADR 的“写入失败忽略”一致，但值得在验收措辞里注明。非法 `profileBudget` 会被 `validateLedgerWrite` 拒绝（`sqlite-decision-ledger-operations.ts:70-82`），然后同样被吞掉。
- **不合规范/不可信输入**：`memoryIds` 经 `idList` 校验（≤200、去重、1–256 字符），`reasonCodes` 校验 1–16 个、每个 1–64 字符且必须包含 `write.reasonCode`，`profileBudget` 校验整数与 `pinned <= used`。这些都能挡住格式错误。未发现新的注入面；SQL 使用参数化。
- **安全**：记录只存记忆编号、`profileBudget` 和 run 引用，不存正文（`context-formation-service.ts:358-361`），符合 ADR 的隐私取舍；写失败不影响对话。
- **资源耗尽**：置顶超过上限时按设计允许无限超出，没有硬上限；主人在多轮、多置顶或超长记忆下可以让每轮 prompt 持续变大，成本和上下文窗口风险由主人自行承担。建议至少在文档里写明没有硬上限，并考虑未来加“单条/总置顶字数”上限。
- **不可撤销操作**：决策记录是 append-only；去重避免了大多数重复写入。没有删除/改写历史。
- **规则/文档一致性**：除上面第 1 条，`docs/execution/specs/2026-11-09-decision-record-write-convention.md` 与 `insertLedgerRow` 明确不一致；ADR 0112/自建记忆引擎设计文档仍写“总长 2000 字、超出按重要度截断”，没有反映“置顶可超出上限”。
- **并发**：`appendIfChanged` 的“读最新 + 插入”在同一 SQLite 事务里，单写线程下能防重复；跨进程/跨线程的“最新”判定见推测第 5、6 条。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？
**不会改变请求开头，仍然是只在末尾追加；本轮会变的档案内容在最后一条用户消息里。**
- 档案块来自 `envelope.contextBlocks`，经 `context-projection-service.ts:90,410-434` 变成 projection 的 `contextBlocks`。
- `pi-runtime-adapter.ts:623-641` 的 `turnPrompt()` 把这些块放进 `<himawari-context>`，再在 `<owner-message>` 里放本轮 prompt；`pi-runtime-adapter.ts:1357,1893` 通过 `session.prompt(turn, ...)` 作为本轮用户消息追加。
- 系统提示和工具由冻结的 bundle/`productSystemPrompt` 单独构造（`pi-runtime-adapter.ts:1372-1386`），本改动没有触碰。
- `compose()` 新增的 `usage` 没有进入 envelope：`context-formation-service.ts:453-458` 只映射 `kind/ref/payloadRef/memoryIds`；`usage` 只用于写决策记录。
- 结论：档案选中的条目变了只会改变本轮最后一条用户消息；历史、系统提示、工具定义不变。此前已经发出的轮次不会被改写。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
**模型输入没有新增不确定性。**
- 档案文本顺序由 `ownerFirst(pinned)` 和 `byImportance`（重要度 + `id.localeCompare`）决定，顺序固定（`owner-profile-service.ts:114-124,192-233,239-243`）。
- 本次新增的 `memoryIds` 在写库前显式 `.sort()`（`context-formation-service.ts:359`），不是无序集合。
- 没有新增依赖当前时间/随机数的模型可见字段；`decidedAt` 和新的 ledger id 只写进决策记录，不进模型请求。
- 注意：决策记录本身每次的 `id`/`decidedAt` 会不同，但这不是“同一段文字发给模型时字节不同”的问题；只要以后不要把 ledger 记录回灌进 prompt，就不影响 KV 缓存规则。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？
**有对应的自动检查；主要正向、去重和反向用例在实现被破坏时会失败。但我没有运行测试（工具限制），实际是否通过标记为「未核实」。**
- 正向：`owner-profile-service.unit.test.ts` 的两个 `[P2-5]`、`decision-ledger.test.ts` 的两个 `[P2-5]`、`memory-source-browser.test.ts` 的正向浏览器用例。去掉置顶预留或置顶超限记录，这些会失败。
- 去重：`decision-ledger.test.ts:1196-1200`（连续两次 `form()` 仍只有 1 条）。去掉 `appendIfChanged` 的去重，会变成 2 条，失败。
- 反向：`decision-ledger.test.ts:1249-1263`（未超字数时 `context_truncation` 为空）。若无条件写记录，会失败。
- 不足：
  - 浏览器反向用例只测了 `pinned = 0`，无法区分 `pinned > 0` 和 `pinned > limit`（见问题 3）。
  - `[P2-5]` 的“worker”腿并没有真的走 worker 传输：`test/integration/sqlite-contract-execution.fixture.ts:22,49-60` 只对 `workerOwned` 集合启动真实 worker，其他操作直接 `operations.execute(...)`。因此 `decisionLedger.appendIfChanged` 的 worker 序列化/分发是否另有覆盖，未核实。
  - 没有直接测试 `appendIfChanged` 对非法 `reasonCodes`、非法 `profileBudget` 的拒绝，也没有测试原因码翻转但编号集合相同的场景。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？
按 I-73 的方式逐项核对了两端：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `profileUsage.pinned` | `production-memory-control.ts:701-705` | 网关契约 `contracts-v2.ts:1244-1248` 的 `integer(0)`；`memory-page.tsx:1284-1290`；control-center 测试 fixture 已补 | 接受。允许大于 `limit`，契约没有上限 |
| `profileBudget {limit, used, pinned}` | `context-formation-service.ts:358-361` | `validateLedgerWrite`（`sqlite-decision-ledger-operations.ts:70-82`）要求 `limit>=1`、`used>=0`、`pinned>=0`、`pinned<=used`；`insertLedgerRow:130-136` 写入；`entryFromRow:228` 读回 | 接受。代码路径中 `used>=pinned` 恒成立；`used` 可大于 `limit` 是设计允许 |
| `profile_budget_exceeded` / `profile_pinned_over_budget` | `ports/decision-ledger.ts:104-109` | 表约束 `reason_code` 长度 1–64（迁移 0087:35）、`kind/outcome` 组合合法（0087:68）；`appendIfChanged` 的 `reasonCodes` 校验（sqlite:324-331） | 接受，长度和值都合法 |
| 操作名 `decisionLedger.appendIfChanged` | `durable-adapters.ts:1022` | `sqlite-decision-ledger-operations.ts:252-253` 分发；worker 默认走 `durableOperations.execute`（`sqlite-worker.ts:1108-1109`） | 接受，没有发现 I-73 式“清单值过不了后端校验” |
| `OwnerProfileUsage.pinned` 类型 | `owner-profile-service.ts:53-58` | `production-memory-control`、控制中心测试 fixture、`production-memory-capture.test.ts:1622-1626` | 接受。检索到的构造点都已更新 |
| i18n `memory.page.carry.pinnedOver` | `message-ids.ts:785,1410` | `memory-page.tsx:1286`；`en.ts:882-883`、`ja.ts:888-889`、`zh-CN.ts:833-834` | 接受，三种语言和样例值齐全 |
| 文档中的声明 | 新 ADR 0214 | `2026-11-09-decision-record-write-convention.md:35`、ADR 0143、ADR 0112、自建记忆引擎设计文档 | **不接受**：文档与代码不一致，见问题 1；这是本次复核最明确的规范落地缺口 |
