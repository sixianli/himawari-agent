# PR 436 第 2 轮判断

## 会出错 · 中、高（已改）
- d1 就地改写迁移 0095：0095 从未进过 main，是本分支自己的临时迁移号；仍按意见还原成首次提交的内容。跨 agent 区分靠提议编号哈希里的 agentId，测试 `tells proposals from two agents of one owner apart`。
- d2 已生效规则的去重只在编号相同时成立。属实。改：先查同参数的生效规则，有就直接按已有规则回执。测试：`does not queue a proposal for a rule that is already enforced even when it is worded differently`。

## 会出错 · 低（已改）
- d3 重提已撤销的已采纳提议，列表已满时先删旧载荷。改：先写表，成功后再删旧载荷。测试：`lets an adopted card be adopted again after its rule was undone, even when the list is full`。
- d4 拒绝与采纳竞态误报已过期：拒绝读到仍是待采纳时重试一次。重复激活不成立：规则创建是幂等的。
- 测试意见：来源标记刷新用例原话不同，已改成同一句原话先推断后主人说，断言标记变为主人说的。

## 可以更好（不改，列给 Andy）
- d5 已拒绝/已过期提议的行和载荷没有清理。
- d6 载荷读取不做结构校验。
