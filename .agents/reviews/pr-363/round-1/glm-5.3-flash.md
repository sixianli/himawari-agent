# 复核报告（e83d5bb2，基准 979a3121）

## 按严重度排列的发现

**1. 中｜sqlite-proactive-operations.ts:341｜作者说法「writeRule 只在参数改变时才被调用（读写之间用修订号比较）」与代码不符**
- 证据：`if (current && current.parameters === parameters) return;`（第 341 行）。writeRule 由 writeSettings **每次保存都调用**（第 300、312 行），参数相同只是提前返回；比较的是序列化参数的**字节相等**，不是修订号。整个设置读写路径也没有修订号并发控制：`proactive.settings.set` 契约里没有 `expectedRevision`（contracts-v2.ts:494-501），production-proactive.ts:436-448 直接落库。
- 结论：「未改变的退休规则保持退休是原有行为、本 PR 没变」这一点**成立**（我用 `git show 979a3121:...sqlite-proactive-operations.ts` 核对过基准代码，ON CONFLICT 同样不设 status、同样提前返回），但「用修订号比较」的机制描述是错的，实际靠的是参数字节比较。顺带说明：正因是字节比较，参数里不含时间戳（时间在 `updated_at` 列，不进 `parameters`），重复保存不会误增修订号——这条链路是自洽的。

**2. 低｜提交 e83d5bb2 说明｜Fast-mode-checks 行没有记录基本检查**
- 证据：提交说明只有 `Fast-mode-checks: validate_docs.py --strict 错误数不变（13）`，而 .agents/instructions/delivery-mode.md 要求该行列出实际运行过的基本检查（`npm run check` 等）和主机、版本。
- 推测：可能跑过没写；按提交记录无法证实。建议补记或说明。

**3. 低｜docs/adr/0184-back-off-ignored-proactive-pushes.md:38｜正文仍引用已删除的列**
- 证据：新加的括号注明「迁移 0086 起，重要发件人改存 rule_book_rules」（与 0086_rule_book.sql:40-46 一致，属实），但前文仍写「和 `proactive_settings.important_senders` 同级」，该列已随 0086 删除（0086_rule_book.sql:65-67）。建议改成「和 rule_book_rules.parameters 同级」之类的现役表述。

**4. 信息｜sqlite-proactive-operations.ts:341｜退休规则 + 参数不变 = 保持退休，且 readSettings 回落默认值**
- 证据：`readSettings` 只取 `status = 'active'` 的规则（第 233 行），取不到就回落默认静默时段 23:00–07:00 和空发件人（第 244-257 行）。
- 目前**没有任何生产代码路径会写入 status='retired'**（全仓 grep，只有新测试直接 `UPDATE ... SET status = 'retired'`），所以这是第 4 步规则页的预留行为。届时「主人重新保存了完全相同的值，规则仍然退休」是否符合直觉，建议在第 4 步明确写下来。

## 侧重检查（普通流程走查 + 测试/文档核对）

走的流程：设置页改静默时段 → `proactive-settings.tsx`（本地校验时钟/天数；`MAXIMUM_PERIODS = 8`，第 24、155 行，8 段时隐藏添加按钮）→ `proactive.saveSettings`（control-center/src/proactive.ts:241）→ 网关契约解析（contracts-v2.ts:494-501，≤8、时钟、天数去重）→ production-proactive.ts:436-448（天数去重排序、发件人规范化）→ durable-adapters.ts:975 → `writeSettings`（262-326 行二次校验）→ `writeRule` ×2 → `rule_book_rules` + `rule_book_history`。

- 测试覆盖（全部为**读代码判断**，本环境只允许 git 命令，**没有实际运行任何测试**）：
  - 退休恢复用例（rule-book-store.test.ts:121-151）：在基准代码上 ON CONFLICT 不设 status，`DISTINCT status = ['active']` 断言必失败 → 反向用例有效。
  - 9 段拒绝用例（同文件 153-172）：基准上限 14，9 段不会被拒，`rejects.toThrow()` 必失败 → 反向有效。
  - 迁移契约测试的删 Agent 断言（147-153 行）：行为 0086 本来就有（FK `ON DELETE CASCADE`，且 no_delete 触发器的 WHEN 条件在 Agent 已删时放行，0086_rule_book.sql:28-31），属回归护栏，不是新行为。
  - rule-registry 14→8（unit.test.ts:90）：只是让「store 接受的最大设置」用例与新上限一致，不构成反向用例。
  - 走查中**未核实**的路径：production-proactive.ts:436-448 的映射细节（`normalizeSender` 等，proactive-production.test.ts:597 有 settings.set 用例但未逐行读）；UI「8 段隐藏按钮」是否有交互测试。

## 必答问题

1. **不会。** diff 只碰持久层、测试和 ADR 文档，系统提示、工具定义、历史消息、遮盖结果均未涉及，[prompt-prefix 规则](../../.claude/rules/prompt-prefix.md)不适用；ADR 0209 里「`check:prompt-prefix` 不受影响」一句是原有行，与本 PR 无冲突。
2. **不会。** 静默时段写入前 days 排序（sqlite-proactive-operations.ts:304-308），网关侧也先去重排序（production-proactive.ts:440-444）；`status = 'active'` 是固定字面量；时间戳不进 `parameters`。同一输入每次序列化字节相同，无序集合不参与序列化。
3. **有，且反向用例经推演有效**（见侧重检查），但我在本环境无法运行测试，「测试通过」未核实。提交说明也按 Layer-0 规则声明了 4 个测试文件。
4. **逐值核对，均一致**：「8」的上限在存储（:267）、网关契约（contracts-v2.ts:347，写入命令与总览快照两处共用）、UI（proactive-settings.tsx:24）三处对齐，testing 包无第二套 proactive 实现（grep 无 quietHours）；`status='active'` 的消费方 readSettings（:233）、RuleJudge（rule-judge.ts:27）、历史行（:357）、0086 CHECK 约束两端一致；ADR 0209 的「迁移 0086 删两列不可逆」（0086:65-67）、「迁移引擎要求快照」（migration-engine.ts:928、851-857，仅 currentSequence>0 时）、「已应用迁移不能改」（digest 校验，:810-824）均与代码相符；「回退脚本沿用这一条」**未核实**（未找到回退脚本，未穷尽搜索）。
