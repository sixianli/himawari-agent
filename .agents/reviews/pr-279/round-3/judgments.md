# 第 3 轮（提交 ded1e61f，只看增量）线程逐条判断

DeepSeek 两次服务报错（api-error），脚本按规则替补 GLM 跑了这一轮（账本 substitute）。

- r3-glm-1 取消标记永久锁存：不成立。我的说法本来是“服务停止后 start 一律拒绝”，实例只在关停时 cancel，行为与说法一致。
- r3-glm-2 cancel 与 start 竞态：成立，低。触发：stop 恰好落在 start 的两次等待之间，且范围内没有邮件。已改：#execute 开头先检查取消标记；用例（stop 紧跟 start、无邮件）在旧代码下失败（已实际运行）。
- r3-glm-3 gate 挡在列出不是读取：不成立。这只是提交说明 ded1e61f 里的措辞，已推送不改写历史；测试名与代码都没有写“读取”。
- r3-glm-4 Date.parse 过滤缺排除用例：不成立。用例“drops mail outside the asked range”本来就有，且在 main 的改动之后通过；NaN 不可达，因为 instant() 校验入口，Gmail 的 receivedAt 恒为 toISOString()。
