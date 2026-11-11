# PR 378 第 7 轮复核判断

复核提交 5671bb24，只用 DeepSeek（Andy 选“再跑一轮 DeepSeek”）。第 6 轮的三处修改复核认为方向正确，没有新问题；本轮另找到 3 条“中”级的老问题，已改，未复核。逐条判断写在同目录的 `verdicts.jsonl`。

## 会出错：中、高（已改，未复核）

- r7-1 某条记忆解密出错会让整轮失败并每天重来：出题时读取出错计为 `source_unreadable`、记进 `declined`；作答时读不出的题计为答不了。
- r7-2 取不到原话的记忆每周占名额：`source_missing` 也记进 `declined`。测试 “skips a memory whose text cannot be read or has no source and asks about the rest”，变异验证过。
- r7-3 将来时间的标记永不过期：开始时间晚于现在的按读不懂处理，修改时间在将来时先改成现在。测试 “treats a marker dated in the future as unreadable and lets it expire”。

## 会出错：低（已改或写进 ADR）

- r7-5 `once` 花到上限后不重跑：有意设计，写进 ADR。
- r7-6 “一点几分”：补上“几”，加测试。
- r7-8 退役题占着唯一键：写进 ADR 后果。

## 可以更好（已改文档）

- r7-7 样本里的正文只遮敏感值：ADR 和案例 87 改了说法。
- r7-9 报告脚本不分主人：写进 ADR。

## 不成立

- r7-4 没有 runId 的旧标记：那个版本没上线过。
