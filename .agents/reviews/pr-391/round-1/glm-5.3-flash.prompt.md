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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 de952d31cd60d5cea9a583037ad84a9fef16bfd2。
对比基准是 ff53635fd0ffb03af97d830d32d4be5148fd07bc，先运行 git diff ff53635fd0ffb03af97d830d32d4be5148fd07bc..de952d31cd60d5cea9a583037ad84a9fef16bfd2 看改动。
作者的说法（可能有错，请核对）：
# PR 391 作者说明

## 问题
main.yml 自 2026-11-10 16:11 JST 起每次都 startup_failure。PR 347（ADR 0201）让 ci.yml 的 required 作业申请 `actions: write`（删除本次运行的报告产物），而 main.yml 的 full 作业通过 `uses: ./.github/workflows/ci.yml` 调用它时只继承工作流级的 `actions: read`。GitHub 规定被调用的可复用工作流拿不到超过调用方的权限，于是整轮在启动前失败。

## 改动
- main.yml 的 full 作业显式写 permissions：contents: read、actions: write、pull-requests: read。
- scripts/ci/main-workflow.mjs：原来要求 full 不得有 permissions，现在要求正好是上面这组（错误码 full-permissions）。
- test/tooling/ci-optimization.test.mjs 新增 [I-93] 测试：ci.yml 顶层和每个作业申请的每项权限，都不能高于 main.yml full（或工作流级）授予的权限；并验证把 actions 改回 read 时 validateMainWorkflow 抛 full-permissions。
- docs/incidents-and-gates.md 新增 I-93 一行。

## 作者的说法，请核对
1. 这组权限是最小的：只有 required 作业需要 actions: write，其余作业只读。full 作业授予 actions: write 不会让 main 上的 plan/confirm 作业拿到写权限。
2. [I-93] 测试能拦住同类回归：以后 ci.yml 任何作业新增更高权限而 main.yml 没跟上，测试会失败。
3. 不影响 PR 触发的 ci.yml（pull_request 事件）的权限。

## 约束
不写代码注释；不改 ci.yml 的 job 数量和 DAG（check-policy.mjs 校验）。
