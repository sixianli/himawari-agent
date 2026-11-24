你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条意见单独一个以「### 」开头的三级标题（标题里写序号、严重度和一句话问题），下面写：文件:行、问题、证据（引用你亲自读到的那几行代码）、建议；意见以外的内容不要用三级标题。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 f1ef788b775a1a08eeb8ab2a1b21a44a1f1bb4b1。
对比基准是 1bf660da051af28383162d27dc01749329f968f9，先运行 git diff 1bf660da051af28383162d27dc01749329f968f9..f1ef788b775a1a08eeb8ab2a1b21a44a1f1bb4b1 看改动。
作者的说法（可能有错，请核对）：
# PR 629 复核材料：记忆编号和按编号打开记忆

## 问题和目标

ADR 0286（docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md）第 2 步的前半：
- 每条记忆有一个固定不变的短编号（按主人和 agent 分开从 1 数），以后记忆清单每条一行写“编号紧贴内容”，主模型凭编号打开。
- recall 工具的每条结果多一个 number 字段。
- 新的只读工具 memory_open：按编号打开一条记忆，返回全文、类别、现在状态（current / corrected / ended / tentative / trashed / archived）、日期、取代它的记忆的编号（correctedBy），以及按时间排的各个版本和当时主人的原话（quote），按每页字数上限分页。

记忆清单（开头快照）在下一个 PR，本 PR 不改系统提示和每轮资料。

## 约束

- 迁移只加不改：新表 memory_numbers 和 memory_number_counters，加一个 memory_records 的 AFTER INSERT 触发器；已有记忆按 recorded_at（没有时用 updated_at）、id 排序补编号。
- 编号永不复用：记忆删除后它的编号不再分给新记忆（计数器表只增不减）。
- 发给模型的内容只追加（.agents/instructions/prompt-prefix.md）：memory_open 定义加在工具列表最末尾；原有工具定义不变（测试锁住了 memory_open 之前所有定义的哈希，等于 main 的）。recall 的工具说明没改，只是结果里多一个字段。
- 工具结果每页上限 = max(2000, 主模型上下文窗口 × memory.toolResultShare，默认 2%)，和 PR 620 的翻原话工具同一个数。
- 不能给模型看的密级（restricted）、已永久删除或等待删除的记忆，一律按“没有这个编号”回答。
- 读到的记忆出自外部内容（网页、邮件）时，这次运行要记“读过外部内容”（和 recall 一样用 recalled_external_record）。
- 代码不写注释。

## 作者的说法（请核对）

1. 迁移后已有记忆按记录时间从 1 编号，各 agent 分开；之后新插入的记忆由触发器接着编，删掉的编号不复用。
2. byNumber 和 numbers 只在同一个 owner、agent 范围内查，查不到别的 agent 的记忆。
3. memory_open 的每页 JSON 总长不超过 pageCharacters（版本正文和原话超长时截断），nextPage 只在还有下一页时出现。
4. 输入不合法（缺 number、非正整数、page 越界、多余参数）一律 MEMORY_OPEN_INPUT_INVALID；其他失败 MEMORY_OPEN_UNAVAILABLE，不外露内部错误。
5. 内容密级取请求密级和这条记忆密级里高的一个。

## 请重点看

- packages/persistence-sqlite/src/migrations/20261124205713_memory_numbers.sql
- packages/persistence-sqlite/src/sqlite-memory-operations.ts 的 numbers / byNumber
- apps/agent-service/src/production-memory-open.ts
- apps/agent-service/src/production-runtime-tools.ts 的 #memoryOpen 和描述符拼接
- packages/prompt-catalog/src/tools.ts 的 TOOL_MEMORY_OPEN 文字是否清楚
- apps/agent-service/src/production-conversation-tools.ts：搜旧对话页码超过最后一页时，说明改成“没有更多了”（TOOL_RESULT_CONVERSATION_NO_MORE），只有一页都没有时才说“没有找到”。
