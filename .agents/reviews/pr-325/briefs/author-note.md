# 作者说明

问题：前端和后端之间约定了一批网关 v2 操作（`packages/gateway-contracts/src/contracts-v2.ts` 的 `GATEWAY_V2_MESSAGE_TYPES`），其中一些只有名字没有实现、一些实现了没人调用。没有自动检查能发现“定义了没人用”。提醒的“取消”和“忽略”还写成同一个状态。

改动（base=origin/main，head=本 PR 最新提交）：
- 从约定里删除 18 个后端、前端、测试都没有使用的查询和命令（任务、收件箱、追踪、设置、会话、健康、`memory.search`、`memory.detail`、`thread.timeline`、`thread.checkpoint.request`），连同只服务它们的 8 个回执一起删；同步清理契约夹具、e2e 夹具服务器、界面清单 `control-center-inventory.ts`（没有任何操作的页面改成约定缺失、集成被阻止，`isSurfaceInstalled` 对空操作列表返回未安装）。
- 删除没人调用的 `rebuildSearch`（端口、SQLite 实现、适配器，一处集成测试调用）。
- 提醒真取消：迁移 0085 重建 `memory_reminders`，状态约束加 `cancelled`，约束改成“只有 scheduled 的行没有关闭时间”；`memory.reminder.respond` 的 cancel 和 `reminder_cancel` 工具写 `cancelled`。
- 新增 `scripts/check-operations.mjs`（`npm run check:operations`，已进 `check:steps`）：约定里每个查询/命令必须有后端实现（`apps/*/src`、`packages/*/src` 里的字面量，生产安装名单本身不算）、调用方（前端、scripts、admin-cli，界面文案 id 不算）、测试（真正的测试文件，夹具不算）；缺项但暂时保留的 23 项登记在 `ci/operations-pending.json` 并写理由；名单里已齐全的、名单外缺项的、安装名单里有约定外名字的，都报红。
- ADR 0192、测试 `test/tooling/operations-check.test.mjs`。

作者的说法可能有错，请对照代码核对，包括：删除的操作是否真的没有隐藏调用方（模型工具、脚本、夹具、其他包）；0085 迁移对已有数据是否安全（外键、索引、约束、`ON CONFLICT` 的 `schedule`）；`cancelled` 状态是否所有读写 `memory_reminders.status` 的地方都接受（含到期、即将到来、整理、导出、治理删除）；检查脚本的“调用方”“测试”判法是否有明显漏判或误判；`isSurfaceInstalled` 的改动是否会让某个页面被错误地判成已安装或未安装。
