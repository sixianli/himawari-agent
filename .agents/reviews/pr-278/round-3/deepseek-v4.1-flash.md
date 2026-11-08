## 结论摘要

本次改动只涉及文档：`git diff --name-status f047…HEAD` 显示除 `.agents/reviews` 记录外，实际代码改动只有 `docs/runbooks/production-server-access-runbook.md` 一处（33 行新增；`6528…HEAD` 只有 1 行替换）。没有改动提示词、工具定义、历史、遮盖或任何模型请求组装代码，因此必答问题 1、2 的答案都是“不会改变”。问题集中在 Mac 端连接步骤的事实错误、同一 `127.0.0.1` 下 cookie 的跨环境泄漏、密码进 URL 的留存风险，以及 Hermes 相关说法与现有文档矛盾。

---

## 一、读代码/仓库证实的

### 1. 【中高】`docs/runbooks/production-server-access-runbook.md:183`（配合 `:165`、`:178`）：生产与 Hermes 共用 `127.0.0.1` 的 cookie，生产凭据会发给 Hermes

证据（我亲自读到）：

- 第 165 行：“浏览器第一次用 `?k=<密码>` 打开时，页面核对后把密码存进一个只给本站用的 cookie（……固定密码时保留 400 天）”
- 第 183 行：“Hermes 测试环境的 Magpie 管理页也用 3430。……两边的 cookie 都存在 `127.0.0.1` 名下，切换后可能要重新用 `?k=` 登录。”

问题：浏览器 cookie 按主机和路径隔离，**不按端口隔离**。所以即使把 Hermes 换到 3431，`127.0.0.1` 名下的生产 cookie 仍会随请求发给 Hermes 页面。按文档自己的说法，这个 cookie 里存的是固定密码；那么 Hermes 页面或其日志会收到生产管理页的凭据。文档只写了“可能要重新登录”，没有指出这个泄漏方向。

建议：不要依赖“不同端口”隔离 cookie。用不同主机名（例如生产 `127.0.0.1`、Hermes 用 `localhost`，或为两者建不同的 `/etc/hosts` 别名）让 cookie 真正分开；切换前清除 `127.0.0.1` 的 cookie；并在文档里写明“Hermes 会收到生产 cookie”这一事实。若 Magpie 支持表单或请求头登录，优先用不带 `?k=` 的方式。

### 2. 【中】`docs/runbooks/production-server-access-runbook.md:169`：一次性 `ssh -L` 不会因 3430 被占用而“失败”

证据：

- 第 169 行：“下面的自动连接已经在运行时不要再开这一条，它会因本机 3430 已被占用而失败。”
- 第 173 行：`ExitOnForwardFailure yes` 只写在 `Host magpie-prod` 块里。

问题：这条一次性命令用的是 `root@84.247.157.41`，不会匹配 `Host magpie-prod`，因此 `ExitOnForwardFailure yes` 不生效。OpenSSH 默认 `ExitOnForwardFailure=no`：本地端口被占用时，它会打印 `bind: Address already in use` / `Could not request local forwarding`，然后**继续打开交互式 shell**，只是转发没建立。读者会以为命令失败并退出了，实际留下一个已登录生产 root 的窗口。

建议：一次性命令也加上 `-o ExitOnForwardFailure=yes`，并加 `-N`（只做转发，不打开生产 root shell），例如 `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3430:127.0.0.1:3430 root@84.247.157.41`。同时把第 183 行“后开的那条会因 `ExitOnForwardFailure` 直接退出”改成条件句，因为只有走该配置块时才成立。

### 3. 【中】`docs/runbooks/production-server-access-runbook.md:178`（配合 `:165`）：密码经 `?k=` 进入浏览器历史、同步和代理，400 天 cookie 无登出/轮换步骤

证据：

- 第 178 行：“浏览器打开一次 `http://127.0.0.1:3430/?k=<密码>`，跳转后地址栏不再带密码；把这个不带密码的 `http://127.0.0.1:3430/` 存成书签。之后 cookie 有效期内直接点书签就能进……”
- 第 165 行：“固定密码时保留 400 天”。

问题：即使页面跳转后去掉了 `k`，带密码的初始 URL 通常仍会进入浏览器历史（以及可能的 iCloud/账号同步、剪贴板、截图、If the Mac's browser uses a proxy，请求也可能带着密码去代理）。文档只警告“不要存进书签”，没有覆盖这些留存路径。400 天固定密码 cookie 也没有“如何登出 / 清 cookie / 轮换”的说明。

建议：明确要求用无痕窗口登录，登录后清除该 URL 的历史；确认浏览器对 `127.0.0.1` 绕过代理；补充“登出 = 清除 `127.0.0.1` 的 cookie”和“疑似泄漏时轮换 `MAGPIE_WEB_KEY` 并重启 `magpie.service`（生产配置变更，需授权）”。如果 Magpie 源码可改，优先支持 POST 或请求头登录，避免密码进 URL。

### 4. 【中】`docs/runbooks/production-server-access-runbook.md:160,182`：通过管理页改生产配置缺少备份、回退和审计步骤

证据：

- 第 182 行：“在管理页里改的路由组、账号或密钥立即影响线上对话，算生产配置变更，按[授权、上线和合并]……处理。”
- ADR 0117 第 160 行：“改前的配置备份在生产机 `/root/config-backups/magpie-providers.json.before-codebuddy-first-20261029T160404Z`。”

问题：文档正确指出了“需要授权”，但没写改前备份、改后记录、回退办法。管理页删除账号/密钥或改路由组是没有 UI 撤销按钮的即时操作；ADR 0117 的先例是改前备份。只写“按授权规则”不足以让执行人知道具体动作。

建议：在“注意”里加一条可执行步骤：改前用只读方式导出/备份当前 Magpie 配置到 `/root/config-backups/`（文件名带 UTC 时间），记录改了哪个路由组/账号，写出回退办法；必要时重启 `magpie.service`。删除类操作另外先取得明确授权。

### 5. 【中】`docs/runbooks/production-server-access-runbook.md:183`：“Hermes 测试环境的 Magpie 管理页也用 3430”与现有文档矛盾且无仓库证据

证据（我亲自读到）：

- 第 183 行：“Hermes 测试环境的 Magpie 管理页也用 3430。”
- `docs/adr/0142-keep-background-memory-capture.md:69`：“……Hermes 上没有 Magpie，无法在那里测。”
- `docs/engineering-casebook.md:4994`：“在生产机上用 Magpie 测：Hermes 上没有 Magpie，改走网关。”

问题：仓库里 `3430` 只出现在这份 Runbook；ADR 0142（2026-10-31，active）和案例库都说 Hermes 上没有 Magpie。除非 2026-11-02 之后在 Hermes 新装了 Magpie，否则这条是错的；即使新装了，也没有任何 ADR/操作记录或验证命令支撑。它还会让第 176 行的 `curl` 验证失去区分力：如果生产隧道没开、Hermes 隧道开着，`401` 同样会通过，用户会误以为连的是生产。

建议：先核实 Hermes 是否真有 Magpie。没有就删掉这条；有就补安装记录/ADR 和验证命令，并用不同主机名区分两个环境（见第 1 条）。另外，`curl` 验证应增加能证明“这是生产 Magpie”的检查（例如对比一个已知的 Magpie 响应头或页面特征），不能只看 `401`。

### 6. 【中低】`docs/runbooks/production-server-access-runbook.md:174,184`：`KeepAlive` + 每 15 秒重试会无限循环，可能刷日志或触发服务器限流

证据：

- 第 174 行：“设 `RunAtLoad`、`KeepAlive` 为真，`ThrottleInterval` 为 15 秒；断线后自动重连。”
- 第 184 行：“SSH 密钥设了口令时，后台的 `ssh` 无法弹窗输入，会每 15 秒重试一次、一直连不上。”

问题：口令错误、钥匙串锁着、主机密钥变化、或本地 3430 已被一次性隧道占用时，`ssh` 立即退出，`KeepAlive` 会让 launchd 每 15 秒重启一次，长期不停。这会持续写系统日志，也可能触发服务器 sshd 的失败登录限制/fail2ban 一类机制。文档只描述了现象，没有给出“先验证一次再启用”的步骤。

建议：在启用 LaunchAgent 前先手动跑一次同一条 `ssh` 确认能连；在文档里写清“失败会每 15 秒重试”和如何 `launchctl unload` 停止；考虑用包装脚本在连接前检查本地端口和钥匙串，或限制重试次数/记录日志。

### 7. 【中低】`docs/runbooks/production-server-access-runbook.md:173-174`：后台 ssh 没指定 `IdentityFile`，也没处理首次 host key

证据：

- 第 173 行配置只有 `HostName`、`User`、`LocalForward`、保活、`ExitOnForwardFailure`、`AddKeysToAgent`、`UseKeychain`，没有 `IdentityFile`。
- 第 174 行使用 `-o BatchMode=yes`。

问题：如果 Mac 上的生产密钥不是默认文件名（`id_rsa`、`id_ed25519` 等），也不在 ssh-agent 里，后台 `ssh` 找不到密钥。`BatchMode=yes` 又禁止 host key 确认提示，首次连接或主机密钥变化时会静默失败，然后进入第 6 条的 15 秒循环。

建议：在 `Host magpie-prod` 里加 `IdentityFile ~/.ssh/<实际私钥>`；先手动 `ssh magpie-prod true` 接受 host key；在验证步骤加“查看 launchd 日志或 `ssh -G magpie-prod` 确认实际使用的密钥/端口”。

### 8. 【低】`docs/runbooks/production-server-access-runbook.md:174-175`：只描述了 plist 字段，没有给完整 plist；`launchctl load` 在新 macOS 已弃用

证据：第 174 行用文字描述 `Label`、`RunAtLoad`、`KeepAlive`、`ThrottleInterval` 和 `ProgramArguments`，但没有可复制的 XML；第 175 行用 `launchctl load` / `unload`。

问题：读者要自己拼 plist，容易漏掉 `ProgramArguments` 数组、权限等；`launchctl load` 在较新 macOS 上仍可用但已弃用，`bootstrap`/`bootout` 是现行写法。不是错误，但作为“critical”Runbook 不够可复制。

建议：附完整 plist 示例（含 `ProgramArguments` 五段），并给出 `launchctl bootstrap gui/$(id -u) …` / `launchctl bootout gui/$(id -u)/com.andy.magpie-tunnel` 的现代写法，同时注明旧写法的兼容性。

### 9. 【低】`docs/runbooks/production-server-access-runbook.md:165`：`grep` 命令实际打印“变量名=”，且漏掉前导空白/`export` 形式

证据：第 165 行：“`grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' /etc/magpie/web.env` 只看变量名（只打印等号前的名字，注释行不打印）”。

问题：`-o` 打印的是匹配部分，包含结尾的 `=`，所以输出是 `MAGPIE_WEB_KEY=`，不是“只打印等号前的名字”。另外，正则锚定 `^`，不匹配前导空白的 `  KEY=`，也不匹配 `export KEY=`。好消息是这些都不会泄漏值；只是描述和覆盖面不精确。

建议：把文字改成“打印变量名和等号”；如果坚持只打印名字，用 `sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'`，或先 `grep '='` 再 `cut -d= -f1`。更稳妥的是让运维人员直接看 `systemctl show magpie -p Environment` 或 `systemd-analyze`，但要注意 `systemctl show` 可能显示值，需脱敏。

### 10. 【低】`docs/runbooks/production-server-access-runbook.md:162`：`/usr/local/bin/magpie` 与 ADR 0117 的 `/opt/magpie/v0.1.2001/magpie` 仍未解决，`readlink -f` 不足以证明运行中的二进制

证据：

- 第 162 行：“`ExecStart=/usr/local/bin/magpie …`；ADR 0117 记的是……`/opt/magpie/v0.1.2001/magpie`；`/usr/local/bin/magpie` 和它是什么关系……没有核实，以服务器上 `readlink -f /usr/local/bin/magpie` 的输出为准。”
- ADR 0117 第 38 行：“版本 v0.1.2001，`/opt/magpie/v0.1.2001/magpie`。”

问题：文档诚实记录了矛盾，但没有解决。`readlink -f` 只显示当前符号链接目标，不证明 Magpie 服务进程实际运行的是那个文件（服务启动后符号链接可能被改过）。如果运行的是另一个版本，文档里基于“生产是更早版本”的登录行为判断也会变。

建议：用 `pgrep -x magpie` 找到 PID，再读 `readlink -f /proc/<pid>/exe`，或 `ls -l /proc/<pid>/exe`，确认实际运行文件；把结果写回 Runbook，并说明 `/opt` 路径与 `/usr/local/bin` 的关系。若无法确认，明确写“未核实，不可依赖版本相关行为”。

### 11. 【低】`docs/runbooks/production-server-access-runbook.md:5,13-17`：正文改动不受 `contract_sha256` 保护，新增内容依赖 ADR 0117 但未进契约清单

证据：

- 第 5 行：`contract_sha256: "sha256:f361…"`
- 第 13-17 行契约清单只有 ADR 0056、BL-20261021-009、ADR 0099，没有 ADR 0117。

问题：按 `docs/lessons.md:159` 的说法，`runbook.py seal` 计算的是契约源文件的摘要，不包含 Runbook 正文。所以这次新增正文不会让封存失效；反过来，正文里对 ADR 0117 的引用也不会在 ADR 0117 变化时被发现。这不是本次改动引入的 bug，但和本次新增内容直接相关。

建议：如果希望“ADR 0117 改了要提醒更新 Runbook”，把 ADR 0117 加进 `runbook-contract` 清单，并在完整模式下复核后 reseal；否则在交付说明里明确“正文不受 seal 保护，靠人工复核”。

### 12. 【低】`docs/runbooks/production-server-access-runbook.md:178`：`?k=<密码>` 未说明 URL 编码，密码含 `+`、`&`、`#`、`%` 时会解析错误

证据：第 178 行直接写 `http://127.0.0.1:3430/?k=<密码>`。

问题：查询参数里的 `+` 常被解析成空格，`&` 会截断参数，`#` 会变成 fragment，`%` 会触发百分号解码。如果 `MAGPIE_WEB_KEY` 是 base64 一类字符串，登录可能失败或发出错误的值。仓库里没有密钥格式证据，所以这是条件性风险。

建议：文档里说明“如密码含 URL 特殊字符，先做百分号编码再放进 `?k=`”；或确认 `MAGPIE_WEB_KEY` 只使用 URL 安全字符（十六进制/字母数字）。最好在源码允许时改用表单/请求头。

---

## 二、推测与未核实

以下内容无法从仓库代码核实，我按材料性质标为推测/未核实，不当作已证实的缺陷：

1. **【中】`docs/runbooks/production-server-access-runbook.md:165` 的 Magpie 源码行为**：`MAGPIE_WEB_KEY`、`?k=` 登录、cookie 400 天、跳转去 `k`，都来自 `yetone/magpie` 的 `main` 分支（2026-11-07），仓库没有 Magpie 源码，无法离线核对。文档自己也说“生产装的是更早的版本，源码描述只作参考”。作者的说法不能视为已证实；建议在服务器上用只读方式验证（401、`Set-Cookie` 属性、重定向目标），并记录具体版本/提交，而不是只写 `main`。
2. **【中】`docs/runbooks/production-server-access-runbook.md:162-163` 的现场输出**：`systemctl cat` 和 `ss -ltnp` 的内容来自 Andy 口述，仓库没有原始输出。`3430` 在仓库中只出现在这份 Runbook。建议把 2026-11-02 的脱敏原始输出存进 handoff/evidence，或在交付说明里给出处。
3. **【中】`docs/runbooks/production-server-access-runbook.md:183` Hermes 的存在性**：见第 5 条，与 ADR 0142、案例库矛盾，需核实。
4. **【低】第 169 行的“会失败”**：具体取决于用户全局 `ssh_config` 是否有 `Host *` 的 `ExitOnForwardFailure yes`；默认不失败。见第 2 条。
5. **【低】`/etc/magpie/web.env` 的变量名是否真是 `MAGPIE_WEB_KEY`**：文档只说“应该来自”，需实际运行第 165 行的 `grep` 确认。
6. **【低】cookie 是否包含明文密码、是否 `HttpOnly`/`SameSite`**：仓库无源码，未核实。如果包含明文密码，第 1 条的跨环境泄漏更严重。
7. **`.agents/reviews/pr-278/round-2/*` 我未能读取**：工具拒绝访问该记录路径，`git show` 也被拒绝。本次结论不依赖这些文件；但建议确认这些复核记录里没有出现真实密码或 `?k=` 实际值。

---

## 三、侧重检查

我按你的侧重逐项查了这些路径：

- **公网暴露/回环**：第 163、167、169、173 行都只绑 `127.0.0.1`，没有 `0.0.0.0` 或公网开放建议；与防火墙第 143 行“只放行 22/tcp”一致。**通过**。
- **密钥内容**：新增段落没有出现任何密钥值；第 165 行的命令只输出变量名（和 `=`）。按 `scripts/scan-machine-secrets.mjs` 的规则阅读（未实际运行），`MAGPIE_WEB_KEY` 不匹配 `credential-assignment` 的 `password|api_key|...` 模式，`?k=<密码>` 也不匹配。**未发现写死密钥**。
- **错误路径**：一次性 `ssh` 的端口占用行为描述错误（第 2 条）；`BatchMode` 下口令/ host key 失败会静默重试（第 6、7 条）；`curl` 的 `401` 不能区分生产与 Hermes（第 5 条）。
- **不可信/不合规范输入**：`grep` 正则对前导空白/`export` 漏报（第 9 条）；`?k=` 未做 URL 编码（第 12 条）；外部源码声明未核实（推测 1）。
- **资源耗尽**：`KeepAlive` + 15 秒重试可能无限循环（第 6 条）；常驻 root SSH 隧道和 400 天 cookie 扩大了 Mac 失守后的影响面（第 1、3 条）。
- **不可撤销操作**：管理页可即时改路由/账号/密钥，文档只写“需授权”，没写备份/回退/审计（第 4 条）。
- **规则与文档一致**：ADR 0117 的安装路径矛盾被文档承认但未解决（第 10 条）；Hermes 有 Magpie 的说法与 ADR 0142/案例库矛盾（第 5 条）；Runbook 正文不受 `contract_sha256` 保护（第 11 条）；`docs/runbooks` 被 `check:glossary` 豁免，新增内容没有表格，`check:markdown-tables` 不会报错；新链接的锚点 `#authorization-deploys-and-merges` 和 ADR 0117 文件都存在，`check:instruction-links` 也不扫描 `docs/` 到 `.claude` 的链接，所以不会拦下。
- **模型请求**：`git diff --name-status` 只有文档和复核记录；仓库里没有把 `docs/runbooks` 读进 `prompt-catalog` 的路径（我查了 `scripts/`、`packages/`、`apps/` 的相关引用）。**模型请求前缀不受影响**。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次改动只改 `docs/runbooks/production-server-access-runbook.md`（和 `.agents/reviews` 记录），没有碰系统提示、工具定义、历史消息、遮盖代码或任何请求组装路径。`git diff --stat f047…HEAD -- . ':(exclude).agents'` 只有这份 Runbook。按 `.claude/rules/prompt-prefix.md` 的第 4 条，已发内容只能末尾追加；本次改动没有触及这个机制。发给模型的内容是否仍“只在末尾追加”、每轮会变的值是否“都在最后一条消息里”，属于现有实现，本次未重新验证（不在改动范围）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 没有序列化、遮盖、时间字段或集合排序的代码改动；新增的 `grep`/`ssh`/`launchd` 命令和 URL 都不是模型请求的一部分。仓库里也没有发现把 Runbook 正文嵌入提示词的路径，因此不存在文档字节影响模型请求字节的问题。

### 3. 有没有对应的自动检查？反向用例会失败吗？

**没有。** 仓库没有针对 Runbook 命令正确性的自动检查：

- `check:glossary` 明确豁免 `docs/runbooks/`（`scripts/check-glossary.mjs:21`）。
- `check:markdown-tables` 只查表格；新增内容没有表格。
- `check:secrets` 只按固定模式扫密钥；本次段落不含密钥格式，按规则不会报。
- `check:instruction-links` 只扫描 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`，不扫描 `docs/` 内的链接。
- `package.json` 的 `check:steps` 里没有已删除的 `check:docs`；`validate_docs.py` 属于仓库外技能，且只查 frontmatter/链接/封存，不验证 SSH/launchd 命令。
- `runbook.py seal` 只算契约源文件摘要；本次三个契约文件没变，正文改动不会让 seal 失败。

上一轮把 `cut -d= -f1` 改成 `grep -oE ...` 这件事本身说明：之前的命令问题没有任何自动检查发现。**反向用例不存在**，也不会失败。建议至少加一个小型 fixture 测试，断言“变量名命令在含 `MAGPIE_WEB_KEY=secret` 的样本上只输出名字，不输出 secret”，并对文档里的 shell 片段做语法检查；否则这类错误只能靠人工复核。

### 4. 每个新增/修改的值，两端都能接受吗？

逐项核对如下：

| 值 | 产生处 | 使用处 | 核对结果 |
| --- | --- | --- | --- |
| `84.247.157.41` | 全文既有 | 新 SSH/防火墙/ADR | 一致 |
| `127.0.0.1:3425` | 新 `MAGPIE_ADDR` | ADR 0117 的 `baseUrl: http://127.0.0.1:3425/v1`、代码测试 | 一致 |
| `127.0.0.1:3430` | 新 `--web` | SSH `LocalForward`、浏览器、curl | 文档内部一致；仓库其他文件无此值，现场未核实 |
| `/usr/local/bin/magpie` | 新 `ExecStart` | 第 162 行 `readlink -f` | 与 ADR 0117 的 `/opt/magpie/v0.1.2001/magpie` 矛盾，文档已承认未解决 |
| `/etc/magpie/web.env` | 新 `EnvironmentFile` | 第 165 行 `grep` | 变量名是否 `MAGPIE_WEB_KEY` 未核实 |
| `MAGPIE_WEB_KEY` | 外部源码声明 | 生产 env 文件、登录 URL | 仓库无源码；需要实际运行 `grep` 验证 |
| `group/himawari-main` | ADR 0117 | 新 Runbook 引用 | 一致 |
| `com.andy.magpie-tunnel` / `magpie-prod` | 新 Runbook | 新 Runbook | 内部一致 |
| `#magpie-admin` | 新导航项 | 新 `<a id>` | 一致 |
| `#authorization-deploys-and-merges` | 新链接 | `.claude/rules/owner-standing-rules.md` | 锚点存在，一致 |
| `../adr/0117-...md` | 新链接 | ADR 0117 | 文件存在，一致 |
| Hermes 3430 | 新 Runbook | — | **与 ADR 0142 第 69 行、案例库第 4994 行矛盾，仓库无证据** |

结论：文档内部的主要标识符（端口、IP、路由组、锚点、链接）两端一致；真正的问题是 **Hermes 相关值没有仓库依据**，以及 **`MAGPIE_WEB_KEY`/3430/`/usr/local/bin` 这些现场值没有可核对的记录**。如果按 I-73 的教训，仅看 diff 会漏掉“清单里的 id 能不能通过后端校验”这类跨端问题；这里对应的就是“文档写的环境/变量名，现场和现有文档能否接受”。建议在交付说明里把未核实的现场值逐项列出，并在服务器上做一次只读核对后再定稿。
