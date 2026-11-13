## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致”逐项查了：

- **错误路径**：项目名拒绝原因（ADR 0242:114、134）、类别不合格（0242:105）、未测试规则类型（`production-owner-rules.ts:458-467`，`writableRuleType` 拒绝）、筛失败（0242:141）。发现拒绝原因可能回显令牌、筛的模型路由未定。
- **不可信输入**：类别提示、项目名、规则类型声明、贴回文本。类别值五份清单一致；项目名检查有可绕过的写法；规则类型登记表接口仍写死邮件参数。
- **安全**：项目名里的令牌可能因单斜杠/单反斜杠写法漏过；拒绝原因可能把令牌写进结果或决策记录；待确认的 sensitive 正文进筛模型时没有写分级准入。
- **资源耗尽**：`propose_rule` 的首个合法提议会做近 30 天邮件回放；重发确认、接受时还会再回放；按接入的规则提议限频目前没有代码，ADR 把它留给任务 C。筛一次最多可处理待确认上限 1000 条，ADR 只写“数据按固定顺序排”，未写批大小、超时或花费保护。
- **不可撤销操作**：筛只给建议，规则要主人点头，“直接存”只管记忆；本轮没有新增不可撤销操作。
- **文档与代码一致**：`CATEGORIES` 九值无 `rule`、`MEMORY_EXTERNAL_CATEGORY_NAMES` 的派生、五份类别清单、`preview` 回放、`#startHere` 只取 summary、`ruleParameters` 写死两个规则编号、0228:63 / 0246:89 的位置，均已核对；作者说法 3 的“第一次调用才走到 preview”不准确。

## 结论（按严重度）

### 1. 中高：项目名凭据检查可被标准 URL 解析器认可的写法绕过

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:134`
- 问题：规则只在字符串含 `://`、以 `//` 开头、或匹配 `用户@主机:` 时才交给标准网址解析。标准 URL 解析器会把 `https:/user:token@host/path`、`https:user:token@host/path` 规范成带 userinfo 的 URL，但这两个串都不含 `://`、不以 `//` 开头、也不是 `user@host:`，于是按普通文字收。`https:\user:token@host\path` 经“反斜杠当正斜杠”后变成单斜杠版本，同样漏过；`user:token@host/path`（无协议 authority 写法）也不触发。
- 证据：
  - `0242:134`：“下面三种算远程地址写法：名字里任何位置有 `://`（不看是什么协议、不分大小写）；以 `//` 开头；开头是 `用户@主机:` 这种写法……”
  - 同行：“前两种用标准的网址解析拆开（以 `//` 开头的先补上一个协议再拆）：拆不开的拒绝；拆出用户名、密码、查询参数或 `#` 后面的部分的拒绝。”
  - 同段末尾：“这道检查排在助手程序之后，挡的是常见的地址写法，不保证认出每一种变形。”
- 建议：规范化后只要匹配 `^[A-Za-z][A-Za-z0-9+.-]*:` 就一律交给标准 URL 解析（或直接拒绝），至少补 `https:/user:token@host/path`、`https:\user:token@host\path`、`user:token@host/path` 三条反向用例；测试条目要写明“用反斜杠的”是双反斜杠还是单反斜杠，否则实现和用例可能对不上。
- 证据性质：ADR 文本是读到的；“标准 URL 解析器会这样规范化”是基于标准行为的推测，未在仓库里运行验证。

### 2. 中：手动筛与“任务 C 里‘筛’这一块等那份 ADR”边界不清

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:141-142`（另见 `:208`、`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:64`、`docs/adr/0246-external-proposals-join-the-data-export-and-web.md:90`）
- 问题：141 行已经决定“点了就筛”、筛失败不影响内容、筛结果不进聊天、待确认正文进一次后台模型调用；142 行又说“任务 C 里‘筛’这一块等那份 ADR，别的不等”。如果“筛这一块”包含手动“先帮我筛一遍”，那么任务 C 会把手动筛也一起搁置，和刚做的决定冲突；如果只指自动筛，文字没有写清。作者摘要又说“筛的结果存哪里、进不进导出、按分级能发给哪些模型、数据怎么排、按接入怎样限频，全部留给另出的一份 ADR”，这些项同样适用于手动筛，进一步放大了歧义。
- 证据：
  - `0242:141`：“……点了就筛，用了多少在用量页上看。筛只给建议……筛的时候待确认的正文会进一次独立的后台模型调用，这是主人自己点的。”
  - `0242:142`：“……这份补注不定这件事，另出一份 ADR 给 Andy 定。任务 C 里‘筛’这一块等那份 ADR，别的不等。”
  - `0242:208`：“这两处是后台调用，固定的指令在前、这次的数据在后，数据按固定的顺序排。”
- 建议：把“手动筛”和“自动筛”分开写：明确手动筛的决定保留、任务 C 要能实现；自动筛、结果存储、导出、按分级路由、限频等才等新 ADR。若手动筛也等新 ADR，就写明“任务 C 不做任何筛”，不要同时保留“点了就筛”的实现承诺。

### 3. 中：手动筛的模型分级路由没有写，例外只写了“会进模型”

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:141-142`、`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:64`
- 问题：三处补注都只说“待确认的正文进一次独立的后台模型调用”，没有说 private/sensitive 的待确认正文分别能发给哪些模型。142 行把“按分级能发给哪些模型”列为自动筛要另定的事，但手动筛同样会把 `sensitive`（健康、财务）正文送进“低价模型”。如果低价模型和现有生产模型名单不是同一套，这就是一个未定的隐私边界；ADR 0228 的例外因此比原文“确认前 Himawari 不用它”走得更远。
- 证据：
  - `0242:141`：“筛的时候待确认的正文会进一次独立的后台模型调用……”
  - `0242:142`：“……按分级能发给哪些模型、按接入怎样限频也都要定。”
  - `0228:64`：“……待确认的正文进一次独立的后台模型调用，只用来给主人出建议。别的不变……”
- 建议：在 0228、0242、0246 的例外补注里加一句“哪些分级可以发给哪些模型，沿用现有模型准入；手动筛不得把超过该路由准入的分级发给模型”，或者明确“手动筛也等那份 ADR 定路由后再实现”。这与作者“筛的路由不算本 PR 问题”的范围声明不矛盾：本 PR 只需把例外写完整，不必现在定路由。

### 4. 中：新增筛调用没有说明遮盖是否逐条独立，测试清单也未覆盖

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:208`、`:251-252`、`:267-275`
- 问题：208 行只写“数据按固定的顺序排”，没有写一批待确认正文是逐条独立遮盖，还是整批一起遮盖。现有对外遮盖是整次返回一起遮：一段里点名的密码/验证码，会让同一批里别处单独出现的同一个值也被遮（`docs/adr/0219-read-only-mcp-entry-with-static-token.md:73`）。筛调用如果把多条待确认正文放进一次请求，同一段正文的遮后字节会随同批前面的条目变化。新增的“要补的自动检查”里有 `start_here` 的字节稳定用例，却没有筛调用的字节稳定或逐条遮盖用例。
- 证据：
  - `0242:208`：“……这两处是后台调用，固定的指令在前、这次的数据在后，数据按固定的顺序排。”
  - `0219:73`：“一次返回里先过一遍所有文字，记下认出的密码、验证码，再遮第二遍。这样同一个密码在一段里被点名、在另一段里单独出现时，两处都遮掉……”
  - `0242:267-275` 的测试清单：有类别、读取上限、项目名、规则类型、字节稳定（`start_here`）等条目，没有筛调用。
- 建议：要么规定筛调用对每条待确认正文单独遮盖后再拼请求，要么在 ADR 里明确接受“同一段正文的遮后字节随批次变化”并加一条反向用例；至少补一条“同一段正文在不同批次里遮后字节相同”的检查，否则无法证明符合 `.claude/rules/prompt-prefix.md` 第 10、11 条。
- 证据性质：`0219:73` 和 ADR 文本是读到的；“同一段正文会因批次不同而遮成不同字节”取决于未来筛的实现，是推测；现有整批遮盖是文档写明的。

### 5. 中低：类别清单“全仓库再搜一遍”的范围不清，内部记忆类别清单会被误纳入

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:105`
- 问题：列出的五份都是“外部提议类别”清单，值都是 9 个（等于 `MEMORY_CATEGORIES` 去掉 `rule`），这部分核对通过。但仓库里还有多份完整记忆类别清单（10 个，含 `rule`）：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:138-149`、`packages/application/src/ports/decision-ledger.ts:89-100`、`packages/calibration/src/thresholds.ts:3-14`、`packages/persistence-sqlite/src/data-export/schemas.ts:6-17`、`packages/gateway-contracts/src/contracts-v2.ts:1185-1196`。105 行又说“动工时全仓库再搜一遍，搜到别的抄本一起纳入”。如果把这些内部清单也纳入“每一份都恰好等于 `MEMORY_CATEGORIES` 去掉 `rule`”的检查，检查会误报；如果只纳入外部提议清单，应该写明范围。
- 证据：
  - `0242:105`：“……任务 C 加一条自动检查：每一份都恰好等于 `MEMORY_CATEGORIES` 去掉 `rule`，多一个、少一个都失败……动工时全仓库再搜一遍，搜到别的抄本一起纳入。”
  - `packages/persistence-sqlite/src/sqlite-memory-operations.ts:138-149` 的 `CATEGORIES` 含 `"rule"`。
  - `packages/application/src/ports/decision-ledger.ts:89-100` 的 `DECISION_CATEGORIES` 含 `"rule"`。
  - `packages/calibration/src/thresholds.ts:3-14` 的 `THRESHOLD_CATEGORIES` 含 `"rule"`。
- 建议：把检查拆成两类：外部提议类别清单必须等于 `MEMORY_CATEGORIES` 去掉 `rule`；内部记忆/账本/校准类别清单必须等于 `MEMORY_CATEGORIES`。现有的 `packages/application/test/tentative-memory-capture.unit.test.ts:227` 已经在守 `THRESHOLD_CATEGORIES === MEMORY_CATEGORIES`，可以扩成统一检查。
- 证据性质：清单内容和值都是读到的；“实现者会把内部清单误纳入”是推测。

### 6. 中低：拒绝原因可能把令牌带进逐条结果或决策记录

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:134`、`:114-115`
- 问题：项目名校验说“拒绝时结果里写明原因”，而同一条决定又说逐条结果会“不合格（附原因）”，整批“连同它的决策记录”写进同一事务。如果实现把原项目名或拆出的 userinfo 写进原因，被拒绝的令牌就会进逐条结果、页面和决策记录。ADR 没有要求原因只写原因码或不回显原文。
- 证据：
  - `0242:134`：“……拒绝时结果里写明原因。”
  - `0242:114`：“逐条返回结果：……不合格（附原因）……”
  - `0242:115`：“一批在一个数据库事务里写完，连同它的决策记录。”
- 建议：明确“原因只写固定原因码和类别，不回显项目名、用户名、密码、查询参数；需要排查时只记项目名的摘要或长度”。这与“宁可错拒”一致，也避免把拒绝变成新的泄密路径。
- 证据性质：ADR 文本是读到的；“会回显令牌”取决于实现，是推测。

### 7. 低：“第一次给主人看之前……试算一遍”与代码的实际多次回放不完全一致；作者说法 3 不准确

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:125`；`apps/agent-service/src/production-mcp-read.ts:722-723`、`:752`；`apps/agent-service/src/production-owner-rules.ts:585`、`:627`
- 问题：125 行说“一个参数合法的提议第一次给主人看之前，会用近 30 天的邮件试算一遍”。`preview` 确实回放，但 `#proposeRule` 在带状态的重发里如果 `answer.kind !== "elicit"` 会再次调用 `#askRuleConfirmation`，从而再次 `preview`；接受提议时 `accept` 走 `create`，`create` 又调用 `#replay`。所以同一个提议可能回放多次，不只是“第一次给主人看之前”。作者说法 3“第一次调用才走到它”也不准确，且第一次调用还需要 `proposals.ready()`。
- 证据：
  - `production-mcp-read.ts:722-723`：“if (answer.kind !== “elicit”) return await this.#askRuleConfirmation(...)”
  - `production-mcp-read.ts:752`：“const preview = await rules.preview(proposal);”
  - `production-owner-rules.ts:585`：“replay: await this.#replay(draft),”
  - `production-owner-rules.ts:627`：“const replayed = await this.#replay(draft);”
- 建议：ADR 改成“每次发出确认（包括重发）都会回放；接受并创建规则时还会再回放一次”，并让按接入的限频把重发确认也算作一次可计量的尝试，否则对方可以不换参数、只重发确认来反复触发回放。
- 证据性质：代码是读到的；限频计数规则是未来任务，未核实。

### 8. 低：规则提议计数窗口和“重发算不算一次”未定义

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:125`、`:169`、`:272`
- 问题：169 行说每个接入显示“提了几次、因为超过频率被拒几次”，272 行说“跟着变”“没提过规则的接入这两个数是 0”。但没有说这两个数是按天、按周还是累计，也没有说同一提议的重发确认算不算“提了一次”。这会影响页面和决定 13 的按天统计表怎么接。
- 证据：
  - `0242:169`：“2026-11-12 补：每个接入还显示规则提议提了几次、因为超过频率被拒几次（决定 7 的补注）。”
  - `0242:272`：“……规则提议超过这个接入的频率额度被拒，页面上这个接入‘提了几次’‘被拒几次’跟着变，没提过规则的接入这两个数是 0……”
- 建议：明确窗口（例如“按天，和决定 13 的统计表同键”或“累计”）以及重发确认是否计数；最好让计数和限频用同一个判定点，避免页面显示和限频口径不一致。
- 证据性质：未实现，未核实。

### 9. 低：作者“只定一件事”与文本实际决定的内容不符

- 文件:行：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:141`、`:208`、`:251-252`
- 问题：作者摘要说“这个 PR 只定一件事：点之前不显示预计费用，点了就筛”。但 141 行还决定了“筛失败不影响已存内容”“筛结果不进 Himari 自己的聊天”“待确认正文进一次独立后台调用”“ADR 0228 的‘确认前不用它’照旧”，252 行还决定了“这两处之外没有别的代码把待确认内容发给模型”。这些不是同一件事。
- 证据：
  - `0242:141` 的上述四句。
  - `0242:252`：“……这两处之外没有别的代码把待确认的内容发给模型。”
- 建议：作者摘要改成“这个 PR 只定手动筛的触发与费用展示，并给 0228/0246 加例外；自动筛和筛的存储/路由/限频另定”，不要用“只定一件事”概括。
- 证据性质：读文本证实的。

## 读代码证实的

- `packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:54-66`：`CATEGORIES` 九值 `identity`、`preference`、`relationship`、`goal`、`project`、`health`、`finance`、`event`、`other`，无 `rule`。作者说法 1 正确。
- `packages/gateway-contracts/src/contracts-v2.ts:1185-1201`：`MEMORY_CATEGORY_NAMES` 十字含 `rule`；`MEMORY_EXTERNAL_CATEGORY_NAMES = MEMORY_CATEGORY_NAMES.filter(category => category !== "rule")`。`contracts-v2.ts:1588` 在 `memoryOverviewSnapshotSchema.externalProposals.items.category` 使用它。作者说法 2 正确。
- 五份外部提议类别清单均为九值：`production-mcp-memory-writer.ts:46-56`、`sqlite-external-memory-proposal-operations.ts:54-66`、`data-export/schemas.ts:153-163`、`migrations/0093_external_memory_proposals.sql:10-15`、`contracts-v2.ts:1198-1201`。作者说法 C 的“五份”成立。
- `production-owner-rules.ts:569-587` 的 `preview` 调用 `#replay(draft)`；`production-mcp-read.ts:680-689` 第一次调用在 `elicitationSupported`、`proposals.ready()` 后进入 `#askRuleConfirmation`，`:752` 调用 `rules.preview`。作者说法 3 的“preview 会调回放试算”正确；“第一次调用才走到它”不准确（见问题 7）。
- `production-mcp-rule-writer.ts:16`：`EXTERNAL_RULE_TYPES = ["mail_must_notify", "mail_read_whole_thread"]`；`packages/application/src/rules/rule-types.ts` 的 `RULE_TYPES` 也是这两种，`RuleTypeDefinition.parse` 返回 `MailMatchParameters`，`writableRuleType` 以 `RULE_TYPE_UNTESTED` 拒绝无测试类型；`production-owner-rules.ts:458-467` 的 `#draft` 先调 `writableRuleType(type)`。ADR 0242:123-124 的说法与代码一致。
- `production-mcp-read.ts:324-327`：`ruleParameters` 用 `rule.id === "quiet_hours"` 和 `"floor_important_sender"` 决定 `rule_book` 参数；`:1263` 的 `#startHere` 只取 `enforcedOwnerRule(row)?.summary`。ADR 0242:99、:199 与代码一致。
- `docs/adr/0228:63` 原句在决定 1 下面；`docs/adr/0246:89` 原句在“后果”一节；`0242:251-252` 在后果的“对发给模型的请求”下。作者说法 4 正确。
- `git show --stat d3affcea` 只改 `.agents/reviews/pr-447/round-2` 和四个 ADR；`git diff --stat cc510cc..b773735` 也只有这四个 ADR 和复核记录。`645dc1c..b773735` 里的 CI 改动来自合并 `origin/main`（PR 441），不属于本 PR。作者“只改文档”成立。

## 推测 / 未核实

- **第 2 轮 10 条意见是否改到位：未核实。** `.agents/reviews/pr-447/round-2/judgments.md` 不在 sparse checkout 工作区，`git show` 对该路径被策略拒绝（`REVIEW_GIT_REFUSED records-path`），无法逐条对照。我只按增量文本和作者摘要 A–E 核对。
- **单斜杠/单反斜杠 URL 绕过**：基于标准 URL 解析器的行为，未在仓库里运行验证。
- **筛的模型分级路由、筛结果存储、筛的限频、筛的批大小/超时**：代码里没有筛的实现，全部未核实。
- **项目名长度上限、保留项目编号的具体值、项目名/编号的所有消费者**：尚未实现，无法逐个核对两端校验。
- **规则提议计数窗口和重发计数**：尚未实现，未核实。
- **“拒绝原因会回显令牌”**：取决于未来实现，未核实。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

不会改变 Himawari 自己对话请求的开头。本 PR 只改 ADR 和复核记录，没有代码。新增的“先帮我筛一遍”和“解析贴回的文本”被写成独立后台调用，固定指令在前、数据在后（0242:208、:251-252），不是往已有对话历史里插内容；ADR 0228、0246 的补注也明确“没确认的内容不进记忆、不进概况、不进对话请求”。唯一会变的是外部 agent 那边的 MCP 工具定义：0242:125 明说“登记表变了，对外 MCP 上 `propose_rule` 的工具定义跟着变一次；变的是外部 agent 那边的请求开头，不是 Himawari 自己的”。所以：**Himawari 自己的系统提示、工具定义、历史、遮盖结果都不变；新内容是追加的独立请求；外部 agent 的工具定义会变一次，ADR 已承认这个代价。**

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

大部分值是确定的：类别清单固定、项目名统一 `trim` + NFC、列表要求固定顺序（0242:208）、规则类型由登记表声明。但有两处未闭合：
- 新增筛调用把多条待确认正文放在一次后台请求里，现有对外遮法是整次请求一起遮（0219:73）。同一段正文的遮后字节可能随同批前面的条目变化；ADR 只写了“数据按固定顺序排”，没有说逐条独立遮盖。这一点是**推测的潜在问题**，需要在实现筛时明确。
- 项目名拒绝原因若回显原输入，同一段输入在不同请求里的“原因”字节可能不同，且可能把令牌带进结果/决策记录。ADR 没有禁止回显。
除此之外，NFC/trim 和固定排序的方向是正确的。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

没有。本 PR 是纯文档，没有新增可运行的检查。ADR 新增的测试条目（0242:267-275）都是“任务 B、C 先做出来再写用例”的描述，现在无法运行，也无法证明反向用例会失败。`npm run check:prompt-prefix` 只管 Himawari 自己的对话请求，管不到 MCP 和新增的后台筛调用；类别清单同步检查、项目名反向用例、规则类型反向用例都还没有代码。现有的 `packages/application/test/tentative-memory-capture.unit.test.ts:227` 只守 `THRESHOLD_CATEGORIES === MEMORY_CATEGORIES`，不覆盖本 PR 关注的五份外部提议清单。**结论：自动检查尚未落地；反向用例只是文字，不能验证会失败。**

**4. 每个值的使用方都能接受吗？**

- **类别值**：已核对五份外部提议清单都是九值，等于 `MEMORY_CATEGORIES` 去掉 `rule`；`production-mcp-read.ts:532/818` 的工具 schema 和写入校验、`sqlite-external-memory-proposal-operations.ts:54` 的存储校验、`0093` 的 CHECK、`data-export/schemas.ts:153` 的导出 schema、`contracts-v2.ts:1588` 的网页快照校验，都接受这九值。**这部分两端一致。**
- **规则类型值**：当前 `EXTERNAL_RULE_TYPES` 两种与 `RULE_TYPES` 的两种一致；`writableRuleType` 的测试门槛、`#draft` 的调用链也一致。**当前值两端一致。**
- **项目名/项目编号**：尚未实现，长度上限、保留固定编号、`machineString` 校验、页面和 `find_memories` 的消费方都无法逐端核对，**未核实**。
- **用量计数**：尚未实现，窗口和重发计数未定义，**未核实**。
- **类别检查本身**：外部提议清单的做法正确，但“全仓库再搜一遍”若把含 `rule` 的内部记忆类别清单也纳入“等于 `MEMORY_CATEGORIES` 去掉 `rule`”的检查，会误报；建议按问题 5 拆成两类。
- **项目名拒绝原因**：可能把令牌带进结果和决策记录，建议只写原因码（问题 6）。
