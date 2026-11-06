你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 40a306a390d7ab3cbe353bfb72c5f89525e85ae6。
问题、目标和约束：
# 问题：CI 的 policy 检查让“合法的规则修改”自己的 PR 和合并后 main 的第一次运行必然失败

## 现象（已核对）

- PR 259 把 CI 任务时限从 45/30/5 分钟改为 90/60/15 分钟（`ci/policy.json` 的 `timeoutMinutes`、`.github/workflows/ci.yml`/`main.yml` 的 `timeout-minutes`、`scripts/ci/check-policy.mjs` 的 `timeoutMinutesFor`）。这个 PR 的 `policy` 检查每次都失败，报 `Unexpected timeout: policy`，后面的测试都没跑。
- 原因：`scripts/ci/check-policy.mjs` 的 `main()`（约第 1122-1140 行）先用 `resolvePolicySource({ base })` 从目标分支（main）读出已接受的 `ci/policy.json`，再用 PR 里的新代码 `validatePolicy` 校验它（新代码只接受新时限），并用它校验 PR 的 workflow（`validateWorkflow(source.policy, ...)` 要求 `timeout-minutes` 与 `timeoutMinutes` 精确相等，第 307 行附近）。
- 合并后 main 上第一次运行同样失败：`scripts/ci/context.mjs` 约第 109-111 行，`push` 事件的比较基线取 `payload.before`（推送前的 main）。
- 之前有一次类似的迁移（托管 runner → Hermes），是在 `resolvePolicySource` 里加了一段只认那一种旧写法的升级 `upgradeHostedRunnerPolicy`（Andy 当时选的做法，见 `docs/adr/0160-self-hosted-runner-on-hermes.md` 决定第 6 条）。coverage 阈值、integration 项目也各有一次类似的专用迁移代码（`resolvePolicySource` 里 `integrationWorkerLimits`、`allowLegacyCoverage`）。每次规则修改都要写一段一次性迁移代码。

## 这道检查为什么存在（已核对）

`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md`：

- 第 115 行：“普通功能 PR 使用目标分支已经接受的阈值和例外。确需修正规则或接纳新例外时，提交只包含政策及其验证材料的独立变更。若旧规则仍能通过，按正常 PR 合入；若旧规则本身阻止合法政策修复，必须由 Owner 单独授权临时规则维护，记录准确变更、对照证据和恢复结果，再重新证明强制门禁生效。不得在功能 PR 中利用这一入口降低自己的失败条件。”
- 第 225 行：“基线和例外默认读取目标分支受保护版本；同一 PR 不能自行降低阈值使自身通过。”
- 第 242 行：已有一个类似的“Owner 精确批准”入口：`.github/security-review-manifest.json` + PR 评论，检查通过 GitHub API 核验仓库所有者身份、PR、源码提交、清单字节摘要、有效期（最长 30 天）。

## 目标

- 合法的规则修改（例如调整时限、加减检查项）不必每次写一次性迁移代码，也不必让自己的 PR 和合并后的第一次 main 运行必然失败。
- 保留原设计的保护：功能 PR 不能自己放宽规则让自己通过；规则修改要有 Owner 的明确授权，并且可核验、只对那一次精确改动生效。

## 约束

- 检查名 `ci/required` 不变。
- 仓库唯一所有者是 Andy（GitHub `sixianli`）；Andy 的代理线程也用他的账号推送和评论，所以“评论作者是仓库所有者”本身不能证明是 Andy 本人授权（已有的安全审批入口同样面临这个问题，请一并考虑）。
- 合并目前不等 CI 结果（`AGENTS.md`“交付模式”一节），规则集还没要求 `ci/required`。
- 不写代码注释；改动要有测试，包括能证明旧代码会失败的反向用例。
- 大改动要先给 Andy 看方案。

请从问题本身出发，读代码和上面的文档，查业界做法（例如 GitHub 的 required workflows、CODEOWNERS、`pull_request_target` 的安全用法，成熟开源项目怎样处理“规则变更自己的 PR 用哪份规则”），给出你认为最好的方案，写明依据（一手来源链接或文件行号）、风险和验证方法。
