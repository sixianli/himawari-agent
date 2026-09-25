# OrbStack `setsid` 后代停止候选探针

日期：2026-09-23 UTC。此目录保存一次临时容器实验，评估 Linux 容器是否能隔离本机脱离进程组的写入者。

## 环境与边界

- 宿主：macOS 27.2、Apple Silicon；OrbStack 2.2.3；Docker CLI/API 29.4.0。
- 镜像：`docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e`，以 `linux/arm64` 拉取。
- 容器禁用网络，只 bind mount `/private/tmp/himawari-p1-orbstack-20260923-01/workspace`。探针在容器中启动 `setsid sh` 循环追加文件，保持容器主进程等待。
- 容器停止后以 Docker `inspect` 读取运行状态，并从宿主独立读取挂载文件字节数。临时容器已删除；没有挂载项目工作区。

## 观察结果

`process-groups.txt` 保存主进程 `pid pgrp session` 为 `1 1 1`、后代为 `6 6 6`，说明后代确实进入独立进程组和 session。停止前已有 4 字节写入。`docker stop --signal TERM --time 2` 在宽限后以 SIGKILL 结束容器；`container-state.txt` 保存 `exited false 0 137`。停止返回时为 42 字节，之后 1 秒复读仍为 42 字节。`docker rm` 返回后只删除了本探针命名的容器。

这是针对容器运行时本身的候选证明：独立容器在本次探针中阻止了脱离进程组的后代继续写入 bind mount，且运行时状态提供了停止回执。它**尚不构成 Himawari 产品释放证明**，因为目前 Job Host/SRT 未将执行放入这个容器，也未把 daemon 状态、容器身份和 fencing 原子保存为永久回执。仍需实现产品接入、异常/daemon 失联测试、恢复语义及安装产物资格。

## 清理状态

OrbStack 启动前处于停止状态。它在启动时自动恢复了已有的 `just-rag-postgres`；探针未调用该数据库。结束时先用 10 秒期限的正常 `docker stop` 停止该容器，再停止 OrbStack；最终 `orbctl status` 为 `Stopped`。拉取的 BusyBox 镜像保留在 OrbStack 缓存（约 2.2 MB），因为停止 daemon 后无法在不再次启动并可能恢复该用户容器的情况下移除它。未删改已有容器、镜像、卷或数据库文件。

复跑入口见同目录 [probe.sh](probe.sh)；它绑定绝对临时路径与容器名称，复跑前须由操作者清理旧临时目录并确认 OrbStack 可启动。
