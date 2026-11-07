## 结论概览

未发现高严重度问题。改动只新增了一个文档章节（`docs/runbooks/production-server-access-runbook.md` 30 行），没有代码、提示词、工具定义或序列化改动。主要问题是：**新章节与 ADR 0117 的安装路径矛盾**、**把管理页密码放进 URL 并建议存书签**、**一次性命令与自动配置的本地绑定地址不一致**，以及若干“把未核实信息写成现场事实”的地方。

以下按严重度排列，每条注明【证实】或【推测/未核实】。

---

## 发现的问题

### 1.【中】【证实：文档文字矛盾；实际生产路径未核实】安装路径与 ADR 0117 矛盾

- 文件：`docs/runbooks/production-server-access-runbook.md:162`；`docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:38`
- 问题：新章节写 `ExecStart=/usr/local/bin/magpie`，而 ADR 0117 明确写安装路径是 `/opt/magpie/v0.1.2001/magpie`。仓库里除本次改动外，`/usr/local/bin/magpie` 没有任何出现记录；也没有升级、迁移或符号链接的记录。
- 证据：
  - 新章节：``ExecStart=/usr/local/bin/magpie serve --web=127.0.0.1:3430``
  - ADR 0117：``版本 v0.1.2001，`/opt/magpie/v0.1.2001/magpie`，系统服务 `magpie.service`……只监听 `127.0.0.1:3425` ``
- 建议：在现场用 `readlink -f /usr/local/bin/magpie`、`systemctl show magpie -p ExecStart` 复核。若是符号链接，写清“链接指向 ADR 0117 的 `/opt/magpie/v0.1.2001/magpie`”；若不是，改正本节。ADR 与 Runbook 必须给出同一个事实。

### 2.【中】【证实：设计问题；Magpie 是否记录完整 URL 未核实】把管理页密码放进查询参数并建议存书签

- 文件：`docs/runbooks/production-server-access-runbook.md:168`、`:175`
- 问题：命令让浏览器打开 `http://127.0.0.1:3430/?k=<密码>`，又建议“把带密码的网址存成浏览器书签”。查询参数里的秘密会进入浏览器历史、书签同步、代理/访问日志，并可能通过 `Referer` 发给管理页加载的外部资源。该密码可改配置、看全部密钥，属于高价值凭据。
- 证据：
  - `浏览器打开 http://127.0.0.1:3430/?k=<密码>`
  - `之后把带密码的网址存成浏览器书签`
- 建议：优先使用页面登录表单或 POST，登录后靠会话 cookie。若 Magpie 只支持 `?k=`，至少不要存书签、用完清除历史，并核实 Magpie 不把完整 URL 写日志、不加载第三方资源；同时不要通过 URL 传递密码作为长期做法。

### 3.【中】【证实：两处文本不一致；实际暴露条件为推测】一次性命令未显式绑定回环地址

- 文件：`docs/runbooks/production-server-access-runbook.md:168` 与 `:172`
- 问题：一次性命令是 `ssh -L 3430:127.0.0.1:3430 ...`，没有写本机绑定地址；自动配置却明确写了 `LocalForward 127.0.0.1:3430 127.0.0.1:3430`。`-L` 的默认绑定行为受客户端 SSH 配置影响，显式写 `127.0.0.1` 才能保证只在本机回环上监听。若用户 `~/.ssh/config` 中有 `GatewayPorts yes`，一次性转发可能把管理页暴露到 Mac 的其他网络接口。
- 证据：
  - 一次性：`ssh -L 3430:127.0.0.1:3430 root@84.247.157.41`
  - 自动：`LocalForward 127.0.0.1:3430 127.0.0.1:3430`
- 建议：统一改成 `ssh -L 127.0.0.1:3430:127.0.0.1:3430 root@84.247.157.41`，并在文中说明“只在本机回环监听”。

### 4.【中低】【证实：仓库内无其他佐证；Magpie 实际行为未核实】“密码在 web.env、用 `?k=` 登录”超出所给证据

- 文件：`docs/runbooks/production-server-access-runbook.md:162-164`、`:168`
- 问题：`systemctl cat` 显示 `EnvironmentFile=/etc/magpie/web.env`，只能证明服务加载了某个环境文件，不能证明管理页密码就在其中，也不能证明密码参数名是 `k`。`curl -sI` 返回 401 只能证明页面存在且需要认证，不能证明 `?k=<密码>` 是正确登录方式。仓库里 `3430`、`web.env`、`?k=` 除本次改动外没有任何记录（Hermes 工件的 `127.0.0.1:3430` 只能证明该端口在测试机监听，不能证明是 Magpie 管理页）。
- 证据：
  - `EnvironmentFile=/etc/magpie/web.env`
  - `管理页密码在 /etc/magpie/web.env，由服务通过 EnvironmentFile 读入`
  - `http://127.0.0.1:3430/?k=<密码>`
- 建议：按实际 Magpie 版本核实环境变量名和认证方式，文档里写“变量名/登录方式经现场验证”，但不写值；未核实前标成待复核，不要写成既成事实。

### 5.【低】【部分推测：Magpie 对 HEAD 的响应未核实】用 `curl -sI | head -1` 做验证有误判风险

- 文件：`docs/runbooks/production-server-access-runbook.md:175`
- 问题：验证依赖 HEAD 请求返回 `HTTP/1.1 401 Unauthorized`。如果管理页对 HEAD 返回 `405`、`302` 或 `200`，判断会误导；`curl -s` 还会吞掉连接错误，管道的退出码是 `head` 的 0，无法区分“隧道没通”和“页面返回了别的状态”。
- 证据：`curl -sI http://127.0.0.1:3430/ | head -1` 返回 `HTTP/1.1 401 Unauthorized`
- 建议：改用 `curl -sS -o /dev/null -w '%{http_code}\n' --noproxy '*' http://127.0.0.1:3430/`，失败时明确显示 `000`；并补一条实际登录成功的验证，不只靠 401。

### 6.【低】【证实：macOS/launchd 平台行为】“开机自动连接”实际是“登录后自动连接”，`launchctl load` 已弃用

- 文件：`docs/runbooks/production-server-access-runbook.md:170-174`
- 问题：`~/Library/LaunchAgents` 的 LaunchAgent 在用户登录后由 launchd 加载，不是系统开机时运行；真正开机运行需要 LaunchDaemon（通常需要 root）。另外 `launchctl load/unload` 在新版 macOS 已弃用，推荐 `launchctl bootstrap gui/$(id -u)` 和 `launchctl bootout`。
- 证据：
  - `~/Library/LaunchAgents/com.andy.magpie-tunnel.plist`
  - `launchctl load ~/Library/LaunchAgents/com.andy.magpie-tunnel.plist` 启用；`launchctl unload` 同一路径停用
- 建议：改为“登录后自动连接”；命令改为 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.andy.magpie-tunnel.plist` / `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.andy.magpie-tunnel.plist`，或至少注明旧命令仍可用。

### 7.【低】【推测：生产是否装 fail2ban 未核实】`KeepAlive` 无限重试可能刷日志/触发封禁

- 文件：`docs/runbooks/production-server-access-runbook.md:173`、`:180`
- 问题：`KeepAlive` 为真、`ThrottleInterval` 15 秒，配合 `BatchMode=yes`。当私钥口令未进钥匙串、端口被 Hermes 隧道占用或网络长期不可达时，ssh 会每 15 秒失败重试并无限持续；可能刷 Mac/服务器日志，若生产有 fail2ban 一类机制，还可能把来源 IP 封掉。
- 证据：`设 RunAtLoad、KeepAlive 为真，ThrottleInterval 为 15 秒；断线后自动重连`
- 建议：在 plist 里配置 `StandardErrorPath`/`StandardOutPath` 便于排障，或给重试加退避；文档补一句如何用 `launchctl print gui/$(id -u)/com.andy.magpie-tunnel` 查看状态并停止。

### 8.【低】【证实：契约清单文字；是否必须纳入属治理判断】新章节依赖 ADR 0117，但契约清单未包含它

- 文件：`docs/runbooks/production-server-access-runbook.md:13-17`、`:179`
- 问题：新章节引用 ADR 0117 的路由顺序，并且安装路径事实也应以 ADR 0117 为准；但 `runbook-contract` 仍只列 ADR 0056、BL-20261021-009、ADR 0099。将来 ADR 0117 改动不会让本 Runbook 的 `contract_sha256` 失效，封存机制发现不了这处漂移。
- 证据：
  - `<!-- runbook-contract: docs/adr/0056... docs/backlog/BL-20261021-009... docs/adr/0099... -->`
  - `路由组 group/himawari-main 的当前顺序见 ADR 0117`
- 建议：把 `docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md` 加入 `runbook-contract`，并在完整模式重新封存；若不纳入，写明理由。

### 9.【低】【建议】没有检查 `/etc/magpie/web.env` 的权限和安全读取方式

- 文件：`docs/runbooks/production-server-access-runbook.md:164`
- 问题：文档只说“密码在 `/etc/magpie/web.env`、不要把内容贴进聊天或仓库”，但没有要求确认该文件权限，也没有说明如何安全读取。该文件若对同机其他账号可读，管理页密码和可能的供应商密钥会暴露。
- 证据：`管理页密码在 /etc/magpie/web.env，由服务通过 EnvironmentFile 读入。不要把它的内容贴进聊天或写进仓库。`
- 建议：补一条只读检查，例如 `stat -c '%a %U:%G' /etc/magpie/web.env`，期望仅 root/`magpie` 可读（如 `0600`/`0640`）；读取时避免进入 shell 历史或终端回滚。

---

## 命令与配置可用性

- 【证实：OpenSSH 选项文本语义】`Host`、`HostName`、`User`、`LocalForward 127.0.0.1:3430 127.0.0.1:3430`、`ServerAliveInterval`、`ServerAliveCountMax`、`ExitOnForwardFailure`、`AddKeysToAgent`、`UseKeychain` 都是 macOS OpenSSH 接受的配置；`ssh-add --apple-use-keychain <私钥文件>` 也是 macOS 支持的写法。
- 【推测/未核实】`launchd` plist 只写了关键项，没有给出完整 `ProgramArguments` 数组和 label，无法从文档独立复现；`RunAtLoad`/`KeepAlive` 的 launchd 语义本身正确，但“开机”措辞不准确（见第 6 条）。
- 【未核实】管理页是否真的用 `?k=`、是否对 HEAD 返回 401、Hermes 的 3430 是否就是 Magpie 管理页；仓库内没有足够证据。

---

## 侧重检查

- **错误路径**：隧道失败、认证失败、端口被占、KeepAlive 反复重启、`curl` 误判——见第 3、5、7 条。文档对 Hermes 的 3430 冲突有提示，这是好的；但没有给出“如何确认隧道在反复失败”的检查。
- **不合规范或不可信输入**：密码放进 URL 查询参数、`<密码>` 占位符、`EnvironmentFile` 内容与变量名未核实——见第 2、4 条。
- **安全**：只监听回环、防火墙只放行 22、经 SSH 转发、不对外开放，这些方向正确，没有建议对公网开放。遗漏在秘密处理：URL 存密码/书签、一次性命令未显式绑定回环、未检查 `web.env` 权限——见第 2、3、9 条。
- **资源耗尽**：`KeepAlive` + 15 秒重试在长期失败时无上限——见第 7 条（推测）。
- **不可撤销的操作**：管理页改路由组/账号/密钥会立即影响线上，文档明确要求按授权规则处理，这一点与 `.claude/rules/owner-standing-rules.md:37` 的“授权、上线和合并”一致，未发现问题。
- **规则文件、说明文档和代码是否一致**：新章节的两个链接锚点都存在（`#magpie-admin` 在 `production-server-access-runbook.md:156`；`#authorization-deploys-and-merges` 在 `owner-standing-rules.md:37`），`group/himawari-main` 在 ADR 0117 中存在；但安装路径与 ADR 0117 矛盾，且 ADR 0117 未纳入 Runbook 契约清单——见第 1、8 条。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本次 diff 只在 `docs/runbooks/production-server-access-runbook.md` 新增 30 行文档，没有改系统提示、工具定义、历史消息、遮盖代码或序列化代码。该 Runbook 没有被 prompt catalog 或运行时代码引用（仓库内只有其他文档链接到它）。因此发给模型的内容仍然遵循“固定在前、变化在后、只在末尾追加”；本次没有把任何每轮变化的值放进请求开头。依据：[prompt-prefix.md 第 4 条](../.claude/rules/prompt-prefix.md#append-only) 和[第 2 条](../.claude/rules/prompt-prefix.md#order)。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 改动是静态文档文字，没有运行时代码、序列化格式、遮盖规则或无序集合变化。文档里的 `2026-11-02` 是固定文字，不是每次请求生成的时间字段。本次不涉及“依赖前后文的遮盖”“带时间的字段”“无序集合”这几类问题。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**没有针对这些命令/配置的自动检查。** 提交说明写的是 `Layer-0-tests: none`，只运行了 `check:glossary`、`check:markdown-tables`、`check:secrets`、`check:instruction-links` 和 `validate_docs.py --strict`；这些只检查文档结构、链接和密钥格式，不会验证 SSH/launchd/curl 命令是否可用，也不会验证 401、端口转发或密码保存方式。文档里的 401 是人工正向验证；没有记录反向用例（例如隧道关闭时请求应失败、公网访问 3430 应不通、错误密码应被拒绝），也没有一个“去掉修复就会失败”的自动反向测试。依据：提交说明 `Layer-0-tests: none`，以及 `docs/incidents-and-gates.md:112` 对 I-73 的教训（测试只覆盖解析和展示，没有把清单值交给真正的使用端校验）。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对如下：

| 值 | 产生位置 | 使用/核对位置 | 结论 |
| --- | --- | --- | --- |
| `84.247.157.41` | Runbook:168、172 | Runbook 开头的 `84.247.157.41`（:19）、Procedure（:88） | 一致 |
| `127.0.0.1:3425` | Runbook:162、163 | ADR 0117:38、:46 的 `127.0.0.1:3425` | 一致 |
| `127.0.0.1:3430` | Runbook:162、163、168、172、175、180 | 仓库内只有本改动和 `.agents/tasks/hermes-runner/artifacts/hr4-*.txt` 的端口快照；后者只能证明 Hermes 上有该端口监听 | 生产端使用点**未核实**；Hermes 端部分佐证 |
| `/usr/local/bin/magpie` | Runbook:162 | ADR 0117:38 写 `/opt/magpie/v0.1.2001/magpie`；仓库内无其他记录 | **矛盾，需复核** |
| `/etc/magpie/web.env` | Runbook:162、164 | 仓库内无其他记录 | **未核实**：只能证明 `EnvironmentFile` 存在，不能证明密码在其中 |
| `?k=<密码>` | Runbook:168、175 | 仓库内无其他记录；401 不证明该参数是登录方式 | **未核实**，且有秘密泄漏风险 |
| `magpie-prod`、`com.andy.magpie-tunnel` | Runbook:172、173 | 只在 Mac 本地使用，仓库无冲突 | 可用，但文档未给出完整 plist，无法独立复现 |
| `#magpie-admin` | Runbook:33、156 | 同文件锚点存在 | 一致 |
| `#authorization-deploys-and-merges` | Runbook:179 | `.claude/rules/owner-standing-rules.md:37` 锚点存在 | 一致 |
| `group/himawari-main` | Runbook:179 | ADR 0117:60、:129、:160 | 一致 |
| Runbook 契约清单 | Runbook:13-17 | 新章节依赖 ADR 0117:38、:160，但清单没有 ADR 0117 | **不一致**：未来 ADR 0117 改动不会让本 Runbook 封存失效 |
| `contract_sha256` | Runbook:5 | 契约源文件（ADR 0056、BL-20261021-009、ADR 0099）本次未改 | 本次 diff 不直接导致摘要变化；提交说明已承认该 Runbook 封存改前已过期，属既有问题 |

以上第 1、2、4、8 条是本次应重点处理的；第 3、5、6、7、9 条属于低严重度或依赖现场核实。
