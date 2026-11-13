# PR 481 第 2 轮判断（deepseek-v4.1-flash）

没有中、高意见，全部按低处理，改动小，用 `--accept-low 2` 记账，不再复核。

- 1 成立，低：读不出时改为四段 `- unreadable:<原因> - -`，文档同步。
- 2 成立，低：补 rests.json 是目录（EISDIR）的用例。
- 3 成立，低：按码点截断，补 81 个 emoji 的用例。
- 4 成立，可以更好：文档写明这两行只在运行时打印、`--report` 不含，耗时数字在账本里（只改文档）。
- 5 不成立：本线程真实 Magpie 用量（gateway-live/config/magpie/usage.jsonl，24 行）每行都有整数 `status` 200 和字符串 `session`（如 `ses_e2bf1dfd5ffesKZjZ4fED8ZALr`）；本轮实跑 `REVIEW_TIMING ... cacheMisses=2`，没有恒为 0。
- 6 成立，低：耗时统计改用和费用汇总相同的 `line.status >= 200 && line.status < 300`。
