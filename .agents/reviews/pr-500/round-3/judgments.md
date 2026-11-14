# PR 500 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）不成立：### 1. 中：未知服务器值原样以 `.public` 写入系统日志，且“64 个字符”不是字节上限。沿用第 2 轮第 3 条、第 1 轮第 4 条原判：os.Logger 每条调用是一条结构化记录，换行不能伪造新记录；枚举字符串按契约不是用户数据（ServerValues.swift:9）。新点“按 Character 截而非按字节”：只有服务器故意发超长组合字符串才触发，结果只是一条较长的日志，且受服务器响应体大小限制，没有错误结果
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低：增量测试没有真正守住 `startOverWarning` 的接线和 `%d`。PairingProblemCoverageTests 原只查键存在；第 3 轮起低意见不修，列入报告“低严重度未修”；触发：有人把 PairingView.swift 的确认框改回 L.text(pairing.startOver.confirm)，或某语言的 confirmUnsent 丢了 %d；后果：测试仍通过；确认框不显示未发送消息数，只是提示不够准，不丢数据，用户仍要手动确认
- 3（deepseek-v4.1-flash）不成立：### 3. 低：Apple 专属代码没有编译证据，源码文本测试也无法替代编译。Linux 不编译 Apple 目标是已知的仓库设置（Package.swift:21-23），不是本 PR 引入；这轮增量只有测试文件；Mac 编译由主线程/Andy 在 Mac 上做，无代码输入会出错
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 低：进程级一次性 64 个上限、截断后再去重，会让“每个不同值报一次”不成立。沿用第 2 轮第 4 条原判：全局 64 上限和截断后去重是有意取舍，要先出现 64 个不同未知值才触发，不是会出错的输入，列给 Andy
- 5（deepseek-v4.1-flash）不成立：### 5. 低：作者材料与代码有多处不一致。沿用第 2 轮第 1 条原判：这是材料文字不一致，不是代码；代码里没有会出错的输入
