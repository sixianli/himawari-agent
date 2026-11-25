**本轮核查范围**
- 增量：`owner-profile-service.ts`、`memory-snapshot-block.ts`、`sqlite-conversation-turn-operations.ts`、`context-projection.ts`、`conversation-turns.ts`、两个 envelope 校验器、生产装配与这几处的单测/集成测试。
- 旧代码跟读：`pi-runtime-adapter.ts` 的 `turnPrompt` 与压缩回调、`thread-prompt-bundle-service.ts` 的冻结逻辑、`memory_open` 与 `memory_numbers`、提示词目录里的清单/变化格式、ADR 0286 与设计文档。
- 未运行测试（工具限制），测试结论均按代码推断；`prompt-manifest.json` 的哈希未逐项重算；Pi 的 `sendCustomMessage` 实际存储形状与 `compaction_end` 时序未在真实 Pi 里核实。

**侧重检查**
- 错误路径：空清单、无旧对话 span、旧 envelope 的 `owner-profile`、压缩后重复补发、重复 snapshot 抛错、变化块被截断，均已对照代码。发现“全部记忆删除且无 span”仍无变化提示（见意见 1）。
- 不可信输入：记忆正文在入清单前已把空白折叠成空格，且解析标记要求行首换行，正文无法伪造清单/变化标记；`owner-message` 里的文字在闭合标记之后，当前单文本块形状下不计入（依赖“单个 text 块”，见“未核实”）。SQL 的 owner/agent/分类均走参数绑定。
- 安全：超出 ceiling 的记忆和受限分类对话被排除；旧对话分类已并入快照块分类（意见 6 已修好）；但变化块分类可能低于其内容（意见 2）。
- 资源：每轮 `compose` 都会重读全部记忆并重放全部历史变化块，见意见 6。
- 不可撤销操作：增量未新增。
- 规则/文档一致性：仍有文档与实现不一致，见意见 4。

### 1. 中低 — 上一轮意见 9 仍未改好：所有记忆删除且没有旧对话 span 时，模型收不到任何“已删除”
文件: `packages/application/src/services/owner-profile-service.ts:528`，`packages/runtime-pi/src/memory-snapshot-block.ts:256`
问题：当 `lines.length === 0 && !span` 时 `#snapshot` 返回 `undefined`，于是投影里没有 `memory-snapshot` 块；`splitMemorySnapshot` 一旦发现没有当前清单就直接返回，不再计算变化。结果是之前见过的记忆被删光、同时旧对话 span 不存在（例如相关线程被清空/回收）时，模型永远停在旧清单上。
证据：
```ts
// owner-profile-service.ts:528
if (lines.length === 0 && !span) return undefined;
// memory-snapshot-block.ts:256-258
if (!current) return { blocks, snapshot: undefined, changes: undefined };
```
建议：即使当前清单为空，只要 `knownMemories` 能重建出旧基线，也应生成变化块（或生成一个只有表头的空清单块）；补一条“删除后无 span”的反向用例。
证据性质：读代码证实；上一轮已报，增量未触及该分支。

### 2. 中低 — “记忆变化”块的分类只取当前清单分类，可能低于其中旧记忆正文的真实分类
文件: `packages/runtime-pi/src/memory-snapshot-block.ts:237`、`:269`
问题：`changesSince` 会把旧基线的 `old.line` 原样写进“已不再有效”，但块的分类只用了 `current.dataClassification`。若一条 sensitive 记忆被删除，而当前清单只剩 private，变化块会带着 sensitive 正文却标成 private。
证据：
```ts
else if (old && !now && !omitted.has(old.section))
  lines.push(renderPrompt(CHAT_MEMORY_CHANGE_REMOVED, { line: old.line }));
...
dataClassification: current.dataClassification,
```
建议：让 `knownMemories` 同时记录每条记忆的分类，变化块取“当前分类 + 所有被报告旧条目的最高分类”；补一条“删除 sensitive 记忆后变化块仍为 sensitive”的测试。
证据性质：分类逻辑读代码证实；当前唯一消费者 `pi-runtime-adapter.ts` 渲染时不读该字段，因此“是否已造成泄漏”属推测，但该值本身确实可能失真。

### 3. 低 — 快照预算仍未覆盖表头/“你还能查到的”/省略行，作者“字数上限”的说法不成立
文件: `packages/application/src/services/owner-profile-service.ts:529-583`
问题：`remaining` 只按记忆行扣减，之后直接拼接表头、可达说明、旧对话范围行和各类省略行。因此实际快照长度约为 `snapshotCharacterBudget + 固定开销`；预算很小时（无 contextWindow 时会退到 2000）总长可以明显超过预算。单测 `snapshotCharacterBudget: 20` 也只检查省略行，没有断言总长度。
证据：
```ts
if (entry.line.length + 1 > remaining) continue;
remaining -= entry.line.length + 1;
...
const text = [
  MEMORY_SNAPSHOT_HEADER.text,
  ...body,
  MEMORY_SNAPSHOT_REACHABLE_HEADER.text,
  MEMORY_SNAPSHOT_REACHABLE_DETAILS.text,
  ...(span ? [...] : []),
  ...omitted,
].join("\n");
```
建议：先把固定开销从预算里扣除，或最后断言 `text.length <= limit` 并据此减少行数；同步修正“快照不超过窗口 10%”的描述。上一轮意见 4 仍未改好。
证据性质：读代码证实。

### 4. 低 — 上一轮意见 11 仍未改好：设计文档与实现仍有可指认的不一致
文件: `docs/execution/specs/2026-11-24-memory-redesign-design.md:101`、`:99`，`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:354-383`，`packages/prompt-catalog/src/memory.ts:410-427`
问题：设计说“旧对话从哪天到哪天、共多少场、每月多少场”，代码和提示词统计的是“有对话的天数”。另外设计说“只写别处的改动；她在这场对话里亲手改的不再重复”，当前实现只是与基线做全量 diff，没有记录改动来源；等写入工具上线后，模型自己本轮改过的记忆下一轮也会再报一次。
证据：
```ts
// 设计文档
③ 旧对话从哪天到哪天、共多少场、每月多少场，都能搜
- **记忆变化**：只写别处的改动...她在这场对话里亲手改的，工具结果里已经有，不再重复
// 实现/提示词
const days = ... count(DISTINCT c.day)
"旧对话：从 ...，共 ... 天有对话（...）"
```
建议：统一“场”与“天”的语义；在设计或代码二选一改。等实时写入上线时，把工具结果里的已改动作并入基线，或在变化块里过滤“本对话工具刚改过的条目”。
证据性质：文档和代码均亲自读到；“亲手改的不重复”是下一步实时写入才会触发的风险。

### 5. 低 — 新增的“记忆变化”路径没有被阻断级请求只追加测试覆盖
文件: `packages/runtime-pi/test/prompt-prefix.compat.test.ts:800-814`，`packages/runtime-pi/test/memory-snapshot-block.unit.test.ts:187-265`
问题：阻断检查里的多轮用例每轮都传同一份 `ownerProfile`（清单内容固定），因此只覆盖“清单只发一次、之后不发变化”，没有覆盖“清单内容真的变了、变化块进入最后一条消息”时的逐字节只追加。新的变化解析/重建测试都是单元级，不在 `npm run check:prompt-prefix` 里。
证据：
```ts
// prompt-prefix.compat.test.ts：每轮 blocks 都是同一 ownerProfile
{ prompt: "总结一下", blocks: [ownerProfile, ...memories.slice(10)] },
{ prompt: "再短一点", blocks: [] },
```
建议：加一条三到四轮的端到端对话：第一轮清单 A，后续记忆变化触发变化块，断言后一轮请求前缀逐字节等于前一轮、变化只出现在最后一条用户消息里；同时补“全部删除且无 span”“变化块分类”两条反向用例。
证据性质：测试代码读代码证实；是否真的失败无法运行验证。

### 6. 低 — 每轮重读全部记忆、重放全部变化块，记忆多时请求侧成本线性增长
文件: `packages/application/src/services/context-formation-service.ts:232-239`，`packages/application/src/services/owner-profile-service.ts:498-519`，`apps/agent-service/src/production-run-composition.ts:304-305`
问题：`compose` 每次形成 context 都执行；`#snapshot` 为所有 `listed` 记忆查编号并逐条 `readText`。生产里的 `profileText` 缓存到 2000 条就整体清空，而设计允许约 6800 条；因此每轮可能重复解密数千条 payload。`knownMemories` 还会从头重放本轮压缩点之后的所有变化块。
证据：
```ts
const found = await this.#options.state.numbers({...});
...
const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
...
if (profileText.size >= 2000) profileText.clear();
```
建议：按记忆版本/水位数缓存完整清单或变化基线，只在新版本出现时重读；至少在记忆数大时加单轮耗时/读取量上限。
证据性质：代码路径读代码证实；实际生产规模下的耗时未测量，属推测性风险。此路径不是本轮增量新增，前几轮可能已复核，此轮未把它判为确定性错误。

**必答问题**

1. **会不会改变模型已见过的请求开头？** 本轮增量本身只改读取/比对逻辑，发给模型的内容仍在末尾追加：清单只在“压缩点之后找不到清单”时附一次，变化块只在最后一条用户消息里；`turnPrompt` 的顺序是 snapshot → 其它块 → changes → environment，history 不改写。系统提示文字（`chat.ts` identity）确实改了，但 `promptBundleChange` 只比较分类、工具名、模型、思考强度、语言，不比较 systemPrompt 文本，因此已有 prompt bundle 的老对话继续用冻结字节，新对话才用新文字；这一结论依赖生产确实配置了 `promptBundles`。没有 bundle、但有历史的老对话会走 `rollout` 用当前提示词建新 bundle，这会改一次开头，属既有 rollout 路径，未核实生产是否还有这种对话。每轮会变的记忆变化和运行环境都在最后一条用户消息里。

2. **同一段文字会不会在不同请求里变成不同字节？** 本轮未发现新增的不确定性：清单的类别顺序固定、行按编号排序；变化条目按编号排序；`Set` 只用于判断是否省略，不参与输出顺序；旧对话月份由 SQL `ORDER BY month` 固定；变化块不最近带时间字段，且 `changesSince` 忽略“你还能查到的”里的日期范围变化。出口遮盖未改，仍是既有确定性规则。快照重新生成时旧对话日期会随数据库变化，但只在首次/压缩后追加，不会改写已发字节。

3. **有没有对应的自动检查？反向用例真的会失败吗？** 有：owner-profile 的字数/分类测试、清单变化与逐轮基线测试、省略按类抑制测试、标记碰撞测试、旧 envelope 测试、span 线程范围测试、生产 HTTP 顺序测试。按代码推断，上一轮修复对应的关键反向用例会失败于旧实现：变化“只报一次”在旧基线上会重复报；按类省略在旧的“任意省略就全抑制”下会漏报真实删除；旧 envelope 会先被校验器拒绝；span 会把 trashed 线程算进去；分类 floor 会丢成 private。缺口见意见 5：没有端到端只追加用例覆盖真实变化块，也没有“全部删除且无 span”的反向用例。测试未实际运行。

4. **每个改动/新增值的产生端和使用端都能接受吗？**
   - `ConversationSpan.dataClassification`：唯一产生端是 `sqlite-conversation-turn-operations.ts:374-383`，取值固定为 `restricted/sensitive/private/public`；唯一使用端是 `owner-profile-service.ts:587` 的 `floor`，再进 `highestClassification`，两端接受；测试 mock 已补该字段。
   - `owner-profile` 这个块类型：现在只在旧 envelope/测试里出现；`ProductContextBlockKind` 已加入，`context-formation-service.ts:820` 与 `context-projection-service.ts:776` 两个校验器都放行，运行时按普通资料块渲染；旧 envelope 集成测试通过（代码层面）。
   - `memorySnapshotCharacters` → `snapshotCharacterBudget`：`toolResultCharacters` 保证是 >=2000 的整数，`#snapshot` 只把它当数字用；未发现第二个会拒绝它的配置解析器。
   - 记忆编号：产生端 `memory.numbers`/`memory_numbers` 是 1 起的整数，使用端 `memory_open` 的 `byNumber` 也要求 1 起整数，迁移与触发器保证编号存在；两端匹配。
   - 清单/变化标记与 `memory-snapshot`/`memory-changes` 的序列化格式：解析器的前后缀直接取自 `prompt-catalog` 的同一模板，`contextBlockMarker` 也用同一标记，两端匹配。
   - 但“变化块”的分类值使用端不匹配其内容（意见 2）；这是本轮发现的确定性问题，虽然当前渲染端暂不消费该字段。

**未核实**
- 未运行任何测试，未重算 `prompt-manifest.json` 的 sha256。
- Pi 的 `session.sendCustomMessage` 在真实历史里是否始终以字符串 `content` 保存、`compaction_end` 时 `session.messages` 是否已包含摘要，均未在真实 Pi 运行时核实。
- 生产是否还存在“有历史但没有 prompt bundle”的老对话，因此无法确认系统提示换新是否真的只影响新对话。
- 每轮读取数千条记忆的实际耗时未测量。
