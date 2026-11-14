# PR 520 第 1 轮作者说明

问题：PR 436 的通用提议箱 `owner_proposals` 只有“待采纳 → 已采纳 / 已拒绝 / 已过期”，没有执行层。“主动提议下一步”要让一部分提议（确定动作，例如把提醒改到 9:40）在主人点头后由程序执行，需要：主人的决定和执行结果分两列、领取时的租约、采纳时服务器能验的“本人在场”和“看过全文”凭据、撤销是终点、来源标记由服务器定。方案：仓库外 `/mnt/project-files/ambient-sensing/proposed-actions-plan.md` “审核后改的地方”第 2、4、5、6、7、14 条（Andy 2026-11-12 已同意）。

改动：
- 迁移 `packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql`（`.meta.json` 声明 alters）：给 `owner_proposals` 加 exec_status、lease_id、lease_expires_at、attempts、requires_full_read、requires_presence、executed_at、execution_ref。
- `packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts`：`claim`（带版本号和指纹条件，同时把决定改成已采纳、执行改成执行中并记租约和尝试次数）、`moveExecution`（只允许固定的执行状态转换、带租约条件）、`listExpiredLeases`；`propose` 对已有执行记录的编号返回 `closed`；决定加 superseded、withdrawn。
- `apps/agent-service/src/production-proposals.ts`：`ProposalActionHandler`（verify、execute、readBack、undo）；`#adoptAction`（核对前提 → 本人在场 → 看过全文 → 领取 → 执行 → 记原样 → 读回）；`undo`（撤销是终点）；`#recover`（租约过期只读回，不重做）；`openFull`（服务进程内存里的短期凭据，绑编号、版本号、指纹）；`propose` 的 `externalContentSeen` 让来源标记一律记 `external_content`。
- `apps/agent-service/src/production-proposal-control.ts`、`packages/gateway-contracts/src/contracts-v2.ts`：`proposal.respond` 加 undo 动作和 `recentAuthenticationRef`、`fullReadToken`；`proposals.read` 加 `open`，快照加 `requiresFullRead`、`requiresPresence`、`opened`；控制层 `execute` 现在收 `authentication`，经 `RecentAuthenticationGuard` 核对。
- 测试 `test/integration/owner-proposal-execution.test.ts`；文档 `docs/architecture-v0.1.md` 提议箱一节。

约束：不调模型、不改发给模型的任何内容（本 PR 不涉及模型请求）；不顾旧数据兼容；规则（`owner_rule`）提议的现有行为不变；表里不对会增长的取值写 CHECK 枚举，取值在代码里校验；不写代码注释；没有网页界面。没做的（后续 PR）：清除/导出/导入这张表、两种具体确定动作、“去办一件事”开运行、入口表。

作者的说法（请核对，不要照信）：
1. 两台设备同时点同一个提议，只有一个能领取并执行（`claim` 的条件更新）。
2. 租约过期的执行永远不会被再执行一遍，只读回核实。
3. 同一编号撤销后再提议不会重新打开。
4. 凭据对不上或过期时，什么状态都不改。
5. 规则类提议（有 `adopt` 的旧处理方）的行为没变。

请重点核对：
1. `claim` 与 `moveExecution` 的状态转换表（`EXECUTION_STEPS`）有没有漏掉或多放的转换；`unknown → succeeded`、`unknown → failed` 允许是否合理；租约在 `moveExecution` 到终态时被清除，之后的转换带 `leaseId: null` 是否有绕过租约的路径。
2. `#adoptAction` 里“先 verify 再 claim”“claim 失败后重新读状态再报错”的各分支：有没有可能 verify 通过、claim 成功后因为 `execute` 抛错而把一条提议永远卡在执行中。
3. 读回出错记“结果不明”后，这条提议再也不能采纳也不能撤销，主人在界面上会看到什么、有没有出路（只需指出，不需改）。
4. `openFull` 凭据只存内存：进程重启、多个进程、并发打开的行为；每个提议只保留最新凭据的逻辑；容量满时的清理循环是否正确。
5. `propose` 里 `requiresFullRead` / `requiresPresence` 的默认值逻辑（依赖登记时的处理方）：提议入箱时处理方还没登记会怎样。
6. 网关合约：新增必填字段 `recentAuthenticationRef`、`fullReadToken`、`open`、`opened`、`requiresFullRead`、`requiresPresence` 后，所有生产者和使用者（`apps/control-center/src/memory.ts`、测试夹具、客户端能力表）是否都已对齐。
7. 迁移：`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT ... CHECK` 在 SQLite 里对已有行是否合法；`.meta.json` 的 alters 声明是否足够。
