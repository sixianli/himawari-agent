# P2：真实浏览器测试样例

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P2](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p2)中“用真实浏览器测试样例验证进程、profile、下载和出口一起被管住；没有登记浏览器后端的产品入口继续拒绝”，验收条目是 ITE-13。规则来源是 Spec 的[浏览器与外部资源](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#browser)：第一阶段不新增浏览器产品工具，只用测试样例验证容器后端能管住浏览器这类进程。

## 用词

| 用词 | 意思 |
| --- | --- |
| profile | 浏览器保存 cookie、缓存、历史的目录 |
| CDP | Chrome DevTools Protocol，外部程序遥控浏览器用的接口，默认监听 9222 端口 |
| 无头模式 | 浏览器不显示窗口地运行，`--headless=new` |
| 模拟网站 | 测试时在环境的内部网络上临时启动的小型 HTTP 服务，名字叫 `site.test` |
| 407 | HTTP 状态码“需要代理认证” |

## 用户的授权

2026-09-26 用户同意下载浏览器。浏览器测试镜像 [`fixtures/browser-image/Dockerfile`](../../../../integration/fixtures/browser-image/Dockerfile) 以已经固定的 `node:22.22.3-alpine` 为底，只装一个写死版本的 `chromium=152.0.7977.82-r0`，从 Alpine 3.24 软件源下载。

构建结果：

- Mac：内容 ID `a4f03b33…`，约 896 MB。
- Hermes：内容 ID `44b8c081…`。构建后，根盘剩余空间从 16 GB 降到 14 GB。

这个镜像只用于测试，不是产品的 runner 镜像。

## 发现并修正的产品问题

第一次运行时，浏览器访问 `example.com` 和 `example.org` 都报 `net::ERR_PROXY_AUTH_UNSUPPORTED`（`mac-browser-dev-02.*`）。原因在出口代理 [`network-egress.ts`](../../../../../packages/runtime-sandbox/src/network-egress.ts)：它拒绝没带认证的请求时，返回的 407 响应里没有 `Proxy-Authenticate` 头，而 HTTP 规范（RFC 9110）要求 407 必须带这个头，告诉客户端用哪种方式认证。

- curl、npm 这类客户端会直接把代理地址里的账号密码发过去，所以之前一直没有暴露。
- 浏览器会先等代理说明认证方式，所以失败了。

修正：普通请求和 CONNECT 隧道的 407 响应都带上 `Proxy-Authenticate: Basic realm="himawari-egress"`。认证核对本身没有变。先在 [`network-egress.unit.test.ts`](../../../../../packages/runtime-sandbox/test/network-egress.unit.test.ts) 新增一项测试，在修正前运行，失败了；修正后通过，这个文件共 31 项。修正后，浏览器经出口代理打开了 `example.com`。

## 测试做了什么

测试文件是 [`container-browser-qualification.test.ts`](../../../../integration/container-browser-qualification.test.ts)，在 [`ci/policy.json`](../../../../../ci/policy.json) 登记为独立项目 `qualification-container-browser`。运行它要设置 `HIMAWARI_CONTAINER_BROWSER_QUALIFICATION=1`，并用 `HIMAWARI_CONTAINER_BROWSER_IMAGE_ID` 给出本机构建的浏览器镜像内容 ID；缺少内容 ID 时测试失败，不会跳过。

浏览器环境的资源额度单独放宽为 1 个 CPU、1 GiB 内存、512 个进程、512 MiB 私有存储。原来 128 MiB 的内存不够 Chromium 运行。

测试步骤：

1. 创建第一个环境。它只批准 `example.com:443`，并只读挂载控制脚本 [`driver.mjs`](../../../../integration/fixtures/browser-image/driver.mjs)。
2. 在它的内部网络上启动模拟网站 [`site.mjs`](../../../../integration/fixtures/browser-image/site.mjs)，提供三种页面：写 cookie、显示 cookie、一个每 100 毫秒发 16 KB、永远发不完的下载。
3. 在环境里运行控制脚本。脚本在后台启动 Chromium（无头模式，profile 放在 `/tmp/profile`，经任务出口代理联网，访问模拟网站时不走代理），然后通过 CDP 依次：
   - 写入 cookie 并读回；
   - 打开 `example.com` 和 `example.org`；
   - 开始慢速下载。

   脚本自己退出后，浏览器继续运行。
4. 检查以下几项：
   - 环境里的浏览器进程数；
   - 环境里能连上 CDP；
   - 从模拟网站所在的容器（和任务在同一个网络上）连任务的 9222 端口，以及对照端口 9333（任务在 `0.0.0.0` 上另开的普通端口）；
   - 任务容器没有向宿主发布任何端口；
   - 下载在停止前还在增长。
5. 停止环境，拿到停止证明。确认模拟网站记录到下载连接已断开，并且此后 2 秒内字节数不再增加。
6. 创建第二个环境，把模拟网站也接到它的网络上，再运行控制脚本，读取 cookie。

“没有登记浏览器后端的产品入口继续拒绝”由现有代码和测试证明，本批没有改动：

- 产品没有浏览器工具，Pi 工具固定为 7 个（[`governed-coding-tools.ts`](../../../../../packages/runtime-pi/src/governed-coding-tools.ts) 的 `GovernedPiCodingToolName`）。
- 名单以外的工具名，会在 [`pi-runtime-adapter.ts`](../../../../../packages/runtime-pi/src/pi-runtime-adapter.ts) 里被 `PI_UNKNOWN_TOOL` 拒绝，[`runtime-event-contract.unit.test.ts`](../../../../../packages/runtime-pi/test/runtime-event-contract.unit.test.ts) 的 “rejects unknown tools” 覆盖了这一点。

## 结果

| 检查 | Mac（OrbStack 2.2.3，arm64） | Hermes（Docker 29.6.1，amd64） |
| --- | --- | --- |
| cookie 写入后读回 | `himawari=fixture-cookie` | 相同 |
| 经出口代理打开批准的 `example.com` | 标题为 `Example Domain` | 相同 |
| 打开未批准的 `example.org` | `net::ERR_TUNNEL_CONNECTION_FAILED` | 相同 |
| 浏览器进程数 | 15 | 16 |
| 环境里连 CDP | 能连上 | 相同 |
| 邻居容器连对照端口 9333 | 能连上 | 相同 |
| 邻居容器连 CDP 端口 9222 | 连不上 | 相同 |
| 向宿主发布的端口 | 无 | 相同 |
| 停止前的下载 | 1 秒内从 180224 字节增长到 360448 字节 | 从 278528 增长到 475136 |
| 停止后的下载 | 模拟网站记录 `download-closed`，之后 2 秒字节数不变 | 相同 |
| 停止证明 | 两个环境都是 `verified_stopped` | 相同 |
| 第二个环境 | 启动前没有 profile，读到的 cookie 为空 | 相同 |
| 清理 | 本轮测试的容器和网络读回为 0 | 相同 |

邻居容器能连上对照端口、却连不上 CDP 端口，说明地址和网络都是通的，CDP 确实只对环境内部开放。

写测试时还做过一次反向检查：把控制脚本改成让 CDP 监听所有地址，测试仍然通过（`mutation-cdp-all-addresses.*`）。在一次性容器里直接查看才发现，Chromium 152 的新版无头模式会忽略 `--remote-debugging-address`，CDP 始终只监听 `127.0.0.1`。也就是说，那次改动并没有真正生效。正是因为这一点，测试里加了上面的对照端口。

出口代理改过，所以原有的资格测试也重跑了：两个平台都是 14 项通过（Mac 经 `qualify:container` 入口）。

## 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| 浏览器资格测试，Mac | 最终运行 1 项通过（`mac-browser-01.*`）；`dev-01`、`dev-02` 是修正出口代理之前的失败，`dev-03` 是加对照端口之前的运行 |
| 浏览器资格测试，Hermes | 1 项通过（`hermes-browser-01.*`） |
| 单元测试（出口代理与后端两个文件），Mac 与 Hermes | 各 77 项通过 |
| 资格测试 `qualification-container`，Mac 与 Hermes | 各 14 项通过 |
| tooling 项目 | 1042 项通过，9 项失败（`tooling-01.log`），都是[资格验证入口的记录](../p2-qualification-entry-01/README.md)里已经查明的原有环境问题。此前由 `.DS_Store` 引起的那一项，在用户同意删除这个文件后通过了 |

密钥扫描 `npm run check:secrets` 把 `driver.mjs` 中把代理密码交给 CDP 的那一处 `password: decodeURIComponent` 认作写死的密码。这个值其实来自任务环境变量里的代理地址，是误报。已按项目登记测试文件误报的做法，在 [`machine-secret-scan-baseline.json`](../../../../../scripts/machine-secret-scan-baseline.json) 为这一处匹配文本登记一条，绑定文件、规则和摘要；文本一旦改变，扫描就会重新报出来。登记后扫描通过。

两个平台运行的改动文件 SHA-256 相同，见 `browser-files.sha256`。原始输出打包在 [`raw-logs.tar.gz`](raw-logs.tar.gz)。

## 没有覆盖的部分

- **浏览器产品工具**：第一阶段不做，这里的结果不代表产品已经具备浏览器功能。
- **把浏览器装进 runner 镜像**：没有做，runner 镜像仍然不含浏览器。
- **用户已登录的 profile 或桌面浏览器**：没有接入这类路径，所以也没有专门测试它们会被拒绝；拒绝依据是产品里根本没有这类工具。
- **远端浏览器**：没有涉及。
