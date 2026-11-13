# PR 463 第 3 轮复核的逐条判断

只用 DeepSeek，看 `1b0423e80..39ee0c390`。模型确认第 2 轮三处代码修复都对、启动定时器只触发一次、帧上限两种形态都覆盖。新报 2 条中、4 条低。

## 会出错、低（已改，用 --accept-low 记账，不再复核）

- R3-ds1（模型标中，线程判低）：kill 帧、协议违规、发送失败这三条杀进程路径没有先查 Job Host 是否已退出。成立，但窗口很窄（Job Host 已退出、stderr 还被后代占着时才会出现），本机路径改动前也只看 `childExited`。改：`killGroup` 统一先查 `exitCode`/`signalCode`。新测试：Job Host 退出后留一个占着 stderr 的后代，再发 kill 帧，后代不能被杀；去掉这次的检查时测试失败（已验证，用 `/proc/<pid>/stat` 区分僵尸进程）。
- R3-ds6 低：started 之前的 message/stderr 帧没有拒绝。改：started 之前收到其他帧就报错关闭。新单元测试，去掉修复时失败（已验证）。

## 可以更好（不改，列给 Andy）

- R3-ds2：套接字权限测试分不出“监听前设 umask”和“监听后 chmod”。代码本身是对的；生产用 systemd 建的套接字（PR③），`--socket` 只给测试用。
- R3-ds3：网关出站写不处理背压。只有主服务能连，输出量受 Job Host 的 `maxOutputBytes` 限制。
- R3-ds4：网关被杀时不清理 Job Host。PR③ 的 systemd 单元用默认 `KillMode=control-group`，停服务时整个 cgroup 一起清掉；放进 PR③ 的测试机清单。

## 不成立

- R3-ds5：64 MiB 是协议层防内存耗尽的固定值，不是 ADR 0234 说的按人配置的上限；材料的说法已在第 1、2 轮判断里写明。
