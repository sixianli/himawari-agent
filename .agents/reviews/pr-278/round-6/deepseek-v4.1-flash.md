评审范围：`git diff 7b549e3e..2d9451c`。除 `.agents/reviews` 复核记录外，产品改动只有 `docs/runbooks/production-server-access-runbook.md`（33 行）；`4212288..2d9451c` 的增量只新增第 4、5 轮复核记录，runbook 内容未再变化。

## 侧重检查

- **错误路径**：查了 `BatchMode=yes`、`KeepAlive`、`ThrottleInterval`、`ExitOnForwardFailure`、host key/口令、端口被占用、`curl` 返回 `000`/`401`。结论：自动连接的失败路径没有日志，见发现 2。
- **不合规范或不可信输入**：查了 `?k=` 的 URL 编码、`read -rs`、`grep` 只打印变量名、外部 GitHub `main` 链接。结论：编码写法可用；外部源码不可在本仓库核实；`grep` 命令本身不打印值。
- **安全**：查了回环监听、`ufw`、Cloudflare 隧道、cookie 作用域、`/etc/magpie/web.env` 权限、root SSH、浏览器历史/终端/剪贴板。结论：回环和防火墙方向正确；主要遗漏是密码文件权限和长期 cookie，见发现 3、4、5。
- **资源耗尽**：`KeepAlive` + 15 秒重试会在失败时无限重试；有 `ServerAliveInterval`，但没有 `ConnectTimeout`。影响不大，但失败会持续。
- **不可撤销操作**：管理页可立即改路由、账号、密钥；文档只引用授权规则，没有备份/回滚步骤，见发现 8。
- **规则与文档一致**：`prompt-prefix` 不涉及本次改动；`owner-standing-rules` 锚点存在；发现 ADR 0117、ADR 0142 与新段落不一致；runbook 契约不覆盖新依赖；没有自动检查，见发现 1、6、7。

## 发现（按严重度）

### 1. 中 — Hermes 有 Magpie 管理页的说法与仓库现有文档冲突，且没有仓库内证据

`docs/runbooks/production-server-access-runbook.md:183`

问题：新段落写“Hermes 测试环境的 Magpie 管理页也用 3430”，并让用户为连 Hermes 先停生产隧道。但仓库里最近的相关记录说 Hermes 上没有 Magpie。

证据：

- 新段落：`Hermes 测试环境的 Magpie 管理页也用 3430。要连 Hermes 时先 launchctl unload 生产隧道……`
- `docs/adr/0142-keep-background-memory-capture.md:69`：`模型是网关上的 DeepSeek，不是生产 Magpie 背后的来源；Hermes 上没有 Magpie，无法在那里测。`
- `docs/engineering-casebook.md:4994`：`在生产机上用 Magpie 测：Hermes 上没有 Magpie，改走网关。`

这可能是 2026-10-31 之后 Hermes 新装了 Magpie，但仓库没有任何对应记录或现场输出。若说法不实，会误导用户停掉生产隧道并去找一个不存在的管理页。

建议：在 Hermes 上实际核对 `systemctl cat magpie.service` / `ss -ltnp` 后，把日期和输出写进文档；或者删掉这段 Hermes 说明。若 Hermes 确实新装了 Magpie，应同时更新 ADR 0142 和案例库里的旧结论，避免两份文档互相矛盾。

### 2. 中 — “开机自动连接”没有给出可直接使用的 launchd plist，失败时也没有日志

`docs/runbooks/production-server-access-runbook.md:174-175`

问题：作者说“按文中的 ~/.ssh/config + launchd plist 配好后”成功，但文档只描述了 plist 的字段，没有给出完整 XML，也没有 `ProgramArguments`、`StandardOutPath`、`StandardErrorPath`。`BatchMode=yes` 下 host key 未确认、口令未进钥匙串、3430 被占用等错误都不会显示，用户只能看到进程反复退出。

证据：

- `:174`：`~/Library/LaunchAgents/com.andy.magpie-tunnel.plist 让 macOS 的 launchd……运行 /usr/bin/ssh -N -o BatchMode=yes magpie-prod，Label 为 com.andy.magpie-tunnel，设 RunAtLoad、KeepAlive 为真，ThrottleInterval 为 15 秒`
- `:175`：`启用：launchctl load ……看状态：launchctl list | grep magpie-tunnel，第一列是进程号，第二列是上次退出码。`
- 项目现有脚本 `scripts/disk-hygiene/install-schedule.sh:50-66` 反而给出了完整 plist，并设置 `StandardOutPath`/`StandardErrorPath`，使用 `launchctl bootout`/`launchctl bootstrap "gui/$(id -u)"`。

建议：在 runbook 中给出完整 plist（`Label`、`ProgramArguments`、`RunAtLoad`、`KeepAlive`、`ThrottleInterval`、标准输出/错误日志路径），并改用项目现有的 `launchctl bootstrap/bootout gui/$(id -u)` 写法。补充排障：`launchctl print gui/$(id -u)/com.andy.magpie-tunnel`、日志文件路径、首次 host key 如何确认、`ssh-add --apple-use-keychain` 应在加载 LaunchAgent 之前运行。这样“开机自动连接”才是可复现的。

### 3. 中（潜在高）— 密码文件 `/etc/magpie/web.env` 的权限没有被检查，而生产机上有一个无 sudo 的普通测试账号

`docs/runbooks/production-server-access-runbook.md:165`

问题：文档写管理页密码来自 `/etc/magpie/web.env`，只教用户用 `grep` 看变量名，却没有检查文件权限。生产机上存在普通账号 `himawari-ci`（uid 1001，无 sudo）；如果该文件是安装脚本按默认 umask 生成的 `0644`，这个账号就能读到生产管理页密码，进而改路由组、查看全部密钥。systemd 以 root 读 `EnvironmentFile`，文件本来可以设成 `0600`，但文档没有要求核对。

证据：

- `:165`：`生产服务里这个变量应该来自 /etc/magpie/web.env，但文件内容没有读过；用 ssh root@84.247.157.41 "grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' /etc/magpie/web.env" 只看变量名……不显示值。`
- `.agents/instructions/test-and-production-hosts.md:9`：`……在云服务器 84.247.157.41 上以普通账号 himawari-ci（uid 1001，无 sudo）……`
- 同一行还规定测试账号“绝不读取生产机密”，但这是行为约束，不是文件权限。

建议：在该段增加只读检查，例如 `stat -c '%a %U:%G' /etc/magpie/web.env`、`namei -l /etc/magpie/web.env`，并确认 `himawari-ci` 不可读（如 `sudo -u himawari-ci test -r /etc/magpie/web.env; echo $?` 应为非零）。要求 `0600 root:root` 或至少 `root:magpie`。若现状不是这样，应作为生产配置变更交给 Andy 授权后修正。

### 4. 中低 — 生产密码被放进保留 400 天的浏览器 cookie，且 cookie 按主机名共享到所有 `127.0.0.1` 端口；文档只靠“用单独浏览器”约束

`docs/runbooks/production-server-access-runbook.md:165,178`

问题：文档已经正确指出 cookie 里就是生产密码、不看端口，但给出的主要缓解是“生产管理页用一个单独的浏览器（或单独的浏览器用户），这个浏览器里不打开别的本机页面”。这是行为约束，不是技术隔离；而且文档明确建议“不要用无痕窗口”，进一步把生产密码长期留在浏览器里。密码还可能在终端回显、剪贴板、浏览器会话恢复、浏览器同步和服务端访问日志里留下副本，文档只提了删浏览器历史。

证据：

- `:165`：`常驻的管理页从环境变量 MAGPIE_WEB_KEY 取固定密码……固定密码时保留 400 天`
- `:178`：`这个 cookie 里就是生产密码，同一个浏览器打开任何 http://127.0.0.1:<端口>/ 的页面都会把它发过去；所以生产管理页用一个单独的浏览器（或单独的浏览器用户），这个浏览器里不打开别的本机页面。` 同段还有“不要用无痕窗口，关窗后 cookie 就没了”。

建议：优先给出技术隔离方案，例如为生产转发使用一个不同的回环地址（如 `127.0.0.2:3430`，需先在 macOS 上确认可用）或不同的主机名，使 cookie 不再与 `127.0.0.1` 上其它服务共享；或者至少把“每次用独立隐私窗口登录、退出时清站点 cookie”作为安全选项写清楚。补充提示：`read -rs` 之后的 Python 输出会带编码后的密码，需清理终端回滚缓冲和剪贴板；如果 Magpie 记录请求 URL，还应检查并清理服务日志。另建议给出退出/清 cookie 的步骤，而不是只依赖固定密码 400 天。

### 5. 低 — “只监听回环就公网连不到”的论证漏掉了本机反向隧道（cloudflared）

`docs/runbooks/production-server-access-runbook.md:163`

问题：段落用 `ss` 看到两个回环端口和 `ufw` 只放行 22，就断言“公网连不到”。但同一台生产机上有 `cloudflared`，它从服务器主动向外连，可以不经过 `ufw` 入站规则，把本机任意端口接到公网。仓库文档目前说该隧道只转到 `127.0.0.1:8400`，所以现状大概率没问题；但新段落没有引用或复核这一点，读者无法知道这个结论还依赖隧道 ingress。

证据：

- 新段落：`两者都只在回环地址上，公网连不到，防火墙也只放行 22。`
- `docs/runbooks/production-web-entry-runbook.md:61`：`himawari.siyi.win 经隧道 himawari-prod……转到生产机 http://127.0.0.1:8400。`
- `docs/adr/0099-production-host-firewall-ssh-only.md:29`：`cloudflared……只监听本机`，以及隧道是服务器主动连出。

建议：在该段补一句“现有 Cloudflare 隧道只回源到 8400，见生产网页入口 Runbook”，并给出变更时的复核方法（检查 `cloudflared` 的 ingress/DNS 路由，确保没有把 3430 接到公网）。不要把“回环 + ufw”当成完整的公网隔离证明。

### 6. 低 — ADR 0117 的“只监听 3425”与新段落的“3425 和 3430”没有对齐

`docs/runbooks/production-server-access-runbook.md:162-163`；`docs/adr/0117-magpie-routes-models-through-owned-subscriptions.md:38`

问题：作者核对了 ADR 0117 的程序安装路径差异，并诚实标注 `/usr/local/bin/magpie` 与 `/opt/magpie/v0.1.2001/magpie` 的关系未核实，这一点处理得好；但没有处理 ADR 0117 的端口描述。ADR 说“只监听 `127.0.0.1:3425`”，新段落说同一进程还监听 `127.0.0.1:3430`。这可能只是“安装时只有 3425，后来开了管理页”，但文档没有说明。

证据：

- ADR 0117:38：`……系统服务 magpie.service，专用用户 magpie，只监听 127.0.0.1:3425……`
- 新段落:162-163：`ExecStart=/usr/local/bin/magpie serve --web=127.0.0.1:3430`、`Environment=MAGPIE_ADDR=127.0.0.1:3425`；`ss -ltnp` 显示同一进程监听 `127.0.0.1:3425` 和 `127.0.0.1:3430`。

建议：在 ADR 0117 的 2026-10-29 安装记录后加一句“当时只有模型接口 3425，管理页 3430 是后来开启的”，或在 runbook 中说明这是 2026-11-02 的现场状态，与 ADR 的安装时记录不矛盾。避免读者以为两份文档必有一份错误。

### 7. 低 — 这次改动没有对应的自动检查，runbook 契约也不覆盖新增的 ADR 0117 依赖

`docs/runbooks/production-server-access-runbook.md:10-14`；`package.json:27,93`

问题：这次是纯文档改动，仓库里没有任何测试会执行或解析新增的 SSH/launchd 命令，也没有反向用例。文档头部 `runbook-contract` 只列了 ADR 0056、BL-20261021-009、ADR 0099，不包含 ADR 0117；因此 ADR 0117 或 Magpie 管理页事实变化时，`contract_sha256` 不会报警。`check:instruction-links` 只检查 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions` 这些根，不检查 runbook。

证据：

- `package.json:27` 的检查清单；`:93`：`"check:instruction-links": "node scripts/check-instruction-links.mjs"`
- `scripts/check-instruction-links.mjs:7-12` 的 `INSTRUCTION_ROOTS` 只有 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`。
- `.agents/instructions/document-governance.md:29`：改 `docs/` 的提交要**手动**运行技能里的 `validate_docs.py . --strict`。

建议：至少把 runbook 的 Markdown 链接/锚点纳入现有检查，或为这类“连接步骤”增加可执行的反向用例（例如解析文档中的 ssh 配置/plist 并校验语法，或检查 Hermes 说法与 ADR 0142 是否一致）。若短期做不到，应在交付说明里明确“本次没有自动检查，只有 Andy 的一次 401 手工验证”。

### 8. 低 — 管理页改动是立即生效的生产变更，但文档没有备份/回滚步骤

`docs/runbooks/production-server-access-runbook.md:182`

问题：段落正确指出改路由组、账号或密钥会立即影响线上调用，并链接到 Andy 的授权规则；但没有要求在改之前备份 Magpie 配置或 `/etc/magpie/web.env`，也没有说明改坏了怎么恢复。ADR 0117 里已有生产机配置备份的先例（`/root/config-backups/...`）。

证据：

- `:182`：`在管理页里改的路由组、账号或密钥立即影响线上对话，算生产配置变更，按授权、上线和合并处理。`
- `docs/adr/0117-...md:160`：`改前的配置备份在生产机 /root/config-backups/magpie-providers.json.before-codebuddy-first-...`

建议：在该条后面补一句：改动前复制 `/etc/magpie/web.env` 和 Magpie 的 providers 配置到带时间戳的备份目录，记录恢复方法；删除账号/密钥这类不可逆操作按“会删东西”的授权流程处理。

## 推测 / 未核实

- `MAGPIE_WEB_KEY`、`?k=<密码>`、固定密码 cookie 保留 400 天、跳转行为：文档引用的是 GitHub `yetone/magpie` 的 `internal/gui/web.go`，本仓库没有 Magpie 源码，无法核实。
- `/usr/local/bin/magpie` 与 `/opt/magpie/v0.1.2001/magpie` 的关系：文档自己已标注未核实，处理正确。
- `systemctl cat`、`ss -ltnp`、`curl` 返回 401 的原始输出：仓库里只有文字转述，没有原始记录。
- macOS 上 `UseKeychain yes`、`AddKeysToAgent yes`、`ssh-add --apple-use-keychain` 的实际行为：语法看起来符合 macOS OpenSSH，未在 macOS 执行。
- `/etc/magpie/web.env` 的实际权限和属主：未核实；发现 3 是“缺少检查”，不是已确认的文件是 0644。
- Hermes 上是否真的有 Magpie 管理页：未核实，且与 ADR 0142 冲突。
- `cloudflared` 实际 ingress 是否只有 8400：仓库文档如此写，服务器当前配置未核实。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次产品改动只新增 `docs/runbooks/production-server-access-runbook.md` 的一节，没有改系统提示、工具定义、历史消息、遮盖代码或任何请求组装逻辑。该 runbook 不在 `packages/prompt-catalog` 里，也没有被自动注入 prompt；它只在有人打开文档时被读取，不是模型请求的开头。

发给模型的内容仍然遵守“只在末尾追加”：这份改动没有新增每轮变化的值，也没有改追加顺序。新增的 `2026-11-02`、`3430`、`127.0.0.1`、`/etc/magpie/web.env` 都是静态字面量。依据 `.claude/rules/prompt-prefix.md#rules` 第 1-5 条和第 10-11 条。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 改动没有新的序列化代码、时间字段、随机值、无序集合或依赖前后文的遮盖。文档里出现的日期是静态文本；没有“当前时间”“本轮记忆”这类每轮变化的值。只要文件内容相同，读出来的文字就相同。唯一与运行环境有关的是“2026-11-07 的 main”这种外部链接说明，但它不会在请求生成时被求值。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**没有针对这次改动的自动检查，也没有反向用例。** 仓库的 `check:instruction-links` 只覆盖指令文件，不覆盖 runbook；`check:markdown-tables`、`check:adr-numbers`、`check:secrets` 等也不验证 SSH/launchd 命令或文档中的事实。`validate_docs.py --strict` 是外部技能脚本，需要手动运行，且只做文档结构/链接校验，不验证命令语义。runbook 的 `contract_sha256` 只覆盖 ADR 0056、BL-20261021-009、ADR 0099 三个源文件；这三者本次没变，所以封存不会因这次改动失效，但也就不会发现新段落与 ADR 0142/ADR 0117 的矛盾。若要反向用例，例如“文档声称 Hermes 有 Magpie，但 ADR 0142 说没有”这样的检查现在不存在，因此无处可失败。

### 4. 每个值的产生处和使用处两端都能接受吗？

逐个核对：

- **`127.0.0.1:3430`**：产生处是文档转述的 `systemctl cat` / `ss`；使用处是 `ssh -L 127.0.0.1:3430:127.0.0.1:3430`、`LocalForward 127.0.0.1:3430 127.0.0.1:3430`、`curl http://127.0.0.1:3430/` 和浏览器地址。SSH 语法接受这个写法；文档内部一致。但仓库里没有独立证据证明 3430 存在，ADR 0117 只记录了 3425，**两端没有都核实**。
- **`MAGPIE_WEB_KEY`**：产生处是外部 Magpie 源码和 `/etc/magpie/web.env`；使用处是管理页登录和 cookie。仓库没有源码或配置，无法验证变量名、`?k=` 参数名和 cookie 行为，**未核实**。
- **`/etc/magpie/web.env`**：产生处是 systemd `EnvironmentFile`；使用处是文档里的 `grep` 命令。命令的 `^[A-Za-z_][A-Za-z0-9_]*=` 能打印常规 `NAME=value` 行的变量名，但文件权限没有被检查；如果文件对 `himawari-ci` 可读，密码就泄露，见发现 3。
- **`magpie-prod` 和 `com.andy.magpie-tunnel`**：产生处是文档；使用处是 `~/.ssh/config` 的 `Host`、plist 的 `Label`、`launchctl list | grep magpie-tunnel`。文件名和 Label 在文档里一致，但文档没有给出完整 plist，无法验证 `Label` 是否真的写入、`ProgramArguments` 是否真的使用 `magpie-prod`，**有一端缺失**。
- **`400 天`**：只用于解释 cookie 寿命，没有程序消费，**外部源码未核实**。
- **`401`**：产生处是管理页；使用处是人的验证步骤。它能说明“有 HTTP 服务回 401”，但严格说不能单独证明“就是 Magpie”，因为远端 3430 上若有别的服务也可能回 401；不过结合 `ss` 输出和隧道，这个假设合理。
- **`group/himawari-main`**：来自 ADR 0117，使用处是文档说明“当前顺序以管理页为准”，两端一致。
- **`UseKeychain` / `AddKeysToAgent` / `--apple-use-keychain`**：产生处是文档，使用处是 macOS SSH/ssh-add；语法看起来正确，但**未在 macOS 执行验证**。
- **`84.247.157.41` / `22/tcp`**：来自 runbook 和 ADR 0099，使用处是 SSH 和防火墙说明，和现有文档一致。

整体结论：文档方向正确，回环、防火墙、授权边界的写法基本符合现有规则；但合并前建议至少处理 **Hermes 说法与 ADR 0142 的冲突**、**`/etc/magpie/web.env` 权限检查**、**完整可复现的 launchd plist 和日志**。其余（长期 cookie、cloudflared ingress 证据、ADR 0117 端口说明、无自动检查、无备份步骤）可作为后续改进。
