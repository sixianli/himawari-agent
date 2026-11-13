CLAIM|1|一致|packages/application/src/rules/rule-book.ts:150（f6f49666^）|内置规则 `floor_money_words` 原来靠“钱相关词”判断邮件涉不涉钱|  [RULE_IDS.moneyWords]: Object.freeze([...MONEY_SUBSTRINGS, ...MONEY_WORDS]),
CLAIM|2|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:42|`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md` 第 42 行：“写死了三条‘地板规则’（重要发件人、公共机构域名后缀、钱相关词）”|4. 现有的邮件检查在 `packages/application/src/services/proactive-rules.ts`（迁移前）里写死了三条“地板规则”（重要发件人、公共机构域名后缀、钱相关词）和静默时段计算；三条地板规则的 id（`floor_important_sender`、`floor_public_domain`、`floor_money_words`）已写进决策记录，所以保持不变。
CLAIM|3|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:42|`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md` 第 42 行，“三条地板规则的 id（`floor_important_sender`、`floor_public_domain`、`floor_money_words`）已写进决策记录，所以保持不变。”|4. 现有的邮件检查在 `packages/application/src/services/proactive-rules.ts`（迁移前）里写死了三条“地板规则”（重要发件人、公共机构域名后缀、钱相关词）和静默时段计算；三条地板规则的 id（`floor_important_sender`、`floor_public_domain`、`floor_money_words`）已写进决策记录，所以保持不变。
CLAIM|4|一致|packages/application/src/services/proactive-rules.ts:126|`ignore` 命中地板变 `know`|  if (result === "ignore") return { result: "know", raised: true };
CLAIM|5|一致|packages/application/src/services/proactive-rules.ts:124|`unsure` 或 `check` 变 `check`|  if (confidence === "unsure" || result === "check")
CLAIM|6|一致|packages/application/src/services/proactive-rules.ts:123|`act` 不动|  if (!floor || result === "act") return { result, raised: false };
CLAIM|7|一致|packages/application/src/rules/field-catalog.ts:53|`packages/application/src/rules/field-catalog.ts` 的 `amount_state` 字段|        name: "amount_state",
CLAIM|8|一致|packages/application/src/rules/amount.ts:47|`rules/amount.ts` 的 `parseMailAmount`|export function parseMailAmount(raw: unknown, bodyComplete: boolean): MailAmount {
CLAIM|9|一致|packages/application/src/services/proactive-mail-check-service.ts:599|邮件金额由模型给|        ["act", "know", "check"].includes(result as string) ? entry["amount"] : undefined,
CLAIM|10|一致|packages/application/src/rules/rule-book.ts:364|`suppress_small_amount` 规则读它|  return `amount_state == "known" && amount_currency == ${celString(parameters.currency)} && amount_minor < ${parameters.minor}`;
CLAIM|11|一致|packages/application/src/services/proactive-mail-check-service.ts:1034|地板命中在判断之后计算|    for (const item of candidates) {
CLAIM|12|一致|packages/application/src/services/proactive-mail-check-service.ts:1035|逐封邮件先取 `judged.get(item.messageId)`|      const judgement = judged.get(item.messageId);
CLAIM|13|一致|packages/application/src/services/proactive-mail-check-service.ts:1038|再算 `floorHitIds`|        : floorHitIds(item, rules, judgement?.money ?? "unknown");
CLAIM|14|不一致|packages/application/src/services/proactive-mail-check-service.ts:1080|判断之前用同一份邮件事实算的是 `outcomeHits`（要读整串、一定提醒）|      const notifyRules = item.sentByOwner ? [] : mustNotifyHitIds(item, rules);
CLAIM|15|一致|packages/application/src/services/proactive-rules.ts:43|它们不读涉钱事实|  const hits = JUDGE.decide("mail_item", mailItemFacts(item), rules)
CLAIM|16|一致|packages/application/src/rules/field-catalog.ts:53|本项目的 `amount_state` 已经是这个形状|        name: "amount_state",
CLAIM|17|一致|.claude/rules/prompt-prefix.md:67|属于 `.claude/rules/prompt-prefix.md` 第 15 条说的后台调用|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。

未核对的部分：决定里新增 `money_state`、删除词表等属于方案内容，未按现状核对；后果里旧提醒行的读取路径和旧决策记录界面显示也没有完整核对。
