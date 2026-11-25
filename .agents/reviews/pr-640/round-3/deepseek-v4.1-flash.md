## 范围与上一轮

本轮增量 `a7109561..1636c573` 只改了 `packages/application/src/services/context-formation-service.ts`（外加本轮复核记录，`git show` 被规则拒绝，未读）。我核对了增量前后这段代码，并跟到 `owner-profile-service.ts`、`memory-snapshot-block.ts`、`pi-runtime-adapter.ts`、prompt 目录、SQLite `span`、上下文投影/组装以及相关测试。

上一轮判断文件读不出来；只能按提交记录和代码核对：上一轮两条低意见（`c9b4ffb45`）确实已改：`memory-snapshot-block.ts:272-274` 用 `highestClassification(current.dataClassification, [projection.contentClassification ?? ...])` 抬高记忆变化块的分类；设计文档里“旧对话”已改成“共有多少天有对话、每月多少天”（`docs/execution/specs/2026-11-24-memory-redesign-design.md` 当前行）。增量 `1636c5735` 对“清单内记忆不再被相关记忆去重掉”的修复也已在代码里。

### 1. 【中】清单预算只算记忆正文行，实际快照可以明显超过“窗口 10%”

文件:行：`packages/application/src/services/owner-profile-service.ts:529-542`、`563-583`；对照 `docs/execution/specs/2026-11-24-memory-redesign-design.md:127` 和 `docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:51`。

问题：作者说“字数上限 snapshotCharacterBudget（窗口 10%）”，ADR 也写“开头快照不超过窗口 10%”，但实现只对每条记忆的 `line` 计费，固定表头、各分类标题、“你还能查到的”、省略行，以及旧对话范围行都没有计入。旧对话范围里的月份数随对话历史增长，完全没有上限。

证据（读代码证实）：
```ts
let remaining = limit;
...
if (entry.line.length + 1 > remaining) continue;
remaining -= entry.line.length + 1;
...
const text = [
  MEMORY_SNAPSHOT_HEADER.text,
  ...body,
  MEMORY_SNAPSHOT_REACHABLE_HEADER.text,
  MEMORY_SNAPSHOT_REACHABLE_DETAILS.text,
  ...(span ? [renderPrompt(MEMORY_SNAPSHOT_CONVERSATIONS, { ... months: span.months.map(...).join("，") })] : []),
  ...omitted,
].join("\n");
```
`owner-profile-service.unit.test.ts:463-483` 用 `snapshotCharacterBudget: 20`，最终文本却远长于 20 个字符，说明现有测试没有把“总字数”当作契约。

建议：按最终 `text` 的总长度校验并回退（至少预留表头、分类标题、省略行、旧对话行的空间）；对 `span.months` 设条数上限或把这一行也纳入预算；补一条“总长度不超过预算”的反向用例。

### 2. 【中低】每轮都逐条解密全部记忆，且仍读取已不再使用的档案事实行

文件:行：`packages/application/src/services/owner-profile-service.ts:258-266`、`420`、`508-512`。

问题：本轮侧重资源耗尽。把主人档案块换成记忆清单后，`#select` 仍计算并 `readText` 所有重要度 ≥600 或置顶的事实行（`factLines`），但 `compose` 只解构 `rules`，`sections/factLines` 已不再使用；同时 `#snapshot` 又在应用预算前按 `listed` 顺序逐条 `await readText`。每条记忆每轮可能被解密两次，且读取数量不受 `snapshotCharacterBudget` 限制（先读完全部再裁剪）。

证据（读代码证实）：
```ts
const factLines = await read(
  eligible.filter((memory) => (pinned.has(memory.id) || ...) && PROFILE_SECTIONS.some(...)),
  true,
);
...
const { rules, eligible, declined, usage, listed, ceiling } = await this.#select(input);
...
for (const memory of listed) {
  const number = numbers.get(memory.id);
  ...
  const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
```
这一段在增量之前就存在，不是 `1636c5735` 引入，但属于本 PR 的新清单路径。

建议：`compose` 不再需要事实档案时删掉 `factLines/sections` 的计算和读取；`#snapshot` 先按重要度/更新时间/编号排序和预算估计再读文本，或至少避免同一条记忆在一轮内重复解密。

### 3. 【低】压缩后补发的是本轮开始时的快照，不是“最新记忆重建”的清单

文件:行：`packages/runtime-pi/src/pi-runtime-adapter.ts:1883`、`packages/runtime-pi/src/memory-snapshot-block.ts:280-288`。

问题：ADR 0286/设计写“压缩长对话时重建”记忆清单，但运行中 `projection` 只在每轮开始时解析一次，`memorySnapshotAfterCompaction` 直接取这个 `projection.contextBlocks` 里的旧快照，没有重新调用 `OwnerProfileService.compose`。如果本轮开始后后台/其他设备改了记忆，压缩后补发的清单仍是本轮开始时的版本；真正的变化要等下一轮才以“记忆变化”出现。

证据（读代码证实）：
```ts
const snapshot = memorySnapshotAfterCompaction(session.messages, projection);
...
const snapshot = projection.contextBlocks.find(({ kind }) => kind === MEMORY_SNAPSHOT_KIND);
if (!snapshot || previousMemorySnapshot(messages) !== undefined) return undefined;
```
“本轮中途记忆变化会丢到下一轮”是基于上述代码的推断，未实际制造并发写入验证。

建议：压缩时重新解析投影/重新 compose 最新清单，或在规格里明确“补发的是本轮开始时的快照”；补一条适配器层的压缩补发用例。

### 4. 【低/推测】增量修复让清单内记忆参与 `maxSelectedMemories` 竞争，可能挤掉不在清单里的新相关记忆

文件:行：`packages/application/src/services/context-formation-service.ts:254-258`、`280-290`。

问题：增量修复把 `memory-snapshot` 的 `memoryIds` 从去重集合里排除，相关搜索命中的清单内记忆现在也会进入 `allowed`，并和不在清单里的记忆一起被 `slice(0, request.maxSelectedMemories)` 截断。生产默认 `maxSelectedMemories: 5`；若前 5 条恰好都在清单里，第 6 条真正新相关、但不在清单里的记忆仍可能被挤掉。修复本身符合“每轮相关记忆不被清单去重”的意图，但这是新的候选竞争后果。

证据（读代码证实）：增量代码只删除了清单的排除项，随后仍是：
```ts
const allowed = candidates.filter((candidate) =>
  !profileMemoryIds.has(candidate.id) && CLASSIFICATION_RANK[...] <= VISIBLE_RANK);
const selected = allowed.slice(0, request.maxSelectedMemories)...
```
“会挤掉新记忆”是推测，取决于实际分数；没有用真实搜索分布验证。

建议：若目标是“每轮附相关记忆的最新版本”，可考虑优先保留不在清单里的候选，或至少为不在清单里的候选保留名额；补一条“清单内高分记忆 + 清单外新相关记忆”的边界测试。

### 5. 【低】规则清单文档仍描述“规则和档案共用 2000 字”，与当前代码不一致

文件:行：`docs/agent-rulebook-inventory.md:153`（M-3）；代码 `packages/application/src/services/owner-profile-service.ts:420`、`447`。

问题：M-3 仍写“规则和档案共用 2000 字……其余的规则在前、档案在后”，但 `compose` 已不再产出 `owner-profile` 档案块，2000 字预算实际只约束规则行；记忆清单另用 `snapshotCharacterBudget`。文档旧于本 PR，属于说明与代码不一致。

证据（读代码证实）：`compose` 现在解构的是 `{ rules, eligible, declined, usage, listed, ceiling }`，随后生成的是 `memory-snapshot` 块，不再使用 `sections`。文档原文仍写“档案在后”。

建议：更新 M-3、相关 ADR 引用和测试名称，说明 2000 字现在只管规则块，记忆清单按窗口比例单独预算。

## 侧重检查

- 错误路径：重复 `memory-snapshot` 会抛 `RUNTIME_PROJECTION_DUPLICATE_MEMORY_SNAPSHOT`（`memory-snapshot-block.ts:255-256`）；没有清单时正常回退；清单只有旧对话、没有记忆时仍可生成块；记忆没有编号或正文为空会被静默跳过，不会报错，也不会算入“省略了几条”。`snapshotCharacterBudget` 本身没有校验，传负数/NaN 时预算行为异常，但生产入口只会传正整数（`toolResultCharacters`，最小 2000）。
- 不可信输入：清单标记只认用户消息里的 `<himawari-context>` 和 `himawari.memory-snapshot` 自定义消息，owner-message 里的同样文字不算（`memory-snapshot-block.ts:88-125`）；记忆正文里出现清单标记或省略尾句的用例有覆盖（`memory-snapshot-block.unit.test.ts:273-285`）。但记忆正文会先被压成单行，所以无法在正文中伪造“独占一行”的标记；若主人规则或资料块正文里出现换行加完整标记，代码没有专门拒绝，属于低概率内容注入面，未实测。
- 安全/分级：快照块分类取“保留记忆最高级 + 旧对话最高级”；记忆变化块分类取当前快照分类和本轮 `contentClassification` 的最高者（`memory-snapshot-block.ts:272-274`）。被删敏感记忆的原文因此通常还会带着上一轮 runtimeHistory 的较高分类，未发现新增明文降级；这一点依赖 `captureHistory` 保存历史分类，未做真实历史回放验证。
- 资源耗尽：见意见 2；另外旧对话范围按月份数生成，见意见 1。
- 不可撤销操作：本改动只有读取和生成上下文，没有删除、覆盖或外发不可逆动作；`memory_open` 是只读。
- 规则/文档一致性：见意见 1、5；系统提示按对话冻结这一条本身与规则一致（见必答问题 1）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
正常新对话不会：`turnPrompt` 把清单放在最后一条用户消息的 `<himawari-context>` 里（`pi-runtime-adapter.ts:652-675`）；第二次起 `splitMemorySnapshot` 在历史里找到旧清单后不再附清单，只把“记忆变化”放在最后一条消息（`memory-snapshot-block.ts:260-276`）；压缩补发也是追加的自定义 steer 消息（`pi-runtime-adapter.ts:1883-1887`）。系统提示按对话冻结也确实成立：`production-run-policy.ts:102-123` 生成系统指令，`thread-prompt-bundle-service.ts` 按线程保存并在同一线程复用；`production-http-composition-process.test.ts:2290-2297` 的 `[PR-B]` 验证配置改变后旧对话的请求头不变。
残留点：部署后旧对话的第一轮会在末尾补一份完整清单（历史里没有清单标记），旧对话冻结的系统提示仍写着“主人档案”，与新清单措辞不一致，但不改变已有前缀。

**2. 同一段文字会不会在不同请求里变成不同字节？**
未发现新增的不确定性。清单正文按固定分类顺序、每类按编号排序；保留选择按重要度、更新时间、编号排序；旧对话月份由 SQL `GROUP BY month ORDER BY month` 产生；记忆变化按编号排序。省略分类只用 Set 做成员判断，不参与输出顺序。清单内容会随数据库变化而变化是设计使然，同一状态、同一历史应产生相同字节。增量没有引入带时间的字段或无序集合输出。

**3. 有没有自动检查和真正会失败的反向用例？**
有。`memory-snapshot-block.unit.test.ts` 覆盖：首轮发清单、已知清单不再发、增删改变化、省略类不报失效、压缩补发与不重复补发、数字开头编号、带括号的“待确认”分类、伪造标记；`owner-profile-service.unit.test.ts:463-483` 覆盖预算与省略行；`conversation-turns.test.ts` 覆盖 `span` 的分类、其他 agent、已回收线程；`context-projection.test.ts` 覆盖旧 `owner-profile` 块兼容；`production-http-composition-process.test.ts:2555-2574` 通过“去掉清单后仍至少有两段相关记忆”来反向覆盖本次增量修复，改回旧去重逻辑会失败。
缺口：没有测试“快照总长度不超过预算”；没有适配器层测试真正触发 `compaction_end` 后补发记忆清单（只测了纯函数）；`check:prompt-prefix` 只验证首轮清单和后续不再重复，没有覆盖“记忆变化块”的追加路径；提交说明引用的 `test/integration/context-formation.test.ts` 没有注入 profile，覆盖不到本次去重修复，实际覆盖来自 production-http 用例。

**4. 改动产生或修改的每个值，使用端都能接受吗？**
增量只产生局部 `profileMemoryIds`，只在 `context-formation-service.ts:280-323` 使用，类型仍是 `Set<string>`；`ownerProfile` trace 仍按块输出快照的 `memoryIds`（`:457-462`），下游 UI 计数逻辑接受数组，未发现两端校验不一致。
更广范围核对：`memory-snapshot` 在两个 envelope 校验器里都已放行（`context-formation-service.ts:820-827`、`context-projection-service.ts:769-786`），旧 `owner-profile` 仍被接受；`ConversationSpan` 的生产者 SQLite `span` 字段与 `OwnerProfileService` 消费字段一致；所有新 prompt id 都在 `prompt-manifest.json` 注册；`himawari.memory-snapshot` 自定义消息类型只在新模块和 Pi steer 路径使用；`snapshotCharacterBudget` 生产端来自 `toolResultCharacters` 的正整数。
一个非当前缺陷：`memory-changes` 加进了 `ProductContextBlockKind`，但没有加进两个 envelope 白名单。它目前只在运行时合成、不落 envelope，所以安全；将来若把它写进 envelope，恢复时会被拒绝。
