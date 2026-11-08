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
仓库就是当前目录，已检出 e29a3007257eebae019d929e4973052a91e30928。
对比基准是 5530765ed0855341c5e78ffb5de747a37202c31b，先运行 git diff 5530765ed0855341c5e78ffb5de747a37202c31b..e29a3007257eebae019d929e4973052a91e30928 看改动。
上一轮复核到 8855e042ce27b81107c99e9e585f231338e12165，先看 git diff 8855e042ce27b81107c99e9e585f231338e12165..e29a3007257eebae019d929e4973052a91e30928 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 312 代码复核材料（第 2 轮）

第 1 轮两个模型都说没有发现高、中严重度的功能回归，指出的问题集中在文档和门槛上。本轮要复核的是按那些意见做的修改，以及把 `origin/main` 合进分支这一次合并。

第 1 轮复核的提交是 `8855e042`，本轮复核 `e29a3007`。

## 按第 1 轮意见做的修改

### 一、补上一条真能跑红的检查（第 1 轮 R1-5、R1-6）

第 1 轮两个模型都指出：第三条改动（延续授权那条路拿不到「写不可恢复记录」的入口）只有读代码的推理，没有任何会变红的检查；如果以后有人把 `resultUnrecoverable` 挪进两个实例共用的那份参数，这条路会重新拿到写入口，而当时没有用例会失败。

DeepSeek 给的办法是不去造「同一批里有两个沙箱调用」的夹具，而是直接在同一份状态上调用只判断的那个实例。照这个办法做了：
- `apps/agent-service/src/production-run-composition.ts` 把 `inspectToolResultRecovery` 放进 `createProductionRunComposition` 返回的对象里。
- `test/integration/sqlite-sandbox-execution-v2.test.ts` 的 `loss-unrecoverable` 变体，在写记录之前先调用这个实例，断言它返回 `undefined`，并且数据库里 `operation_key LIKE 'sandbox-tool-result-unrecoverable:%'` 的记录数为 0。

已实测的反向验证：把 `...(options.sandboxResultUnrecoverable ? { resultUnrecoverable: options.sandboxResultUnrecoverable } : {})` 加进 `toolResultRecoveryParts` 之后，这条断言以 `expected { count: 1 } to deeply equal { count: +0 }` 失败；还原后通过。

### 二、`docs/lessons.md`（第 1 轮 R1-1、R1-2）

2026-11-08（PR #282、I-84）那条教训原来把 `test/tooling/safe-tool-reason-codes.test.mjs` 列为必须手工加进第 0 层清单的按路径扫源码的门槛，而这个文件本 PR 已删除。改成只列 `apps/agent-service/test/prompt-catalog.unit.test.ts` 和 `npm run check:glossary`，并写明原来那个文件比对的是白名单的两份拷贝、合成一处后已删除。

### 三、Backlog `BL-20261017-005`（第 1 轮 R1-3、R1-4）

这条 Backlog 的处理方向就是本 PR 第二条改动，而它还是 `record_state: "open"`、摘要说白名单「现在有两份」。用 `document-governance` 的 `idea_backlog.py close BL-20261017-005 --state done --result …` 关闭，再用 `archive_doc.py` 归档到 `docs/archive/backlog/`。

### 四、事故表 I-84 那一行的措辞（第 1 轮 R1-7）

原来写「这条路在类型上就拿不到写入口」。`resultUnrecoverable` 仍是可选字段，拦住写入的是运行期条件 `options.resultUnrecoverable &&`，不是类型系统。改成「这条路的实例没有传入这个回调，写记录的条件永远不成立」，并把上面那条新断言写进同一行；原来那段「为什么不加用例」的论证改写成「哪一次调用仍然没有直接用例、为什么，以及新断言怎样绕开这个限制」。

## 没有按意见改的

第 1 轮有三条被判为「可以更好」，按项目规则不改，列给 Andy 定：按 1024 换算却仍写 `KB`、`MB`（严格说是 `KiB`、`MiB`）；`limitBytes` 的 KB 用 `toFixed(1)` 而界面上 `delivered-files.ts` 的 KB 用 `Math.round`；`thread-execution-state.unit.test.ts` 的白名单用例只点名 21 个原因码里的 11 个。逐条判断在 `.agents/reviews/pr-312/round-1/judgments.md`。

## 把 origin/main 合进分支

`e29a3007` 是一次合并提交，把 `5530765e` 合进来，没有冲突。它带进来的是别的 PR（#300、#310）的改动，不是本 PR 的内容。

## 已经跑过的检查

- `apps/agent-service/test/service-orchestration.unit.test.ts` 71 条、`test/integration/production-queued-run-restart.test.ts` 11 条、`test/integration/thread-run-lifecycle.test.ts` 206 条、`test/integration/sqlite-sandbox-execution-v2.test.ts` 765 条，全过（在合并 main 之前跑的）。
- `npm run typecheck`、`npm run lint`、`npm run check:incident-gates`（incidents=85 errors=0）、`npm run check:instruction-links`、`npm run check:glossary` 通过。
- `document-governance` 的 `validate_docs.py --strict` 仍是 main 上原有的 11 条 Runbook 哈希错误，没有新增。
- `npm run format:check` 失败，两处都在 `scripts/model-review/opencode-review.mjs` 和 `test/tooling/opencode-review.test.mjs`，是 main 上 `c7685e77` 起就有的；本 PR 一度顺手修过又整段撤回（`8855e042`），因为 PR 306 在改同样这几行。

## 特别想知道的

- 新加的那条断言放在 `loss-unrecoverable` 变体里、在 `make("restarted-consumer").dispatcher.pump()` 之前。请判断它放在这个位置会不会改变这个变体后面那些断言要验证的状态（例如多调用一次恢复扫描是否留下别的副作用）。
- 把 `inspectToolResultRecovery` 放进 `createProductionRunComposition` 的返回值，是为了让测试能拿到它。请判断这样做有没有扩大不该暴露的面，或者有没有更合适的做法。
- 事故表 I-84 那一行和 `docs/lessons.md` 改后的措辞，和代码是否相符。
