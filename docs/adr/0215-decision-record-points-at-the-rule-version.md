---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "packages/application/src/rules/rule-book.ts, packages/application/src/services/automatic-memory-service.ts, packages/application/test/rule-version.unit.test.ts, packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql, test/integration/decision-chain.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0215：决策记录指向真正执行了的那一版规则

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P2-7 要求：决策记录（Himawari 每次拿主意留下的一行，见[词表](../glossary.md)）里“命中了哪条规则”这一栏，要指向真正执行了的硬规则；记忆候选类记录的这一栏不再放丢弃原因；“依据”抽屉的规则一环显示规则原文、出处和测试状态。

动手前核对 main 时发现两件事，已告诉 Andy：

- 任务块写的“规则类型（一类硬偏好的执行逻辑，带测试）”出自 [ADR 0163](0163-owner-preferences-as-data-run-by-tested-rule-types.md)。[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 之后，规则是规则手册里的一行 CEL 表达式（Google 的一种受限条件写法），由一个裁判统一计算，代码里没有按类型分的执行程序。每条规则的“测试”是它自带的“该命中 / 不该命中”例子；重要发件人、静默时段这两条由设置生成的规则，例子是空的。
- 邮件检查记录这一栏只记了地板规则的编号，不带修订号；“小额不推送”的命中只记在另一个字段，抽屉不显示；静默时段把推送压后时完全没记。记忆候选的丢弃记录则把丢弃原因代码塞进了这一栏。

Andy 2026-11-11 在选择卡上选了“实算例子并补空的”：抽屉打开时用那一版规则的例子当场计算；空的例子由程序按设置值生成。随后对变更清单回复“同意”。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 规则手册每条规则有固定 id、修订号、出处和只追加的历史：[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 决定 2，“每条有固定 id、修订号、表达式、结果、出处、状态”。
2. 设置派生的规则只存参数，表达式由程序生成：ADR 0209 决定 2，“这两条的表达式不存库，由程序按存下来的参数生成，所以参数是唯一来源”。
3. 回归测试按规则类型写，不按每条偏好写：ADR 0163 决定 1，“每条偏好的执行，由它所属规则类型的程序和测试来保证”；ADR 0209 决定 6 写明 ADR 0163 的决定 1、2、3 不变。
4. 规则可以来自一条规则类记忆，并有“待重审”状态，待重审的规则照常执行：[ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md) 决定 1、2。
5. 改动前，记忆候选丢弃记录的规则字段写的是丢弃原因：`packages/application/src/services/automatic-memory-service.ts`（改动前第 572 行）`inputs: { memoryIds: write.inputs.memoryIds, ruleIds: [reasonCode] }`。
6. 规则重审记录由数据库触发器写，规则字段只有规则 id：`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql`，`json_object('memoryIds', json_array(OLD.id), 'ruleIds', json_array(rule_id), ...)`。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **记录写“规则 id@修订号”。**邮件检查记录的 `ruleIds` 写每条真正起了作用的规则和它当时的修订号：三条地板规则、“小额不推送”、把推送压到静默时段结束的静默时段规则。按邮件记的 `floorHits` 不变，仍是不带修订号的地板规则 id（[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 前提 4 要求这些 id 不变）。修订号为 0 表示主人从没改过设置、用的是程序默认值。
2. **记忆候选记录的 `ruleIds` 为空。**丢弃原因只在 `reasonCode` 里。这类记录现在没有任何硬规则参与。
3. **规则重审记录不改触发器。**它只记规则 id；读取时显示这条规则的当前版本，并写明“只记了规则名，显示的是现在的版本”；查不到当前版本时不写这句，只显示“这一版的规则内容查不到”。改触发器要做迁移，不值得。
4. **读取时按版本查规则手册。**读决策记录的同时，按 `ruleIds` 去 `rule_book_history` 查那一版（只有 id 的查 `rule_book_rules` 的当前版本；修订号 0 用程序默认值）。不改表结构，不加迁移。内置规则按代码里的版本，修订号对不上就如实显示“这一版的规则内容查不到”。
5. **抽屉每条规则显示：**
   - 规则种类：重要发件人、公共机构、钱相关词、静默时段、小额不推送；不认识的 id 显示原 id 和“未登记的规则”。
   - 规则原文：规则来自规则类记忆时，显示那条记忆的文字（受限档照旧隐藏）；规则内容显示当时的参数，例如发件人名单、静默时段、内置规则的后缀和词表，全部从规则手册动态取，不在界面里写死。
   - 出处：规则自带的出处、修订号、生效时间，“待重审”标记。
   - 测试状态：用那一版规则的例子当场计算，显示“N 条例子全部通过”“第 k 条例子不符”“这条规则没有例子”或“查不到”。
6. **重要发件人和静默时段的例子由程序按设置值生成。**重要发件人：名单里前三项各生成该命中的地址（域名项另加一个子域名），再加一个名单外的地址；静默时段：每个时段的起点、起点前一分钟、终点前一分钟、终点。每个例子该不该命中由另一段独立写的程序判断，再和 CEL 表达式的结果对照，所以生成表达式的代码写错时例子会不符。表达式和执行都不变。
7. **门槛：**`npm run check:rule-registry` 加入 `packages/application/test/rule-version.unit.test.ts` 和 `test/integration/decision-chain.test.ts`。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 这一步只给已有的决策记录补上规则的修订号，并在读取时把修订号解析成那一版规则的内容。思路和审计日志里记“策略版本号”一致，例如 Open Policy Agent（一个开源的策略引擎）的决策日志每条都带策略包修订号，官方说明是 `bundles[_].revision`：“Revision of the bundle at the time of evaluation”，还带命中规则的编号 `ids`：“List of annotation id values for rules that were successfully evaluated”（<https://www.openpolicyagent.org/docs/management-decision-logs>）。这样事后能还原“当时用的是哪一版、哪几条规则”。没有另做调研。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **测试状态显示“本版本发布前规则测试已通过”。**每条规则显示同一句话，说明不了这一条此刻对不对，Andy 没选。
- **给规则加“规则类型”字段并改表。**规则 id 现在和类型一一对应（每种类型一条规则）；第 4 步一句话变规则后会出现同类型多条规则，到那时再随那一步的迁移加。
- **改触发器让规则重审记录也带修订号。**要做迁移，而读当前版本已经够用。
- **把旧记录里的丢弃原因清掉。**抽屉对记忆候选记录本来就不显示规则一环；Andy 定过不顾旧数据兼容，旧行不动。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 删除了 `DECISION_RULE_CATALOG`：规则的来源（你设定的 / 内置）和出处改由生成那条规则的代码（`packages/application/src/rules/rule-book.ts` 里每条规则的 `origin`、`source`）给出，不再有第二份登记表。规则手册表 `rule_book_rules.source` 列现在只有写设置时留下的内部标记（例如 `owner setting: important senders`），不给主人看；规则来自一句话时，“原话”一行显示那条记忆。
- 本 ADR 取代两处旧说法：[ADR 0195](0195-show-the-whole-chain-of-one-decision-record.md) 决定 4“规则出处登记在 `DECISION_RULE_CATALOG`”和它列出的 `decision-rule-catalog.unit.test.ts`；[ADR 0212](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0212-hard-rules-step2-amount-field-and-push-suppression.md) 决定 4 里“原有的 `floorHits`、`ruleIds` 不变”中关于 `ruleIds` 的部分。两份 ADR 的其余决定不变。
- 邮件详情页“这封邮件用到”的规则，除了按邮件记的地板规则，也算上这封邮件的“小额不推送”命中；静默时段管的是整次推送，不按邮件算，所以它的“命中 N 封邮件”是 0。
- 决策记录写入约定（`docs/execution/specs/2026-11-09-decision-record-write-convention.md`）同步改为“写规则 id@修订号”。
- 现在没有任何规则来自规则类记忆（ADR 0211 后果），所以“原话”这一行要等第 4 步填上 `source_memory_id` 才会出现；集成测试用直接改表的方式覆盖了它。
- “小额不推送”的参数还不在规则手册表里，它出现在抽屉时内容显示“查不到”，等第 4 步把它存进规则手册后自动显示。
- 发给模型的内容、系统提示和工具定义都没有变，`npm run check:prompt-prefix` 不受影响。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0163](0163-owner-preferences-as-data-run-by-tested-rule-types.md)：主人的偏好是数据，由测过的规则类型执行。
- [ADR 0195](0195-show-the-whole-chain-of-one-decision-record.md)：一条决策记录的完整依据链。
- [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)：规则手册、裁判和迁移 0086。
- [ADR 0211](0211-hard-rule-points-back-to-its-rule-memory.md)：硬规则记着来源记忆。
- [ADR 0212](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0212-hard-rules-step2-amount-field-and-push-suppression.md)：金额字段和“小额不推送”。

[返回阅读导航](#contents)
