# 方案审核结论（核对提交 `27a078fc`）

方案正文与仓库内 `.agents/handoffs/2026-11-05-opencode-review-plan-t2-t3-t5-t6.md` 逐字一致；脚本为 `scripts/model-review/opencode-review.mjs`（1487 行）。

## 证实的（按严重度从高到低）

**1.【高】T2+T3 组合存在自我回归（提交复核记录必然改变 head，按方案自己的规则又要复审记录本身）**
- 证据：T2 规则 T2 节第 1 条要求“合并前，最后一轮复核的 `--head` 必须等于分支当前提交”，且拍板项 1 明确“只改 `docs/`、`.agents/` 文字的提交不豁免”；T3 第 3 条要求“线程在合并前把这个目录随 PR 一起提交”。提交记录文件 = 新提交 = 新 head ≠ 最后一轮复核的 head → 再跑一轮 → 那轮的记录又要提交 → 再跑。方案没写怎么断环；实际执行只会二选一：要么死循环烧钱，要么线程干脆不提交记录（绕回 F3）。
- 业界对照：GitHub 的措辞其实是“作废批准”仅限于“推了**影响 diff 的**提交”（"dismiss stale pull request approvals when commits are pushed that **affect the diff** in the pull request"，https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches ）；即业界规则本身就带最小的豁免面。方案硬引这条却没落地这个细节。
- 建议：把“需要复核的面”定义为**除 `.agents/reviews/**` 外的树内容差异**。`--assert-reviewed` 比较“给定 head 与账本 head 的 `git diff -- . ':(exclude).agents/reviews/**'` 是否为空”，为空即视为当前。这样记录提交不再触发复核，而 #248 那类 `.agents/instructions`、`ci/rules` 改动仍被覆盖（`bd0859a9` 提交说明自述“合并 main 后的规则改动（把摘要白名单收窄）未再复核”，豁免面收在 `.agents/reviews/` 独目录内不会放过它）。

**2.【高】T5 与现有“重跑补进原轮次”机制直接冲突，方案没处理**
- 证据：脚本每轮只写一个 `prompt.md`（`opencode-review.mjs:1426` `writeFileSync(join(roundDir, "prompt.md"), prompt)`；`--round` 时用 `roundForRun` 拿它和本次提示词逐字比对，`:1375-1384`、`:775-776` `ROUND_PROMPT_MISMATCH`）。改后两个模型提示词不同：用 `--models` 补跑失败模型时，磁盘上那个 prompt 必然和这次的不一致（补的可能还是另一个模型），必撞 `ROUND_PROMPT_MISMATCH`；单文件也分不清哪份 prompt 是发给谁的（F10 的“事后对照”随之失效一半）。
- 建议：按模型存 `<模型>.prompt.md`，比对按模型取；`buildPrompt`（`:176`）签名必须加 `model` 参数——方案完全没提这个改动。

**3.【中】`--assert-reviewed` 的规格不完备，按现文写实现依然有洞**
- `--out <结果目录>` 由调用方传（T2 节第 2 条）与 T3 “`--out` 不再由线程指定”自相矛盾：assert 指向任意旧账本就等于没拦。应由 `--pr`/`--topic` 按同一套推导取账本。
- 未说明用 `REVIEW_MODELS` 常量（`:24`）还是账本里出现的模型来核对“两个模型都是 ok”；应明确用常量。
- `readUsage` 遇坏行抛 `USAGE_LEDGER_INVALID`（`:744-745`）；assert 的反向用例缺“账本坏行”“账本里缺某个模型的行”两条。反向用例本身在途的核对也要确认**真的会失败**（见必答 3）。

**4.【中】T5 没有任何自动检查（必答问题 3 对 T5 不满足）**
- 方案的验收只有一次花钱对比；侧重句没有回归测试钉死。现有测试恰好相反地断言“两次 `buildPrompt` 的固定段逐字节相同”（`test/tooling/opencode-review.test.mjs:171-196`），实施时会：“先失败再改”，方案应写明改法（按模型分别断言固定段相同、各含各的侧重句、互不含对方侧重句），再加反向用例：删掉侧重句或换模型取侧重要有测试失败。

**5.【中】“合并 main 之后”两个方向没分开定**
- 把 main merge 进**分支**（产生分支上的合并提交，assert 可在合并前拦，正文按此写）；分支 merge**进 main** 之后（main 新增提交，只能做“事后增量复核”，拦不住）。拍板项 1 说“每次合并 main 后多跑一轮只看增量的复核”，两种情形的操作、`--previous` 取值、记录往哪提交（后者只能提交到 main）方案都没写。会照着做错的人（线程）要靠猜。

**6.【低】T3 的 `--topic` 重新打开了它要堵的门**
- 同一件事换个短名就是新账本，脚本无法分辨（plan 讨论没有像 PR 编号那样的外部锚点），先问线仍可绕。缓解：T6 要求贴的 `REVIEW_SPENT_TOTAL` 本就带路径（`opencode-review.mjs:1473`），把“列出一个议题用过的所有账本目录”写成 T6 的一行能暴露换名；更硬的做法是账本目录由 `--brief` 文件路径哈希推导。力度取舍留给 Andy。

**7.【低】记录进仓库后会进复核模型的眼**
- PR 复核副本是干净克隆（`:1270-1290` `prepareCopy` 只删 `.opencode`、`opencode.json(c)`、`.env*`、外链），`.agents/reviews/**` 一旦提交，后续轮次的模型能直接读到**同一 PR 之前几轮的结论**。不违反必答 1（不是开头改写），但上一轮结论会锚定下一轮，也可能是喂料通道。建议在 prompt 固定段加一句“`.agents/reviews/` 下的内容不作核对依据”（或写明接受该风险）。

**8.【低】T6 宣布“没有自动检查”，其实有低成本选项**
- 自检探针会检查系统提示里不能出现副本中 `AGENTS.md` 的标题（`model-review.md:63`、测试 `opencode-review.test.mjs:1016-1024` 一带），提示词调整有温和护栏；而 assert 输出可以规定固定写进合并提交说明，`git log --format=%B` 即可 grep，把 T6 的第 3、4 行从“贴在 PR 描述”升级为机器可查。参考先例：本仓库 `check:` 系列都是 `node scripts/check-*.mjs`（`package.json:27-47`）。此外 T6 若把新节标题插进"每次都要问的问题”一节内部会把问题截断（`reviewQuestions` 按下一个 `##`/锚点切分，`:134-145`；现有测试只断言 ≥3 条，`:165-169`，建议改成“恰好 3 条”）。

## 前提核对（未发现错案）
- P2 引文与 GitHub 文档逐字相符；该页还多一句支持方案的原文："approving reviews will be dismissed as stale if the merge base introduces new changes after the review was submitted"——即 GitHub 连 merge base 变化都算，方案“照搬”的类比立得住。
- P10 与 Anthropic README 一致：4 个并行代理（#1/#2 CLAUDE.md 合规、#3 明显 bug、#4 git blame/历史）、"Scores each issue 0-100"、"Filters out issues below 80 confidence threshold"（源码同仓 `plugins/code-review/README.md`）。方案不给打分过滤的理由（线程逐条判断）成立，但可注明：Anthropic 加过滤的目的是压误报噪声，与“线程判成立”不重复，属可选项。
- P6 属实（本地提交说明）：`a3aa0ad4`"OpenCode 代码复核第 4 轮（累计约 0.46 美元）"；`3bfc0f8a`"第 1 轮（两个模型，累计约 0.11 美元）"；`bd0859a9`"双模型复核 2 轮（0.26 美元）"。
- 更正一节正确：`docs/product-vision.md:124` 的“决策记录"确指"主动性的校准数据（它何时该提醒、何时该沉默……）"，不是开发复核记录。
- P4/P5/P7/P12/P13 附行号均核实无误。

## 未核实
- PR #248 的网页原文（fetch 404，疑为私有仓库）；文本以本地提交说明 `bd0859a9` 作一手替代证据。
- 拍板项 3 举例"#213 之后 I-73"——I-73 行只写成因于 #207，#213 的关系未核实（不影响方案结论，只是举例要改准）:docs/incidents-and-gates.md:112。

## 如果由我来定
1. **先 T3 后 T2（或一起落）**：assert 只在账本进仓库后才有意义；顺序反过来 assert 没事可查。交接排队时也按此实施。
2. **T2 的“改动面"收窄成规则原文**："`.agents/reviews/**` 单独提交不重置复核状态；其余任何提交（含合并 main 的冲突解决、`docs/`、`.agents/instructions`）都算”，断环。
3. **assert 规格**：账本由 `--pr`/`--topic` 推导；只看 `mode=="code-review"` 的记录；两模型的 ok 以 `REVIEW_MODELS` 常量核对；反向用例至少四组（head 不等、某模型非 ok、只有更早轮次 ok、账本坏行/缺模型行），实施时逐条运行证明失败。
4. **T5**：`buildPrompt` 加 `model`，prompt 按模型存档；侧重句照方案文本（DeepSeek 管错误路径/安全/资源/规则冲突，GLM 管跨模块契约/测试覆盖/文档一致）——侧重划分和 I-73 补漏方向是对的；保留一次真实对比，比法用同一约定：一个 `--topic` 账本里跑第 1 轮（同提示词对照基线、`--models` 两模型不改提示）和第 2 轮（侧重后），跨轮同序列化对比意见重叠与漏报；过滤所省的钱和被截断风险可作为后续可选项，不阻塞本项。
5. **T6**：增"恰好 3 条问题"断言和模板节位置的注意事项之外，把 assert 输出固定行要求并进合并提交说明，`git log` 可查；“复盘通过≠测试通过”一句照写。

## 必答问题
1. **请求开头**：T2/T3/T6 不改任何发给模型的内容——提示词仍由 `buildPrompt` 的固定段+单条材料消息构成（`opencode-review.mjs:176-203`），`reviewQuestions` 只解析 checklist 节（`:134-145`），改动都在 checklist 之外（T6 注意勿插进该节内部）；每个会话仍然只在末尾追加，变值（head/base/previous/brief）全在唯一一条用户消息里。T5 改变的是**新会话**首条消息的固定段：每次运行都新开会话、只有追问一步带 `--session`（`:485`），规则第 67 行写明追问只追加——“没改写任何已发内容”，不构成必答 1 的违规，但要按第 2 条给自动检查。新增的记录文件进副本后只是模型**可读的新材料**，不是已发内容的开头变化。
2. **字节一致性**：T5 侧重句是 `MODE_TEXT` 里的静态文本，不带时间、无依序集合；提示词可变值只有提交哈希和 brief 内容，同输入同字节，未发现会漂移的构造。`usage.jsonl` 的 `at: new Date().toISOString()`（`:1447`）带时间但只落盘、不回发给模型，不在该规则约束范围。assert 打印“差了哪些提交”建议固定排序（rev-list 默认与审查意图均稳定，非模型输入，仅提示）。
3. **自动检查**：T2 有三组反向用例——方向对，但按第 3 条补齐或在实施时补齐“账本缺模型/坏行/mode 过滤"，反向必须跑出非零退出码才算立项成立；T3 有基础测试但缺 assert 相关两组；T5 现状**没有**（第 4 条给的测试方案落实后才算有）；T6 自认没有，第 5、8 条给了低成本替代。
