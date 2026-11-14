## 结论

本轮增量只改了两处产品行为：设备网关审计 id 改为 `audit:device-gateway:<attempt>:<outcome>`，以及新增两组测试。**没有发现会改变模型请求开头或模型可见字节的代码**。主要问题在测试：排序的反向用例不可靠，也不能防止最关键的“重复 id”回归。

## 发现（按严重度）

### 1. 中：排序测试既不能稳定复现旧实现，也拦不住重复 id 的坏实现
- 文件：`packages/platform-node/test/device-gateway.unit.test.ts:26`、`:75`
- 问题：测试用的假审计台账不检查 id 唯一性，也不检查 id 结构，只按插入顺序保存；排序断言又是把本地数组自己按 `id` 排序，而不是调用真实台账。
- 证据：
  - `packages/platform-node/test/device-gateway.unit.test.ts:28-31`
    ```ts
    async append(record) {
      if (records.length >= failAfter) throw new Error("audit store unavailable");
      records.push(record);
    },
    ```
    这里没有像生产实现那样拒绝重复 id。生产端 `packages/persistence-sqlite/src/sqlite-durable-operations.ts:1834-1837` 对 `SQLITE_CONSTRAINT_PRIMARYKEY` 报 `PORT_DUPLICATE`；内存台账 `packages/testing/src/in-memory/observability.ts:235-240` 也检查重复。
  - `packages/platform-node/test/device-gateway.unit.test.ts:75-81`
    ```ts
    expect(records.map((record) => record.outcome)).toEqual(["accepted", "completed"]);
    expect([...records].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.outcome)).toEqual([
      "accepted",
      "completed",
    ]);
    ```
- 后果：
  - 如果实现把 id 写成 `audit:device-gateway:${attempt}`（漏掉 `:outcome`），测试仍会通过；但在生产里第二次 `append` 会因主键重复失败，再被 `.catch(() => undefined)` 吞掉，最终只剩受理记录。
  - 如果退回父提交的“每条审计一个新随机 UUID”，排序结果约有一半概率仍是 `accepted, completed`，因此这个反向用例不是确定性地失败。
- 建议：在假台账里加重复 id 检查，或直接复用 `InMemoryAuditLedger`；断言两条记录共享同一 `attempt` 前缀且分别以 `:accepted`、`:completed` 结尾；再增加 `:failed` 用例。更彻底的做法是让 `dispatchDeviceGatewayRequest` 接受可注入的 id 生成器。

### 2. 中低：声称“受理排在失败之前”，但没有自动检查失败路径的排序
- 文件：`test/integration/device-gateway.test.ts:127-131`、`:357-382`
- 问题：现有集成测试的 `auditTrail()` 在返回前执行 `.sort()`，把顺序抹掉了；新单测只断言了 `accepted/completed`，没有覆盖 `failed`。
- 证据：`test/integration/device-gateway.test.ts:127-131`
  ```ts
  async function auditTrail(h: Harness) {
    return (await audits(h))
      .map(({ action, targetRef, outcome }) => `${action}:${targetRef}:${outcome}`)
      .sort();
  }
  ```
- 后果：如果把 `failed` 的 id 方案改坏，例如让 `failed` 排到 `accepted` 前面，本轮没有测试会失败。
- 建议：在失败路径用例里直接断言未排序的 `outcomes` 为 `["accepted", "failed"]`，或在单测里补 `failed` 的 id 排序断言。

### 3. 低：完成/失败审计写入失败被静默吞掉，没有日志或指标
- 文件：`packages/platform-node/src/device-gateway.ts:161`、`:164`
- 问题：本轮测试把“审计写失败时结果照常返回”固化为预期行为，但失败被完全静默处理，生产上无法发现审计缺口。
- 证据：
  ```ts
  await record("failed").catch(() => undefined);
  ...
  await record("completed").catch(() => undefined);
  ```
- 建议：仍保持“不因完成审计失败而回滚已执行结果”，但至少记录一次结构化日志或指标（如 `device_gateway.audit.completed_failed`），否则安全审计缺口不可观测。

### 4. 低：排序保证只存在于 SQLite 实现，且依赖英文结果名的字典序
- 文件：`packages/platform-node/src/device-gateway.ts:148`；`packages/persistence-sqlite/src/sqlite-durable-operations.ts:1848`；`packages/testing/src/in-memory/observability.ts:245-248`
- 问题：`AuditLedgerPort` 没有定义排序契约。SQLite 按 `ORDER BY occurred_at, id` 返回，内存台账按插入顺序返回；本轮单测只是手动排序本地数组，没有验证任何真实适配器。另外，“`accepted < completed < failed`”依赖结果字符串的英文字典序，未来改名或新增结果会悄悄破坏该性质。
- 建议：在端口契约或测试里明确要求的排序，并用真实 SQLite + 固定时钟写一条集成断言；若要长期依赖 id 排序，使用显式序号（如 `:0-accepted`、`:1-completed`、`:2-failed`）比依赖英文单词更稳。

## 读代码证实的与推测

**读代码证实：**
- 同一次 `dispatchDeviceGatewayRequest` 只生成一个 `attempt`，三条审计共用它。
- SQLite 返回顺序确为 `ORDER BY occurred_at, id`，同毫秒时同一 `attempt` 的 `accepted` 会排在 `completed`、`failed` 前。
- 新 id 只被主键、`afterId` 游标、内存台账重复检查和测试使用；仓库内没有解析该 id 结构的消费者，也没有长度/正则校验会拒绝它。
- `proactive.pause` 是 `tighten` 层，不需要确认；仓库内消费方（能力表、v2 合约、生产命令表、执行 switch、生成的 Swift、fixture）都接受 `payload: {}`。
- `proactive.pause` 的两次调用使用不同随机 `idempotencyKey`，确实会进入 `setEnabled`；`writeEnabled` 只在开关值变化时写观测事件，因此新测试的反向用例是有效的：去掉去重会产生两条 `proactive_disabled`。

**推测 / 未核实：**
- 未运行测试（本次工具限制只能读和看 git），无法实测新测试通过、父提交失败；以上关于反向有效性的判断来自静态推演。
- 仓库外是否有运维脚本依赖旧的 `audit:device-gateway:<uuid>` 格式未核实；仓库内未发现。
- “审计写失败可以静默丢失”是否需要更严格的审计要求，仓库内未见明确规定，需产品/审计规则确认。

## 侧重检查

- **错误路径**：受理写失败会在转发前抛出（`device-gateway.ts:156`），测试 `:99-107` 有效；完成/失败写失败被吞掉（`:161`、`:164`），结果不被阻塞，但静默无日志，见发现 3。
- **不合规范/不可信输入**：本轮新增 id 是服务端生成，不接受客户端输入；`classifyDeviceGatewayRequest` 仍校验字段白名单、`messageId`、`idempotencyKey` 和 payload，测试传入的 `proactive.pause` 合法。
- **安全**：`proactive.pause` 属于“减少收集”的 `tighten` 操作，免确认且可逆（`proactive.settings.set` 可重新开启），符合现有分层；审计 id 不包含秘密，不进入模型输入。
- **资源耗尽**：每条请求只多生成一个 UUID，id 长度约 67，远低于任何已知限制；没有新增循环或大对象。
- **不可撤销操作**：`pause` 可逆；审计写入在 SQLite 事务内；没有新增不可撤销删除。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 未被违反；审计记录和 `observation_events` 都不参与提示词组装，规则与代码一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及 `audit_records` 和 `observation_events`，没有改系统提示、工具定义、历史消息或遮盖逻辑。仓库内未发现审计 id 或观测事件进入模型请求，因此请求仍是只在末尾追加；本轮也没有新增“每轮会变的值”到请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？** 新审计 id 本身每次派发都因 `randomUUID()` 而不同，但它不是模型可见文本，所以不影响模型请求字节。若将来有人把审计 id 放进提示词或历史，就会违反“字节必须确定”，目前没有这种情况。`observation_events` 的 id 同样不是模型输入。

3. **有没有自动检查，反向用例是否真的会失败？** 有测试，但排序测试的反向无效：假台账不查重复 id，且父提交的随机 id 实现约有一半概率仍通过；漏掉 `:outcome` 的坏实现也能通过。`failed` 排序没有测试。`proactive.pause` 双发只产生一条事件的反向用例是有效的。

4. **改动产生/修改的每个值，使用方都能接受吗？** 新审计 id：SQLite 主键是普通 `TEXT`，无格式/长度约束；`listByAgent` 的 `afterId` 按字符串相等查找；内存台账按 id 查重；仓库内无解析器会拒绝。长度约 67，均能接受。`proactive.pause` 的核对面：能力表、v2 schema（`payload: {}`）、生产命令表和执行 switch、生成的 Swift、fixture、`ci/operations-pending.json` 全部一致，没有发现后端校验会拒绝；本轮没有新增清单项或配置键。唯一需要补强的是测试端没有模拟 SQLite 的主键唯一约束。
