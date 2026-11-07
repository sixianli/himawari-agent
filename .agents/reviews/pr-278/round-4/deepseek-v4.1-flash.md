## 一、读代码/文档证实的发现（按严重度）

### 1. 中 — 新章节与 ADR 0117 对监听端口、鉴权的说法冲突
- 文件:行：`docs/runbooks/production-server-access-runbook.md:163`、`:162`；`docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:38`、`:114`
- 问题：ADR 0117（仍为 `status: active`）写的是「只监听 `127.0.0.1:3425`」，并说「Magpie 只监听本机时不检查访问密钥」；新 Runbook 说同一个进程还监听 `3430`，且管理页要密码。Runbook 只注明了安装路径与 ADR 不同，没有注明端口和鉴权口径的变化。
- 证据：
  - ADR 0117:38：「只监听 `127.0.0.1:3425`」
  - Runbook:163：「同一个 `magpie` 进程监听 `127.0.0.1:3425`（模型接口）和 `127.0.0.1:3430`（管理页）」
  - ADR 0117:114：「Magpie 只监听本机时不检查访问密钥」
- 建议：在 ADR 0117 补一条后续修订（管理页后来在 3430 启用、带密码），或在 Runbook 明确写「3425 是网关 API，3430 是后来启用的管理页，不受 ADR 那句『不检查访问密钥』覆盖」。若把 ADR 0117 当作本节依据，还应把它加入 `runbook-contract` 清单。

### 2. 中 — Cookie 按主机名共享，不只 Hermes；文档只警告了 Hermes
- 文件:行：`docs/runbooks/production-server-access-runbook.md:183`、`:178`
- 问题：文档自己写了「浏览器的 cookie 按主机名区分、不按端口区分」，但只提醒不要用 `127.0.0.1` 连 Hermes。按同一规则，Mac 上任何绑定 `127.0.0.1` 的其他本地服务（任意端口）都可能收到生产管理页的 cookie；文档却建议把 `http://127.0.0.1:3430/` 存成长期书签，风险面比 Hermes 大。
- 证据：
  - Runbook:183：「浏览器的 cookie 按主机名区分、不按端口区分……否则浏览器会把生产管理页的 cookie（里面就是生产密码）发给 Hermes 的 Magpie。」
  - Runbook:178：「把这个不带密码的 `http://127.0.0.1:3430/` 存成书签。」
- 建议：把这条警告推广到「所有本地服务」，并给出更稳的做法：生产管理页用专用浏览器配置/容器，或至少不要在同一浏览器里用 `127.0.0.1` 访问其他本地服务；切换后清理 cookie。

### 3. 中 — 密码放在 `?k=` 查询串里，文档只处理了浏览器历史
- 文件:行：`docs/runbooks/production-server-access-runbook.md:165`、`:178`
- 问题：`?k=<密码>` 会进入 Magpie 的 HTTP 访问日志、浏览器同步/扩展、会话恢复，页面若加载外部资源还可能通过 `Referer` 带出。文档只要求「到浏览历史里删掉带 `k=` 的那一条」，没有覆盖这些渠道。管理页能改路由、看全部密钥，密码泄露的影响很大。
- 证据：
  - Runbook:165：「浏览器第一次用 `?k=<密码>` 打开……」
  - Runbook:178：「再到浏览历史里删掉带 `k=` 的那一条」
- 建议：补充「登录后检查/清理 Magpie 访问日志；用专用浏览器配置；确认管理页不向外部资源发请求」；如果 `?k=` 可能已进日志或同步，轮换 `MAGPIE_WEB_KEY` 并重启 Magpie。Magpie 是否记录查询串我无法离线核实，但文档的缓解措施即使按最保守假设也不完整。

### 4. 低 — 网址编码只列了 `+ & # %`，不完整
- 文件:行：`docs/runbooks/production-server-access-runbook.md:178`
- 问题：查询串里还需要编码的字符不止这些（空格、非 ASCII、`?`、`;`、`=`、`/` 等都可能因实现不同出问题）。文档写成「密码含 `+、&、#、%` 时先做网址编码」，容易被理解成只处理这四个。
- 证据：Runbook:178：「密码含 `+`、`&`、`#`、`%` 时先做网址编码」
- 建议：改成「对整个密码做 percent-encoding」，例如用浏览器控制台的 `encodeURIComponent(密码)` 或 `python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))'`。

### 5. 低 — `UseKeychain` 与裸 `ssh`、`Host *` 覆盖顺序可能导致配置不可用
- 文件:行：`docs/runbooks/production-server-access-runbook.md:169`、`:173`、`:174`
- 问题：`UseKeychain yes` 和 `ssh-add --apple-use-keychain` 是 Apple 自带 ssh 的特性；一次性连接用的是裸 `ssh`，若 `PATH` 里是 Homebrew OpenSSH，配置会因未知选项失败。另外 OpenSSH 对同一参数取「先匹配到的值」，如果用户的 `Host *` 在 `Host magpie-prod` 之前并设置了 `User`、`ExitOnForwardFailure` 等，后面这段可能被忽略。
- 证据：
  - Runbook:169：「`ssh -N -o ExitOnForwardFailure=yes -L ...`」
  - Runbook:173：「`UseKeychain yes`」
  - Runbook:174：「`/usr/bin/ssh -N -o BatchMode=yes magpie-prod`」
- 建议：一次性命令也写 `/usr/bin/ssh`，或注明这些选项只适用于 Apple ssh；并说明把 `Host magpie-prod` 放在 `Host *` 之前，或用 `ssh -G magpie-prod` 核对最终生效值。

### 6. 低 — 只看变量名的 `grep` 可能漏掉 `MAGPIE_WEB_KEY`
- 文件:行：`docs/runbooks/production-server-access-runbook.md:165`
- 问题：`grep -oE '^[A-Za-z_][A-Za-z0-9_]*='` 只匹配行首、且要求变量名后直接跟 `=`。如果 `/etc/magpie/web.env` 用了 `export NAME=`、行首缩进或 `NAME = value` 写法，变量名不会打印，用户可能误以为没有密码变量。
- 证据：Runbook:165：「`grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' /etc/magpie/web.env`」只看变量名
- 建议：用更宽容的表达式，例如 `grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*='`；它仍只打印名字和等号，不输出值。

### 7. 低 — LaunchAgent 失败路径和 `000` 的解释覆盖不足
- 文件:行：`docs/runbooks/production-server-access-runbook.md:174`、`:184`、`:176`
- 问题：`BatchMode=yes` 遇到未知主机密钥或密钥不在 agent 时会直接失败；`KeepAlive` + `ThrottleInterval 15` 会每 15 秒无限重试。文档只讲了口令保护密钥这一种原因。另外 `curl` 的 `000` 也可能表示服务器上的 Magpie 没在监听/已崩溃，不只「隧道没通」。
- 证据：
  - Runbook:174：「`JudgeKeepAlive` 为真，`ThrottleInterval` 为 15 秒」
  - Runbook:184：「后台的 `ssh` 无法弹窗输入，会每 15 秒重试一次」
  - Runbook:176：「输出 `000` 表示隧道没通」
- 建议：补一句「先手动跑一次同一条 ssh 接受主机密钥，再 load LaunchAgent」；写清失败时用 `launchctl unload` 停止、用 `log show` 或前台命令看原因；把 `000` 解释为「没拿到 HTTP 响应，可能是隧道、远程 3430 或 Magpie 本身的问题」。

### 8. 低 — `runbook-contract` 未包含新引用的 ADR 0117
- 文件:行：`docs/runbooks/production-server-access-runbook.md:13-17`、`:162`
- 问题：新章节的事实依据来自 ADR 0117，但 `runbook-contract` 仍只列 ADR 0056、BL-20261021-009、ADR 0099。以后 ADR 0117 改动不会让本 Runbook 的 `contract_sha256` 失效，Runbook 可能悄悄过期。
- 证据：Runbook:13-17 的契约清单没有 ADR 0117；Runbook:162 引用了 `[ADR 0117](../adr/0117-...)`
- 建议：若 ADR 0117 是本节权威来源，把它加入契约清单并用 `runbook.py seal --confirm-reconciled --apply` 重新封存；若只是背景资料，在文中注明。

## 二、推测/未核实（不能下确定结论）

- **`MAGPIE_WEB_KEY`、`?k=`、400 天 cookie 的行为**：仓库里没有 Magpie 源码，我无法离线核对 `internal/gui/web.go`；文档也承认生产装的是更早版本。`MAGPIE_WEB_KEY` 是否就是生产版本读取的变量名、cookie 里是否真是原始密码，均未核实。
- **「2026-11-02 用户用这个流程登进了生产管理页」**：作者材料只给了 `curl -sI` 返回 401 这一条证据，401 只能证明「能到达但未登录」，不能证明登录成功；文档的验证命令又从 `curl -sI`（HEAD）改成了 GET，两者未见同一份实测记录。
- **Hermes 的 Magpie 管理页也用 3430**：仓库内没有找到第二条证据，属于未核实的现场事实。
- **`/etc/magpie/web.env` 的内容和权限**：文档明说「文件内容没有读过」；`MAGPIE_WEB_KEY` 是否真的在这个文件里、文件是否仅 root 可读，都未核实。
- **`/usr/local/bin/magpie` 与 `/opt/magpie/v0.1.2001/magpie` 的关系**：文档已明确写「未核实，以 `readlink -f` 为准」，这是正确的处理；但当前仍无法确认两者是否同一程序。
- **Magpie 是否记录查询串、管理页是否有 CSRF 防护**：未核实，所以我无法判断 `?k=` 和跨端口 cookie 的实际可利用程度；结论只能按最保守方向建议。
- **`validate_docs.py --strict` / `contract_sha256`**：我没有运行该技能。按文件内容看，契约清单里的三个源文件未改动，哈希应仍匹配；若把 ADR 0117 加进清单，则需要重新封存。

## 三、侧重检查

- **错误路径**：端口被 Hermes/其他本地服务占用（`169`、`183`）、隧道断开（`176`）、口令保护密钥（`184`）、未知主机密钥（`174`）、远程 Magpie 未启动（`176`）、密码错误或无 cookie（`176`、`178`）、cookie 被清（`178`）。结论：主要路径有说明，但主机密钥和远程 Magpie 未启动未覆盖，`000` 的解释过窄。
- **不合规范/不可信输入**：密码里的保留字符（`178`）、`/etc/magpie/web.env` 的格式（`165`）、`grep` 只匹配行首（`165`）。结论：URL 编码建议不完整，`grep` 可能漏行。
- **安全**：只绑回环、只走 SSH、不开放公网（`167`、`183`）方向正确；但 cookie 跨端口共享只警告了 Hermes（`183`），`?k=` 的日志/Referer/同步泄漏未覆盖（`165`、`178`），`/etc/magpie/web.env` 权限未检查（`165`），常驻隧道 + 400 天 cookie 的暴露面也未提示（`174`、`165`）。
- **资源耗尽**：`KeepAlive` + `ThrottleInterval 15` + `BatchMode` 在密钥/主机密钥/网络失败时会无限重试（`174`、`184`）；文档给了 `launchctl unload`，但没有日志查看和失败停止说明。
- **不可撤销操作**：管理页修建立即影响线上（`182`），已正确指向授权规则；但没有建议改前备份 Magpie 当前配置（ADR 0117 里有历史备份路径，可作为参考）。
- **规则/文档一致**：`prompt-prefix.md` 的追加规则不受影响（本次只改文档）；`owner-standing-rules.md:37` 的锚点存在；ADR 0117 的端口/鉴权说法冲突；`runbook-contract` 未列 ADR 0117。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次实际改动只有 `docs/runbooks/production-server-access-runbook.md`（33 行新增）和复核记录，没有任何组装系统提示、工具定义、历史或遮盖的代码；用 `grep` 查过仓库，没有代码把这个 Runbook 读进模型请求。因此仍然符合 `prompt-prefix.md` 第 2 条「每轮都会变的内容只放在最后一条用户消息里」和第 4 条「只能追加」；每轮会变的值没有被挪到前面。若有人把这篇 Runbook 手动贴进对话，它也只是末尾新增的用户/工具内容，不是前缀改动。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。没有改 JSON 序列化、工具顺序、列表顺序或遮盖逻辑；文档里的日期是手写固定文字，不是每轮生成的时间字段。只有把 Runbook 作为外部资料喂给模型时才可能进入请求，但那是静态文件内容，且当前代码没有这条路径。

3. **有没有对应的自动检查？反向用例会不会真的失败？** 没有专门检查。`npm run check:prompt-prefix` 等门槛针对提示词组装，不检查 Runbook 里的 SSH/launchd/curl 命令；文档治理的 `validate_docs.py --strict` 最多检查 front matter、契约和链接，不会发现 `ssh` 选项写错、端口写错或 cookie 警告漏项。因此没有反向用例，写错也不会让 CI 失败；目前只有作者手工 `curl` 401 的现场证据，且不在仓库里。

4. **每个值两端都能接受吗？** 逐个核对：
   - `127.0.0.1:3430`：服务端 `--web=127.0.0.1:3430` 与 `ss` 证据、客户端 `-L`/`LocalForward`、`curl`、浏览器一致；服务端事实按作者说法，未在仓库独立核实。
   - `127.0.0.1:3425`：只是模型接口上下文，ADR 0117 的 `baseUrl` 也用它，本次未改。
   - `magpie-prod`：`~/.ssh/config` 定义、launchd `ProgramArguments` 使用，两端匹配。
   - `com.andy.magpie-tunnel`：文件名、`Label`、`launchctl list | grep magpie-tunnel` 三者匹配。
   - `MAGPIE_WEB_KEY`：这是最像 I-73 的一处。产生方声称是 Magpie 源码，使用方是 `/etc/magpie/web.env`；但生产是旧版本，仓库没有源码可核对，`grep` 又只列名字。文档没有证明生产版本真的读这个键。建议不要断定键名，或把「先列变量名、再核对生产二进制/服务环境」写成必须步骤。
   - `/usr/local/bin/magpie` vs `/opt/magpie/v0.1.2001/magpie`：文档已承认未核实并用 `readlink -f` 兜底，处理正确，但两端仍未真正核对。
   - `/etc/magpie/web.env`：systemd 读取、文档只读变量名，方向对；文件权限未检查。
   - URL `?k=<密码>`：产生方是 env 里的密码，使用方是浏览器和 Magpie；编码列表不完整（见发现 4）。
   - `UseKeychain` / `--apple-use-keychain`：使用方是 Apple ssh/ssh-add；launchd 用 `/usr/bin/ssh` 没问题，一次性命令用裸 `ssh` 可能在 Homebrew OpenSSH 上失败（见发现 5）。
   - `ExitOnForwardFailure`、`--noproxy '*'`、`launchctl load/unload`：语法和用途都成立；`launchctl load` 虽已弃用但仍可用。
   - 结论：端口、别名、Label、curl 选项两端一致；真正未核实的两端是 `MAGPIE_WEB_KEY`/env 文件和安装路径，主要兼容性缺口是 URL 编码与 Apple ssh。没有发现 I-73 那种「清单 id 过不了后端校验」的同类硬错误，但存在同类的「生产端是否接受这个名字/路径」未验证问题。
