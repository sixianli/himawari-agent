## 复核结论

先说明：我只能读代码和 git 历史，不能运行测试，所以「140 条全过」「npm run check / build 通过」未核实。下面的行号以当前检出 `830b565d` 为准。

---

### 高

**1. 复核链只核「后续提交」，不核每轮的 `--previous`，一轮单模型复核可以只复核空增量，放行中间未复核的提交**

- 文件:行：`scripts/model-review/opencode-review.mjs:1008`、`scripts/model-review/opencode-review.mjs:1063`、`scripts/model-review/opencode-review.mjs:2212`
- 问题：`coveragePoints` 只把每轮的 `head` 串成点，`assertReviewed` 对普通复习轮只检查 `isAncestor(before.head, point.head)`。账本里明明记了 `previous`，却没有任何一端核对它。线程可以：round 1 双模型复核 A → 提交未复核的 B → 用 `--previous B` 只跑 DeepSeek，模型看到的增量是 `B..B`（空）→ 账本记 `head=B, previous=B` → 门禁认为 B 已复核。旧检查会取 `lastCompleteRound=A`，`changedOutside(A, HEAD)` 会报 `unreviewed`，所以这是新链引入的绕过。
- 证据：
  ```js
  // coveragePoints: 只取 head，没有 previous
  const covering = reviews.filter(
    (record) =>
      (record.round ?? 1) === round &&
      record.outcome === "ok" &&
      (record.model === REVIEW_MODELS[0] || ...),
  );
  points.push({ round, head: heads[0], by });

  // assertReviewed: 普通点没有 from，只检查祖先关系
  if (!isAncestor(before.head, point.head) || (point.from && point.from !== before.head)) {
    chainProblems.push(`chain-broken round=${point.round} ${point.head}`);
    break;
  }
  ```
  账本生产端确实记了 `previous`（`previous: commits.previous ?? null`，第 2212 行），但消费端没用。
- 建议：每个后续复习点带上 `record.previous`；若 `previous` 非空，要求 `isAncestor(previous, before.head)`（允许等于，也允许更早的完整复核），否则报 `chain-broken`/`previous-skips-round`。补反向用例：A 双模型 → 未复核 B → `--previous B` 单模型 ok，必须失败。顺带检查起点轮：若起点是带 `--previous` 的完整轮，也要能追溯到上一完整轮。

---

### 中

**2. DeepSeek 因时间/费用不足「没有重跑」时，仍然会让 GLM 替补，而且替补用全新的完整超时**

- 文件:行：`scripts/model-review/opencode-review.mjs:712`、`scripts/model-review/opencode-review.mjs:738`、`scripts/model-review/opencode-review.mjs:2185`、`scripts/model-review/opencode-review.mjs:2255`
- 问题：`substituteFor` 只看 `outcome === "api-error"` 和 `apiError.retryable`，不看 `review.retry`。如果 `retryAfterApiError` 返回 `no-time` / `no-budget` / `cost-unknown`，DeepSeek 根本没重跑，`substituteFor` 仍返回 GLM；而 `runOne` 给替补传的是原始 `timeoutMs`（默认 25 分钟），不是剩余时间。结果是「脚本刚判断时间不够、不重跑」，却又开了一个完整的 25 分钟 GLM 运行；预算不足时也照样再花 GLM 的 0.2 美元额度。这也与规则文件和 ADR 的「重跑后仍是可重试的服务报错才替补」不一致。
- 证据：
  ```js
  // substituteFor 不看 retry 原因
  if (!replacement || run.record.outcome !== "api-error") return null;
  if (!run.review.summary.apiError?.retryable) return null;
  return { model: replacement, for: models[0] };

  // 替补调用 runOne，runOne 用闭包里的原始 timeoutMs
  const { record } = await runOne(substitute.model, substitutePrompt, {
    substitute: true,
    substituteFor: substitute.for,
  });
  ```
  规则原文 `.agents/instructions/model-review.md:35`：「脚本等 60 秒、在同一个 0.2 美元上限里整轮重跑一次；仍是可以重试的服务报错，就让 GLM 跑这一轮」；ADR `docs/adr/0174-cheaper-code-review-rounds.md:61` 同样写「重跑后仍是……」。代码没有「重跑后」这个前提。
- 建议：`substituteFor` 增加 `run.review.retry === "retried"`（或至少排除 `no-time`、`no-budget`、`cost-unknown`）；替补调用传入剩余时间（例如 `deadline - Date.now()`），并在替补前检查剩余时间门槛。补反向用例：`retry` 为 `no-time`/`no-budget` 时不得替补；替补不得使用完整 `timeoutMs`。

**3. 重新核对 low-fix 时读的是 `HEAD:`，不是这条 low-fix 记录自己的 `head:`，事后补证据可以让手写记录通过**

- 文件:行：`scripts/model-review/opencode-review.mjs:945`、`scripts/model-review/opencode-review.mjs:953`、`scripts/model-review/opencode-review.mjs:967`、`scripts/model-review/opencode-review.mjs:1068`
- 问题：`lowFixProblems` 收下了 `to`，但只用它算 `git diff from to`；`verdicts.jsonl` 和模型答案都用 `git show HEAD:<path>` 读取。链上重新核对时 `HEAD` 是最终提交，`to` 才是 low-fix 记录声明的提交。线程可以手写一条 low-fix 记录把 `head` 定在 F，此时 F 下没有 verdicts/答案；之后在 `.agents/reviews/...`（属于记录目录，最终门禁不检查）里补上伪造的 `verdicts.jsonl` 和含 quote 的 `<模型>.md`，最终 `assertReviewed` 读 HEAD 时就能通过。这正好绕过了「手写一条 low-fix 记录」的重新核对。
- 证据：
  ```js
  function showAt(repo, path) {
    const shown = gitStatus(["show", `HEAD:${path}`], repo);
    return shown.status === 0 ? shown.stdout : null;
  }
  // ...
  const text = showAt(repo, verdictsPath);
  // ...
  answers.set(
    verdict.model,
    showAt(repo, `${ledgerPath}/round-${round}/${verdict.model.split("/").pop()}.md`),
  );
  ```
  `to` 只出现在第 976 行的 `git diff --numstat from to`。
- 建议：`showAt` 接受提交参数，`--accept-low` 时用当前 HEAD（等于 `to`），链上重新核对时用 `to`（即 low-fix 的 `head`）。补反例：记录提交之后才补 verdicts/答案，门禁必须报 `verdicts-not-committed`/`quote-not-found`。

**4. low-fix 记录里的 `files` 和 `findings` 只用于展示，门禁重算后不与记录核对（I-73 类问题）**

- 文件:行：`scripts/model-review/opencode-review.mjs:1154`、`scripts/model-review/opencode-review.mjs:1068`、`scripts/model-review/opencode-review.mjs:1222`
- 问题：生产端写入 `files: check.files`、`findings: check.errors.map(v => v.id)`；消费端 `assertReviewed` 只取 `lowFixProblems(...).problems`，完全忽略重算出的 `files`/`errors`；`--report` 又直接用记录里的 `files`/`findings` 展示。手写或篡改记录可以把「改了哪些文件」「放行了哪些意见」写少，规模检查仍按真实 diff 做，所以不会放过超限改动，但 Andy 抽查看到的清单会和实际不一致。`parseVerdicts` 也不要求 `id` 唯一，`reviewReport` 的 `verdicts.find(item => item.id === id)` 可能取到错误的那条原话。
- 证据：
  ```js
  // 生产
  files: check.files,
  findings: check.errors.map((verdict) => verdict.id),

  // 链上只用了 problems
  for (const problem of lowFixProblems({ ... }).problems)
    chainProblems.push(`low-fix-invalid round=${point.round} ${problem}`);

  // 报告直接用记录字段
  `...files=${record.files.map(printable).join(",")}`,
  ...record.findings.map((id) => {
    const verdict = verdicts.find((item) => item.id === id);
  ```
- 建议：链上重新核对时把记录里的 `files`/`findings` 与重算结果逐项比较（`files` 集合相等、`findings` 等于重算的 error id 列表）；`parseVerdicts` 拒绝重复 `id`。补反例：手写记录把 `files` 写少、把 `findings` 写少、重复 id，都必须失败。

---

### 低

**5. `AGENTS.md` 开头仍写「两个模型各看一遍」，与同文件的新规则和代码矛盾**

- 文件:行：`AGENTS.md:49`、`AGENTS.md:52`
- 问题：第 49 行说「下面两个时机都要请……两个模型各看一遍」，第 52 行又说「第 1 轮两个模型都跑，之后的轮次默认只用 DeepSeek」。规则文件 `.agents/instructions/model-review.md` 顶部已改成带条件的说法，但 `AGENTS.md` 的引言没改。
- 证据：
  ```
  49: 下面两个时机都要请 OpenCode……两个模型各看一遍。
  52: 合并 PR 之前：……第 1 轮两个模型都跑，之后的轮次默认只用 DeepSeek。
  ```
- 建议：把第 49 行改成「方案讨论两个模型都看；代码复核第 1 轮两个都看，之后默认只用 DeepSeek」。

**6. `retry-after` 为 `null` 或空串时会被当成可重试**

- 文件:行：`scripts/model-review/opencode-review.mjs:239`
- 问题：`Number(headers["retry-after"]) * 1000` 在 header 缺失时是 `NaN`（正确），但 `Number(null)` 和 `Number("")` 都是 `0`，`Number.isFinite(0)` 为真，于是没有真正 retry hint 的错误也会被当成可重试，白等 60 秒并再跑一次。真实响应里出现 `null`/空串的概率不高，所以标为推测。
- 证据：
  ```js
  const retryAfterMs = Number(headers["retry-after-ms"] ?? Number(headers["retry-after"]) * 1000);
  retryable: data.isRetryable === true || Number.isFinite(retryAfterMs),
  ```
- 建议：先判断 header 存在且非空再转数字，例如只接受有限正数；加 `retry-after: ""` 和 `null` 的反例。

**7. `--accept-low` 打印 `REVIEW_LOW_FIX_REFUSED` 但问题列表为空时退出码仍是 0**

- 文件:行：`scripts/model-review/opencode-review.mjs:1131`、`scripts/model-review/opencode-review.mjs:2095`
- 问题：当 `problems.length === 0` 时 `acceptLow` 记 `nothing-unreviewed` 并打印 `REVIEW_LOW_FIX_REFUSED`，但 `main` 只在 `problems.length > 0 && !overridden` 时设退出码 5，所以这条拒绝命令退出 0。若外层脚本靠退出码判断，会把「拒绝放行」当成功。门槛本身没被放松（本来就没有未复核改动），但输出/退出码不自洽。
- 证据：
  ```js
  if (problems.length === 0) reasons.push("nothing-unreviewed");
  ...
  lines.push(`REVIEW_LOW_FIX_REFUSED ${reasons.join(" ")}`);
  ...
  if (result.problems.length > 0 && !result.overridden) process.exitCode = 5;
  ```
- 建议：`acceptLow` 被拒绝时也设非零退出码（或单独返回 `refused` 标志），并补一条调用 `main` 的用例。

**8. 已提交的 low-fix 记录对应的 `verdicts.jsonl` 格式坏掉时，`--report` 会抛异常而不是降级显示 `verdict-missing`**

- 文件:行：`scripts/model-review/opencode-review.mjs:1220`、对比 `scripts/model-review/opencode-review.mjs:956`
- 问题：`lowFixProblems` 对 `parseVerdicts` 的异常是 catch 后转成 `problems`；`reviewReport` 直接调用 `parseVerdicts`，没有 catch。记录目录里手改坏一行，`--report` 就整体失败，和门禁的容错不一致。
- 证据：
  ```js
  const verdicts = text.status === 0 ? parseVerdicts(text.stdout, path) : [];
  ```
- 建议：报告路径也 catch，按 `verdict-missing`/`verdicts-invalid` 展示。

**9. 改动范围包含约束清单外的复核记录文件**

- 文件:行：本次 diff 新增 `.agents/reviews/topic-review-cost/round-1/*`、`round-2/*`、`usage.jsonl`
- 问题：约束写的是「只改脚本、测试、规则、AGENTS、ADR、案例库和方案文件」。这些是方案讨论的复核记录，不是方案文件本身。它们可能是必要的证据，但按字面不在允许清单里。
- 证据：`git diff --stat` 中出现了这些路径，且 `docs/engineering-casebook.md` 还引用了它们。
- 建议：确认这些记录是否属于「方案文件」的一部分；若不属于，移到允许的位置或在约束里补上「方案讨论的复核记录」。

---

## 侧重检查

- **错误路径**：查了 `summarizeEvents` 的 `api-error` 优先级、`retryAfterApiError` 的 `cost-unknown`/`no-budget`/`no-time` 分支、`substituteFor` 的触发条件、`lowFixProblems` 的 `verdicts-not-committed`/`VERDICTS_INVALID`/`quote-not-found`/`not-low`/`no-low-errors`/`no-changes`/`too-many-*`/`no-test-change` 分支、`git diff`/`git show` 失败路径。发现替补未检查重跑是否真的发生（第 2 条）。
- **不合规范/不可信输入**：查了 `verdicts.jsonl` 的字段校验、模型名白名单、round 正整数、`from`/`head` 哈希、`files`/`findings` 数组、换行/控制字符、`--accept-low`/`--pr`/`--main-ref` 等参数。发现 `findings`/`files` 没有被消费端交叉核对（第 4 条）、重复 `id` 没有拒绝。
- **安全/绕过**：查了合并门禁的链、`--accept-low`、`--accept-unreviewed`、手写 low-fix、改写历史、`HEAD` vs 记录 `head`、`previous` 与增量范围。发现两个可绕过点（第 1、3 条）。
- **资源耗尽/费用**：查了重试的 0.2 美元上限、等待时间、替补前的 `budgetCheck`、low-fix 的 5 文件/30 行上限。重试本身在同一个 0.2 上限内；但替补使用完整超时且不看「money/time 不够没重跑」的决定（第 2 条）。
- **不可撤销操作**：没有发现新的删除/覆盖操作；low-fix/override 都是向账本追加，`git` 操作都是只读。
- **规则、文档、代码一致性**：核对了 `.agents/instructions/model-review.md`、`AGENTS.md`、ADR 0068/0174、案例库。发现 `AGENTS.md:49` 与第 52 行/代码矛盾（第 5 条）；规则/ADR 的「重跑后仍是可重试错误才替补」与代码不符（第 2 条）。ADR 0174 说方案讨论不在范围内，但 `MODEL_LENSES` 的改动也作用到 `plan-review` 的 DeepSeek 固定提示，属于轻微范围外变化。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

在复核工具内部，**不会**：每个模型每轮的固定部分（角色、工具、任务、必答问题、侧重、输出格式）都排在「本次材料」之前；`head`、`base`、`previous`、`brief` 都在材料里，材料是最后一段。重试是**新会话**，重发的 prompt 与第一次逐字节相同（测试里也断言了 `requests[6].messages === requests[0].messages`）；追问是在同一会话末尾追加。测试 `[review chain] gives DeepSeek the same fixed prompt...` 验证了同一 `--base` 下第 1 轮和第 2 轮「本次材料」之前逐字节相同。

但有两个限定：
- 这个 diff 改了 DeepSeek 的固定侧重文字。对比**旧脚本已经跑过的轮次**，DeepSeek 的开头会变一次；如果某个 PR 跨这次部署（第 1 轮旧、第 2 轮新），那一轮会缓存未命中。新脚本内部从第 1 轮起就带，所以同一 PR 的新轮次之间一致。
- 必答问题是从 `--base` 读的，固定在「本次材料」之前。如果 `--base` 是移动的引用（例如 `origin/main`）且两轮之间移动了，固定部分会变。代码没有在运行时强制 `--base` 稳定；这是既有行为，但「每轮逐字节相同」的说法依赖调用方传稳定的 base 提交。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

没有发现新的不确定性进入发给模型的内容。新增的 `at: new Date().toISOString()` 只在 `low-fix` 账本记录里，不发给模型；`apiError`、`retry`、`retriedAfter` 也只进账本。`coveragePoints` 的轮次排序、`lowFixProblems` 的文件列表、报告输出都按固定顺序/账本顺序，不依赖对象遍历或无序集合。复核 prompt 的组装仍是确定性的。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有测试，且在 `test/tooling/opencode-review.test.mjs`；它属于 vitest 的 `tooling` 项目，CI 的 `policy`/`coverage` 检查会跑（本地对应 `npm run test:tooling`）。**但 `npm run check` 的 `check:steps` 不包含这个测试文件**，所以「npm run check 通过」不能证明这些新测试通过。测试里已有不少反向用例：非后续提交的 `chain-broken`、非替补 GLM 不计入、`medium-high` 拒绝、`no-test-change`、`too-many-files`、`too-many-lines`、`quote-not-found`、`no-low-errors`、`not-last-round`、`verdicts-not-committed`、手写 low-fix 缺测试、`parseUsage` 非法记录、`--accept-low` 参数误用等。

但**关键反向用例缺失**：没有覆盖「未复核提交 + `--previous` 指向自身/新提交的单模型轮」（第 1 条）、「重试因时间/费用不足被跳过时不得替补」（第 2 条）、「low-fix 证据在记录提交之后才补」（第 3 条）、「记录里的 `files`/`findings` 与重算不一致」（第 4 条）。因此现有测试不能证明门禁不可绕过。140 条是否全过未核实。

**4. 新产生的每个值，使用它的地方都能接受吗？**

逐项核对：
- `outcome: "api-error"`、`apiError`、`retry`、`retriedAfter`：`parseUsage` 接受字符串/不校验具体值，`singleLine` 会挡住换行；`resultLine` 只显示 `outcome`；`coveragePoints` 只把 `ok` 当覆盖点。两端能接受。
- `substitute: true`、`substituteFor`：生产端写完整 DeepSeek 模型名，`coveragePoints` 用 `record.substituteFor === REVIEW_MODELS[0]`、`record.model === GLM` 校验，能对上。
- `low-fix`：`parseUsage` 校验正整数 `round`、`from`/`head` 哈希、`cost === 0`、非空 `files`/`findings`；`nextRound`/`roundForRun` 用 `NOTE_MODES` 排除它；`reviewReport` 能读；`coveragePoints` 能插入链。基本能接受。
- **不一致的地方**：`files`/`findings` 生产后没有被门禁重算核对（第 4 条）；`findings` 的 `id` 没有唯一性校验，`reviewReport` 用 `find` 取第一条，可能展示错的原话；`low-fix` 证据用 `HEAD:` 而不是记录 `head:`（第 3 条）。
- `--accept-low`：只在 `--assert-reviewed` 下接受，`--report` 和普通复核都会被 `parseArgs` 拒绝（代码和测试一致）。
- `AGENTS.md`/规则/ADR 对替补和「两个模型」的描述与代码有两处不一致（第 2、5 条）。
