CLAIM|1|一致|AGENTS.md:17|`AGENTS.md` 写明“规则写进程序、必定执行、每条有回归测试”|自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试
CLAIM|2|一致|apps/agent-service/src/production-memory-capture.ts:381|确认的现有代码在 `apps/agent-service/src/production-memory-capture.ts` 的 `evidenceRejected`|    const evidenceRejected =
CLAIM|3|一致|apps/agent-service/src/production-memory-capture.ts:148-174（35b9c506^）|原先用 `GENERIC_TERMS` 去掉虚词后比较两句话有没有共同的两字词|        tokens.add(`${chars[index]}${chars[index + 1]}`);
CLAIM|4|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|待确认记忆转正“有原话还要和那条记忆相关”的规则出自 ADR 0179 第 59 行：“原话与那条待确认记忆自己的文字……去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正”|原话与那条待确认记忆自己的文字（不用模型这次输出的候选文字，它可以被抄进去绕过）去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正
CLAIM|5|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|并写明“字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次”|字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次
CLAIM|6|一致|apps/agent-service/src/production-memory-capture.ts:154|逐字核对 `quoteFromOwnerMessage` 只看引用是否出自主人原话，不看是否在说同一件事|    normalizedMessage.includes(normalizedQuote)
CLAIM|7|一致|apps/agent-service/src/production-memory-capture.ts:154|同文件，原话必须在归一化后逐字出现在主人消息里|    normalizedMessage.includes(normalizedQuote)
CLAIM|8|一致|packages/platform-node/src/gmail-related.ts:14（b84eba60^）|邮件单号原先由正则 `REFERENCE_CONTEXT` 在 `packages/platform-node/src/gmail-related.ts` 里抽取|const REFERENCE_CONTEXT =
CLAIM|9|一致|packages/platform-node/src/gmail-related.ts:15（b84eba60^）|要求“订单、预约、案件”等标签紧挨着号码|  /(?<![A-Za-z])(?:order|booking|reservation|ticket|case|claim|invoice|confirmation|tracking|注文|订单|訂單|予約|预约|預約|案件|受付|申込|申请|お問い合わせ|問い合わせ)\s*(?:number|no\.?|id|番号|編号|编号|号)?\s*[:：#＃]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39})/giu;
CLAIM|10|一致|docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md:41|ADR 0180 第 41 行写明规则：“单独的 ID、No.、# 不算”|单独的 ID、No.、# 不算
CLAIM|11|一致|packages/application/src/services/proactive-mail-check-service.ts:946|`packages/application/src/services/proactive-mail-check-service.ts` 的 `#related` 先于 `#judge`|        : await this.#related(
CLAIM|12|一致|packages/platform-node/src/gmail-related.ts:86|取相关邮件在判断模型调用之前、每日成本上限之外|  const budget = new Budget(limits.requestsPerCheck);
CLAIM|13|一致|packages/application/src/services/real-memory-eval.ts:93|评测题防泄露原先用 n-gram|  const asked = ngrams(question, LEAK_NGRAM);
CLAIM|14|一致|packages/application/src/services/real-memory-eval.ts:97|评测题防泄露原先用数字重叠|    for (const value of numbers(source)) if (askedNumbers.has(value)) return true;
CLAIM|15|一致|packages/application/src/services/real-memory-eval.ts:114-150（8d83c29e^）|再加 `chineseNumber`、`PART_OF_DAY`、`dateTokens` 这套日期时刻词典：`packages/application/src/services/real-memory-eval.ts`|function dateTokens(value: string): Set<string> {
CLAIM|16|一致|docs/adr/0239-real-memory-eval-sets.md:54|ADR 0239 决定 2 写明了这套规则|和原话或记忆正文有连续 6 个字相同、含同一个两位以上数字，或含同一个日期时刻（“十二月”和“12 月”、“七点”和“7 点”算同一个；
CLAIM|17|一致|.claude/rules/prompt-prefix.md:35|请求开头只追加：`.claude/rules/prompt-prefix.md` 第 4、6 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|18|一致|packages/application/src/services/real-memory-eval.ts:184|沿用 `rejected: "leak"`，不加新枚举值|  if (leaksAnswer(question, texts)) return { rejected: "leak" };
CLAIM|19|一致|packages/application/src/services/real-memory-eval-service.ts:323|预算用尽照旧中止，不当成泄露|            if (error instanceof RealEvalBudgetExceededError) throw error;
CLAIM|20|一致|docs/adr/0239-real-memory-eval-sets.md:58|计入每周 0.5 美元上限|配置 `runPolicy.realEval.weeklyCapMicros` 最大 500000 微美元（0.5 美元），超过启动时拒绝
CLAIM|21|一致|packages/application/src/services/real-memory-eval-service.ts:307-308|和已有的出题失败处理一致|            declined.push(declinedKey(memory.id, memory.revision));

未核对的部分：方案中新增或修改的实现细节（如 `judgeWithModel` 的重试、提示词清单与预算预留等）属于计划，未作为现状核对；外部文档和第三方产品（OpenAI、Anthropic、LongMemEval、Mem0）的说法未上网核对。另“模型调用仍走原有的出口遮盖和准入”这一调用链未逐条追查。
