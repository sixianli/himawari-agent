你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作。另一个复核者侧重别的方面，所以你仍要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 3b41b0e47eff99664c17bab146021a70ae6b24f9。
待审核的方案：
# 方案：CI 规则修改的授权入口（让合法的规则修改不再必然失败两次）

状态：方案，等 Andy 决定。Andy 2026-11-06 同意另开任务做这件事（“3 要”）。两个模型已各自独立出方案（记录在 `.agents/reviews/topic-policy-migration/round-1/`，花 0.161 美元）；本文是整合后的版本，还没请模型审核。

## 1. 前提和来源

1. 现在每改一次 CI 规则，改动所在 PR 的 `policy` 检查必然失败：检查用目标分支上已接受的 `ci/policy.json`，却用 PR 里的新代码校验它，新代码只认新值。来源：`scripts/ci/check-policy.mjs:1125-1132`（`resolvePolicySource` 后 `validateWorkflow(source.policy, ...)`）、`:169` `assert(check.timeoutMinutes === timeoutMinutesFor(check.id), ...)`。PR 259 实际报错 `Unexpected timeout: policy`（运行 42080372382）。
2. 合并后 main 的第一次运行也必然失败一次：`scripts/ci/context.mjs:111`，`push` 事件的比较基线取 `payload.before`（推送前的 main）。
3. 至今已经为此写过三段一次性迁移代码：`upgradeHostedRunnerPolicy`（`check-policy.mjs:53-72`）、integration 的 worker 限额升级、coverage 的旧值兼容（`resolvePolicySource` 内）。ADR 0160 决定第 6 条承认这段代码“合入后不会再生效，但会一直留着”。
4. 原设计要的就是“Owner 授权的规则维护入口”，只是没有实现：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:115` 原文“若旧规则本身阻止合法政策修复，必须由 Owner 单独授权临时规则维护……不得在功能 PR 中利用这一入口降低自己的失败条件。”；`:225` 原文“同一 PR 不能自行降低阈值使自身通过。”
5. 已有一个同类入口可以照着做：安全审批（`.github/security-review-manifest.json` + PR 评论），由 `scripts/ci/security-owner-review.mjs` 经 GitHub API 核验评论作者是仓库所有者、PR、源码提交、清单字节摘要、最长 30 天有效期。来源：设计文档 `:242`。
6. 这套检查的信任边界本来就是“可信 Owner 审阅”，不防同账号的人：设计文档 `:280` 原文“同仓库 writer 及外部 PR 都能提议修改 workflow、政策和汇总器……当前采用可信 Owner 审阅这一边界……需要独立可信 CI 控制面时另立设计”。Andy 的代理线程也用他的 GitHub 账号，所以“评论作者是仓库所有者”证明不了是 Andy 本人；现有安全审批也是这样。
7. 仓库用 merge commit 合并，PR 的 head 是合并提交的第二个父提交：`scripts/ci/main-evidence.mjs:57-58`（`MAIN_SINGLE_MERGE_REQUIRED`）。
8. 合并目前不等 CI：`AGENTS.md`“交付模式”一节原文“在 Andy 决定规则集要求 `ci/required` 之前，合并不等 CI 结果”。

## 2. 做法

1. **规则值写在规则文件里，代码只查结构。** 删掉 `timeoutMinutesFor`、`hostedTimeoutMinutesFor` 这类写死的值和三段一次性迁移代码；`validatePolicy` 只查不会随规则变化的结构（检查编号唯一、`policy`/`required` 存在、依赖无环、`required` 依赖其他全部检查、每个检查至少一个没暂停的成员等），具体时限只受 schema 的 1–120 分钟约束。workflow 的 `timeout-minutes` 仍要求和规则文件一致。
2. **比较“已接受的规则”和“这次要跑的规则”。** 已接受的规则 = 目标分支（PR）或推送前的 main（push）上的 `ci/policy.json`，用那个提交自己的 schema 读，不用新代码判它。这次要跑的规则 = 被测提交（PR 的试合并提交、或 main 的合并提交）上的那份。
   - 两份字节相同：照旧，普通 PR 行为不变。
   - 不同：必须有 Owner 授权（第 3 条），否则报 `CI_POLICY_CHANGE_UNAUTHORIZED` 并列出变化；授权通过就按新规则跑。
3. **授权记录照抄安全审批的做法。** 新增 `.github/policy-change-manifest.json`（写明 PR 编号、源码提交、以及 `ci/policy.json` 改前和改后的 SHA-256），配一条 PR 评论；检查经 GitHub API 核验评论作者、PR、清单字节摘要、30 天有效期，并要求清单里的改前、改后摘要与实际两份规则文件完全一致，多一处、少一处都拒绝。
4. **合并后 main 的第一次运行。** push 时取合并提交的第二个父提交当 PR head，用同一份清单和评论核验；核验通过就按新规则跑，不再失败。没授权就合并的，main 上明确报 `CI_POLICY_CHANGE_UNAUTHORIZED`。
5. **所有读规则的地方用同一份。** `context.mjs`、`run.mjs`、`aggregate.mjs`、`check-coverage.mjs`、`required.mjs`、`export-evidence.mjs`、`test.mjs`、`security-exceptions.mjs` 现在都按 `context.baseSha` 读规则；全部改成读同一份“生效的规则”，并用端到端测试核对它们拿到的规则摘要一致（这是最容易漏改出错的地方）。

## 3. 测试

- 正向：base 是旧时限、被测提交是新时限，有授权 → 通过；同一用例在旧代码上报 `Unexpected timeout: policy`（反向证明）。
- 反向：没有授权、评论作者不对、过期、清单摘要和实际不符、清单多一处或少一处、合并后 main 没授权 → 各自失败，报固定的错误码。
- 普通 PR 不改规则：现有 `test/tooling/policy.test.mjs` 全部照样通过。
- push：构造“推送前是旧规则、合并提交第二父提交带授权”的仓库，`createContext` 拿到新规则的摘要。

## 4. 放弃的做法

- 继续每次写一次性迁移代码：维护负担，而且每次仍会失败一次。
- 所有检查直接读 PR 分支的规则：功能 PR 就能自己放宽规则，违反设计文档 `:225`。
- 只删掉 `check-policy.mjs:1132` 那一行：能止住这一个报错，但其他读 `context.baseSha` 的地方还是用旧规则，而且没有授权入口。
- 用 GitHub 网页端提交自带的签名证明是 Andy 本人（GLM 提的）：推断代理通过 GitHub 接口建的提交也会带同样的签名，证明不了是本人（未核实，需要时再查）。

## 5. 要 Andy 定的

1. **用什么证明“是 Andy 授权的”。**
   - A（建议先做）：PR 评论 + 清单，和现有安全审批一样。成本低，和设计文档 `:280` 接受的边界一致；但它只证明“是这个 GitHub 账号”，代理也能发这条评论（项目规则约束代理只在 Andy 说了之后才发）。
   - B（更强）：Andy 用只有自己持有的签名密钥（最好是硬件密钥，按一下才签）给 PR 最后一个提交签名，CI 用 main 上登记的公钥验签。代理拿不到密钥就伪造不了；代价是每次改规则 Andy 都要在 Mac 上亲手签一次，第一次登记公钥也要 Andy 亲手做。
2. **哪些文件算“规则”。** 建议先只管 `ci/policy.json`；`ci/coverage-policy.json`、两个 workflow、`scripts/ci/` 要不要也纳入，纳入越多越安全，但普通 CI 工具改动也都要授权。
3. **模型审核这份方案的费用。** 按规则还要请两个模型审核这份整合方案（约 0.1–0.2 美元，按封顶算最多 0.4 美元）。加上已花的 0.161 美元，封顶会超过 0.5 美元的先问线，脚本会拒跑，需要 Andy 同意总额 0.6 美元。
