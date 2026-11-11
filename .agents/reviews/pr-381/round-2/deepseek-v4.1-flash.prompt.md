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
仓库就是当前目录，已检出 432fe4b8e8302f4fbc81d6e56127e28175001a3c。
对比基准是 a57fffb76fce1c2244115ba04ba20519521a9e54，先运行 git diff a57fffb76fce1c2244115ba04ba20519521a9e54..432fe4b8e8302f4fbc81d6e56127e28175001a3c 看改动。
上一轮复核到 606862d3ac37cb8605a62c35abd9f6a8e6ddd5dd，先看 git diff 606862d3ac37cb8605a62c35abd9f6a8e6ddd5dd..432fe4b8e8302f4fbc81d6e56127e28175001a3c 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 381 第 2 轮：按第 1 轮意见的修改，加合入最新 main

上一轮复核的提交是 606862d3。本轮看它之后的两部分：

1. 提交 2a4a3e4b：按第 1 轮意见修改（逐条判断见 `.agents/reviews/pr-381/round-1/judgments.md`）。
   - 模型调用记忆工具时本轮已失去执行权（嵌入准入报 `NOT_AUTHORITATIVE`），不写检索降级记录（`production-run-memory.ts`、`production-memory-composition.ts`）。聊天检索本来就把取消信号传进来（`run-coordinator.ts:474-476` → `context-formation-service.ts:244` → `production-run-memory.ts` 的 `search`）。
   - `make-packet.py` 的嵌入目标按服务启动的条件核对，出包档案清单与 TypeScript 档案一致由测试保证。
   - 本机模型：推理中放弃的调用方不拿向量；关闭先等在算的那条；畸形请求 400/404。
   - 每日摘要补算跳过算不出的那条，一页全失败才报错（`packages/memory-engine/src/episodes.ts`）。
   - 导出测试加正向对照；ADR 0224、威胁模型、规则清单同步。
2. 合并提交（合入 origin/main，带进 P3-3 检索融合后截断去重等）。冲突在 `production-memory-composition.ts`、`production-run-memory.ts`、`hybrid-memory-provider.ts`、`strict-configuration.ts`、`startup-configuration.unit.test.ts`、`prompt-rendering-golden.unit.test.ts`、`memory-retrieval-eval/live.test.ts`；main 新加的 `hybrid-memory-provider.unit.test.ts`、`mcp-read.test.ts` 改用 `embedQuery`/`embedDocument`。只合入 main、没有冲突的文件不用看。

## 请重点核对
- 冲突解决有没有丢掉任何一边的行为（尤其 P3-3 的 `relevance`、`dedupeSameSource`、`onRelevanceUnknown`，和本 PR 的取消判断、本机运行时关闭）。
- 把 `NOT_AUTHORITATIVE` 当作“本轮已不归我”是否会吞掉真实的检索失败。
- 补算逐条跳过后，循环会不会不结束、或在执行权已失时继续花钱。
