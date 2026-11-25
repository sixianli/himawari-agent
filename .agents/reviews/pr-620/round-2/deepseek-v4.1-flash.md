本轮查过的范围：`git diff b84767c40ec8cd471fdd87fc11c1ac1d68c8f39a..2a2692316b378f90d2a172441995cac862f3f14e`，包括 4787cf3d1 的第 1 轮修复和 2a2692316 的合并解冲突。重点读了 `production-conversation-tools.ts`、`production-runtime-tools.ts`、`production-tool-actions.ts`、`context-external-content.ts`、`packages/prompt-catalog/src/tools.ts`、`prompt-manifest.json`、`conversation-turns.ts`、`sqlite-conversation-turn-operations.ts`、相关单元/集成测试、`docs/architecture-v0.1.md` 和 `service-main.ts` 的接线。PR 618 带来的 `tool-result-clearing`、`runtime-pi` 内部实现只看了与本 PR 工具拼接、预检、取回拦截直接相关的边界，没有整份重审（在 PR 618 各轮已复核）。

### 1. 中：搜索和打开工具的“每页上限”仍不是整个工具结果的硬上限，预算只算对话正文，不含 JSON 元数据

文件:行：`apps/agent-service/src/production-conversation-tools.ts:155-170`、`214-254`、`287-292`

问题：本次修改让分页按“剩余正文预算”逐行装入，但 `size` 只累计每行原文的字符数（`size += [...next.text].length`），而工具结果里还有每轮的 `conversationId`、`sequence`、`day`、`truncated`、`nextPage` 等字段。`conversation_open` 也把 `conversationId`、`earlierFrom`、`laterFrom` 等放在正文字数之外。因此“工具一次返回不超过窗口 2%”作为整个工具结果的上限并没有成立：哪怕只有一轮，正文刚好 2000 字时，序列化后的结果也会超过 2000；多轮短对话时元数据会远超 2% 预算。

读代码证实的：分页判断是 `if (current.length > 0 && used + size > budget)`，而 `size` 只来自 `#fitted` 的 `size += [...next.text].length`；输出时又逐轮追加了 `conversationId/sequence/day/lines/truncated`，这些都没有计入 `used`（`production-conversation-tools.ts:219-229`、`242-249`）。集成测试也只统计了 `lines` 里的 `text`（`test/integration/conversation-turns.test.ts:805-810`），测不到这部分。

推测：如果产品定义的预算是“对话原文字符”而不是“整个工具结果字节”，则现状符合；但作者的约束和 ADR 0286 写的是“工具一次返回不超过窗口 2% / 每页最多 2 万 token”，按这个口径就没有做到。

建议：把每轮的元数据开销也计入预算（可以按 `JSON.stringify` 后的字符或固定预留估算），或限制每页轮数；集成测试同时断言 `JSON.stringify(result.output)` 不超过预算（允许少量固定误差要在测试里写明）。

### 2. 中（旧代码，不是本轮增量）：`conversation_search` 搜不到已归档对话，和“未进回收站都能搜”以及 `conversation_open` 的行为不一致

文件:行：`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:28-33`、`packages/memory-engine/src/conversation-turns.ts:381-383`

问题：搜索的 SQL 要求线程 `t.status = 'open'`，所以已归档（archived，不是回收站）的对话永远搜不到；但 `conversation_open` 的 `window` 明确允许 `active` 和 `archived`。结果是模型可以按已知编号打开归档对话，却无法通过搜索找到它。作者材料写的是“只搜主人发起的、未进回收站的对话”，记忆系统设计也写“对话删除时索引同时删掉，搜不到也打不开”，都暗示归档对话仍应可搜。

读代码证实的：`AND EXISTS (SELECT 1 FROM threads t WHERE t.id = c.thread_id AND t.status = 'open' AND t.origin = 'owner')`；而 `window` 用的是 `if (!thread || (thread.status !== "active" && thread.status !== "archived")) return undefined;`。现有 `conversation-turns` 集成测试没有归档对话的用例。

推测：这可能是 PR 614 建索引时的有意取舍，但与当前说明文字和产品行为不一致，建议确认；若要归档也搜，改成 `t.status IN ('open','archived')` 并补正反用例。

建议：确认“归档”是否算“未进回收站”；是的话修改查询并加测试，不是的话修正文档和工具描述，避免模型以为旧归档对话可搜。

### 3. 低：新提示说 `earlierFrom`/`laterFrom` 是“还有原话时接着读的位置”，但从最后一条往前打开时 `laterFrom` 仍会返回非 null

文件:行：`packages/prompt-catalog/src/tools.ts:54`、`packages/memory-engine/src/conversation-turns.ts:424-430`

问题：新提示文字把两个指针描述成“还有原话时接着读的位置”。实现里方向为 `earlier` 时，`laterFrom = lastLine.sequence + 1` 是无条件给的；如果 `fromSequence` 已经是这个对话的最后一条，`laterFrom` 指向一个不存在的序号。模型按提示去“往后接着读”，会得到一个 `found: true` 但 `lines: []` 的空结果，浪费一次调用。

读代码证实的：`laterFrom: lastLine && (input.direction === "earlier" || stoppedAt !== null || messages.length >= MESSAGES_PER_READ) ? lastLine.sequence + 1 : null`。方向为 `earlier` 时第一个条件恒真。提示原文见 `tools.ts:54`。

推测：这是边界体验问题，不是数据错误；模型会浪费一次工具调用，但不会看到错误内容。

建议：实现上只有在确实存在下一条消息时才返回 `laterFrom`，或把提示改成“非 null 只说明可以从这里继续试，可能已经没有更多”；同时补一个“从最后一条往前打开”的集成用例。

### 4. 低：外部内容标记的反向检查只到桩函数，没有验证真实 thread 存储键，也没测 `conversation_open` 路径

文件:行：`apps/agent-service/test/production-runtime-tools.unit.test.ts:1573-1613`、`apps/agent-service/src/production-runtime-tools.ts:854-863`

问题：上一轮意见 2 的核心假设是“`conversation_search/open` 显示的对话线程若读过外部内容，当前运行要记 `recalled_external_conversation`”。新测试把 `readThread` 完全打桩，只验证了“返回哪些 id 时会调用 mark”；它没有用真实的 `ContextExternalContent` 验证 `mark(runId, ...)` 写进去的键和 `readThread(conversationId)` 读的键确实是同一个 thread 键，也没有覆盖 `conversation_open` 的 `conversationIds` 分支。真实存储键若写错（例如写成 run 键却按 thread 键读），单测仍然通过。

读代码证实的：测试里 `const readThread = vi.fn(async (threadId: string) => threadId === "thread:web" ? [...] : [])`；`mark` 也是 `vi.fn`。真实实现 `readThread` 用 `externalContentKey({threadId, runId:""})`，`mark` 用 `#scopes(runId)` 的第一项；两者目前看起来匹配，但没有测试锁住。

推测：实现本身从代码看是对的；这是测试覆盖缺口，不是已确认的功能错误。

建议：加一条使用真实 `ContextExternalContent` 和真实 thread 状态的集成用例：旧运行在线程 A 读过网页 -> 新运行搜索/打开 A -> 后续有后果的工具触发 `context_external_content` 事实；再来一条线程没读过外部内容时不触发的反向用例。

### 5. 低（旧代码）：`direction: null` 被当成缺省 `later`，而不是作者声称的 `CONVERSATION_INPUT_INVALID`

文件:行：`apps/agent-service/src/production-conversation-tools.ts:261-268`、`69`

问题：工具参数 schema 写的是 `direction` 为 `"later" | "earlier"`，作者说法 2 说“direction 不在枚举里一律变成 `CONVERSATION_INPUT_INVALID`”。但代码用 `args["direction"] ?? "later"`，显式传 `null` 会被当成缺省值并成功执行，不报输入错误。其他非法值（数字、空串等）会正确报错。

读代码证实的：`const direction = args["direction"] ?? "later";` 后面只检查 `direction !== "later" && direction !== "earlier"`，而 `null ?? "later"` 已经变成 `"later"`。

推测：影响很低（只是回退到默认方向），但和严格的参数契约、作者说法不一致，属于不合规范输入被静默接受。

建议：改成只有 `undefined` 才用默认值，`null` 和其他非枚举值报 `ConversationToolInputError`。

**上一轮意见核对**

- 意见 2（外部内容标记）：代码主路径已补上，搜索和打开都会拿 `conversationIds` 去查 thread 标记并调用 `mark(call.runId, RECALLED_EXTERNAL_CONVERSATION_ORIGIN)`（`production-runtime-tools.ts:854-863`）。但测试是桩，见上面意见 4。
- 意见 3（分页字符预算）：正文逐行装入、截断省略号计入正文上限、超出轮次标 `truncated`，这部分确实改好了（`production-conversation-tools.ts:114-170`、`219-229`）；整个工具结果的硬上限仍未做到，见意见 1。
- 意见 4（`conversation_open` 方向提示）：主体改好了，明确写了 `earlierFrom + earlier`、`laterFrom + later`、null 表示那一头读完（`tools.ts:54`）；只是最后一条往前打开的边界描述不准确，见意见 3。
- 意见 1（想一想只读工具集）：文档已补 `conversation_search`、`conversation_open`，合并后又补了 `tool_result_recall`（`docs/architecture-v0.1.md:437`），测试改成精确集合（`think-run-pieces.unit.test.ts:33-43`），已改好。

**侧重检查**

- 错误路径：`readThread` 或 `mark` 抛错时，`#conversation` 的失败映射会把整个调用变成 `CONVERSATION_UNAVAILABLE`，不把对话正文交给模型；结果缓存在 `run_and_tool_call` 下，重放同一调用不会绕过。已确认。
- 不可信输入：多余键、空/超长 query、日期格式、日期不存在、页码 1–100、sequence 正整数、conversationId 非空且 ≤200、direction 枚举都有校验；SQL 全部参数化。唯一缺口是 `direction: null`，见意见 5。
- 安全：`conversation_search` 的 SQL 限定 `t.origin='owner'`，`window` 显式拒绝 `origin: "think"`，所以想一想线程搜不到也打不开；回收站（trashed）两条路径都拒绝。已确认。发现归档对话“能打开、搜不到”的不一致，见意见 2。
- 资源耗尽：分页只限制输出正文，但每次搜索仍会先把最多 60 轮的全部原文读/解密到内存（`conversation-turns.ts:363-369` 调用 `turnLines`），再交给 `#fitted` 截断；这是旧代码，本轮增量没有改变读取成本，只改变了输出分页。建议后续按预算提前停止读取。
- 不可撤销操作：两个新工具都是只读，动作表登记为 `actionKind: "READ"`、`sideEffect: "none"`；外部内容标记是幂等状态写入，不涉及撤销。
- 规则/文档一致：`prompt-prefix.md` 的“按对话冻结、工具集合变了换新一次”解释了新增工具带来的前缀变化；`architecture-v0.1.md` 的只读工具清单已与测试一致；`prompt-manifest.json` 更新了 `tools.conversation-open` 的摘要和原因。旧提示文字里没有数字，换成新文字后老对话即便按“外来内容”重新检查，也不容易因敏感数字改变遮盖（但具体哈希我未重算，见必答问题 3）。

**作者说法核对**

1. 基本成立：`conversationToolDescriptors()` 只在 `#options.conversations` 存在时加入，且拼在 `[...offered, toolResultRecallDescriptor(), ...conversations]` 的最后（`production-runtime-tools.ts:619-627`）；原有工具定义没有被改写。注意“只在末尾追加”是指工具列表末尾，工具定义整体仍在系统提示和历史之前，老对话会因工具集合变化重建一次。
2. 大体成立，但 `direction: null` 被当成缺省 `later`；另外 `page` 只要在 1–100 内、超过实际结果页数时返回空结果和 `note`，不报 `CONVERSATION_INPUT_INVALID`（测试 `conversation-turns.test.ts:824-825` 明确这样期望）。如果“page 越界”指超过实际页数，这条说法不成立。
3. 正文层面成立；`nextPage` 只在 `page < pages.length` 时出现，单行截断也有行级 `truncated`。但“每页上限”不是整个工具结果的硬上限，见意见 1。
4. 代码顺序成立：`conversationTurns` 在 `service-main.ts:1549-1570` 创建，`recallProjection` 在 `1617`；`conversationTurns` 用的是 `memoryComposition.projection` 的嵌入器和失败回调 `conversationTurnFailure`。是否与 PR 614 在每个槽位、每种失败上报上完全一致，我没有逐行对比 PR 614 原实现，标“未核实”。
5. 成立：`conversation_search/open` 两行在 `production-tool-actions.ts:266-297`，都是 `READ`、`targetType: "owner-conversation"`、`executor: "owner_scoped"`、`deduplication: "run_and_tool_call"`，`readOnlyRow` 为真。注意它们的 `authorization` 是 `"read"`，不是 `"owner_scope"`；这里说“主人范围”应理解为数据范围，不是授权路径。

**必答问题**

1. 这个改动会不会改变模型已经见过的请求开头？
   - 消息、历史、工具结果层面仍然是只追加：新增的 `truncated`、分页结果、外部内容标记都不改写旧消息；每轮会变的页码、截断信息、`day`/`time` 都在当次工具结果里，而在系统提示和工具定义里没有新增时间、路径、额度这类值。
   - 但工具定义块会增加 `conversation_search`、`conversation_open`（合并后还排在 main 新加的 `tool_result_recall` 后面）。工具定义在请求最前面，所以对已经见过旧工具列表的对话，前缀会变一次；这属于规则第 6 条允许的“工具集合变了换新一次”，不是纯消息追加。作者材料说上线前旧对话会全部删除，如果确实如此，就不会有已见前缀的老对话。
   - 修改 `TOOL_CONVERSATION_OPEN` 文字只对之后新建/换新的对话生效；已有对话冻结的旧工具定义不会在历史中间被改写。遮盖方面，旧文字不再在提示词固定文字清单里，但我读到的旧文字没有会被认成敏感信息的数字，未发现这次改文字会造成旧的已发内容遮盖变化。

2. 同一段文字会不会在不同请求里变成不同字节？
   - 本轮新增的输出字段是确定性的：搜索排序由分数和 turn id 决定，分页、`#fitted`、`truncated` 都由输入和历史决定；`day` 由固定日期和配置时区算出；`time` 是历史里的 `committedAt`，不是当前时间；`conversationIds` 只在内部使用、不会序列化进结果。
   - 没有新增依赖前后文的遮盖，也没有新增无序集合进入模型内容。外部内容标记只影响授权事实，不改变请求字节。
   - 需要说明的前提：如果时区配置或 `memory.toolResultShare` 在两次请求之间变化，输出会变；这是配置变化，不是同一配置下的不确定性。

3. 改动有没有对应的自动检查，反向用例是否真的会失败？
   - 工具顺序/定义：`production-runtime-tools.unit.test.ts:2110-2124` 检查完整列表哈希，并检查去掉最后两个对话工具后的哈希等于 main；反向会锁住“原有工具定义和顺序不变”。
   - 分页：`conversation-turns.test.ts:779-829` 用 60 字预算检查每页正文 ≤60、长行截断、拥挤轮次 `truncated` 且丢掉了后面的行、`nextPage` 连续。退回旧实现（省略号不在预算内、无轮级截断）这条会失败。但它只量正文，不量整个工具结果，见意见 1。
   - 外部内容标记：`production-runtime-tools.unit.test.ts:1573-1613` 有“无外部内容不 mark / 有外部内容 mark 一次 / 空 id 不 mark”的正反用例，标记无条件调用会失败；但边界是桩，见意见 4。
   - 想一想只读工具集：测试是精确集合，文档也更新了；如果代码多出或少了工具会失败。
   - `conversation_open` 方向提示：只有提示词清单哈希和编译期使用关系，没有行为测试证明模型能正确理解 `earlierFrom + earlier`、`laterFrom + later`；这属于文档型改动，无法用现有测试反向验证。提示词哈希的精确值我未重算，标“未核实”。

4. 改动产生或修改的每个值，使用它的地方都能接受吗？
   - `ConversationToolResult.conversationIds`：产生于 `production-conversation-tools.ts:253,283,297`，唯一生产使用端是 `production-runtime-tools.ts:854-863`；类型定义和所有测试桩都已补 `conversationIds`。接受。
   - `RECALLED_EXTERNAL_CONVERSATION_ORIGIN = "recalled_external_conversation"`：写入 `mark`，由 `read`/`readThread`/`originsOf` 读回，最后会进入 `externalContentSourceRefs` 和授权事实。没有 origin 白名单或枚举校验，长度 30 小于 256 和 512 限制，接受。
   - 搜索输出的 `truncated`（行级和轮级）：只序列化给模型，没有后端 schema 校验；测试和工具描述都能接受。
   - 提示词 `tools.conversation-open` 新文字和 manifest：`prompt-manifest.json:1020-1025` 已更新同一个 id 的哈希和原因；但精确哈希值我没重算，标“未核实”。
   - 合并带入的 `RuntimeToolResultRecallDescriptor`、`RUNTIME_CONTEXT_EXECUTOR = "runtime_context"`、`TOOL_RESULT_RECALL_CAPABILITY_REF = "context.tool_result_recall"`、`targetType: "conversation-context"`：描述符、动作表、`BUILTIN_PREFLIGHT`、preflight 判断和 Pi 适配器里的 `TOOL_RESULT_RECALL_TOOL_NAME = "tool_result_recall"` 两边一致；`executor` 类型就是 `string`，没有额外枚举需要同步。接受。
   - `externalContent` 的 `Pick` 新增 `readThread`：生产入口 `service-main.ts` 传的是真实 `ContextExternalContent`，有这个方法；只有“没有配置 conversations”的测试桩缺少，不影响该路径。接受。
   - 合并后工具拼接值：`offered` 先过滤，再把 `tool_result_recall` 和两个对话工具追加；`everyToolOptions` 的期望列表和 main 的哈希常量都从 `ca741...` 改成“含 recall、去掉对话工具”的哈希，两端接受。
