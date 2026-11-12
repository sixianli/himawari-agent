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
仓库就是当前目录，已检出 17670535fce736af38351df2238ae0381214914b。
对比基准是 075dd4a679e4c2f66b18c3814185988ac6bf1bda，先运行 git diff 075dd4a679e4c2f66b18c3814185988ac6bf1bda..17670535fce736af38351df2238ae0381214914b 看改动。
上一轮复核到 e36981acc8401ad695fb7611df23ef8d8f202edc，先看 git diff e36981acc8401ad695fb7611df23ef8d8f202edc..17670535fce736af38351df2238ae0381214914b 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 408 作者说明：其他 agent 写进来的记忆先存「待确认」（P5-3 PR A）

## 问题
外部 agent（Muse、Claude Code、Claude 应用）通过 MCP 的 `propose_memory` 往 Himawari 写记忆。原来（ADR 0225）只在客户端弹确认框，同意才保存；客户端不支持确认框、取消、或 1.5 秒内回来的回答（Claude 桌面 App 不显示确认框却自动回拒绝）都不保存，数据丢了。Andy 定的完成标准：不能弹框的客户端写进来的存成「待确认」，Andy 在 Himawari 里确认。

## 目标与约束
- 新表 `external_memory_proposals`（迁移 0093）。第一次调用就存一条 pending；正文加密存 payload（`memory-content:mcp-proposal:<摘要>`），不进记忆表、检索索引，模型任何读路径都读不到。
- 同意直接保存（记忆 id `memory:mcp:<提议>`），拒绝记 rejected；不支持确认框、记忆本没准备好、取消、unseen 都留 pending。
- 按正文摘要去重（唯一索引 owner、agent、text_sha256，排除 superseded）：已保存回 ALREADY_SAVED，拒绝过回 DECLINED。同一个 source_key 的新正文替换旧 pending。
- 批量工具 `propose_memories`：1–50 条，每条单独状态；超 50 或 schema 不合整个调用拒绝。
- 机器密钥（`scanMachineSecrets`）拒收。
- 网页接口：`memory.overview.snapshot` 多 `externalProposals`；`memory.external.respond`（1–500 项，keep 可带 editedText，reject 不能带）；`memory.external.undo {batchId}` 把这一批保存的记忆移到废纸篓、提议回到 pending。网页确认的记忆 id 带 `:batchId` 后缀。保存时正文和已有 active 记忆相同，只挂到那条记忆。
- 拒绝的正文 30 天后删除，只留摘要继续挡。pending 不过期。
- 一个 `ProductionMcpMemoryWriter` 实例同时给 MCP 和网页用，按提议编号加锁串行。
- 发给模型的内容只追加；不得写代码注释；数据导出暂时把这些提议列为未导出（网页区块、每日回顾、完整导出在下一个 PR）。

## 请重点看
- 并发：MCP 同意和网页确认同时发生、同一批里重复编号、撤销和再次确认交错时，会不会重复保存或状态和记忆不一致。
- 迁移的 CHECK 约束和代码写入的状态组合是否一致；外键 RESTRICT/SET NULL 在删除记忆、payload 时会不会挡住已有的删除流程。
- 待确认正文是否真的进不了任何模型可读路径（find_memories、today_context、档案、索引）。
- 撤销按 id 后缀找记忆是否会误伤别的记忆。
- respond 部分失败时的返回和状态。
- ADR 0228 及 ADR 0225 加的说明与代码是否一致。

## 第 2 轮：本轮改了什么（作者说法，请核对）
按第 1 轮意见修改（逐条判断见 PR 里提交的 round-1/judgments.md，复核副本里看不到）：
- 正文按 UTF-16 码元限 2000；网页批次号改为幂等键 SHA-256 前 32 位加 `batch-`。
- 按正文找已有记忆挪进 keep()（客户端确认框也走），同批改成同样正文只建一条；去掉 keepAsExisting。
- 写入器 submit、keep、decline 在一个队列里串行；keep 检查 decide 结果。
- 存储层命中已有行时删掉没人引用的新 payload；被替换的正文 30 天后也清掉（迁移 CHECK 改为 rejected 或 superseded 时 content_ref 可空）；命中待确认行且新分级为敏感时调高。
- 修订串用 pendingSummary（不解密）；待确认、被替换的决策记录不进每日回顾；key 扫机器密钥；超长 subjectRef 存摘要；重发补写待确认记录；回收站里的同号记忆报 MCP_PROPOSAL_MEMORY_REMOVED。
请重点看这些修改本身有没有引入新问题（例如队列串行有没有死锁、payload 删除会不会删掉仍被引用的正文、分级调高和 payload 分级是否矛盾）。

## 第 3 轮：本轮改了什么（作者说法，请核对）
按第 2 轮意见修改：
- 撤销挪进写入器 undoBatch，在同一个队列里查批次、移入回收站、重新打开。
- MCP 确认框回答时，decline 返回 false 或 keep 抛 MCP_PROPOSAL_ALREADY_DECIDED，按实际状态回复。
- 已有记忆摘要在队列内的 keep 里取，写入器新建记忆计数变了就重算；跳过 tentative 和 supersededBy 不为空的记忆。
- 待确认正文引用带分级；调高时行改指敏感那份，旧的没人引用就删。
- 过期正文清理进队列；批量结果里被同 key 替换的报 replaced；导出计数排除 committed；提议编号限 64 字。
请重点看这些修改本身是否正确、有没有引入新问题。

## 第 4 轮：本轮改了什么（作者说法，请核对）
按第 3 轮意见修改：
- 撤销后写入器记忆变化计数加一，摘要表重算；挂到已有记忆前再读一次，不是 active 就新建。
- 存储层命中已有待确认行时，也把同一 key 的其他待确认行标为被替换，命中行没有 key 时补上。
- listPending 进写入器队列；submit 返回本次替换掉的编号，批量结果只把本次调用里被替换的标 replaced。
- 工具说明改成分类不对、超过 50 条整次被拒；提议编号上限改为 40；ADR 0228 待确认正文引用带分级。
请重点看这些修改本身是否正确、有没有引入新问题。

## 第 5 轮：本轮改了什么（作者说法，请核对）
按第 4 轮意见修改：
- 调高分级时把分类一起改成这次提交的分类；新建记忆成功后立刻更新摘要计数；propose_memories 的 idempotentHint 改为 false。
- 新增表 external_memory_proposal_keys（迁移 0093 内，主键 owner、agent、source_key）：每个 key 指向它最近一次带来的正文。提交时把 key 指向本次的行；原来指着的行和 source_key 列等于这个 key 的待确认行里，没有任何 key 再指着的才标为被替换。
- 写入器 submit 自己查正文长度、机器密钥、key 长度和密钥；存储层查 subjectRef、client、normalization、source_key 长度和分类、分级取值。
请重点看：key 表和 source_key 列两套说法是否会不一致（撤销后重新打开、命中已保存或已拒绝的行时 key 不改指）、外键级联、替换逻辑会不会漏标或误标。

## 第 6 轮：本轮改了什么（作者说法，请核对）
按第 5 轮意见修改：
- key 带来已保存或已拒绝的正文时同样改指，原来指着的待确认没人再指就标为被替换，被替换的决策记录不再只在命中待确认时写；key 表主键加 client，替换只看同一客户端。
- 撤销：写入器只把这批新建记忆（按 externalProposalMemoryId 精确比对）的条目和拒绝的条目交给存储层重新打开；其余已保存条目留在已保存、batch_id 清空。存储层 reopenBatch 多了 reopen 参数。
- 彻底删除记忆（sqlite-governed-deletion）时把 memory_id 指向它的提议改为 rejected、清 content_ref 和 memory_id，正文 payload 进删除清单。
- 敏感提议不挂到 private 的已有记忆，另建；respond 一条都没决定时报 MCP_PROPOSAL_ALREADY_DECIDED；decide 拒绝 committed 且 memoryId 为空；写入器存正文前先查分类和 client 长度。
请重点看：彻底删除这一步会不会删掉仍被别的行引用的 payload、和已有删除流程的事务顺序；撤销后批次统计和再次撤销；key 改指到已保存行后再撤销那一批时的状态。
