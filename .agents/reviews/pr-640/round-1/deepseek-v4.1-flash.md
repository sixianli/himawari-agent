**复核范围与限制**：本次只读了代码和文档，没有运行测试，也没有运行除 git 读命令之外的任何命令。以下结论都来自逐行核对；对依赖运行/部署场景的部分已标为“推测”。

### 1. 高 — “记忆变化”永远和最初那份完整快照比较，导致改动每轮重复，回退或删除后模型仍停在旧值

文件：`packages/runtime-pi/src/memory-snapshot-block.ts:55-85`、`:111-131`、`:144-146`

问题：`previousMemorySnapshot` 只认 `memory-snapshot` 内容（自定义消息也只认 `himawari.memory-snapshot`），不认上一轮发出的 `memory-changes`；`splitMemorySnapshot` 于是总拿当前快照和“历史里最早那份完整快照”比，而不是和模型最后看到的状态比。

已读代码证实的后果：
- 记忆从 A1 改成 A2 后，下一轮当前仍是 A2，`memoryChanges(previous=A1, current=A2)` 仍非空，会再次发“改为 A2”；只要没压缩/补发完整快照，就每轮重复。
- A1→A2 后又改回 A1：当前等于最初快照，`memoryChanges` 返回 `undefined`，模型最后看到的是“改为 A2”，却收不到“改回 A1”，于是继续相信 A2。
- A1→A2 后 A2 被删：比较对象是 A1，发出的“已不再有效”带的是 A1 的旧文本，模型最后看到的 A2 没有被明确作废。

证据：
```ts
const previous = previousMemorySnapshot(projection.nativeHistory?.messages ?? []);
if (previous === undefined) return { blocks, snapshot: current, changes: undefined };
const changed = memoryChanges(previous, current.content);
```
```ts
if (message["role"] === "custom" &&
    message["customType"] === MEMORY_SNAPSHOT_MESSAGE_TYPE &&
    typeof message["content"] === "string") { ... }
```
```ts
const reportRemovals = !hasOmissions(current);
...
else if (old && !now && reportRemovals)
```
设计规格也要求“记忆变化”只描述状态变化且没有变化就不出现（`docs/execution/specs/2026-11-24-memory-redesign-design.md:98-99`），当前实现不满足“相对上次已告知状态”的语义。

建议：保存/重建“最后一次已告知的完整状态”作为 diff 基线（例如每轮把当前状态作为不展示的持久状态消息/键值保存，或把已发出的 changes 应用回基线），再和当前快照比；补一个“同一改动只发一次、回退、改后删除”的反向用例。

### 2. 中高 — 只要有任意一类“因篇幅没有列出”，全部真实失效都被吞掉

文件：`packages/runtime-pi/src/memory-snapshot-block.ts:107-114`、`:128-129`

问题：`reportRemovals = !hasOmissions(current)` 是全局开关。只要当前快照任何一类出现省略行，所有类的真实删除/过期/取代都不会告诉模型，模型会继续相信这些记忆有效——而这正是规格说“只有记忆变化能告诉她已作废”要解决的问题。

证据：
```ts
function hasOmissions(snapshot: string): boolean {
  return OMITTED_TAIL !== undefined && snapshot.includes(OMITTED_TAIL);
}
...
const reportRemovals = !hasOmissions(current);
```
测试 `packages/runtime-pi/test/memory-snapshot-block.unit.test.ts:96-108` 只验证“省略时不报失效”，没有验证“另一类完整展示的条目真实删除时仍要报”。

建议：按类别判断——只有“旧条目所在类别在当前快照里也有省略”时才抑制该条目的失效；当前完整展示的类别必须照常报失效。同时把 `hasOmissions` 从子串判断改成按行/按类别解析，避免正文误命中。

### 3. 中 — 旧对话 span 的统计范围比 `conversation_search` 宽，会包含搜不到的线程

文件：`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:344-351`（新增 span）与 `:29-34`、`:387-394`（既有 search/listUnembedded）

问题：`span` 只按 owner/agent/classification 统计；既有的 `search` 和 `listUnembedded` 都额外要求线程 `status = 'open'` 且 `origin = 'owner'`。被回收的对话、非 owner 来源的子线程仍留在 `conversation_turns` 里，会被 span 计入，但模型用 `conversation_search` 搜不到。提示词却写“旧对话……都能用 conversation_search 搜当时的原话”（`packages/prompt-catalog/src/memory.ts` 的 `MEMORY_SNAPSHOT_CONVERSATIONS`）。

证据：
```sql
FROM conversation_turns
WHERE owner_id = @ownerId AND agent_id = @agentId
  AND classification IN (SELECT value FROM json_each(@allowed))
GROUP BY month ORDER BY month
```
```sql
AND EXISTS (SELECT 1 FROM threads t WHERE t.id = c.thread_id AND t.status = 'open'
  AND t.origin = 'owner')
```
测试 `test/integration/conversation-turns.test.ts:678-704` 只覆盖同 owner/agent 与 public 过滤，没有覆盖回收线程或非 owner 来源。

建议：`span` 复用与 `search` 完全相同的 `EXISTS threads ... status='open' AND origin='owner'` 条件，并补一个“回收线程/子线程不计入”的反向用例。

### 4. 中 — 快照预算只约束记忆行，实际快照总长度没有上限

文件：`packages/application/src/services/owner-profile-service.ts:514-527`、`:528-568`；`apps/agent-service/src/production-conversation-tools.ts:80-83`

问题：`remaining` 只扣 `entry.line.length + 1`；随后拼接的清单标题、每个类别标题、`你还能查到的`、旧对话 span（月份列表可随历史增长）、以及所有省略行都不计入预算。ADR 0286 第 6 条和设计规格写的是“开头快照不超过窗口 10%”，代码做不到这个上限；小窗口下 `toolResultCharacters` 还有 `MINIMUM_PAGE_CHARACTERS = 2000` 下限，可能直接超过 10%。

证据：
```ts
let remaining = limit;
for (const entry of [...lines].sort(...)) {
  if (entry.line.length + 1 > remaining) continue;
  remaining -= entry.line.length + 1;
  kept.add(entry.memory.id);
}
```
```ts
const text = [
  MEMORY_SNAPSHOT_HEADER.text,
  ...body,
  MEMORY_SNAPSHOT_REACHABLE_HEADER.text,
  MEMORY_SNAPSHOT_REACHABLE_DETAILS.text,
  ...(span ? [renderPrompt(MEMORY_SNAPSHOT_CONVERSATIONS, {...})] : []),
  ...omitted,
].join("\n");
```
另外 `continue` 会跳过放不下的高优先级长条目，继续保留后面较短的低优先级条目，这与“按重要程度保留”的表述也不完全一致。

建议：把标题、类别行、span、省略行都计入同一个预算；span 的月份列表设上限或汇总；`continue` 改为按优先级截断（或明确这是“装箱”而不是“按优先级”）；补一个断言整体快照长度不超过预算的用例。

### 5. 中 — 读取校验不再接受旧 envelope 的 `owner-profile`，在途/重跑 run 可能直接失败

文件：`packages/application/src/services/context-formation-service.ts:150`、`:547`、`:816-822`；`packages/application/src/services/context-projection-service.ts:266`、`:772-778`

问题：两个 `context.v1` 校验器都把 `owner-profile` 从允许列表删掉了。`ContextFormationService.form` 每次先 `readExistingEnvelope`，如果该 run 在本 PR 部署前已经形成过 envelope，重试/重跑时会读到旧的 `owner-profile`，随后校验失败。

已读代码证实：校验器只允许 `memory-snapshot`；`form` 会复用已存在的 envelope 并走同一校验。
推测：只有部署时存在“已形成 envelope 且会被重放”的 run 才会触发；如果部署流程保证没有在途/可重放 run，则实际影响小。

建议：读取校验保留对旧 `owner-profile` 的兼容（可标记 deprecated），只阻止新写入；补一个“旧 envelope 可重放”的集成用例。

### 6. 中低 — 快照块的数据分类没有把旧对话 span 的分类算进去，可能把私有/敏感对话的日期标成较低级别

文件：`packages/application/src/services/owner-profile-service.ts:447-449`、`:505-512`、`:569-572`、`:582-585`；`packages/memory-engine/src/conversation-turns.ts:240-242`

问题：`#snapshot` 用 span 生成“旧对话：从…到…”文本，但 `#block` 的分类只由 `snapshot.memories`（保留下来的记忆）计算，span 来自 `conversation_turns`，这些 turn 的分类至少被抬到 `private`。当没有记忆或只有 public 记忆时，块可能被标成 `public`，内容却包含 private/sensitive 对话的日期与数量。

证据：
```ts
const snapshot = await this.#snapshot(input, listed, ceiling);
if (snapshot)
  blocks.push(await this.#block(input, "memory-snapshot", snapshot.text, snapshot.memories));
```
```ts
const dataClassification = highestClassification(
  floor ?? "public",
  memories.map(({ dataClassification }) => dataClassification),
);
```
```ts
const dataClassification: DataClassification = visible
  ? highestClassification("private", classifications)
  : "restricted";
```
推测：实际是否造成越权取决于这个块的 `dataClassification` 后续是否被用于访问控制/导出；至少分类标注是错误的。

建议：把 span 所覆盖对话的最高分类作为块的最低分类传入 `#block`，或让 span 只统计与块分类相容的数据并在代码里写明原因。

### 7. 中低 — 每轮都读取/解密全部活动记忆，且新增对 `numbers` 的硬依赖；任一失败整轮请求失败

文件：`packages/application/src/services/owner-profile-service.ts:477-504`、`:232-239`；`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1082-1092`

问题：`listActive` 没有条数上限，`#snapshot` 在裁剪预算之前对每条非规则记忆调用 `readText`（生产实现还会解密 payload），然后才按预算丢弃。记忆很多时，即使最终只保留几行，也要付出全量读取/解密成本。此外 `state.numbers` 是新增强依赖，查询失败会让 `compose` 直接抛错，整轮模型请求失败；旧路径没有这个依赖。

证据：
```ts
for (const memory of listed) {
  const number = numbers.get(memory.id);
  if (number === undefined) continue;
  const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
  if (!text) continue;
  lines.push({ memory, number, section: snapshotSection(memory), line: ... });
}
```
```ts
`${memorySelect} WHERE owner_id = ? AND agent_id = ? AND status = 'active'
 ORDER BY id`
```
规格明确“不设条数上限”（ADR 0286 第 6 条），所以这是随记忆规模线性增长的成本/失败面。

建议：先按重要度/更新时间/使用次数做元数据级排序并只读取可能进入预算的条目（分批读取直到预算用完）；`numbers` 查询失败时降级为不带编号或跳过清单而不是让整轮失败，并记录诊断。

### 8. 低 — 清单解析依赖固定字符串，记忆正文可与之碰撞，导致错误的“变化”判断

文件：`packages/runtime-pi/src/memory-snapshot-block.ts:42-52`、`:87-100`、`:103-108`

问题：`snapshotIn` 用 `lastIndexOf(marker)`、`indexOf("\n你还能查到的：\n")` 和“下一个不以 `- ` 开头的行”来切快照；`entries` 用整行相等判断标题；`hasOmissions` 用正文子串判断。记忆正文虽然做了空白归一化，但来自主人/外部内容，仍可能包含这些固定字符串。例如某条记忆正文结尾正好是快照标记，`lastIndexOf` 会从该记忆内部开始截取，丢掉前面的条目；正文含“你还能查到的：”会让 `entries` 提前结束；正文含省略尾句会让 `hasOmissions` 误真。

证据：
```ts
const start = text.lastIndexOf(marker);
...
const reachable = content.indexOf(endHeader);
...
const stop = after.search(/\n(?!- )/u);
```
```ts
if (line === MEMORY_SNAPSHOT_REACHABLE_HEADER.text) break;
...
const match = /^(\d+)/u.exec(line);
```
建议：解析时只认“行首标记”，并校验标记是独立一行（前后都是换行）；省略信息改成结构化的机器可读行或单独字段；补一条正文包含标记/标题/省略尾句的反向用例。

### 9. 低 — 所有记忆被删且没有旧对话 span 时，模型完全收不到“已删除”

文件：`packages/application/src/services/owner-profile-service.ts:513`；`packages/runtime-pi/src/memory-snapshot-block.ts:143`

问题：`#snapshot` 在 `lines.length === 0 && !span` 时返回 `undefined`；随后 `splitMemorySnapshot` 看不到当前快照，直接返回 `changes: undefined`。如果此前历史里有一份完整快照，而主人把记忆全部删光、且 `conversation_turns` 没有可统计的对话（例如索引关闭），模型会一直使用旧快照，没有“已不再有效”的说明。

证据：
```ts
if (lines.length === 0 && !span) return undefined;
```
```ts
if (!current) return { blocks, snapshot: undefined, changes: undefined };
```
建议：即使当前清单为空，只要历史里存在旧快照，也要生成一个只含删除/失效信息的 `memory-changes` 块（或一个空清单加删除说明）。

### 10. 低 — 自动检查覆盖了主路径，但关键反向场景和 adapter 接线没有用例

文件：`packages/runtime-pi/test/memory-snapshot-block.unit.test.ts:58-70`、`:96-108`；`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:1707-1774`；`test/integration/conversation-turns.test.ts:678-704`；`packages/application/test/owner-profile-service.unit.test.ts:432-463`

已核实已有：首次发送、相同清单不重发、忽略 reachable 变化、压缩后补发及“已补发不再补”、省略不报失效、编号后空格、预算省略行、span 的 owner/agent/public 过滤。

缺口（这些反向用例目前不会失败）：
- 没有“同一改动只发一次”“改动后回退”“改动后再删除”的用例，因此第 1 条不会被现有测试抓到。
- 省略用例只验证“全部不报”，没有验证“另一类完整展示的真实删除仍要报”，第 2 条不会被抓到。
- adapter 层只有运行环境压缩补发用例，没有快照补发的接线用例；`branchSummary` 路径也没有用例。
- `span` 没有跨月 SQL、回收线程/非 owner 来源线程的用例。
- 预算用例没有断言快照整体长度上限，只断言省略行存在。
- 持久化旧 `owner-profile` envelope 的重放没有用例。

建议：按上述每条补一个能失败的 REVERSE 用例，尤其是第 1、2 条。

### 11. 低 — 规则/设计文档与当前实现不一致

文件：`docs/agent-rulebook-inventory.md:82`、`:153-155`；`docs/execution/specs/2026-11-24-memory-redesign-design.md:82`、`:97-101`

已核实的不一致：
- 规则清单 H-13 仍写“待确认的记忆不进主人档案”，但现在待确认记忆会进入 `memory-snapshot` 的“待确认”类别。
- M-3 仍写“规则和档案共用 2000 字预算”，但 `compose` 已不再产出主人档案块，改用快照预算。
- 设计规格写“记忆变化只写别处的改动，她在这场对话里亲手改的不再重复”，代码没有区分来源，会把她自己通过工具改的也报出来（第 1 步/只读阶段暂不可见，但第 3 步会变成问题）。
- 设计规格写旧对话“共多少场、每月多少场”，代码统计的是“有对话的天数”；规格还要求“你还能查到的”列出主题页名字，代码没有（主题页可能属于后续步骤，需在文档里写明）。
- 规格写放不下时保留“常提到、最近用过的”，代码按 `importancePermille`、`updatedAt`、编号排序，并不使用 `use_count`/`last_used_at`。

建议：在 PR 里同步更新规则清单与设计规格，或明确写出本步的偏差和原因；文档若继续作为验收依据，会让复核者按旧规则判错。

**侧重检查**

- 错误路径：`numbers` 失败会让整轮 `compose` 失败（第 7 条）；压缩补发失败会 `session.abort()`（与既有运行环境模式一致，未新增特殊处理）；全部记忆删除且无 span 时删除信息丢失（第 9 条）。
- 不可信/不合规输入：记忆正文做了空白归一化，但解析仍用固定字符串和整行相等（第 8 条）；span 的 SQL 全部走参数/`json_each`，没有发现注入问题；编号查询有 10000 条/批的上限，服务端也拒绝超过 10000 的查询。
- 安全：没有发现新的外部内容进入系统提示或工具定义的路径；清单内容只进最后一条消息。发现 span 统计范围比搜索宽（第 3 条）和块分类未计 span（第 6 条）两处隐私/分类问题。
- 资源耗尽：全量读取/解密活动记忆、span 月份列表无上限、预算只算记忆行（第 4、7 条）；“记忆变化”重复发送会持续放大历史 token（第 1 条）。
- 不可撤销操作：本改动没有写记忆/删记忆等不可逆动作；新增的压缩补发只是追加自定义消息。
- 规则文件与代码：`prompt-prefix.md` 的“只追加、会变的值在最后一条消息、系统提示按对话冻结”与代码一致；文档清单和设计规格存在过期表述（第 11 条）。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 对模型已经见过的系统提示、工具定义和旧历史：没有改动。快照和变化都通过 `turnPrompt` 拼进最后一条用户消息（`packages/runtime-pi/src/pi-runtime-adapter.ts:660-678`）；首次附快照、之后只附变化（`memory-snapshot-block.ts:144-146`）。`chat.ts` identity 的改动确实按对话冻结：`ThreadPromptBundleService.#current` 在 identity 未变且工具可用时直接返回已有 bundle，`promptBundleChange` 不比较候选系统提示文字（`packages/application/src/services/thread-prompt-bundle-service.ts:81-94`、`:190-207`），所以老对话不变，只有新对话或按规则换新时使用新提示。唯一不符合“只追加”语义的是旧 envelope 校验兼容问题（第 5 条），但那是失败路径而不是改写开头。
2. **同一段文字会不会在不同请求里变成不同字节？** 同一状态下没有发现：快照按重要度/更新时间/编号排序，类别内按编号，span 月份按月份排序，记忆编号是持久且不复用的，输出是确定的。快照里的 span 会随新对话天数变化，但它不参与变化 diff，且完整快照只在首次/压缩后发送；问题不是“同文字不同字节”，而是“同一改动被重复发送多次”和正文可碰撞固定标记（第 1、8 条）。
3. **有没有自动检查，反向用例真的会失败吗？** 主路径有检查（首次发送、相同清单不重发、忽略 reachable、压缩补发、省略抑制、编号空格、预算省略、span 基础过滤、prompt manifest、prompt-prefix 只追加）。但第 1、2 条的核心错误没有反向用例，adapter 层快照补发、branchSummary、跨月/回收线程 span、整体预算上限也都没有能失败的用例（第 10 条）。
4. **每个新值的使用方都能接受吗？** `memory-snapshot` 被 context formation/projection 校验器、runtime marker、决策记录和测试接受；`memory-changes` 只在 runtime 生成，不写入 envelope，但 envelope 校验器不接受它（当前不持久化所以没爆，若将来持久化会失败）；`conversationTurn.span` 的 port/sqlite/durable 两端已接上；`snapshotCharacterBudget` 从 `service-main` 经 `production-run-composition` 传入主运行，但其他 `compose` 调用方仍用默认 100000（第 4、7 条）。最明确的两端不一致是旧 `owner-profile` envelope 仍可能被重放、但读取校验已不接受（第 5 条），以及 span 与 `conversation_search` 的过滤条件不一致（第 3 条）。
