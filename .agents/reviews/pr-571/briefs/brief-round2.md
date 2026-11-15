# PR 571 第 2 轮复核材料

第 1 轮之后加了一个提交（8de0a1697），按审计结果一并修掉部署时同类的不稳点。Andy 已定：出包时不在 Hermes 上跑整套生产验收；部署失败后不回滚、保留现场。所以停服之后出现一次误判，就意味着服务真的停掉。

改动：
1. S6_READ 的 run-service-probe.py：统计途中消失的文件按 0 计；采样错误改为警告。
2. run-stage-03.py 和 maintenance-common.mjs：资源和空间采样错误改为警告，安全检查（临时目录身份、存活进程、引用）仍然致命。S7、S9、finalize、cloud-seal 四处使用 resourceSamplingErrors 的地方同步改了。
3. check-p5-scratch-cleanup.py 的登记轮询：跳过正在退出的进程。
4. failure-scene.py：消失的文件记为 vanished。
5. S6-service-read.py：cgroup 已被删除时按空列表处理。
6. 外网调用加有限重试：curl 用 --retry 2，npm 用 fetch-retries=2，question-12 下载遇到 5xx、DNS 错误、连接重置、超时时重试。策略拦截（403）不重试。
7. 启动预算：生产实例 startupReadyBudgetSeconds 从 30 改为 90。产品代码 apps/execution-worker/src/service-main.ts 的 DEFAULT_STARTUP_WAIT_TIMEOUT_MS 从 45000 改为 105000。
8. S7 启动读回的失败事件匹配：带 retryInMs 的事件和 memory.embedding_catch_up_failed 不再判为失败。
9. 事故清单 I-107 和 I-28 更新。

请特别查：
- 改成警告之后，有没有哪个安全判断（磁盘余量、清理是否允许）原来依赖采样结果，现在会被静默放行。
- 重试会不会让本该证明“被拦截”的场景变成重试后通过。
- 把 worker 启动等待改为 105 秒，对产品运行时有什么影响：worker 等谁、超时之后做什么、systemd 的启动超时会不会先触发。
- 新的失败事件排除名单是不是太宽。
- 每个改了的记录字段，所有读它的地方是否都同步了，包括签名、封存、S8 对照和夹具。
