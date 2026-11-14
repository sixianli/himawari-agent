CLAIM|1|不一致|apps/agent-service/src/production-memory-capture.ts:1141|待确认规矩的引用是否真的在说同一件事仍靠词表猜意思|const verdict = await judgeOrDefault(
CLAIM|2|不一致|packages/application/src/services/proactive-mail-check-service.ts:690|邮件里的订单号仍靠词表猜意思|const prompt = mailReferencePrompt(batch, perMail);
CLAIM|3|不一致|packages/application/src/services/real-memory-eval-service.ts:316|评测题干有没有泄题仍靠词表猜意思|leakJudgePrompt({ question: questionText, memory: text, quote }),
CLAIM|4|一致|AGENTS.md:17|AGENTS.md 写明“规则写进程序、必定执行、每条有回归测试”|规则写进程序、必定执行、每条有回归测试
CLAIM|5|一致|apps/agent-service/src/production-memory-capture.ts:381|确认的现有代码在 apps/agent-service/src/production-memory-capture.ts 的 evidenceRejected|const evidenceRejected =
CLAIM|6|一致|apps/agent-service/src/production-memory-capture.ts:148|原先用 GENERIC_TERMS 去掉虚词|const GENERIC_TERMS =
CLAIM|7|一致|apps/agent-service/src/production-memory-capture.ts:162|原先用 GENERIC_TERMS 去掉虚词后比较两句话有没有共同的两字词|tokens.add(`${chars[index]}${chars[index + 1]}`);
CLAIM|8|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|待确认记忆转正“有原话还要和那条记忆相关”的规则出自 ADR 0179 第 59 行|6. **转正必须有主人自己的原话（Andy 2026-11-08 选定）。**
CLAIM|9|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|原话与那条待确认记忆自己的文字……去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正|原话与那条待确认记忆自己的文字（不用模型这次输出的候选文字，它可以被抄进去绕过）去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正
CLAIM|10|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|并写明“字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次”|字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次。
CLAIM|11|一致|apps/agent-service/src/production-memory-capture.ts:154|逐字核对 quoteFromOwnerMessage 只看引用是否出自主人原话，不看是否在说同一件事|normalizedMessage.includes(normalizedQuote)
CLAIM|12|一致|apps/agent-service/src/production-memory-capture.ts:154|同文件，原话必须在归一化后逐字出现在主人消息里|normalizedMessage.includes(normalizedQuote)
CLAIM|13|一致|packages/platform-node/src/gmail-related.ts:14|邮件单号原先由正则 REFERENCE_CONTEXT 在 packages/platform-node/src/gmail-related.ts 里抽取|const REFERENCE_CONTEXT =
CLAIM|14|一致|packages/platform-node/src/gmail-related.ts:15|要求“订单、预约、案件”等标签紧挨着号码|/(?<![A-Za-z])(?:order|booking|reservation|ticket|case|claim|invoice|confirmation|tracking|注文|订单|訂單|予約|预约|預約|案件|受付|申込|申请|お問い合わせ|問い合わせ)\s*(?:number|no\.?|id|番号|編号|编号|号)?\s*[:：#＃]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39})/giu;
CLAIM|15|不一致|docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md:41|ADR 0180 第 41 行写明规则：“单独的 ID、No.、# 不算”|原先靠标签正则 `extractReferenceIds` 抽取，已删除。
CLAIM|16|一致|packages/application/src/services/proactive-mail-check-service.ts:969|取相关邮件在判断模型调用之前|? await this.#related(
CLAIM|17|不一致|packages/application/src/services/proactive-mail-check-service.ts:967|取相关邮件在每日成本上限之外|spentToday >= this.#options.limits.dailyCostMicros
CLAIM|18|一致|packages/application/src/services/real-memory-eval.ts:163|评测题防泄露原先用 n-gram、数字重叠|for (const gram of ngrams(source, LEAK_NGRAM)) if (asked.has(gram)) return true;
CLAIM|19|一致|packages/application/src/services/real-memory-eval.ts:114|评测题防泄露原先再加 chineseNumber|function chineseNumber(value: string): number | null {
CLAIM|20|一致|packages/application/src/services/real-memory-eval.ts:128|评测题防泄露原先再加 PART_OF_DAY|const PART_OF_DAY = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜裡|半夜|深夜|午夜)\s*$/u;
CLAIM|21|一致|packages/application/src/services/real-memory-eval.ts:137|评测题防泄露原先再加 dateTokens 这套日期时刻词典|function dateTokens(value: string): Set<string> {
CLAIM|22|一致|docs/adr/0239-real-memory-eval-sets.md:54|ADR 0239 决定 2 写明了这套规则|和原话或记忆正文有连续 6 个字相同、含同一个两位以上数字，或含同一个日期时刻（“十二月”和“12 月”、“七点”和“7 点”算同一个；“一点”只在前面有“下午”这类时段词、或后面跟着“钟”“整”“半”“几分”时才算钟点，免得“一点也不”被当成时间）就当泄题丢弃
CLAIM|23|一致|.claude/rules/prompt-prefix.md:35|请求开头只追加：.claude/rules/prompt-prefix.md 第 4 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|24|一致|.claude/rules/prompt-prefix.md:41|请求开头只追加：.claude/rules/prompt-prefix.md 第 6 条|6. **系统提示和工具按对话冻结**

未核对的部分：决定与后果里新增或修改的行为、以及“三个提示词都是后台单独调用、不改对话请求”的说法，按要求未作为现状核对；外部网站和第三方产品的说法也未核。带「原先」的条目按改动前版本（35b9c506^、b84eba60^、8d83c29e^）核对，行号指该版本，当前 HEAD 已无这些代码；ADR 0180 第 41 行在 d54f016e 确有“单独的 ID、No.、# 不算”，但 HEAD 已改写，故按 HEAD 判为不一致。
