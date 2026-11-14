# PR 481 第 1 轮判断（deepseek-v4.1-flash）

- 1 成立，会出错，中高：失败请求不再参与缓存判断，补“200 → 502 → 200”反向用例；去掉修复后该用例失败（expected 0 to be 60000）。
- 2 成立，会出错，低：没有字符串 session 的行跳过缓存判断，同一用例覆盖。
- 3 成立，会出错，低：文件不存在仍返回空；读失败、坏 JSON、根不是对象时打印 `unreadable <原因>`，补用例。
- 4 成立，会出错，低：清理 `\p{Cc}\p{Cf}` 并截到 80 字符，补用例。
- 5 成立，可以更好：delegate.mjs 的汇报要求加上 REVIEW_TIMING 和 GATEWAY_REST（Andy 定“可以更好”直接改）。
- A 不成立：真实 Magpie 用量行里起标题请求就是 `"effort":"low"`（本线程实测 gateway-live/config/magpie/usage.jsonl：`req group/review-deepseek-v4.1-flash, effort low, in 1415, out 120`），其余 23 行都没有 effort=low。
- B 不成立：本轮复核 OpenCode 自己算的费用 `REVIEW_RESULT ... cost=0.0981` 和修复后 Magpie 折算的 `GATEWAY_USAGE ... usd=0.0981` 相同；修复前两者差约三成。
- C 不成立：真实 rests.json 是以服务方为键的对象，字段 why/status/until（`{"opendesign":{"why":"credit","status":402,"until":...}}`）；结构不对时现在也会打印 unreadable。
