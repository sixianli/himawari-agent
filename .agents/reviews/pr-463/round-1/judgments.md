# PR 463 第 1 轮复核的逐条判断

这一轮看的是提交 `d0aedcc93`（每人 Job Host 网关和远端传输；生产还没接网关，不碰发给模型的内容）。DeepSeek 报了 1 条高、2 条中、2 条低；GLM 报了 1 条中、3 条低、1 条信息。

## 会出错、中高（已改，第 2 轮复核）

- R1-ds1 高 / R1-glm4 低：`await session.spawned` 没有超时，网关收下 launch 却不回应时，SRT 环境的锁会被一直占住。成立。改：`gatewayJobHostLauncher` 在启动窗口（沿用现有 `JOB_HOST_STARTUP_WINDOW_MS`，测试可传更短的值）内没收到 started 帧就报 error 并 close，`spawned` 兑现为 undefined，后端走原有的“启动失败”路径。新测试：一个只收不回的套接字，transport 报错关闭。
- R1-ds3 中 / R1-glm1 中：帧上限只检查了未结束的那一段，一次到达、带换行的超长行不受限。成立。改：拼接前先检查长度。新单元测试 `job-host-gateway-frames.unit.test.ts`，去掉这行检查时它失败（已验证）。64 MiB 是协议层防内存耗尽的固定值，不是给人的用量上限，不属于 ADR 0234 说的“按人配置的上限”。
- R1-glm2 低（按中处理，一起改）：Worker 断线后 Job Host 若不退出，网关永不空闲。成立。改：断开后等这次请求自带的 `cleanupTimeoutMs`（和 Worker 自己取消后等待的时间相同）仍未退出就杀进程组。新测试用不理会断开的子进程，去掉这段时失败（已验证）。
- R1-ds2 中（部分）：`--socket` 模式套接字按 umask 创建。改：监听后立即 chmod 0600。对端 uid 校验 Node 没有接口；生产走 systemd 建的 0600 套接字（PR③），反向测试“别的账号连不上”放在 PR③。

## 可以更好（不改，列给 Andy）

- R1-ds3（其余部分）：写入不处理背压、没有连接数上限和握手超时、客户端收到 close 后不关连接时网关不进入空闲。只有主服务能连，输出量受 Job Host 的 `maxOutputBytes` 限制；Worker 收到 close 帧会自己关连接。
- R1-ds4 低：transport 在 close 时总会补发 exit，spawn 失败时顺序是 error→exit→close。job-host.ts 只用 exit 置 `childExited`，不影响行为。
- R1-glm3 低 / R1-ds 推测：跨账号后主服务读 `/proc/<pid>` 拿进程起始标记可能受 hidepid 影响。列入 PR③ 测试机实测清单。
- R1-ds5 / R1-glm5：还缺 fork 失败事件顺序、systemd fd 3 真实启动的用例。fd 3 路径要在测试机上测（PR③）。
- 二次 launch 的反向用例已补（GLM 指出的缺口）。
