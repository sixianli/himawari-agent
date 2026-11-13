CLAIM|1|一致|AGENTS.md:17|自 v2.2 起 Andy 定的规则是硬性设定|自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试
CLAIM|2|一致|AGENTS.md:17|`AGENTS.md` 写明“规则写进程序、必定执行、每条有回归测试”|自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试
CLAIM|3|一致|apps/agent-service/src/production-memory-capture.ts:381|确认的现有代码在 `apps/agent-service/src/production-memory-capture.ts` 的 `evidenceRejected`|const evidenceRejected =
CLAIM|4|一致|apps/agent-service/src/production-memory-capture.ts:148-162（5e06602c）|原先用 `GENERIC_TERMS` 去掉虚词后比较两句话有没有共同的两字词|    .replace(GENERIC_TERMS, " ");
CLAIM|5|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|待确认记忆转正“有原话还要和那条记忆相关”的规则出自 ADR 0179 第 59 行|有原话还要和那条记忆相关
CLAIM|6|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|原话与那条待确认记忆自己的文字……去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正|原话与那条待确认记忆自己的文字（不用模型这次输出的候选文字，它可以被抄进去绕过）去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正
CLAIM|7|一致|docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md:59|字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次|字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次。
CLAIM|8|一致|apps/agent-service/src/production-memory-capture.ts:148-156|逐字核对 `quoteFromOwnerMessage` 只看引用是否出自主人原话，不看是否在说同一件事|    normalizedMessage.includes(normalizedQuote)
CLAIM|9|一致|apps/agent-service/src/production-memory-capture.ts:148-156|同文件，原话必须在归一化后逐字出现在主人消息里|    normalizedMessage.includes(normalizedQuote)
CLAIM|10|一致|packages/platform-node/src/gmail-related.ts:14-15（b84eba60^）|邮件单号原先由正则 `REFERENCE_CONTEXT` 在 `packages/platform-node/src/gmail-related.ts` 里抽取|const REFERENCE_CONTEXT =
CLAIM|11|一致|packages/platform-node/src/gmail-related.ts:15（b84eba60^）|要求“订单、预约、案件”等标签紧挨着号码|  /(?<![A-Za-z])(?:order|booking|reservation|ticket|case|claim|invoice|confirmation|tracking|注文|订单|訂單|予約|预约|預約|案件|受付|申込|申请|お問い合わせ|問い合わせ)\s*(?:number|no\.?|id|番号|編号|编号|号)?\s*[:：#＃]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39})/giu;
CLAIM|12|一致|docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md:41|ADR 0180 第 41 行写明规则：“单独的 ID、No.、# 不算”|；单独的 ID、No.、# 不算）
CLAIM|13|一致|packages/application/src/services/proactive-mail-check-service.ts:915|取相关邮件在判断模型调用之前|        : await this.#related(
CLAIM|14|一致|packages/application/src/services/proactive-mail-check-service.ts:911-922|取相关邮件在每日成本上限之外|    costMicros += referenceBudget.costMicros;
CLAIM|15|一致|packages/application/src/services/proactive-mail-check-service.ts:915|`#related` 先于 `#judge`|        : await this.#related(
CLAIM|16|一致|packages/application/src/services/real-memory-eval.ts:79,158（8d83c29e^）|评测题防泄露原先用 n-gram|  const asked = ngrams(question, LEAK_NGRAM);
CLAIM|17|一致|packages/application/src/services/real-memory-eval.ts:87,159（8d83c29e^）|评测题防泄露原先用数字重叠|  const askedNumbers = numbers(question);
CLAIM|18|一致|packages/application/src/services/real-memory-eval.ts:114,128,137（8d83c29e^）|再加 `chineseNumber`、`PART_OF_DAY`、`dateTokens` 这套日期时刻词典|function dateTokens(value: string): Set<string> {
CLAIM|19|一致|docs/adr/0239-real-memory-eval-sets.md:54|ADR 0239 决定 2 写明了这套规则|和原话或记忆正文有连续 6 个字相同、含同一个两位以上数字，或含同一个日期时刻
CLAIM|20|一致|.claude/rules/prompt-prefix.md:35|请求开头只追加：`.claude/rules/prompt-prefix.md` 第 4、6 条|4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**
CLAIM|21|一致|apps/agent-service/src/production-memory-capture.ts:148-156|逐字核对保留|    normalizedMessage.includes(normalizedQuote)
CLAIM|22|不一致|apps/agent-service/src/production-memory-capture.ts:164-165|结果按（规矩文本、引用、提示词版本）在进程内复用|  return `${memoryId}\u0000${quote}`;
CLAIM|23|一致|apps/agent-service/src/production-memory-capture.ts:1135-1160|同一轮重试不重复花钱；失败的结果不复用|        if (settled) {
CLAIM|24|一致|packages/application/src/services/proactive-references.ts:25|程序校验全部保留并移到 `packages/application/src/services/proactive-references.ts`|export function validMailReferences(
CLAIM|25|一致|packages/application/src/services/proactive-references.ts:3|每封最多 3 个|export const MAXIMUM_REFERENCES_PER_MAIL = 3;
CLAIM|26|一致|packages/application/src/services/proactive-references.ts:5|只认 `[A-Z0-9-]{8,40}`、含数字|const REFERENCE_SHAPE = /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39}$/u;
CLAIM|27|一致|packages/application/src/services/proactive-references.ts:6|不是日期|const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;
CLAIM|28|一致|packages/application/src/services/proactive-references.ts:36|必须作为完整片段逐字出现在这封邮件里|    if (!appearsAsWholeToken(haystack, reference)) continue;
CLAIM|29|一致|packages/platform-node/src/gmail-related.ts:149|搜回的邮件仍要逐字含该单号才算|          if (mentions(message, reference)) add(message);
CLAIM|30|一致|packages/application/src/services/real-memory-eval.ts:92-99|保留 n-gram 与数字重叠两道确定性检查|  const asked = ngrams(question, LEAK_NGRAM);
CLAIM|31|一致|packages/application/src/services/real-memory-eval.ts:141|沿用 `rejected: "leak"`，不加新枚举值|  | "leak"
CLAIM|32|一致|packages/application/src/services/real-memory-eval-service.ts:322-325|预算用尽照旧中止，不当成泄露|            if (error instanceof RealEvalBudgetExceededError) throw error;
CLAIM|33|一致|apps/agent-service/src/production-memory-capture.ts:1082|这些调用沿用各自调用方已有的模型配置，不在代码里写死模型名|      modelDescriptorRef: request.modelRef,
CLAIM|34|一致|packages/prompt-catalog/prompt-manifest.json:307,352,561|提示词写进目录并登记在 `prompt-manifest.json`|  "eval.real-memory.leak-judge": {
CLAIM|35|一致|packages/application/src/ports/configuration.ts:275|评测每道题多一到两次小调用，计入每周 0.5 美元上限|export const REAL_EVAL_WEEKLY_CAP_MICROS_MAXIMUM = 500_000;
CLAIM|36|一致|packages/application/src/services/proactive-mail-check-service.ts:681-695|邮件每次检查多一次（每批一次）抽取调用|    for (let start = 0; start < candidates.length; start += size) {
CLAIM|37|一致|packages/application/src/services/proactive-mail-check-service.ts:686-687|每日成本用尽那一轮不抽取|      if (budget.spentToday + budget.costMicros + estimate > this.#options.limits.dailyCostMicros)
CLAIM|38|一致|packages/application/src/services/proactive-mail-check-service.ts:915|单号抽取发生在判断之前（`#related` 先于 `#judge`）|        : await this.#related(

未核对：OpenAI／Anthropic 结构化输出文档、LongMemEval、Mem0 等外部资料，以及设计线程拆 T1–T6 的过程；“模型调用仍走原有的出口遮盖和准入”“不改任何对话请求的系统提示和工具定义”“只在评测开着时运行”这三处我没有逐行读到实现。标“原先”的条目是用改动前提交（5e06602c、b84eba60^、8d83c29e^）核对的历史状态，当前工作树已删掉这些旧实现。
