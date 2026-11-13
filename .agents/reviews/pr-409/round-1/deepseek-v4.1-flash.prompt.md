你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 c9a5bda4b366c24bfbfd031e66415721a63dafe5。
对比基准是 4460960d8184b5e5d2a669f49e58d8a411400338，先运行 git diff 4460960d8184b5e5d2a669f49e58d8a411400338..c9a5bda4b366c24bfbfd031e66415721a63dafe5 看改动。
作者的说法（可能有错，请核对）：
# PR 409 第 1 轮作者说明

Andy 2026-11-11 同意：草稿 PR 不跑 CI、合并前等 CI 变绿、runner 保留 npm 缓存（本 PR 只做前两项和“改标题不重跑”）。决定见 `docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md`。

改动：
- `.github/workflows/ci.yml`：6 个检查作业带草稿条件；`ci/required` 第一步 bash 判草稿/上游取消失败；之后的 gate 上传和共享目录删除改为 `always() && steps.entry.outcome == 'success'`；去掉 `edited` 事件和并发组的 edited 段。
- `scripts/ci/check-policy.mjs`：对应硬规则。
- 测试：`test/tooling/policy.test.mjs` 反向用例，`test/tooling/ci-optimization.test.mjs` 执行入口 bash。
- 文档：ADR 0241、ADR 0191 标为被取代、交付模式、AGENTS.md、设计说明。

请核对：
1. GitHub 表达式 `contains(needs.*.result, 'cancelled')` 和 `github.event_name == 'pull_request' && github.event.pull_request.draft == true` 在 workflow_call（main.yml 调用）、workflow_dispatch、非草稿 PR 上的取值，会不会误判失败或漏判。
2. 草稿条件加到 policy 后，下游作业（依赖 policy）在草稿上和非草稿上的行为；main.yml 调用 ci.yml 时是否仍全部运行。
3. 入口失败后不删共享目录、不上传 gate，会不会让 main 的证据或 main-evidence.mjs 出问题；被取消运行的残留目录靠每小时清理是否足够。
4. 去掉 edited 后有没有别的地方（main-evidence、aggregate、文档、测试）还依赖它。
5. 合并规矩的文字是否清楚，有没有和其他指令文件冲突。
