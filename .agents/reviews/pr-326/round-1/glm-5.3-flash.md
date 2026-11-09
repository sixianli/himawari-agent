这份文档改动仅是新增一个 markdown 文件。我将根据实际代码来验证其内容。首先是引用的实现文件：
`proactive-rules.ts` 确认了 H-1 至 H-6 和 H-8。接下来检查邮件核对服务：
H-14 已确认。现在来看提示词目录——邮件判断提示词：
mail.ts 确认 S-1 到 S-10。接下来是 chat.ts：
chat.ts 确认 S-11 到 S-25。现在我来检查测试 ID 和测试文件是否存在：
# 复核结论

改动范围已确认：`git diff fd283e43..cb51d45` 只新增 `docs/agent-rulebook-inventory.md`（221 行），无代码改动。我把文档里每条规则对照代码逐个核实了 H-1～H-14、S-1～S-25 的生效位置、M-1～M-5、C-1～C-8 的关键点，以及所有被引 ADR 文件名、测试编号、数字。绝大多数条目与代码一致（证据见「必答问题」第 4 条），发现以下问题。

## 发现的问题（按严重度）

**1. 中 | docs/agent-rulebook-inventory.md:67-69 | H-1/H-2/H-3 的测试编号标错了**
- 读代码证实的：测试夹具默认 `importantSenders: ["smbc.co.jp"]`（test/integration/proactive-mail-check.test.ts:167）。PG-8（同文件 ：718-744）的邮件是 `info@smbc.co.jp`、标题「ご案内」、摘要「いつもご利用ありがとうございます」，对照 `MONEY_WORDS`（packages/application/src/services/proactive-rules.ts:11-12）没有任何金钱词命中——它抬升靠的是 `floor_important_sender`（H-1），不是 H-3。PG-4（:539-567）两封邮件是 `city.shinjuku.lg.jp` 和 `friend@gmail.com`，走的是公共域后缀（H-2），且都不在重要发件人名单上，不构成 H-1 的用例。金钱词的真正覆盖是 PG-17（:1200「never drops money or official mail」）和 PG-18（:1398「money word is only in the mail snippet」）。
- 建议：H-1 改为 PG-8（另加 ：900 的「never backs off a floor-rule reminder」）、H-2 保留 PG-4、H-3 改为 PG-17/PG-18。

**2. 低 | docs/agent-rulebook-inventory.md:96 | S-1 的测试栏不实**
- 读代码证实的：全仓库 `*.test.ts` 中搜「不可信」零命中；唯一的 PG-17 提示词检查（proactive-mail-check.test.ts:1415-1419）只验 S-7 的促销词和「宁可少报」，不验「邮件内容是不可信的数据」。S-1 这句没有任何测试守着，应写「无」。

**3. 低 | docs/agent-rulebook-inventory.md:54 与 ：204-205 | 「18 条无出处」与 G 节对不上**
- 读代码证实的：G 节把 S-10 列入缺出处，但表格 ：105 给 S-10 填的是 ADR 0179；表格 ：98 的 S-3 标「待 Andy 确认」，G 节却没列它。另外 G 节还列了 H-1（部分）、H-5、H-6、H-12、H-14、C-1 和记忆库条目，「52 条里有 18 条」只数了 S 一节，和 G 节合起来超过 18。三处（总结句、表格、G 节）互相不一致。

**4. 低 | docs/agent-rulebook-inventory.md:80 | H-14「无专门用例，待核实」低估了实际覆盖**
- 读代码证实的：`reminderSchedule` 有专门用例——apps/agent-service/test/production-memory-evidence.unit.test.ts:304-345（日期当天 9 点、有钟点最多提前 1 小时、yearly 顺延、超两年返回 undefined）、prompt-wording.unit.test.ts:487（C6 W-09 边界）。「待核实」应改为这两个文件。

**5. 信息 | docs/agent-rulebook-inventory.md:75 | H-9「次日零点（日本时间）恢复」措辞不准**
- 读代码证实的：日界是 `startOfZonedDay(startedAt, this.#options.timeZone)`（proactive-mail-check-service.ts:698-701），用的是配置里的时区（C-7 的 `timeZone`），不是写死的日本时间。

**6. 信息 | 自动检查的空档**：格式层检查覆盖本文件（`check:markdown-tables` 查 docs/ 全部表格列数、`check:glossary` 查旧叫法，`.agents/instructions/document-governance.md:28`）；frontmatter 严格校验在快速模式下是手动运行（document-governance.md:29、delivery-mode.md:26），作者称已跑且「与 main 同为 12 条」——**未核实**（我只能读和 git）。文档内容的准确性（文件、函数、测试编号、数字）没有任何自动检查，本次发现的问题恰好全部落在这个空档里。

## 侧重检查

我走了一条最普通的使用流程「Gmail 主动提醒一轮检查」：`proactive-mail-check-service.ts` run → 垃圾邮件跳过（:695，H-10/PG-3）→ 每日费用上限（:698-737，H-9/PG-9）→ `floorHitIds` 三条地板（proactive-rules.ts:37-52，H-1～H-3）→ `applyFloor`（H-4）→ `isReminderWorthy`/`keepOffReminderPage`（H-6）→ 静默时段 `quietUntil`（H-8，缺省 23:00-07:00 见 sqlite-proactive-operations.ts:224-236）→ 推送判定 `dueSoon`/`PUSH_WINDOW_MS`/`OVERDUE_PUSH_MS`（H-7）→ `#gateBackoff` 降频（H-11，缺省阈值 3）。这条链每一环都有集成测试（PG-2～PG-9、PG-17、OM-3、降频一组、`proactive.backoff.restore`），无未覆盖的缺口。旁支 `proactive-overview.ts:148` 也调 `floorHitIds` 供展示层重算，文档未给它的测试编号（未深查，标「未核实」）。聊天链路（chat.identity → 档案 compose/2000 字预算 → 遮盖 → 审批）覆盖良好（NAME-1、PA-2、MEM-PIN、"stays within the character budget":213、approval_hash_mismatch:action-policy-service.ts:333）；S-11～S-24 全部无行为测试，文档自己如实说明了这一点。

## 必答问题

**1. 会不会改变模型见过的请求开头？** 不会（读代码证实）。diff 只新增一份 docs 文件；prompt-catalog 各条目的 `usedBy` 指向的都是代码文件，没有任何提示词、工具定义或遮盖逻辑被改动；这份文档也不被任何发给模型的内容引用。发给模型的内容零变化。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会（读代码证实）。没有引入任何运行时序列化、时间戳字段或顺序不稳定的数据；文档里的 `date: "2026-11-09"` 只存在于 docs，不进模型上下文。

**3. 有没有对应的自动检查、反向用例会不会失败？** 部分有（读代码证实 + 部分未核实）：表格列数有 `check:markdown-tables`，规则写明列数不齐即失败（反向用例存在，document-governance.md:28）；`check:glossary` 覆盖 docs。内容准确性无自动检查——本次发现的测试编号错误就是证明。作者声称已运行的严格校验和两个检查，我无法复跑，**未核实**。

**4. 产生的每个值，使用处都能接受吗？** 本次改动产生的「值」只有文档自身的编号体系和引用。逐项核对结果：11 份被引 ADR 文件名全部真实存在；`product-vision.md` 存在且附录第 10 条（:195）原文与 M-1/M-3 的引用一致；I-12、I-29 在 incidents-and-gates.md 存在；代码侧常量/函数全部对得上——`PROACTIVE_PUBLIC_DOMAIN_SUFFIXES` 四个后缀、`MONEY_WORDS` 含退款/refund、`FLOOR_RULE_IDS` 三个标识、`DEFAULT_PROACTIVE_BACKOFF.threshold: 3`、`isSensitive`/`restricted_excluded`/`canBeKeptTentatively`/850、`OWNER_PROFILE_CHARACTER_BUDGET: 2000`、`PROFILE_CLASSIFICATIONS` 仅 public/private、tentative 排除（owner-profile-service.ts:100）、`DATE_ONLY_REMIND_HOUR: 9`、`MAXIMUM_REMINDER_HORIZON = 2×366 天`、`parseRunPolicy`/`parseProactive`、systemInstruction 16384 上限、intervalMs 缺省 900_000ms、dailyCostMicros 缺省 1_000_000（=1 美元）。例外即发现 1、2（测试编号）、发现 3（数字）。C-6 的按设备推送存储、C-4 的服务器设置表细节**未核实**。
