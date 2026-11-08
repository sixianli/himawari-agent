## 侧重检查（先查的路径）

- **错误路径**：重点看了权限检查、`sudo` 失败、文件不存在、隧道未启动、端口被占用、密钥口令未进钥匙串这几条。发现一处会把“检查失败”误报成“读不到”的假通过。
- **不可信输入**：看了含特殊字符的密码如何做 URL 编码、`web.env` 变量名提取、Hermes 快照能否证明端口归属。编码命令本身可用，但依赖 `python3`；端口归属没有被快照证明。
- **安全**：看了回环绑定、`ufw` 只放 22、Cloudflare 隧道、`?k=` 密码、400 天 cookie、同机无 sudo 的 `himawari-ci`、Magpie 能看全部密钥。发现密码日志/Referer/同步泄漏面、只检查 `web.env`、`himawari-ci` 仍可访问 3430 等遗漏。
- **资源耗尽**：`KeepAlive` + `ThrottleInterval 15` 会在密钥口令不可用时每 15 秒重试；文档已提醒，风险小。
- **不可撤销操作**：改 `web.env` 权限、在管理页改路由/密钥都按生产配置变更处理了授权；但没有给改权限的回退步骤。
- **规则/文档一致**：核对了 `owner-standing-rules.md#authorization-deploys-and-merges`、ADR 0117、ADR 0142、ADR 0099、ADR 0056、`hr4-after.txt`、`production-web-entry-runbook.md`、`test-host-operations-runbook.md`。锚点和内部链接存在；ADR 0117 的 `/opt/...` 与现场 `/usr/local/bin/...` 已在文中标成未核实，没有硬说矛盾。

## 发现（按严重度）

### 中 — `docs/runbooks/production-server-access-runbook.md:165,178`（并见 `:111`）

**问题**：管理页密码通过 `?k=` 放在 URL 里，并保存成 400 天 cookie。文档只提醒删除浏览器历史，没有覆盖服务端 Magpie 访问日志/journal、Referer、浏览器同步/剪贴板等泄漏面；而同一 Runbook 的 Evidence 还明确要求把 `journalctl` 片段贴给 Claude。若 Magpie 记录完整请求行，密码会离开本机。

**证据**：
- `:165`：“浏览器第一次用 `?k=<密码>` 打开时……把密码存进一个只给本站用的 cookie（……固定密码时保留 400 天）”
- `:178`：“跳转后地址栏不再带密码，再到浏览历史里删掉带 `k=` 的那一条”
- `:111`：“把 `systemctl status` 和相关 `journalctl` 片段贴给 Claude”

**建议**：优先确认 Magpie 是否有登录表单或一次性令牌；如果只能用 `?k=`，在文档中明确禁止把 Magpie 日志贴给模型、检查并清理访问日志，使用关闭同步的独立浏览器配置，并把源码链接固定到 tag/commit。Magpie 是否记录完整 URL 需在服务器上核实。

### 中 — `docs/runbooks/production-server-access-runbook.md:165`

**问题**：权限检查用 `sudo ... && echo 能读 || echo 读不到`，会把“sudo 执行失败、用户不存在、文件不存在”等错误也归到“测试账号读不到”，安全门禁会假通过。

**证据**：
`sudo -u himawari-ci test -r /etc/magpie/web.env && echo 测试账号能读 || echo 测试账号读不到`

**建议**：先确认 `id himawari-ci` 和 `sudo -u himawari-ci true` 能成功，再用 `case $?` 区分：`0`=能读、`1`=读不到、其他=检查失败并停下；或让远端脚本把检查失败显式退出为 `2`，不要把非零一律当“读不到”。

### 中 — `docs/runbooks/production-server-access-runbook.md:160,165`

**问题**：权限检查只覆盖 `/etc/magpie/web.env`，但管理页能看全部密钥，Magpie 的 provider 配置/数据文件也可能含密钥；另外 `himawari-ci` 作为同机普通用户仍能连 `127.0.0.1:3430` 尝试登录，文档没有提密码强度、限速或访问控制。

**证据**：
- `:160`：“可以看和改路由组、模型账号和密钥”
- `:165`：只对 `/etc/magpie/web.env` 做 `stat` 和 `test -r`
- `docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:160`：提到 `/root/config-backups/magpie-providers.json...`，说明 provider 配置确实含敏感信息
- `docs/adr/0056-cloud-server-also-test-host.md:63`：“普通用户 `himawari-ci`（uid 1001），没有 sudo”

**建议**：增加对 Magpie 配置/数据目录的 `stat`/`test -r`（具体 live 路径未核实）；确认 `himawari-ci` 连 3430 也只能得到 401；要求强随机密码；必要时用 `iptables -m owner` 或类似手段把 3430 限制给 `root`/`magpie`。

### 低 — `docs/runbooks/production-server-access-runbook.md:183`

**问题**：Hermes 的证据只证明“容器在运行”和“3425/3430 在监听”，不证明是 `magpie-test` 绑定这两个端口；`ExitOnForwardFailure` 会直接退出的说法也只在该 Hermes 连接也配了该选项时成立，但文档没有给 Hermes 的连接命令。

**证据**：
- `:183`：“只绑 `127.0.0.1:3425` 和 `127.0.0.1:3430`（Hermes 端口快照 … 里同时有这个容器和 `127.0.0.1:3430`）”
- `.agents/tasks/hermes-runner/artifacts/hr4-after.txt:74-75`：`127.0.0.1:3425`、`127.0.0.1:3430`
- 同文件 `:132`：`magpie-test Up 3 days (healthy)`
- 快照没有 `docker port`/`ss -ltnp` 的进程归属，无法把容器和端口对应起来。

**建议**：补 `docker port magpie-test` 或 `docker inspect -f '{{json .NetworkSettings.Ports}}' magpie-test`，或给 `ss -ltnp` 的 PID/进程归属；Hermes 部分补上实际 SSH 别名/命令，并说明只有配了 `ExitOnForwardFailure yes` 才会因端口冲突退出。

### 低 — `docs/runbooks/production-server-access-runbook.md:173,183`

**问题**：生产和 Hermes 都用本机 `3430`，只能靠卸载生产隧道解决；这会中断生产访问，忘记重载就一直断着。

**证据**：
- `:173`：`LocalForward 127.0.0.1:3430 127.0.0.1:3430`
- `:183`：“先 `launchctl unload` 生产隧道，否则两条转发抢同一个本机端口”

**建议**：生产改用另一个本机端口，例如 `LocalForward 127.0.0.1:13430 127.0.0.1:3430`，书签和 `curl` 相应改成 `13430`；Hermes 保留 `3430`。这样两条隧道可共存，也降低本机 `3430` 被其他程序占用/劫持的风险。

### 低 — `docs/runbooks/production-server-access-runbook.md:174-178`

**问题**：plist 只描述没有给完整 XML；`launchctl load/unload` 在新 macOS 仍可用但已弃用；`python3` 在没装 Xcode CLT 的 Mac 上可能只是占位程序。

**证据**：
- `:174`：“运行 `/usr/bin/ssh -N -o BatchMode=yes magpie-prod`”
- `:175`：`launchctl load ...`、`launchctl unload`
- `:178`：`K="$K" python3 -c '...'`

**建议**：给完整 plist（`ProgramArguments` 数组、`StandardErrorPath`、文件权限），用 `launchctl bootstrap gui/$(id -u)` / `bootout` 或注明兼容做法；URL 编码改用 macOS 自带的 `perl -MURI::Escape`，或把编码放到服务器端。

### 低 — `docs/runbooks/production-server-access-runbook.md:163`

**问题**：文档用“回环绑定 + ufw 只开 22”证明公网连不到，但服务器上的 `cloudflared` 出站隧道也能访问 `127.0.0.1:3430`，是第三条路径。现有文档说隧道只到 8400，所以当前安全，但本 Runbook 没把这条列入依据或检查。

**证据**：
- `:163`：“两者都只在回环地址上，公网连不到，防火墙也只放行 22”
- `docs/runbooks/production-web-entry-runbook.md:61`：“`himawari.siyi.win` 经隧道 `himawari-prod`……转到生产机 `http://127.0.0.1:8400`”

**建议**：在“公网连不到”的依据里加上“Cloudflare 隧道 ingress 只到 8400”，或增加一条只读检查/定期核对隧道配置。

### 低 — `docs/runbooks/production-server-access-runbook.md:41,165`

**问题**：Scope 说 Claude、opencode 和 Grok 不以 `root` 或任何生产账号登录，但新段落的命令都是 `ssh root@...`，没有标明“仅 Andy 本人执行”，容易让代理线程误以为它也可以照做。

**证据**：
- `:41`：“不适用：Claude、opencode 和 Grok 都不以 `root` 或任何生产账号登录……”
- `:165`：`ssh root@84.247.157.41 "..."`
- `:169`：`ssh ... root@84.247.157.41`

**建议**：在 Magpie 管理页段落开头写“以下命令由 Andy 本人在 Mac 上运行；AI 线程不得执行”，与 Scope 保持一致。

### 信息 — `docs/runbooks/production-server-access-runbook.md:13-17`

**问题**：`runbook-contract` 只列了 ADR 0056、BL-20261021-009、ADR 0099；新段落依赖 ADR 0117、ADR 0142 和外部 Magpie 行为，封存不会因这些依赖变化而变。当前三个契约文件都没改，`contract_sha256` 仍然有效，不需要重新封存；但将来 ADR 0117 被取代或 Magpie 行为改变时不会触发复核。

**建议**：如果希望封存覆盖新依赖，把 ADR 0117（必要时 ADR 0142）加入 `runbook-contract` 并在同一提交里重新封存；否则保持现在“以管理页和现场为准”的写法，并接受这条封存盲区。

### 信息 — `docs/runbooks/production-server-access-runbook.md:162`

**问题**：ADR 0117 记的是 `/opt/magpie/v0.1.2001/magpie`，现场 `systemctl` 是 `/usr/local/bin/magpie`；文档没有武断地说两者矛盾，而是标成“未核实”，这一点是对的。但这是 `execution_risk: critical` 的 Runbook，发布前应记录 `readlink -f` 的实际结果；外部源码链接用的是 `main`，不是固定版本。

**建议**：把 `readlink -f /usr/local/bin/magpie` 的输出写进 Evidence，或明确列为操作前必须核对；源码链接固定到 tag/commit（最好是生产用的 v0.1.2001）。

## 读代码/文档证实的

- 本次增量 `git diff 2d9451c..24f6966 --numstat` 只有 `docs/runbooks/production-server-access-runbook.md` 的 2 行修改，以及 `.agents/reviews/pr-278/*` 评审记录；没有代码、提示词、工具定义或遮盖逻辑改动。
- ADR 0117 确实记 `/opt/magpie/v0.1.2001/magpie`，并且写了“只监听本机时不检查访问密钥”的是 **网关 3425**，不是管理页 3430；新文档把管理页密码和网关区分开了。
- ADR 0142 的日期是 2026-10-31，正文确实说“Hermes 上没有 Magpie，无法在那里测”；新文档把它解释为“安装之前的情况”，与 `hr4-after.txt:132` 的 `magpie-test Up 3 days`（2026-11-04 快照）方向一致。
- `hr4-after.txt:74-75` 有 `127.0.0.1:3425`、`127.0.0.1:3430`，`:132` 有 `magpie-test`；但没有容器到端口的映射。
- `docs/adr/0056-cloud-server-also-test-host.md:63` 确认 `himawari-ci` 是普通用户、没有 sudo。
- 防火墙文档与 ADR 0099 一致：ufw 入站默认拒绝，只放行 22；Cloudflare 隧道到 8400。
- 新段落的内部链接和锚点都存在：`#magpie-admin`、`#firewall`、ADR 0117、ADR 0142、`owner-standing-rules.md#authorization-deploys-and-merges`、`hr4-after.txt` 路径。
- 仓库里搜 `MAGPIE_WEB_KEY`、`/etc/magpie/web.env`、`magpie.service`，除这份 Runbook 外没有代码消费这些值；没有仓库组件会因这些字符串改变行为。
- `contract_sha256` 保持不变；`runbook-contract` 列出的三个文件本次都没改，所以没有触发重新封存。

## 推测/未核实

- 生产机上 `systemctl cat magpie.service`、`ss -ltnp`、`curl` 返回 401 的实际输出：仓库里没有对应记录，无法独立复核，只有文档转述。
- `MAGPIE_WEB_KEY` 是否真的在 `/etc/magpie/web.env`、该文件的实际权限和属主：文档自己说“文件内容没有读过”，只能按给出的 `grep`/`stat` 命令现场核对。
- Magpie 源码 `internal/gui/web.go` 的 `?k=`、cookie、400 天行为：外部链接，本次不能上网核对；文档也注明生产版本更早，源码只作参考。
- Magpie 是否记录完整请求行（含 `?k=`）：决定上文第一条安全风险的严重度，需要在服务器上查访问日志/journal。
- Magpie 的 provider 配置/数据目录实际路径和权限：ADR 0117 只提到 `/root/config-backups/magpie-providers.json...`，live 路径未核实。
- `/usr/local/bin/magpie` 是否指向 `/opt/magpie/v0.1.2001/magpie`：未核实。
- `himawari-ci` 连接 `127.0.0.1:3430` 的实际响应、管理页是否有速率限制/强密码：未核实。
- Andy Mac 上实际的 plist 文件和 `~/.ssh/config` 内容：不在仓库，未能核对。
- `python3` 是否存在于目标 Mac、是否为 Xcode CLT 占位：未核实。
- `validate_docs.py . --strict` 是否在提交前运行：提交说明没有写，本次复核也不能运行；无法确认。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

不会。改动只涉及 `docs/runbooks/production-server-access-runbook.md` 和评审记录，没有改 `packages/prompt-catalog`、运行时、工具定义、历史存储或出口遮盖。发给模型的内容仍由原有代码组装；如果某个线程用工具读了这份 Runbook，它只会作为新的工具结果追加在历史末尾，不在请求开头。文档里的日期、路径、命令都是静态值，不是每轮变化的值，因此仍然满足“只在末尾追加、每轮会变的值放在最后一条消息”。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会。这是纯文档改动，没有代码路径；文本是固定的，不依赖前后文、时间、数据库顺序或无序集合。评审记录也是静态文件。仓库中没有组件把这份 Runbook 作为自动请求内容序列化。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

没有针对这份 Runbook 的自动检查。`check:prompt-prefix` 与它无关；`check:markdown-tables` 只查表格，本段没有表格；`check:instruction-links` 不扫这份 Runbook；`check:glossary` 排除了 `docs/runbooks/`。`document-governance` 的手动 `validate_docs.py . --strict` 只检查 frontmatter、链接、锚点和封存，不验证 macOS/Magpie 命令是否正确。`contract_sha256` 因三个契约文件未变而仍然有效，不需要重新封存。没有反向用例；权限检查里的 `sudo` 假通过也没有测试覆盖。若要补，最小测试应模拟“sudo 不存在/用户不存在/文件不存在”，要求检查器明确报“检查失败”，而不是输出“读不到”。

**4. 每个新值的使用端都能接受吗？**

- `magpie-prod`：产生于 `~/.ssh/config`（:173），被 plist 的 `ssh ... magpie-prod`（:174）和手动 ssh 使用，名字一致。
- `com.andy.magpie-tunnel`：用于 plist 文件名、`Label`、`launchctl list | grep`（:174-175），一致。
- `127.0.0.1:3430`：用于一次性 `-L`（:169）、`LocalForward`（:173）、浏览器 URL（:178）、`curl`（:176）、Hermes 说明（:183），一致；问题是它与 Hermes 的本机端口冲突，只能靠卸载生产隧道解决。
- `MAGPIE_WEB_KEY` / `/etc/magpie/web.env`：产生于 `systemctl cat` 的 `EnvironmentFile`（:162），被 `grep` 和权限检查（:165）使用；仓库里没有代码消费它，Magpie 实际是否读这个变量未核实。权限检查的错误路径如上所述不能正确区分“失败”和“不可读”。
- `group/himawari-main`：引用 ADR 0117/0119，文档明确说“当前顺序以管理页显示的为准”，没有把顺序写死，使用端可以接受。
- `magpie-test` / `3425` / `3430`：产生于 Hermes 快照，但快照没有证明容器与端口的绑定；这是证据端不满足，不是使用端问题。
- `contract_sha256`：本次未变且仍然有效；但新段落依赖的 ADR 0117/0142 不在契约清单里，封存覆盖不到这两个依赖。
- 内部链接/锚点：都存在于对应文件；外部 `yetone/magpie` 链接未核实。

## 总结

改动方向正确：只写密码位置、不写密钥内容、只经 SSH 回环转发、生产配置变更要求授权，且没有影响模型请求。需要优先修的是权限检查的错误路径假通过、密码在 URL/日志侧的泄漏面、只检查 `web.env` 而没覆盖 Magpie 的密钥配置，以及 Hermes 端口绑定的证据不足。现场 `systemctl`/`ss`/401、`MAGPIE_WEB_KEY`、Magpie 源码行为、`readlink -f`、Hermes 容器端口映射和 Andy Mac 上的实际 plist 都未能在本仓库核实。
