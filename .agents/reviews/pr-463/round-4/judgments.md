# PR 463 第 4 轮复核的逐条判断

只用 DeepSeek，看第 3 轮记账之后的两个提交（CI 规则逼出的“跨账号资格测试改成手动 root 脚本”）。新报 1 条中、7 条低。

## 会出错、低（已改，用 --accept-low 记账，不再复核）

- R4-ds1（模型标中，线程判低）：资格脚本在失败路径可能一直等下去，不退出也不清理。成立，但这是 root 手动跑的验证脚本，不进 CI、不进生产，挂住只会让跑的人看到它不结束。改：加 30 秒总超时，到时杀 Job Host 和网关进程组并以 1 退出。
- R4-ds2 低：失败清理只杀网关，不杀 Job Host。改：记下 Job Host 的进程号，`finally` 里先杀它的进程组再杀网关。
- R4-ds4 低：Job Host 自己断开通道（正常收尾）后，Worker 的心跳会让网关把它杀掉，和本机通道的行为不一致。改：网关在 Job Host 断开时发 `disconnect` 帧，通道收到后 `connected` 变成 false；网关收到发往已断开 Job Host 的消息时只丢弃，不杀进程。新集成测试“reports a Job Host that let go of its channel as no longer connected”：断开后 `connected` 为 false、没有 exit/error/close，发心跳后 Job Host 仍在。分别去掉通道和网关的改动，测试都失败（已验证）。
- R4-ds6 低：脚本的 pid/uid 断言用宽松相等。改用 `assert.strictEqual`。

## 可以更好（不改，列给 Andy）

- R4-ds3：资格脚本用测试替身网关宿主，不经过 `job-host-gateway-main.ts`，没验证套接字 0600。0600 已由集成测试“gateway main process”用真实入口验证；生产的套接字由 systemd 建（PR③），PR③ 的测试机清单会用真实入口跑。
- R4-ds5：手动资格脚本没有文档入口。放进 PR③ 的测试机资格文档一起写。

## 不成立

- R4-ds7：`/proc` 只在 Linux 有。集成测试只在 Linux 跑，项目规则禁止在 MacBook 上跑服务端测试，CI 规则也禁止 `runIf`。
- R4-ds8：64 MiB 是协议层防内存耗尽的固定值，不是按人配置的上限（同 R3-ds5）；材料里过期的说法只是材料问题，不是代码问题。
