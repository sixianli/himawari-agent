---
status: active
supersedes: ""
superseded_by: ""
date: "2026-11-02"
---

# Himawari 词表

<a id="contents"></a>

## 阅读导航

- [这份词表管什么](#scope)
- [词表](#terms)
- [不改的地方](#not-renamed)
- [怎么加新词或改名](#how-to-change)

<a id="scope"></a>
## 这份词表管什么

同一个东西，整个系统只用一个名字。名字是 Andy 在 2026-11-02 定的（来源：项目聊天里他对 9 个称呼的确认，以及他同意的调整：第 1 条改成“系统没存下的记忆”，主动提醒的统计加上限定词，Gmail 检查那一栏改叫“提醒检查记录”）。

这份词表是 `npm run check:glossary` 的唯一数据来源：检查脚本读下面表格的“旧叫法”一列，在三种语言的界面文案、`AGENTS.md`、`.claude/rules/`、`.agents/instructions/` 和现行文档里搜这些词，搜到就失败。检查的范围和例外写在 `scripts/check-glossary.mjs` 开头；新词表项不用改脚本。

[↑ 回到阅读导航](#contents)

<a id="terms"></a>
## 词表

“新名”一列的反引号里是三种语言（中文、英文、日文）的名字；“旧叫法”一列反引号里的写法一旦在检查范围内出现就报错。“检查范围”写“全部”表示扫描检查范围内的所有文件，写“仅界面”表示只扫描三种语言的界面文案（这些词在历史规格里是工程上“候选改动”的意思，不改）。

| 编号 | 新名 | 旧叫法 | 含义 | 检查范围 |
| --- | --- | --- | --- | --- |
| 1 | `系统没存下的记忆` `Memories the system chose not to save` `システムが保存しないと判断した記憶` | `捕获候选` `记忆候选` `候选记忆` `被放弃的记忆` `想存但没存的记忆` | 系统自己判断后不存的记忆。你亲手点了拒绝的不算在内，因为那是你自己的决定 | 全部 |
| 2 | `待你确认的记忆` `Memories awaiting your confirmation` `確認待ちの記憶` | `等你确认的记忆` `待审批候选` | 系统想存、等你点头的记忆 | 全部 |
| 3 | `决策记录` `Decision record` `判断の記録` `提醒检查记录` `Reminder check record` `リマインダー確認の記録` | `决策账本` `决策日志` `Decision log` | 决策记录是 Himawari 每次拿主意（提醒还是沉默、记还是不记、合并还是作废）留下的一行。提醒页里原来只列 Gmail 检查的那一栏，叫提醒检查记录 | 全部 |
| 4 | `每天打分` `Daily rating` `毎日の採点` | `待评价区` `每日审阅清单` | 你每天花约 2 分钟给 Himawari 的决定打分的区域 | 全部 |
| 5 | `做对了` `不该做` `该做没做` `Right call` `Shouldn’t have done it` `Should have done it` `正しかった` `やるべきではなかった` `やるべきだった` | `没必要` `该说没说` `Not needed` `Should have told me` `useful {Useful}` `役立った` `不要だった` `知らせてほしかった` | 打分的三个选项。数据库里存的值 `useful`、`unneeded`、`missed` 不变 | 全部 |
| 6 | `没提醒的邮件` `Emails with no reminder` `通知しなかったメール` | `筛掉的邮件` `最近 7 天筛掉` `抽查清单` `抽查记录` `"抽查"` `“抽查”` `邮件审计` `リマインドから外した` | Himawari 判断不用提醒、没放进提醒页的邮件 | 全部 |
| 7 | `整理记忆` `Memory tidy-up` `記憶の整理` | `每日整理` `Daily tidy-up` `毎日の整理` | Himawari 每天合并、作废、归档记忆的那件事，也是记忆页里对应的筛选名 | 全部 |
| 8 | `主动提醒总次数` `恰当的提醒` `多余的提醒` `漏提醒（你查过的邮件里）` `Total proactive reminders` `Appropriate reminders` `Unneeded reminders` `Reminders it missed (in emails you checked)` `自発的なリマインダーの総数` `適切なリマインダー` `余計なリマインダー` `見逃し（確認したメールの中）` | `已审样本内漏报` `漏报` `误扰` `没开口` `"开口"` `“开口”` `Spoke up` `Unwanted` `Missed (in reviewed sample)` `確認済みの中の見逃し` | 提醒页的四个统计。恰当 = 你打了“做对了”，或 24 小时内点开；多余 = 你打了“不该做”，或划掉、24 小时没点开；漏提醒只算你查过的邮件 | 全部 |
| 9 | `系统主动提醒` `Proactive reminders` `自発的なリマインダー` | `主动提醒` `主动检查` `主动闭环` | Himawari 读邮件后自己发现并发出的提醒，与你让它设的定时提醒（叫“提醒”）区分。新名里带“主动提醒”的写法（系统主动提醒、主动提醒总次数）不算旧叫法，单独写的“主动提醒”才算 | 全部 |
| 10 | `遮盖` `Redaction` `マスキング` | `脱敏` | 把敏感信息换成固定占位的动作 | 全部 |
| 11 | `待采纳的改进` `Improvements awaiting adoption` `採用待ちの改善` | `自我改进候选` `Self-improvement candidates` `自己改善候補` | 自我改进里等你决定采不采纳的那一项 | 仅界面 |
| 12 | `草稿未发布` `the draft was not published` `下書きは公開されませんでした` | `候选未发布` `the candidate was not published` `候補は公開されませんでした` | 文件版本冲突时，已写好但没有发布的修改 | 仅界面 |
| 13 | `拆成一条条` `Split into items` `項目に分ける` | `整理成一条条` | 记忆页里把一段话拆成多条记忆的按钮 | 全部 |
| 14 | `Muse 对照` | | 与 Muse 的对照条目，没有旧叫法，只登记在这里 | 全部 |

[↑ 回到阅读导航](#contents)

<a id="not-renamed"></a>
## 不改的地方

- 数据库列和存的值（例如 `discarded`、`memory_candidate`、`owner_rating`）、接口操作名、代码标识符：改它们要迁移，会让旧数据对不上，而且用户看不到。
- 已经通过的 ADR 正文和归档文档：历史记录不重写，在这里记“旧叫法 → 新叫法”即可。
- `docs/product-vision.md`：只有 Andy 能改愿景正文。它还写着“决策账本”（护城河四样资产之一），指的就是这里的“决策记录”；等 Andy 下次换版愿景时再改。
- 已冻结的设计原型（`docs/assets/`）、已封存的 Runbook（`docs/runbooks/`）和已做完的实施计划（`docs/execution/plans/`）：原型是定稿截图的源文件，Runbook 改了文字要重新封存，计划是做完的任务清单，不再维护。
- 发给模型的提示词和工具结果文字：已发出的内容只能往后追加（见 [prompt-prefix.md](../.claude/rules/prompt-prefix.md)），不为改名而改动。

[↑ 回到阅读导航](#contents)

<a id="how-to-change"></a>
## 怎么加新词或改名

1. 在上面的表格加一行或改一行：新名写进“新名”列，不再用的写法写进“旧叫法”列。旧叫法要写完整的词，不要写“候选”“整理”这样会误伤别的意思的单字词。
2. 改掉检查范围内所有出现旧叫法的地方，运行 `npm run check:glossary`。
3. 改界面文案时，中、英、日三份一起改。

[↑ 回到阅读导航](#contents)
