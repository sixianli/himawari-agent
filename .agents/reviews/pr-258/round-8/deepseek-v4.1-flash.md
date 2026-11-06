## 结论

未发现本轮合并会出错的阻断问题。合并增量只带进 main 的 Hermes runner 文档/脚本/测试和两批复核记录；本 PR 的功能文件相对上一轮 `a22e487e` 未被合并改动，main 侧功能文件与 `ba915c21` 逐字一致。ADR 编号和迁移 0078 均无冲突。

## 问题列表（按严重度）

### 低：清空记录与并发上报之间有竞态（PR 既有实现，不是本次合并引入，不阻断合并）

- 文件:行：`packages/application/src/services/sensitive-interception-recorder.ts:111`、`apps/agent-service/src/production-sensitive-interceptions-control.ts:95`、`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:239`
- 问题：`clear` 先 `flush` 队列，再执行 `DELETE`。如果并发的模型请求在这次 flush 之后、`DELETE` 前后又调用 `reportEgress`，新观测只会进入内存队列，随后由定时器/下一次 flush 写入，导致用户刚清空后又出现记录。
- 证据：
  - `observe` 只把观测推进队列并安排定时写入：`sensitive-interception-recorder.ts:111-134`。
  - `clear` 前只调用一次 `beforeRead`（即 flush），然后直接删除：`production-sensitive-interceptions-control.ts:95-96`、`sqlite-sensitive-interception-operations.ts:239-245`。
  - 读取时又会先 flush：`production-http-composition.ts:1098`，因此刚清空后重新打开页面可能再次看到这些记录。
- 建议：让 recorder 提供“暂停并排空 + 清空后恢复”的屏障，或把 clear 与写入串行化；至少在 `DELETE` 后再 flush 并再次确认清空。该竞态需要并发触发，是否实际出现属于推断；代码中确实没有互斥。
- 严重度说明：会破坏“清空”这一不可撤销操作的语义，但不导致崩溃或数据泄漏，故定为低。

其余未发现会出错的合并问题。

## 读代码证实的

1. 合并范围与完整性：
   - `git show --stat 53d3d16e` 显示合并提交只涉及 `docs/adr/0170`、新增 `docs/adr/0173`、Hermes runbook、`scripts/operations/hermes-runner/`、`test/tooling/hermes-runner-scripts.test.mjs` 和 `.agents/reviews/`。
   - `git diff ba915c21..53d3d16e -- docs/adr docs/runbooks scripts/operations/hermes-runner test/tooling/hermes-runner-scripts.test.mjs` 无输出，功能文件与 main 逐字相同。
   - `git diff a22e487e..53d3d16e --name-only` 只有上述 main 文件和复核记录，PR 功能文件没有被合并改写。
2. ADR：PR 没有新增/修改 ADR；main 新增 0173，当前不存在 0172，但全仓库没有对 `0172` 的引用，因此没有悬空引用或编号覆盖。
3. 迁移：main 没有新增迁移；`0078_sensitive_interceptions.sql` 唯一，`migration-engine.ts:616` 只注册一次 78；相关测试已改为期望 78（`migration-engine.contract.test.ts` 等）。
4. 外键两端：`0078` 的 `(owner_id, agent_id, thread_id)` 指向 `threads(owner_id, agent_id, id)`；`0001_initial_product_schema.sql:85` 有 `UNIQUE (owner_id, agent_id, id)`，外键合法。
5. 隐私：`ModelEgress` 只上报指纹，原始值不落库；`sensitive-interception-recorder.ts` 和数据库操作均只接收 `fingerprint`；测试明确断言序列化结果不含原始卡号/验证码。
6. 错误路径：recorder 对时钟异常、数据库写入失败、`onWriteFailed`/`onDropped` 监听器异常都做了捕获；`ModelEgress.#report` 和 `reportMasked` 的异常也不会改变请求体。
7. 资源：队列上限 2000、每批 500、数据库单次最多 500 条、接口分页上限 100；超限丢弃最旧记录并计数。
8. 生命周期：`sensitive-interceptions` 在 `repository` 之后注册，`ProductionServiceLifecycle.#stop` 反向关闭（`production-service-lifecycle.ts:40`），因此 flush 发生在 repository 关闭之前。

## 推测/未核实

- `.agents/reviews/pr-261/` 因当前环境拒绝对该路径执行 diff，未逐字核对；它们是复核记录，不是运行时代码。
- 未运行任何测试，只阅读了测试代码；因此“反向用例会失败”是按代码断言推断，不是实际执行结果。
- 清空竞态的实际触发概率未测量。

## 侧重检查

我重点查了以下路径：

- 不可信输入：`record` 校验 `source/part/category/outcome` 枚举、`fingerprint` 十六进制长度、`ruleId` 长度、`occurrences >= 1`、`now` 必须是规范 ISO；`list` 校验 limit 1–100 和游标时间/64 位十六进制 id；集成测试 `refuses records that do not fit the fixed fields` 覆盖了非法 category/part/fingerprint/occurrences/ruleId/time/limit。
- 不可信输入后的数据库约束：同一组枚举在 `0078` 的 `CHECK` 中重复，后端不会写入契约之外的值。
- 安全：上报只保存 HMAC 指纹，不保存原文；测试断言 raw 请求和序列化 reports 都不含密码、卡号、验证码、身份证号。
- 资源耗尽：队列、批量、分页都有上限；超限丢最旧并报告 `sensitive-interception.dropped`。
- 不可撤销操作：`clear` 只允许 owner actor，校验 owner/agent scope，界面有二次确认；但没有与并发写入互斥，见上面的低严重度问题。
- 错误路径：时钟/数据库/日志监听器失败都不会向模型调用方抛错；HTTP 查询会先 flush，避免读不到刚产生的记录。
- 合并冲突：ADR 编号、迁移号、Hermes 脚本与本 PR 文件无交集；main 侧功能文件逐字一致。

## 必答问题

1. 会不会改变模型已经见过的请求开头？
   不会。合并没有改模型请求相关文件；PR 的出口改动只增加“上报被遮盖内容”的回调，`model-egress.ts:188-221` 仍返回原来的 `result.text`，上报不参与请求体生成。新增测试 `[SI-2]` 明确比较“有上报”和“无上报”的请求体，要求 `recorded.bodies` 等于 `plain.bodies`。本次改动没有往系统提示或工具定义加会变的值，每轮会变的内容仍在原有位置；因此仍满足“只在末尾追加”。

2. 会不会让同一段文字在不同请求里变成不同字节？
   不会。指纹是 `HMAC(key, label\0kind\0value)`（`model-egress.ts:199,495`），只取决于值和固定密钥，不依赖前后文或时间；测试 `gives the same value the same fingerprint in every request` 专门验证这一点。`locateMaskedValues` 里的顺序标签只用于定位，不进入发给模型的内容。数据库里的 `first_seen_at/last_seen_at` 属于记录字段，不进入模型请求。

3. 有没有对应的自动检查，反向用例是否真的会失败？
   有，且我读到的反向断言方向正确：
   - `prompt-prefix.compat.test.ts` 的 `[SI-2]`：比较上报与不上报的请求体，并断言上报序列化不含卡号。
   - `model-egress.unit.test.ts`：断言上报/不上报/上报失败三种情况字节相同；无 context 或未遮盖时不上报；报告不含原文。
   - `sensitive-interception-recorder.unit.test.ts`：验证超限丢弃最旧、数据库失败、时钟失败、监听器抛错都不向调用方抛出。
   - `sensitive-interceptions.test.ts`：验证非法字段被拒绝、分页不重不漏、按 agent 隔离、删除对话级联、会话不存在时跳过而不是整批失败。
   未运行测试（环境只允许读和有限的 git 命令），所以“实际会失败”未核实；从断言内容看，行为回退会触发失败。

4. 改动产生或修改的每个值，使用它的地方都能接受吗？
   逐个核对后未发现两端不一致：
   - `source`、`part`、`category`、`outcome`：端口常量、`0078` 的 `CHECK`、网关契约枚举三处完全一致。
   - `outcome` 的 `not_saved` 在 HTTP 层映射为 `notSaved`，与快照契约和前端字段一致。
   - `fingerprint`：出口生成 32 位小写十六进制；数据库接受 16–64 位；不对外暴露。
   - `id`/`dedupe_key`：数据库固定 64 位十六进制，列表游标校验 64 位，快照契约的 `machineString` 接受。
   - 时间字段：数据库 `exactTime` 要求规范 ISO；网关 `timestamp` 也要求 `new Date(x).toISOString() === x`，两端一致。
   - `purpose`：数据库 1–64 字符，端口校验 1–64，实际产生的 `chat`、`mail-judgment`、`action-review`、`memory-capture`、`thread-title` 都满足契约的 `machineString`。
   - 新增操作名 `sensitive.interceptions.read/clear`：同时出现在网关契约消息类型、控制端能力和 `installedOperations` 中，控制对象在组合时无条件创建。
   - `MemoryExtractionAuditRecord` 新增的 `ownerId/agentId/threadId`：产出方 `automatic-memory-service.ts:230,342,579` 和 `production-memory-capture.ts:729` 都已补齐，类型检查不会因缺字段失败。
   - 外键两端的 `threads(owner_id, agent_id, id)` 唯一约束已存在，复合外键可成立。
