# PR 378 第 1 轮复核判断

复核提交 bc041d22，两个模型（deepseek-v4.1-flash、glm-5.3-flash）。逐条判断写在同目录的 `verdicts.jsonl`。

## 会出错：中、高（本轮没过，已改，送第 2 轮）

- d1 / g1 费用上限不是硬上限。
  - 改法：上限改成最近 7 天所有运行（包括失败的）实际花费的累计，这次运行只能用剩下的部分，剩下为零就不跑。
  - 改法：调用后按实际费用记账，累计超过上限时立刻抛 `RealEvalBudgetExceededError`。
  - 改法：检索前先检查额度，额度用完就不检索。
  - 改法：两种模式下 24 小时内跑过就不再跑，失败隔一天才重试。
  - 代码位置：`RealEvalBudget.record`、`ensureRemaining`、`realEvalSpentMicros`、`dueRealEvalTrigger`。
  - 测试：`real-memory-eval.unit.test.ts` 的 spending cap，`real-memory-eval-service.unit.test.ts` 的 “stops at once when a call costs more than its estimate” 和 “counts retrieval cost”，`production-real-eval.unit.test.ts` 的到期判断和 “adds up what runs started in the last seven days spent”。
  - 失败的调用不报费用，这一部分不入账。所以最坏情况是每次失败的调用都少记一次花费，但失败后要隔 24 小时才重跑。
- d2 / g2 孤儿题干：`addQuestion` 返回 false 或抛错时，调用 `discardQuestion` 删掉刚写的 payload（生产用 `payloads.delete`）。测试是 “deletes the stored question text when the bank does not keep the question”，变异验证过：去掉删除这一步，测试失败。
- d3 重复出题：所有被拒的题（泄题、敏感值、格式不对、模型拒绝）都把记忆编号和版本记进 `declined`，读取窗口从最近 52 次运行改成 520 次（约十年的周跑）。测试改为：同一版本第二次不再问，版本变了才再问。
- d4 新题饿死：作答顺序改成先答本周新题，再答固定面板；额度用完时把没答的题数记在 `unanswered`。测试是 “answers this week's new questions before the fixed panel”，变异验证过：改回旧顺序，测试失败。
  - 固定面板总量这次不设上限：每条记忆最多两道题，费用由上限挡住，面板始终从最老的题开始答，所以每周答到的是同一批题，趋势仍可比。
- d5 抽查样本残留：每次定时器检查时，删掉写入满 7 天的样本文件，ADR 写明“被删的记忆最多在这个文件里多留 7 天”。测试是 “deletes the sample once it is a week old”。
- d6 泄题：新增日期时刻比对，阿拉伯数字和汉字数字都认，“十二月”和“12 月”、“七点”和“7 点”算同一个值。很短的专有名词仍然认不出，写进 ADR 后果，留到第一次抽查再看。测试是 “treats a date or hour written in Chinese or Arabic numerals as the same value”。

## 会出错：低（已改）

- d7：ADR 决定 1 改为“只记分数、计数和标识（……记忆编号和版本、错误名），不含记忆正文、原话、题干或回答”。
- d8：删掉重复导出。
- d9 / g6：补了这几类测试：实际费用大于预估、检索费用、并发检查（“starts only one run when ticks overlap”）、样本过期、剩余额度传给运行。`service-main` 的装配块仍只由集成测试覆盖主干。
- g3：失败后隔 24 小时重试，见 d1。
- g4：题退役时一并删掉它的题干 payload。测试在 “keeps earlier questions as the fixed panel …” 里断言退役题的 payload 已删。
- g5：同 d5。

## 可以更好

- g7：作者说明里写的是“预留”，代码实际是“检查”。这一条只涉及复核材料的措辞（材料不在仓库里，不改代码行为）。ADR 决定 6 已改成准确的说法：“加上已花的超过上限就不调用；调用后按实际费用记账”。

## 不成立

无。
