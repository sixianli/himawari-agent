# PR 436 第 1 轮判断

核对方式：逐条读代码，并对修改补了真实 SQLite 的反向用例（`production-memory-capture.test.ts` 的 `[A-1]` 组）。

## 会出错 · 中、高（已改）
- d1 提议编号没有 agentId、主键是全局的：同 owner 第二个 agent 提同样内容会撞主键。属实（`0095` 的主键、`production-owner-rules.ts` 的哈希）。改：哈希加入 agentId，主键改成 `(owner_id, agent_id, id)`。测试：`tells proposals from two agents of one owner apart`（去掉哈希里的 agentId 会失败）。
- d2 先写表后写载荷：载荷写失败会留下无法采纳的待采纳行。属实。改：先写载荷再写表，写表失败或已满时把这次刚写的载荷删掉。测试：`drops what it wrote when the list is full`（已满时载荷列表不变）。
- d4 对话删除后采纳仍用载荷里的旧对话编号写记忆。属实（`#activate` 用 `proposal.threadId`）。改：采纳时用表里的对话编号（对话删除后为空）。测试：`adopts a proposal whose source conversation is gone`。

## 会出错 · 低（已改）
- d3 载荷只写一次，重新提议后依据陈旧。判低：不丢数据，不给出错误结果，只是依据不是这一次的。改：已拒绝/已过期/已撤销后再提议时重写载荷；待采纳中的保持第一次的依据。测试：`rewrites the basis when a refused proposal comes back`。
- d7 缺反向用例：已随 d1、d2、d3、d4 补上。
- g1 延长过期日的分支不更新来源标记。改：同步更新 origin 和对话编号。
- g2 已采纳且同参数规则仍在生效时再次提议，会出现“规则已生效”的待采纳卡片。改：这种情况不新建待采纳，按已有规则回执。测试：`does not stack a waiting proposal on a rule that is already enforced`。

## 不成立
- g3 旧库里已有的待采纳行会因哈希方式改变而重复：不成立。旧版本从来没有表行，旧提议只有载荷，列表本来就不显示它们，没有行可重复；旧载荷仍可按编号采纳。

## 可以更好（不改，列给 Andy）
- d5 已拒绝/已过期的行和载荷没有清理：计划要求“保留拒绝历史”，保留多久是产品取舍，且每条要有一次模型提议才会产生，暂不清理。
- d6 `revision()` 不含待采纳提议：现有的长期规则列表同样不在 `revision()` 里，控制中心在每次操作后和每 5 分钟刷新；统一补进 `revision()` 需要对所有规则一起设计。
- d8 提议表没进数据导出：待采纳提议是临时数据，是否导出等 Andy 定。
- g4 退回认领失败被吞，行会停在已采纳：只有“写规则失败且同时写库失败”的双重故障才触发，再次点生效可恢复；现行为不变。
