## 总体判断

方向（让增量轮更便宜、减少流程性重跑）有价值，但 v1 不能直接实施：C 的新枚举与现有解析器/合并检查不兼容（正是 I-73 那类问题），D 的自检缓存会跳过每个 PR 的 `AGENTS.md` 检查，E1 与现行严重度规则冲突，A 又会改动固定前缀并可能压掉真实意见。建议拆小、先测、每步带反向用例。

我只读了代码和一手网页，没有运行测试；测试结论均来自读代码。

## 侧重检查

- **错误路径**：查了 `PROMPT_TOO_LARGE`（`opencode-review.mjs:3447-3448`）、`roundForRun` 补跑提示词校验（`:2022-2069`）、`--accept-low` 的拒绝原因（`:1219-1276`）、`plan-claims` 的坏行/坏引文处理（`plan-claims.mjs:40-69`、`:161-171`）。结论：C 的新值会在解析阶段被当成坏行；A 加内容后没有容量控制。
- **不合规范/不可信输入**：查了 `verdicts.jsonl` 被喂进下一轮提示词、PR 可改的 `review-models.json`、PR 自带的 `AGENTS.md`、C 的 `文件:行@提交`、B 的动态测试配置。结论：四处置信边界都变了，方案没有相应校验。
- **安全**：查了自检里的项目指令检查（`:2467-2475`、`:2500-2506`）、固定临时目录（`:3486-3492`、`:2803-2805`）、提示词注入（A）。结论：D 的缓存会漏掉 `AGENTS.md` 检查；固定 `/tmp` 路径有并发/符号链接/残留风险。
- **资源耗尽**：查了 100 KB 提示词上限、A 的“上一轮每条意见”、C 的整份句子清单、E1 的“几十万行/NaN”。结论：A/C 没有上限；E1 可能把资源耗尽类问题降级。
- **不可撤销操作**：查了 `--accept-low`、合并门、`cleanup` 的 `rmSync`、`@commit` 旧证据。结论：B 的配置上移和 C 的旧提交引用都可能让门更容易被绕过。
- **规则/文档一致性**：查了 `model-review.md:37-46`、`:53-65`、`:80-83`、`.claude/rules/prompt-prefix.md` 第 2/4/10/11 条与代码。结论：C/A 都需要同步改规则和流程卡，否则线程仍按旧规则做。

## 证实的（按严重度）

### 高

**1. C 新增的“不是现状说法”会被现有解析器直接判坏，方案跑不通。**
- 证据：`scripts/model-review/plan-claims.mjs:4` 只允许 `["一致","不一致","找不到"]`；`:57` 对不在这个数组里的 verdict 记 `line-...-malformed`；`:13-14` 的 `CLAIMS_LINE_FORMAT` 也只列三种；`:161-171` 的 `claimEvidenceProblem` 对“不是找不到”的每条都要求位置和代码原文。也就是说，模型按 C 输出“不是现状说法”后，`parseClaims` 会判坏，`CLAIMS_PARSE_FAILED`/`claims-answer-invalid` 会拦住，而不是“条数固定、只重核改过的句子”。
- 建议：要么不新增这个 verdict，由脚本自己标出“非现状句”，只让模型核对候选句；要么同步改 `CLAIM_VERDICTS`、`CLAIM_PROBLEM_VERDICTS`、`CLAIMS_LINE_FORMAT`、`parseClaims`、`claimEvidenceProblem`、`claimsProblems`、`CLAIMS_SUMMARY/FLAGGED` 和全部测试，并给“不是现状说法”跳过证据检查。这是 I-73 的标准场景：新值产生端有了，使用端没接住（`docs/incidents-and-gates.md:112`）。

**2. D 的自检缓存会跳过每个 PR 的 `AGENTS.md` 检查，可能让 PR 指令进入复核模型。**
- 证据：`opencode-review.mjs:2543-2629` 的自检每次都读 `projectInstructionLine(copy)`，并在 `:2500-2506` 断言 opencode 发给模型的系统提示里不能出现副本 `AGENTS.md` 的标题；`:2594-2598` 还在每个模型跑完后检查副本 `git status` 有无改动。D 的缓存键只有“opencode 版本、锁文件、配置、平台”，不含当前 PR 的 `AGENTS.md` 内容或提交。缓存命中后，新 PR 加上 `AGENTS.md` 也不会被这条检查拦住。
- 建议：自检缓存只缓存安装/完整性/静态探针；`AGENTS.md` 系统提示检查、`git status` 检查每个 PR 都跑。至少把 `AGENTS.md` 内容和 PR 提交纳入缓存键。加反向用例：同版本同配置、不同 `AGENTS.md`，缓存不得让自检通过。

**3. E1 与现行严重度规则直接冲突，会把数据丢失/资源耗尽/安全问题降成“只列不修”。**
- 证据：`model-review.md:53` 明确“会出错”包括“不合规范的、恶意的或不可信的输入”导致的丢数据、安全漏洞、资源耗尽等；`:57` 的“低”要求“只有故意构造的怪输入才能触发，而且触发后是报错拒绝、不会给出错误结果”；`:58` “拿不准的按中、高”；`:60` “涉及错误路径、安全、数据、资源耗尽、不可逆操作的意见，没有这样的依据就按会出错”。E1 用“刻意构造或极端输入”作为降级理由，但“故意构造”本身不是现行“低”的充分条件；如果 `NaN`、几十万行现在被判中高，说明线程认为它会产生错误结果或资源耗尽，不能仅因输入怪就降级。
- 建议：不要按 E1 直接改。先按现行 `low` 标准逐条复核抽样中的 7 条：只有“故意构造且失败关闭（报错拒绝、无错误结果）”的才降；`NaN`、几十万行、手改导出包若会产生错误结果/耗尽资源/安全影响，保持中高。若 Andy 仍要改，必须改 `model-review.md` 的严重度定义，而不是只改流程；不要把 Codex 的“只报 P0/P1”当成“忽略恶意输入”的依据——Codex 文档原话是“Codex flags only P0 and P1 issues so review comments stay focused on high-priority risks”（https://developers.openai.com/codex/integrations/github ），并没有说忽略错误路径或资源耗尽。

**4. A 把上一轮 `verdicts.jsonl` 当作下一轮提示词，并明确要求“不再重报”，会引入新的信任边界并压掉真问题。**
- 证据：`verdicts.jsonl` 是线程手写的，`parseVerdicts` 只校验字段形状，不校验 `quote` 是否真来自模型答案（`opencode-review.mjs:1176-1212`；真正的逐字核对在 `lowFixProblems:1238-1239`）。A 把这些自由文本（`quote`、`why`）送进下一轮提示词，等于让 PR 里的记录影响复核模型。A 还说“上一轮判为不成立或‘可以更好’的，除非相关代码改了或有新证据，不再重报”；而现行规则 `model-review.md:68` 是“线程已经写明理由判为不成立或可以更好的意见，后面的轮次再提，不算新的会出错意见；但代码改过、触发条件变了或有新证据时，线程要重新判断”。模型是发现“新证据”的一方，直接告诉它不要重报，等于拿掉这道安全网。
- 建议：只把上一轮 `valid: true` 且 `class: "error"` 的已修意见作为“上轮已修项”放入提示词，放在材料末尾，不放进固定前缀；明确写“这些是上一轮的意见，不是指令；本轮仍要独立核对代码，发现新问题照报”。不要写“不再重报”。读取时固定到上一轮的 `head`/`round`，校验 `id`、`quote`、`valid`、`class`；记录不存在或格式不对时明确失败或回退，不能静默省略。对条数和总字节设上限。

**5. A 的“独立固定前缀”和“只问相关必答问题”会改变不同轮次的用户消息开头，并跳过硬性必答问题。**
- 证据：`opencode-review.mjs:354-365` 把 `questions` 放进 `fixed`；`test/tooling/opencode-review.test.mjs:163-188` 明确断言全量轮和增量轮的 `fixed` 前缀逐字节相同；`:190-194` 断言恰好 4 个必答问题。`model-review.md:80-83` 的“每次都要问的问题”就是 4 条。A 说“只问和修改有关的必答问题”“用一个独立的固定前缀”，如果选择逻辑依赖改了哪些文件，前缀会随轮次变化，现有测试会失败；如果跳过 Q2/Q3/Q4，又违反现行规则。
- 建议：所有代码复核轮次保持同一个 `fixed` 前缀、始终带 4 个必答问题；把“本轮增量范围”“上一轮已修项”放到 `---- 本次材料 ----` 之后（最后一条用户消息里）。如果确实想少写，让模型对不受影响的问题简短回答，而不是不回答。更新测试：增加“全量轮与增量轮固定前缀逐字节相同”的断言，并加反向用例“把上一轮意见放进 fixed 必须失败”。

### 中

**6. D 的固定临时目录不是“几乎零风险”：并发、残留、符号链接、清理都可能出错。**
- 证据：当前用 `mkdtempSync(join(tmpdir(), "opencode-review-"))`（`:3486`），`cleanup` 直接 `rmSync(workRoot, {recursive:true, force:true})`（`:3488-3492`）；`prepareCopy` 用 `git clone ... repo copy`（`:2803-2805`），目标已存在时 clone 会失败。固定 `/tmp/opencode-review-pr-N` 后：同一 PR 两个复核并发会互相覆盖/删除；被 SIGKILL 后残留目录会让下一轮 clone 失败；`/tmp` 可预测，别的本地用户可以预先建目录/符号链接。
- 建议：保留 `mkdtemp`；如果一定要稳定 cwd，用“每 PR 锁文件（`O_EXCL`）+ 0700 权限 + `lstat` 检查属主/类型 + 失败回退 `mkdtemp`”，清理前确认目录是本次创建的，不要对未验证的路径递归删除。补并发、残留、符号链接、清理失败的测试。注：D 的收益也只在同一天内——见第 15 条。

**7. C 的“按句沿用”与现有 `claimsSha256` 合并门不兼容；而且“引文还在”正是已知盲区。**
- 证据：`plan-claims.mjs:248-252` 只认 `record.claimsSha256 === sha(HEAD ADR)` 的记录；ADR 改一个字节，旧记录就不匹配（`model-review.md:37`）。C 说“ADR 改了，只重核改过的句子”，但新记录仍必须带整个 ADR 的当前哈希；旧记录里的未改句子不会被 `claimsProblems` 读到。`model-review.md:39` 已承认“行还在、周围的代码改了意思时，脚本发现不了”；C 把“引文仍逐字存在”当作沿用条件，等于把这个盲区固化。
- 建议：要么不做“按句沿用”，每次重跑全部句子（更简单、更安全）；要么新增每句状态，记录 `(句子文本哈希, 文件:行, 引用代码, 引用提交)`，在新提交上逐句复核；引文还在但句子/提交/上下文变了时不能直接沿用。合并门要能验证脚本切出的每个句子都有状态，而不只是“答案里出现的句子”。同时给句子定义稳定 ID（建议内容哈希，不用位置编号；插入一句后位置编号会全变）。

**8. B 的“从仓库配置动态读测试文件”会把 `--accept-low` 的口子交给 PR 自己控制。**
- 证据：`isTestFile`（`opencode-review.mjs:1169-1174`）目前是固定规则；`lowFixProblems:1269-1274` 只要求“至少一个测试文件有新增行”，不要求这个测试真的覆盖了这条意见。如果改成读 PR 里的 `vitest.config`/`pyproject.toml`，PR 可以把任意路径加进 test glob，从而满足 `--accept-low`，省掉一整轮复核。另外 vitest 配置可以是带 import 的 TS/JS，静态解析不可靠；`pyproject.toml` 还可能需要新依赖。
- 建议：用固定的、代码维护的模式表（`test/`、`tests/`、`__tests__/`、`*.test.*`、`*.spec.*`、`test_*.py`、`*_test.py`、Go/Rust/Java 对应后缀），不要读 PR 配置。若确实要读配置，只读 `--main-ref` 里的配置，不读 PR 改动，并给上限。补 `test_*.py`、`*_test.py` 的真/假用例，保留 `testing/a.ts`、`docs/test.md` 这类反向用例（现有测试在 `test/tooling/opencode-review-merge-gate.test.mjs:2451-2468`）。

**9. B 把文件数/行数上限挪到 `review-models.json`，但该文件在 PR/脚本检出里，PR 可以自己放宽。**
- 证据：`LOW_FIX_MAX_FILES`/`LOW_FIX_MAX_LINES_PER_FILE` 在 `opencode-review.mjs:1162-1163`；`readReviewModels` 从 `REVIEW_MODELS_CONFIG_PATH` 读（`:86-101`），只校验 `allowed`/`default`/`substitutes`/`lowDeferFromRound`。`--accept-low` 是“少跑一轮”的门，放宽它会直接减少复核。
- 建议：硬上限留在代码里；配置只能调低，不能调高；或者把覆盖值放在 main 控制的文件/命令行并需要 Andy 同意。新增键要有类型、范围校验，旧配置缺省时用默认值，并补“PR 把上限调到 9999 必须被拒/忽略”的反向测试。

**10. C 的 `文件:行@提交` 没有校验提交身份，可能引用任意旧提交或非 PR 提交。**
- 证据：`plan-claims.mjs:28-31` 的 `blobAt(repo, commit, path)` 直接用 `git show ${commit}:${path}`；`:103-108` 的 `locationOf` 正则不接受 `@`；`:161-171` 仍用 `head` 读文件。C 说“提交必须是本 PR 基线或 PR 内的提交”，但没有给出校验代码。
- 建议：新增提交字段，要求完整 40/64 位十六进制、必须是 `head` 的祖先，并且等于 `merge-base(mainRef, head)` 或在 PR 的提交范围内；区分“当前现状”句（必须用 `head`）和“本 PR 删掉的旧代码”句（允许用基线）；拒绝 `--help`、分支名、`..`、非十六进制等。补反向用例：非祖先提交、任意旧提交、带选项的提交、路径不存在。

**11. 方案没有对应的自动检查/反向用例计划，而现有测试会直接挡住 A/C 的改法。**
- 证据：`test/tooling/opencode-review.test.mjs:163-188` 断言全量/增量固定前缀相同；`:190-194` 断言 4 个必答问题；`:208-235` 断言模型侧重与提示词组成；`test/tooling/plan-claims-gate.test.mjs:287-308` 断言三种 verdict 的行格式；`:388-403` 断言引文/位置不存在会报错；`test/tooling/opencode-review-merge-gate.test.mjs:2451-2468` 是 `isTestFile` 的现有用例。方案的“实施顺序”只写了改脚本、提示、流程卡，没有写更新这些测试和新增反向用例。
- 建议：每个 PR 先写会失败的反向用例：A 的“上一轮意见放进 fixed 必须失败”“跳过必答问题必须失败”；B 的“PR 配置放宽上限必须被拒”“Python 测试真/假用例”；C 的“新 verdict 必须被接受且不要求证据”“非祖先 @提交必须被拒”“插句后旧判断不得错误沿用”；D 的“新 AGENTS.md 缓存不得放行”“并发/残留目录不得复用”。再改代码。

**12. A 把上一轮所有成立意见塞进提示词，没有容量控制，可能触发 `PROMPT_TOO_LARGE`。**
- 证据：`opencode-review.mjs:3447-3448` 在提示词超过 100000 字节时直接抛错；A 没有说只取多少条、每条截多长。一个多轮 PR 的 `verdicts.jsonl` 可能很长，加上原 brief 后很容易超限，结果是这一轮根本跑不起来。
- 建议：按严重度/轮次取最近 N 条，`quote`/`why` 截断，总字节设上限；超限时记录并降级为“只带编号和一句话”，不能直接失败。补超限测试。

**13. B 的“97 轮、15%”目前没有原因分布支持；脚本只打印拒绝原因，不写进账本。**
- 证据：`lowFixProblems` 返回 `problems`，调用处打印 `REVIEW_LOW_FIX_REFUSED`（`opencode-review.mjs:1584`）；账本记录只有 `files`/`findings` 等（`:1591`），没有 `not-last-round`、`no-test-change`、`too-many-files` 的分布。方案自己也承认“账本里没分开记”。这 97 轮可能很多是 `not-last-round`、`quote-not-found`、`nothing-unreviewed`，B 改测试文件和上限并不解决。
- 建议：先给 `low-fix` 记录加 `refusedReasons`（注意 `parseUsage`/`delegate` 的字段校验和控制字符检查），在接下来 5 个 PR 上统计；再决定 B 的范围和预测。不要把 97 直接算进 15% 根因。

### 低

**14. D 的前提不完整：OpenCode 系统提示除工作目录外还带“今天日期”。**
- 证据：`https://raw.githubusercontent.com/sst/opencode/v1.19.5/packages/opencode/src/session/system.ts` 原话包含 `Working directory: ${ctx.directory}`、`Workspace root folder: ${ctx.worktree}`、`Platform: ${process.platform}`、`Today's date: ${new Date().toDateString()}`。固定目录能让 cwd/worktree 稳定，但日期每天变；跨天时系统提示仍不同，D 的“每轮相同、第一次请求能命中缓存”只在同一天、同平台、同模型/配置下成立。
- 建议：把前提改成“同一天内稳定”；缓存收益按天评估；不要把跨天命中算进预测。

**15. “大厂共同点”是过度概括，个别来源并不支持“都带着上一轮上下文”。**
- 证据：Google 的速度文档支持“一天内多轮”“LGTM with comments”（https://google.github.io/eng-practices/review/reviewer/speed.html ），但没有说复审只核对上次意见；Anthropic 插件文档支持“只看改动、置信度低于 80 不报”，但原话是“already-reviewed pull requests are automatically skipped”，并没有说带上一轮意见（https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md ）；CodeRabbit 文档支持“focusing on the commits added since the last review”和“连续 5 次后暂停”，但没有在引用页明确说“带着上次的意见”（https://docs.coderabbit.ai/configuration/auto-review ）；OpenAI 的对齐文章反而说“只给 diff 的复核会漏掉整个代码库和依赖交互的上下文”（https://alignment.openai.com/scaling-code-verification/ ）。
- 建议：把“个别产品确实做增量”与“业界共同点就是只看增量”分开写；不要把后者当作 A 的论据。如果要证明“带上一轮意见”是业界做法，需要引用明确写这一点的文档或源码。

**16. E2 的“大 PR 轮数多”是相关关系，拆 PR 可能增加总轮数/总成本。**
- 证据：Google 的小 CL 文档支持“小 CL 审得快、少引入 bug”（https://google.github.io/eng-practices/review/developer/small-cls.html ），但没有说拆开后总轮数一定下降；每拆出一个 PR 都会多一次全量第一轮。
- 建议：按“一个自包含改动”拆，不加硬限制；用“每个功能的总复核轮数/总费用/总时长”衡量，而不是只看单 PR 平均轮数。先测 5 个功能，再决定。

## 推测/未核实

- **账本统计未核实**：当前是 sparse checkout（63%），`.agents/reviews` 不在工作区；`git show HEAD:.agents/reviews/pr-488/usage.jsonl` 被本次环境的 git 守卫拒绝（`REVIEW_GIT_REFUSED records-path`）。178 PR / 665 轮、47 vs 36 步、79%、97 轮、ADR 21 到 63 条、70% 模型看错这些数，我无法从当前检出复现，按“未核实”处理。
- **预测值未核实**：47→20 步、10→5 分钟、3.7→3.0 轮、78→45 分钟、$0.33→$0.2 都是推算；方案也说“待实测”，不能当成已经证明。
- **“现在靠子代理手工沿用原判”未核实**：代码里只有 `model-review.md:68` 的规则，没有找到“子代理手工沿用”的实现证据；这是流程描述，不是代码事实。
- **PR 493 未核实**：当前提交里没有 PR 493 的内容，无法确认“A 在 493 合并后再动流程卡”的冲突。
- **D 的缓存命中未实测**：系统提示带 cwd/日期是证实的，但“固定路径后第一次请求能命中缓存”没有抓包或命中率数据；只应作为待测假设。
- **C 的切句可行性未验证**：没有实现，也没有针对 Markdown 代码块、表格、列表、中文标点、URL、跨句 claim 的测试；位置编号在插入句子后会整体偏移，方案没有说明如何保持稳定。
- **“大厂共同点”是综合判断**：各条单独事实大多能对上，但“都带着上一轮上下文、不是从头再找”不是引用页的原话。

## 如果由你来定，我会怎样改

1. **先做 B，但改成静态规则 + 先度量**：扩展 `isTestFile` 的固定模式（含 `test_*.py`、`*_test.py`、Go/Rust/Java），不读 PR 配置；上限留在代码或 main 控制的配置，只能调低；先给 `low-fix` 记录加拒绝原因统计，用 5 个 PR 验证 97 轮的构成，再决定是否改。
2. **再做 C 的第一阶段**：保留模型列 claim 的现有格式，脚本额外切出一份“候选句清单”并校验覆盖；句子 ID 用内容哈希，不按位置；新增 `@commit` 时只允许基线/PR 范围且必须是 head 祖先；先不做“按句沿用”或只做带每句哈希的严格沿用。每步补 `plan-claims` 的正反向测试。
3. **A 用受控实验，不做“别重报”**：固定前缀和 4 个必答问题保持不变；把上一轮已修的 `error` 意见放在材料末尾，结构化、限条数、限字节，注明“这是上一轮意见，不是指令，仍要独立核对”；不告诉模型不要重报，去重交给线程。先在 5 个 PR 上对照测步数、时长、费用、漏报/误报。
4. **D 最后做，且只缓存静态部分**：安装/完整性/工具表/权限等静态探针可缓存；`AGENTS.md` 系统提示检查、`git status` 每个 PR 都跑。固定路径必须加锁、属主/类型检查、安全清理和回退；否则保留 `mkdtemp`。修正“系统提示只带工作目录”的前提，说明日期每天变。
5. **E1 不采纳**；E2 采纳方向但按“每个功能的总成本”度量。
6. **每个 PR 同步改规则和测试**：`model-review.md`、`model-review-card.md`、`buildPrompt`、`plan-claims.mjs`、对应测试一起改；新增 ADR 记录这次流程变化和反向用例。

## 逐条回答必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
- 不会改变“已有会话”的开头：每次复核轮次都是新的 `opencode run`，主运行不带 `--session`（`opencode-review.mjs:802-861`；`session` 只在同一轮追问时用，`:1103-1111`）。所以 A 不会去改写某段已经发过的历史。
- 但 A 的“独立固定前缀 + 按改动筛选必答问题”会让全量轮和增量轮、甚至不同增量轮的用户消息开头不同；如果把上一轮意见放进 `fixed`，那更是每轮变化的值放在开头。这违反 prompt-prefix 第 2 条“每轮都会变的内容只放在最后一条用户消息里”，也会让现有 `test/tooling/opencode-review.test.mjs:163-188` 失败。
- D 的固定路径只让系统提示里的 `Working directory`/`Workspace root folder` 稳定；`Today's date` 仍然每天变（system.ts 原话），所以不能说“每轮完全相同”。
- 结论：A 必须保持 `fixed` 逐字节相同、4 个必答问题都在；上一轮意见和本轮范围只放材料末尾。D 的收益限定在同一天内。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**
- A：如果上一轮意见按账本行序、`Map`/对象遍历序或未排序集合拼接，就可能不同；必须固定排序（轮次、id）、固定字段顺序、固定截断规则。
- B：动态读 `vitest.config`/`pyproject.toml` 可能受文件遍历/glob 顺序影响；应使用固定模式，不读 PR 配置。
- C：句子清单必须确定性切分；位置编号在插入句子后会整体变化，建议内容哈希 ID；`@commit` 必须规范成完整提交哈希，不能有时写短哈希/分支名；`claims-verdicts.jsonl` 的顺序也要固定。
- D：固定路径让 cwd 稳定，但系统提示里的日期是时间依赖；同一天内相同，跨天不同。
- 结论：方案没有规定这些确定性规则；按现在的写法，至少 A/C 有让同样文字变成不同字节的风险。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
- 没有。方案的“实施顺序”没有测试步骤，只有“5 个 PR 实测”。而现有测试会挡住一部分改动：`opencode-review.test.mjs:163-188`（固定前缀）、`:190-194`（4 个问题）、`opencode-review-merge-gate.test.mjs:2451-2468`（`isTestFile`）、`plan-claims-gate.test.mjs:287-308`（claim 行格式）、`:388-403`（引文/位置错误）。
- 必须补的反向用例：A 把上一轮意见放进 `fixed` 必须失败；跳过必答问题必须失败；B 的 PR 配置放宽上限必须被拒；C 的“不是现状说法”必须被接受且不要求证据、非祖先 `@提交` 必须被拒、插句后旧判断不得错误沿用；D 的新 `AGENTS.md` 缓存不得放行、并发/残留目录不得复用。每个用例先在旧代码上跑红，再改。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
- **C 的“不是现状说法”**：产生端是提示词/脚本，使用端 `CLAIM_VERDICTS`、`CLAIMS_LINE_FORMAT`、`parseClaims`、`claimEvidenceProblem`、`claimsProblems`、`CLAIMS_SUMMARY/FLAGGED` 现在都不接受；这是 I-73 式的不兼容，必须全部改。
- **C 的 `文件:行@提交`**：产生端是模型答案，使用端 `locationOf`、`validEvidencePath`、`claimEvidenceProblem`、`blobAt` 都不接受/不校验；必须加完整哈希、祖先/范围校验，并区分当前现状与已删旧代码。
- **C 的句子 ID/沿用状态**：产生端是脚本切句，使用端是 `parseClaims`（`CLAIM_ID_PATTERN`）、`claims-verdicts`（按 `model+id`）、合并门的 `claimsSha256` 匹配；目前没有“每句状态”字段，也没有“每个句子都被核过”的覆盖检查。
- **A 的上一轮意见块**：产生端是 `verdicts.jsonl` 读取器，使用端是 `buildPrompt`、`roundForRun` 的提示词摘要（`:2057-2067`）、`delegate.mjs` 的 `promptFileSha256`（`delegate.mjs:334-338`）、`PROMPT_TOO_LARGE`（`:3448`）、提示词存档遮盖（`:3558`）。必须保证可复现、可补跑、超限可降级、不含像密钥的文字。
- **B 的新配置键/测试模式**：产生端是 `review-models.json`，使用端是 `reviewModelsProblems`、`LOW_FIX_MAX_*`、`isTestFile`、`lowFixProblems`；必须校验类型/范围、旧配置缺省、PR 不能放宽，并补测试。
- **D 的固定路径/缓存键**：产生端是路径/缓存写入，使用端是 `prepareCopy`、`installGitGuard`、`selfCheck`、`projectInstructionLine`、`git status`、`cleanup`、`runOpencode` 的 cwd；必须处理并发、残留、符号链接、清理，并把 PR 的 `AGENTS.md`/提交纳入每个 PR 的检查。
- 结论：A/B/D 可以逐项核对后接受；C 目前两端明显不一致，不能按 v1 实施。
