# 复核报告 PR-278 round 2（6528a69…）

先说核对的组织方式：这是纯文档改动（`git diff 446fe3e..6528a69` 只动 `docs/runbooks/production-server-access-runbook.md` 一处；`.agents/` 下的复核工件是 round 1 就加进去的，本轮未变），所以重点查三件事：文中命令/配置与仓库内其他文档是否矛盾、能核对到的每个值的两端、以及文档类改动有没有任何自动检查兜底。

## 侧重检查

我走的流程：以「Andy 从 Mac 连生产 Magpie 管理页」为普通使用流程，从入口走到结束——

1. 隧道入口 `ssh -L 127.0.0.1:3430:127.0.0.1:3430 root@84.247.157.41`（runbook:169）→ 2. 自动连接 `~/.ssh/config` 的 `Host magpie-prod` + LaunchAgent plist（runbook:173-175）→ 3. 验证 curl 401/000（runbook:176）→ 4. 浏览器 `?k=` 登录拿 cookie、存无密码书签（runbook:178）→ 5. 在管理页改配置 → 6. 按 owner-standing-rules 会被当成生产变更（runbook:182）。
- 走通的路：第 6 步的链接与锚点我逐一核实过——`../../.claude/rules/owner-standing-rules.md` 存在且锚点 `<a id="authorization-deploys-and-merges">` 存在（第 37 行）；`../adr/0117-...md` 存在。
- **没有仓库内测试覆盖的路径：全部。** ssh 命令、ssh config、launchd plist（`RunAtLoad`/`KeepAlive`/`ThrottleInterval`）、`launchctl list` 输出格式说明、`?k=` 登录流程、401/000 判定，没有任何一条会由本仓库的任何测试或检查执行；我无法在此环境跑 ssh/launchctl/curl，这些命令本身「是否真实可用」全部标注**未核实**，以下对命令的判断基于语法与 macOS 通行用法（推测，非实测）。
- round-1 的复核工件（`.agents/reviews/pr-278/round-1/*`）在本检出里读不到（读取被 `REVIEW_GIT_REFUSED` 拒），round 1 具体提了什么意见我未核对；本轮增量 log 显示 6528a69 只改 runbook。

## 发现的问题（按严重度）

**1. 中 | runbook:165 | 管理页登录行为按 Magpie 上游 main（2026-11-07）描述，生产装的是 v0.1.2001（2026-10-29 静态输出）——两端版本没有对上。**
证据：runbook:165「Magpie 源码 internal/gui/web.go（yetone/magpie…2026-11-07 的 main）里…`?k=<密码>`…cookie…固定密码时保留 400 天」；ADR 0117:38「版本 v0.1.2001」。`?k=`、cookie、400 天这些字符没有一个出现在本仓库 Magpie 相关代码里（grep 全仓只有这一处 MAGPIE_WEB_KEY，仓库内无 go 源码），是**读代码证实的缺口**：结论依赖上游 main 的行为，而生产二进制是 10-29 更旧的 v0.1.2001，行为可能不同（固定密码机制是否升级引入？）。若 `?k=` 在 v0.1.2001 不存在，curl 只会一直 401，Andy 无从登录。建议：文中加一句以服务器上 `readlink -f /usr/local/bin/magpie` 解出的版本为准、或下次登录时实测记录版本号与登录结果（后文错把「systemctl 事实」标注了未核实，这里同样该标）。

**2. 中 | 无文件（属仓库级门槛缺口），见 incidents-and-gates.md:45 / .agents/instructions/document-governance.md:28 | 文档类改动没有任何自动检查，反向用例不存在。**
证据：I-06「`npm run check:docs` 已于 2026-10-31 删除…只能通过 document-governance 技能手动校验，不再拦提交」；governance 指令同段「仓库没有对 docs/ 做全面校验的自动检查」。本次改的所有反向场景（写错端口、写错验证命令、cookie 描述错误）都不会让任何检查失败。这符合「只改文档」的约束，但要明确：**本轮没有任何门槛会把「runbook 写错」拦下来**，唯一保险是 Andy 实际操作时发现。建议接受（若 Andy 愿意），否则写一条低成本自检（例如核对 runbook 中引用的 ADR/锚点文件存在、`?k=` 版本说明与 Magpie 版本联动的占位提醒），但这是新增工作，不是必须。

**3. 低 | runbook:165 | `cut -d= -f1 /etc/magpie/web.env` 会把注释行和空行原样打出，不是「只看变量名」。**
证据：cut 按行首 `=` 切第一列——`# 密码是 xyz` 这样的注释行会被整行打印。这是文档里给人跑的命令，若有人曾在 web.env 里写注释（注释里带值），就会泄露。属**推测**（cut 的标准语义确定的、未经本机验证）。建议改为 `grep -v '^#' /etc/magpie/web.env | cut -d= -f1` 或 `systemctl show magpie.service -p EnvironmentFiles` 之类不碰文件内容的读法。

**4. 低 | runbook:13-17 vs runbook:162/182 | Magpie 一节新增了对 ADR 0117 的实质依赖，但 ADR 0117 没加进 `runbook-contract` 契约源文件清单。**
证据：第 13-17 行契约注释只列 ADR 0056、BL-009、ADR 0099；第 162/182 行的事实与顺序都指向 ADR 0117。按 governance（document-governance.md:56），契约源文件变更才会触发重新封存核对；ADR 0117 改动（它历史上已两次修订过，见 0117:123/158）不会让这份 runbook 过期提醒生效，靠人来发现。建议把 `docs/adr/0117-....md` 加进契约清单（一次重新封存有机会一起做）。

**5. 信息 | runbook:162 | 「/usr/local/bin/magpie 与 /opt/magpie/v0.1.2001/magpie 的关系」处理正确，不算矛盾。**
ADR 0117:38 记的是安装时位置 `/opt/magpie/v0.1.2001/magpie`；runbook 原 diff 作者本轮照实记下 2026-11-02 的 systemctl 输出并声明「关系没有核实，以 `readlink -f` 为准」（runbook:162），没有把猜测当成事实，与 ADR 0117 没有文字冲突，只是留了一个「待核实」。可接受。

## 对作者具体说法的核对

- 「systemctl cat 显示 ExecStart=/usr/local/bin/magpie serve --web=127.0.0.1:3430 / MAGPIE_ADDR=127.0.0.1:3425 / EnvironmentFile=/etc/magpie/web.env / User=magpie」：runbook:162 与此一致；与 ADR 0117:38 的路径差异已正确处理并标注未核实（问题 5）。**服务器上的实际输出未核实（无网/无 SSH）。**
- 「ss 显示只监听 127.0.0.1:3425/3430」：runbook:163 与此一致，并与防火墙节（只放行 22）自洽。**未核实现场**。
- 「curl 返回 401 Unauthorized」与「变体 `curl -sS -o /dev/null -w '%{http_code}\n' --noproxy '*'` 输出 401；000 表示隧道没通」：`--noproxy '*'` 排除代理干扰、`-o /dev/null` 只取状态码，写法正确；-sI 与 -w 的对比合理。**未实测**。
- 「~/.ssh/config 里 UseKeychain yes / AddKeysToAgent yes 说的是 macOS 特有选项，正确」：`UseKeychain`、`ssh-add --apple-use-keychain` 是 macOS 自带 imperialism OpenSSH 的标准选项（推测，基于通行用法，未实测）。plist 的 `RunAtLoad`/`KeepAlive`/`ThrottleInterval`、`launchctl load/unload/list` 三列输出说明均为 macOS 通行做法，未发现问题，未实测。
- 「跟 ADR 0117 写的 /opt/magpie/v0.1.2001/magpie 矛盾」：本仓库可见的唯一一处不一致；本轮已按上面问题 5 的方式写出并标未核实，**矛盾不再成立**，但需要 Andy 下次登录时跑 readlink 收尾。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本轮 diff 只动 `docs/runbooks/production-server-access-runbook.md`（已逐 hunk 看过）和 `.agents` 加了复核工件，没有任何代码路径、提示词、工具定义或遮盖代码变动。check:prompt-prefix 的门槛（I-66，incidents:112）未被动到。答「**不适用**」。
2. **同一段文字会不会不同字节？** 文档改动不会。文中描述的遮盖与 `?k=`、cookie 都在模型请求之外；遮盖确定性规则（prompt-prefix.md 第 11 条、I-78）未被触碰。
3. **有没有对应的自动检查，反向用例会失败吗？** 没有。详情见问题 2 的第 2 条发现：docs 类改动无门槛（check:docs 已删，I-06）；仅有间接读的 `check:incident-gates`、`check:markdown-tables` 等不针对本文件内容。**反向用例不存在。**
4. **每个产生/修改的值的两端都核对过吗？** 我列出了全部改动产生的值：`magpie-prod`（产生于 ~/.ssh/config，使用于 plist 的 ssh 命令，两端一致✔）、`com.andy.magpie-tunnel`（文件名与 Label 一致✔）、3430/3425（systemctl 声称、ss 声称、curl 验证三处一致✔）、`MAGPIE_WEB_KEY`（使用端是本仓库外的 Magpie 源码与服务器 /etc/magpie/web.env——**两端都无法在本仓库核实**，这正是 I-73 类「没问清单 id 能否过后端校验」在本文档场景的同类：文中给了核对命令但没人跑过）、`?k=` 与 400 天 cookie（同上，以外部 main 为准，版本对不上——问题的第 1 条）。

**结论：改动本身是一个正确、保守的纯文档增改（回环绑定、密码只写位置、给 ADR 矛盾打标都对）；但「文中描述的登录机制两端版本对不上」和「无任何自动检查兜底」是本轮留下的两个真实风险，建议解决或明确接受。**
