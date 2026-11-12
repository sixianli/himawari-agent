# PR 441 第 2 轮作者说明

第 1 轮判断见 `.agents/reviews/pr-441/round-1/judgments.md`。主要改动（都在 `scripts/ci/ci-summary.mjs`）：
- 实测证实 CI 的 vitest 只开 JSON 和 JUnit 报告，`.log` 里没有失败用例名。`renderFailedLogs` 现在先输出“失败的用例”一段：从 `result.json` 登记为 `json` 的报告里找有 `testResults` 数组的，取 `assertionResults` 里 `status === "failed"` 的文件名、`fullName` 和第一条 `failureMessages` 的前 20 行；文件级失败（`status === "failed"` 且没有失败的用例）取 `message`。最多 30 条，占上限的一半。
- 命令日志只显示 `result.json` 登记为 `diagnostic` 且以 `.log` 结尾的文件；`details.json` 里退出码非 0 的命令的日志排前面；放不下时列出前 5 个文件名。
- `result.json` 读不出来或没有 `reports` 数组时，只写一句说明，不显示任何文件；路径是绝对路径或含 `..` 的不读。
- 控制字符之外，U+2028、U+2029 也换成 `?`；用例名里的反引号换成 `?`；ANSI 颜色码去掉。`logLines` 去掉末尾所有空行。`--failed-logs` 为空串时按参数错误拒绝。
- 文档同步（ADR 0243 第 4 条的补充、设计文档第 250、320 行）。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？
2. 失败用例一段的输入是不可信的 JSON（来自 PR 的测试运行）：字段类型不对、超大文件、超长名字、深层结构，会不会抛异常让这一步失败，或者绕过遮盖、绕过行前缀。
3. `reportPaths` 的路径过滤够不够（符号链接、绝对路径、`..`、Windows 分隔符）；`listFiles` 用 `lstat` 不跟符号链接，JSON 报告的读取是否同样安全。
4. 上限：失败用例一段加命令日志一段，总量是否仍不超过 64 KiB；`FOOTER_RESERVE_BYTES` 改成 512 后，说明文字是否一定放得下。
5. 排序改动（`first`）有没有影响原有的诊断显示顺序（确定性）。
6. 文档和代码是否一致。
