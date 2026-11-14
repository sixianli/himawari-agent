# PR 504 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. 低：新增断言用宽松正则，未锁定原因、轮次和提交。测试断言写法偏松，但它要求 chain-already-broken 开头且 use=new-round 结尾，旧代码结尾是 use=no-previous 会失败（test:1809），反向有效；原因文字未被改写由 replace 只动 ' use=' 之后保证。可改精确断言，属写法可更好，不是错误。
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 低：用正则剥掉 ` use=...` 生成建议，耦合消息格式。joins 的四个返回（opencode-review.mjs 约 1480-1500）都以单个 ' use=' 结尾，原因中的 head/previous 经 git rev-parse 和 COMMIT_PATTERN 校验为哈希，没有可达输入带 ' use=' 而被截断；结构化返回是可选重构，当前行为正确。
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 低：新增用例未经过 `roundForRun`，同模型重跑时实际会先被别的错误拦住。模型自己也说是函数级契约；previousProblem 是独立导出函数，用例直接测它的返回；CLI 入口里同模型重跑先被 ROUND_ALREADY_HAS_RESULT 拦住是既有设计，不使这条提示错误，换模型补跑时可达。属覆盖说明，不是代码错误。
