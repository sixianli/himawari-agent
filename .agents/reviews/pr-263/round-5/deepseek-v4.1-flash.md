## 侧重检查

先按本次要求检查错误路径、不可信输入、安全、资源耗尽、不可撤销操作和规则/文档一致性：

- **错误路径**：读了 `summarizeEvents`（scripts/model-review/opencode-review.mjs:251-313）、`retryAfterApiError`（:726-732）、`substituteFor`（:716-724）、`lowFixProblems`（:942-997）、`walkChain`（:1043-1069）、`assertReviewed`（:1083-1236）、`reviewReport`（:1246-1294）。429、不可重试错误、重试后仍失败、钱/时间不足、替补被预算拒绝、坏 `verdicts.jsonl`、原话找不到、非 low、超规模、重复 low-fix、重复报告记录、找不到意见编号，均有对应分支；大部分会 fail closed 或拒绝写入。
- **不可信输入**：`head`/`from` 受 `COMMIT_PATTERN` 限制；`round` 是安全正整数；`files`/`findings` 的换行会被拒；模型名白名单校验；`quote` 用 `includes` 对答案原文核对；`--accept-low` 必须是正整数。没有发现新的路径穿越或任意文件写入；新的写操作只有向已由 `--pr` 推导出的账本追加。
- **安全**：本次没有改变网络、工具或复核副本的沙箱逻辑；新增的 `apiError` 会去控制字符并截到 300 字，不把响应头、密钥或完整响应体写进账本。
- **资源耗尽**：重试最多两次脚本尝试，等待固定 60 秒，并受原 0.2 美元和超时限制；low-fix 有 5 文件/30 行限制；错误信息截断。唯一偏弱的是先把整个错误消息展开再截断，超大错误消息会短暂占用内存，但影响有限。
- **不可撤销操作**：low-fix 只追加账本记录；提交前重复运行会因 `ledger-differs-from-HEAD` 拒绝，提交后再运行会以 `nothing-unreviewed`/`already-low-fixed` 拒绝，不会静默重复追加。并发运行没有锁，可能追加两条，但后续检查会以 `second-low-fix` 拒绝，属于 fail closed。
- **规则和文档**：发现下面第 1 条“GLM 提示词开头在 PR 中途变化”和第 4 条“测试条数/第一轮单模型说法不精确”。文档已经明确写出“防手误、不防有意伪造”，和代码的能力边界基本一致。

## 发现（按严重度）

### 1. 严重度：中 — GLM 的固定提示词开头在本 PR 中途改过，替补轮不能保证与第 1 轮逐字节相同

- 文件:行：`scripts/model-review/opencode-review.mjs:180-183`、`:198-208`
- 问题：`MODEL_LENSES` 的 GLM 文案在 `65a0450e` 被修改，而 PR 263 第 1 轮的 GLM 提示词记录在更早的 `e4e11d13` 已经提交。按新流程，后续 DeepSeek 失败时 GLM 会作为替补跑同一 PR 的后续轮；这时 GLM 看到的“本次材料”之前的部分会带上新文案，与第 1 轮记录里的旧文案不同，违反“同一个模型每轮提示词在‘本次材料’之前必须逐字节相同”的约束，也会让缓存命中失效。
- 证据：
  ```js
  // scripts/model-review/opencode-review.mjs:180-183
  "deepseek-v4.1-flash":
    "……以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个……",
  "glm-5.3-flash":
    "……有时另有一个复核者侧重别的方面，有时只有你一个……",
  ```
  ```js
  // :198-208
  const fixed = [
    text.role,
    ...
    ...(lens ? [lens] : []),
    text.output,
  ].join("\n");
  ```
  `git show --stat e4e11d13` 显示第 1 轮 `glm-5.3-flash.prompt.md` 在此时加入；`git show --stat 65a0450e` 显示同一提交既修改脚本，又加入第 2 轮记录。也就是说 GLM 第 1 轮记录生成时脚本里还是旧文案，之后文案才变。
- 建议：把固定侧重像必问问题一样从 `--base`/冻结的提示词来源读取，或把“提示词开头哈希”存进账本并在后续轮次校验；如果确实要改文案，明确要求重新起一轮双模型完整复核（新的起点），不要在同一 PR 的替换路径上改。至少加一条测试/门禁，比较同一 PR 各轮 `<模型>.prompt.md` 的 `---- 本次材料 ----` 之前部分。
- 证实/推测：文案位置、提交顺序、`buildPrompt` 把 lens 放在材料之前，均已读代码/提交证实；“本次 PR 一定会发生 GLM 替补”是推测，当前记录里第 2 轮起没有实际 GLM 运行。

### 2. 严重度：低 — 自动替补的主流程没有端到端测试，测试声明比实际多

- 文件:行：`test/tooling/opencode-review.test.mjs:538-559`；生产接线 `scripts/model-review/opencode-review.mjs:2291-2317`
- 问题：`substituteFor` 只有纯函数单元测试，没有“DeepSeek 重试后仍 429 → 主流程真的调用 GLM → 账本写出 `substitute:true` → 退出码正确”的端到端用例；预算不够导致 `REVIEW_SUBSTITUTE_SKIPPED` 的路径也没有测试。`74fa4af1` 的提交说明自己也写了“替补这条路径只有单元测试”。
- 证据：
  ```js
  // test/tooling/opencode-review.test.mjs:538-559
  expect(substituteFor({ ...later, runs: [run("api-error", busy)] })).toEqual({...});
  ...
  for (const options of none) expect(substituteFor(options)).toBeNull();
  ```
  主流程则在这里独立接线：
  ```js
  // scripts/model-review/opencode-review.mjs:2291-2317
  const substitute = substituteFor({ ...options, ...commits, runs });
  if (substitute) {
    ...
    const { record } = await runOne(substitute.model, substitutePrompt, {
      substitute: true,
      substituteFor: substitute.for,
    });
  }
  ```
  这段接线没有被任何脚本化 429 用例覆盖；如果 `substituteFor` 参数或 `runOne` 的 extra 写错，现有测试不会失败。
- 建议：用现有的本机假服务/`withScriptedReview` 增加：DeepSeek 两次 429、GLM 成功；GLM 也失败；预算不足跳过；替补成功后退出码为 0。另加反向用例：手写 `substitute` 但 `substituteFor` 写错时不进入链。
- 证实/推测：测试覆盖缺口是读测试文件证实的；“接线可能出错”是推测，但没有实际发现接线错误。

### 3. 严重度：低 — `retry-after` 只认小写数字，HTTP-date 或大写头不会触发重试，和“带 retry-after 就算可重试”的说法不完全一致

- 文件:行：`scripts/model-review/opencode-review.mjs:239-247`
- 问题：`hint` 只对字符串调用 `Number(value)`，并且只读小写的 `retry-after-ms` / `retry-after`。HTTP 规范允许 `Retry-After` 是 HTTP-date，也允许头名大小写不同；这类响应如果没有 `isRetryable`，脚本会判成不可重试。作者说“带 retry-after 时算可重试”过于绝对。
- 证据：
  ```js
  const hint = (value) =>
    typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  const retryAfterMs = Number.isFinite(hint(headers["retry-after-ms"]))
    ? hint(headers["retry-after-ms"])
    : hint(headers["retry-after"]) * 1000;
  ```
- 建议：统一把响应头键转小写，并支持 HTTP-date；或者把文档改成“数字形式的 retry-after/retry-after-ms 才算可重试”。
- 证实/推测：代码行为已证实；“真实服务会返回大写头或日期格式”是推测，当前夹具使用小写数字，未受影响。

### 4. 严重度：低 — 测试条数和“第 1 轮单模型一律拒绝”的说法与当前代码/提交不一致

- 文件:行：`.agents/instructions/model-review.md:21`、`docs/adr/0175-cheaper-code-review-rounds.md:61`、`scripts/model-review/opencode-review.mjs:2120-2124`
- 问题：本次材料说“140 条全过”，而当前提交 `6c7fd3cf` 的说明写“146 条通过”；数字已经过期。另外 ADR 说“第 1 轮只给一个模型时脚本拒绝”，但代码只在“不传 `--previous` 且不传 `--round`”时拒绝；传 `--round 1` 的单模型调用由 `roundForRun` 的目录/提示词检查决定，不是 `parseArgs` 直接拒绝。合并门禁最终仍要求双模型起点，所以不是绕过，但文档表述不够精确。
- 证据：
  ```js
  // scripts/model-review/opencode-review.mjs:2120-2124
  if (options.mode === "code-review" && !options.selfCheckOnly) {
    const firstRound = !options.previous && options.round === undefined;
    if (firstRound && options.models.length !== REVIEW_MODELS.length)
      throw new Error("ARG_FIRST_ROUND_NEEDS_BOTH_MODELS");
    if (options.previous && !given.has("--models")) options.models = [REVIEW_MODELS[0]];
  }
  ```
- 建议：更新测试条数；把 ADR 的“一律拒绝”改成“新起第 1 轮时拒绝，往已有轮次补跑失败模型除外”，并补一条 `--round 1` 新轮次的测试。
- 证实/推测：条数不一致和 `parseArgs` 条件已证实；`roundForRun` 对空目录/已有提示词的边界行为未逐一执行验证。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 对 DeepSeek：`947d8131` 改了它的固定侧重，但第 1 轮记录在更晚的 `e4e11d13` 才提交，按提交顺序它看到的已经是新文案，未发现 DeepSeek 实际不一致。
   - 对 GLM：`65a0450e` 改了 GLM 固定侧重，而第 1 轮 GLM 提示词在更早的 `e4e11d13` 已提交；如果之后 GLM 作为替补跑同一 PR 的后续轮，它的固定开头就和第 1 轮不同。
   - 发给模型的内容仍然是把材料放在最后：`buildPrompt` 先拼 `fixed`，再拼 `---- 本次材料 ----`，`head/base/previous/brief` 都在材料里；重试复用同一个 `prompt`。但“同一个模型每轮在材料之前逐字节相同”没有代码保证，也没有跨轮哈希校验。因此答案：**大部分情况是，但 GLM 替补路径不满足这个硬约束**。

2. **同一段文字会不会在不同请求里变成不同字节？**
   本次改动没有引入每请求随机数、当前时间或依赖后文的遮盖；`apiError` 只进账本，不进模型提示词；`git diff`、`parseVerdicts`、`coveragePoints` 的顺序都由固定输入决定。账本里的 `at: new Date().toISOString()` 每次不同，但不会发给模型。真正导致字节变化的是上面第 1 条的“提示词版本在 PR 中途变化”，不是同一版本内的上下文依赖。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：真实 429 夹具、重试成功/仍失败/401 不重试、low-fix 正反例、重复 low-fix 报告用例等。新增的“同轮同提交重复 low-fix”用例在旧代码上会走到 `verdicts.find(...).model` 的 TypeError，所以反向用例确实会失败。缺口是：主流程自动替补/预算跳过没有端到端测试；GLM 跨轮提示词开头没有测试；`npm run check`/`npm run build` 在本环境不能运行，**未核实**。测试条数的说法也过期（材料 140，当前提交说 146）。

4. **改动产生或修改的每个值，两端都接受吗？**
   逐项核对过：
   - `outcome:"api-error"`：`parseUsage` 接受字符串；`coveragePoints` 只把 `ok` 当通过；`substituteFor` 只认这个值；`resultLine` 原样打印；退出码逻辑正确。
   - `apiError`：由 `apiErrorText` 生成，控制字符/换行已处理，账本的单行校验能通过。
   - `retry`/`retriedAfter`：`parseUsage` 不限制枚举但接受字符串；`substituteFor` 只认 `"retried"`；文档中的 `no-budget`/`no-time`/`cost-unknown` 能写入。
   - `substitute:true`/`substituteFor`：主流程写入完整模型名；`coveragePoints` 要求 `true` 且 `substituteFor` 是 DeepSeek 的完整 ID，两端一致。
   - `mode:"low-fix"`：`parseUsage` 的 `NOTE_MODES`/`lowFixValid` 接受；`nextRound`、`roundForRun` 排除；`coveragePoints`、`walkChain`、`reviewReport` 消费；`cost:0`、`round`、`from`、`head`、非空 `files`/`findings` 两端都有校验。
   - `--accept-low`：只在 `ASSERT_OPTIONS` 中允许，`parseArgs` 校验正整数，`main` 根据 `lowFixRefused` 返回 5，`--report` 传它会被拒绝。
   - 新增的 `index`：由 `coveragePoints` 在解析同一个 `HEAD:usage.jsonl` 时生成，`reviewReport` 也解析同一个 HEAD 账本，索引基准一致；重复记录不会误认。
   - 唯一宽松处：`parseUsage` 不校验 `retry` 的枚举值，也不校验 `substitute` 的类型，但消费端只做精确比较，不会因此放行；不影响安全。

## 作者说法核对（简要）

- `summarizeEvents`/`apiErrorOf`/`isRetryable`：与代码一致；补充：`retry-after` 只认数字形式。
- `reviewModel` 重试：60 秒、两次费用相加、第二次上限为剩余额度、钱低于 0.07 美元或时间不足不重试，均一致。
- `substituteFor`：一致，且代码还要求 `retry === "retried"`（作者说法里没写这一点）。
- `parseArgs`：作者列的两种默认行为一致；“第 1 轮一个模型”主要在门禁/轮次运行阶段被约束，不是所有 `--round 1` 情况都由 `parseArgs` 拒绝。
- `coveragePoints`/`walkChain`：作者已说明“从 lastCompleteRound 起”过时，当前代码确实是 `walkChain` 按轮次接链。
- `assertReviewed`、`lowFixProblems`、`parseUsage`、`nextRound`、`roundForRun`、`--report`：与代码一致；第 5 轮“按账本位置认 low-fix”确实实现，重复记录不再崩溃或冒充。
- 测试：材料里的“140 条”已过期，当前提交说明是 146 条；`npm run check`/`npm run build` 本环境无法运行，未核实。
