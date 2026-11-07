代码执行受限；`glob` 看不到 `.claude/rules`，但 `grep` 确认了该文件存在。现在我来检查 ADR 0117 以及验证 `runbook contract hash` 的脚本。
现在我来检查几个交叉引用：`port`/`Hermes` 权限项（3342 行）、`owner-standing-rules` 锚点（3351 行），以及是否有代码读取这些 `runbook`（3360 行）。
一项关键交叉检查：ADR 0142 中提到“Hermes 上没有 Magpie”，这可能与 Runbook 中关于 Hermes 管理页面的声明相矛盾。我来核实一下。
直接矛盾现已显现。我来检查一下评审工件是否指出了这个问题，并读取结论。
# 复核报告（16679830 → 生产访问 Runbook 的 Magpie 管理页一节）

改动范围（git diff 确认）：`docs/runbooks/production-server-access-runbook.md` 的 Magpie 管理页一节（cookie 提醒、curl 000 解释、密码网址编码、Hermes 一句改写），加 `.agents/reviews/pr-278/` 第 4 轮复核记录。纯文档，无代码。

## 读代码证实的问题（按严重度）

**1. 中 · docs/runbooks/production-server-access-runbook.md:183 vs docs/adr/0142-keep-background-memory-capture.md:69 · 文档互相矛盾：Hermes 到底有没有 Magpie**
- 证据：runbook 写「Hermes 测试环境的 Magpie 管理页也用 3430」；ADR 0142（2026-10-31）第 69 行写「Hermes 上没有 Magpie，无法在那里测」；engineering-casebook.md:4994「Hermes 上没有 Magpie，改走网关」。I-74/I-73（incidents-and-gates.md:112-113，11-02）描述的 Hermes 验收环境配置也是直接列三个 primary 模型、不经 Magpie。
- 全仓库范围内「Hermes 用 3430 的管理页」只有这一句，没有其他出处。哪个对（11-02 之后是否在 Hermes 装了 Magpie）未核实。
- 建议：现场核实后改一头；若 Hermes 确有 Magpie，在 ADR 0142 加注；若没有，这句会让 Andy 去连一个不存在的页面。

**2. 低 · production-server-access-runbook.md:178 · 密码经命令行传入，留在 shell 历史和进程列表**
- 证据：「先对整个密码做网址编码，例如 `python3 -c '...' <密码>`」。密码作 argv 会被 `history`/`ps` 看到。文档下面只说「不要把密码贴进聊天、写进仓库或存进书签」（165 行），没覆盖这条路径。
- 建议：改成 `read -r` 输入或 `printf '%s' "$MAGPIE_WEB_KEY" | python3 -c '...'` 之类的管道读法。

**3. 低 · production-server-access-runbook.md:178 · 全量网址编码依赖 Magpie 端做标准解码，生产具体版本未核实（推测部分）**
- 读代码证实：早期轮次的实测只覆盖含 `+`、`&`、`#`、`%` 的情形；本句改成「对整个密码编码」，会把 `!`、`*`、`(` 等也转成 `%xx`。
- 推测（源码在本仓库外）：只有当生产版 Magpie 对 `?k=` 做标准 percent-decode 后比对，编码前后才等价；若它拿原始字符串直接比对会失败。文档 165 行已自标「生产装的是更早的版本，源码描述只作参考」，但这条具体差异没提。

**4. 低 · production-server-access-runbook.md:174-175 · `launchctl load/unload` 已是 deprecated 子命令（非代码核对，是我对 macOS 的既有知识）**
- 仍可用、行为与文中一致（`launchctl list` 第一列 PID、第二列上次退出码正确）。长期 runbook 建议补一句现代写法 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/...` 兼容提示。

**5. 信息 · 文档治理元数据可能过期**
- front-matter `date: "2026-10-28"`（第 6 行），正文却记 2026-11-02/11-07 的现场事实。 exacerbated 无检查（见 Q3）。本节依据的 ADR 0117 也没进第 12-16 行的 `runbook-contract` 封存清单（清单仍只有 0056、BL-009、0099 三个文件——因为现场事实来自服务器而非 ADR，是否该加由治理规则定，存疑而非错误）。

**核对一致（读代码证实、无问题）**
- `ExecStart=...--web=127.0.0.1:3430`、`MAGPIE_ADDR=127.0.0.1:3425`、`EnvironmentFile=/etc/magpie/web.env`、`magpie` 账号：与作者的说法逐字一致（162 行）。
- `/usr/local/bin/magpie` 与 ADR 0117:38 的 `/opt/magpie/v0.1.2001/magpie`：**不构成矛盾**——runbook 162 行已自标「没有核实，以 `readlink -f` 输出为准」。
- 3425 在仓库内唯一消费方是 Himawari 的模型 `baseUrl`（ADR 0117、`configured-model-binding` 的回环 http 校验），与本改动一致；3430、`MAGPIE_WEB_KEY`、`MAGPIE_ADDR`、`/etc/magpie/web.env`、`?k=`、cookie、`com.andy.magpie-tunnel` 在仓库代码里 grep 无任何消费方，两端校验问题不存在。
- 安全约束满足：管理页只听回环（163）、转发只绑 `127.0.0.1`（169、173）、ufw 只放 22、无任何对公网开放的措辞、密码不出现在仓库。cookie 跨端口发送的提醒（178 行）技术上是正确的（cookie 按主机名、不按端口隔离），第 4 轮的改写在这一点上把风险讲清了。
- 176 行「000 = 隧道没通，或 Magpie 没在运行」的新解释对 curl 行为描述准确。

## 侧重检查（测试覆盖 / 文档一致性 / 普通流程走查）

走过流程：Mac 登录 → 配 `~/.ssh/config` + launchd plist → 端口转发 → `curl` 看 401 → `?k=` 登录 → 管理页改配置（此处触发 owner-standing-rules 的生产变更授权锚点，锚点 `#authorization-deploys-and-merges` 在 `.claude/rules/owner-standing-rules.md:37` 存在，链接可解析）。结论：本 runbook 的每一步都是 OS 命令和外部程序（ssh、launchd、Magpie）的操作，仓库内**没有任何测试覆盖**；仓库代码唯一相关的值（3425 回环配置校验）有现成测试且本改动未碰。文档一致性方面发现的矛盾就是问题 1；`check:instruction-links.mjs:7-12` 只查 AGENTS/CLAUDE/.claude/rules/.agents/instructions，runbook 内的链接和锚点不在任何自动检查范围内。

## 必答问题

1. **不会。** 改动只含 runbook 文档和 `.agents/reviews` 复核记录；发模型的请求由提示词目录和适配层生成，不读这些文件（读代码证实：无任何 prompt 代码引用 runbooks 或本节文字）。运行时系统提示、工具定义、历史、遮盖一字未动，仍只在末尾追加；`check:prompt-prefix` 的被检代码没变化。
2. **不会。** 文档内容不进模型请求；文本里的日期（"2026-11-07 的 main"、"2026-11-02 现场"）是提交时固化的静态内容，不是每请求序列化值，也没有无序集合或依赖前后文的遮盖。
3. **没有对应自动检查，反向用例不适用。** `npm run check` 步骤清单（package.json:27）不含任何 runbook 事实校验；`contract_sha256` 只封存三个依据文件（未变，不会触发也不需要重封）；治理校验 `validate_docs.py --strict` 是仓库外手动执行（document-governance.md:29），当前 `DELIVERY_MODE=fast`，是否有提交者跑过无法从 git 证实（未核实）。也就是说：即使本节内容的链接死掉、Hermes 那句错了，`npm run check` 一条都不会失败。
4. **逐个值核对过两端：** 3425——消费方是模型 baseUrl 校验，已接受（有测试）；3430、`MAGPIE_WEB_KEY`、`/etc/magpie/web.env`、`?k=`、cookie、`MAGPIE_ADDR`、label `com.andy.magpie-tunnel`——仓库内零消费方，仅文档引用，无校验断裂；URL 编码后的密码——消费方是 Magpie 的 `?k` 解析，**未核实**（问题 3）。I-73 要求的「清单里的 id 过得了后端校验吗」这类两端问题，本次改动没有引入新的仓库内标识，故无同类风险。
