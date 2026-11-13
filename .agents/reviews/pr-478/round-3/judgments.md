# PR 478 第 3 轮复核的逐条判断

只用 DeepSeek，看 `4ddba2e49..ed622fd65`。模型确认路径限制没有绕过、网关不可用不会被当成“没有证据”、第 2 轮的修复成立。报 1 条中（第 1、2 轮已判过的同一件事）、3 条低、1 条信息。

## 会出错、低（已改，用 --accept-low 记账）

- R3-ds2：证据读取打开文件时没有 `O_NONBLOCK`，控制目录里放一个命名管道就能让网关读证据卡住（改动前就有，网关路径上更值得修）。改：加 `O_NONBLOCK`，打开后由 `isFile()` 拒绝。新用例：控制目录放命名管道，经网关读结束证据立刻报 `JOB_HOST_CONTROL_EVIDENCE_INVALID`；去掉 `O_NONBLOCK` 时用例卡到超时失败（已验证）。
- R3-ds3：网关的“不可用”“超时”没有映射到恢复流程的原因码，会被记成笼统的“未确认”。改：`JOB_HOST_GATEWAY_UNAVAILABLE` 对应 `SANDBOX_SUPERVISOR_UNAVAILABLE`，`JOB_HOST_GATEWAY_CONTROL_TIMEOUT` 对应 `SANDBOX_CONTROL_TIMED_OUT`，和本机路径一致。表驱动用例加两行；去掉映射时失败（已验证）。系统错误码正则不收下划线是有意的：只带回 `ENOENT` 这类 errno，Node 的 `ERR_*` 不该被当作系统状态。

## 可以更好（不改，列给 Andy）

- R3-ds1（模型标中）：网关的“抢开始”在调用方超时后仍可能写盘，调用方以为没抢到。核对了 Worker 代码：Worker 不重试抢“开始”，抢失败就报结果未知（`production-sandbox-execution-v2.ts:499-507`），之后由恢复流程处理；这和本机路径上 Worker 抢到“开始”后立刻崩溃是同一种情况，不是本 PR 新增的状态，也不会重复启动。模型建议的“同一绑定重复抢开始也算成功”会改变本机路径语义，留到 PR③ 接生产前一起看。
- R3-ds4：根不一致时网关已经在自己的根下建了空目录，Worker 不清理。只在开通配错时出现，目录是空的、属执行账号；配错本身由 PR③ 的开通检查拦。

## 不是意见

- R3-ds5：`--control-root` 变成必填。网关还没有任何生产启动处，PR③ 的 systemd 单元会传。
