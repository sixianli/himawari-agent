## 查过的范围

- 增量：`git diff 37d6776b..04b4bd57` 的统计与三个文件 diff；净改动：`git diff f6997c3b..04b4bd57`。
- 两个父提交：`420b3562f`（PR 分支，含第 4 轮复核记录）与 `f6997c3b0`（main）在三个文件上的版本差异。
- 数据导出：`scripts/check-data-export.mjs`、新测试 `test/integration/data-export.test.ts:1031-1074`、`packages/persistence-sqlite/src/data-export/export.ts:789-793`、迁移 `20261114154943_apple_push.sql`、导入侧。
- 测试夹具：`test/fixtures/device-api-harness.ts` 的选项与字段使用端，包括 `device-gateway.test.ts`、`notification-actions.test.ts`、`perception-*` 等。
- 上一轮第 3 条：`apps/agent-service/src/production-apple-push.ts`、`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts`。
- 说明：`git grep` 被本环境的命令白名单拒绝，改用 `grep` 工具按同样关键字核对；`npm run check` 不能运行，作者“55 步全过”未独立核实。

### 1（低）上一轮第 3 条未修复：实时活动“已开始”清理仍只扫前 500 条，并逐条查询

- 文件:行：`apps/agent-service/src/production-apple-push.ts:33`、`:513`；`packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:665-676`
- 问题：`#activityStarts` 的清理仍只取前 500 个 key，且对这批 key 逐个执行单行查询；超过 500 的 key 不会被本轮清理，长期运行会积累，已结束的 run 也可能继续占位。
- 证据：`const ACTIVITY_READ_BATCH = 500;`；`const remembered = [...this.#activityStarts.keys()].slice(0, ACTIVITY_READ_BATCH);`；`readActivityRuns` 内部是 `return [...new Set(input.runIds)].flatMap((runId) => { const run = read.get(...); ... });`。另外，`git diff 37d6776..04b4bd57 -- apps/agent-service/src/production-apple-push.ts packages/persistence-sqlite/src/sqlite-apple-push-operations.ts` 无输出，说明这次增量没有动它，上一轮的低严重度意见并未改好。
- 建议：用游标或分批快照遍历全部 key；把 `readActivityRuns` 改成单条 `IN (...)`/JOIN 查询；给 `#activityStarts` 设上限并在超限时按确定顺序淘汰；补一条超过 500 个 key、其中第 501 个之后有已结束 run 的测试。
- 读代码证实的：只取前 500、逐条 `.get`、增量未修改该文件。
- 推测：第 501 个之后的过期条目会一直保留，可能阻止同一设备/run 再次开始，并带来内存增长；影响大小取决于运行时长和设备数。

### 2（低）合并后计划目录顺序与正文顺序相反

- 文件:行：`docs/execution/plans/2026-11-11-apple-device-body-plan.md:29-30`、`:113`、`:147`
- 问题：阅读导航按“第 4 批 → 第 5 批”排列，正文却是“第 5 批 → 第 4 批”；从目录点“第 4 批”会跳到第 5 批之后，再点“第 5 批”又跳回上方。
- 证据：目录第 29 行 `- [第 4 批的任务（服务器部分）](#batch-4-server)`，第 30 行 `- [第 5 批的任务](#batch-5)`；正文第 113 行是 `<a id="batch-5"></a>`，第 147 行才是 `<a id="batch-4-server"></a>`。
- 建议：把第 5 批整节移到第 4 批之后，或把目录改成与正文一致的“5 → 4”；两处只保留一种顺序。
- 读代码证实的：两个锚点都存在，两个条目都保留；正文与目录顺序不一致。
- 推测：只影响阅读导航，不影响构建或测试。

## 三处合并结果核对

- 数据导出条数：main 的 `REQUIRED` 是 112（`git show f6997c3b0:scripts/check-data-export.mjs`），合并结果是 113（`scripts/check-data-export.mjs:18`）；`git diff f6997c3b..04b4bd57` 在这 7 个导出测试文件里只新增了一条 `[P1-6]` 测试（`test/integration/data-export.test.ts:1031`），没有删除或改写其他测试。作者“main 112、本 PR 多 1 条”的说法与代码一致。作者称 `DATA_EXPORT 132 条通过`，未独立复跑。
- 计划目录：main 只有第 5 批条目，PR 分支只有第 4 批条目，合并结果两个目录条目和两个正文小节都保留了；保留正确，但插入位置造成上面的顺序问题。
- harness 选项：main 的 `searchControl` 与 PR 分支的 `applePush`、`revokeHookFails` 都在 `test/fixtures/device-api-harness.ts:116-123`；`protector` 也保留在 `Harness` 和返回对象里（`:112`、`:403`）。类型端 `createProductionApprovalGateway` 确有 `searchControl`（`production-approval-gateway.ts:113`），`DevicePushServiceOptions` 接受 `store/reactions/configuration/now/onPresence/onRegistered`（`device-push.ts:87-96`），`PairedDeviceServiceOptions` 接受 `prepareRevoke`（`paired-device-service.ts:87`）。未发现合并后的类型不匹配。

## 侧重检查

- 错误路径：新增的反向测试覆盖“推送令牌/通知按钮凭据出现在导出文件”和“导入恢复这两张表”；若回归，`expect(text).not.toContain(...)` 或导入后的计数断言会失败。测试直接插入数据库的值逐项满足迁移中的约束（`apn_` 前缀且总长 26、token 为十进制十六进制、`expires_at > created_at` 等）。
- 不可信输入/解析：本次三条合并结果没有新增生产输入解析；新测试使用固定常量，不经过模型或设备输入。`searchControl` 只是把测试替身透传给审批网关。
- 安全：导出侧把苹果推送令牌和通知按钮凭据列入 `omitted`（`export.ts:789-793`），新测试实际检查了令牌、哈希、topic 和 `apn_` 编号都没有出现在任何导出文件里；未发现新增日志或明文泄露路径。
- 资源耗尽：见意见 1，实时活动开始记录的清理仍受 500 上限和逐条查询影响。
- 不可撤销操作：本次增量只改测试夹具、文档和检查脚本；生产 `PairedDeviceService.revoke` 的 `prepareRevoke` 行为没有被这次合并改变，harness 里的 `revokeHookFails` 只是测试用。
- 规则/文档一致性：`prompt-prefix.md` 的规则仍然要求“固定在前、会变的在最后一条用户消息”；本 PR 净改动没有触碰 `packages/prompt-catalog`、`runtime-pi`、系统提示或工具定义。计划文档第 5 批正文与表格行关于“感知记录的删除不在这一批”的说法一致；唯一的文档不一致是意见 2 的顺序。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本轮三条合并结果分别是检查脚本、计划文档和测试夹具；`git diff f6997c3b..04b4bd57` 的净改动没有系统提示、工具定义、历史消息、遮盖或 `packages/prompt-catalog`/`packages/runtime-pi` 文件。相对 main，PR 的净差异没有触碰请求构造；合并带入的 main 感知/提示词内容属于 main 已有改动，本轮未重复判定。未发现每轮变化值进入前缀。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及。新测试使用的 `pushToken`、`actionTokenHash`、`snapshotHash`、`NOW` 都是固定常量；新增的导出省略项是固定中文标签，不进入模型请求。未发现带时间的模型可见字段、无序集合或按后文变化的遮盖。
3. **有没有对应的自动检查？反向用例真的会失败吗？** 有。`scripts/check-data-export.mjs:18` 把下限改为 113，新测试带 `[P1-6][reverse]`；如果导出泄露令牌/哈希/topic/`apn_` 编号，或导入恢复 `apns_registrations`、`notification_action_tokens`，测试会失败。作者称 `npm run check` 55 步、`DATA_EXPORT 132 条` 全过；本环境不能运行 npm，**未独立核实**。需要说明：`REQUIRED=113` 是下限，按作者说法实际通过 132 条，所以单靠这个计数无法发现“这条新测试被删掉”（这是既有阈值策略，不是本次合并新引入）。文档目录顺序没有自动检查，意见 2 不会被现有检查拦住。
4. **每个新值的使用端都能接受吗？**
   - `REQUIRED=113`：只由 `check-data-export.mjs` 消费；main 112 + 新增 1 条 `[P1-6]` 测试，两端一致。
   - 导出省略标签 `苹果推送令牌和通知按钮凭据`：产生于 `export.ts:790`，消费于 `data-export.test.ts:1067`，字符串一致。
   - 新测试直接写入 `apns_registrations`/`notification_action_tokens`：已按迁移的 CHECK 逐项核对，均满足。
   - `searchControl`：类型来自 `createProductionApprovalGateway` 的选项，消费于 `device-gateway.test.ts:612`；`applePush`/`revokeHookFails` 消费于 `notification-actions.test.ts:50-55`；`protector` 消费于 perception 测试；`presence/registered/revoking/wiped` 消费于 `notification-actions.test.ts:412-649`。未发现不接受的另一端。
   - TOC 锚点 `#batch-4-server`、`#batch-5`：两端都存在，问题只是正文顺序（意见 2）。
