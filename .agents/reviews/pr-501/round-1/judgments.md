# PR 501 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 中：永久被跳过的题目每次预评运行都会重新 build/读取原文，且每次运行都写日志。review-prereview.ts 的跳过路径确实不进 24 小时退避；已加进程内 classificationSkipped 表（24 小时过期，模型放开级别时立即失效），第二次运行不再 build，测试 [P4-8] skipped subjects do not take the per-run slot 断言读取次数不增加；触发：预评模型长期不允许 sensitive 且待评池里有 sensitive 题目：每个定时 tick 都对这些题目重新 build（读取并解密原文），并每次写一条 proactive.prereviewed 日志；后果：只是重复的本地读取和日志增多（上限 500 条的本地读，不外发、不花钱、不丢数据），不影响结果正确性；判低理由：build 是本地读取，不外发不花钱，被跳过题目数有上限 500，只是多余开销；但仍在本分支改掉
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 低：新增测试没有覆盖每日 attempts 被跳过占用，也没有证明提示/费用在跳过前未组装；反向用例在旧代码上失败只因缺字段。测试覆盖可以更强；已补 perRun=1 且跳过项排在前面的用例，证明跳过不占名额、提示里没有私密文字；每日次数同一代码路径（attempts 只在 attempted 之后加）
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 低：跳过行为与 ADR 0237 的描述不一致，本次提交没有更新文档。ADR 0237 是已采纳的决定记录，不写实现细节的每一种跳过；代码行为与其不冲突，只是没列出第三类，建议 Andy 决定是否补一句
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 低：两个 real-eval 测试替身仍缺必填的 `allowedDataClassifications`，靠 `as unknown as` 绕过类型检查。real-eval 测试替身只调用 prepare/model，不读该字段，没有运行影响；已给 invoker() 替身补上 allowedDataClassifications
