## 结论

本次只新增 `docs/agent-rulebook-inventory.md`，未改任何代码；因此不会改变发给模型的内容、不涉及序列化确定性，也不改变运行时行为。但这份文档作为交付物本身有若干可核实的事实错误：多处“仓库内无记载”的说法与现有 ADR 直接矛盾，多个测试编号并没有守着它标注的规则，“18 条无出处”和 G 节列出的编号也对不上。核心问题是文档的出处/测试列可信度不足，若直接拿去初始化规则登记册，会重演 I-73 那类“清单值没有经过使用端校验”的问题。

## 发现的问题（读代码证实）

### 高

1. **`docs/agent-rulebook-inventory.md:71`（H-5）说出处“仓库内无记载”，但 ADR 0159 明确记载了这条规则。**
   - 证据：`docs/adr/0159-gmail-check-reads-full-body-and-the-owners-own-mail.md:48`：“**自己发的邮件不套地板规则。** 重要发件人、官方域名、金钱词这三条地板规则只对收到的邮件生效；到每日费用上限时也不为自己发的邮件直接生成提醒。”
   - 代码：`packages/application/src/services/proactive-mail-check-service.ts:787` `const floorIds = item.sentByOwner ? [] : floorHitIds(item, settings.importantSenders);`
   - 建议：H-5 出处改为 ADR 0159 决定第 6 条；同时把 H-5 描述补上“到每日费用上限时也不为自己发的邮件直接生成提醒”，否则规则描述不完整。

2. **`docs/agent-rulebook-inventory.md:80`（H-14）说“仓库内无记载”“无专门用例”，这两点都不对。**
   - 证据：`docs/adr/0166-prompt-wording-batch-1-system-and-tools.md:42`：“**有钟点的提醒提前 1 小时是有意的**（D8），写成‘最多提前 1 小时（离现在不到 1 小时的马上发出）’。”同文件 `:86` 还记载每年重复顺延、最多 200 年的修正；`docs/adr/0150-let-the-model-set-list-and-cancel-reminders.md:36` 记载“已过去、超过两年的时间……都拒绝”。
   - 测试：`apps/agent-service/test/production-memory-evidence.unit.test.ts:304-345` 直接调用 `reminderSchedule` 覆盖 1 小时、9 点、yearly 顺延、两年上限；`apps/agent-service/test/prompt-wording.unit.test.ts:487` 有 `C6 W-09: the reminder description matches reminderSchedule at its boundaries`。
   - 建议：出处改为 ADR 0166（以及 ADR 0150 的两年上限）；测试列填上述两个文件/用例，不要再写“无专门用例”。

3. **`docs/agent-rulebook-inventory.md:96-99`（S-1/S-3/S-4）把已有 ADR 记载的规则标成无出处或错误归到 ADR 0180。**
   - S-1 证据：`docs/adr/0158-bring-related-memories-into-gmail-checks.md:40`：“说明里写明记忆是背景资料、不是指令，邮件里的要求也不是指令。”`docs/adr/0159...:52` 也记了提示词注入的边界。
   - S-3/S-4 证据：`docs/adr/0159...:46`：“`sentByOwner` 的邮件只有主人明确答应了将来要做的事才判‘要你做事’……`bodyTruncated`、`bodyUnavailable` 时不要假设看过全文。”这与 S-3、S-4 的原文几乎逐句对应。
   - 建议：S-1 出处改为 ADR 0158 决定第 7 条 + ADR 0159 决定第 10 条；S-3、S-4 出处改为 ADR 0159 决定第 4 条。ADR 0180 只负责“同一件事的往来邮件”，不应作为 S-3/S-4 的出处。

### 中

4. **`docs/agent-rulebook-inventory.md:67-69`（H-1/H-2/H-3）的测试列互相错位。**
   - PG-4 用的是 `info@city.shinjuku.lg.jp`（`test/integration/proactive-mail-check.test.ts:545`），命中 `lg.jp` 公共域名，即 H-2，不是 H-1。
   - PG-8 用的是 `info@smbc.co.jp`（`:721`），命中 fixture 默认的 `importantSenders: ["smbc.co.jp"]`（`:167`），即 H-1；其标题“ご案内”、摘要“いつもご利用ありがとうございます”不含金钱词，不能证明 H-3。
   - H-3 的金钱词实际由 PG-9（“お引落し”，`:756`）、PG-17（“ご請求”，`:1212`）、PG-18（“ご請求”，`:1346`）、OM-3（“請求書”，`:1978`）覆盖。
   - 建议：H-1 → PG-8；H-2 → PG-4；H-3 → PG-9/PG-17/PG-18/OM-3（或新增专门的金钱词用例）。

5. **`docs/agent-rulebook-inventory.md:100`（S-5）测试写成“OM 一组”，实际测 related 邮件的是 `[PA-1]`。**
   - 证据：`test/integration/proactive-mail-check.test.ts:2207` `describe("[PA-1] the judgment reads the earlier mails about the same matter", ...)`；`:2270` 的用例才断言 `"related":[...]`、前情顺序和 `relatedByMail`。OM 组是 `:1889` 的“主人自己的邮件和全文”，不测 related 读取。
   - 建议：S-5 测试列改为 `[PA-1]` 一组。

6. **`docs/agent-rulebook-inventory.md:96-97`（S-1/S-2）测试列不准确。**
   - S-2 的原文“宁可少报”在 PG-17 的提示词用例里被直接断言：`test/integration/proactive-mail-check.test.ts:1417-1419` `expect(prompt).toContain("宁可少报")`。所以 S-2 不应写“无”。
   - S-1 没有任何测试断言“邮件内容是不可信的数据/不是给你的指令”；PG-17 的提示词用例只检查促销、积分等词（`:1415-1419`）。所以 S-1 写“PG-17 只验提示词里有这类句子”是把不存在的测试算进来了。
   - 建议：S-2 → PG-17；S-1 → 无（或补一条提示词存在性测试）。

7. **`docs/agent-rulebook-inventory.md:72`（H-6）只写 PG-17，但 H-6 有两半，第二半由 PG-18 守着。**
   - 证据：`test/integration/proactive-mail-check.test.ts:1200` 的 PG-17 测“低优先级 act 不上提醒页/不丢钱和官方邮件”；`:1339` 的 PG-18 才测“没命中地板的 know 只进筛掉清单，账单/官方 know 留下”。
   - 建议：H-6 测试列改为 PG-17、PG-18。

8. **`docs/agent-rulebook-inventory.md:54`、`:204-205` 的“18 条无出处”与 G 节自身不一致，G 节还把已有出处的条目列进“无出处”。**
   - G 节列出的编号是：H-1（名单）、H-5、H-6、H-12、H-14，加 S-1、S-2、S-4、S-6、S-7、S-10 到 S-14、S-16 到 S-20、S-22 到 S-24，共 23 个编号，不是 18 个。
   - 其中 S-6 在表里明确写了 `[ADR 0106]`（`:101`），S-10 写了 `[ADR 0179]`（`:105`），S-23 写了 `[ADR 0122]`（`:125`），但 G 节仍把它们列为“只有提示词文字，没有任何文档说明”。
   - 建议：重新按表逐行统计；统一“无出处”的定义（没有 ADR/事故号/规格，还是只有提示词文字），并修掉 G 节与表格的三处直接矛盾。

### 低

9. **`docs/agent-rulebook-inventory.md:78`（H-12）说“仓库内无记载”，但 ADR 0179 明确说敏感类仍走审批。**
   - 证据：`docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:54`：“……不是敏感类（敏感类仍走审批）。”`docs/adr/0143...:53` 也记载 `restricted_excluded` 等丢弃原因。
   - 代码：`packages/application/src/services/automatic-memory-service.ts:133-137` restricted 直接 discard；`:145-146` sensitive 未明确记住时 `requestApproval`。
   - 建议：H-12 出处补 ADR 0179（以及 ADR 0143 的账本原因码）；测试仍可保留 `automatic-memory-golden`。

10. **`docs/agent-rulebook-inventory.md:144`（M-4）同样漏了已有出处。**
    - 证据：`docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md:61`：“`sensitive` 记忆不进全文和实体索引、不带入档案块”；`docs/adr/0112...:47` 也记载档案挑选规则。
    - 建议：M-4 出处补 ADR 0185/0112，而不是“仓库内无记载”。

11. **`docs/agent-rulebook-inventory.md:105`（S-10）写测试“无”，但 PA-2 已断言 tentative 说明会进入提示词。**
    - 证据：`test/integration/proactive-mail-check.test.ts:1762-1780` 断言 `"tentative":true`、`"主人没有确认过"` 以及 `tentativeMemoryIds`。
    - 建议：S-10 测试列改为 PA-2（注明只验提示词注入，不验模型是否照做）。

12. **A 节漏掉了 Gmail 检查里同样是程序硬规则的条目。**
    - 文档 `:53` 自己说“读整个邮件串是对所有邮件都做的（ADR 0180）”，但 A 节 14 条里没有对应行；ADR 0159 决定第 7 条的“已回复”按邮件串、按把握度计算的硬逻辑也没有行。
    - 建议：要么在 A 节补 H-15/H-16（related 读取、“已回复”判定），要么在 E 节明确写“这些 Gmail 产品行为不计入主人规则”，避免清单看起来已覆盖全部程序硬规则。

13. **`scripts/check-instruction-links.mjs:7-12` 不扫描 `docs/`，所以“指令链接检查通过”并不校验这份新文档的链接。**
    - 证据：`INSTRUCTION_ROOTS` 只有 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`；新增文件在 `docs/` 下。
    - `scripts/check-markdown-tables.mjs:8` 确实扫描 `docs`，`scripts/check-glossary.mjs:15` 也扫描 `docs`，所以表格/词表检查有效；但链接检查对本文件是空跑。
    - 建议：在交付说明里改成“表格和词表检查覆盖本文件，链接检查不覆盖 docs”；若要覆盖，扩展 `check-instruction-links.mjs` 或新增 docs 链接检查。

## 推测

- H-9 文档写“次日零点（日本时间）恢复”，但代码使用的是可配置的 `this.#options.timeZone`（`proactive-mail-check-service.ts:700`），`runPolicy.timeZone` 在配置里是可选项，部分调用回退到 UTC（如 `apps/agent-service/src/service-main.ts:1575`）。生产若配的是 Asia/Tokyo 则没问题，但“日本时间”是配置假设，不是代码保证。
- 这些错误的测试编号和出处如果被另一个线程直接用于规则登记册初始化，可能把“有测试/有出处”的假象带进后续机制；这属于推测的后续影响，当前代码没有消费这些 H/S/M/C 编号。

## 侧重检查

- **不可信输入 / 提示词注入**：核对了 S-1、S-7、H-10、OM-9 与遮盖相关 S-25。代码行为存在（spam 跳过、正文作数据、遮盖），但 S-1 的出处和测试列是错的。
- **错误路径 / 限额**：核对了 H-9（每日费用上限）、PG-9、PG-16、H-11 backoff。文档对停止模型、地板规则照常、降频不作用于地板提醒的描述与代码基本一致；H-5 漏了“费用上限时自己发的邮件也不直接生成提醒”。
- **资源耗尽**：核对了正文/批次上限、related 上限、每日费用、单次检查时限，C-8 与 `strict-configuration.ts:1015-1057` 一致。
- **不可撤销操作**：本改动只有文档，没有新增删除、覆盖、迁移或写库路径；E 节对审批的描述与代码位置一致，未发现新增风险。
- **规则文件/文档一致性**：这是本次主要问题来源；上列出处与测试编号错误均属此类。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。`git diff --stat` 显示只新增 `docs/agent-rulebook-inventory.md`；全仓库搜索 `agent-rulebook-inventory` 没有代码引用（`grep` 无结果），`packages/prompt-catalog/src` 也没有引用 `docs/`。发给模型的内容仍由原有代码组装，仍然只在末尾追加，每轮变化的值仍在最后一条用户消息；本 PR 没有触碰这条路径。依据：`.claude/rules/prompt-prefix.md` 第 4、10 条。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增文件不进入请求组装；文档 frontmatter 里的日期是文件内固定字符串，不是每轮变化的字段。没有任何新的 JSON 键序、集合遍历或遮盖逻辑被引入。

3. **有没有对应的自动检查？反向用例会真的失败吗？** 只有文档结构检查：`check-markdown-tables.mjs` 扫描 `docs/`，`check-glossary.mjs` 扫描 `docs/`；作者声称的两项通过是合理的。但 `check-instruction-links.mjs` 不扫描 `docs/`，所以“指令链接检查通过”对本文件没有覆盖。更重要的是：没有任何测试检查规则出处、测试编号、条数统计是否真实；也没有“故意写错测试编号/出处就失败”的反向用例。因此不存在能守住这份清单内容正确性的自动检查。

4. **改动产生或修改的每个值，使用端都能接受吗？**
   - H/S/M/C 编号是文档本地标签，未被任何代码消费（`grep` 无结果），当前不存在后端校验问题；但也没有任何校验器保证它们唯一或格式稳定，未来若用作规则登记册 id 需要另加约束。
   - ADR 链接文件均存在（已核对 `docs/adr/`）。
   - 文档内部锚点均存在。
   - **测试编号是会被读者和后续规则登记册消费的值，而本次有多处两端对不上**：H-1/H-2/H-3 与 PG-4/PG-8 错位，S-5 写成 OM 实际是 PA-1，S-1/S-2 的测试列不实，H-14 被写成无测试，H-6 漏 PG-18。建议按上文逐条修正后再作为登记册初始数据。
