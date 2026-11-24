**复核范围**：基于 `b84767c40ec8cd471fdd87fc11c1ac1d68c8f39a`，对照基准 `ed3f8d0df0673935f6d6c92160b51e1d9449c943` 的 diff，以及相关调用方、存储层和规则文件。未运行测试（本环境只能读代码和 git），涉及“测试会不会过”的结论按源码判断。

**侧重检查**

- 错误路径：`conversation_search/open` 的输入错误都在 `apps/agent-service/src/production-conversation-tools.ts:102-118,154-183,236-248` 收敛为 `ConversationToolInputError`；`production-runtime-tools.ts:847-856` 只把这个类映射为 `CONVERSATION_INPUT_INVALID`，其他异常映射为 `CONVERSATION_UNAVAILABLE`，不直接外露错误消息。发现一处例外：语义检索失败在 `packages/memory-engine/src/conversation-turns.ts:333-343` 被吞掉，工具仍可能返回“没找到”（见意见 5）。
- 不可信/不合规输入：多余键、空 query、日期格式、日历中不存在的日期、`from > to`、`page` 越界、`sequence` 非正整数、`direction` 非枚举、空 `conversationId` 都有校验；`conversationId` 最终落到 `threads.read(ownerId, agentId, threadId)`，按 owner/agent 隔离；`thread_messages` 中的 restricted 不返回。未发现跨 owner/agent 读取。
- 删除跟随：搜索在 SQL 层要求 `t.status = 'open' AND t.origin = 'owner'`（`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:28-33`）；打开原话要求线程状态为 active/archived 且拒绝 `origin = 'think'`（`packages/memory-engine/src/conversation-turns.ts:381-383`）。仓库已有 PR 614 的 trash/restore/deletion/think 用例覆盖这部分。
- 资源耗尽：每个结果页有字符预算，但预算只在“加入下一轮”前检查，单个多行轮次可能整轮塞进一页并超出预算（见意见 3）；`SEARCHED_TURNS = 60` 且 `ConversationTurnService.search` 会为 60 个命中都读取正文并解密（`conversation-turns.ts:363-368`），搜索调用本身较重；配置允许 `toolResultShare` 到 0.5（见意见 6）。
- 不可撤销操作：两个工具是纯读，不写数据库；调用重放由 `deduplication: "run_and_tool_call"` 和 `#ownerScopedOnce` 的结果缓存兜住。
- 规则/文档一致性：ADR 0286 与记忆重设计文档写“工具一次返回不超过窗口 2%”，代码是 `max(2000, floor(contextWindow × share))` 且配置允许 0.5；`docs/architecture-v0.1.md:437` 列出的 think 只读工具没有新工具；`thread-execution-state.ts` 的只读工具名单也没有新工具；`speaker` 固定中文标签没有进提示词目录。见意见 1、6、7、8。

---

### 1. 中：think 后台运行会自动多出两个对话工具，和文档/测试里的只读工具集不一致（已读代码证实）

文件：`apps/agent-service/src/production-tool-actions.ts:262-272`、`packages/application/src/services/tool-action-registry.ts:88-93`、`apps/agent-service/src/service-main.ts:1786-1789`、`docs/architecture-v0.1.md:437`

问题：两个新行登记成 builtin + `authorization: "read"`，`readOnlyRow()` 会返回 true；think 运行的 `readOnlyRun` 也返回 true，因此同一套 `ProductionRuntimeTools` 会把 `conversation_search` / `conversation_open` 提供给后台 think 运行。架构文档仍写 think 只拿 `web_search、web_fetch、recall、reminder_list、rule_list、perception_read`。现有测试用 `arrayContaining`，新增工具不会让它失败。

证据：

```ts
// production-tool-actions.ts
...READ_DEFAULTS,
tool: "conversation_search",
...
authorization: "read",
executor: "owner_scoped",
```

```ts
// tool-action-registry.ts
export function readOnlyRow(row: ToolActionRow): boolean {
  return (
    row.actionKind === "READ" &&
    row.sideEffect === "none" &&
    READ_ONLY_FAMILIES.includes(row.family)
  );
}
```

```ts
// service-main.ts
readOnlyRun: async (runId) => {
  const source = await runSources.read(runId);
  return source === undefined || isThinkRunSource(source);
},
```

```ts
// docs/architecture-v0.1.md:437
...只给 actionKind 为 READ、sideEffect 为 none、属于 builtin 或 web 的工具（现在是 web_search、web_fetch、recall、reminder_list、rule_list、perception_read）。
```

```ts
// think-run-pieces.unit.test.ts:33-35
expect(readOnly).toEqual(
  expect.arrayContaining(["web_search", "web_fetch", "recall", "reminder_list"]),
);
```

建议：先明确产品意图。若 think 不应读主人历史，就在只读工具筛选里按 `targetType === "owner-conversation"` 排除，或不要把 `conversations` 传给 think 运行；若有意开放，更新 `docs/architecture-v0.1.md`，并把测试从 `arrayContaining` 改成精确集合，让以后新增只读工具必须显式决定是否给 think。

### 2. 中（推测，需安全负责人确认）：旧对话原文被当作 owner_data 返回，没有把外部内容出处记到当前 run/thread

文件：`apps/agent-service/src/production-runtime-tools.ts:832-857`、`apps/agent-service/src/production-runtime-tools.ts:807-822`、`apps/agent-service/src/context-external-content.ts:161-169,193-205`、`apps/agent-service/src/production-tool-actions.ts:269-272`

问题：recall 在结果来自外部记录时会调用 `externalContent.mark(..., RECALLED_EXTERNAL_RECORD_ORIGIN)`，但 `#conversation` 没有任何标记；两个新行又写 `resultOrigin: "owner_data"`。外部内容标记按“当前线程 + 当前 run”保存。若过去某个对话曾读过网页/邮件，现在通过 `conversation_search/open` 重新读到那段文字，当前 run/线程不会因此被视为“读过外来内容”，后续需要“读过外来内容后先问”的操作可能不会被拦。我没有找到 `thread_messages` 会原样保存外部工具结果的直接证据，因此这是推测；但 agent 回复或主人转述的外部内容也可能进入历史，风险存在。

证据：

```ts
// recall 会标记
const { output, contentClassification, externalContent } =
  await recall.recallWithClassification(call);
if (externalContent)
  await this.#options.externalContent?.mark(
    call.runId,
    RECALLED_EXTERNAL_RECORD_ORIGIN,
  );
```

```ts
// conversation 只返回 output/classification
const { output, contentClassification } = await conversations.run(call);
return { value: output, contentClassification };
```

```ts
// 标记按当前线程/run 存
async #scopes(runId: RunId): Promise<readonly ExternalContentScope[]> {
  const threadId = (await this.#source.read(runId))?.threadId ?? null;
  return threadId
    ? [{ threadId, runId }, { threadId: null, runId }]
    : [{ threadId: null, runId }];
}
```

建议：给对话轮索引记录“这段原话是否带外部出处”，搜索/打开时把命中的外部出处映射到当前 run 的标记；或至少在产品规则里明确“旧对话历史一律按 owner_data 处理”，并新增一条安全用例说明这是有意取舍。否则建议在打开/搜索返回外部出处命中时保守地标记，让现有授权门继续生效。

### 3. 中：搜索分页的字符预算不是硬上限，单个多行轮次和截断省略号都会让一页超出预算（已读代码证实）

文件：`apps/agent-service/src/production-conversation-tools.ts:196-211`、`apps/agent-service/src/production-conversation-tools.ts:113-118`、`test/integration/conversation-turns.test.ts:779-808`

问题：循环只在 `current.length > 0` 时才因为下一轮超预算而换页；如果当前轮本身很大，或它是本页第一个命中，就整轮加入，页大小没有上限。另外 `clipped()` 截断时在 `maximum` 个字符后追加 `…`，所以单行在“刚好超限”时会变成 `maximum + 1` 个字符。测试自己把 60 字符预算下单行断言为 61 个字符，却没有断言整页总长度不超过 60。

证据：

```ts
// production-conversation-tools.ts:201-210
const lines = hit.lines.map((line) => this.#line(line, lineLimit));
const size = lines.reduce((total, line) => total + line.text.length, 0);
if (current.length > 0 && used + size > budget) {
  pages.push(current);
  current = [];
  used = 0;
}
current.push({ turn: hit, lines });
used += size;
```

```ts
// production-conversation-tools.ts:113-118
const characters = [...text];
return characters.length <= maximum
  ? { text, truncated: false }
  : { text: `${characters.slice(0, maximum).join("")}…`, truncated: true };
```

```ts
// conversation-turns.test.ts:806
expect([...(long?.text ?? "")].length).toBe(61);
```

建议：分页时按“剩余预算”裁剪当前轮/当前行，或允许一轮跨页；至少让每页总长度有硬上限（例如 `Math.min` 到剩余预算，或把超长轮拆成多页）。测试里增加“页总长度 ≤ budget”的断言，并把 61 这种边界写清楚；同时把 `clipped()` 的省略号计入预算。

### 4. 中：`conversation_open` 的提示没有说明 `earlierFrom` 必须继续用 `direction: "earlier"`，且结果总是同时给两个方向指针，模型容易翻错方向（已读代码证实）

文件：`packages/prompt-catalog/src/tools.ts:54`、`apps/agent-service/src/production-conversation-tools.ts:263-275`

问题：工具描述只说“一次读不完时结果里给出 earlierFrom 或 laterFrom，把它填进 sequence 接着读”，没有说 `earlierFrom` 还要配 `direction: "earlier"`。但代码里不填 direction 默认是 `later`（`production-conversation-tools.ts:240`），模型把 `earlierFrom` 填进 sequence 后会从该位置往后读，正好读反。并且 `window` 在两个方向都会返回两个指针，不一定“只在读不完时”出现。

证据：

```ts
// tools.ts:54
text: "打开以前的一段对话，读某个位置前后的原话。conversationId 和 sequence 取自 conversation_search 的结果；direction 填 later 从 sequence 往后读，填 earlier 从 sequence 往前读，不填就往后读。一次读不完时结果里给出 earlierFrom 或 laterFrom，把它填进 sequence 接着读。",
```

```ts
// production-conversation-tools.ts:264-270
output: {
  conversationId,
  found: true,
  lines: opened.lines.map((line) => this.#line(line, budget)),
  earlierFrom: opened.earlierFrom,
  laterFrom: opened.laterFrom,
},
```

建议：把提示改成明确的两种续读方式，例如“用 `earlierFrom` 时同时填 `direction: "earlier"`；用 `laterFrom` 时填 `direction: "later"`”，或直接给两个续读参数对象；只在确实还有内容时返回对应指针，减少模型误用。

### 5. 低：语义检索失败被静默吞掉，工具仍报“没有找到”，和“其他错误变成 CONVERSATION_UNAVAILABLE”的说法不完全一致（已读代码证实）

文件：`packages/memory-engine/src/conversation-turns.ts:333-343`、`apps/agent-service/src/production-conversation-tools.ts:185-195,218-231`、`apps/agent-service/src/production-runtime-tools.ts:847-856`

问题：`ConversationTurnService.search` 在 `embedQuery` 失败时只调用 `onEmbeddingFailure`，然后继续做字词检索；`ProductionConversationTools` 无法区分“确实没有相关旧对话”和“语义检索坏了”。如果查询靠语义而字词检索没有命中，工具会返回 `note: "没有找到相关的旧对话..."`，模型就可能如实告诉主人“以前没聊过”。这与作者说法“其他错误一律 CONVERSATION_UNAVAILABLE”不一致。

证据：

```ts
// conversation-turns.ts:333-343
if (embedder && this.#options.embeddableClassifications.includes("private")) {
  try {
    embedding = { ... vector: await (input.within ?? direct)("private", () => embedder.embedQuery(input.query)) };
  } catch (error) {
    this.#options.onEmbeddingFailure?.(error);
  }
}
```

```ts
// production-conversation-tools.ts:229-231
...(page < pages.length ? { nextPage: page + 1 } : {}),
...(shown.length === 0 ? { note: TOOL_RESULT_CONVERSATION_EMPTY.text } : {}),
```

建议：把“语义检索失败但字词检索成功/为空”作为一个可区分的结果返回，例如在输出里加 `semanticUnavailable: true` 并换一句提示“这次只按字词查过”；或者按作者说法在语义失败时直接报 `CONVERSATION_UNAVAILABLE`。同时补一条查询函数抛错的集成用例。

### 6. 低：`toolResultShare` 允许到 0.5，且 `max(2000, ...)` 下限会在小窗口下超过 ADR/设计文档的“一次不超过窗口 2%”（已读代码证实）

文件：`apps/agent-service/src/production-conversation-tools.ts:78-82`、`packages/platform-node/src/strict-configuration.ts:2098-2103`、`test/integration/conversation-turns.test.ts:866-869`、`docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:51`

问题：ADR 0286 写“工具一次返回不超过 2%”，设计文档也写“一次不超过窗口 2%”；代码的公式是 `max(2000, floor(contextWindow × share))`，配置又允许 `share` 到 0.5。默认 0.02、主模型 100 万上下文时是 20,000 字符，和文档一致；但窗口小于 10 万 token 时 2,000 字符的下限已经超过 2%，`share` 设到 0.5 时会返回窗口的一半。测试还明确把 10,000 窗口算成 2,000（20%）。另外窗口单位是 token，代码用的是字符数，二者没有换算说明。

证据：

```ts
// production-conversation-tools.ts:78-82
export function toolResultCharacters(contextWindow: number | undefined, share: number): number {
  if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
    return MINIMUM_PAGE_CHARACTERS;
  return Math.max(MINIMUM_PAGE_CHARACTERS, Math.floor(contextWindow * share));
}
```

```ts
// startup test
expect(toolResultCharacters(10_000, 0.02)).toBe(2_000);
```

```ts
// strict-configuration.ts:2102-2103
if (toolResultShare !== undefined && (toolResultShare <= 0 || toolResultShare > 0.5))
  throw invalid("configuration.memory.toolResultShare", "must be greater than 0 and at most 0.5");
```

建议：把“2% 是硬上限”落到代码里（例如 `Math.min` 到窗口比例，或把 2,000 下限写成文档中的例外），把 `share` 上限收紧到和 ADR 一致；如果按字符估算 token，至少写成明确的保守换算，并在文档里说明小窗口下限。

### 7. 低：`READ_ONLY_TOOL_NAMES` 没有收录两个新工具，取消/失败中的调用在界面会显示成“未确认”而不是“已停止/失败”（已读代码证实）

文件：`packages/application/src/services/thread-execution-state.ts:19-25,138-144`

问题：这个名单决定运行被取消/失败且沙箱资源已不存在时，只读工具的调用是否能显示为 `stopped`/`failed`。新工具是只读的，但没有加入；正在执行的 `conversation_search/open` 会落到 `unresolved`，给主人显示“结果未确认”。`rule_list`、`perception_read` 也没有在这个名单里，所以要先确认这个名单是不是只服务某类工具；但按“新加只读内置工具和别的只读工具一致”的目标，这里漏了。

证据：

```ts
const READ_ONLY_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "read",
  "recall",
  "reminder_list",
]);
```

```ts
? sandboxResourcesAbsent &&
  READ_ONLY_TOOL_NAMES.has(tool.name) &&
  ["cancelled", "failed"].includes(run.status)
  ? run.status === "cancelled"
    ? "stopped"
    : "failed"
  : "unresolved"
```

建议：确认名单语义后把 `conversation_search`、`conversation_open` 加进去，或者更彻底地改成从工具动作登记表的 `actionKind`/`sideEffect` 推导，避免每加一个只读工具就漏一处；补一条对应的执行状态测试。

### 8. 低（推测）：工具结果里的 `speaker: "主人"/"你"` 是写死在代码里的模型可见文字，不进提示词目录，也不随回答语言变（已读代码证实写法，是否违规需按目录规则确认）

文件：`apps/agent-service/src/production-conversation-tools.ts:143-151`、`apps/agent-service/test/prompt-catalog.unit.test.ts:211-221,247-259`

问题：项目要求模型能看到的固定提示词登记在 `packages/prompt-catalog` 并有摘要；但这里把固定中文标签直接写在工具结果数据里，`prompt-catalog` 的扫描只看 `modelContent:`、`note:`、`text:` 后面的字符串，不会发现它。产品又支持中英日回答语言，英文/日文回答时工具结果仍出现“主人/你”。这不一定违反“提示词”的定义（也可能被当作结构化数据），需要规则负责人确认。

证据：

```ts
return {
  sequence: line.sequence,
  speaker: line.role === "owner" ? "主人" : "你",
  time: line.committedAt,
  text: shown.text,
  ...(shown.truncated ? { truncated: true } : {}),
};
```

建议：若这些标签算模型可见固定文字，就移进 `prompt-catalog` 并登记摘要；或者输出 `role: "owner" | "agent"` 让模型自己理解，标签由提示词层决定，这样也避免多语言不一致。

---

**必答问题**

**1. 会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

- 工具定义层面：原 23 个工具定义的字节和顺序没变，新两个定义确实追加在工具列表末尾；测试用 `descriptors.slice(0, -2)` 的哈希守住前 23 个（`apps/agent-service/test/production-runtime-tools.unit.test.ts:2064-2068`）。这部分作者说法成立。
- 但“只在末尾追加”不能理解为整个请求只追加。工具定义在请求最前面；已有对话的 frozen tool set 名称一旦变化，`promptBundleChange` 会返回 `tool_set_changed`（`packages/application/src/services/thread-prompt-bundle-service.ts:81-94`），系统会换新一次，系统提示和全部历史从工具定义之后都要重算。依据 `prompt-prefix.md` 第 6、7 条，这是一次允许的换新，但作者说法没有指出这次开头变化。对新对话或换新后的对话，前 23 个工具定义逐字节不变，新工具接在后面，之后内容按原顺序排列，没有改写历史。
- 每轮会变的值：新增工具定义里没有当前时间、路径、哈希等；`YYYY-MM-DD` 是固定占位文字，不会被 `VOLATILE_TEXT` 当成日期。对话工具结果作为最新工具结果追加在末尾；返回的 `time` 来自已保存的 `line.committedAt`（`production-conversation-tools.ts:143-151`），`day` 来自已保存的 `turn.startedAt`（`:223-227`），没有使用 `clock.now()`。因此“每轮会变的值都在最后一条消息里”这一点对新增输出成立；遮盖由 ModelEgress 按整段外发请求执行，工具本身不改旧消息。
- 结论：已有对话会因工具集合变化换新一次、请求开头变一次，这是规则允许的代价，但不应说成“整个请求只在末尾追加”；新对话/换新后是追加。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

- 工具输出顺序是确定的：搜索结果先由存储层按 SQL `ORDER BY` 返回（`sqlite-conversation-turn-operations.ts:246,280,292`），融合后按分数和 `turn.id` 排序（`packages/memory-engine/src/conversation-turns.ts:355-366`），分页按固定循环生成；`lines` 按消息 sequence 返回。没有使用对象遍历顺序或无序集合。
- `day`、`time` 来自固定存储值，`window` 的时间和时区来自本次输入/配置，不读当前时钟。`clipped()` 对同样的文本截出同样的字节。
- 未发现新增的“同一段内容因前后文不同而遮成不同字节”的逻辑；出口遮盖仍按 `prompt-prefix.md` 第 11 条执行，属于既有全局机制。
- 唯一会变的是检索结果本身可能随着新对话被索引、向量回填而变化；这是数据变化，不是同一段文字被编码成不同字节。
- 结论：就工具编码本身，没有发现新增的非确定性；`Intl`/时区数据版本变化属于外部依赖，未在本次核实。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- 有：提示词清单/摘要检查、前 23 个工具定义哈希、动作登记表排序测试、只读工具列表测试、输入错误与 `CONVERSATION_UNAVAILABLE` 映射测试、搜索分页/单行截断集成测试、`toolResultShare` 配置范围测试、重放去重测试。
- 反向用例：提示词清单有“改了文字但摘要没更新”的反向用例；输入映射测试同时覆盖 `ConversationToolInputError -> INPUT_INVALID` 和普通异常 `-> UNAVAILABLE`；动作表测试会拦住把工具误登记成 `owner_scope` 或改变只读顺序。
- 不足：分页测试没有断言“整页总字符数 ≤ budget”，反而接受 61 > 60（`conversation-turns.test.ts:806`），所以预算回退不会让它失败；think 只读工具测试用 `arrayContaining`，新增工具不会失败；service-main 里 `pageCharacters = toolResultCharacters(primaryModel.contextWindow, configuration.memory.toolResultShare)` 的接线没有直接装配测试；语义检索失败、外部内容出处、`READ_ONLY_TOOL_NAMES` 都没有反向用例。
- 未核实：提示词清单的 sha256、25 个工具定义总哈希、以及这些测试实际是否通过——本环境只允许读代码和 git，不能运行测试。

**4. 每个新值是否都能被它的使用方接受？**

逐个核对如下：

- `capabilityRef: "conversation.search" / "conversation.open"`：产生于 `production-conversation-tools.ts:25-26`，被工具定义、`PRODUCTION_TOOL_ACTION_ROWS`（`production-tool-actions.ts:264-289`）和 `ToolActionRegistry` 接受；`BUILTIN_PREFLIGHT` 和 `#builtinExecutor` 都认识 `owner-conversation`。成立。
- `targetType: "owner-conversation"`：`ToolActionRow.targetType` 是自由 string；`BUILTIN_PREFLIGHT`（`production-runtime-tools.ts:152`）和 `#builtinExecutor`（`:686-687`）都处理。它是 `authorization: "read"`，不会进入 `owner-scope-authorization` 的 owner_scope 分支，因此不需要额外 target 校验。成立。
- `conversationId`：搜索产生的是 `turn.turn.threadId`（`conversation-turns.ts` 的 `ThreadId`，领域校验最长 128，`packages/domain/src/identifiers.ts:39-47`）；打开端限制 200（`production-conversation-tools.ts:241-247`），再经 owner/agent 范围读取。生产者和消费者相容；模型乱传也只会查不到或输入错误。成立。
- `sequence`：搜索产生 turn 的 `firstSequence`，行里也有 message sequence；数据库 schema 保证 `sequence >= 1`，打开端用 `positiveInteger` 校验安全整数和 ≥1。成立。
- `page` / `nextPage`：搜索总命中最多 60，页数不会超过 60，打开端允许 100；`nextPage` 不会超过 100。成立。
- `earlierFrom` / `laterFrom`：由 `window` 产生 `sequence ± 1`（仍 ≥1），模型填回 `sequence` 时通过 `positiveInteger`。成立；提示歧义见意见 4。
- `memory.toolResultShare`：`strict-configuration.ts:2076-2103` 接受并校验 0 < x ≤ 0.5，类型 `ConfiguredMemoryDescriptor` 加了可选字段，`service-main.ts:1604-1608` 消费。两端都接受；但和 ADR 的 2% 不一致（意见 6），且配置模板/文档没有给出这个键，运维不一定知道怎么用。
- `ConversationLine.dataClassification`：只由 `packages/memory-engine/src/conversation-turns.ts:100-106` 产生，只被新工具用于计算密级（`production-conversation-tools.ts:214-217,271-274`），没有其他实现需要补字段。成立。
- 提示词清单项与摘要：清单项已登记；sha256 是否与源码一致未核实（无法运行 `check:prompt-catalog`）。
- `READ_ONLY_TOOL_NAMES`、`docs/architecture-v0.1.md` 的只读工具列举：这两个使用方目前没有接受新工具，分别对应意见 7 和意见 1。
- 结论：除意见 1、6、7、8 指出的文档/名单/标签问题外，新标识、字段、配置键和序列化格式的两端校验基本对齐；最需要再确认的是 `toolResultShare` 的规则上限和 think 运行的工具范围。
