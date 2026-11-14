# PR 497 第 8 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 中高 ADR 0268 改动没有配套的 plan-claims 记录，`--assert-reviewed` 会报 `claims-stale` 并让队列移出该 PR。对 a79f8dbc3 上的 ADR 重跑 plan-claims 并提交记录；触发：ADR 改过之后没有重跑声明核对就跑合并前检查；后果：--assert-reviewed 报 claims-stale，不能合并；判低理由：这是合并前检查本来就会拦下的流程步骤，不是代码缺陷，不会合错代码；修法是对最终 ADR 重跑一次声明核对，不改代码
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低 去掉 `VERDICTS_INVALID` 的“到不了”只有人读代码支持，没有反向用例。补了用例：low-fix 检查遇到坏 verdicts 时报问题而不崩溃，改成直接抛出时用例失败；触发：以后有人让 lowFixProblems 把 verdicts 解析错误直接抛出；后果：--assert-reviewed 崩溃，合并队列停下而不是只移出这个 PR
