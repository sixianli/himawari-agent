# P2：容器运行时重启后的核实

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)中“验证停止在 `setsid`、两次 fork、daemon 场景下覆盖整个环境……”这一项里还缺的部分：运行时本身（OrbStack 或 Hermes 的 Docker）重启以后，后端给出的结论是否正确。

## 用词

| 用词 | 意思 |
| --- | --- |
| 运行时 | 实际运行容器的 Docker 服务：Mac 上是 OrbStack，Hermes 上是 systemd 管理的 `docker` 服务 |
| 运行时身份 | `docker system info` 返回的 `ID`，后端用它判断是不是同一个运行时 |
| 停止证明 | 后端核实环境已经整体停下、不会再被启动后给出的记录 |
| 重启策略 | 容器的 `RestartPolicy`；环境容器都是 `no`，运行时重启后不会自动拉起 |
| live-restore | Docker 的一个选项，开启后运行时重启时容器可以继续运行；Hermes 没有开启 |

## 用户的授权

2026-09-26 用户批准重启 OrbStack 和 Hermes 的 Docker，知道这会影响机器上其他正在运行的容器。

- **Mac**：由测试执行 `orbctl stop` 再 `orbctl start`。OrbStack 没有单独重启 Docker 引擎的命令，所以整体停止再启动。
- **Hermes**：重启 `docker` 服务需要 root 权限，`andy` 使用 sudo 要输入密码，所以由用户在自己的终端里执行 `sudo systemctl restart docker`。测试这边的“重启命令”是一个等待脚本（包里的 `wait-for-docker-restart.sh`）：它记下 `docker` 服务的启动时间，一直等到这个时间变了、运行时也能连上为止。

## 测试做了什么

新的测试文件是 [`container-runtime-restart-qualification.test.ts`](../../../../integration/container-runtime-restart-qualification.test.ts)，在 [`ci/policy.json`](../../../../../ci/policy.json) 里登记为独立项目 `qualification-container-restart`。重启会中断同一台机器上的其他容器，所以它不并入 `qualify:container`。运行它要同时满足两个条件：设置了 `HIMAWARI_CONTAINER_RESTART_QUALIFICATION=1`，并用 `HIMAWARI_CONTAINER_RESTART_COMMAND` 给出重启命令（JSON 数组）。打开了开关却没有给命令时，测试失败，不会跳过。

它和原有的资格测试共用 [`container-qualification-support.ts`](../../../../integration/container-qualification-support.ts)。这个文件是从原测试里抽出来的：运行时设置、镜像常量、后端的构造、环境身份，以及执行、停止证明和清理。原测试的 13 项在抽取后没有改动测试内容；在两个平台上重跑，都通过了（`*-qualification-after-refactor.*`）。

步骤：

1. 创建一个联网环境：任务容器加出口代理。在里面用 `nohup` 留一个后台程序。
2. 再创建一个环境，重启前就停止它并拿到停止证明。
3. 记下运行时身份，以及三个容器的启动时间和重启次数。
4. 执行重启命令，然后等运行时重新可以连上。
5. 核对以下各项：
   - 运行时身份没有变；
   - 三个容器都没有在运行，重启次数为 0，启动时间和重启前一样，也就是没有被重新启动过；
   - 后端报告第一个环境为“已停止”，再执行调用时报 `CONTAINER_NOT_RUNNING`；
   - 两个环境都能给出停止证明；
   - 核对完以后，所有容器仍然停着。

## 结果

| 检查 | Mac（OrbStack 2.2.3，Docker 29.4.0） | Hermes（Docker 29.6.1） |
| --- | --- | --- |
| 重启方式 | 测试执行 `orbctl stop` 再 `orbctl start`，共 12 秒 | 用户执行 `sudo systemctl restart docker`；`docker` 服务的启动时间从 2026-08-21 20:40:50 变为 2026-09-26 10:15:16（日本时间）。测试记录的 1123 秒包含等待用户执行命令的时间 |
| 运行时身份 | 没有变 | 没有变 |
| 重启前在运行的任务容器和出口代理 | 已退出，重启次数 0，启动时间不变 | 相同 |
| 重启前已拿到证明的环境 | 仍然停着，启动时间不变 | 相同 |
| 后端对运行中环境的判断 | `stopped`；再执行调用得到 `CONTAINER_NOT_RUNNING` | 相同 |
| 停止证明 | 两个环境都给出 `verified_stopped` | 相同 |
| 本轮测试的容器和网络 | 结束时清理，读回为 0 | 相同 |
| 机器上其他容器 | Mac 原有 6 个容器，重启前后名字和状态一致（都已停止）（`mac-containers-*.txt`） | 原来运行的 38 个容器全部回来，名单一致（`running-*-restart.txt`） |

结论：这两个运行时重启时，环境容器都被停掉，而且不会被自动拉起。运行时身份保持不变，所以后端能正确判断环境“已停止”，并给出停止证明。

## 验证命令

Mac：

```bash
HIMAWARI_CONTAINER_RESTART_QUALIFICATION=1 HIMAWARI_CONTAINER_RESTART_COMMAND='["/bin/sh","-c","/opt/homebrew/bin/orbctl stop && /opt/homebrew/bin/orbctl start"]' HIMAWARI_CONTAINER_DOCKER_CLI=/usr/local/bin/docker HIMAWARI_CONTAINER_DOCKER_HOST=unix:///Users/<用户>/.orbstack/run/docker.sock HIMAWARI_CONTAINER_EVIDENCE_PATH=<输出文件> npx vitest run --config vitest.workspace.ts --project qualification-container-restart --reporter=verbose
```

Hermes 在 `/data/himawari-p2-20260925-01/source` 里运行。重启命令设为 `["<等待脚本的路径>"]`，其余变量和[第二批](../p2-original-directory-01/README.md#verification)相同。测试进入等待后，由用户执行 `sudo systemctl restart docker`。

原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)。

## 没有覆盖的部分

- **运行时身份变化的情况**：两个平台重启后身份都没变。如果某个运行时重启后身份变了，后端会按“换了运行时”处理，不给停止证明，需要人工处理。这种情况本批没有实测。
- **重启过程中正在执行的调用**：重启时没有正在进行的 `docker exec`。
- **主机本身重启或休眠**：没有测。
- **开启 live-restore 的运行时**：容器会在运行时重启后继续运行。Hermes 没有开启这个选项，这种情况没有测。
