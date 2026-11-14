## 发现（按严重度，均为读代码证实）

### 中：全局过滤抽取提示，顺手削弱了两条“零调用”反向断言
- 文件:行：`test/integration/proactive-production.test.ts:311`、`:966`、`:1185`
- 问题：为了让 `[PG-12]` 的“只发 1 条提示”断言继续成立，提交在 `prepare` 里把所有以单号抽取提示开头的 prompt 都丢弃：`if (!prompt.startsWith(MAIL_REFERENCE_EXTRACTION.text)) prompts.push(prompt);`。但 `h.prompts` 同时被两条反向测试当成“有没有调用模型”的唯一证据：`:966` 和 `:1185` 都断言 `expect(h.prompts).toEqual([])`。过滤后，即使产品在“没有新邮件”或“提醒已关闭”时错误地调用了抽取模型，这两条测试也照样通过；原来的证明对象从“一次模型调用都没有”退化成“没有非抽取调用”。
- 证据：
  - `test/integration/proactive-production.test.ts:311`：`if (!prompt.startsWith(MAIL_REFERENCE_EXTRACTION.text)) prompts.push(prompt);`
  - `test/integration/proactive-production.test.ts:966`：`expect(h.prompts).toEqual([]);`（NO_NEW_MAIL）
  - `test/integration/proactive-production.test.ts:1185`：`expect(h.prompts).toEqual([]);`（提醒关闭）
  - 对照 `test/integration/proactive-mail-check.test.ts:373-374` 的做法：`referenceCall = prompt.startsWith(MAIL_REFERENCE_EXTRACTION.text); (referenceCall ? referencePrompts : prompts).push(prompt);`，是分开记录，而不是丢弃。
- 建议：改成独立的 `referencePrompts` 数组（与 `proactive-mail-check.test.ts` 一致），`:966`、`:1185` 同时断言 `prompts` 和 `referencePrompts` 都为空；`:512`、`:1001` 只对 `prompts` 断言条数。这样既保留原意，也不会把抽取调用藏起来。

### 低：防泄露裁判替身恒答 `false`，且没有断言它真的被调用
- 文件:行：`test/integration/real-memory-eval.test.ts:263-264`
- 问题：`if (prompt.startsWith(REAL_EVAL_LEAK_JUDGE.text)) return { output: '{"leaks":false}', costMicros: 5 };` 对任何题干都回答“不泄露”。这份集成测试因此无法发现“本该拒绝的泄露题被放行”；如果以后服务端漏接防泄露裁判，这个分支根本不会执行，测试也不会报错。它不算会挡住本次修复的错误，但确实是过宽的替身。
- 证据：
  - `test/integration/real-memory-eval.test.ts:263-264` 上述恒 `false` 的返回。
  - `packages/application/src/services/real-memory-eval-service.ts:327-336` 才是真正用裁判结论拒绝题目的地方；裁判异常/解析失败按 `true` 处理（`:322-325`）。
- 建议：至少加一条 `expect(prompts.some((prompt) => prompt.startsWith(REAL_EVAL_LEAK_JUDGE.text))).toBe(true)`，确保新调用被走到；如果希望覆盖端到端语义泄露，再让替身按 `data.question` 对一条已知泄露题返回 `{"leaks":true}` 并断言它没有入题库。底层正向/反向已由 `packages/application/test/real-memory-eval-service.unit.test.ts:384-408` 覆盖，所以不是阻塞问题。

### 低（作者说法）：合并提交不只是“CI 日志和复核记录”
- 文件:行：合并提交 `acfb2eff8`（涉及 `scripts/ci/ci-summary.mjs`、`.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs`、`test/tooling/ci-summary.test.mjs`）
- 问题：作者说 “合入 main（只带来 CI 日志和复核记录，没有产品代码改动）”。“没有产品运行时代码改动”这句是对的；但该合并还带入了约 219 行 `ci-summary.mjs`、329 行 `ci-summary.test.mjs` 以及 CI 策略/工作流改动，不只是日志和复核记录。这不是产品缺陷，但会误导“这次增量只该看两份测试”的范围判断。
- 证据：`git show --stat acfb2eff8` 显示 `scripts/ci/ci-summary.mjs | 219 +++++++++---`、`test/tooling/ci-summary.test.mjs | 329 +++++++++`、`.github/workflows/ci.yml | 12 +-`、`scripts/ci/check-policy.mjs | 2 +-`。我核对了 `.github/workflows/ci.yml` 里所有检查作业的 `ci-summary.mjs` 调用都已带上 `--failed-logs .ci-output/public/reports`（68、111、159、232、280、323 行），与 `check-policy.mjs` 的新逐字期望一致。
- 建议：把合并说明改为“带入 main 的 CI 工具代码、CI 测试和复核记录，无产品运行时改动”，避免后续复核误以为只有文档。

## 读代码证实的正向结论
- `a17d9f29b` 确实只改两份测试：`git show --stat a17d9f29b` 只有 `test/integration/proactive-production.test.ts`（5 行）和 `test/integration/real-memory-eval.test.ts`（3 行）。
- `money: "yes"` 两端都认：`packages/application/src/rules/amount.ts:60-62` 只接受 `"yes"|"no"`；`packages/application/src/rules/rule-book.ts:140` 的表达式是 `money_state == "yes"`。
- 加 `money: "yes"` 没有让 `[P2-3]` 的 owner-rule 用例“白过”：`ignore+sure+money=yes` 只升到 `know`（`packages/application/src/services/proactive-rules.ts:123-127`、`:141-152`），仍要 `mail_must_notify` 才会变成 `check` 并推送。
- `{"leaks":false}` 两端都认：`packages/application/src/services/real-memory-eval.ts:113-117` 要求严格布尔值；服务端 `real-memory-eval-service.ts:313-320` 用 `parseLeakVerdict(...) ?? true` 后判断是否等于 `true`。
- 新增的单号抽取提示是独立后台调用，且在判断之前执行：`proactive-mail-check-service.ts:955-960` 先取 references，`:1041` 才调用判断。
- 抽取 payload 混进历史不会污染规则回放：`owner-rule-replay.ts:56-70` 只接受同时带 `id` 和 `from` 的条目，而抽取 prompt 的条目没有 `from`，会被跳过。
- 其他替身没有同类遗漏：`test/integration/proactive-mail-check.test.ts:216-218/373-374` 已单独处理抽取调用；`packages/application/test/real-memory-eval-service.unit.test.ts:193-200` 已处理防泄露裁判。

## 推测 / 未核实
- 作者说“改完后这两个文件 22 条全过”“同一次 CI 里另外 10 条在 main 上也失败、与本 PR 无关”：我没有运行测试的权限，未核实。
- “真正泄露会被这条过宽替身放行”是测试覆盖层面的推测，不是当前产品代码有泄露的证据；底层服务单元测试已有泄露正反向用例。
- 合并进来的 `ci-summary.mjs` 新逻辑我只核对了 `--failed-logs` 在 `ci.yml`、`check-policy.mjs` 和测试里的一致性，没有逐行复核它在运行时的所有错误路径。

## 侧重检查
- **错误路径**：防泄露裁判抛错/输出非法时服务端按“泄露”拒绝（`real-memory-eval-service.ts:322-325`），方向是安全的；但集成测试替身恒答 `false`，覆盖不到这条错误路径。
- **不合规范/不可信输入**：单号由模型抽取后仍由程序逐字校验（`proactive-references.ts:25-68`），本次测试改动没有放宽；`money` 只接受 `yes/no`，非法值落成 `unknown`。
- **安全/隐私**：`proactive-production.test.ts` 的全局过滤让“提醒关闭时什么都不做”这条反向测试不再能发现“仍把邮件内容发给抽取模型”的回归，需要按上面的建议拆开记录。
- **资源耗尽**：抽取最多花每日额度十分之一、且不抢判断预算，已在 `proactive-mail-check.test.ts:2686-2722` 覆盖；本测试日额度 1,000,000，新增调用不会触发上限。
- **不可撤销操作**：本次增量只改测试，无。
- **规则/文档与代码一致**：`packages/prompt-catalog/src/mail.ts:27-28` 要求包括 `ignore` 在内都写 `money`，测试补 `money: "yes"` 与之一致；作者说旧词表命中“請求”，在 `f6f496669` 的删除行中确认为 `MONEY_SUBSTRINGS` 的一项。

## 必答问题
1. **会不会改变模型已经见过的请求开头？** 本增量 `a17d9f29b` 只改测试，不改变发给模型的任何字节，因此不改变前缀。就整个 PR 的相关调用看：单号抽取是“固定说明 + JSON 数据”（`proactive-mail-check-service.ts:445-458`），防泄露裁判是“固定说明 + JSON 数据”（`real-memory-eval.ts:102-111`），邮件判断把每次变化的 `now/timeZone/today` 放在最后（`proactive-mail-check-service.ts:504`），符合“固定的在前、会变的在后、只在末尾追加”。需要说明的是 T7 改写了 `MAIL_JUDGMENT.text`（加入 `money` 说明），这会让邮件判断这个后台调用旧前缀的缓存失效一次；它不是改写已发过的对话历史，也不是在会话中间改前缀。
2. **同一段文字会不会在不同请求里变成不同字节？** 本增量不涉及。相关后台提示里新增的固定文字是常量，数据用 `JSON.stringify`，键顺序由代码固定；抽取和防泄露裁判提示里没有时间字段，邮件判断的时间在最后。未发现依赖前后文的遮盖、带时间字段或无序集合导致字节漂移的代码。
3. **有没有自动检查，反向用例真会失败吗？** 有。去掉 `money: "yes"`，`[P2-3]` 的快照会从 `know` 变回 `ignore`，断言失败；去掉防泄露分支，替身会抛 `UNEXPECTED_PROMPT`，两个 `describe.each` 分支都会失败；去掉过滤，`:512`/`:1001` 的条数断言会失败。T7/T4/T3 的产品反向用例也分别存在于 `proactive-mail-check.test.ts:1481-1490`、`2695-2722` 和 `real-memory-eval-service.unit.test.ts:384-408`。缺口正是上面第一条：没有反向用例保证“关闭/无新邮件时抽取模型也一次都不调用”。
4. **改动产生/修改的每个值，使用它的地方都能接受吗？** 能。测试新增的 `money: "yes"` 由 `parseMailMoney` 接受并进入 `money_state == "yes"` 规则；`{"leaks":false}` 由 `parseLeakVerdict` 接受，服务端把 `false` 解释为不泄露。两个值都没有新增标识、配置键或序列化格式；导入的 `MAIL_REFERENCE_EXTRACTION`、`REAL_EVAL_LEAK_JUDGE` 都从 `packages/prompt-catalog/src/index.ts` 导出。合并进来的 `--failed-logs` 也在 `ci.yml`、`check-policy.mjs`、`ci-summary.mjs` 和测试四处保持一致。
