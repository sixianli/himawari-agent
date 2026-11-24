本轮范围：只看 `2a2692316b378f90d2a172441995cac862f3f14e..6812983ba793634013f278a3a6bc22314d6f0857` 的增量，重点是 PR 620 相关的两个提交 `2ce65386d`、`6812983ba`，文件为 `production-conversation-tools.ts`、`production-runtime-tools.ts`、`service-main.ts`、`packages/prompt-catalog/src/tools.ts`、`prompt-manifest.json` 和对应测试。增量里混入的 main 合并（推送、quiet hours、苹果端文档等）没有整份重读，只在会碰到 PR 620 说法或工具头的地方核对。没有运行测试、没有计算哈希，凡是“测试通过”“哈希正确”“与 PR 614 完全一致”的说法只做了代码核对。

## 侧重检查

- 不受信输入：`onlyKeys`、`query` 去空和长度、`from`/`to` 格式加 `requestedTimeScope`、`page` 1..100、`sequence` 正整数、`direction` 枚举都逐项看过；`direction: null` 现在落在 `args["direction"] === undefined ? "later" : args["direction"]` 后的校验里，会抛 `ConversationToolInputError`（`production-conversation-tools.ts:286-296`）。
- 错误路径：`ConversationToolInputError` 映射成 `CONVERSATION_INPUT_INVALID`，其他一律 `CONVERSATION_UNAVAILABLE`，只输出固定说明，不外露内部错误（`production-runtime-tools.ts:866-875`）。
- 安全与主人范围：工具用配置里的 `ownerId`/`agentId` 调服务；`window` 对不存在、think、trashed 的对话返回 `undefined`（`packages/memory-engine/src/conversation-turns.ts:381-383`）；外发内容只由 ModelEgress 遮盖，工具本身不遮盖；外部内容来源按显示的 `conversationIds` 打标（`production-runtime-tools.ts:856-862`）。
- 资源耗尽：`query` 500、`page` 100、`sequence` 安全整数、搜索命中 60 轮；`#lineWithin` 每次至少把 `maximum` 减 1，且文本被截时通常一轮收敛，没有无界循环；`JSON.stringify` 只作用于已被预算限制的文本。
- 不可撤销操作：两个工具登记为 `READ`、`sideEffect: "none"`、`reversible: true`（`production-tool-actions.ts:266-297`），没有写操作。
- 规则、说明与代码一致性：`conversation-open` 说明已按新行为改写；但作者说法 1 的“原有 23 个工具一字不改”与增量实际不符，见意见 1。

## 上一轮意见复核

- 上轮意见 1（每页上限只算正文）：已改。`jsonLength` 统计整个 `output` 的序列化字符数，搜索先预留 `query/window/page/turns/nextPage` 固定开销，再按每轮、每行计入；打开先预留 `conversationId/found/lines/earlierFrom/laterFrom`。`modelContent` 就是 `JSON.stringify(value)`（`production-runtime-tools.ts:981`），所以预算和模型实际看到的结果一致。序列化账目有 1～2 个字符的保守多算，不会超。
- 上轮意见 3（从最后一条往前打开时 `laterFrom` 非 null）：行为没改，改的是说明。新说明明确“不为 null 时那一头也可能刚好没有更多原话，接着读拿到空的 lines 就说明读完了”（`packages/prompt-catalog/src/tools.ts:54`），与代码一致，可接受。注意改说明只对新对话生效；PR 620 还没上线，目前没有旧对话被冻结成旧说明，所以不构成现实问题。
- 上轮意见 5（`direction: null` 被当缺省 later）：已改，显式 `null` 现在被拒（`production-conversation-tools.ts:288-296`），集成测试也加了这一条（`test/integration/conversation-turns.test.ts:892`）。

## 意见

### 1. 低：作者说法“原有工具定义一字不改、测试里有前 23 个的哈希”与本轮增量不符

文件:行：`apps/agent-service/test/production-runtime-tools.unit.test.ts:2346-2349`、`packages/prompt-catalog/src/tools.ts:297`

问题：增量里有一个既有的工具定义被改了文字——`TOOL_RULE_SET` 现在多了 `her_words` 类别的说明；随后 `6812983ba` 把“两个翻原话工具之前的全部定义”的哈希从 `ca741f…` 改成 `234052ab…`。同时 `EVERY_TOOL_NAMES` 里在 `conversation_search`/`conversation_open` 之前实际有 24 个工具（`read` 到 `tool_result_recall`），不是 23 个。作者说法 1 把这两点说成了“原有工具定义和顺序不变”。

证据（亲自读到）：

```ts
const EVERY_TOOL_DEFINITIONS_SHA256 =
  "dd3f25c219b0fed43fc4dbc160011f7a789496a41d947ce688ab7b2b240431b1";
const TOOL_DEFINITIONS_BEFORE_CONVERSATIONS_SHA256 =
  "234052ab611271e072924607af18b493123a699ea64aa711a4dac54bb4533326";
```

`rule_set` 说明里已出现：

```ts
classes 可选 run_result（任务完成或失败）、mail_reminder（邮件提醒）、her_words（你写给主人、推到手机上的话）、scheduled_reminder（主人自己定的到点提醒）
```

`6812983ba` 的提交说明也写明：main 的 `d7a63abc3` 改了 `TOOL_RULE_SET`，本提交只是把哈希换成 main 的实际值。

建议：把说法改成“PR 620 自己新加的两个工具只在末尾追加；本轮合并 main 后，既有 `rule_set` 说明和 `chat.identity` 系统提示也变了，这来自 main”。如果哈希快照是为了证明“PR 620 本身没改既有工具”，应拿 PR 与 main 的合并基点比较，或把 main 的提示词改动及其哈希更新分开记录；不要用本轮更新过的 `TOOL_DEFINITIONS_BEFORE_CONVERSATIONS_SHA256` 来支撑“既有定义没变”。

### 2. 低：搜索页的固定预留没有包含空结果/越界页的 `note`，当前只靠 `pageCharacters` 下限 2000 才安全

文件:行：`apps/agent-service/src/production-conversation-tools.ts:230-232`、`:276-277`

问题：硬上限的固定预留按下面这个对象算：

```ts
const room =
  budget -
  jsonLength({ query, window, page: MAXIMUM_PAGE, turns: [], nextPage: MAXIMUM_PAGE + 1 });
```

但真正输出空页时会给 `note`，而 `note` 没有算进这个预留：

```ts
...(page < pages.length ? { nextPage: page + 1 } : {}),
...(shown.length === 0 ? { note: TOOL_RESULT_CONVERSATION_EMPTY.text } : {}),
```

`note` 只会在 `turns` 为空时出现，所以没有轮次正文，今天不会超过 `budget`：生产 `toolResultCharacters` 最低返回 2000，固定部分和 note 加起来远小于 2000；测试里 400 的预算也够。但它意味着“整个结果不超过 budget”的证明多依赖一个下限常量，而不是预留本身；如果以后允许把 `pageCharacters` 配到约 700 以下，空结果页就可能越过预算。新增的集成测试只测了有轮次的页，没测 `page 9` 这种空页的 JSON 长度。

建议：把 `note` 也纳入固定预留（按最坏长度预留，或空页时直接按 `note` 长度检查）；或者在 `ProductionConversationTools` 构造时断言 `pageCharacters` 至少能容纳固定部分加 note。测试补一条空页 `JSON.stringify(output).length` 的断言。

## 推测与未核实

- **推测**：`jsonLength` 用的是 `[...JSON.stringify(value)].length`，即 Unicode 码点；`modelContent.length` 对代理对（emoji）会更大。如果“上限”的单位实际是 UTF-16 码元或字节，含星号外字符时可能越过上限。现有代码、测试和提示词规范都按码点理解“字符”，所以我没把它算成错误，只提示单位需要确认。
- **未核实**：`prompt-manifest.json` 里 `tools.conversation-open` 的 `sha256` 是否与新文字逐字节匹配。读到的清单值已更新，作者说跑了 `check:prompt-catalog`，但我不能运行哈希。
- **未核实**：作者说法 4 与 PR 614 完全一致。当前代码确实在 `recallProjection` 之前创建 `conversationTurns`（`service-main.ts:1549-1570`），并用 `recallEmbedWithin` 走 `governedMemory.embedWithin`（`:1571-1595`），失败写到 `conversation-turn.failed`；没有 PR 614 基线，无法逐行比较。
- **未核实**：测试是否真的全绿。`test/integration/conversation-turns.test.ts:779-848` 的断言从代码上看与实现一致，反向用例按旧实现也确实会失败（旧预算只算正文会超过 400；旧 `?? "later"` 不会拒绝 `null`），但我没有运行。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** PR 620 自己只把两个新工具定义追加在工具列表最末尾（`production-runtime-tools.ts:622-627`，测试 `production-runtime-tools.unit.test.ts:1540`）；没有在系统提示、历史或既有工具定义里插入新的每轮变化值。新增工具会让已有对话的工具集合变化，按规则 6 是一次允许的换新。每轮会变的值没有进入头部：搜索结果的 `time` 来自消息的 `committedAt`，`day` 由它和固定时区算出，不是当前时间；工具结果作为末尾追加。**但本轮增量合并了 main**，`chat.identity` 系统提示和 `rule_set` 工具说明确实变了（`packages/prompt-catalog/src/chat.ts:39`、`packages/prompt-catalog/src/tools.ts:297`），所以相对于 `2a26923`，新对话的请求头会不同，旧对话按冻结规则保留旧字节（或因工具集合变化换新一次）。这些是 main 的改动，不是 PR 620 自己加的每轮变化值。
2. **同一段文字会不会在不同请求里变成不同字节？** 没有发现新增的不确定性：输出对象的键顺序固定，`day`/`time` 来自存储值，页码和截断由预算确定性计算，没有当前时间字段，`conversationIds` 只用于内部去重和外部内容打标。遮盖仍由 ModelEgress 对整个请求做，工具不另做遮盖，也没有新增依赖前后文的遮盖。唯一未核实的是服务端检索排序/嵌入本身是否跨请求稳定；这不是本轮增量改的。
3. **有没有对应的自动检查，反向用例会真的失败？** 有。`test/integration/conversation-turns.test.ts:779-848` 对每个搜索页和每个打开页断言 `JSON.stringify(output).length <= 400`，并顺着 `nextPage`/`laterFrom`/`earlierFrom` 走完整段历史，检查不重不漏；`:892` 增加了 `direction: null` 必须报输入错误。按旧代码，正文预算那只算正文会导致该断言超过 400，旧 `?? "later"` 不会拒绝 `null`，所以这两条反向用例逻辑上会失败。哈希快照测试在 `production-runtime-tools.unit.test.ts:2110-2135`。没有自动检查空页 `note` 的预算（见意见 2）。
4. **每个产生/修改的值，使用端都能接受吗？**
   - `earlierFrom`/`laterFrom`：产生端是 `opened.earlierFrom/laterFrom` 或 `first.sequence - 1` / `last.sequence + 1`（`production-conversation-tools.ts:333-334`）；使用端是模型按说明填回 `sequence`，工具再用 `positiveInteger` 校验。截断时 `first.sequence > 1`，所以 `-1` 不会到 0，能通过；服务端 `window` 也接受任意正序列号。
   - `nextPage`：产生端 `page + 1`，页数最多 60（`SEARCHED_TURNS`），使用端 `page` 校验上限 100，能通过。
   - `conversationIds`：产生端是命中的 `threadId`，使用端 `marker.readThread` 要字符串线程号，接受。
   - `pageCharacters`：由 `toolResultCharacters` 产生，配置键 `memory.toolResultShare` 在 `packages/platform-node/src/strict-configuration.ts:2098-2103` 校验 `0 < x <= 0.5`，使用端只当正数预算，接受。
   - `conversation.search`/`conversation.open`：工具动作表已登记（`production-tool-actions.ts:266-297`），`ToolActionRegistry.assertRow` 的只读、可逆、后果、主人范围约束都能通过（`tool-action-registry.ts:66-95`），`preflight` 也能按 `targetType: "owner-conversation"` 找到执行器。
   - `TOOL_CONVERSATION_OPEN` 文字和清单哈希：使用端是工具描述和 `prompt-catalog` 清单校验，清单已同步更新；哈希本身未独立计算。
   - `direction: null`：描述符 schema 的 enum 本来就不含 `null`，工具又显式拒绝，`CONVERSATION_INPUT_INVALID` 说明也提示只能用定义里列出的参数。
   - 增量里 main 带来的 `her_words`：向下查了 `PUSH_QUIET_CLASSES`（`rule-types.ts:47-58`）和 `web-push-gate.ts`，后端接受 `her_words`，没有 I-73 那种“提示词让填、后端不认”的问题。
