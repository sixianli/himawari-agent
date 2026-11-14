# PR 478 第 1 轮复核的逐条判断

只用 DeepSeek，看 `3726dbdb1`。新报 1 条中、5 条低、1 组未核实。

## 会出错、中（已改，第 2 轮复核）

- R1-ds1：Worker 新加的 `jobHostAccount` 分支没有自动测试。成立：PR③ 接线时如果把启动器或控制访问漏传，没有测试会发现。改：`sandbox-v2-worker-lifecycle.test.ts` 加“网关正常”和“网关 [R2-D4] 准备确认被拦下”两个场景，起真实网关，断言目录经网关建、启动器原样传给 `prepareSandboxJobHost`、被拦下时经网关抢“开始”。反向验证：Worker 不传启动器、或不用 `jobHostAccount.control`，新场景都失败（已验证）。

## 会出错、低（已改）

- R1-ds2：网关的“读决定”和“成功拦下”没有正向用例；控制目录在根外的 launch 上下文没有用例。改：`sandbox-preparation-control.test.ts` 加本机和网关各一遍的用例：登记准备后不抢“开始”，主服务拦下，读回签名的拦下决定，之后抢“开始”失败，释放依据是 `preparation_launch_blocked`；`job-host-gateway.test.ts` 加根外上下文的拦下被拒。反向验证：去掉网关的 `block` 或 `read` 处理，网关那一遍失败（已验证）。
- R1-ds5：尾斜杠路径能过 `dirname` 检查，`describe` 的 `lstat` 会跟随符号链接，泄露根外目录的元数据（不含内容）。改：`controlDirectory` 要求 `path.resolve(directory) === directory`。新断言：尾斜杠路径报 `JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT`；去掉这一条时失败（已验证）。控制根本身是符号链接时所有操作都报 `JOB_HOST_CONTROL_BINDING_INVALID`，是拒绝而不是越界，不改；PR③ 的开通工具建根时用规范路径。

## 可以更好（不改，列给 Andy）

- R1-ds3：调用方断开后，网关的 prepare、claim、block 仍会写完。在帧到达时同步检查 `signal.aborted` 起不到作用，真要取消得把信号传进 `decideJobHostLaunch` 的每一步，而且写盘和断开之间总有窗口。“抢到开始但调用方不知道”和本机路径上 Worker 抢到后立刻崩溃是同一种情况，已有的恢复按“从未开始”处理；拦下是保守方向。
- R1-ds4：`./control` 只是编译期的导入边界，网关协议本身接受所有操作。运行时的边界是套接字 0600、属执行账号，只有主服务账号能连（PR③ 开通）；PR 描述已写明。

## 材料不准（已改 PR 描述）

- R1-ds6：launch 决定由网关端验证并签发，调用方再验；只有 query 和证据是“网关回原始字节、调用方验签”。本机路径不是逐行等价：建目录后立刻取设备号和 inode（原来在登记前取），`describe` 把 realpath 失败当成“不规范”而不是抛错；两处都更严格，PR 描述已改。

## 不是意见

- R1-ds7：未核实清单。13 条基线失败在 main 上复现过；生产接线和跨账号在 PR③ 的测试机资格里验。
