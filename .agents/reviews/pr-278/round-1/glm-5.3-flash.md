# 复核结论（提交 446fe3e，基准 f0478c4）

## 侧重检查

本次改动只有一份文档（docs/runbooks/production-server-access-runbook.md 新增 30 行）。我按「最普通使用流程」从入口走到结束：

- 流程 a（一次性）：Mac 终端 `ssh -L` → 本机 3430 → `curl -sI` 验证 401 → 浏览器带 `?k=<密码>` 打开 → 在管理页改配置（按 owner-standing-rules 授权）。
- 流程 b（常驻）：`~/.ssh/config` 的 `Host magpie-prod` → LaunchAgent `com.andy.magpie-tunnel` → `launchctl load` → KeepAlive 重连 → 连 Hermes 前 `unload`。
- 流程 c（排障）：连不上 = Hermes 抢端口 / 密钥口令未进钥匙串。

结论：这些路径本身是纯文档，仓库内没有任何代码或测试可执行、可覆盖；我逐一核对了文档内的锚点（33 行导航 ↔ 156 行 `<a id="magpie-admin">`，匹配）和相对链接（`../../.claude/rules/owner-standing-rules.md#authorization-deploys-and-merges` 存在，owner-standing-rules.md:37-38；`../adr/0117-…md` 存在）——读代码证实，链接和锚点没有断的。流程里**没有被验证闭环的环节**是「带 `?k=<密码>` 真的能登录」这一步（下详）。

## 发现（按严重度从高到低）

**1.（高）production-server-access-runbook.md:168、175 — 教用户把生产管理页密码存进浏览器书签。**
证据（读代码证实，亲自读到的行）：
- 168 行：`浏览器打开 http://127.0.0.1:3430/?k=<密码>`
- 175 行：`之后把带密码的网址存成浏览器书签。`

能看全部密钥、改路由配置的密码会明文留在书签里，并进浏览器历史（推测：若浏览器开启同步/钥匙串备份，还会同步出去）。本文自身 164 行就强调「不要把它的内容写进仓库」，但书签这一步给同一密码开了长期持久化的口子。建议：改为「把密码存进密码管理器/钥匙串，每次访问时粘贴」，并勾一步「无痕窗口访问」避免历史/自动填充残留；至少注明书签含明文密码的代价。

**2.（中）production-server-access-runbook.md:162 — `ExecStart=/usr/local/bin/magpie` 与 ADR 0117 的安装路径矛盾、未解释。**
证据（读代码证实）：
- 本文档 162 行：`ExecStart=/usr/local/bin/magpie serve --web=127.0.0.1:3430`
- ADR 0117:38：`已装好并空跑：版本 v0.1.2001，/opt/magpie/v0.1.2001/magpie，系统服务 magpie.service`

推测（可能是符号链接、升级后换路径，或当时记录的是解包位置）：两份文档都是「生产机现场记录」，直接并存会让读者怀疑哪边准。建议在本文加一句两路径的关系（例如 `/usr/local/bin/magpie` 是 symlink），或注明「以当前 `systemctl cat` 输出为准，v0.1.2001 时代装在 /opt（ADR 0117）」。

**3.（中）production-server-access-runbook.md:168、175 — 验证步骤没有验证文档教的认证方式本身。**
证据：175 行的验证是 `curl -sI http://127.0.0.1:3430/ | head -1 返回 HTTP/1.1 401`，只证明「端口转发通、页面拒绝匿名访问」。文档教的登录形态是 `?k=<密码>`（168 行）——401 并不能证实 Magpie 管理页认这个查询参数作为凭据（也可能是某个请求头/表单）。Magpie 是仓库外的开源程序（github.com/yetone/magpie，工程案例库 3932 行引用），**`?k=` 用法在本仓库内未核实**；作者也未声称 Andy 验证过 `?k=` 能登录成功。若 `?k=` 不是 Magpie 的认证方式，照本文做的人会一直停在 401。建议：把验证一步改为「带密码的网址打开后确认能看到管理页」，并注明管理页对认证形态的要求来源（如 Magpie 文档/README）。

**4.（低）production-server-access-runbook.md:13-17 — 新增一节引用了新的权威来源，但没进 runbook-contract。**
证据（读代码证实）：文件头的 `runbook-contract` 清单仍只有 `0056`、`BL-20261021-009`、`0099` 三项；新节却依赖 `docs/adr/0117`（179 行「当前顺序见 ADR 0117」）和 `.claude/rules/owner-standing-rules.md`。document-governance.md:28-31 说明契约源文件的封存机制；依据 document-governance.md:56，只有当「契约源文件」被改动才强制重新封存，本次改的是 Runbook 本体，不强制。但既然把 ADR 0117 当作生产状态的对照来源，建议要么把 0117 加入契约清单并用 `runbook.py seal` 重新封存，要么删掉「当前顺序」这类会漂的说法（路由组顺序属于「生产机上的配置，不在本仓库」，ADR 0117/0119 也多处声明这一点）。

**5.（低）production-server-access-runbook.md:106-112、frontmatter 第 8 行 — 证据登记和 frontmatter date 没跟上。**
证据（读代码证实）：Evidence 一节写「每次登录处理生产问题时，把 systemctl status …记入当次的交接文件」，而新节却引用 2026-11-02 的 `systemctl cat`/`ss -ltnp` 只读输出，Evidence 里没有对应指针；frontmatter `date: "2026-10-28"` 也未随 2026-11-02 的内容更新（该字段的确切校验规则未核实——`check:docs` 及其脚本已删除，见必答 3）。建议补一条证据出处并更新 date。

**6.（低）production-server-access-runbook.md:168 — 「一次性连接」未提示与自家常驻隧道的端口冲突。**
证据（读代码证实）：180 行已提示两条隧道抢 3430 时后开的因 `ExitOnForwardFailure` 退出（针对 Hermes）。同理，常驻 LaunchAgent 在跑时再执行 168 行的一次性 `ssh -L 3430:…` 也会因本地端口占用失败。建议在一次性段加一句「常驻隧道已在跑时不必再用本命令」。

**7.（信息/未核实）macOS 命令、launchd、ssh 选项的正确性。**
`AddKeysToAgent yes`、`UseKeychain yes`、`ssh-add --apple-use-keychain`、`/usr/bin/ssh`、`LocalForward` 不带 `-g` 时默认只绑回环、`ThrottleInterval 15` 秒——这些是 macOS/OpenSSH 的通行行为，与我离线掌握的知识一致，但**本仓库内没有可核对的代码**，也未联网验证，标「未核实」。一个小措辞：`RunAtLoad` 的 LaunchAgent 是**用户登录时**启动，不是严格的「开机」（本文称「开机自动连接」，属轻微不准）。另外作者说法中的 `User=magpie` 在文档 162 行被省略了，与文档不矛盾，只是信息缺失。

## 读代码证实的 vs 推测 —— 汇总

- 证实：diff 仅此一个 md，+30 行，不含真实密钥（密码一律 `<密码>` 占位，IP 与既有文档/脚本一致，如 scripts/delivery-mode/instances/andy-production.json:4）；锚点与两条内链可达；防火墙节「只放行 22」的表述与本文 143-149 行一致；Hermes 确有 magpie 痕迹（hermes-runner 任务 artifacts/hr4-after.txt:132 有 `magpie-test Up 3 days` 容器记录——侧面支持 180 行的 Hermes 说法，但 Hermes 管理页是否用 3430 未核实）。
- 推测：`/usr/local/bin/magpie` 与 `/opt/...` 的关系；`?k=` 是否为 Magpie 认可的认证方式；书签/历史持久化与同步的实际影响面。

## 逐条回答必答问题

1. **不会改变模型见过的请求开头。** 本次只改 `docs/runbooks/` 下一个 md；在我检索过的引用关系里，没有任何代码或配置把该 runbook 放进系统提示、工具定义、历史消息或遮盖材料（prompt 材料入口是 AGENTS.md、`.claude/rules/prompt-prefix.md` 等规则文件与代码内配置；组装细节未逐行核实，标此限）。发给模型的内容零变化，「只追加」「会变值放最后一条消息」的规则自然不触碰。无自动检查直接覆盖此文档的 prompt 影响——不适用即无影响。
2. **不会。** 改动是纯 Markdown 增段，不涉及遮盖算法、带时间字段或无序集合；新节里出现的时间（2026-11-02）是历史事实记录，不是每次请求会变的值，也不进入发给模型的字节流。
3. **没有，反向用例也不会失败。** document-governance.md:28 写明「仓库没有对 docs/ 做全面校验的自动检查：`npm run check:docs` 及其脚本已删除」；delivery-mode.md:18 写明 `npm run check` 不含文档校验，改 docs 需「另外手动运行文档校验」。`npm run check` 里查 docs 的几步（check:glossary、check:incident-gates、check:instruction-links、check:markdown-tables、check:adr-numbers）都不覆盖本次改动点（instruction-links 只查指令文件→docs 方向，本文是 docs→.claude/rules）；`check:markdown-tables` 对本节无表格相关性（本节用的是列表）。validate_docs.py --strict 是否通过未证实——我无权运行。本次内容质量完全依赖人工复核与 Andy 的现场验证。
4. **逐值核对：** 改动产生/引用的值——端口 3430（管理页）与 3425（模型接口）、路径 `/usr/local/bin/magpie`、`/etc/magpie/web.env`、别名 `magpie-prod`、plist `com.andy.magpie-tunnel`、URL 形态 `?k=<密码>`。**仓库内不存在这些值的第二个校验端**（I-73 的教训「清单里的 id 要过发送端校验」主要是代码型改动才有的双重校验面）：使用方只有 Andy 的 Mac 端命令、外部 Magpie 程序和生产机 systemd/sshd。仓库内可确认的是：(a) 端口 3425 与 ADR 0117:38 及多处文档一致；(b) IP、路径写法与既有 runbook 一致；(c) 机密扫描不会误伤（前一个提交 f0478c4 正刚调整 gitleaks，本文无真实密钥）；(d) 链接/锚点可达。仓库外无法核实的对端校验：「?k= 是否被 Magpie 接受」「ExecStart 路径与 ADR 0117 安装路径的矛盾（见发现 2）」「Hermes 管理页是否真的也用 3430」——这三项是本次唯一需要 Andy 现场或外部文档把关的值，发现 2、3 已给出建议。

**总体：** 改动方向正确（只读记录现场、只教回环转发、不写密钥、明确生产变更授权），与防火墙节、ADR 0117 的监听事实不冲突；合并前建议处理发现 1（书签存密码）与发现 3（验证步骤不闭环），澄清发现 2，其余为低severity完善项。
