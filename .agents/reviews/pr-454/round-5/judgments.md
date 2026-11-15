# PR 454 第 5 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 低 — 新增 UNION 把 runIds 绑定两次，超长监控历史可能永久卡在 retry_wait。sqlite-durable-operations.ts 新增的 UNION 把 runIds 绑定两次。第 3 轮起只剩低问题，不修，交给 Andy 看。；触发：单个 GitHub 监控的历史 run 数超过约 1.6 万（SQLite 默认 32766 个变量的一半）；后果：删历史的事务回滚，进入重试等待，主人删不掉这份历史；正常使用远达不到这个量
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低 — 删除历史会抹掉已交付但未回报动作的证据，设备再回报得到 404。governed-deletion 删对话/轮次时也是同样不分状态一起删（sqlite-governed-deletion.ts #removeDeviceActions）。是产品取舍，不是错误。；触发：主人删 GitHub 监控历史，而该监控的某一轮有已送达设备但还没回报的动作；后果：设备之后回报得到 404，读回结果不落库；历史本来就是主人要求删的，动作和记录一起删符合“删就是删”
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 低 — 新测试只覆盖 arguments_ref，result_ref 与“别的 run 不受影响”没有反向用例。测试里设备动作的 result_ref 为 NULL；覆盖缺口，不影响现在的行为。；触发：以后有人改这段删除逻辑；后果：result_ref 载荷收集和“另一个 run 不受影响”没有反向用例保护
