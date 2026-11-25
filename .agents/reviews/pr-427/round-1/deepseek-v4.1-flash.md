## 复核发现（按严重度从高到低）

### 中

**1. 只有 handle 工具的会话里，模型会拿到 activity 参数却看不到图标表**【读代码证实的代码分支；触发条件为推测】

- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1379`、`:1386-1395`；`packages/runtime-pi/src/tool-activity.ts:49-52`；`apps/agent-service/src/production-runtime-tools.ts:405-415`、`:512-526`
- 问题：冻结开头的候选只根据 `frozenDefinitions` 决定是否加入“过程图标”一节，而真正发给模型的 `requestTools` 还包括 handle 工具，handle 工具同样会被加上 activity/activityIcon。
- 证据：
  - `pi-runtime-adapter.ts:1379`：`systemPrompt: productSystemPrompt(projection.systemInstruction, frozenDefinitions),`
  - `pi-runtime-adapter.ts:1386-1389`：没有 bundle 时却用 `descriptors.map(...)`。
  - `pi-runtime-adapter.ts:1390-1393`：`requestTools` 是 `bundle.tools` 加上 `handleDescriptors.map(...)`。
  - `production-runtime-tools.ts:405-415`：`fileReadEnabled === false ? [] : [...]`；`:512-526` 才追加 `authorized_*` 等 handle 工具。
  - `tool-activity.ts:49-52`：只有 `tools.some(carriesToolActivity)` 才返回图标表。
- 建议：图标表是否加入应按“本轮所有会发给模型的工具”判断，或在功能开启时无条件加入；不要只按冻结工具判断。补一条只含 handle 工具的用例。

**2. `event.input` 变更是否只作用于校验副本、历史与循环守卫是否真的看到去掉后的参数，没有测试锁定**【推测/未核实，测试缺口确认】

- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1532-1534`、`:1542-1545`；`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2605-2618`；`docs/adr/0250-tools-carry-model-written-activity-and-icon.md:40`、`:54`、`:88`
- 问题：ADR 的两条后果依赖“对话记录保留模型原样参数”和“工具循环停止的判断看到去掉后的参数”，但 `[ICON-1]` 只断言了 `preflight`、`tools.execute` 和 `tool_intent`，没有检查第二轮请求里的 assistant toolCall 参数，也没有检查 `tool_result` 的 `event.input`。
- 证据：
  - `pi-runtime-adapter.ts:1533`：`if (activityTools.has(event.toolName)) removeToolActivity(event.input);`
  - `pi-runtime-adapter.ts:1544`：`toolProgress.observe(event.toolName, event.input, ...)`，循环守卫的哈希直接吃 `event.input`。
  - 测试 `2609-2618` 只断言 `executed`/`preflight` 参数，没有断言第二次 `observedContext`。
- 建议：在 `[ICON-1]` 里检查第二次请求的 assistant toolCall 仍带 activity/activityIcon，同时检查 `tool_result` 的 `event.input` 已被剥掉；这样 ADR 的两条后果才有门禁。若 Pi 实际上把变异作用到 transcript，应改为在独立副本上删除，或明确接受并写进 ADR。

**3. 新契约字段是必填，旧客户端会整体解析失败**【读代码证实；旧手机是否已发布未核实】

- 文件：`packages/gateway-contracts/src/thread-contracts-v3.ts:605-606`；`packages/gateway-contracts/src/validation.ts:175`；`docs/adr/0250-tools-carry-model-written-activity-and-icon.md`（“网关契约变了”一段）
- 问题：`activity`、`activityIcon` 是必填 `displayText`，旧客户端解析新记录会报 `unknown field`（ADR 已承认），而不是只影响过程行显示。
- 证据：
  - `thread-contracts-v3.ts:605-606`：`activity: displayText, activityIcon: displayText,`
  - `validation.ts:175`：``if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");``
- 建议：若手机端尚未上线，写清楚上线顺序并在发布门槛里检查；若可能有旧客户端在线，先加可选字段并给默认值，或升契约版本。仅写“网页和服务器一起上线”不足以覆盖手机。

### 低

**4. 投影对所有工具都按“过程字段”处理，工具自己原有的 activity/activityIcon 会被误当成展示句子**【读代码证实，生产暂无此类工具】

- 文件：`packages/application/src/services/thread-execution-projection.ts:66-74`；`packages/runtime-pi/src/tool-activity.ts:16-21`；`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2596-2613`
- 问题：`withToolActivityParameters` 对已有同名参数的工具不加参数，但 `toolActivity()` 仍无条件把 `activity`/`activityIcon` 从任意工具参数里取出当过程句子，并把它们从 `input` 删除。测试里的 `diary_note` 就是这种工具。
- 证据：
  - `thread-execution-projection.ts:67-69`：`const { [TOOL_ACTIVITY_PARAMETER_NAME]: rawActivity, [TOOL_ACTIVITY_ICON_PARAMETER_NAME]: rawIcon, ...rest } = object(value);`
  - `tool-activity.ts:18-21`：只要已有同名键就 `return parameters;`
- 建议：按 `carriesToolActivity`（或显式注入标记）判断是否提取，不要只看键名；否则工具原生参数会被截到 80 字并从 `input` 消失。

**5. 图标名有两份“事实来源”，但没有一致性检查**【读代码证实】

- 文件：`packages/prompt-catalog/src/activity.ts:3-40` 与 `:73-81`；`:85` 只被投影用作白名单
- 问题：`PROCESS_ACTIVITY_ICONS` 数组和系统提示里的散列文字是两份独立数据，当前 36 个名字一致，但没有任何测试把两者绑在一起。以后加删图标只改一处不会被发现：模型可能被要求用服务器不认的名字（静默变成 `tools`），或服务器接受没在提示里列出的名字。
- 证据：`activity.ts:3` 的数组和 `:74-80` 的散列文字各自列举名字；全仓只有 `thread-execution-projection.ts:85` 使用这个数组。
- 建议：用 `{ name, description }` 一份数据生成系统提示文字和白名单；或至少加测试解析散列文字，断言与数组完全相等。

**6. 参数说明写“不超过 30 个字”，服务器上限是 80**【读代码证实】

- 文件：`packages/prompt-catalog/src/activity.ts:45`、`:55`；`packages/application/src/services/thread-execution-projection.ts:71-74`
- 问题：提示词要求 ≤30 字，服务器按 80 个码点截断，两端不一致，也没有测试。
- 证据：`activity.ts:45` `PROCESS_ACTIVITY_MAX_LENGTH = 80;`；`:55` `不超过 30 个字`；`projection.ts:73` `.slice(0, PROCESS_ACTIVITY_MAX_LENGTH)`。
- 建议：统一成一个常量，并让提示词由常量拼出，或明确 30 只是建议、80 是硬上限。

**7. 模型可控的 activity 文本没有清洗换行/控制字符/双向控制符**【读代码证实处理方式；影响为推测】

- 文件：`packages/application/src/services/thread-execution-projection.ts:71-74`
- 问题：只做了 `trim` 和按码点截断，换行、C0/C1 控制字符、RTL 覆盖符都会原样进入过程记录，手机端将来直接显示时可能多行或伪装。
- 证据：`rawActivity.trim()` 之后直接 `[...].slice(...).join("")`，没有任何字符过滤。
- 建议：在投影或共享契约里去掉换行和控制/双向字符，或将其替换为空格；补一条用例。

**8. 结束记录把 activity/activityIcon 置空，依赖客户端按 itemId 合并；网页合并没有测试，其他消费者不共享这段逻辑**【读代码证实代码，影响为推测】

- 文件：`packages/application/src/services/thread-execution-projection.ts:494-508`、`:221-225`；`apps/control-center/src/execution-view.ts:212-214`
- 问题：终态记录两个字段为空，只有网页 `executionItems` 做了“空不覆盖”；手机、`execution-timeline`、`thread-execution-state` 等消费者没有这份合并逻辑。若客户端取最后一条记录，完成步骤会丢句子和图标。
- 证据：
  - `projection.ts:501-507`：`...(ended ? {} : toolActivity(...))`，而 `base` 里 `activity: ""`、`activityIcon: ""`。
  - `execution-view.ts:213-214`：`activity: record.activity || previous?.activity || ""`。
  - `execution-view.unit.test.ts` 的改动只补了默认字段，没有断言 activity 的合并。
- 建议：让终态记录也带同样的 activity/activityIcon（最简单、所有消费者都安全），或把合并逻辑放进共享契约包并为它加测试；不要只靠网页这一处。

**9. 退回句子在每次读取时按当前 `answerLocale` 重新生成，历史显示可能随语言切换变化**【读代码证实，模型请求不受影响】

- 文件：`packages/application/src/services/thread-execution-projection.ts:71-74`、`:304`、`:506`
- 问题：`processStepText(toolName, thread.answerLocale)` 在读取时计算，而不是记录事件时固化；同一段 trace 在回答语言改变后重新读取会得到不同的 `activity` 文字。
- 证据：三处 `toolActivity(..., thread.answerLocale)` 都发生在投影读取路径。
- 建议：如果历史过程行要求稳定，应在事件写入时固化句子；若接受随当前语言显示，应在 ADR 里写清楚，并避免客户端缓存与重新读取混用。

---

## 侧重检查

- 错误路径：`removeToolActivity` 直接对 `event.input` 做 `delete`（`tool-activity.ts:44-46`），假定它一定是对象；Pi 的事件类型看起来是对象，但没有防御。`toolActivity()` 对非对象参数有 `object()` 兜底（`projection.ts:66`），`processStepText` 对未知语言和工具名有回退，未见崩溃路径。
- 不合规范/不可信输入：`activityIcon` 用 `PROCESS_ACTIVITY_ICONS.includes` 校验并回退 `tools`（`projection.ts:85-87`），这点做得对；`activity` 只有长度限制，没有字符清洗（见发现 7）。工具 schema 里的两个参数都是可选字符串，不会让缺参或未知图标导致工具调用失败。
- 安全：新增值来自模型，`activity` 会进入过程记录和 trace；trace 侧走 `redactObservation`（`pi-runtime-adapter.ts:2371`），未见新增日志泄漏。模型文本目前网页不渲染，手机端未在本仓库，无法核实。
- 资源耗尽：`[...rawActivity.trim()]` 会先展开整个字符串再截断（`projection.ts:73`），但模型输出有上限，且只对 `activity` 这个字段做，未发现新的无界循环或大对象复制。
- 不可撤销操作：没有数据库表结构变更；只有一次性的 prompt bundle 失效重建和契约形状变化，后者是发布风险（发现 3）。
- 规则/文档一致性：`prompt-prefix.md` 第 6 条允许因工具集合/参数结构变化一次性换新，ADR 0250 写了 Andy 的同意（“老对话的请求开头换新一次”），规则与代码一致；`docs/pi-development-guide.md` 已从“还没有测试锁住”改成引用 `[ICON-1]`，与代码一致。ADR 引用的 36 个图标和手机合并语义在 PR 405 提交 `f7cbbf01`，本仓库当前提交里 `docs/execution/specs/2026-11-11-apple-device-body-design.md` 没有“过程行/图标”一节，**这 36 个名字和手机端是否接受未核实**。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

会。这个版本相对旧版本的请求开头确实变了：系统提示末尾多了固定的“过程图标”一节（`pi-runtime-adapter.ts:607`），所有参数结构为对象的工具定义多了 `activity`、`activityIcon` 两个可选字符串（`tool-activity.ts:22-35`；builtin 和普通工具分别接在 `pi-runtime-adapter.ts:2063`、`:2077`）。所以它**不是只在末尾追加**，而是一次性的冻结开头换新；`thread-prompt-bundle-service.ts:204` 的 `toolSchemaChanged` 会在老对话的下一轮触发一次 `tool_schema_changed` 重建，这和 ADR 0250 记录的 Andy 同意、以及规则第 6 条一致。

换新之后，同一对话里图标表和工具 schema 固定，每轮变化的内容（时间、记忆等）仍在最后一条用户消息；模型自己写的 `activity`、`activityIcon` 属于追加的 assistant/toolCall 历史。需要注意发现 1：只有 handle 工具的会话里，“图标表已经在系统提示里”不成立；发现 2：历史是否真的保留模型原样参数还没有测试锁定。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

模型请求层面：新增文字都是固定的，工具属性顺序固定（先 `activity` 再 `activityIcon`），图标表用固定 `join("\n")`，没有时间、路径、无序集合；因此同一份输入序列化出的字节是确定的。遮盖方面，新增文本都在 `prompt-catalog` 的固定文字里，属于固定文字豁免；`activity` 来自工具参数，trace 侧会走 `redactObservation`，规则上看是确定的。

但有两处要注意：一是发现 2，若 Pi 的 `event.input` 变异会作用到 transcript，下一轮历史里的工具调用参数会和模型原输出不同，这需要真实运行时用例确认；二是发现 9，过程记录的退回句子是在读取时按当前 `answerLocale` 重算的，同一段 trace 可能在语言切换后显示不同文字（这只影响执行记录，不影响发给模型的字节）。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，且主要反向用例是有效的：

- `[ICON-1]`（`pi-runtime-adapter.compat.test.ts:2461`）：真实 Pi 会话，断言工具定义带新参数、图标表只出现一次、`preflight`/`tools.execute` 看不到新参数、工具自身同名参数保留、`tool_intent` 里仍有它们。若删除逻辑失效，`executed.get("activity-call")` 会变成 `{query, activity, activityIcon}`，测试会失败。
- `[ICON-2]` 契约（`thread-contracts-v3.contract.test.ts:440`）：缺 `activity` 会抛 `$.activity`，`activityIcon` 非字符串会抛；删除这两个反向用例是有效的。
- `[ICON-2]` 集成（`thread-run-lifecycle.test.ts:3801`）：真实 SQLite，断言退回 `tools`、`input` 不含 `activity`、每条记录都能过新契约。
- `[ICON-3]`（`step-summary.unit.test.ts:140`、`process-step.contract.test.ts:4`）：三种语言逐字对齐；`constructor`/`toString` 不会误判，这个反向用例也有效。

缺口：图标表散列文字与 `PROCESS_ACTIVITY_ICONS` 的一致性没有测试；只有 handle 工具的场景没有测试；网页“空值不覆盖”没有测试；30/80 没有测试；历史保留与 `tool_result` 循环守卫没有测试；老对话一次性 `tool_schema_changed` 重建依赖既有通用测试，这次没有专门的回归用例。依据规则不能运行测试，以上只按代码和测试内容判断。

**4. 每个新值，产生处和使用处都能接受吗？**

- `activity`/`activityIcon` 过程字段：产生处是 `ThreadExecutionProjection`，所有分支都从 `base` 带上字段（`projection.ts:221-225`），终态记录为 `""`；契约 `displayText` 接受任意 ≤65536 的字符串，网页 `executionItems` 能传播。手机端是否按同样规则合并、是否接受空字符串，本仓库看不到，**未核实**。
- `activity`/`activityIcon` 工具参数：产生处是 `withToolActivityParameters`，使用处是模型 schema、Pi 校验、`preflight`/审批/工具执行。`[ICON-1]` 证实执行和权限判断拿到的是去掉后的参数；工具自身同名参数不会被删。投影端却对所有工具都提取同名参数（发现 4），这是产生/使用两端不完全对齐的地方。
- 图标名清单：产生处是 `PROCESS_ACTIVITY_ICONS`，服务端校验使用同一数组，模型侧使用系统提示散列文字；两端目前一致，但没有测试绑定（发现 5）。手机端图标组件是否认识这 36 个名字，**未核实**。
- `processStepKind`/`PROCESS_STEP_TEXT`：产生处是 `gateway-contracts`，使用处是服务端退回和网页；`[ICON-3]` 锁住了三语文字，抽查 `web_search`、`web_fetch`、`reminder_set`、`rule_set`、`execution_task_start` 等名字与生产工具名一致。
- prompt manifest 新增的 `chat.process-icons-section`、`tools.activity-parameter`、`tools.activity-icon-parameter`：使用处是提示词目录清单校验；哈希是否等于实际 segments **未核实**（不能运行 `prompt-catalog.unit.test.ts`）。
- 契约字段是必填，使用这些字段的旧客户端会拒绝整条记录（发现 3）；这是本次改动最明确的跨端兼容风险。
