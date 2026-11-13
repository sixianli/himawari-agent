# PR 463 第 2 轮复核的逐条判断

这一轮只用 DeepSeek，看 `d0aedcc93..1b0423e80`。报了 2 条中、2 条中低、3 条低、1 条说明。

## 会出错（已改，第 3 轮复核）

- R2-ds1 中：`fork` 同步抛错（例如路径里有 NUL）会让网关进程崩溃。成立。改：包住 `fork`，失败时回 error+close，网关继续服务。新测试：fork 抛错时连续两个连接都收到 error+close。
- R2-ds2 中低：收到 pid 不合法的 started 帧时先清了启动定时器，对端再不说话 transport 就永远不结束。成立。改：pid 不合法或重复的 started 帧立即 error+close。新测试：对端发 `started{pid:null}` 后保持连接。
- R2-ds3 中低：Job Host 自己先断开 IPC（正常收尾路径）时，Worker 断线不会安排兜底。成立。改：只要 Job Host 还在运行就安排按 `cleanupTimeoutMs` 兜底，只有 IPC 还连着时才调用 disconnect。新测试：Job Host 自己断开后挂住。
- R2-ds4 低：`--socket` 模式 chmod 在监听之后，有短暂窗口；chmod 失败没处理。成立。改：监听前把 umask 设成 0177、监听完成后恢复，不再 chmod；测试检查套接字权限是 0600。
- R2-ds5 低：兜底杀进程只看集合，不看进程是否已退出。成立。改：杀之前再查 `exitCode`/`signalCode`。
- R2-ds6 低：错误路径上 transport 也补发 exit。成立。改：只在收到 exit 帧时发 exit，fork 失败时只有 error→close，和本机一致；测试断言没有 exit。
- R2-ds7 低：启动窗口没按请求剩余期限截断。成立。改：取启动窗口和剩余期限的较小值，和 session 自己的启动定时器一致。
- 资格测试：`setpriv` 不存在时会挂到超时。改：同时监听 error。

上面四处新测试在去掉对应修复时失败（已手动验证：兜底、fork 失败、无 pid 的 started、套接字权限）。

## 可以更好（不改，列给 Andy）

- R2-ds8：帧上限 64 MiB 是协议层防内存耗尽的固定值，不是按人配置的上限，保持不变。
- 兜底测试的 `cleanupTimeoutMs` 只有 10 毫秒，区分不出“等了再杀”和“立即杀”；完整行跨多个分片时越过上限的用例。

## 顺带修正

第 1 轮修改的提交里误带进了三个无关文件的格式化改动（`job-host-control-client.ts`、`linux-host-group.ts`、`readiness-probe.ts`，只是 import 排序），这次改回 main 的原样。
