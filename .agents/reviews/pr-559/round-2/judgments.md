# PR 559 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 中高 — 放置到 Mac 的通知仍未记为已处理，会占满待发表批次并饿死后续通知。读代码证实：已放置项不记账，listDue 每轮按创建时间取前 50 行，放置项排在最前占名额。已改：待发表批次 = 50 + 当前放置条数（上限 500，production-web-push.ts #deliver 的 batch，apple 渠道同用），放置记录满 500 后不再放置（mac-placement.ts）；新增 push-channels 用例“a pile of notifications placed on the Mac”，把 batch 改回 50 时该用例失败。；触发：同一渠道里已放置到 Mac 且未过期的通知累计 50 条以上，再来一条新提醒；后果：新提醒进不了本轮批次，Mac 和 iPhone 都收不到，直到旧项过期（最长 6 到 24 小时）
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 中 — “选最近有输入的那台 Mac”的新测试没有验证收件设备，选错也会通过。测试只断言总帧数，选错设备也会通过，没有错误输出。已改：按设备分开记帧，断言 dev_new 收到 deliver、dev_old 为空。
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 低 — `/presence` 未接线时非 Mac 已返回 404，但没有回归用例。代码已正确，只缺回归用例，没有可达的错误结果。已改：harness 加 withoutNotifications，新增 device-notifications 用例（iPhone 得 404、Mac 得 ok:false）。
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低 — Mac 标题/正文上限没有测试，也没登记进设计文档的新值清单。读代码证实：Mac 标题 256、正文 2048 字节上限没登记进设计文档新值清单，也没有测试。已改：spec 第 17 节该行补上上限与截断规则；导出 clip 并加多字节超长文本用例。；触发：按 I-73 查设计文档新值清单；后果：新增的跨端约定没登记，文档与代码不符
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 低 — 重启后的重复响与收不到撤回仅文档化，未修复（作者说法属实）。同第 1 轮第 2 条的原判：放置状态只在内存是有意取舍，已写进 ADR 0273，模型自己也说作者说法属实，没有新证据，不持久化。
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6. 低（推测）— `withdrawExpired` 与主循环用了两个时刻，到期边界可能多响一次。读代码证实：withdrawExpired 原来读实时时钟，主循环用 tick 开头的 now，边界上可能先撤回再重发。已改：withdrawExpired 改为接收本轮 now 的毫秒值，两处同一时刻。；触发：通知有效期恰好落在 tick 开头与撤回之间的几十毫秒内；后果：Mac 上先撤回再重发一次，下一轮又撤回
- 7（deepseek-v4.1-flash）成立，会出错，低：### 7. 低 — `REMEMBER_LIMIT` 淘汰放置项时不发撤回，且可能被重复 deliver（旧代码，非本轮引入）。读代码证实：放置记录超过 500 条时删最旧项，不撤回，且该通知下一轮会被重发。已改：满 500 条后 place 返回 false（新通知走 iPhone），不再淘汰已放置项。；触发：同时有 500 条以上未过期的放置通知；后果：最旧一条在 Mac 上重复出现且收不到撤回
