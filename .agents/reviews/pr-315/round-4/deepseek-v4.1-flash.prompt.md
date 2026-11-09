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
仓库就是当前目录，已检出 bfa69c5c0a31476debb9c85eb45d26479e46ea02。
对比基准是 8b16d692e49beb39a2ec07d6700a54648332c449，先运行 git diff 8b16d692e49beb39a2ec07d6700a54648332c449..bfa69c5c0a31476debb9c85eb45d26479e46ea02 看改动。
上一轮复核到 ab8767c1d1a07c5d4721a8ae5ca553a40c59d053，先看 git diff ab8767c1d1a07c5d4721a8ae5ca553a40c59d053..bfa69c5c0a31476debb9c85eb45d26479e46ea02 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 315 第 4 轮：只看第 3 轮（提交 ab8767c1）之后的修改

第 3 轮有 1 条中（前导引号回溯让短值被多遮）和 1 条高（旧对话的历史会被新规则重新遮盖，请求开头变一次，违反“发给模型的内容只能往后追加”）。之后的修改（`git diff ab8767c1..HEAD` 里除了合并 main 带来的，只看下面这些）：

1. （提交 1a593a41）宽松密码规则的值首字符不能是引号/左括号，前面的引号并入前导；重定向排除收窄为 `\d?[<>]\S*`；测试和 ADR 0188 同步。
2. （提交 bfa69c5c，针对高那条）**新遮盖规则只对新对话生效**：
   - `packages/sensitive-capture/src/redaction.ts`：`EGRESS_RULESET_CURRENT = 2`；`redactForEgress` 的 `ruleset` 选项小于 2 时跳过两条宽松密码规则，严格规则不变。
   - 版本记在按对话冻结的提示记录里（ADR 0165）：`ThreadPromptBundleIdentity.redactionRuleset?`（存在 `identity_json` 里，不加列，不改表结构）。`packages/application/src/services/thread-prompt-bundle-service.ts`：新对话写当前版本；`rollout`（上线时已有历史、第一次建记录）写 1；`#open` 读不到字段按 1；`promptBundleChange` 不看这个字段，所以不会因为它换新；别的原因换新时写当前版本。
   - `packages/application/src/services/model-egress.ts`：`ModelEgressContext.redactionRuleset` 传给 `redactForEgress`；`packages/runtime-pi/src/pi-runtime-adapter.ts` 把已钉住的记录的版本传给 `egress.exchange`。没有记录的路径用当前版本。
   - `packages/persistence-sqlite/src/sqlite-thread-prompt-bundle-operations.ts`：校验并存这个字段。
   - 测试：`prompt-prefix.compat.test.ts` 的 `[ADR-0188]` 三条（旧版本全程不变、新对话从第一轮遮盖、中途换版本必须被报告为断开），`model-egress.unit.test.ts`，`thread-prompt-bundles.test.ts`，`redaction.unit.test.ts`。
   - ADR 0188 与 0165 已同步。已知代价：版本 1 的老对话继续把宽松写法的密码原样发给模型，直到它因别的原因换新或手动换新（`thread prompt rebuild`）。

## 请重点看

- 版本字段的所有读写路径：旧记录（没有字段）、`rollout`、换新、手动换新（`requestThreadPromptRebuild` 让旧行失效后下一次运行建新行）、被钉住的运行（pin）里的版本是否一致；有没有哪条路径让同一个对话的版本在两次请求之间变化而不换新。
- 没有记录的调用（`threadId` 为空、没有 `promptBundles` 依赖）用当前版本是否会让某个对话的前缀变化。
- 必答问题 1：会不会改变模型已经见过的请求开头。
- 新用例是否真的会失败（特别是“中途换版本必须被报告为断开”）。
