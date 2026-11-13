# PR 475 第 3 轮复核结论

先核对作者六条说法：第 1、3、4、5、6 条与代码一致；第 2 条的“读失败照常抛错”一致，但“写失败”在重放路径上仍有缺口（见 A1）；r1-7 / r2-4 按要求未再报。

---

## 一、读代码证实的发现（按严重度从高到低）

### A1. 中：重放已执行过的调用时，标记“写”失败仍会返回 `not_sent`

- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:1229-1252`、`apps/agent-service/src/context-external-content.ts:224-229`
- 问题：`execute` 只在错误是 `ExternalContentMarkNotWrittenError` 时返回“没发出”；而任何非冲突的 `commitStateAndEvents` 失败都会被包装成这个错误。标记是在 `#executeCanonical`/重放查找之前做的（`production-runtime-tools.ts:1301` 之后才进入 `#execute` 的 `existing = await artifacts.lookup(intentKey)` 重放分支）。ADR 第 208 行说“读不出对话状态时照常报错，因为重放的调用上一次可能已经执行过”，但对“写失败”没有同样的豁免。
- 证据：

```ts
// production-runtime-tools.ts:1229-1232
try {
  await this.#markExternalContent(invocation);
} catch (error) {
  if (!(error instanceof ExternalContentMarkNotWrittenError)) throw error;
```

```ts
// context-external-content.ts:224-229
} catch (error) {
  if (!isConflict(error)) throw new ExternalContentMarkNotWrittenError(error);
  lastError = error;
}
...
throw new ExternalContentMarkNotWrittenError(lastError);
```

- 建议：在重放分支已能读出“上次结果”时，不要把标记写失败解释成“没发出”；可以先用重放记录判断本次是否只是重放，或把标记放到“确认要真正发送”的分支之前、重放查找之后。若坚持先标记，至少在返回 `not_sent` 前检查是否存在已执行结果。
- 说明：`not_sent` 这个返回路径本身是证实的；能触发它的前提（上次已执行但当前 origin 对应的标记不存在，例如工具表/配置变化导致 origin 名称变化，或标记状态丢失）属于推测，现场未核实。

### A2. 中：标记队列没有超时，单个“挂住不返回”的写会永久阻塞同一对话后续所有标记

- 文件:行：`apps/agent-service/src/context-external-content.ts:185-192`
- 问题：队列只处理“失败”（`previous.catch(() => undefined)`），不处理“永远不 settle”。`#write` 里的 `readScopedState` / `commitStateAndEvents` 只要有一个一直 pending，后面同一 key 的 `mark` 全部排在它后面，等待标记的工具调用也一起挂住。写失败不会让 `#pending` 越积越多（失败会被 catch 成下一环继续），但“挂起”会。是否真的会无限挂起取决于 SQLite 端口实现，未核实。
- 证据：

```ts
const previous = this.#pending.get(key) ?? Promise.resolve();
const current = previous.catch(() => undefined).then(() => this.#write(key, runId, origin));
this.#pending.set(key, current);
try {
  await current;
} finally {
  if (this.#pending.get(key) === current) this.#pending.delete(key);
}
```

- 建议：给排队中的写加可中断的超时/取消（与现有 runtime 请求超时一致），或让后续写不依赖前一个 unsettled promise；至少不要让工具执行无限期等待标记。
- 结论：失败不会卡住后续写，`#pending` 也不会因失败积累；但“卡死”无保护。

### A3. 低：缺少“第一次写失败后，下一次写仍然成功”的自动检查

- 文件:行：`apps/agent-service/test/context-external-content.unit.test.ts:121-135`、`:146-177`
- 问题：用户特别问的这条没有被覆盖。现有用例只有“单个写失败被区分”和“12 个并发来源全部成功”，没有“A 写失败 → 同一 key 的 B 随后写成功”的顺序用例；因此 `previous.catch(() => undefined)` 这行如果被改错，测试不一定报出来。
- 建议：加一条反向/续作用例：第一次提交抛错，第二次提交成功，断言第二次的 origin 真的落盘、提交次数符合预期。

### A4. 低：来源名/记录编号截断可能把不同的来源或记录变成同一字节，削弱“按记录编号区分”的保证

- 文件:行：`apps/agent-service/src/context-external-content.ts:37-42`
- 问题：先对 origin 做 `slice(0, 256)`，再去重、排序，然后按剩余空间截 recordId。两个只在第 256 个字符之后不同的 origin 会合并；两个只在 `room` 之后不同的 recordId 也会得到相同的 ref。ADR 第 218 行写“标记按记录编号区分，同来源去重不会因为标记把两条记录并在一起”，在超长输入下不再成立。
- 证据：

```ts
return [...new Set(origins.map((origin) => origin.slice(0, ORIGIN_IN_REF_LIMIT)))]
  .sort((left, right) => left.localeCompare(right, "en"))
  .map((origin) => {
    const room = SOURCE_REF_LIMIT - EXTERNAL_CONTENT_SOURCE_REF_PREFIX.length - 1 - origin.length;
    return `${EXTERNAL_CONTENT_SOURCE_REF_PREFIX}${recordId.slice(0, room)}|${origin}`;
  });
```

- 建议：超长时保留哈希后缀（如截断部分 + 哈希前几位），既保证 ≤512，又避免碰撞；测试补一条“两个前缀相同、尾部不同”的用例。
- 触发概率：当前 origin 主要来自内置工具名，recordId 主要是 payload/记忆编号，通常远短于限制；属于低概率。

### A5. 低：ADR 写“最多 512/256 个字符”，代码实际按 UTF-16 code unit 计算，可能截断代理对

- 文件:行：`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:218`、`apps/agent-service/src/context-external-content.ts:37-42`
- 问题：`.length`/`.slice` 计的是 UTF-16 code unit，`slice` 可能切出孤立代理项；ADR 的“字符”与代码语义不完全一致。网关 `boundedString` 也用 `.length`（`packages/gateway-contracts/src/validation.ts:89-105`），所以不会造成校验失败，属于文档精度问题。
- 建议：把 ADR 写成“UTF-16 code unit”或改成按 `Array.from` 处理完整字符。

---

## 二、推测 / 未核实

### B1. 低（推测）：A1 的具体触发条件

上次已执行且标记已存在时，`#write` 会在 `sources.some(source => source.origin === origin)` 处提前返回（`context-external-content.ts:201`），不会走到 commit 失败。要触发 A1，需要“上次执行过，但这次 origin 对应的标记不存在”，例如：

- 工具表/`publicSearch`/`publicFetch` 配置变化导致 `#contentOrigin` 返回不同的 origin；
- 状态存储丢失或回滚。

这两种情况是否会在生产重放中出现，未核实。

### B2. 低（推测）：捕获测试的运行来源桩与生产 `runExecutionSource` 语义不完全一致

- 测试桩：`test/integration/production-memory-capture.test.ts:248-265`，只要找到 owner 消息就返回 `threadId: THREAD_ID`，不检查线程是否仍 open。
- 生产：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1530-1534` 要求 run 的线程 `status='open' AND archived_at IS NULL`，否则整行不返回。
- 影响：`ProductionMemoryCapture.#plan` 本来就会先 `sources.read(sourceRunId)`，读不到直接返回（`production-memory-capture.ts:1086-1087`），所以正常路径不会出现“线程已归档还捕获”的情况。只有 `#plan` 读到线程之后、`mark` 内部第二次 `#scopes` 再读时线程刚好归档的窄竞态，才可能把线程标记读丢（此时会退回只读 run key）；是否可实际触发未核实。
- 建议：测试桩按生产语义校验线程状态，或让捕获改用已知的 `threadId` 读 `readThread`，避免二次依赖 `runExecutionSource`。

### B3. 低（推测，I-73 类）：旧的拒绝审计行与新 `targetRef` 不兼容

`#audit` 的审计 id 公式仍是 `digest([intent.id, "refused:<规则编号>"])`，但 `targetRef` 从旧的 `intent.id` 改成了 `action-refusal:<intent.id>`，`occurredAt` 也改为取状态记录里的时间（`owner-scope-authorization.ts:362-370`）。`appendAuditRecord` 遇到重复 id 会逐字段比较，任何不同都重新抛错（`owner-policy-authorization.ts:20-32`）。如果部署库里已有旧版本写下的同 id 审计行，重放旧 intent 可能把“规则拒绝”变成 `authorization_component_error`。是否已有旧行、旧 intent 是否会在升级后重放，未核实；如果该功能尚未发布，则不存在此问题。

### B4. 低（推测，安全前瞻）：`preauthorizeOwnTaskCancel` 的表达式比“取消”更宽

- 文件:行：`packages/application/src/rules/action-rules.ts:198-202`
- 表达式是 `target_type == "managed-task" && action_kind == "CREATE_OR_UPDATE"`，没有限定 `operation == "cancel"`。当前登记表里只有 cancel 是这个组合，所以现在是对的；以后新增一个同为 `managed-task` + `CREATE_OR_UPDATE` 的任务操作，会被自动预先授权。属于未来风险，不是当前 bug。

### B5. 低（未核实）：拒绝记录状态只增不删

新增的 `action-refusal:<intentId>` 每次唯一拒绝都会写一条 `product_state_records`，没有清理/过期逻辑；`externalSources` 也会复制进每条拒绝记录。长期看是资源增长，但每条内容很小，且现有设计“只追加不删除”，未核实是否有其他清理机制。

---

## 三、侧重检查

- **错误路径**
  - 标记写失败：单次 `execute` 返回 `not_sent`，确认。
  - 标记读失败：`#write` 的第一次 `readScopedState` 在 try 外（`context-external-content.ts:199`），不会被包装；`#scopes` 的 `source.read` 也在 try 外，确认不会误归为“写不进去”。
  - 队列失败：失败被 `previous.catch(() => undefined)` 吸收，后续写继续；`#pending` 在最后一环的 `finally` 删除，失败不会永久占位，确认。
  - 队列挂起：无超时，见 A2，风险确认但“会无限挂起”未核实。
  - 拒绝状态写冲突：`#audit` 在 commit 失败后重新读，读到别的写者记录就接受（`owner-scope-authorization.ts:356-361`），测试覆盖 raced true/false，确认。
  - 捕获/复盘读标记失败会让整个捕获/复盘失败（`production-memory-capture.ts:1209-1212`、`production-memory-conversation-review.ts:734`），这是新增的可用性耦合；是否可接受属设计取舍，未核实产品要求。
- **不合规范/不可信输入**
  - origin 主要来自内置工具表、`authorized:<能力名>` / `unregistered:<能力名>`，不是模型直接写的自由文本；`externalContentSourceRefs` 不做解析，只有前缀判断，注入 `|` 不会改变消费端行为。
  - 截断碰撞见 A4；控制字符由网关 `boundedString` 拒绝（`validation.ts:89-105`），但本地写入端没有先行校验。
  - `#audit` 的 `externalSources` 来自状态，长度/数量没有上限，见 B5。
- **安全**
  - 读过外来内容后“有后果的动作先问”、后台“不做”由 `askAfterExternalContent` / `refuseBackgroundAfterExternalContent` 覆盖；`context_external_content` 事实已登记三种语言。
  - 同一轮并行发出的“读外来内容”和“有后果动作”不会互相看见对方的标记；但模型在看到读结果之前就发出了动作，因此不构成“被该内容诱导”的注入路径，未按漏洞报告。
  - 任务取消现在走 owner scope，且被专用规则直接授权；当前登记表只有 cancel 匹配，B4 是未来风险。
- **不可撤销操作**
  - `preauthorizeOwnerData` 仍要求 `reversible == 1`；新增的直接授权只有任务取消（`reversible: false`），属于 ADR 明确取舍。
- **规则文件、说明文档、代码一致性**
  - ADR 第 200 行“第 1 步真正起作用的列”已挪回原段，确认。
  - ADR 第 208 行读/写失败区分与代码基本一致，但重放写失败有 A1 缺口。
  - ADR 第 217 行排队写与 5 次重试，与代码一致。
  - ADR 第 218 行 512/256 限制与代码一致（字符语义见 A5）。
  - ADR 第 225 行拒绝记录 `targetRef` 与 `#audit` 一致；旧行兼容见 B3。
  - ADR 第 228 行“审批原因使用处改成网关快照”与 `governance-gateway-adapter.ts:385-391` 一致；control-center 不读 `askedBecause`，与文档一致。
  - ADR 第 229 行内置规则开关的键、命令类型、动作值与代码一致。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 依据：

- 本改动的标记只写入 `product_state_records`，供授权、来源记录、记忆 `sourceRefs` 使用；没有改系统提示、工具定义、历史消息或遮盖规则。
- 每轮变化的值（时间、运行环境、本轮记忆）本来就在最后一条用户消息里：`packages/runtime-pi/src/pi-runtime-adapter.ts:644-662` 的 `turnPrompt` 把它们放在 `<himawari-context>` 和 `<owner-message>` 中。
- `production-run-memory.ts:465` 把记忆的 `sourceRef` 改成第一个非 `external-content:` 引用，反而稳定了上下文块 metadata 里的来源值；该 metadata 在最后一条用户消息里（`runtime-environment-block.ts:30-42`），不是在请求开头。
- 遮盖没有改；`context-external-content` 的值为 `firstSeenAt` 等时间字段，但只存状态，不进入模型输入。
- 结论：仍然只追加；每轮变化的值都在最后一条消息；请求开头不变。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会（就本改动新增的值而言）。**

- 来源列表在写入时按 origin 排序（`context-external-content.ts:203-205`）；`externalContentSourceRefs` 去重后排序（`:37-38`）。
- `#externalSources` 用 `new Set(...).sort()`（`owner-scope-authorization.ts:235`）；`askedBecause` 按排序后的来源取前 5 个（`:93-102`）。
- `parameterFingerprint` 使用递归排序键的 `stable`（`owner-scope-authorization.ts:35-41`），同一参数得到同一指纹。
- `read` 固定先读线程 key 再读 run key（`context-external-content.ts:168-178`），顺序确定。
- `firstSeenAt`、`firstRunId` 是时间/历史字段，但只存状态，不进入模型可见文本。
- 唯一保留的既有问题是 `localeCompare(..., "en")` 依赖 ICU 版本，但这是改动前就有的写法，不是本次新增；同一进程内确定。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，且有多个真实反向用例；但有一个明确缺口。**（只做静态核对，没有运行测试命令。）

- `apps/agent-service/test/context-external-content.unit.test.ts`
  - 截断用例（`:62-68`）：如果改回“整条字符串直接 slice”，对 600 字符 recordId，`endsWith("|web_fetch")` 会失败，反向真实。
  - 写失败/读失败区分：若把读失败也包成 `ExternalContentMarkNotWrittenError`，`expect(error).not.toBeInstanceOf(...)` 会失败，反向真实。
  - 12 个并发来源：若去掉队列，冲突重试会导致提交次数/内容不符，反向真实。
  - **缺口**：没有“写失败后同一 key 再写成功”的用例（A3）。
- `test/integration/production-memory-capture.test.ts`
  - 使用真实 `ContextExternalContent`，并加“只有别的对话读过不带标记”的反向；若实现读所有线程标记，反向会失败。
- `test/integration/memory-conversation-review.test.ts`
  - 同样按 `episode.threadId` 读自己的标记，别的线程的标记不生效；反向真实。
- `test/integration/tool-action-registry.test.ts`
  - 写失败返回 `not_sent`；重放读失败不返回 `not_sent`；拒绝记录冲突 raced true/false 两支；规则开关冲突重试 3 次；卡片原因来源截断。若对应逻辑被改反向，测试会失败。
- `test/tooling/rule-ids-frozen.test.ts`
  - 新增/改名的内置规则编号会同时报“缺失”和“未冻结”，反向真实。
- 配置与拒绝次数：`startup-configuration.unit.test.ts`、`pi-tool-progress-guard.compat.test.ts` 覆盖范围和上限。
- **未覆盖**：队列“挂起”无测试（难以稳定构造，A2）；A1 的“重放 + 写失败 + origin 变化”无测试；B2 的线程归档竞态无测试。

### 4. 每个新值/改动的两端是否都能接受？

逐项核对结果：

| 值/字段 | 产生处 | 使用处与两端校验 | 结论 |
| --- | --- | --- | --- |
| 新增内置规则编号（4 个） | `packages/application/src/rules/action-rules.ts` | 冻结清单 `test/tooling/rule-ids.frozen.json`；网关 `machineString` 1-128；规则快照 `ruleId: machineString` | 接受；编号均符合 |
| `context_external_content` 事实码 | `owner-scope-authorization.ts` | `policy-fact-registry.ts` 有定义、三种语言；字段目录/规则闸门 | 接受 |
| `target_type` 闸门字段 | `actionGateFacts`（`action-rules.ts`） | `field-catalog.ts` 登记为 string；规则表达式可用 | 接受 |
| `external-content:<记录编号>\|<来源>`，≤512 | `externalContentSourceRefs` | 网关 `sourceRefs: array(boundedString(512))`；`MEMORY_SOURCE_REF_MAX_LENGTH=512`；`memory_provenance` 无长度限制 | 接受；长度可正好 512，不越界 |
| 规则 `source` ≤256 | `production-owner-rules.ts:ruleSource` | `sqlite-owner-rule-operations.ts:123` 要求 1..256；`slice(0,256)` | 接受 |
| `builtIn` 快照字段 | `production-memory-control.ts:814` | `contracts-v2.ts`：`ruleId` machineString、`revision` integer、`outcome` 枚举、计数 integer、`askFirst` nullable boolean | 接受 |
| `memory.rule.respond` 新动作 `ask_first`/`allow_directly` | 控制中心 | `OWNER_RULE_ACTIONS` 已扩展；`ProductionMemoryControl` 新分支转给 `setAskFirst` | 接受 |
| 开关键 `action-rule:<编号>` 与命令 `authorization.action_rule.set` | `action-rule-switches.ts` | `owner-scope-authorization.ts` 的 `#standingAuthorization` 读同一键；持久化层无命令类型白名单 | 接受 |
| `action-refusal:<intentId>` 与审计 `targetRef` | `owner-scope-authorization.ts:324,367` | 持久化 key 无长度限制；测试按同一函数核对 | 接受；旧审计行兼容见 B3（推测） |
| `runPolicy.toolRefusals.{consecutive,total}` | `strict-configuration.ts` | 解析范围 1..1000 / 1..10000；`PiToolProgressGuard` 再校验；默认 3/20 | 接受 |
| 工具结果 `refused?: true` | `runtime-tool-authorization.ts` | `RuntimeToolSettledResult`、Pi 适配器、进度守卫 | 接受 |
| `ownerAttachments` | `ContextProjectionService` | `RuntimeProjection` 类型；只用于标记，不序列化进请求 | 接受 |
| `#pending` / `ExternalContentMarkNotWrittenError` | `context-external-content.ts` | 进程内工具/授权/捕获共用实例；跨进程靠冲突重试 | 接受；A1/A2 为边界风险 |

---

## 五、总体判断

- 本轮改动方向正确，作者六条说法基本属实；抽取 `runExternalOrigins` / `threadExternalOrigins` 是等价重构，读/写失败区分在正常路径上成立。
- 最值得补的两点：**重放路径的写失败仍可能报“没发出”（A1）**，以及**队列对挂起写没有超时（A2）**；其次是**补“写失败后下一次写仍成功”的测试（A3）**。
- 未发现会改变模型已发请求开头、或让同一段文字在不同请求中产生不同字节的改动；未发现新的高危安全漏洞；不可撤销操作仍受既有规则约束。
