# PR 338 第 2 轮复核判断

## 会出错（已修）

- r2-1（中，成立，读 Pi 源码并写用例复现）：第 1 轮加的捕获一致性检查会误拒。Pi 1.5.0 把运行中插入的 custom 消息（后台命令通知、压缩后的运行环境说明）存成 `custom_message` 条目，重建时时间戳换成条目自己的时间（`pi-coding-agent/dist/core/messages.js` 的 `createCustomMessage(..., timestamp)` 用 `new Date(timestamp).getTime()`），和内存里的对象不相等。新用例“captures a batch after a message steered in during the run…”在旧写法下报 `PI_CONTINUATION_PREFIX_INVALID`。改成比较模型实际看到的内容：两边都过 Pi 的 `convertToLlm`、去掉 system 消息和时间戳后比较 JSON。压缩和 `context_edit` 之后 Pi 用 `_refreshFinalizedContext()` 把内存消息换成条目的投影，两边一致。作者说法“不一致时只是拒绝保存”不准确：检查失败会让这一批工具以失败结束（checkpoint）或记为结果未知（suspend）。
- r2-2（模型判中，线程判低）：导出 `gitleaksGateExceptions` 并补用例；临时去掉它里面的过滤后用例报 `SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN`。
- r2-3（低）：沙箱执行器和文件改动预演各补一条经真实入口的用例（undefined、BigInt、Map）；临时去掉调用后两条用例都失败。
- r2-4（低）：日志里放行 `PI_REQUEST_TOOLS_DIVERGED` 这个 Himawari 自己的代码，事件里的错误码仍是 `PI_MODEL_ERROR`（加新错误码要改界面文案，不在这次范围）。
- r2-5（低）：ADR 决定 7 加上“Himawari 关着 Pi 的自动重试”的前提；案例 86 写明是改适配器设置。

## 可以更好（不改，列给 Andy）

- r2-6：续跑请求开头的比较是 Pi 交给服务方之前的 transcript 序列化，不是 HTTP 请求体原始字节；第 1 轮判断里“逐字节”的说法按此理解。
