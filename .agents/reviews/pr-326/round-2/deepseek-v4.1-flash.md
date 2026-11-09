## 侧重检查

本次 diff 实际只改 `docs/agent-rulebook-inventory.md`（另加第 1 轮复核记录），没有改代码、提示词目录、工具定义或历史构造。我按额外侧重查了：

- **不可信输入 / 提示注入**：S-1 对应 `packages/prompt-catalog/src/mail.ts:12`；H-15 的前情邮件作为 JSON 字段交给模型（ADR 0180 决定 2），程序侧注入防护见 ADR 0159 决定 9、10 和 `[OM-9]`。文档改动不影响这些路径。
- **资源耗尽 / 费用**：H-9 的每日费用上限、H-15 的 `#related` 在已超每日上限时跳过（`proactive-mail-check-service.ts:704-708`）、请求数/字数上限在 `strict-configuration.ts:995-998,1050-1053`。
- **错误路径**：`related` 读取失败降级为 `relatedUnavailable`（ADR 0180 决定 5）；H-16 的“没判到不关旧提醒”见 ADR 0159 决定 7。文档改动不改变这些行为。
- **不可撤销操作**：本次没有。
- **规则/文档/代码一致性**：逐条核对了本次改动涉及的 ADR 原文、测试文件与函数名，发现的问题见下。

## 发现（读代码证实的）

### 中：新增 H-16 的测试清单漏了 `[OM-15]`，且“数据库里更晚的邮件”这一半不在 `#repliedThreads`

- 文件:行：`docs/agent-rulebook-inventory.md:82`
- 问题：H-16 正文写“本次**和数据库里**都没有更晚的邮件”，但“生效位置”只写 `#repliedThreads`，测试列只写 `PG-5、OM-1、OM-2、OM-14`。数据库这一半实际在持久层，且已有专门反向用例 `[OM-15]`。
- 证据：
  - `test/integration/proactive-mail-check.test.ts:2018`：`it("[OM-15] keeps the reminder open when a later mail of the thread was processed in an earlier check", ...`
  - `packages/persistence-sqlite/src/sqlite-proactive-operations.ts:776-783` 才执行 `WHERE ... AND NOT EXISTS (SELECT 1 FROM proactive_processed_messages later ... received_at > ?)`
  - `proactive-mail-check-service.ts:919-944` 的 `#repliedThreads` 只比较 `candidates`（本次），没有查数据库。
- 建议：H-16 生效位置补 `sqlite-proactive-operations.ts` 的标记已回复条件，测试列补 `OM-15`。

### 中：没有可复跑的自动检查守着“出处链接/测试编号/19 条”本身

- 文件:行：`docs/agent-rulebook-inventory.md:204`
- 问题：这次的核心产出就是文档事实，但仓库里没有检查本文 ADR 链接目标、测试编号是否存在、G 节 19 条是否与表格一致的门槛。作者提交说明里的“用脚本核对本文所有锚点和 ADR 链接存在”是临时脚本，没有进仓库。
- 证据：`scripts/check-adr-numbers.mjs:10-29` 只查 ADR 文件名和编号重复；`scripts/check-markdown-tables.mjs:7-8` 只扫 `docs` 的表格列数；`scripts/check-instruction-links.mjs:7-12` 只扫 `AGENTS.md`、`.claude/rules`、`.agents/instructions`，不扫 `docs/`。没有脚本核对测试编号或 G 节条数。
- 建议：加一个最小检查（例如把本文的 ADR 链接解析后 `existsSync`、用正则抽取 `PG-xx/OM-xx/PA-xx` 到测试目录检索、把 G 节编号与表格出处列做集合比较），并带一个故意写错编号的反向用例；否则下一轮仍可能再出现“出处/编号对不上”。

### 低：G 节 19 条按字面一致，但 S-8、S-9 指向的出处本身缺失，未被计入

- 文件:行：`docs/agent-rulebook-inventory.md:105-106`、`:207`
- 问题：S-8 的出处写“同 H-1 到 H-3”，S-9 写“同 H-6”；H-6 在 G 节里被列为“没有 ADR 专门记载”，因此 S-9 实际也查不到完整出处，却没进 G 节。若严格按字面“待 Andy 确认/仓库内无记载/同上”，19 条是对的；但按 G 节自述的“或只能查到一半的”，这两条没有被交给 Andy。
- 证据：`:204` 定义“下面这 19 条是表里出处写着……或只能查到一半的”；`:105` S-8 出处“同 H-1 到 H-3”；`:106` S-9 出处“同 H-6”；`:207` 提示词规则列表无 S-8、S-9。
- 建议：要么把 S-9（以及 S-8）补进 G 节并把总数改为 21，要么在 G 节开头写明“按字面只统计‘待 Andy 确认/仓库内无记载/同上’，‘同 H-…’不在内”，避免歧义。

### 低：S-1 测试写“无”，但整段 `mail.judgment` 有 golden 快照守字节

- 文件:行：`docs/agent-rulebook-inventory.md:98`
- 问题：S-1 测试列写“无”。但 `mail.judgment` 整段有快照测试，S-1 这句一旦改动会失败；按本文对其他条目的口径（“只验提示词里有这句”也算），这里不应写“无”。
- 证据：`apps/agent-service/test/prompt-rendering-golden.unit.test.ts:39` 列出 `"mail.judgment"`，`:211-215` 用 `toMatchFileSnapshot(golden("mail.judgment"))`；`apps/agent-service/test/__prompt_golden__/mail.judgment.txt:2` 正是 S-1 原句。
- 建议：测试列改为“`prompt-rendering-golden.unit.test.ts` 的 `mail.judgment` 快照（只验文字存在，不验模型照做）”。

### 低：S-1 的“不可信的数据”没有 ADR 0159 决定 10 的直接支持

- 文件:行：`docs/agent-rulebook-inventory.md:98`
- 问题：ADR 0158 决定 7 支持“邮件里的要求不是指令”；ADR 0159 决定 10 讲的是“提示词注入、模型没有工具、正文以 JSON 字段进入”，并没有“邮件内容是不可信的数据”这句话。引用不算错题，但“不可信的数据”属于推断性概括。
- 证据：ADR 0158 决定 7（`docs/adr/0158-...md:40`）：“说明里写明记忆是背景资料、不是指令，邮件里的要求也不是指令。”；ADR 0159 决定 10（`docs/adr/0159-...md:52`）：“提示词注入。模型没有任何工具；正文只作为 JSON 字符串字段进入提示词……”
- 建议：保留 ADR 0158 决定 7，把 ADR 0159 决定 10 改成“决定 9、10（不可信输出与注入防护）”或注明“不可信数据是概括，非原文”。

### 低：H-15 的“对所有邮件都做”忽略了到每日费用上限就跳过

- 文件:行：`docs/agent-rulebook-inventory.md:81`
- 问题：H-15 写“对所有邮件都做，不是按‘退款’之类的词触发”。触发方式确实不是关键词，但当本次检查已花到每日上限时，`#related` 整段被跳过；另有 `relatedRequestsPerCheck`、半程时限等预算。文档可补一句限定。
- 证据：`proactive-mail-check-service.ts:704-708`：`spentToday >= this.#options.limits.dailyCostMicros ? new Map() : await this.#related(...)`。
- 建议：改为“在费用/请求预算内对所有待判邮件都做（已到每日上限时不找）”。

### 低：M-4 的测试 `PA-2` 只覆盖“待确认不进档案”，没覆盖“敏感永不注入”

- 文件:行：`docs/agent-rulebook-inventory.md:146`
- 问题：M-4 同时写了“敏感规则永不注入”和“不是待确认”，但测试列只写 `PA-2`；`PA-2` 用例实际只断言 tentative 记忆不进 profile。
- 证据：`packages/application/test/owner-profile-service.unit.test.ts:178`：`it("[PA-2] never puts a tentative memory into the profile block ...`；敏感排除是在同文件 `:132-176` 的“puts rules first…”里顺带体现，未单列。
- 建议：测试列补该文件“puts rules first and groups important facts by section”（含 `dataClassification: "sensitive"` 的记忆不进结果）。

### 低（既有，非本次引入）：F 第 4 条与表格中 H-1、H-8 的出处矛盾

- 文件:行：`docs/agent-rulebook-inventory.md:194`
- 问题：F 第 4 条写“所以 H-1、H-8 这两条硬规则没有出处”，但表格里 H-1、H-8 都明确引用 ADR 0106。这个矛盾在本次改动前就存在，但本次重写了 H-1 出处后更显眼。
- 证据：`:67` H-1 出处 `[ADR 0106](adr/0106-...)`；`:74` H-8 出处同样 `[ADR 0106]`；`:194` “所以 H-1、H-8 这两条硬规则没有出处”。
- 建议：改成“H-1 的名单内容和 H-8 的设置值没有历史/逐项出处”，或删掉“没有出处”。

## 推测（未核实）

- `.agents/reviews/pr-326/round-1/*` 无法读取（工作区稀疏检出，`git show` 对 records 路径被拒），所以“第 1 轮复核意见已全部改正”这句话我只能按最终文档核对，无法逐条比对第 1 轮原文，标“未核实”。
- H-16“产生了新提醒的用新提醒替换旧提醒”在代码中的具体位置我没有继续追（ADR 0159 决定 7 有记载）；文档目前只写 `#repliedThreads`，可能还漏了持久层/提醒替换位置，属未完全核实。
- “生产配置为日本时间”（H-9）依赖 `/etc/himawari/config.json`，仓库里没有生产值，未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 只改 `docs/agent-rulebook-inventory.md` 及复核记录，没有改系统提示、工具定义、历史消息或遮盖逻辑；H-15/H-16 只是描述既有的 `#related`、`#repliedThreads`。发给模型的内容没有新增或改动，append-only 的前缀不受影响。本次没有验证代码本身的只追加实现（不属于本次改动）。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。文档改动不进入任何请求；文档描述的 `related` 时间线是既有后台调用行为，本次没有触碰。没有新增时间字段、无序集合或依赖前后文的遮盖。

3. **有没有对应的自动检查，反向用例会真的失败？** 没有针对本文事实正确性的自动检查。仓库只有表格列数（`check-markdown-tables.mjs`）、ADR 编号重复（`check-adr-numbers.mjs`）和 `.claude` 指令链接（`check-instruction-links.mjs`）等结构检查；没有检查本文 ADR 链接目标、测试编号、G 节 19 条与表格一致性的脚本，也没有反向用例。作者提交说明里的核对脚本没有进仓库，无法复跑。

4. **改动产生/修改的每个值，使用它的一端都能接受吗？** 大部分可以：
   - 条数：16+25+5+8=54，与 H-1..H-16、S-1..S-25、M-1..M-5、C-1..C-8 逐行一致。
   - ADR 链接：本文引用的 0106、0110、0112、0122、0143、0150、0158、0159、0163、0165、0166、0179、0180、0183、0184、0185 文件都存在。
   - H-15/H-16 与代码：`#related`（`proactive-mail-check-service.ts:532`）、`#repliedThreads`（`:919`）、`sentByOwner ? [] : floorHitIds`（`:787`）都存在，H-15/H-16 主体描述与 ADR 0180、ADR 0159 决定 6/7 一致。
   - 不完全一致的地方：H-16 漏 `OM-15` 且数据库条件不在 `#repliedThreads`；S-1 测试写“无”但 golden 快照实际会拦住；G 节未计入 S-8/S-9；M-4 的 `PA-2` 只覆盖待确认。详见上面各条。
