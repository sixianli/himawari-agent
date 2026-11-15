# PR 584 第 5 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. 低 — ADR 说“这段原文只在退回原做法时使用”，但第一轮全量复核也会出现这句。代码属实：opencode-review.mjs:377 scoped 要求 previous，首轮 base && !scoped 照样输出这句（:396）；但 ADR 0280 前提 1 的主语是“增量轮原来的提示”，在增量轮范围内“只在算不出增量、退回原做法时使用”是对的，首轮本来就不是增量轮，读者不会因此做错；补一句“第一轮仍用它”只是更清楚，属于可以更好
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 低 — “--assert-reviewed 的结果不受 shadow 影响”说得过满。代码属实：recordSecretProblems（opencode-review.mjs:3420-3428）用 git ls-tree -r 递归扫整个账本目录，含 shadow/；但这句话只在材料文件（brief 第 15 行作者说法 4）里，仓库的 ADR、指令和代码里都没有这句，轮次和覆盖判断确实只读顶层 usage.jsonl（:1758）；shadow 记录参与敏感信息扫描是该有的行为，不改代码，只是作者说法可以写得更准
