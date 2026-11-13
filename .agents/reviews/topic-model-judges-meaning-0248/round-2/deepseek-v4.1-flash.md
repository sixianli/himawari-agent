CLAIM|1|不一致|packages/application/src/rules/rule-book.ts:140|内置规则 `floor_money_words` 用两张词表（中日文子串、英文单词）|    expression: 'money_state == "yes"',
CLAIM|2|不一致|packages/application/src/rules/rule-book.ts:140|对邮件标题和摘要做包含匹配|    expression: 'money_state == "yes"',
CLAIM|3|一致|packages/application/src/services/proactive-rules.ts:126|命中就把邮件至少抬到“值得知道”。|  if (result === "ignore") return { result: "know", raised: true };
CLAIM|4|找不到|-|词表只认写进去的词|-|
CLAIM|5|找不到|-|“お引落し”这类写法、词表外的说法认不出|-|
CLAIM|6|找不到|-|词表外的说法认不出|-|
CLAIM|7|找不到|-|“账单”出现在促销文案里却会误命中|-|
CLAIM|8|一致|docs/adr/0209-rule-book-with-cel-expressions-and-judge.md:42|规则 id 已写进决策记录，不能改：`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md` 第 42 行，“三条地板规则的 id（`floor_important_sender`、`floor_public_domain`、`floor_money_words`）已写进决策记录，所以保持不变。”|4. 现有的邮件检查在 `packages/application/src/services/proactive-rules.ts`（迁移前）里写死了三条“地板规则”（重要发件人、公共机构域名后缀、钱相关词）和静默时段计算；三条地板规则的 id（`floor_important_sender`、`floor_public_domain`、`floor_money_words`）已写进决策记录，所以保持不变。
CLAIM|9|一致|packages/application/src/services/proactive-rules.ts:118|地板的作用是“判断模型已经给出结论后，涉钱邮件至少升到要知道”：`packages/application/src/services/proactive-rules.ts` 的 `applyFloor`|export function applyFloor(
CLAIM|10|一致|packages/application/src/services/proactive-rules.ts:126|`ignore` 命中地板变 `know`|  if (result === "ignore") return { result: "know", raised: true };
CLAIM|11|一致|packages/application/src/services/proactive-rules.ts:125|`unsure` 或 `check` 变 `check`|    return { result: "check", raised: result !== "check" };
CLAIM|12|一致|packages/application/src/services/proactive-rules.ts:123|`act` 不动|  if (!floor || result === "act") return { result, raised: false };
CLAIM|13|一致|packages/application/src/services/proactive-mail-check-service.ts:599|邮件金额由模型给|        ["act", "know", "check"].includes(result as string) ? entry["amount"] : undefined,
CLAIM|14|一致|packages/application/src/rules/field-catalog.ts:53|`packages/application/src/rules/field-catalog.ts` 的 `amount_state` 字段|        name: "amount_state",
CLAIM|15|一致|packages/application/src/rules/amount.ts:47|`rules/amount.ts` 的 `parseMailAmount`|export function parseMailAmount(raw: unknown, bodyComplete: boolean): MailAmount {
CLAIM|16|一致|packages/application/src/rules/rule-book.ts:364|`suppress_small_amount` 规则读它|  return `amount_state == "known" && amount_currency == ${celString(parameters.currency)} && amount_minor < ${parameters.minor}`;
CLAIM|17|一致|packages/application/src/services/proactive-mail-check-service.ts:1038|地板命中在判断之后计算|        : floorHitIds(item, rules, judgement?.money ?? "unknown");
CLAIM|18|一致|packages/application/src/services/proactive-mail-check-service.ts:1035|`proactive-mail-check-service.ts` 里逐封邮件先取 `judged.get(item.messageId)`|      const judgement = judged.get(item.messageId);
CLAIM|19|一致|packages/application/src/services/proactive-mail-check-service.ts:1038|再算 `floorHitIds`|        : floorHitIds(item, rules, judgement?.money ?? "unknown");
CLAIM|20|一致|packages/application/src/services/proactive-mail-check-service.ts:898|判断之前用同一份邮件事实算的是 `outcomeHits`|      const hits = wholeThreadHitIds(item, rules);
CLAIM|21|一致|packages/application/src/services/proactive-rules.ts:41|`outcomeHits`（要读整串、一定提醒）|  wanted: "require_notify" | "require_whole_thread",
CLAIM|22|一致|packages/application/src/services/proactive-rules.ts:43|它们不读涉钱事实|  const hits = JUDGE.decide("mail_item", mailItemFacts(item), rules)
CLAIM|23|找不到|-|设计线程方案：`/mnt/project-files/model-judges-meaning/integrated-plan.md` 末尾“T7”一节|-|
CLAIM|24|一致|packages/application/src/rules/amount.ts:47|本项目的 `amount_state` 已经是这个形状|export function parseMailAmount(raw: unknown, bodyComplete: boolean): MailAmount {
CLAIM|25|一致|packages/application/src/rules/amount.ts:61|模型漏答或答错时这条地板失效（失败默认不命中）|  return raw === "yes" || raw === "no" ? raw : "unknown";
CLAIM|26|一致|packages/application/src/services/proactive-mail-check-service.ts:1038|每日成本用尽、没有判断的邮件没有涉钱事实，所以不再因词表被抬到“要看”|        : floorHitIds(item, rules, judgement?.money ?? "unknown");
CLAIM|27|找不到|-|已存的旧决策记录里写着 `floor_money_words@1`|-|
CLAIM|28|一致|packages/application/test/rule-version.unit.test.ts:73|版本 1 的词表已不在代码里|    expect(BUILT_IN_RULE_VALUES[RULE_IDS.moneyWords]).toBeUndefined();
CLAIM|29|不一致|apps/control-center/src/i18n/resources/zh-CN.ts:1052|界面显示“找不到这一版的内容”|  "decision.chain.ruleWordingMissing": "这一版的规则内容查不到",
CLAIM|30|一致|packages/application/src/services/proactive-overview.ts:149|已存的、没有 `floorHit` 记录的旧提醒行在读取时无法再按词表补判|      (content.floorHit ??
CLAIM|31|一致|packages/prompt-catalog/src/mail.ts:6|只影响后台的邮件判断调用|  usedBy: ["packages/application/src/services/proactive-mail-check-service.ts"],
CLAIM|32|一致|packages/prompt-catalog/src/mail.ts:7|不属于对话请求的开头|  layer: "background",
CLAIM|33|不一致|.claude/rules/prompt-prefix.md:67|不涉及 `prompt-prefix` 规则|15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。

未能核对的部分：`/mnt/project-files/model-judges-meaning/integrated-plan.md` 因目录权限无法读取；数据库里已存的旧决策记录和旧提醒行属于运行时数据，仓库内无法核对。背景中关于已删除词表的具体识别行为，也因当前代码里没有词表而无法核对。
