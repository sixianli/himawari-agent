## 结论

本次实际改动的范围是 `ba27d1f5..044605a7`（`1b1622..HEAD` 混入了大量 main 合并，不适合当作本 PR 的增量）。没有发现高/中严重度缺陷；核心路径读代码成立：最近认证在状态变化前检查、停用计数与保存同事务、退回在资格核验通过前不落盘、新读操作带 owner/agent 范围、文档/操作清单与代码一致。

以下为低严重度问题和测试缺口，按严重度排列。

## 发现

### 低｜资源耗尽：新增依赖任务读取没有上限
**文件:行**：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:2727-2741`，调用端 `packages/application/src/services/governance-gateway-adapter.ts:435-437`

**问题**：`listScheduledJobRefs` 和停用计数用的查询都是“该能力名下所有 `status != 'revoked'` 的定时任务”，没有 `LIMIT`。`capability.detail` 会把全部 id 放进 `dependencyTaskRefs`；停用事务也会把全部命中任务逐条更新。某个能力名下任务很多时，单次详情响应或停用事务会无界增长。

**证据**：
```ts
2735:          `SELECT id FROM scheduled_jobs
2736:          WHERE owner_id = ? AND agent_id = ? AND status != 'revoked'
2737:            AND json_extract(record_json, '$.capabilityRef') = ? ORDER BY id`,
2738:        )
2739:        .all(input.ownerId, input.agentId, input.capabilityRef) as Array<{ id: string }>
```
```ts
435:    const taskRefs = distinctSorted(
436:      await this.#dependencies.dependencies.listTaskRefsByCapability(record.ref),
437:    );
```
这是“读代码证实”的行为；“任务很多时被滥用”是影响推断。读取已按 owner/agent 限定，不能跨账号。

**建议**：给详情读取加合理上限（或分页/截断并在契约中表达），为 `scheduled_jobs` 的 `json_extract(record_json,'$.capabilityRef')` 建索引，停用计数可只 `COUNT(*)`。

### 低｜错误路径/幂等：第二道最近认证失败仍会留下 executing 收据
**文件:行**：`packages/application/src/services/governance-gateway-adapter.ts:614-615, 636-648, 710-716, 1012`；`apps/control-center/src/governance-control-center.tsx:799-813`

**问题**：第一道检查在 `#begin` 之前，失败不留收据（这点成立，且有测试：先传 null 失败、同一幂等键换正确引用后成功）。但 `#disableCapability` / `#rollbackCapability` 在 `#begin` 创建收据之后还会再检查一次最近认证。若第一道通过、第二道因会话被撤销或证据恰好过期而失败，收据会留在 `executing`；控制中心当前只在 409 清待重试键，403 不清。之后用同一幂等键、新的 `recentAuthenticationRef` 重试，`#begin` 会因指纹不同抛 409，而不是继续执行。

**证据**：
```ts
614:    await this.#authenticateBeforeFirstReceipt(input.authentication, input.command);
615:    const attempt = await this.#begin(input.command);
...
647:    await this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
```
```ts
710:    if (receipt.commandType !== command.type || receipt.semanticFingerprint !== fingerprint) {
711:      throw new ApplicationPortError(
712:        PORT_ERROR_CODES.CONFLICT,
```
```ts
799:      } else if (status === 409) {
800:        storage.clearPendingGovernanceMutation(identity.operationKey);
...
806:      } else {
807:        setMutationStatus("rejected");
```
触发窗口很窄，属于“推测的边界场景”，不是可稳定复现的认证绕过；这里的 403 不会改变状态。

**建议**：要么把“认证通过”作为创建收据的前置条件并只保留这一处检查（恢复路径另行处理），要么在控制中心对 `capability.disable`/`capability.rollback` 的 403 也清待重试键，或把 `recentAuthenticationRef` 一并持久化到待重试记录。

### 低｜测试缺口：缺少跨 owner/agent 和“已撤销任务不计入”的反向用例
**文件:行**：`test/integration/sqlite-durable-repositories.test.ts:786-789, 818-837`；`test/integration/production-capability-gateway.test.ts:180-196`

**问题**：新 SQL 确实带了 `owner_id = ? AND agent_id = ?`，但测试都只在同一个 owner/agent 的 store 上查询；如果以后有人删掉这两个条件，现有用例仍会通过。计数测试也只证明 `paused` 被计入，没有预置一条已 `revoked` 的任务证明它不会被算进取消数。

**证据**：
```ts
786:      await expect(capabilities.listScheduledJobRefs?.(action.capabilityRef)).resolves.toEqual([
787:        "job-capability-governed-sqlite",
788:      ]);
```
```ts
834:        lastInvalidation: { lifecycle: "disabled", cancelledScheduledJobs: 2, occurredAt: T2 },
```
这是“读代码证实”的测试缺口。

**建议**：用另一个 owner/agent 的 `capabilityStore` 查询同一 `capabilityRef`，断言 `[]`；在停用前插入一条 `status: "revoked"` 的同能力任务，仍断言取消数为 2。

### 说明（不是当前漏洞）：最近认证检查在网关适配器，不在 `CapabilityLifecycleService` 本身
**文件:行**：`packages/application/src/services/governance-gateway-adapter.ts:1012, 1034`；`packages/application/src/services/capability-lifecycle-service.ts:625-635, 579-623`

`CapabilityLifecycleService.disable/rollback` 本身没有认证参数，检查发生在 `GovernanceGatewayV2ControlPlane`。目前生产只通过 `createProductionCapabilityLifecycle` → governance adapter 调用（我用 grep 找过 `new CapabilityLifecycleService` 和 `.rollback(`），没有发现绕过入口。但这是隐含不变量，未来若别处直接调用服务层，最近认证不会自动生效。

**建议**：在服务层文档/注释中写清“调用方必须已做最近认证”，或把认证能力作为服务依赖，避免未来新增调用方绕过。

## 未核实

- “生产库实查有 3 条能力记录，都是 active”：没有数据库可查，未核实。
- “生产部署快照每个能力只有当前版本、资格结果 5 分钟后过期”：属于运行环境事实，未核实；代码只体现了生产 `runtime.qualify` 固定抛错、`artifacts.verify` 固定 `verified: false`。
- 测试未实际运行（只允许读代码），以下“会失败”的判断来自用例逻辑核对。

## 侧重检查

- **错误路径**：能力不存在 → `NOT_FOUND`；`expectedRevision` 不符 → conflict；最近认证缺失/不匹配 → `NOT_AUTHORITATIVE`，状态不变；退回未安装 → `OPERATION_NOT_INSTALLED`，状态不变；退回资格核验失败在 `switchCapabilityVersion` 之前抛出，不落盘。以上均已对照代码，部分有集成测试。
- **不可信输入**：`capabilityRef`、owner/agent 均走 SQL 参数绑定；命令 payload 由契约校验；`prod-read.sh capabilities` 不接受额外参数，不读取 `record_json`。
- **安全/范围**：`production-approval-gateway.ts:112` 的 `capabilityStore(ownerId, agentId)` 固定了范围；`listCapabilityScheduledJobRefs`、`invalidateCapabilityAuthority` 的 SQL 都带 owner/agent；`capability.detail` 的 `get` 同样带范围。
- **不可撤销操作**：停用会撤销句柄并取消任务，且没有恢复路径；服务端先验近期认证再变更，控制中心停用/退回命令已带 `recentAuthenticationRef`。
- **规则/文档一致性**：`docs/architecture-v0.1.md:364`、`ci/operations-pending.json`、契约、控制中心清单、i18n 与代码一致；`capability.rollback` 留在 `notInstalled`，代码确实未安装。
- **模型请求**：本 PR 未改 prompt catalog、工具定义、历史、遮盖或模型请求装配文件。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动文件集中在网关、SQLite、契约、控制中心、运维脚本和文档，没有系统提示、工具定义、历史消息、遮盖逻辑或 prompt 装配的改动。因此发给模型的内容仍然只可能在末尾追加；本 PR 没有新增“每轮会变”的值到请求开头。需要说明：我没有运行 `npm run check:prompt-prefix`，依据是改动文件清单和调用点。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会影响模型请求。新增的 `lastInvalidation.occurredAt` 是停用时写入一次并持久化，不会每次请求重算；`dependencyTaskRefs` 经 SQL `ORDER BY id` 和 `distinctSorted` 排序，顺序确定。网关响应里原有的 `generatedAt` 仍随时间变化，但它不是模型提示内容。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`scripts/check-operations.mjs` 校验操作 id 在契约、已安装清单、控制中心清单、处理方和测试中一致；新增/修改了 `test/integration/production-capability-gateway.test.ts`、`test/integration/sqlite-durable-repositories.test.ts`、`test/tooling/prod-read.test.mjs`、控制中心单元测试。反向用例覆盖：null/不匹配认证被拒且状态不变、同一幂等键换正确引用后成功、退回未安装且状态不变、暂停任务计入取消数。若去掉认证检查、把暂停任务排除出计数、或安装 rollback，这些用例会失败。缺的是跨 owner/agent 和“已撤销任务不计入”的反向用例。未实际执行测试。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   逐个核对如下：
   - `capability.list/detail/disable`：契约 `contracts-v2.ts:93,108-109` 有定义；`production-approval-gateway.ts:80-84` 安装；`production-http-composition.ts:707` 对外公布；控制中心清单和 `ci/operations-pending.json` 同步；`check-operations` 覆盖。
   - `capability.rollback`：契约仍保留，但生产不安装（`PRODUCTION_CAPABILITY_OPERATIONS` 不含它），`ci/operations-pending.json` 留在 `notInstalled`，控制中心按已安装操作过滤按钮，两端一致。
   - `recentAuthenticationRef`：契约 `contracts-v2.ts:2188,2198` 接受 `string | null`；控制中心发送 `configuration.recentAuthenticationRef ?? null`；网关适配器读取并交给 `RecentAuthenticationGuard`；`null` 会被拒绝。两端可接受。
   - `lastInvalidation`：SQLite 在停用事务产生（`sqlite-durable-operations.ts:2693-2700`）；端口类型 `capabilities.ts:273-280`；读模型 `governance-gateway-adapter.ts:494`；契约 `contracts-v2.ts:2661-2667`；控制中心显示和 fixture 都已更新。`cancelledScheduledJobs` 是非负整数，`occurredAt` 是时间戳，与契约一致。
   - `listScheduledJobRefs`：端口可选，SQLite 适配器和 durable adapter 实现，生产网关调用并回退 `[]`；当前生产使用 SQLite，能接受。
   - 唯一需要留意的是：新增读操作无上限，以及服务层本身不内置最近认证；这两点已在上面的低严重度发现中写明。
