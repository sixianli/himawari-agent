# PR 443 第 3 轮逐条判断

- ds-1（deepseek-v4.1-flash）「中：限流被无限重试，且与本次新增设计说明矛盾」：成立，中、高，已改。
- ds-2（deepseek-v4.1-flash）「中低：Live Activity 更新的失败没有退避，会按推送 tick 无限重发」：成立，低，已改。
- ds-3（deepseek-v4.1-flash）「中低：`#activityStarts` 的清理在批次满时完全跳过，可能长期增长；且没有测试」：成立，低，已改。
- ds-4（deepseek-v4.1-flash）「中低：Apple 侧失败会阻断同一次 tick 的网页推送」：成立，中、高，已改。
- ds-5（deepseek-v4.1-flash）「低：未知动作的拒绝逻辑正确但没有反向用例；路由的默认映射埋下未来扩展风险」：成立，低，已改。
- ds-6（deepseek-v4.1-flash）「低：`activityLimit` 生产端有 1..64 上限，消费端只有下限」：成立，低，已改。
- ds-7（deepseek-v4.1-flash）「低：`apple-push` 用途字符串两端一处用常量、一处用字面量，存在静默失配风险」：成立，低，已改。

ds-4 模型给的是中低，线程判中高：它会拖住原本正常的网页推送。ds-6 里顺带提的派生主题超长也改了（主题最长 232 个字符，加上后缀不超过苹果的 255）。模型推测的连接超时没改：发送器的超时用例（test/integration/apple-push-sender.test.ts）覆盖了连不通和超时都返回 retry。
