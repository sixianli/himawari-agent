# 结论（先给判断）

推荐做「**锚点分段**」：老对话的提示包继续写规则集 1，但在 `identity_json` 里加一个**锚点**（最后一条已经按规则集 1 发出去的消息 id）。出口遮盖时，**系统提示、锚点及以前的全部消息继续用规则集 1；锚点之后的消息用规则集 2**。锚点只写一次、只前进、不改表结构。

不建议把整个对话的 `redactionRuleset` 从 1 改成 2，也不建议为此重建提示包：前者会让老消息按规则集 2 重遮，改变已发字节；后者同样会改变，且缓存整段失效。

---

# 一、方案依赖的前提

## 读代码/来源证实的

**P1. 请求前缀必须逐字节稳定，业界要求只追加。**
- 本项目规则原话：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”来源：`.claude/rules/prompt-prefix.md:35`。
- Anthropic 原话：“Prompt caching references the entire prompt: `tools`, `system`, and `messages` (in that order), up to and including the block designated with `cache_control`.” 以及 “changes at each level invalidate that level and all subsequent levels.” 来源：https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- OpenAI 原话：“Cache reuse requires the entire rendered prefix to match. If content or a relevant setting changes before a breakpoint, the prefix after that change cannot match the existing cache entry.” 以及 “Preserve conversation history. Append new messages rather than rewriting earlier turns.” 来源：https://developers.openai.com/api/docs/guides/prompt-caching
- DeepSeek 原话：“If subsequent requests have overlapping prefixes with previous requests, the overlapping part will only be fetched from the cache,” 示例是 `A+B` 后接 `A+B+C`。来源：https://api-docs.deepseek.com/guides/kv_cache

**P2. 历史里存原文，每次发送时重新遮盖。**
规则原话：“出口遮盖是唯一的例外：历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖。”来源：`.claude/rules/prompt-prefix.md:36`。实现上 `model-egress.ts:220-249` 对请求体逐字符串调用 `redactForEgress`。**这意味着：同一条老消息每次发送时都会重新决定遮法，必须靠持久状态保证它仍选规则集 1。**

**P3. 规则集 2 只多两条宽松密码规则。**
`redaction.ts:350-363`：只有 `ruleset >= EGRESS_RULESET_FIRST_LOOSE_PASSWORDS` 时才执行 `PASSWORD_WORDED_ASSIGNMENT` 和 `PASSWORD_BARE_VALUE`；其余规则两个版本相同。`EGRESS_RULESET_CURRENT = 2` 在 `redaction.ts:53-54`。

**P4. 规则集版本存在按对话冻结的提示包 `identity_json` 里，缺字段按 1。**
`thread-prompt-bundle-service.ts:22-28` 的 `storedRuleset`；新建/换新时的取值在 `:263-280`；读回在 `:291`。SQLite 写入在 `sqlite-thread-prompt-bundle-operations.ts:209-217`。表定义在 `migrations/0077_thread_prompt_bundles.sql`。

**P5. 出口看到的是发给模型服务方的 JSON，而不是 Pi 的内部消息对象。**
`model-egress.ts:467-483` 的 `maskRequest` 遍历请求体；`DEFINITION_KEYS`（含 `tools`）在 `:398` 被跳过，所以工具定义不遮盖；会话数组逐项处理。**系统提示在 OpenAI 兼容请求里是 `messages` 的一项，在 Anthropic 请求里是顶层 `system` 字段，两种都能被 `maskRequest` 处理。**

**P6. 新增 `origin` 会撞上数据库 CHECK。**
`migrations/0077_thread_prompt_bundles.sql:6-10` 写明 `origin IN (...)`，只有现有 10 个值。`ports/thread-prompt-bundles.ts:6-17` 也是同一份清单。**如果方案想新增 `redaction_ruleset_upgrade` 这个 origin，SQLite 会拒绝，必须写迁移重建表或改约束；这正是 I-73 说的“清单里的 id 能通过后端校验吗”。** 所以本方案不改 origin。

**P7. 会话消息有稳定 id 和顺序；提示包在 SQLite 中持久化。**
`thread_messages` 有 `id`、`sequence`、`UNIQUE(thread_id, sequence)`（`0001_initial_product_schema.sql:88-100`）。投影层按 `sequence` 严格排序后才给出 `history`（`context-projection-service.ts:314-343`）。`RuntimeProjectionMessage` 带 `id`（`ports/intelligence.ts:321-337`）。**锚点可以用消息 id 表示，不必新增 sequence 字段。**

**P8. 压缩会重写历史，本身是允许的缓存失效点。**
规则原话：“必须缩短历史时，集中做、少做，并在 ADR 里写明。”来源：`.claude/rules/prompt-prefix.md:59`。适配器在 `prehydrateSession` 里按 native history → 中断提示 → 产品历史 → compaction 的顺序装配（`pi-runtime-adapter.ts:654-688`）。

**P9. 现有反向用例已经证明“中途把整个对话切到规则集 2”会断前缀。**
`packages/runtime-pi/test/prompt-prefix.compat.test.ts:655-663` 的 `[ADR-0188] REVERSE`。前缀检查器逐条比较 `messages` 的 JSON，并检查原始字节（`test/helpers/prompt-prefix.ts:24-47`）。

**P10. 业界没有查到“按消息记录遮盖规则版本”的一手文档。**
Anthropic/OpenAI/DeepSeek 的一手文档只规范前缀缓存和只追加，不规定遮盖策略的版本化。所以本方案是把前缀缓存原则应用到遮盖版本上，不能声称业界已有同一做法。

## 推测或未核实

- **P11【未核实】同一线程是否严格串行执行。** 代码只证明执行租约按 run 管理（`run-coordinator.ts:331-339`），没有证明同一 `threadId` 同时最多一个 run。若并发，见风险 R1。
- **P12【未核实】Pi 对不同 provider 的请求体是否与产品历史一一对应。** 现有 `check:prompt-prefix` 只覆盖 openai-completions 的本机回环；Anthropic 会把多个 tool_result 合并进一个 user 消息，按“消息条数”切分可能错位。必须做验证或按 provider 分别实现。
- **P13【推测】规则集 2 是规则集 1 的“遮得更多”超集。** 结构上 2 只新增替换，但后执行的证件号/卡号规则可能跨越被替换的片段，不能仅凭代码断言绝对超集。需要属性测试；若不成立，改动要改成取两种遮法的并集。

---

# 二、方案本身

## 1. 状态模型

在现有 `thread_prompt_bundles.identity_json` 中增加两个字段，不改表：

```json
{
  "toolNames": [...],
  "modelRef": "...",
  "thinkingLevel": "...",
  "answerLocale": null,
  "redactionRuleset": 1,
  "redactionRulesetAnchor": "message-id-or-native-sentinel",
  "redactionRulesetAnchorIncludesCompaction": false
}
```

- `redactionRuleset`：锚点及以前使用的版本（老对话为 1）。
- `redactionRulesetAnchor`：最后一条已经按旧版本发出去的消息 id。**没有这个字段 = 还没有分段，整个对话用 `redactionRuleset`。**
- 为了将来规则集 3 不返工，实际可存成有序段数组 `redactionRulesetSegments: [{ untilMessageId, ruleset }]`；MVP 只写一段也可以，但字段形状要能扩展。段是有序数组，满足“无序集合会变字节”的约束。

**不需要新增表或列。** `thread_messages.sequence/id` 已经持久化；提示包记录已经持久化；锚点写进已有 JSON。

## 2. 升级时机与原子写入

在 `ThreadPromptBundleService.resolve` 里，当同时满足：

- `hasHistory` 为真；
- 当前记录的 `storedRuleset < EGRESS_RULESET_CURRENT`；
- `redactionRulesetAnchor` 为空；

就调用新的存储操作 `markRedactionUpgrade`，用一条带守卫的 `UPDATE` 写入锚点：

```sql
UPDATE thread_prompt_bundles
SET identity_json = json_set(identity_json, '$.redactionRulesetAnchor', ?,
       '$.redactionRulesetAnchorIncludesCompaction', ?)
WHERE owner_id = ? AND agent_id = ? AND thread_id = ? AND generation = ?
  AND json_extract(identity_json, '$.redactionRulesetAnchor') IS NULL
```

锚点取本 run 开始时 `projection.history` 的最后一条消息 id；如果只有 native history、没有产品历史，就写一个固定 sentinel（例如 `"native-history"`）。如果本次投影里有 compaction，把 `includesCompaction` 写为 true。

几个关键点：

- **不新建 generation、不改 origin**，所以不会撞上 0077 的 CHECK，也不会让 pin 失效。
- 只改 `identity_json` 元数据，不改 `system_prompt_ref`、`tools_ref`、两个 sha256，所以系统提示和工具字节完全不变。
- 写入是原子的、幂等的；多个进程同时升级时只有一个能写入，另一个读到同一个锚点。
- 如果写入失败，**本次 run 必须失败**（例如抛 `RUNTIME_PROMPT_BUNDLE_REDACTION_UPGRADE_REQUIRED`），不能用没有锚点的旧记录继续跑。否则 tail 消息会在本轮按 1 发出，下一轮无法补遮。

## 3. 发送时怎样切分

`projection.history` 是有序的（P7），适配器已经能拿到它和 `projection.nativeHistory`。适配器在 `prehydrateSession` 同一顺序上计算 `headMessageCount`：

```text
headProductCount =
  锚点存在且在 projection.history 中找到 ? (锚点下标 + 1) : 0
headCount =
  nativeHistoryMessages.length
  + (中断提示是否存在 ? 1 : 0)
  + headProductCount
  + (锚点存在且本次 compaction 属于升级前 ? 1 : 0)
```

然后适配器把 `headCount`、`headRuleset`、`currentRuleset` 放进 `ModelEgressContext`，随 `admitPiStream` 传给 `egress.exchange`（现有链路在 `pi-runtime-adapter.ts:1000-1007`、`:1567`）。

`model-egress` 的切分规则：

- 顶层 `system`/`instructions` 字段和 role 为 `system`/`developer` 的消息：**永远用 headRuleset**（保护冻结的系统提示）。
- 会话数组中前 `headCount` 个非 system 消息：headRuleset。
- 其余消息：`EGRESS_RULESET_CURRENT`（tail）。
- `tools` 仍然跳过（现状）。
- 继续使用同一个按顺序累积的 `known` map（`model-egress.ts:130`、`:411-425`），因此遮盖仍只依赖“自己 + 前面的内容”，不依赖后面的消息。

错误处理必须偏保守：

- 锚点存在但当前历史里找不到（被压缩掉）：**产品历史全部按 current 处理**（`headProductCount = 0`），绝不把锚点之后的消息退回 head。
- 锚点字段非法（不是字符串、为空、超长）：按“锚点存在但丢失”处理，同样全部按 current，不能当成“没有锚点”而退回整个对话 head。
- 没有锚点且 `storedRuleset < current` 且有历史：这是升级未完成，resolve 失败，不允许发送。

## 4. 代价

- 每个老对话一次性写一条 `identity_json` 更新，不产生新行、不增加请求。
- 第一次升级后的请求，系统提示、工具、旧历史完全不变，只有本来就要新增的消息在末尾，且用规则集 2 遮。
- 代码改动集中在：提示包服务/端口/SQLite 操作、适配器的 headCount 计算、`model-egress` 的按段遮法；不需要改提示词目录、工具定义、模型绑定。
- 需要为 provider 请求体与历史消息的对应关系补一条验证；这是主要成本。

---

# 三、考虑过但不选的做法

1. **整个对话切到规则集 2。** 会重遮老消息，改变已发字节；现有 `[ADR-0188] REVERSE` 用例就会失败（`prompt-prefix.compat.test.ts:655-663`）。不选。
2. **手动 `thread prompt rebuild` 让老对话整体换新。** 会重写历史和系统提示、整段缓存失效，且老消息字节改变。只能作为主人明确选择“隐私优先于缓存”的按钮，不作为默认修法。
3. **只对“最后一条消息”用规则集 2。** 下一轮这条消息变成历史后会被规则集 1 重遮，新遮过的内容重新露出；直接违反问题 3 的要求。不选。
4. **新增一列/一张表记录每条消息的规则集。** 正确性最好，尤其能处理并发旧 run，但违反“最好不改表结构”和 PA-4 迁移排队约束；而且现有 `thread_messages` 已有 `run_id`，若要做更稳的方案，优先考虑“按消息所属 run 的冻结提示包取规则集”，而不是新增列。后者的端口/查询改动也不小，作为备选。
5. **把新消息在写入历史前先遮好。** 会改变历史存储内容和网页展示，违反 ADR 0183“内部存储和展示用原文”；而且 Pi 会话每轮从产品历史重建，下一次仍要重新决定规则集。不选。
6. **在消息里插入不可见标记字符当分段点。** 会改变模型看到的字节，可能影响 tokenizer，且展示层还要剥离标记。不选。
7. **用时间戳/创建时间当边界。** 排队中的用户消息 `occurredAt` 可能早于升级时间，导致第一条新消息漏遮；时钟偏差也不可控。不选。
8. **新增 `redaction_ruleset_upgrade` origin。** 会撞 `0077` 的 CHECK，必须迁移；且 `THREAD_PROMPT_BUNDLE_ORIGINS` 也要同步。为了不改表，不选。

---

# 四、风险与反例

- **R1（并发旧 run）：** 旧 run 在升级前已经 resolve 了没有锚点的 bundle，升级后它仍按规则集 1 发送并提交新消息；后续请求会把这些消息当成 tail 用规则集 2 重遮，导致这些消息**从 1 变 2**、字节改变一次。方向是“遮得更多”，不会泄露，但严格说违反“已发字节不变”。若 P11 能证明同一线程串行，则不存在；否则需要维护窗口，或改成按消息/按 run 持久化规则集。**这是最需要拍板的风险。**
- **R2（provider 请求体与历史不是一一对应）：** Anthropic 合并 tool_result、Pi 省略/合并 custom 消息时，`headCount` 会错位。错成“少算”会把新消息按 1 发（漏遮）；错成“多算”会把旧消息按 2 遮（改字节）。缓解：先只支持已经验证的 openai-completions 路径；Anthropic 按 content block 切分或暂不升级；用 `check:prompt-prefix` 的真实回环验证每个 provider。
- **R3（压缩丢掉锚点）：** 锚点被压缩掉后全部按 current，老消息可能从 1 变 2；但压缩本身已经允许整段缓存失效，且方向是遮得更多，不泄露。**不能**在锚点丢失时退回 head，否则 tail 消息会重新露出。
- **R4（规则集 2 不是严格超集）：** 见 P13。若属性测试发现 2 会破坏 1 已遮的片段，需在出口取两种遮法的并集，或限制新规则的执行顺序。
- **R5（换新记录时丢锚点）：** `sqlite-thread-prompt-bundle-operations.ts:209-217` 目前只写 `redactionRuleset`；`#rulesetFor` 在工具/模型变化时直接返回 current。若新记录丢掉锚点并把 `redactionRuleset` 写成 2，老消息会被 2 重遮。必须在 `#create`、`#rulesetFor`、`storedRuleset` 三处都携带锚点；这正是“每个产生值和消费值的地方都要核对”的检查点。
- **R6（回滚）：** 旧代码的 `storedRuleset` 用 `Math.min(stored, current)`（`:27`）。若新版本写过规则集 3、回滚到只认 2 的代码，3 会被压成 2；3 独有的规则无法执行，可能重新露出。需要发布/回滚策略：先回滚规则集常量，再回滚代码；或在新版本里把“高版本记录”标成不可降级。
- **R7（`known` 顺序）：** 分段后仍必须按消息顺序处理，且 head 消息先于 tail。若实现按 kind 或对象遍历顺序处理，会改变 `known` 累积顺序，导致不同字节。用现有顺序遍历即可。

---

# 五、需要人拍板的取舍

1. **是否接受 R1 的一次性 1→2 字节变化**：接受（MVP，简单）还是要求维护窗口/按消息持久化（更严格，改动大）。
2. **是否只支持已验证的 provider**：Anthropic 等按 content block 实现前，老对话是否继续停留在规则集 1。
3. **是否现在就把锚点做成可扩展的段数组**：为将来规则集 3 省一次迁移，还是先做单段、上线前加保护检查。
4. **内部元数据原地更新 vs 新 generation/迁移**：原地更新不改表但让 `identity_json` 可变；新 origin 更“正统”但要迁移并可能与 PA-4 的 0082 冲突。
5. **手动 rebuild 的语义**：是保留锚点（旧消息仍 1），还是明确“重建 = 从当前版本重新遮全部历史”（会改变老字节，但主人主动选择）。
6. **压缩后的严格程度**：接受锚点丢失后全部按 current，还是额外持久化压缩点前的段，尽量保持老消息字节。

---

# 六、逐条回答必答问题

## 必答 1：会不会改变模型已经见过的请求开头？

**按本方案不会。**
- 系统提示、工具定义、锚点及以前的全部历史消息，仍按它们被发出时的规则集（老对话为 1）重新遮盖；工具本来就不参与遮盖（`model-egress.ts:398`）。
- 新消息本来就只能追加在末尾；本轮变化的值仍然只在最后一条消息里，方案没有把任何会变的值放进系统提示或工具。
- 规则集版本、锚点不会发进请求体，模型看不到。
- 唯一例外是压缩：压缩本身是规则允许的缓存失效点；压缩后锚点丢失时全部按规则集 2，字节会变，但方向是遮得更多，且压缩已经让缓存整段失效。

## 必答 2：同一段文字会不会在不同请求里变成不同字节？

**不会，前提是锚点持久且按消息 id 判定。**
- head 段文字每个请求都用 headRuleset；tail 段每个请求都用 current；判定只取决于该消息在有序历史中的位置和持久锚点，不取决于后文。
- `known` 仍是按消息顺序向前累积，符合规则第 11 条“只依赖自己和前面的内容”。
- 没有新增时间、随机数、无序集合；新增的段数组必须是有序的。
- 一旦消息被判定为 tail，它就不会退回 head（锚点只写一次、只前进；锚点丢失时也是继续 current）。这保证“已经按 2 遮过的内容不会退回 1 重新露出”。

## 必答 3：有没有对应的自动检查，反向用例真的会失败？

有，建议这样接：

- 在 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[I-66]` describe 里新增用例（该 describe 的 fullName 会被 `scripts/check-prompt-prefix.mjs:27` 的 `-t "\[I-66\]"` 选中）：
  1. **正向：老对话第 2 轮升级。** 第 1 轮老消息含 `abc12345`；第 2/3 轮新消息含另一个宽松密码 `xyz98765`。断言：`abc12345` 在所有请求里保持原样（老字节不变），`xyz98765` 从它第一次发出起就不再出现，`findConversationBreak` 为 null。
  2. **反向：如果整段用规则集 2。** 复用现有 `[ADR-0188] REVERSE` 思路，断言 `findConversationBreak` 非 null（老消息被改）。
  3. **反向：如果 tail 退回规则集 1。** 断言 `xyz98765` 会在后续请求里重新出现；这个断言必须在“故意把 tail 设成 1”的变体下失败。
  4. **重启：** 用同一 SQLite/历史，销毁并重建适配器后再跑第 3 轮，断言锚点仍生效、`xyz98765` 不出现、老消息字节不变。
  5. **压缩：** 构造/触发 compaction，使锚点被丢掉；断言剩余消息全部按 current，且任何已按 2 遮过的值都不重新出现；反向：如果锚点丢失时退回 head，测试必须失败。
  6. **并发：** 两个 resolve 同时升级；断言只产生一个锚点，两个调用看到同一值；反向：去掉 `WHERE ... IS NULL` 守卫时测试失败。
- 在 `packages/application/test/model-egress.unit.test.ts` 增加按段遮盖的单元用例：同一段文字在 head 位置不被宽松规则遮、在 tail 位置被遮；反向：给整个请求传同一个 ruleset 时必须失败。
- 在 `test/integration/thread-prompt-bundles.test.ts` 增加：锚点写入幂等、重开数据库后仍在、换新记录携带锚点、`classification_lower` 不丢锚点、非法锚点按“丢失”处理。
- 把 `scripts/check-prompt-prefix.mjs:10` 的 `REQUIRED = 8` 提高到新增后的通过数（例如 12/14），否则新增用例即使没跑也会显示通过。
- 反向用例要按现有做法先确认“修之前会失败”，而不是只断言修之后通过。

## 必答 4：每个产生/使用的新值，两端都接受吗？

逐个核对：

| 值 | 产生处 | 使用处 | 需要补的校验/改动 |
|---|---|---|---|
| `identity.redactionRulesetAnchor` | 新的 `markRedactionUpgrade` / `#create` | `storedRuleset` 之后读回、`#open`、适配器、SQLite `create` | `ThreadPromptBundleIdentity` 加字段（`ports/thread-prompt-bundles.ts:21-27`）；SQLite `create` 的校验（`sqlite-thread-prompt-bundle-operations.ts:148-165`）加：非空字符串、长度上限；`#open` 的返回对象（`thread-prompt-bundle-service.ts:287-292`）加字段 |
| `redactionRulesetAnchorIncludesCompaction` | 升级写入 | 适配器计算 headCount | 必须是布尔值；非法按 false 但锚点丢失时仍按 current |
| `origin` | 不新增 | `THREAD_PROMPT_BUNDLE_ORIGINS`（ports:6-17）与 SQLite CHECK（0077:6-10） | **如果改成新 origin，两处都会拒绝/不认**；本方案不新增，避免 I-73 类问题 |
| `redactionRuleset` 头部值 | `#rulesetFor` / `storedRuleset` | `#open`、适配器、`model-egress` | 保持安全整数 ≥1；`storedRuleset` 的 `Math.min` 要改为“头部不降级”语义，避免规则集 3 回滚时把已发 head 降级 |
| `headCount` | 适配器 | `model-egress` | 必须是非负安全整数且不超过请求会话数组长度；越界时 fail closed（tail 全部按 current，head 只到系统消息） |
| `redactionRulesetSegments`（若采用段数组） | 升级/换新 | `#open`、适配器 | 有序、每项 `{untilMessageId: string, ruleset: int>=1}`；未知字段忽略；数组不能依赖对象遍历顺序 |

另外，写回 `identity_json` 的 SQLite 操作要像现有 `create` 一样做类型校验；`markRedactionUpgrade` 要返回更新后的记录，服务重新 `#open`，不能继续用内存里的旧记录。

---

# 七、逐条回答“请回答”（5 问）

1. **怎样让老对话新消息用规则集 2、已发历史字节不变？**
   用锚点分段：提示包 `identity_json` 记录“最后一条旧消息 id”；出口把系统提示和锚点前的消息按旧规则集遮，锚点后的消息按当前规则集遮；锚点只写一次、只前进。代价是新增一个存储操作、投影/适配器的 headCount 计算和 `model-egress` 的按段切分，以及 provider 请求体映射的验证。

2. **需要持久保存什么状态？能不能不改表结构？**
   只需持久化 `redactionRuleset`（头部版本）和 `redactionRulesetAnchor`（含“是否包含升级前的压缩摘要”）。两者都放进现有 `thread_prompt_bundles.identity_json`，**可以不改表结构、不加列**。消息 id/顺序和提示包记录本来就在 SQLite 里。

3. **压缩、并发、重启时怎样保证不退回规则集 1？**
   - 重启：锚点和规则集在 SQLite，每次 resolve 重新读取；没有内存态。
   - 压缩：消息按 id 判定；锚点还在就保持分段；锚点被压缩掉就把剩余产品历史全部按 current，绝不退回 head。压缩本身允许缓存整段失效。
   - 并发：升级写入用带 `anchor IS NULL` 守卫的单条事务 UPDATE，只有一个锚点胜出；旧 run 的并发窗口只会让消息从 1→2（遮得更多），不会 2→1。若要求严格不变，需要维护窗口或按消息/按 run 持久化（见拍板项）。

4. **怎样做反向验收、怎样接进 `check:prompt-prefix`？**
   在 `[I-66]` describe 内新增正向和反向用例（老消息不变、新消息必遮、整段切 2 必须报断、tail 退回 1 必须报断、重启/压缩/并发必须保持），并提高 `scripts/check-prompt-prefix.mjs` 的 `REQUIRED`。同时保留现有 `findConversationBreak` 逐字节检查；新增“已遮值不得重新出现”的辅助断言，并确认去掉修复时该断言会失败。

5. **最小可行做法是什么？哪些情况直接放弃更划算？**
   最小可行：只做单段锚点 + 出口按 head/current 切分；只支持已经用 `check:prompt-prefix` 验证过请求体映射的 provider；不改表、不新增 origin；压缩后锚点丢失时全部按 current；接受并发旧 run 的一次性 1→2 变化。
   建议直接放弃/暂不处理：Anthropic 合并 tool_result 的精确分段（先实现 content block 级或让老对话留在 1）、跨进程在途旧 run 的严格字节保持（要维护窗口或按消息持久化）、规则集 3+ 的自动升级（先在代码里加“段数组”形状和保护检查）、以及老对话里已经漏出去的值（只能靠主人主动 rebuild，不能自动改历史）。
