# “控制复核”方案讨论：三方比较和取舍

| 来源 | 意见 | 取舍 |
|---|---|---|
| DeepSeek 方案 | 强制服务方用白名单 `--gateway-provider`，缺模型时停下不换回 | 采纳白名单思路，参数名用 `--providers` |
| GLM 方案 | 停止复用现有 `stop(reason)` 路径写账本，`owner-stopped` 加进 `GUARD_DEFERS_TO_PARENT`，打印 `REVIEW_PID` | 采纳 |
| DeepSeek 方案 | 新一节不能被 `reviewQuestions` 当成必问问题，加“正好 4 条”的测试 | 采纳 |
| DeepSeek 审核 1（高） | `--providers` 会让积分检查被跳过 | 成立，条件改成“CodeBuddy 不在 drop 里” |
| DeepSeek 审核 2、GLM 审核 1（高） | 零轮覆盖被 `ledgerMatchesHead` 拒、目录不存在、写完就放行 | 成立，改成先写、提交后认出才放行 |
| DeepSeek 审核 3、GLM 审核 3（中） | `process.once` 第二次信号不清理；`stop` 拿不到；不能先清理 | 成立，改信号接线 |
| DeepSeek 审核 4（中） | 没列出的服务方仍会被配置登录 | 成立，不传给 `startGateway` |
| DeepSeek 审核 5（中） | `three-rounds` 会把 `owner-stopped` 算一轮 | 成立 |
| DeepSeek 审核 6（中） | 提交账本后 `--round` 补跑撞 `ROUND_HEAD_MISMATCH` | 成立，文档写明 `--head` 传被停那轮的提交 |
| DeepSeek 审核 7、GLM 审核 4 | 新一节要以 `##`/锚点起头，反向用例插在必问问题那一节 | 成立 |
| DeepSeek 审核 8、9，GLM 审核 4 | 文档多处没同步 | 成立，列入改动 |
| DeepSeek 审核 10（低） | 停止请求落在追问、替补启动前 | 成立，加 `stopRequested` |
| DeepSeek 审核 11、12、13、14 | 测试目录、校验时机、`gatewayDropped` 校验 | 成立 |
| DeepSeek 审核 15 | `REVIEW_PID` 要靠后台命令 | 成立，线程本来就后台跑复核，文档写明 |
| DeepSeek 审核 16 | 替补模型的组在 `--providers` 下可能缺成员 | 不处理：已有规定新服务方必须提供两个模型 |
| GLM 审核 2 | 现有 4 处 `needs=3` 用例要改 | 成立 |
| GLM 审核 6 | drop 顺序要固定 | 成立 |
| GLM 审核 8 | `low-fix-invalid` 也能盖过，风险要点名 | 成立，写进风险 |
| DeepSeek “如果由我来定” 1 | 另做 `--skip-review` | 不采纳：Andy 决定整体放松，两个相近参数更容易用错 |
