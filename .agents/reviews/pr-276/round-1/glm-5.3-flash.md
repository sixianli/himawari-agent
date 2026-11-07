改动只有 `docs/engineering-casebook.md` 一个文件。现在核对作者说法与仓库内证据。
输出被截断了，改用 `git log -1` 单查这两个提交。
引用的 usage.jsonl 没找到，检查 reviews 目录实际结构。
工作树是 sparse checkout（95% 文件在场），被引的 usage.jsonl 可能没被检出。用 git 查这两个路径是否在仓库里。
核对一个细节：5870f36 提交说明里“恢复后 18 个通过”与当前测试文件的用例数是否一致。
最后确认案例库文件没有被任何发给模型的请求组装路径引用。
# 复核结论

本次 PR（`ba9ffaed`）只改 `docs/engineering-casebook.md`（+79/-1）：新增案例 85、目录第 85 项、能力对照表"Agent 安全"行、案例 81 的后续段。无代码改动。以下按严重度排列。

「读代码证实的」与「推测」分开说明；证据只引我亲自读过的行。

---

## 一、发现的问题（按严重度）

**1.【中】docs/engineering-casebook.md:5390 — 两条费用数字的出处对任何后续复核者都不可达，等于不可核对的断言**
- 问题：案例写「方案讨论 0.3471 美元（`.agents/reviews/topic-trusted-prompt-egress/usage.jsonl`），代码复核 4 轮共 0.5596 美元（`.agents/reviews/pr-268/usage.jsonl`）」，但复核副本按设计删除整个 `.agents/reviews/`（`.agents/instructions/model-review.md:89` "复核副本用 sparse checkout 去掉整个 `.agents/reviews/`"；本环境即被 `REVIEW_GIT_REFUSED` 拒绝，含工作树——sparse checkout 只有 95% 文件在场）。
- 读代码证实的：仓库规则层面确实把这些文件当作数字的唯一出处（`model-review.md:88-93`）；复核端永远读不到它。
- 推测：数字本身可能正确，但目前无法核实是否与账本一致。
- 建议：把可核对的合规要点（轮数、是否每轮两个模型 `ok`）在 PR 汇报里以粘贴账本摘要行的形式固化，而不是只留一个对复核者不可见的路径。这正是 I-73 类问题（“引用的清单它认可吗”）在文档侧的重演。

**2.【低】docs/engineering-casebook.md:5349（业界引文）— 两条 ✅ 引文在离线环境不可核实**
- 读代码证实的：本环境不能上网，两条引文（Google 排除规则、Presidio allow list，:5369-5371 行）无法对照原文；引文句式与案例库图例要求（✅、短引文）一致。
- 建议：无需改动；接受为「未核实」。

**3.【低】`5870f36` 提交说明与测试规模的口径不一致（仅影响案例里的转述细节）**
- 读代码证实的：提交说明写「10 个用例失败…恢复后 18 个通过」；同一提交点上 `trusted-prompt-egress.unit.test.ts` 实际只有 9 个 `it()`（`git show 5870f36:apps/agent-service/test/trusted-prompt-egress.unit.test.ts`，含 91、99、109、126、135、144、154、162、186 行），18 只能来自多个测试文件合计。
- 案例 85 的转述（:5359 行「10 次运行失败，恢复后全部通过」）与提交说明兼容，不构成与代码不符，但"全部通过"的统计口径未写明。
- 建议：接受现状；不必改。

**4.【低，流程风险而非缺陷】docs/engineering-casebook.md:5394 引用 `.agents/reviews/topic-trusted-prompt-egress/`、`.agents/reviews/pr-268/` 作为「方案讨论和逐条判断」附件** —— 同问题 1，路径对复核端不可读；后续轮次的复核模型无法用它回查「GLM 独立方案」「DeepSeek 指出切段问题」这些备选理由（:5373、5374 行）。

**未发现的问题**：锚点、目录、能力表、I-78 行、规则第 11 条、其余数字、术语解释与模板九节均核对通过（见下）。

---

## 二、侧重检查（普通使用流程走查 + 文档/测试一致性）

我选的流程：**Andy 在对话里说「我的验证码是 482910」→ 出口遮盖 → 拦截记录页面**。

1. 提示词目录产出固定指令：`packages/prompt-catalog/src/memory.ts:16-17`（含「密码和验证码用 restricted。」「confidence 是 0 到 1000」原文）→ `packages/prompt-catalog/src/trusted.ts:10`（`TRUSTED_PROMPT_TEXTS`）→ `entry.ts:59-76`（24 字符门槛、去重、按长度排序）。
2. 出口遮盖：`packages/application/src/services/model-egress.ts:198`（默认用目录清单）→ `packages/sensitive-capture/src/redaction.ts:172-237`（24 字符再过滤、34 个填充字符 `:174-178`、原地填充 `:220-226`、空跑 `:227-232`、换回失败抛 `EgressRedactionError` `:235`）→ 验证码规则 `\d{4,8}` + `CODE_WINDOW=40` `:69`、`:340-350`。
3. 测试覆盖（`npm run check:prompt-catalog`，package.json:52）：`trusted-prompt-egress.unit.test.ts:91` 发记忆指令原样不变、`:99` REVERSE（清单为空时 1000 被遮并记录）、`:109` 目录每个条目两条角色都原样、`:126` 隔着固定文字的关键词仍生效、`:135/144/154/162/171/179/186` 正反均覆盖；`trusted-text.unit.test.ts` 与 `sensitive-interceptions.unit.test.ts` 的 [I-78] 用例存在。反向用例方向与正向相反，确实会失败。
4. **没有测试覆盖的路径**（读到的）：`redaction.ts:235` 的「换回对不上就拒绝发送」异常在生产 egress 流水线上的传播后果，未见专门用例（未核实具体用例，仅浏览两个主要测试文件未发现）；「加上空跑之后的总开销」「整理记忆缓存命中率变化」两处性能，案例自己写「未测量」，仓库也无基准脚本佐证——诚实，但确实是空白。
5. 结论：文档描述的机制与代码逐条符合；本次纯文档改动本身没有专属自动检查，依赖 `npm run check` 的通用文档治理（未运行，未核实是否零报错）。

---

## 三、作者说法逐条核对

1. **与 PR #268 / I-78 / prompt-prefix 第 11 条一致 — 证实**。`27e1d33` 即 PR #268 合并提交；`5870f36` 包含案例所述全部要点（清单、填充、空跑退回、页面写明用途、规则第 11 条、7.4/7.8 毫秒、"10 个用例失败"）；`docs/incidents-and-gates.md:116` 的 I-78 行与案例 85 各段（现象、根因、复现、门槛、测试文件名）一一对应；`.claude/rules/prompt-prefix.md:53` 的第 11 条正文与案例「对比与取舍」要点一致。
2. **数字出处 — 部分证实，部分未核实**：7.4/7.8 毫秒、"75 段清单""10 个用例失败"来自 `5870f36` 提交说明（证实）；0.3471 / 0.5596 美元：`git log -- .agents/reviews` 被本环境拒绝，**未核实**；生产验收截图仓库中确实没有（作者已如实声明，证实）。
3. **两条业界引文打开过原文 — 未核实**（离线）。
4. **目录第 85 项 + 能力表更新 — 证实**（diff 中 :112 行 TOC、能力表行均已插入）。
5. 附加核对：作者说"第 11 条"——实际上 trusted-text 的所有约束写在 prompt-prefix.md 第 11 条的子弹（:53 行）里，`docs/kv-cache-guide.md:66` 也是第 11 行，引用编号正确。

---

## 四、必答问题

1. **不会改变模型已见过的请求开头。** 本次 diff 只改 `docs/engineering-casebook.md`；`packages/`、`apps/` 里没有任何代码引用 casebook（两次 grep 均无结果），它也不是 `.claude/rules/` 会话规则文件。发给模型的内容本轮零变化，自然仍满足"只追加、每轮变的值在最后一条消息"。案例里描述的提示词目录变化（「老对话的请求开头可能变一次」）是 I-78 修复（上一个 PR）的既有行为，已写进规则第 11 条，不是本次 PR 引入。
2. **不会让同一段文字变成不同字节。** 纯文档改动，无时间戳、无运行时输入、无集合顺序问题；文档正文里 `2026-11-07` 等日期是叙述性文字，不进入任何请求。
3. **有部分自动检查；反向用例确实会失败。** 行为侧：`check:prompt-catalog`（package.json:52）里三个 [I-78] 测试文件在 `npm run check` 中运行，REVERSE 用例（`trusted-prompt-egress` :99、"旧页面代码上失败"，见 I-78 行）方向正确——清单为空时 `1000` 被遮、正向用例断言"原样发出"，两者互斥，撤清单必然翻红（`5870f36` 留有 10 个失败记录）。案例 85 新增的目录项/锚点本身没有专属检查（未核实 `npm run check` 的文档治理是否会覆盖它，未运行）。
4. **每个新值的双端核对通过，唯二例外是费用数字。** 逐个：目录锚点 `#case-trusted-prompt-text`（:5334）与 TOC/能力表链接一致；`incidents-and-gates.md#incidents`（:32）存在；`adr/0148-…md` 存在；`TRUSTED_PROMPT_TEXTS` 生产端（`entry.ts:59` ≥24、`trusted.ts:10`）与消费端（`model-egress.ts:198` 默认值、`redaction.ts:172,210-212` 同一 24 字符再过滤、测试 `:145-146` 断言 ≥24 且不含"。"、`:127` 断言含 MEMORY_CAPTURE）两端同值。唯一无法到达两端的值是 casebook:5390 的两条费用数字（见问题 1），属 I-73 类风险。
