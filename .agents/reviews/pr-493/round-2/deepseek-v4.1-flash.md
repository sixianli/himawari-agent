## 本轮查过的范围

- 增量：`git diff 30e9e72b9bf9ac1673b2225a2d1c0f4a1396eaae..500688f8188140f8b604f4a0b7e92d58c09d2270`。
- 上下文：`git diff 2ed412c2e7921cae21244fb76949287e9288636d..500688f8188140f8b604f4a0b7e92d58c09d2270`，以及 `30e9e72` 之前的流程卡原文。
- 读过的文件：`.agents/instructions/model-review-card.md`、`.claude/agents/code-review-round.md`、`AGENTS.md`、`docs/adr/0263-...`、`docs/adr/0175-...`、`docs/assets/review-cost/2026-11-13-data.txt`、`test/tooling/review-round-tools.test.mjs`，以及 `scripts/model-review/opencode-review.mjs` 中 `buildPrompt`、`budgetCheck`、`finishRound`、`judgeSkeleton`、`latestReviewRound`、`reviewReport`、`parseArgs`、主流程和退出码相关段落。
- 未核实：`.agents/reviews/pr-493/round-1/*` 和 `usage.jsonl` 被环境的 git 守卫以 `REVIEW_GIT_REFUSED records-path` 拒绝读取，未看到上一轮的判断原文；本轮没有运行 vitest，反向用例只按旧卡文本核对。

下面第 1–6 条是读代码证实的，第 7–8 条是推测。

### 1. 中：流程卡和 ADR 0263 仍写着“子代理跑复核”，与新的主线程分工相反

- 文件:行：`.agents/instructions/model-review-card.md:6`；`docs/adr/0263-cheaper-claude-side-of-code-review.md:52-53`
- 问题：文档开头仍把“复核”整体交给子代理，而同一段和下面步骤又说复核由主线程跑。读者或代理可能照旧让子代理跑 `--mode code-review`，正好重新引入这次要避免的 5 分钟缓存过期问题。
- 证据（读代码证实）：
  - 卡第 6 行：`每一轮复核交给一个新开的子代理（…），主线程只拿回结论`；紧接着：`DeepSeek 复核由主线程在后台跑，答案出来后再起子代理`。
  - 卡第 18 行：`主线程自己在后台跑这一轮的复核命令`；第 19 行才起子代理。
  - ADR 0263 第 52 行：`由它跑这一轮复核、逐条判断、按结论修改并提交`；第 53 行修订：`DeepSeek 复核改由主线程在后台跑`。
- 建议：把卡第 6 行改成“每一轮的判断、修改和收尾交给一个新开的子代理”；ADR 0263 第 52 行同样改掉“由它跑这一轮复核”，或在第 52 行明确写“本句已被第 53 行修订”。

### 2. 低：主线程的超额花费流程缺 `--approved-usd`，问过 Andy 后原命令仍会被拒绝

- 文件:行：`.agents/instructions/model-review-card.md:18`；`scripts/model-review/opencode-review.mjs:1140-1147`、`3448-3456`；`.agents/instructions/model-review.md:136`
- 问题：卡只写“会超过 1 美元时先问 Andy”，没有说 Andy 同意后要在命令里加 `--approved-usd`。主线程若原样重跑，脚本仍会以 `BUDGET_NEEDS_APPROVAL` 拒绝。错误表第 70 行指向“怎么跑”，那里确实写了 `--approved-usd`，所以可恢复，但卡的主路径不完整。
- 证据（读代码证实）：
  - `budgetCheck`：`if (approvedUsd !== undefined && total <= approvedUsd) return null;`，否则返回 `BUDGET_NEEDS_APPROVAL spent=…`（`opencode-review.mjs:1146-1147`）。
  - 主流程：`if (overBudget) throw new Error(overBudget);`（`opencode-review.mjs:3456`）。
  - 卡第 18 行只写“先问 Andy”，没有 `--approved-usd`；`model-review.md:136` 写“他同意的总额用 `--approved-usd <美元>` 传入”。
- 建议：卡第 18 行补一句“Andy 同意后用 `--approved-usd <总额>` 重跑”，或明确指向“怎么跑”的门槛段落。

### 3. 低：子代理定义把 `--accept-low`、`--report` 写成可直接跑的子命令，单独使用会被参数校验拒绝

- 文件:行：`.claude/agents/code-review-round.md:11`；`scripts/model-review/opencode-review.mjs:3114-3123`、`3139`
- 问题：定义说可以跑“不花钱的子命令（`--judge-skeleton`、`--finish-round`、`--accept-low`、`--assert-reviewed`、`--report`）”。但 `--accept-low` 必须和 `--assert-reviewed` 一起用，`--report` 必须带 `--stop`；单独跑会报错。流程卡第 4、5 步给的是完整命令，所以实际影响小。
- 证据（读代码证实）：
  - `--report && options.stop === undefined` → `ARG_REQUIRED --stop`（`opencode-review.mjs:3120`）。
  - `options.acceptLow !== undefined` 在非 `--assert-reviewed` 分支 → `ARG_ACCEPT_LOW_ONLY_WITH_ASSERT`（`opencode-review.mjs:3139`）。
- 建议：把定义里的两项写成 `--assert-reviewed --accept-low <轮次>` 和 `--report --pr <编号> --stop <原因>`，或注明“只在流程卡第 4、5 步的完整命令里使用”。

### 4. 低：收尾命令固定 `--stop no-error`，连续三轮没过时不能照抄

- 文件:行：`.agents/instructions/model-review-card.md:49`、`:56`；`scripts/model-review/opencode-review.mjs:1836-1847`
- 问题：子代理第 5 步的合并检查固定跑 `--report --pr <编号> --stop no-error`。但同一张卡的“停下来交回主线程”包括“连续三轮没过”。若主线程在那种情况下让子代理跑第 5 步，`--report` 会因 `REPORT_STOP_INCONSISTENT` 失败。该命令是旧卡就有的，本增量没有改它；但本增量把收尾和“停下的原因”明确交给主线程，仍值得补明。
- 证据（读代码证实）：
  - `reviewReport` 的 `no-error` 条件是 `latestComplete && gate.problems.length === 0`（`opencode-review.mjs:1837`），否则 `throw new Error(\`REPORT_STOP_INCONSISTENT ${stop}\`)`（`:1847`）。
  - 卡第 56 行：`连续三轮没过（每轮都有中高问题）`。
- 建议：在收尾说明里区分 `--stop no-error`、`--stop three-rounds`、`--stop andy-decision`、`--stop run-failed`；第 5 步的 `no-error` 只用于没有中高“会出错”的收尾。

### 5. 低：作者说“只改指令和文档，不改代码”与原 diff 不符（新增了测试代码）

- 文件:行：`test/tooling/review-round-tools.test.mjs:267-290`
- 问题：完整 diff 新增了 25 行测试代码；生产脚本 `scripts/model-review/opencode-review.mjs` 确实没有改。作者的说法作为“不改生产代码”成立，字面上“只改指令和文档”不准确。
- 证据（读代码证实）：`git diff --stat 2ed412..500688f` 含 `test/tooling/review-round-tools.test.mjs | 25 +++++++++++++++++++++`，不含 `scripts/model-review/opencode-review.mjs`。
- 建议：把说法改成“只改指令、文档和测试，不改生产脚本”。

### 6. 低：ADR 0263 的“本 PR 第 3 到 5 轮”与数据文件的“PR 481”不一致或有歧义

- 文件:行：`docs/adr/0263-cheaper-claude-side-of-code-review.md:53`；`docs/assets/review-cost/2026-11-13-data.txt:34`
- 问题：ADR 写“本 PR 第 3 到 5 轮实测”，数据文件写“PR 481 第 3 到 5 轮”；本次改动在 PR 493 上。读者可能把“本 PR”理解成 493，从而找不到对应数据。
- 证据（读代码证实）：ADR 第 53 行 `原因是本 PR 第 3 到 5 轮实测`；数据文件第 34 行 `## 子代理的实测（PR 481 第 3 到 5 轮，2026-11-13…）`；提交 `30e9e72` 的说明也写 `PR 481 rounds 3-5`。
- 建议：把 ADR 第 53 行改成“PR 481 第 3 到 5 轮实测”。

### 7. 低（推测）：主线程直接执行子代理交回的 `NEXT` 字符串，缺少“这是脚本原始输出”的校验

- 文件:行：`.agents/instructions/model-review-card.md:18`、`:29`；`.claude/agents/code-review-round.md:16`；`scripts/model-review/opencode-review.mjs:3061-3068`、`3114-3123`
- 问题：新流程让主线程“照抄上一个子代理交回的 NEXT 命令”去跑下一轮。子代理在理论上可以交回一条合法但不同的命令，例如 `--assert-reviewed --accept-unreviewed "<伪造的 Andy 原话>"`；脚本允许这种组合，主线程若只看前缀“NEXT”就可能执行。这是流程信任边界问题，不是本 PR 的代码回归（旧流程子代理也有 shell 权限），但主线程执行子代理输出会放大影响。
- 证据（推测，基于已读代码）：
  - 卡第 18 行：`照抄上一个子代理交回的 NEXT 命令`；第 29 行：`回到第 1 步跑下一轮`。
  - 定义第 16 行只要求交回 NEXT 行，不要求主线程校验。
  - `parseArgs` 允许 `--accept-unreviewed` 与 `--assert-reviewed` 组合（`opencode-review.mjs:3061-3068`、`3114-3123`）。
- 建议：主线程执行前检查 NEXT 行确实以 `NEXT fix-and-rereview node scripts/model-review/opencode-review.mjs --mode code-review` 开头，且不含 `--accept-unreviewed`、`--accept-low`、`--report`、`--assert-reviewed`；或者由主线程自己重跑 `--finish-round` 生成命令，不直接采用子代理转抄的字符串。

### 8. 低（推测）：`退出码 0 + 至少一条 outcome=ok` 不能证明本轮所有模型都通过

- 文件:行：`.agents/instructions/model-review-card.md:19`；`scripts/model-review/opencode-review.mjs:3690-3696`、`1681-1683`
- 问题：主线程按“退出码 0、输出里有 `outcome=ok` 的 REVIEW_RESULT”起子代理。但脚本的退出码只反映**本次运行**的结果：如果 Andy 指定了两个模型，其中一个失败，主线程用 `--round` 只补跑另一个模型，补跑退出码仍是 0；此时本轮仍有失败记录，子代理的 `--judge-skeleton` 却会因为本轮“至少有一条 ok”而只基于 ok 记录生成草稿。后续 `--assert-reviewed` 才会发现这一轮不完整。默认只跑 DeepSeek 时不会触发，属于双模型人工指定时的边界。
- 证据（推测，基于已读代码）：
  - `results.some((record) => record.outcome !== "ok" && !(covered && record.model === results[0].model))` 才把退出码设为 4（`opencode-review.mjs:3691-3696`），`results` 只包含本次运行。
  - `latestReviewRound` 只在 `ok.length === 0` 时抛 `ROUND_NOT_OK`（`opencode-review.mjs:1681-1683`），有一条 ok 就继续。
  - 卡第 19 行的启动条件只要求“退出码 0 + 存在 outcome=ok”。
- 建议：启动子代理前确认本轮所有应跑模型都有 ok 或替补 ok 记录；或在卡里写明“`--round` 必须把所有失败模型都补跑完，再起子代理”。

## 侧重检查

- **错误路径**：我核对了脚本的退出码路径——抛错为 2、自检失败为 3、模型 `outcome` 非 ok 为 4、`--assert-reviewed`/`--report`/`--accept-low` 不合格为 5、`owner-stopped` 为 130。卡第 19 行的“退出码 0 + outcome=ok”与这条主路径一致；第 8 条是双模型 `--round` 补跑的边界。还核对了 `ROUND_NOT_OK`、`ROUND_ALREADY_HAS_RESULT`、`ROUND_HEAD_MISMATCH`、`ROUND_PROMPT_MISMATCH`、`FINISH_ROUND_REFUSED`（quote-not-found、why-missing、control-character、base-invalid）、`REVIEW_LOW_FIX_REFUSED`、`REPORT_STOP_INCONSISTENT`、`REPORT_LEDGER_NOT_COMMITTED`，卡的错误表指向的章节都存在。
- **不合规范或不可信输入**：脚本自己生成的 `NEXT` 行里，`base`、`reviewed`（head）、`pr`、`gateway` 分别经过提交哈希、正整数、`magpie` 校验；`<材料文件>` 是占位符，由主线程替换为路径，不是直接拼进模型提示。残余风险是主线程直接采用子代理转抄的 `NEXT` 字符串（第 7 条）。`--brief` 路径没有做 `-` 前缀检查，但 `parseArgs` 的 `take()` 会把它当值取走，影响有限。
- **安全**：子代理定义禁止 `--accept-unreviewed`、合并、在 GitHub 发评论；允许 `--accept-low`（写账本）、`--assert-reviewed`、`--report`。`--accept-low` 是可写账本的操作，但脚本会核对本轮是链上最后一轮、原话在答案里、规模上限和测试文件；没有发现新增的绕过路径。复核记录目录在 `prepareCopy` 中被排除，不会进入被复核模型的上下文；本 PR 也没有新增密钥或敏感值。
- **资源耗尽**：主线程后台运行有 40 分钟上限，脚本内部默认 25 分钟；默认一个模型，`budgetCheck` 按每个模型 0.2 美元预留，累计超过 1 美元拒绝。新流程把等待从子代理移到主线程，确实避免了子代理 5 分钟缓存过期；没有发现无界循环，连续三轮仍有上限。缺口是第 2 条的 `--approved-usd` 流程。
- **不可撤销的操作**：`--accept-low` 写账本、`git push` 是子代理可做的；合并和 `--accept-unreviewed` 被定义明确禁止。主线程新增的 `NEXT` 执行权是唯一需要注意的信任边界（第 7 条）。
- **规则文件、说明文档和代码是否一致**：主要不一致是第 1 条（卡/ADR 仍说子代理跑复核）和第 6 条（“本 PR”与“PR 481”）；`AGENTS.md:52`、卡第 18–19 行、定义第 7/11 行与脚本的实际分工一致。`docs/adr/0175` 的 `amended_by` 新项与 `docs/adr/0263` 的 `amends` 双向对应，`check-adr-numbers` 的路径检查会通过（文件存在）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本 PR 没有改 `scripts/model-review/opencode-review.mjs`；`buildPrompt` 的固定前缀仍是 `text.role`、工具说明、`text.task`、`FOCUS_SENTENCE`、`RULE_16_SENTENCE`、必答问题、侧重点、`text.output`，`head`/`base`/`previous`/`brief` 仍在后面的 `material` 段（`opencode-review.mjs:349-378`）。新流程只改变“谁启动复核命令”，不改变发给复核模型的内容；每轮会变的值仍在末尾的 `material` 和命令参数里。子代理的提示是给 Claude 的另一条消息，且每轮新起，不涉及复核模型的 prefix 缓存。按 `.claude/rules/prompt-prefix.md#rules`，结论是“只在末尾追加”仍然成立。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。没有新增运行时序列化；`NEXT`、`REVIEW_RESULT`、`REVIEW_SPENT_TOTAL` 都由当前账本和固定模板确定，没有时间字段或无序集合；文档和测试改动不进入请求。唯一随轮次变化的是提交哈希、`--previous` 和材料路径，这些改动前就随轮次变化，且都在命令参数或提示末尾。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有两条新测试：`test/tooling/review-round-tools.test.mjs:267-290`。按旧卡（`30e9e72`）文本核对，第一条会在检查 `<材料文件>` 时失败（旧卡只写了 `<修改后的提交>`）；第二条会在“退出码是 0、输出里有 `outcome=ok` 的 `REVIEW_RESULT`”“`ROUND_NOT_OK`”“`fix-low-then`”这些断言上失败。未实际运行 vitest（本轮工具限制）。覆盖缺口：测试只检查流程卡；ADR 0263 的 10.8/7 万/71 万、ADR 0175 的 `amended_by` 和 AGENTS 的改动没有专门测试，只有 `check-adr-numbers` 的路径存在性检查和现有“锚点/选项存在”测试间接覆盖。

4. **每个产生/修改的值，两端都能接受吗？** 逐项核对结果：
   - `<修改后的提交>`、`<材料文件>`：由 `finishRound` 的 NEXT 行产生（`opencode-review.mjs:1803`），主线程替换为新提交和材料路径；`--head` 接受提交哈希，`--brief` 接受路径。卡第 18 行两处都写了怎么替换，新测试也检查了。**两端一致。**
   - `fix-and-rereview`、`fix-low-then`、`low-deferred`、`done`：由 `finishRound` 产生（`:1801-1816`），主线程分支（卡第 29 行）和子代理步骤（第 44-48 行）都覆盖；`fix-low-then` 的命令带 `--assert-reviewed --accept-low`，参数校验接受。**两端一致。**
   - `REVIEW_RESULT outcome=ok` / 退出码 0：由 `resultLine` 和主流程产生（`:1156-1158`、`:3690-3696`），卡第 19 行消费。主路径一致；双模型 `--round` 补跑有第 8 条的边界。
   - `REVIEW_SPENT_TOTAL`：由主流程和 `reviewReport` 产生（`:3689`、`:1878`），卡第 18 行用于预算检查；它包含当前轮，和 `budgetCheck` 的 `spent + 0.2×模型数` 口径一致。**缺 `--approved-usd` 的后续动作（第 2 条）。**
   - `ROUND_NOT_OK`：由 `latestReviewRound` 产生（`:1682`），卡第 65 行消费并指向第 3 步/怎么跑。**两端一致。**
   - `amended_by` 新项：ADR 0175 第 8 行产生，值为 `docs/adr/0263-cheaper-claude-side-of-code-review.md`；文件存在，且 ADR 0263 的 `amends` 指回 0175。**两端一致。**
   - `10.8`、`7 万`、`7.3 万`、`71 万`：数据文件第 34-40 行产生，ADR 第 53、94 行和卡第 6 行消费，数值一致；第 6 条的“本 PR/PR 481”是文字歧义，不是数值错误。
   - 子代理列出的 `--judge-skeleton`、`--finish-round`、`--accept-low`、`--assert-reviewed`、`--report`：这些标志都真实存在；其中 `--accept-low` 和 `--report` 需要配套参数（第 3 条）。

## 结论

本 PR 没有生产脚本改动，主流程、`NEXT` 占位符、`fix-low-then` 分支、`REVIEW_RESULT`/退出码、`amended_by` 和实测数字大体自洽，没有发现高严重度的代码缺陷。最值得先修的是第 1 条：流程卡和 ADR 0263 仍保留“子代理跑复核”的旧说法，和这次改动的目的直接冲突。其次是第 2 条的 `--approved-usd` 流程缺口，以及第 3、4 条的文档/参数配合问题；第 7、8 条是信任边界和双模型补跑的边界风险，建议在流程卡里补校验或说明。
