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
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作。另一个复核者侧重别的方面，所以你仍要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 dacfff49e7fb3aafa0148d7545716528ff2b8808。
对比基准是 ba915c214119b044e105ecfe617d2d98c100db27，先运行 git diff ba915c214119b044e105ecfe617d2d98c100db27..dacfff49e7fb3aafa0148d7545716528ff2b8808 看改动。
上一轮复核到 6269e972c96ee6e9a64c4f230a6c7123e16603ac，先看 git diff 6269e972c96ee6e9a64c4f230a6c7123e16603ac..dacfff49e7fb3aafa0148d7545716528ff2b8808 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# 作者说明：第 2 轮，按第 1 轮复核意见做的修改

PR 的目标不变：CI 不用 GitHub 缓存，artifact 只保存 1 天，策略、比对脚本、工具锁定、测试和文档跟 `main` 上已改的工作流一致。第 1 轮之后加了两个提交：

1. `efbcc6da`：
   - `scripts/ci/check-policy.mjs` 新增 `upgradeArtifactRetention`，在 `resolvePolicySource` 里接在 `upgradeHostedRunnerPolicy` 之后：从基准提交读到的策略恰好是 `retentionDays: { reports: 30, diagnostics: 7 }`（只有这两个键）时，换成 1 和 1；别的值原样交给 `validatePolicy`，由当前 schema（`const: 1`）拒绝。原因：CI 从基准提交读已接受的策略，再用当前 schema 校验；本 PR 自己的 CI 和合并后第一次 `main` 推送时，基准上还是 30/7，不升级就会在每个 job 创建 Context 时失败。做法照搬已有的 `upgradeHostedRunnerPolicy`。
   - `test/tooling/policy.test.mjs` 新增用例：基准为 30/7 时 `resolvePolicySource` 返回的策略等于当前策略；基准为 14/7 时抛错。只加测试时它在旧代码上失败，加修复后通过（Hermes 实跑）。
   - `docs/architecture-v0.1.md` 里“30/7 天保留”改为指向 ADR 0174；ADR 0174 的决定里写明这次升级，后果里写明工作流停用只是等新 CI 服务器的临时状态，不和 ADR 0173 矛盾。
2. `dacfff49`：`test/tooling/ci-optimization.test.mjs` 的缓存检查改用 `usesGitHubCache`，匹配 `actions/cache@`、`actions/cache/restore@`、`actions/cache/save@`，并加正反用例。

## 请核对

- `upgradeArtifactRetention` 会不会放过不该放过的旧策略，或者拦下不该拦的；它在 `resolvePolicySource` 的所有调用方（`context.mjs`、`run.mjs`、`required.mjs`、`test.mjs`、`export-evidence.mjs` 等）里是否都正确。
- `resolvePolicySource` 返回的 `policySha256` 仍按基准上的原始字节计算，升级只改内存里的对象；这样和 Context 里记的摘要比较是否仍然一致。
- 文档改动是否和代码一致。
