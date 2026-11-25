## 本轮范围

这一轮我重点看了四处：`1636c573..2149fb7e1` 的修复提交（`owner-profile-service.ts` 的预算算法、单测、两份文档），`2149fb7e1..f4b180b` 的合入 main（只合入 PR 634 的 delivery timing 删除和无关 UI/Apple 改动，未触及 memory snapshot 相关文件），以及运行端 `memory-snapshot-block.ts`、`pi-runtime-adapter.ts` 的压缩补发、prompt catalog/manifest、`context-formation-service`、`conversationTurn.span` 的 SQL 与组合接线。没有运行测试、lint 或真实遮盖检查（工具受限）；`.agents/reviews` 的轮次记录不在当前工作树，无法读取。

---

### 1. 【中】记忆清单预算是按“默认主模型”的窗口算的，不是本轮实际模型的窗口

`apps/agent-service/src/service-main.ts:1588-1598`、`apps/agent-service/src/production-run-policy.ts:72-76`、`apps/agent-service/src/production-magpie-models.ts:131`、`apps/agent-service/src/production-run-composition.ts:325-327`、`packages/application/src/services/owner-profile-service.ts:529`

问题：`memorySnapshotCharacters` 在组合时只取 `configuration.modelDescriptors.find(role === "primary")` 的第一个模型窗口，然后整个租户的所有 Run 共用这一个预算；但每个 Run 可以由 `source.modelSelection.modelRef` 选择别的 primary 模型，Magpie 新增的 primary 又各自的 `contextWindow` 不同。选到窗口更小的模型时，快照仍按默认大模型的 10% 生成，可能明显超过该模型窗口的 10%，甚至挤爆上下文。作者“预算＝窗口 10%”的说法对非默认模型不成立。

证据（亲自读到的代码）：

```
// service-main.ts:1588-1598
const primaryModel = configuration.modelDescriptors.find(
  (descriptor) => descriptor.role === "primary",
);
...
const memorySnapshotCharacters = toolResultCharacters(
  primaryModel && "contextWindow" in primaryModel ? primaryModel.contextWindow : undefined,
  MEMORY_SNAPSHOT_WINDOW_SHARE,
);
```

```
// production-run-policy.ts:72-76
const selected = source.modelSelection
  ? configuration.modelDescriptors.find(
      (model) => model.ref === source.modelSelection?.modelRef && model.role !== "embedding",
    )
  : primary;
```

```
// production-magpie-models.ts:131（每个新增 primary 用自己的窗口）
contextWindow: entry.contextWindow,
```

建议：把预算做成按 Run 计算的函数，用该 Run 实际绑定的模型窗口乘 10%；或者至少在组合时取所有可选 primary 的最小窗口并夹住，避免小窗口模型被大预算撑爆。

---

### 2. 【中低】“记忆变化”在部分省略的类别里，会把真正作废的记忆一并吞掉

`packages/runtime-pi/src/memory-snapshot-block.ts:208-218`、`packages/runtime-pi/src/memory-snapshot-block.ts:228-242`

问题：`omittedSections()` 只要某类别出现一条“另有 N 条因篇幅没有列出”，就把整个类别加入集合；`changesSince()` 对该类别里的**所有**旧条目都不报“已不再有效”。如果旧清单里同类有 A、B 显示、C 被省略，之后 B 真的作废、而 C 仍因预算被省略，B 的失效就永远不报。设计里“只有记忆变化这一段能告诉她它已作废”的目的在这类场景下失效。

证据（亲自读到的代码）：

```
function omittedSections(snapshot: string): ReadonlySet<string> {
  ...
  if (count >= 0) sections.add(line.slice(OMITTED_PREFIX.length, count));
}
```

```
else if (old && !now && !omitted.has(old.section))
  lines.push(renderPrompt(CHAT_MEMORY_CHANGE_REMOVED, { line: old.line }));
```

现有单测只覆盖“整类省略时不要误报失效”和“另一类省略时本类仍报失效”，没有覆盖“同一类部分省略时本类真正失效仍要报”的反向用例。

建议：至少把“本类有省略”与“本类全部省略”分开判断；或在快照里保留每类被省略的编号/数量变化，用旧显示条目与新省略数量的差值判断哪些消失不是省略造成的。若无法区分，报“已不再有效，或未列出”也比完全不报更安全。

---

### 3. 【低】去掉 owner-profile 块后，profile 预算的“上下文截断”记录仍被界面显示成“回答时没带上的旧内容”

`packages/application/src/services/owner-profile-service.ts:258-283`、`packages/application/src/services/context-formation-service.ts:344-374`、`apps/control-center/src/components/proactive-reminders.tsx:346`、`apps/control-center/src/i18n/resources/zh-CN.ts:1383`

问题：`#select` 仍把 2000 字预算下没放进的 `factLines` 放进 `usage.queued`，`ContextFormationService` 仍以 `profile_budget_exceeded` 写 `context_truncation` 记录；但档案记忆现在会进 `memory-snapshot`，很多 `queued` 的记忆其实在清单里。控制中心把它标成“回答时没带上的旧内容”，与事实不符。这是修改 `usage.queued` 语义后没有同步的消费端。

证据（亲自读到的代码）：

```
// owner-profile-service.ts:275-277
if (length > remaining) {
  queued.push(memory.id);
```

```
// context-formation-service.ts:348-363
if ( ... usage.queued.length > 0 ... ) {
  ... kind: "context_truncation",
      reasonCode: ... PROFILE_BUDGET_EXCEEDED,
      inputs: { memoryIds: [...usage.queued].sort().slice(0, 200), ... }
```

```
// zh-CN.ts:1383（context_truncation 的界面文字）
context_truncation {回答时没带上的旧内容}
```

建议：只把规则类 `queued` 写进用户可见的“裁剪”记录，或为档案超出 2000 单独用不会暗示“模型看不到”的 reason/文案；同时更新 M-3 里“只影响用量提示和下面的记录”的说法。

---

### 4. 【低】当前清单为空时不再产生“记忆变化”，已发清单里的记忆全部作废也不会告诉模型

`packages/application/src/services/owner-profile-service.ts:528`、`packages/runtime-pi/src/memory-snapshot-block.ts:259-262`

问题：`#snapshot` 在没有任何可列出记忆、且没有旧对话 span 时返回 `undefined`。`splitMemorySnapshot` 看到当前没有 `memory-snapshot` 块，就直接返回 `changes: undefined`。于是“上一次清单里的记忆全部被删/全部失效、且这时没有旧对话可查”的场景，模型不会收到任何“已不再有效”。

证据（亲自读到的代码）：

```
// owner-profile-service.ts:528
if (lines.length === 0 && !span) return undefined;
```

```
// memory-snapshot-block.ts:259
if (!current) return { blocks, snapshot: undefined, changes: undefined };
```

建议：如果历史里已有清单而当前清单为空，仍生成一个只带表头和“你还能查到的”的空清单，让 `changesSince` 能算出全部失效；或专门处理“previous 有、current 无”的删除通知。

---

### 5. 【低】清单会静默漏掉没有编号或读不出正文的记忆，且不计入“另有 N 条”

`packages/application/src/services/owner-profile-service.ts:508-519`、`packages/application/src/services/owner-profile-service.ts:560-565`

问题：`numbers` 查不到编号、或 `readText` 返回空时，代码直接 `continue`，这些记忆不会进入 `lines`，也不会进入任何 `entries.length`，因此省略行不会把它们算进去。模型会以为清单是完整的；这与设计“没递给她的部分必须告诉她都有什么”不一致。

证据（亲自读到的代码）：

```
const number = numbers.get(memory.id);
if (number === undefined) continue;
const text = (await this.#options.readText(memory))?.replace(/\s+/gu, " ").trim();
if (!text) continue;
```

```
const shown = entries.filter(({ memory }) => kept.has(memory.id));
...
if (shown.length < entries.length)
  omitted.push(omittedLine(title, entries.length - shown.length));
```

建议：按类别统计“拿不到正文/没有编号”的条数并并入省略行，或单独提示模型“有些记忆暂时打不开”；至少写日志/决策记录。

---

### 6. 【低】清单块的分类只统计“显示出来的”记忆，被省略的敏感记忆不计入

`packages/application/src/services/owner-profile-service.ts:601-605`、`packages/application/src/services/owner-profile-service.ts:614-618`

问题：`#snapshot` 返回的 `memories` 只有 `kept`，`#block` 用 `floor`（旧对话级别）加这些记忆算 `dataClassification`。如果一条敏感记忆因预算被省略，它的类别/条数仍出现在清单尾部，但清单块可能只被标成 private。审计/遮盖分类会低估这份内容。

证据（亲自读到的代码）：

```
return {
  text,
  memories: lines.filter(({ memory }) => kept.has(memory.id)).map(({ memory }) => memory),
  floor: span?.dataClassification,
};
```

```
const dataClassification = highestClassification(
  floor ?? "public",
  memories.map(({ dataClassification }) => dataClassification),
);
```

建议：分类至少按所有 `lines`（含未列出）计算，或按“省略行的类别/条数”额外抬升；如果认为省略行只是元数据，也要在文档里写清这个取舍。

---

### 7. 【低】固定部分本身超过预算时仍会超，旧对话月份列表没有上限

`packages/application/src/services/owner-profile-service.ts:539-556`、`packages/application/src/services/owner-profile-service.ts:568-600`

问题：`fitWithinLimit()` 只把 `remaining` 扣成负数，然后所有记忆行都被跳过；`render()` 仍会原样输出表头 + “你还能查到的” + 省略行。旧对话的 `span.months` 由数据库里所有月份生成，没有条数上限。窗口较小或主人用很多年时，固定部分本身就能超过 `snapshotCharacterBudget`，与“上限”冲突。当前生产默认窗口 1M 时风险较小，但配置不是固定的。

证据（亲自读到的代码）：

```
let remaining =
  limit +
  1 -
  cost([MEMORY_SNAPSHOT_HEADER.text, ...reachable]) -
  cost(...);
...
if (needed > remaining) continue;
```

```
months: span.months
  .map(({ month, days }) => renderPrompt(MEMORY_SNAPSHOT_MONTH, { month, days: String(days) }))
  .join("，"),
```

建议：对月份列表也设上限/截断，固定部分超预算时明确截断或抛错；或者把预算定义成“软上限”并写进文档。

---

### 8. 【低】关键新路径缺少端到端检查，文档引用的测试名也已过期

`packages/runtime-pi/src/pi-runtime-adapter.ts:1883-1887`、`packages/runtime-pi/test/prompt-prefix.compat.test.ts:864-872`、`docs/agent-rulebook-inventory.md:153`

问题：`memorySnapshotAfterCompaction` 的纯函数有单测（包括“已补发不再补”的反向），但新加的适配器调用只照抄了运行环境的分支，没有像运行环境那样有真实适配器级的 `willRetry` 用例；“记忆变化只在最后一条消息、请求开头不变”也没有 I-66 请求前缀用例，现有前缀测试只断言清单首轮出现、后续不出现。此外 M-3 仍引用不存在的测试名“stays within the character budget”（实际测试是“keeps the whole memory list within its budget”），并且“被挤掉的档案记忆模型照样能在清单里看到”也不总成立（清单自身还会省略）。

建议：补一个 `pi-runtime-adapter.compat.test.ts` 的内存清单压缩补发用例；在 `prompt-prefix.compat.test.ts` 增加“某条记忆变化后，变化只在最后一条消息、前一条请求开头逐字节不变”的用例；修正 M-3 的测试名和“照样能看到”的措辞。

---

## 侧重检查

- **错误路径**：清单为空且无旧对话时静默不报失效（意见 4）；编号缺失/正文读不出时静默漏列（意见 5）。
- **不合规范或不可信输入**：记忆正文统一把空白压成空格，因此无法在清单里插入换行级标记或伪 `</himawari-context>`，这一点是安全的；`entries` 对数字开头的正文、带括号的“待确认”类别有单测覆盖，未见解析错。
- **安全/分类**：清单块分类只按显示条目算（意见 6）；旧对话 span 的 `dataClassification` 会抬升块级别，这部分正确。
- **资源耗尽**：预算按默认主模型窗口算（意见 1）、月份列表无上限（意见 7）；`numbers` 分批 10000 与 SQL 上限一致，未发现越界。
- **不可撤销的操作**：本改动只读记忆、发自定义消息，无删除/覆盖类不可撤销操作。
- **规则/文档/代码一致性**：M-3 已从“档案和规则共用 2000 字、被挤掉模型看不到”改成区分记忆清单，方向正确；但夸大了被挤掉档案的可见性，测试名过期（意见 8），且 `usage.queued` 的界面文案未同步（意见 3）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 系统提示：`ThreadPromptBundleService` 只在 `promptBundleChange` 返回变化时重建，`systemPrompt` 文字本身不参与比较（`thread-prompt-bundle-service.ts:81-94`、`:166-188`），所以旧对话继续用旧系统提示，新的 `CHAT_IDENTITY` 只对新对话或会触发重建的对话生效。工具定义本 PR 没有增删。
   - 已发内容：清单只在“本段历史里找不到上一条清单”时插入最后一条用户消息；之后只把“记忆变化”放最后一条消息。清单注入是追加，不改旧消息。压缩时补发清单是压缩例外，属于规则允许的成批换开头。
   - 遮盖：没有发现会让旧消息重新遮盖的新逻辑。旧 `CHAT_IDENTITY` 句子从固定文字清单里移除在理论上会影响遮盖清单，但这句话里没有像密码/验证码的值；未运行真实遮盖检查，标“未核实”。
   - 结论：符合“只追加、会变的值在最后一条消息”；旧对话的系统提示按对话冻结，这一点没有变。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - 清单本身在生成时是确定的：类别固定、类别内按编号排序、超预算按重要度/更新时间/编号排序、旧对话月份按月份排序；没有当前时间字段，只有数据库里的日期范围。
   - 清单一旦发出就冻结；后续请求不会重发同一段清单，只发最后一条消息里的变化。`span` 的新日期范围只会进入新生成的清单（新对话或压缩后），不会回头改旧消息。
   - 未发现新的非确定性来源。唯一理论点是提示词文字变更会影响固定文字遮盖清单，但本次改动的文字不含敏感模式；没有实际测出字节变化。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 预算修复有单测：全放得下时输出不变、预算等于全长时逐字相同、从固定部分到全长的每个预算都断言 `text.length <= budget`。从代码看旧实现会在部分预算上超限，测试应当能抓住；我没有运行，不能独立确认“旧代码上失败”这一句。
   - 记忆变化有较完整的纯函数单测：新增/改为/失效、数字开头的正文、带括号的类别、省略类别不误报、标记伪装、压缩后重发、已重发不重发。
   - 缺口：没有“同类部分省略时真正失效仍要报”的反向用例；没有“主人在 owner-message 里打同样的字不算清单”的用例；没有适配器级压缩补发用例；没有请求前缀级的“变化只在最后一条消息”用例。文档引用的测试名也不存在（意见 8）。

4. **改动产生或修改的每个值，使用端都能接受吗？**
   - `memory-snapshot`：`context-formation-service.ts:823` 和 `context-projection-service.ts:775` 两个持久化信封校验都接受；旧的 `owner-profile` 仍被接受，旧运行可投影（有集成测试）。`memory-changes` 只存在于运行时投影，不写回持久化信封，未发现校验缺口。
   - `himawari.memory-snapshot` 自定义消息：`pi-native-history.ts:55-66` 只跳过 `himawari.context.block`，其余 custom 消息保留，解析端 `memory-snapshot-block.ts` 也认它。
   - `conversationTurn.span`：端口、`durable-adapters.ts:1434`、`sqlite-conversation-turn-operations.ts:108-115` 和 SQL scope 都接上了；集成测试覆盖了 allowed classification、owner/agent、trashed thread。
   - `snapshotCharacterBudget` / `memorySnapshotCharacters`：使用端 `owner-profile-service.ts:529` 接受，但产生端按默认主模型窗口算，和实际 Run 模型不匹配（意见 1）。
   - `numbers`：所有生产/测试构造 `OwnerProfileService` 的地方都用完整 `productMemoryState()`，分批 10000 与 SQL 的 10000 上限一致。
   - `usage.queued`：消费端 `ContextFormationService` 和界面文案仍把它当成“回答时没带上的旧内容”，但档案记忆现在多半已在清单里（意见 3）。
   - 新增 prompt 条目在 `prompt-manifest.json` 中都有 ID；manifest 的 hash 未逐一重算，标“未核实”。
   - 上一轮意见：预算“整份清单”已按表头、类别行、你还能查到的、省略行一起扣（`owner-profile-service.ts:568-600`），意见 1 已改好；M-3 已改写规则/档案预算的说明，意见 5 基本改好，但仍留下上述文档措辞和测试名问题。
