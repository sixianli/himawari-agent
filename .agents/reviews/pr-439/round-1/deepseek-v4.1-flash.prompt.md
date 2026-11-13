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
仓库就是当前目录，已检出 5cec2fab9cb9ec41704f244cdde156fd79dc99a1。
对比基准是 6e33c029fbed56b8201d7924c22dafe10ead139c，先运行 git diff 6e33c029fbed56b8201d7924c22dafe10ead139c..5cec2fab9cb9ec41704f244cdde156fd79dc99a1 看改动。
作者的说法（可能有错，请核对）：
# PR 439 第 1 轮作者说明

问题：带沙箱证据（资格记录里有 `sandbox` 字段）的能力，经 `CapabilityLifecycleService` 的 `activate`、`activateUpdate`、回滚激活时一律报 `runtime qualification failed`。

作者认定的根因（请核对，不要直接采信）：
- `packages/application/src/services/capability-lifecycle-service.ts` 的 `qualify` 原先要求 `enforcement` 六项全部为真。
- `packages/platform-node/src/capabilities/capability-deployment.ts` 的 `parseQualification` 要求带沙箱证据的记录 `resourceCeilings` 必须为假、`termination` 只在 Linux 为真，否则报 `sandbox evidence conflicts with enforcement claims`。
- `packages/execution-contracts/src/sandbox-qualification-v1.ts` 里 `resourceMode` 只有 `observe_and_stop` 一种取值；`packages/application/src/ports/capabilities.ts` 的端口定义写着 “legacy enforcement booleans must remain truthful”。作者据此认为加载器的语义对，`qualify` 错。

改动：
- `qualify` 改调新函数 `qualificationEnforcementHolds`：没有沙箱证据时仍要求六项全真；有沙箱证据时要求 filesystem、network、processes、secrets 为真，`resourceCeilings` 为假，`termination === (sandbox.terminationMode === "verified_tree")`。
- 新测试 `test/integration/sandbox-capability-qualification-lifecycle.test.ts`：写真实快照文件，用真实加载器读出资格记录，交给真实的 `CapabilityLifecycleService`。还原修复后“激活成功”和“拒绝虚报资源上限”两条失败。

约束：不改表；代码不写注释；测试不用假替身；不能只是把检查放宽。

列出的做法只是参考，不要局限于它，请从问题本身出发，提出你认为更好的做法。

请核对：
1. 这个改动会不会改变模型已经见过的请求开头？（作者认为不涉及发给模型的内容，请确认。）
2. 两边哪一边的语义才对，作者的认定有没有依据不足的地方；有没有第三处代码（例如 `apps/execution-worker/src/production-worker-composition.ts`、`packages/platform-node/src/capabilities/isolation.ts`、`authorizedManifests`）对同一份记录有别的要求，会让修复后仍然走不通或者放过不该放过的记录。
3. 新规则有没有比加载器更宽或更严的地方；有没有输入能让带沙箱证据但实际管控不足的记录通过。
4. 测试是否真的覆盖正反两面，有没有遗漏的路径（更新激活、回滚）。
