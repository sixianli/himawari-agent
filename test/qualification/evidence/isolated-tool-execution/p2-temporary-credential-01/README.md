# P2 第四批：凭据必须进入容器时的临时凭据

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)第 4 项“凭据进入容器的路径”，以及第 3 项里“临时凭据的发放和撤销”在容器后端这一层的部分。规则来源是 Spec 的[凭据的使用方式](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#credentials)和验收条目 ITE-21 的容器部分。

本批让容器后端能在一次调用里交给任务一份临时凭据，调用一结束就在签发方那里作废。作废之后，任务抄走的副本和调用期间留下的后台程序再用它都会失败。后端仍没有接进产品，新任务执行仍然关闭；由人逐次批准、审批文字和“先停旧环境再换新环境”的调度属于 P3。

<a id="contents"></a>

## 目录

- [用词](#terms)
- [用户的决定](#decision)
- [做法](#design)
- [实现了什么](#implementation)
- [真实容器上验证了什么](#qualification)
- [单元测试覆盖的情况](#unit)
- [测试能否发现缺陷](#mutations)
- [验证命令与结果](#verification)
- [没有覆盖的部分](#gaps)

<a id="terms"></a>

## 用词

| 用词 | 意思 |
| --- | --- |
| 签发方 | 能发放短期凭据、也能让它失效的一方，例如私有 npm 仓库用长期令牌创建一个只读的短期令牌，用完再删掉 |
| 临时凭据 | 签发方按一次调用发放的短期凭据；过期时间不晚于这次调用和环境的期限 |
| 作废 | 由签发方让凭据失效，任何人拿着副本再用都会被拒绝；只在 Himawari 自己的记录里标记“已撤销”不算作废 |
| 凭据编号 | 后端为每次发放生成的 64 位十六进制编号，先写进宿主上的状态文件，再去签发，作废也按它进行 |
| 模拟仓库 | 资格测试里临时启动的一个小型 HTTP 服务，按令牌判断是否放行，用来代替真实的私有软件仓库 |
| 401 | HTTP 状态码“未授权”，这里表示仓库拒绝了令牌 |
| OrbStack | Mac 上的 Docker 兼容运行时，在一个 Linux 虚拟机里运行容器 |

[↑ 返回目录](#contents)

<a id="decision"></a>

## 用户的决定

2026-09-26 我向用户说明：秘密的真实值一旦进入容器，只撤销 Himawari 内部的密钥句柄（指向宿主上长期密钥的内部编号）挡不住任务留下的副本；要满足“撤销后再用会失败”，只能让签发方作废凭据。用户在三个方案里选了 C：现在做通用流程，真实服务的对接以后按需要再加；接口按方案 A 的规则设计，即只支持签发方能作废的凭据，长期凭据留在宿主一侧，永远不进容器。方案 B（由出口代理替换凭据）要解密 HTTPS，与 [ADR 0026](../../../../../docs/adr/0026-job-scoped-network-egress.md) 冲突，没有采用。

本批没有新的下载：模拟仓库用的是上一批已下载的 node 镜像，摘要不变。

[↑ 返回目录](#contents)

<a id="design"></a>

## 做法

- **只给新环境的第一次调用**：调用请求带上 `credential`（要用的长期凭据的引用 `secretRef`，以及这次人工批准的引用 `approvalRef`）时，后端要求这个环境里从没开始过任何调用。新环境里还没有任何程序，所以此时不会有后台程序在等着拿凭据。之后的调用可以照常执行，但不能再拿凭据；要再用凭据，就得换一个新环境。
- **先记编号再签发**：后端先把凭据编号、调用编号和过期时间写进状态文件（权限 0600，不含凭据的值），再请签发方发放。如果控制进程在两步之间崩溃，停止环境时仍能按编号作废；签发方的规则是，作废过的编号不能再发放。
- **值不进命令行**：发放得到的是若干环境变量。后端只把变量名写进 `docker exec --env <名字>`，值通过 docker 命令行程序自己的环境变量传进去，所以宿主上的进程列表和 `docker inspect` 里都看不到。变量名不能覆盖任务已有的 `HOME`、`PATH`、代理变量等，也不能以 `DOCKER_` 开头（这类变量会改变 docker 命令行程序连哪个运行时）。签发方给的过期时间晚于要求的，同样拒绝。
- **调用一结束就作废**：不论调用成功、失败还是超时，后端都立刻请签发方作废，并向签发方确认已经失效。确认不了时，强制结束任务容器和出口代理，调用报 `CONTAINER_CREDENTIAL_NOT_REVOKED`。
- **停止顺序里也作废**：停止时先关出口，再作废凭据，然后停止容器。签发方确认之前，不给停止证明，也不允许删除环境。停止证明的证据里写入凭据编号和作废时间。

凭据不进入环境权限上限（环境创建时固定的目录、网络目标、资源额度），这一点沿用 P1 的规则：[`decideEnvelopeChange`](../../../../../packages/application/src/services/execution-envelope-policy.ts) 只为凭据返回“这次是否由人确认”，从不把凭据加进下一个环境的权限上限。

[↑ 返回目录](#contents)

<a id="implementation"></a>

## 实现了什么

| 文件 | 内容 |
| --- | --- |
| [`temporary-credential.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/temporary-credential.ts) | 签发方接口 `TemporaryCredentialIssuer`（`issue`、`revoke`、`isRevoked`），以及对签发结果的检查：变量数量和名字、值的长度、过期时间 |
| [`container-execution-backend.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts) | 新选项 `credentialIssuer`；执行、停止、核查已停止、删除都接入凭据的作废；每次调用开始前在状态目录留下记录，用来判断环境是否用过 |
| [`docker-command.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/docker-command.ts) | 可以给 docker 命令行程序额外传环境变量；`DOCKER_HOST` 等会改变连接目标的变量仍然被去掉 |
| [`container-backend-error.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-backend-error.ts) | 新增 `CONTAINER_CREDENTIAL_UNAVAILABLE`（没有签发方或签发失败）、`CONTAINER_CREDENTIAL_REFUSED`（环境用过，或签发结果不合规）、`CONTAINER_CREDENTIAL_NOT_REVOKED`（签发方没确认作废） |
| [`execution-backend.ts`](../../../../../packages/application/src/ports/execution-backend.ts) | 应用层的后端接口里，`execute` 多了可选的 `credential` 字段 |

真实服务的签发方（例如 npm 令牌、GitHub App 令牌）本批没有实现，要等出现实际需要时再加。

[↑ 返回目录](#contents)

<a id="qualification"></a>

## 真实容器上验证了什么

测试文件 [`container-execution-backend-qualification.test.ts`](../../../../integration/container-execution-backend-qualification.test.ts) 新增 1 项，共 13 项。测试步骤：

1. 创建一个带网络目标的环境。
2. 用固定摘要的 node 镜像启动模拟仓库，接到这个环境的内部网络上，名字为 `registry.test`。模拟仓库以只读方式读取宿主上的令牌文件，每个请求在日志里写一行“状态码 + 令牌的 SHA-256 前 16 位”。
3. 测试里的签发方发放随机令牌时写入令牌文件，作废时从文件里删掉。
4. 带凭据的调用里，任务用令牌请求一次仓库，把令牌抄进 `/tmp`，并留下一个后台程序。这个后台程序会一直等到信号文件出现后，再用令牌请求一次。

| 检查 | Mac（OrbStack 2.2.3，Docker 29.4.0） | Hermes（Docker 29.6.1） |
| --- | --- | --- |
| 调用期间用令牌请求仓库 | 取回内容（200） | 相同 |
| 任务 shell 进程的命令行里有没有令牌 | 没有 | 相同 |
| 调用结束后，签发方记录已作废 | 是 | 相同 |
| 下一次调用里有没有令牌变量 | 没有 | 相同 |
| 用抄下的令牌再请求 | 被拒绝 | 相同 |
| 调用期间留下的后台程序再请求 | 被拒绝 | 相同 |
| 模拟仓库日志里这个令牌的记录 | 依次为 200、401、401 | 相同 |
| 同一环境里第二次带凭据的调用 | `CONTAINER_CREDENTIAL_REFUSED`，签发方没有收到第二次发放请求 | 相同 |
| 任务容器的 `docker inspect` 和后端全部状态文件里有没有令牌 | 没有（检查了 15 个状态文件） | 没有（检查了 104 个状态文件，含本轮其他测试的） |
| 停止证明 | 通过，证据里有凭据编号和作废时间 | 相同 |
| 前三批的 12 项 | 通过 | 通过 |
| 清理 | 本轮标签下的容器和网络读回为 0 | 相同 |

写测试时改正了两处测试本身的缺陷，都重跑过：

- 检查“命令行里有没有令牌”时，最初读的是 `/proc/self/cmdline`。`self` 指的是正在运行的 `grep`，它的参数里本来就有要查的令牌，所以一定查得到。改为读执行命令的 shell 进程 `/proc/$$/cmdline`。这次失败的输出只在终端里看过，没有保存；改正后的单项运行结果是 `mac-orbstack/focused-mac-02-after-argv-fix.json`。
- Hermes 第一次完整运行（`hermes-linux/hermes-qualification-01.*`）中模拟仓库没有就绪。原因是 `mkdtemp` 建的目录权限为 0700，仓库容器用 65533 用户运行，读不到里面的文件；Mac 的 OrbStack 会映射文件所有者，所以没暴露出来。在 Hermes 上直接复现：0700 时 node 报错退出，改成 0755 后正常启动。测试已改为建好目录后设成 0755。

[↑ 返回目录](#contents)

<a id="unit"></a>

## 单元测试覆盖的情况

[`container-execution-backend.unit.test.ts`](../../../../../packages/runtime-sandbox/test/container-execution-backend.unit.test.ts) 新增 8 项，共 44 项：

- 只在第一次调用时发放；docker 参数里只有变量名，值走 docker 命令行程序的环境变量；过期时间取调用期限和环境期限中较早的一个；调用结束后作废；状态文件里没有凭据的值；之后的普通调用拿不到变量；再次带凭据被拒绝，且不再发放。
- 环境用过、或者没有签发方时，签发之前就拒绝。
- 签发结果里的变量名是 `PATH`、`HTTPS_PROXY`、`DOCKER_HOST`、不合规的名字，或者没有变量、值为空、过期时间晚于要求时，作废后拒绝，不执行命令。
- 调用超时也会作废。
- 签发方确认不了作废时：结束任务和出口代理，后续调用被拒绝；停止、核查已停止、删除都报 `CONTAINER_CREDENTIAL_NOT_REVOKED`；签发方恢复后，停止证明带上作废记录。
- 签发失败时按已记录的编号作废，这个环境不能再重试带凭据的调用。
- 停止恰好落在“已记录编号、还没签发”之间时，执行方也会按编号作废，停止证明能正常给出。
- docker 命令执行器能把值传给子进程，但传入的 `DOCKER_HOST` 仍被去掉。

两台机器上都是 44 项通过。

[↑ 返回目录](#contents)

<a id="mutations"></a>

## 测试能否发现缺陷

新增的单元测试都先于实现运行过：7 项因为后端还没有凭据功能而失败。实现后回看代码，发现上面说的停止时机问题：停止一方先检查凭据记录，此时还没有记录；执行方随后写下记录，看到停止标记后直接退出。结果这个编号既没发放也没作废，停止证明一直给不出。先补了对应的测试，在没有修复的代码上运行：失败，签发方收到的作废次数是 0。修复后通过。

之后临时破坏实现并重跑，再恢复原样，恢复后的 SHA-256 与破坏前一致：

| 临时破坏 | 平台 | 结果 |
| --- | --- | --- |
| 调用结束后不作废凭据 | Mac 真实容器 | 失败：签发方没有作废记录（`mac-orbstack/mutation-no-revoke.log`） |

[↑ 返回目录](#contents)

<a id="verification"></a>

## 验证命令与结果

基于提交 `040a81a` 加上本批改动，Node.js 22.22.3。两个平台运行的改动文件 SHA-256 相同，见包内 `changed-files.sha256`。运行命令与[第二批](../p2-original-directory-01/README.md#verification)相同；Hermes 的代码副本沿用 `/data/himawari-p2-20260925-01/source`，本批只同步了改动的文件。

| 命令 | 结果 |
| --- | --- |
| 资格验证，Mac | 13 项通过（`mac-orbstack/mac-qualification-01.*`） |
| 资格验证，Hermes | 最终运行 13 项通过（`hermes-linux/hermes-qualification-02.*`）；`-01` 是上面说的目录权限问题 |
| 单元测试（后端），Mac 与 Hermes | 各 44 项通过（`unit-mac-01.log`、`unit-linux-01.log`；Hermes 这次运行时资格测试文件还是改正权限之前的版本，单元测试文件没有变化） |
| `npm run format:check`、`typecheck`、`check:boundaries`、`check:ci-policy`、`check:v0.2-coverage`、`check:v0.2-invariants`、`check:secrets` | 通过（`checks/`） |
| `npm run lint` | 有 20 条 `useLiteralKeys` 警告，都在 `apps/agent-service/src/capability-programs/` 的两个文件里，本批没有改动这两个文件；本批改动的文件没有警告 |

**正式的 `npm test`**：提交 `a6881dd` 之后在本机沙箱外运行 `npm test`，按 `a6881dd` 打安装包后运行全部测试项目。构建和测试两步都通过：contracts 355 项、unit 2012 项（比上一批多 8 项，正好是本批新增的 8 项后端单元测试）、integration 1779 项、e2e 3 项、pi-compat 130 项，没有失败或跳过。报告在 [`npm-test-a6881dd.tar.gz`](npm-test-a6881dd.tar.gz)，安装包本身没有保存，只记录了 SHA-256。本批没有运行覆盖率检查，原因见[第二批](../p2-original-directory-01/README.md#verification)。

原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)（用 `tar -xzf raw-logs.tar.gz` 解开）。里面没有令牌的值：模拟仓库的日志只记录令牌的 SHA-256 前缀，这些令牌也都已经作废。

[↑ 返回目录](#contents)

<a id="gaps"></a>

## 没有覆盖的部分

- **真实服务**：没有对接任何真实的签发方，所以“作废后再用失败”只在模拟仓库上证明过。每个真实服务接入时，都要在真实账号上重新证明一次。
- **经出口代理访问的仓库**：模拟仓库直接接在任务的内部网络上，没有经过出口代理。原因是出口代理按规则拒绝私网地址，本地起的服务过不去。出口代理本身的行为已由[第三批](../p2-task-egress-01/README.md#qualification)验证。
- **调用期间的其他程序**：调用期间，环境里同一用户的其他程序能读到凭据（例如读 `/proc/<pid>/environ`）。Spec 接受这一点，要求在审批时告诉用户；审批文字属于 P3。
- **调用输出**：任务如果把令牌打印出来，令牌会原样保存在调用输出里。令牌那时已经作废，本批没有专门遮掉它。
- **由人批准与换新环境**：后端只保证“只给新环境的第一次调用”。每次由人批准、审批文字、先停旧环境再换新环境，由 P3 的调度负责。

[↑ 返回目录](#contents)
