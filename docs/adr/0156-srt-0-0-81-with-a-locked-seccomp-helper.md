---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-04"
---

# ADR 0156：SRT 升级到 0.0.81，启动前必须用上锁定的 seccomp 小程序

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Himawari 在 Linux 上用 SRT（Anthropic 的 `@anthropic-ai/sandbox-runtime`，底层是 bubblewrap，一个 Linux 命令行隔离程序）隔离 Agent 跑的命令，原先锁定 0.0.75。0.0.75 有一个真实绕过：沙箱里的命令可以自己建一层用户命名空间（Linux 让普通进程拥有一份私有权限视图的机制），在私有的挂载视图里把只读绑定拿掉，再通过事先打开的目录句柄改写被禁写的文件。上游提交 9a277e5（#588，最早进入 v0.0.80）的说明写的是 “a command that may create one can take the binds out of its own view”。本线程 2026-11-04 在云端容器（Ubuntu 24.04、bubblewrap 0.9.0、普通账号）用上游测试的攻击脚本复现：0.0.75 下被禁写的 `.git/config` 被改写；0.0.81 下命令建命名空间时被拒（有 seccomp 小程序时 `EPERM`，没有时 bubblewrap 的 `--disable-userns` 给 `ENOSPC`）。

0.0.81 的修复要靠两样东西之一：seccomp 小程序（`vendor/seccomp/<arch>/apply-seccomp`，seccomp 是 Linux 按系统调用拦截的过滤器），或者 bubblewrap 0.8.0 以上的 `--disable-userns`。测试服务器 Hermes 的 bubblewrap 是 0.6.1，只能靠小程序。两样都没有时，SRT 只在调试日志里写一行 “no seccomp helper in use, and bubblewrap cannot disable user namespaces”（0.0.81 `dist/sandbox/linux-sandbox-utils.js:1346`），照常运行。另外，SRT 找小程序时，指定的路径不存在就退回到包内目录，再找不到就退回到全局 npm 安装目录（`dist/sandbox/generate-seccomp-filter.js:144-201`），可能用上一份旧小程序；0.0.81 README 对旧小程序的说法是 “imposes no limit, and nothing says so”。上游提交说明里提到的 `SRT_HELPER_FEATURES` 自报能力，在 v0.0.81 的 `vendor/seccomp-src/apply-seccomp.c` 里不存在，不能用来区分新旧小程序。

方案经过 OpenCode 两个模型（`opencode-go/deepseek-v4.1-flash`、`opencode-go/glm-5.3-flash`）各一轮独立出方案和一轮审核；Andy 2026-11-04 同意整合方案，并选定真实沙箱检查放进 Hermes 上的上线包检查。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. SRT 锁定 0.0.81。版本号的唯一来源是 `packages/execution-contracts/src/sandbox-runtime-version.ts` 的 `SANDBOX_RUNTIME_VERSION`；资格合同写 `literal(SANDBOX_RUNTIME_VERSION)`，仍是精确值。`npm run check:srt-version`（`npm run check` 的一步）要求 `package.json`、`package-lock.json`、实际安装的包和脚本里的每处版本号都等于它；`docs/`、`.agents/reviews/`（模型复核的记录目录：模型原话、提示词存档、逐条判断、账本和材料；里面的版本号都是引用，不是运行时版本的来源）、`test/qualification/evidence/` 和上线包模板里 `acceptance/cloud/basis-04/`、`acceptance/cloud/probe-source/` 两处历史快照除外；`scripts/operations/` 下 10 个按发布冻结的 `hermes-*-start.mjs`（仍写 0.0.75，各自的摘要由同一次发布的 `*-qualify.py`、`*-cutover.py` 锁定）也除外，检查脚本逐个列出它们和摘要，文件一改就报 `SRT_FROZEN_RELEASE_CHANGED`，新加的同名脚本照常检查。
2. 策略显式写 `allowNestedUserNamespaces: false`。
3. Job Host 在依赖检查之前，由真正加载 SRT 的线程读出实际安装的 SRT 版本、包里小程序的路径、是否普通文件、是否可执行和 SHA-256（文件内容摘要）。版本不符报 `JOB_HOST_SRT_VERSION_MISMATCH`；在 Linux 上小程序缺失、是链接、不可执行或摘要不等于 `packages/runtime-sandbox/src/srt-runtime-identity.ts` 写死的值，报 `JOB_HOST_SECCOMP_HELPER_UNAVAILABLE`，都不启动。通过后把这个路径作为 `seccomp.applyPath` 交给 SRT。启动失败的诊断文字记下 SRT 和 bubblewrap 的版本；资格检查 `inspectSrtDependencies` 把这两类失败写进 `errors`，生产签名脚本因此拒绝签发。
4. SRT 生成命令之后、启动之前，任务命令和就绪探测命令都要求命令结尾严格等于 `SRT_ALLOW_NESTED_USERNS=0 <锁定的小程序> /bin/bash -c <我们传入的命令>`，并且没有 `--disable-userns`（它只在没有小程序时出现），否则报 `JOB_HOST_SECCOMP_HELPER_NOT_IN_USE`。只在 root 下接受 `--cap-add CAP_SETFCAP`。命令改用文件传参（以 `/bin/sh` 开头或带 `--args`）时报 `JOB_HOST_LAUNCH_ARGV_FILE_UNSUPPORTED`。`--dev-bind` 继续拒绝。
5. 保留：禁读临时目录改只读的 `--remount-ro` 改写（上游 #537 只修“重新施加的”禁读临时目录）、自建出口代理（SRT 的私网解析检查不管走 `parentProxy` 的连接，0.0.81 README 第 468 行）、进程清理和结果记账。
6. 真实沙箱边界检查 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs`（`npm run check:srt-boundary`）用真实 SRT、真实 bubblewrap 和我们的策略编译、命令检查函数，逐项验证：嵌套用户命名空间改不了禁写文件，AF_VSOCK（虚拟机和宿主机之间的通信套接字）和 io_uring（Linux 的一种异步读写接口）被拒，禁读临时目录写入得到 `EROFS`，没有小程序的命令被拒。每项都带阳性对照（放开嵌套命名空间后攻击能成功、沙箱外能建 AF_VSOCK 和 io_uring、去掉改写后写入成功），对照不成立就判失败，不会因为环境原因假通过。当前进程是 root 时整个检查改以 `nobody` 身份重跑。它放在 Hermes 上的上线包检查里（`scripts/delivery-mode/run-packet-checks.py` 的 Hermes 专属项），每次出包必跑，不过就不出包；不放进 `npm run check`，因为云端容器默认没有 bubblewrap 和 socat。

[返回目录](#contents)

<a id="options"></a>

## 放弃的做法

- 每个任务启动时再跑一次真实自检：每个任务多启动一次沙箱，而启动太慢已经造成过事故 I-07（[事故与门槛](../incidents-and-gates.md)）。行为检查改放在上线包检查里。
- 在仓库里另存一份小程序副本：包里那份按摘要锁定就够了，多一份副本只多一个要维护的文件。
- 只检查小程序文件存在：文件对，不代表 SRT 用的就是它（全局 npm 退回、`allowAllUnixSockets` 跳过小程序）；所以还要看 SRT 实际生成的命令。
- 把真实沙箱检查放进 `npm run check`：要先在每个云端环境装 bubblewrap 和 socat，否则所有线程的检查都失败。
- 替换 SRT：已和 OpenSandbox 比较过，不替换。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 策略 JSON 多了 `allowNestedUserNamespaces: false`，Job Host 的策略摘要（`policy.ts` 对策略 JSON 算的 SHA-256）随之变化；它由新代码在同一次请求里算出并比对，不会造成不一致。任务环境的摘要（`apps/agent-service/src/production-task-environments.ts` 的 `srtEnvironmentPolicyDigest`）不含策略 JSON，但含运行文件摘要 `runtimeDigest`；新版本上线换了运行文件，已有的任务环境因此按“撤销”重建一次（同文件 `srtEnvironmentRotationReason`）。都不影响发给模型的内容。
- 升级 SRT 时必须同时改常量、依赖、锁文件、小程序摘要和脚本里的版本号，`npm run check:srt-version` 会拦住漏改的地方。
- 小程序装坏或被换掉时沙箱拒绝启动，任务失败而不是静默失去保护。
- 已知限制：0.0.81 在命令行超过 126975 字节（`maxArgStrlen() - 1 - 4096`，0.0.81 `dist/sandbox/linux-sandbox-utils.js:678`、`:836-838`）时把挂载参数移进文件，改走 `/bin/sh … --args`，我们按第 4 条拒绝；0.0.75 没有这条退路，命令行超过 131071 字节才因单个参数过长启动失败。所以命令行在 126976 到 131071 字节之间的任务，0.0.75 能启动、现在会被拒。命令行主要由挂载参数（工作区越大、要禁写的路径越多越长）和转义后的用户命令组成，常见任务约 6 KB。Andy 2026-11-04 决定不支持文件传参，这一段保持拒绝。
- Hermes 和生产机的资格验证、出包和真实账号验收由 Mac 线程在合并后做；回滚用上一包。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0024：SRT 统一执行](0024-srt-unified-execution.md)
- [ADR 0026：按任务的网络出口](0026-job-scoped-network-egress.md)
- [架构 v0.1](../architecture-v0.1.md)
- 上游提交：https://github.com/anthropics/sandbox-runtime/commit/9a277e5
- 上游发布说明：https://github.com/anthropics/sandbox-runtime/releases

[返回目录](#contents)
