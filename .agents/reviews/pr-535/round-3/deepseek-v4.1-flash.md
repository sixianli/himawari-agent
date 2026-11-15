### 1. 【中低】锁只在单个 `ProductionThinkInbox` 实例内生效，文档却写成“服务进程里”

- 文件:行：`apps/agent-service/src/production-think-inbox.ts:103`、`apps/agent-service/src/production-think-inbox.ts:154-163`；`docs/architecture-v0.1.md:436`
- 问题：`#locks` 是实例字段，不是进程级或存储级互斥。同一进程里若有两个 `ProductionThinkInbox` 实例，或以后有两个进程共享同一 SQLite，同来源同版本的提交仍会并发，上一轮“失败清理删掉已接受条目的摘要 / 入队外键错误”的时序仍可能出现。文档却承诺“服务进程里按条目排队”。
- 证据（读代码证实）：
  - `readonly #locks = new Map<string, Promise<void>>();`（`production-think-inbox.ts:103`）
  - `const previous = this.#locks.get(key) ?? Promise.resolve();`（`:154`）
  - 文档：`同一来源版本的提交在服务进程里按条目排队`（`docs/architecture-v0.1.md:436`）
- 推测：当前没有生产调用方，且通常只建一个实例，所以现在不会触发；风险在下一轮接入运行、或出现多实例组合时。
- 建议：要么把互斥提升到存储层（例如让 `enqueue` 在同一个事务里处理“查重、写行、清理孤立载荷”），要么把文档和接口合同明确改成“同一实例内”，并在接线处保证单实例。

### 2. 【低】锁修复没有能反向失败的自动检查

- 文件:行：`test/integration/think-inbox.test.ts:183-190`、`test/integration/think-inbox.test.ts:192-204`；`apps/agent-service/src/production-think-inbox.ts:154-163`
- 问题：新增测试只覆盖“`enqueue` 抛错后清理载荷”，这部分是真反向用例；但没有测试覆盖这次加入的锁。现有“两个相同提交同时进来”的用例在去掉锁后大概率仍会通过。
- 证据（读代码证实）：
  - 并发用例只断言两个都接受、一个 duplicate、最终一份载荷（`think-inbox.test.ts:186-189`）。
  - 载荷 `put` 对重复 ref 会抛 `PORT_DUPLICATE`，`#accept` 捕获后若 `get` 到已有载荷就继续，`wrote` 仍为 false（`production-think-inbox.ts:182-197`），因此第二个提交不会删载荷。
- 推测：把 `#locks` 整段删掉后，这个用例仍会通过；真正危险的“第一个入队被挡、清理与新入队交错”没有被覆盖。
- 建议：加一个确定性用例，用包装后的 store 控制时序：让第一个同 key 提交走到 `queue_full` 清理附近暂停，第二个同 key 提交在中间尝试入队；断言最终要么条目带摘要，要么干净拒绝，且不出现外键错误。该用例应在移除锁后失败。

### 3. 【低】入队抛错后的清理和清扫都是 best-effort，失败时孤立载荷仍会留下且没有按年龄清扫

- 文件:行：`apps/agent-service/src/production-think-inbox.ts:214-231`、`apps/agent-service/src/production-think-inbox.ts:256-264`；`docs/architecture-v0.1.md:436`
- 问题：`enqueue` 抛错时会尝试清理新写载荷，但如果同一存储故障也让 `summaryReferenced` 查询失败，`.catch(() => true)` 会按“仍被引用”处理而跳过删除；清扫里 `payloads.delete` 失败也只记为 false。没有按前缀/年龄清扫“无行引用载荷”的程序，所以这份加密载荷会长期留下。文档只声明了“写载荷和入队之间崩溃”这一种窗口。
- 证据（读代码证实）：
  - `.catch(() => true);`（`production-think-inbox.ts:230`）
  - `if (!referenced) await this.#options.payloads.delete(...).catch(() => false);`（`:231`）
  - `const gone = await ...delete(...).then(() => true).catch(() => false);`（`:257-260`）
- 推测：如果 `enqueue` 因临时写失败抛错，读路径通常仍可用，清理会成功；但在数据库整体不可用、磁盘满导致读写都失败时，孤立载荷会留下。
- 建议：记录清理失败并重试；或者增加一条按 `think-summary:%` 前缀、且 `think_inbox` 无引用的载荷年龄清扫（进入现有 `maintain`）。至少把“清理失败也会留下载荷”写进文档，修正“最终不留”的无条件表述。

### 4. 【低】作者说明第 1 条与代码/文档不一致：重复提交在载荷已清扫时会临时新建载荷

- 文件:行：`apps/agent-service/src/production-think-inbox.ts:181-197`、`apps/agent-service/src/production-think-inbox.ts:219`；`docs/architecture-v0.1.md:436`
- 问题：作者说“重复提交……不新建摘要载荷”，但条目已结束、载荷已被 `maintain` 删除后，再提交同一版本会先写一份新载荷，`enqueue` 返回 duplicate 后再把它删掉。最终不留，但确实临时新建过。更新后的文档已经写明这一点，作者说明没有同步。
- 证据（读代码证实）：
  - 载荷不存在时执行 `put` 并 `wrote = true`（`:182-194`）。
  - duplicate 分支前执行 `if (wrote) await this.#discardUnreferenced(summaryRef);`（`:219`）。
  - 文档：`条目已结束且载荷已被清扫后再提交同一版本，会临时写一份载荷再删掉，最终不留。`（`docs/architecture-v0.1.md:436`）
- 建议：更新作者说明即可；如果希望“重复完全不写载荷”，需要在写载荷前先向存储层查明是否已有条目，或让 `enqueue` 先返回查重结果再写载荷。

**读代码证实的结论**

- 增量只改了 `production-think-inbox.ts` 的提交串行化和 `enqueue` 抛错清理，以及测试、文档、schema 描述；没有改持久层 SQL、配置解析、迁移。
- 锁确实把同一个 key 的 `#accept` 串行化，`#discardUnreferenced` 不会再与同 key 的另一次入队在同一实例内交错。
- `enqueue` 抛错时会清理本次新写的载荷，新增测试在去掉这段 `catch` 后会失败，属于有效反向用例。
- `summaryRef` 与 `payloads` 的删除受 `ON DELETE SET NULL` 影响，`maintain` 删除载荷后指针会清空；`clearSummary` 再置空是冗余但无害。
- 旧的持久层查询均带 `owner_id` 和 `agent_id`；本轮没有放宽范围。

**推测**

- 现有并发测试在移除锁后仍会通过。
- 多实例/多进程共享 SQLite 时锁失效；当前没有调用方，未核实实际部署是否会这样组合。
- 清理查询或删除同时失败时才会留下孤立载荷；普通“入队抛错但读可用”的场景会被清理掉。

**上一轮意见核对**

- 意见 1（同 key 清理与入队无互斥）：在同一 `ProductionThinkInbox` 实例内已修好；跨实例/跨进程仍是残余风险，见意见 1。
- 意见 2（enqueue 抛错留下孤立载荷）：抛错路径已加清理，并有反向测试；进程崩溃窗口仍存在且文档已承认，清理自身失败时仍可能留下载荷，见意见 3。
- 意见 4（文档说“只留指针”但实际置 NULL）：已修好。文档改成“删载荷并把行里的摘要指针置空”，schema 描述也改成按批清扫；代码 `clearSummary` 确实把 `summary_ref` 置 NULL。

**作者说法核对**

1. 基本成立，但“不新建摘要载荷”在“条目已结束且载荷已被清扫”的重复提交上不成立，见意见 4。
2. 成立。队列满/当天满额时只有本次 `wrote` 为真才删；重复提交不会删已有载荷（`production-think-inbox.ts:218-220`）。
3. 成立。`localDay` 用 `Intl.DateTimeFormat` 和配置时区算本地日期，测试覆盖 Asia/Tokyo 跨日（`think-inbox.test.ts:293-301`）。
4. 成立。`thinking` 且 `updated_at <= stalledBefore` 时，`attempts >= maxAttempts` 标 `failed`/`stalled`，否则回 `queued`；`finish` 的 SQL 只匹配 `status = 'thinking'`。注意阈值用的是 `<=`，包含恰好等于阈值的条目，与“早于”措辞略有差异，但不影响结论。
5. 成立。逐条看过 `enqueue`、`claimNext`、`finish`、`recoverStalled`、`expireQueued`、`usage`、`settledSummaries`、`summaryReferenced`、`clearSummary`，查询和写入都带 owner/agent。
6. 重点核对第 2 点（每日上限）：按 `day` 统计所有状态是对的，因为 `day` 只在接收时写入、之后不变，失败或过期条目仍是“当天接收过”的条目；没有发现绕过或误挡。
7. 重点核对第 3 点（`usage.queued` 口径）：`queued` 确实只算 `queued`，而队列上限判断算 `queued + thinking`；文档明确要求用两者之和，所以当前不是错误，但未来界面若直接拿 `queued` 对比上限会误判。
8. 重点核对第 4 点（删除顺序）：先删载荷，成功或载荷本就不存在才清指针；删除失败时指针保留，下次 `maintain` 重试，未发现“误清仍可读指针”。
9. 重点核对第 5 点（反向输入）：未登记来源、空摘要、错误类型、配置越界都会拒绝；配置测试覆盖了边界和未知键。

**必答问题**

1. 不会改变模型已经见过的请求开头。本增量不构造模型请求、不调模型，也不碰系统提示、工具定义、历史消息或遮盖；发给模型的内容没有变化，因此“只在末尾追加”和“每轮变化的值都在最后一条消息里”这两点不受影响。
2. 不会让模型请求里的同一段文字变成不同字节。唯一会随时间变化的是加密载荷的 `createdAt` 和密文；同一摘要重写时会生成新的加密载荷，但那是加密存储、不进模型上下文，`id` 和 `summaryRef` 由稳定的 key 算出。若以后把摘要送入模型，仍需另行确认不把 `createdAt` 等元数据带进提示。
3. 有对应自动检查，但只覆盖了一部分。`enqueue` 抛错后的清理有真正的反向用例（去掉 catch 会留下载荷）；锁修复没有能反向失败的测试，现有并发用例在无锁时大概率仍通过。未运行测试，不能确认整套测试通过。
4. 增量没有产生或修改新的导出函数、配置键、字段或序列化格式；`#accept`、`#locks` 都是私有实现，`submit` 的对外返回/拒绝契约未变。增量唯一对外可见的“值”是文档描述，存在意见 1 的过度承诺。旧持久层的 owner/agent 范围没有被增量改变。

**侧重检查**

- 错误路径：查了 `enqueue` 抛错、`summaryReferenced` 失败、`payloads.delete` 失败、`maintain` 删载荷/清指针失败的顺序；结论见意见 3，正常错误路径会清理，清理自身失败时留下孤立载荷。
- 不合规范/不可信输入：查了来源未登记、`sourceKind` 类型、`sourceRef` 长度、`sourceVersion` 长度、空摘要、`externalContent` 类型和配置上下界；均由 `submit` 或配置解析拒绝，未发现写库。
- 安全：SQL 全部参数化，`status`/`reason_code` 由常量或校验后的值写入；摘要只以加密载荷存储，条目表只有引用；`externalContent` 会并入入队参数；未发现越权或明文泄漏。
- 资源耗尽：队列上限按 `queued + thinking`，每日上限按本地日，摘要长度截断；锁 map 在 settle 后删除。`think_inbox` 行本身永久保留以做去重，这是既有设计，不是本次增量改动。
- 不可撤销操作：新路径只涉及删除摘要载荷和清空指针；先删后清，失败可重试，未新增其他不可逆动作。
- 规则/文档一致性：发现意见 1 的“服务进程”与实例级锁不一致，意见 4 的作者说明与更新后的文档不一致；schema 目录描述与 `maintain` 行为一致。

**本轮范围与未核实**

- 本轮查看了 `1de821c09..2b35dac79` 的完整增量，并沿证据追溯到 `sqlite-think-inbox-operations.ts`、迁移、载荷删除、`maintain` 和配置解析。
- 未核实：没有运行任何测试或类型检查；没有核实实际部署是否可能出现多实例/多进程；没有核实后续模型如何使用摘要载荷；评审记录文件作为记录路径无法读取，未作为代码依据。
