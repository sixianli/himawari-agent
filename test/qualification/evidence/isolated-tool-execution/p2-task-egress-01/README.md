# P2 第三批：任务专属的联网出口

日期：2026-09-25 至 2026-09-26 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)第 3 项的“网络出口”部分；同一项里的“临时凭据的发放和撤销”本批没有做。规则来源是 Spec 的[网络与特权](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#policy)和 [ADR 0026](../../../../../docs/adr/0026-job-scoped-network-egress.md)。

本批让容器后端能执行“允许访问某些网络目标”的环境：任务容器只能经过本环境专属的出口代理访问被批准的 `主机名:端口`，其他所有路径都被挡住。后端因此开始声明联网保证 `task-egress-policy.v1`，六项保证齐全。后端仍没有接进产品，新任务执行仍然关闭。

<a id="contents"></a>

## 目录

- [用词](#terms)
- [用户的授权](#authorization)
- [做法和为什么这样做](#design)
- [实现了什么](#implementation)
- [真实容器上验证了什么](#qualification)
- [一次没能复现的失败](#intermittent)
- [单元测试覆盖的情况](#unit)
- [测试能否发现缺陷](#mutations)
- [验证命令与结果](#verification)
- [没有覆盖的部分](#gaps)

<a id="terms"></a>

## 用词

| 用词 | 意思 |
| --- | --- |
| 出口代理 | 替任务向外发起连接的程序；任务只能连它，它按批准清单决定放不放行 |
| 内部网络（`--internal`） | Docker 建的一种网络，接在上面的容器之间能互通，但没有通往外部的路由 |
| `inhibit_ipv4` | Docker 网络选项 `com.docker.network.bridge.inhibit_ipv4`：不在宿主一侧给这个网络分配 IPv4 地址 |
| CONNECT 隧道 | 客户端请代理连到某个 `主机:端口`，之后原样转发数据；HTTPS 通过代理时用它 |
| 元数据地址 | 云主机上 `169.254.169.254` 这类能取到主机凭据的内部地址 |
| `host.docker.internal`、`0.250.250.254` | OrbStack 给容器访问 Mac 宿主准备的名字和地址 |
| OrbStack | Mac 上的 Docker 兼容运行时，在一个 Linux 虚拟机里运行容器 |

[↑ 返回目录](#contents)

<a id="authorization"></a>

## 用户的授权

2026-09-26 用户同意下载 Docker 官方镜像 `docker.io/library/node:22.22.3-alpine`，用作出口代理的运行环境。两台机器按同一个多平台摘要下载：`node@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd`（Mac 为 arm64，Hermes 为 amd64，都是 Node.js v22.22.3）。Hermes 下载后根盘剩余空间仍为 13 GB。

[↑ 返回目录](#contents)

<a id="design"></a>

## 做法和为什么这样做

每个需要联网的环境有三样东西：

1. 一个专属的**内部网络**，创建时加上 `inhibit_ipv4`；
2. 一个**出口代理容器**，同时接在默认网络（用来出网）和这个内部网络上，在内部网络里的名字是 `himawari-egress`；
3. **任务容器**，只接这个内部网络。

所以“绕不过去”由网络结构保证，不靠 `HTTP_PROXY` 这类环境变量：任务不用代理时，也根本没有别的路可走。代理程序直接复用现有的 [`openNetworkEgress`](../../../../../packages/runtime-sandbox/src/network-egress.ts)：目标精确到 `主机名:端口`，检查 DNS 返回的全部地址，任一地址不是公网地址就拒绝，然后按检查过的数字 IP 连接；不解密 TLS，不跟随重定向。

实现前先用 BusyBox 在两个平台上做了实验（`probes/`）。结果如下：

- 只用 `--internal` 时，Hermes 上的任务容器能通过网络的网关地址 `172.25.0.1` 连到宿主的 SSH（宿主上监听所有地址的还有 Samba 的 139、445 端口）。原因是 Docker 在宿主上给这个网络分配了网关地址。
- 加上 `inhibit_ipv4` 后，宿主不再有这个地址，连不上了。

这也是 Spec 要求单独测试“宿主网关”的原因。

另一个选择是把代理放在宿主进程里，让它监听内部网络的网关地址。没有采用，因为在 Mac 上，宿主进程接触不到 OrbStack 虚拟机里的网桥，两个平台做不到同一种做法。

[↑ 返回目录](#contents)

<a id="implementation"></a>

## 实现了什么

| 文件 | 内容 |
| --- | --- |
| [`network-egress.ts`](../../../../../packages/runtime-sandbox/src/network-egress.ts) | `openNetworkEgress` 新增可选的监听设置（地址、端口、token），token 必须是 64 位十六进制；不传时行为和原来一样，Job Host 路线不受影响 |
| [`egress-proxy-main.ts`](../../../../../packages/runtime-sandbox/src/egress-proxy-main.ts) | 代理容器的入口：从参数读期限和端口，从环境变量读 token 和批准清单，调用 `openNetworkEgress` 监听 `0.0.0.0:3128`；到期或收到停止信号时关闭所有连接并退出 |
| [`egress-proxy.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/egress-proxy.ts) | 建立和核对内部网络与代理容器、等待代理就绪、停止、核查已停止、删除 |
| [`container-records.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-records.ts) | 从后端移出的共用部分：容器记录的类型、读写状态文件、挂载配置的比对 |
| [`container-execution-backend.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts) | 在六个操作中接入出口 |

| 方面 | 做法 |
| --- | --- |
| 能力声明 | 另外要求出口镜像已按摘要存在，声明全部六项保证 |
| 创建 | 为本环境生成 token 并保存在状态目录（权限 0600）。建内部网络并读回核对：必须是 bridge 驱动、`Internal` 为真、未开 IPv6、带 `inhibit_ipv4`，标签属于本环境；不符合就拒绝。建代理容器：固定镜像，65533 用户，只读根文件系统，去掉全部 capability，no-new-privileges，不自动重启，进程数 64、内存 128 MiB、CPU 0.5，代理程序从状态目录只读挂入，读回实际配置逐项核对。启动代理后在代理容器里反复尝试连接 3128 端口，确认就绪后才创建任务容器；等不到就结束代理并报 `CONTAINER_EGRESS_UNAVAILABLE`。任务容器只接内部网络，标签记下代理容器 ID，计入实际配置的摘要 |
| 执行 | 给任务设置 `HTTP_PROXY`、`HTTPS_PROXY`（及小写形式）为 `http://job:<token>@himawari-egress:3128`，`NO_PROXY` 为空 |
| 查看 | 任务或代理任一还在运行，都返回 `running` |
| 停止 | 先停代理（关闭出口和已有连接），再停任务 |
| 核查已停止 | 代理也必须已退出、没有被重新启动过；代理被外部删除且没有删除记录时不给证明。证据里带代理容器的状态 |
| 删除 | 依次删除任务容器、代理容器、内部网络 |
| 期限 | 代理程序按同一个墙上时间期限自己退出 |
| 磁盘保护 | 结束任务时一并结束代理 |

撤权不需要代理去问控制端：环境的权限上限在创建时固定，撤权按 Spec 换新环境，旧环境连同代理一起停掉。所以代理的 `assertCurrent` 在这里总是放行。

[↑ 返回目录](#contents)

<a id="qualification"></a>

## 真实容器上验证了什么

测试文件 [`container-execution-backend-qualification.test.ts`](../../../../integration/container-execution-backend-qualification.test.ts) 新增 3 项，共 12 项。任务容器里的检查用 BusyBox 自带的 `wget`、`nc`、`nslookup`：

| 检查 | Mac（OrbStack 2.2.3，Docker 29.4.0） | Hermes（Docker 29.6.1） |
| --- | --- | --- |
| 读回的内部网络 | `Internal` 为真，未开 IPv6，带 `inhibit_ipv4` | 相同 |
| 宿主一侧的 IPv4 地址 | 用 `--network host` 的临时容器列出运行时宿主（OrbStack 虚拟机）的全部 IPv4 地址，没有一个在任务子网 `192.168.148.0/24` 里 | 列出 Hermes 的全部 IPv4 地址，没有一个在 `172.25.0.0/16` 里 |
| 经代理访问批准的 `example.com:80`（HTTP） | 取回页面 | 相同 |
| CONNECT 批准的 `example.com:443` | `200 Connection Established` | 相同 |
| CONNECT 未批准的主机 `example.org:443`、未批准的端口 `example.com:8443` | `403 Forbidden` | 相同 |
| 批准清单里的 `localhost:80` | `403`，带 `X-Himawari-Egress-Error: target-denied`：地址检查拒绝了非公网地址 | 相同 |
| 不带认证 | `407 Proxy Authentication Required` | 相同 |
| 直连 IPv4 `1.1.1.1:80`、IPv6、UDP `8.8.8.8:53` | 连不上 | 相同 |
| 通过 Docker 自带的 DNS 查外部域名、直接查 `8.8.8.8` | 查不到 | 相同 |
| 元数据地址 `169.254.169.254` | 连不上 | 相同 |
| 宿主局域网地址、`host.docker.internal`、`0.250.250.254` 上的临时监听端口 | 都连不上；宿主上的监听服务读回的连接数为 0 | 相同 |
| 另一个任务的代理 | 连不上；`himawari-egress` 只解析到本环境的代理 | 相同 |
| 停止与证明 | 先停代理再停任务，证据里代理为已退出；删除后内部网络也不存在了 | 相同 |
| 期限 10 秒 | 11.5 秒时任务和代理都已停止 | 9.8 秒时都已停止（从测试准备好环境后开始计时，比真实期限的起点晚） |
| 第一批和第二批的 9 项 | 通过 | 通过 |
| 清理 | 本轮标签下的容器和网络读回为 0 | 相同，原有 38 个容器仍在运行 |

“宿主局域网地址”在 Mac 上指 Mac 本机的地址，在 Hermes 上指 Hermes 的地址 `192.168.1.87`。监听服务由测试进程在宿主上临时打开，监听所有地址，测试结束后关闭。

写测试时改正了三处测试本身的缺陷，均已重跑：

- `printf` 的 `%s` 不会把参数里的 `\r\n` 转成换行，带认证的请求头因此没有结束，改用 `%b`。
- BusyBox 的 `wget` 遇到错误状态时不打印响应头，改用 `nc` 直接发请求读回状态行和标记。
- 原来的“连网关 `.1`”检查不成立：开启 `inhibit_ipv4` 后，`.1` 被分给了代理容器，连它测的是代理，不是宿主。改为直接列出宿主一侧的全部地址。

另外观察到：用 `nc` 发普通 HTTP 请求后立刻关闭发送方向时，代理不会回应，要保持发送方向打开才行。这是现有代理的行为（Node.js HTTP 服务对半关闭连接的处理），本批没有改。npm、curl 这类常见客户端不会这样发请求。

[↑ 返回目录](#contents)

<a id="intermittent"></a>

## 一次没能复现的失败

Mac 上的第三次完整运行（`mac-orbstack/mac-qualification-03.*`）中，出口测试失败：访问批准的 `example.com:80` 没取回页面，CONNECT `example.com:443` 返回了 403。其余 11 项通过。

- **已知**：CONNECT 的 403 只可能来自代理的目标解析这一步，也就是目标不在清单、DNS 解析出错、或者解析结果里有非公网地址三者之一。目标在清单里，所以只剩后两种。上游连接失败不会返回 403。
- **没能复现**：紧接着连续 3 次单独运行都通过（`flake-*`）。之后又做了两项专门的复现：一个同样接在两个网络上的容器连续做了 300 次 DNS 解析，没有失败，也没有非公网地址；同样的代理程序连续处理了 150 次 CONNECT，全部返回 200。这两项复现的输出只记录在本文。
- **不确定**：当时是 Mac 的网络或 DNS 短暂出了问题，还是别的原因。代理容器关闭了日志，事后查不到当时的拒绝原因。
- **影响**：这次失败是“该放行的被拒绝”，没有放行任何未批准的连接，不影响隔离。它提示出口测试依赖真实的外部网络。如果以后再出现，需要让代理报告拒绝的具体原因。那会改变现有的拒绝标记，并影响旧路线的历史证据，本批没有做。

之后两个平台的最终运行（`mac-qualification-04.*`、`hermes-qualification-03.*`）都是 12 项通过。

[↑ 返回目录](#contents)

<a id="unit"></a>

## 单元测试覆盖的情况

- [`network-egress.unit.test.ts`](../../../../../packages/runtime-sandbox/test/network-egress.unit.test.ts) 新增 1 项，共 30 项：按调用方给的地址、端口和 token 监听，错误的 token 得到 407，格式不对的 token 被拒绝。原有的“迟到的 DNS 结果不会再建连接”“地址中混有私网就拒绝”等测试照常通过。
- [`container-execution-backend.unit.test.ts`](../../../../../packages/runtime-sandbox/test/container-execution-backend.unit.test.ts) 新增 7 项，并改了 2 项旧测试（能力声明改为六项、不再以“不支持联网”拒绝），共 36 项。新增的 7 项覆盖：
  - 网络、代理、任务的配置和创建顺序，代理启动在任务创建之前；
  - 任务拿到的代理变量里 token 与代理的一致；
  - 读回的网络不是内部网络或缺少 `inhibit_ipv4` 时拒绝，不启动任何容器；
  - 代理等不到就绪时不创建任务；
  - 先停代理再停任务；代理被重新启动过或被外部删除时不给证明；
  - 删除任务、代理和网络后仍能给出证明；
  - 代理准备过程中收到停止时封住环境；
  - 磁盘保护触发时一并结束代理。

两台机器上都是 66 项通过。

[↑ 返回目录](#contents)

<a id="mutations"></a>

## 测试能否发现缺陷

两个文件的新测试都先于实现运行过：`openNetworkEgress` 的新测试因为用了随机 token 而失败；后端的 8 项因为“不支持联网”而失败。之后逐项临时破坏实现并重跑，再恢复原样，恢复后的 SHA-256 与破坏前一致：

| 临时破坏 | 平台 | 结果 |
| --- | --- | --- |
| 建网络时不加 `inhibit_ipv4`，也不核对它 | Hermes 真实容器 | 失败：宿主上出现 `172.25.0.1/16` |
| 建网络时不加 `--internal`，也不核对它 | Hermes 真实容器 | 失败：读回的网络 `Internal` 为假 |
| 停止时不停代理 | Mac 单元测试 | 2 项失败 |
| 核查已停止时不看代理 | Mac 单元测试 | 1 项失败 |

输出在 `hermes-linux/mutations.log` 和 `mac-orbstack/mutations.log`。

[↑ 返回目录](#contents)

<a id="verification"></a>

## 验证命令与结果

基于提交 `68f6282` 加上本批改动，Node.js 22.22.3。两个平台运行的改动文件 SHA-256 相同，见包内 `changed-files.sha256`。运行命令与[第二批](../p2-original-directory-01/README.md#verification)相同；Hermes 的代码副本和离线安装的依赖沿用 `/data/himawari-p2-20260925-01/source`，本批只同步了改动的文件。

| 命令 | 结果 |
| --- | --- |
| 资格验证，Mac | 最终运行 12 项通过（`mac-qualification-04.*`）；`-01`、`-02` 通过，但测试文件后来还有改动；`-03` 见[一次没能复现的失败](#intermittent)；`dev-*` 是改正测试缺陷时的运行 |
| 资格验证，Hermes | 最终运行 12 项通过（`hermes-qualification-03.*`）；`-01`、`-02` 通过，但测试文件后来还有改动 |
| 单元测试（两个文件），Mac 与 Hermes | 各 66 项通过（`unit-mac-01.log`、`unit-linux-01.log`） |
| `npm run typecheck`、`check:boundaries`、`check:ci-policy`、`check:v0.2-coverage`、`check:v0.2-invariants`、`check:secrets`；改动文件的 `biome format` 与 `biome lint --error-on-warnings` | 通过；lint 只有 `useLiteralKeys` 提示 |

**正式的 `npm test`**：提交 `408e2fd` 之后在本机沙箱外运行 `npm test`，按 `408e2fd` 打安装包后运行全部测试项目。构建和测试两步都通过：contracts 355 项、unit 2004 项（比上一批多 8 项，正好是本批新增的 7 项后端测试和 1 项出口代理测试）、integration 1779 项、e2e 3 项、pi-compat 130 项，没有失败或跳过。报告在 [`npm-test-408e2fd.tar.gz`](npm-test-408e2fd.tar.gz)，安装包本身没有保存，只记录了 SHA-256。本批没有运行覆盖率检查，原因见[第二批](../p2-original-directory-01/README.md#verification)。

原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)（用 `tar -xzf raw-logs.tar.gz` 解开），包括实现前的 BusyBox 实验脚本和日志（`probes/`）。

[↑ 返回目录](#contents)

<a id="gaps"></a>

## 没有覆盖的部分

- **临时凭据**：计划第 3 项的“临时凭据的发放和撤销”和第 4 项“凭据进入容器”都没有做。
- **停止后已建立的连接**：通过“代理容器已退出”来证明所有连接都已关闭（进程退出，连接随之结束）。没有另外做“先建一条隧道、停止后再试着用它”的测试。
- **重定向**：代理不跟随重定向，客户端跟随时是一个新请求，会重新核对目标。这一点由代码结构保证，没有专门的测试，因为需要一个可控的外部服务器。
- **外部网络依赖**：出口测试要访问真实的 `example.com`，外部网络出问题时会失败，见[一次没能复现的失败](#intermittent)。
- **IPv6 出网**：代理检查完全部地址后，用解析结果里的第一个地址去连接。代理容器所在的默认网络没有开 IPv6，如果某个批准目标的第一个地址是 IPv6，连接会失败：HTTP 请求返回 502，CONNECT 直接断开。这种情况只会让访问失败，不会放行未批准的连接。本批测试的 `example.com` 第一个地址是 IPv4，这种情况没有处理，也没有测试。
- **代理本身的资源上限**：内存、进程数、CPU 设了固定上限，但没有测代理在高负载下的表现。
- **产品接入与生产账号**：和前两批相同，见[第一批的未覆盖部分](../p2-container-lifecycle-01/README.md#gaps)。

[↑ 返回目录](#contents)
