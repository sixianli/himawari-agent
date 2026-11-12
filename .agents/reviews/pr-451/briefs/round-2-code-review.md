# PR 451 第 2 轮：对第 1 轮意见的修改

第 1 轮（提交 1338704f1）之后有两类提交：合入基线分支（第 3 批）的两个提交，不属于本 PR 的改动；一个修改提交，处理第 1 轮的意见。请只看修改提交相对上一轮的增量。

## 作者的说法（请核对，不要直接采信）

1. 保存记忆时，新增的 perception 类型出处要求同一主人、同一 Agent 下有这条 active 的感知记录；这条记忆已经记过的出处不再查（`packages/persistence-sqlite/src/sqlite-memory-operations.ts`）。
2. 重新开始抽取时，上一次状态是 `waiting_budget` 的不给 `attempts` 加一（`packages/persistence-sqlite/src/sqlite-perception-operations.ts`）。
3. `confirm` 为真的设备动作，没有接确认入口或确认入口没有返回 true 时不执行（`apps/agent-service/src/production-perception-tools.ts`）。
4. 数据导入拒绝没登记的出处类型和格式不对的 perception 编号，perception 出处导入后标成出处已删（`packages/persistence-sqlite/src/data-export/import.ts`）。
5. `perception_read` 一次调用最多看 `readMaximumScanned` 条记录，没看的条数如实告诉模型。
6. 一段经历里的口头指令编号每 1000 个查一次。
7. 后台被拦下时给模型的固定说明不再说“留给主人以后决定”。
8. 入口检查的范围没有扩，计划文档写明了这一批只管四种动作和原因。

## 约束

和第 1 轮相同：发给模型的内容只追加；外部内容只当资料；`packages/persistence-sqlite` 只能从 `packages/application` 做类型导入。
