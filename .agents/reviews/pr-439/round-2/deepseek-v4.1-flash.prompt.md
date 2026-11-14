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
仓库就是当前目录，已检出 f744066d9a10fa458018dad0378a6a1fe5ea952f。
对比基准是 6e33c029fbed56b8201d7924c22dafe10ead139c，先运行 git diff 6e33c029fbed56b8201d7924c22dafe10ead139c..f744066d9a10fa458018dad0378a6a1fe5ea952f 看改动。
上一轮复核到 5cec2fab9cb9ec41704f244cdde156fd79dc99a1，先看 git diff 5cec2fab9cb9ec41704f244cdde156fd79dc99a1..f744066d9a10fa458018dad0378a6a1fe5ea952f 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 439 第 2 轮作者说明

第 1 轮的逐条判断在 `.agents/reviews/pr-439/round-1/judgments.md`。这一轮请看第 1 轮之后的修改（请核对，不要直接采信）：

- `packages/execution-contracts/src/sandbox-qualification-v1.ts` 新增 `sandboxEnforcementClaimsMatchEvidence`（先用 `sandboxRuntimeQualificationSchema` 解析证据，再核对平台、`runtimeIdentity`、`resourceCeilings` 为假、`termination` 只在 Linux 为真）和 `sandboxRequiredControlsEnforced`（四项必须管控）。
- `packages/platform-node/src/capabilities/capability-deployment.ts` 的 `parseQualification` 改调这两个函数。作者认为加载器的行为没有变，请核对有没有变宽或变严。
- `packages/application/src/services/capability-lifecycle-service.ts` 的 `qualificationEnforcementHolds` 改调这两个函数，并要求带沙箱证据的清单 `runtime.kind === "program"`。
- 测试：`test/integration/sandbox-capability-qualification-lifecycle.test.ts` 共 12 条（更新激活后回滚、更新候选虚报被拒、终止声明矛盾、平台或运行时身份对不上、证据不合契约、无沙箱证据仍要求六项全真）；`packages/platform-node/test/capability-deployment.unit.test.ts` 补 4 条加载器冲突用例。
- 已知且不在本 PR 范围：main 上的生产治理网关没有传 `capabilityLifecycle`，接线由另一个分支做，本 PR 是它的前置。

约束：不改表；代码不写注释；不能只是把检查放宽。

列出的做法只是参考，不要局限于它，请从问题本身出发，提出你认为更好的做法。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？
2. 加载器改调共用函数后，对任何输入的接受或拒绝结果、错误码有没有变化。
3. `qualify` 的新规则还有没有比加载器宽的地方；已持久化的 `runtimeQualification`（回滚时用）会不会因为重新解析证据而被错误拒绝。
4. 新增用例有没有在旧代码下也通过、起不到回归保护作用的。
