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
- 发给模型的内容只追加（.agents/instructions/prompt-prefix.md）：memory_open 定义加在工具列表最末尾；原有工具定义不变（测试锁住了 conversation_search 之前所有定义的哈希，等于 main 的；conversation_search、conversation_open 的描述符本 PR 没改）。recall 的工具说明没改，只是结果里多一个字段。
- 工具结果每页上限 = max(2000, 主模型上下文窗口 × memory.toolResultShare，默认 2%)，和 PR 620 的翻原话工具同一个数。
- 不能给模型看的密级（restricted）、已永久删除或等待删除的记忆，一律按“没有这个编号”回答。
- 读到的记忆出自外部内容（网页、邮件）时，这次运行要记“读过外部内容”（和 recall 一样用 recalled_external_record）。
- 代码不写注释。

## 作者的说法（请核对）

1. 迁移后已有记忆按记录时间从 1 编号，各 agent 分开；之后新插入的记忆由触发器接着编，删掉的编号不复用。
2. byNumber 和 numbers 只在同一个 owner、agent 范围内查，查不到别的 agent 的记忆。
3. memory_open 的每页 JSON 总长不超过 pageCharacters；记忆正文太长时按页切开分在前几页，各页 text 拼起来等于全文，正文给完以后的页不再有 text；版本正文和原话超长时截断并以“…”结尾；分页布局和所请求的页码无关，页数不设上限，nextPage 只在还有下一页时出现。
4. 输入不合法（缺 number、非正整数、page 越界、多余参数）一律 MEMORY_OPEN_INPUT_INVALID；其他失败 MEMORY_OPEN_UNAVAILABLE，不外露内部错误。
5. 模型不可见密级（restricted）的版本正文或原话给 null；结果密级取请求密级、这条记忆的密级和这一页实际给出的正文、版本正文、原话的密级里最高的一个，别的页上的内容不算进来。

## 请重点看

- packages/persistence-sqlite/src/migrations/20261124205713_memory_numbers.sql
- packages/persistence-sqlite/src/sqlite-memory-operations.ts 的 numbers / byNumber
- apps/agent-service/src/production-memory-open.ts
- apps/agent-service/src/production-runtime-tools.ts 的 #memoryOpen 和描述符拼接
- packages/prompt-catalog/src/tools.ts 的 TOOL_MEMORY_OPEN 文字是否清楚
- apps/agent-service/src/production-conversation-tools.ts：搜旧对话页码超过最后一页时，说明改成“没有更多了”（TOOL_RESULT_CONVERSATION_NO_MORE），只有一页都没有时才说“没有找到”。
- test/integration/production-http-composition-process.test.ts：修 main 上 6 条红测试。按轮建对话索引多 1 次嵌入、记忆整理同轮重试多 1 次模型调用，测试先等它们落账再核对计费；检索嵌入只比较带 Query: 的；测试模型上下文窗口由 8192 改成 32768（8192 减去 Pi 预留 4096 后放不下提示和工具定义）。请看等待和过滤会不会把真正的多余调用漏掉。
