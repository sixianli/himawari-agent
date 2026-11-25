先说明：我只能读代码和跑 git diff/log/show，不能运行测试或计算 sha256，所以「测试全过」「哈希值正确」这类运行结果我标为未核实。

## 结论概要

第 3 轮的三处代码修改（句柄工具改看 `bundle.tools`、网页合并图标空值不覆盖、清洗加 U+061C）与作者说法基本一致，方向正确；新增的 `[ICON-1]` 用例改回旧判断确实会失败，网页合并用例改回旧写法也会失败。没有发现高危缺陷。主要问题集中在**安全相关改动的测试覆盖**和**一个未验证的循环保护假设**。

---

## 问题列表（按严重度）

### 1. 中（推测，未核实）：循环停止判断是否看到去掉后的参数，没有自动检查

- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1536-1555`
- 问题：`activity`/`activityIcon` 在 `tool_call` 里从 `event.input` 删除，但“工具循环停止”的判断在 `tool_result` 里用的是 `event.input`。ADR 0250 决定 3 声称“工具循环停止的判断看到的都是去掉后的参数”，可现有 `[ICON-1]` 只断言了 `preflight` 和 `execute` 收到的是干净参数（`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2610-2622`），没有断言 `tool_result`/`PiToolProgressGuard` 看到的输入。
- 证据：
  - `pi-runtime-adapter.ts:1536-1537`：`pi.on("tool_call", (event) => { if (activityTools.has(event.toolName)) removeToolActivity(event.input);`
  - `pi-runtime-adapter.ts:1541-1555`：`toolProgress.observe(event.toolName, event.input, ...)`
  - `pi-tool-progress-guard.ts:79-89`：`const call = digest([name, input])`，并据此算 12 次/2 输入、16 次/4 输入窗口。
  - ADR 自己在 `docs/adr/0250-tools-carry-model-written-activity-and-icon.md:75` 也说“工具循环停止的判断用的是 `tool_result` 事件里的参数，模型每次换一句话会让同样的调用看起来不同”。
- 影响：如果 Pi 1.5.0 的 `tool_result.input` 是模型原始参数（含 activity），那么模型每次换一句 activity 就能让同一个调用在循环保护里看起来不同，12 次/2 输入、16 次/4 输入和连续 4 次相同结果都更难触发。仓库里没有 Pi 源码可核对，所以标为推测。
- 建议：补一条用例：让同一工具、同一结果、每次 activity 不同，断言循环保护仍会停止；或直接在真实 Pi 会话里断言 `tool_result`/`PiToolProgressGuard` 看到的是去掉 `activity`/`activityIcon` 后的参数。

### 2. 低：U+061C 清洗没有对应测试，反向删除不会失败

- 文件：`packages/application/src/services/thread-execution-projection.ts:59`
- 问题：这一轮唯一新增的字符 `\u061c` 没有任何测试覆盖。集成用例的清洗断言只用到了 `\u202e` 和 `\u0007`，没有 `\u061c`。
- 证据：
  - `thread-execution-projection.ts:59`：`.replace(/[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")`
  - `test/integration/thread-run-lifecycle.test.ts:3843`：`activity: "  查东京\n明天的\u202e天气\u0007  "`
  - 全仓 grep `061c` 只命中实现文件本身，没有测试。
- 影响：将来把 `\u061c` 从正则里去掉，测试不会失败。这个字符正是本轮为方向欺骗补的控制字符，属于安全清洗，缺测试不理想。
- 建议：在 `test/integration/thread-run-lifecycle.test.ts` 的 activity 字符串里加 `\u061c`，或给 `toolActivity`/`oneLine` 加单元测试，断言它被换成空格。

### 3. 低：`handleToolsCarryActivity` 只测了“旧冻结不带参数”，没测“新冻结带参数 + 句柄工具”的正向路径

- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1384-1390`
- 问题：新增用例覆盖了 `bundle.tools` 不带 activity 时句柄工具不加参数（`pi-runtime-adapter.compat.test.ts:2748-2884`），但没有任何用例覆盖 `bundle.tools` 带 activity 时句柄工具应该加参数。现有 2635 用例冻结的是空工具列表，也不能覆盖。
- 证据：
  - `pi-runtime-adapter.ts:1384-1388`：`const handleToolsCarryActivity = !bundle || (JSON.parse(bundle.tools) as ...).some(({ parameters }) => carriesToolActivity(parameters));`
  - 正向无 bundle 的覆盖在 2461；旧冻结覆盖在 2748；`bundle.tools` 带 activity 且存在句柄工具的用例没有。
- 影响：如果以后把 `.some` 写错成 `.every` 或改坏，正向路径不会红。另外网页新用例 `apps/control-center/test/execution-view.unit.test.ts:581-588` 构造的是“有句子、无图标”的记录，而投影实际总会给图标兜底 `tools`（`thread-execution-projection.ts:82-94`），这条用例是人工构造、真实投影不会产生该形状，防回归价值有限。
- 建议：补一条冻结 `candidate`（工具带 activity）并带句柄工具的兼容用例，断言句柄工具带参数且系统提示出现图标表；网页侧最好用真实投影输出（或直接写明该形状是防御性的）。

### 4. 低：旧冻结开头下 `activityTools` 对句柄/非句柄工具不对称

- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1389-1390, 1474-1478`
- 问题：`runToolDefinition` 对非句柄工具永远传 `activity=true`（`handleToolsCarryActivity || !isHandleTool` 中的 `!isHandleTool`），所以旧冻结开头下 `activityTools` 仍包含这些非句柄工具；但句柄工具按 `handleToolsCarryActivity=false` 处理，不在 `activityTools` 里。结果是：同一轮里，非句柄工具即使请求头（`bundle.tools`）没有 activity 参数，模型硬塞的 `activity` 会被删掉；句柄工具同样没被提供该参数，硬塞的却不会被删。这不影响请求开头，但错误路径不一致。
- 证据：
  - `pi-runtime-adapter.ts:1389-1390`：`this.toolDefinition(descriptor, handleToolsCarryActivity || !isHandleTool(descriptor))`
  - `pi-runtime-adapter.ts:1474-1478`：`activityTools = new Set(descriptors.filter(...carriesToolActivity(runToolDefinition(descriptor).parameters))...)`
- 影响：仅在“旧冻结 + 模型发出未提供的 activity 参数”这一不常见路径上，句柄工具可能把 `activity` 带到执行层，或被 Pi 的参数校验拒绝。正常模型不会做。
- 建议：让 `activityTools` 与实际提供给模型的 schema 对齐（旧冻结用 `bundle.tools` + 句柄工具的 `runToolDefinition` 结果），或至少加一条用例钉住这个边界。

### 5. 信息：新必填字段会破坏旧客户端，ADR 已写明

- 文件：`packages/gateway-contracts/src/thread-contracts-v3.ts:605-606`
- 问题：`activity`、`activityIcon` 作为必填 `displayText` 加入 v3 记录。旧网页/旧手机解析新记录会报未知字段；新网页解析旧服务器记录也会缺字段。ADR 0250 后果一节已写明“网页和服务器一起上线”，因此属于已知取舍，不是新缺陷。
- 证据：`thread-contracts-v3.ts:605-606`；`thread-contracts-v3.contract.test.ts:444-446` 明确断言缺少 `activity` 会抛错。

---

## 侧重检查

- **错误路径**：`JSON.parse(bundle.tools)` 提前到 `handleToolsCarryActivity`（`pi-runtime-adapter.ts:1386`），但同一路径稍后 `requestTools` 本来就要 `JSON.parse(bundle.tools)`（`:1396`），没有新增失败模式。`toolActivity` 对 `null`/`undefined`/数组/非对象参数都退化为 `{}` 或原值序列化（`thread-execution-projection.ts:73-90`），未见抛错。
- **不可信输入**：`activity` 限 80 个码点（`:78-81`），控制字符、双向控制符、U+2028/2029、U+061C 换成空格；`activityIcon` 只接受白名单，否则 `tools`（`:92-94`）。图标名白名单有测试保证与系统提示里列出的 36 个逐字一致（`apps/agent-service/test/prompt-catalog.unit.test.ts:442-449`）。未知 locale 退回 zh-CN（`process-step.ts:122-127`），`Object.hasOwn` 防原型键（`process-step.ts:49-51`，测试 `process-step.contract.test.ts:16-19`）。
- **安全/不可撤销操作**：`removeToolActivity` 在执行前删参数（`pi-runtime-adapter.ts:1536-1537`），审批/权限判断拿到的是删后参数；工具自己的同名参数（描述不同）会保留，主用例 `pi-runtime-adapter.compat.test.ts:2614-2617` 钉住。唯一风险是工具自有 `activity` 描述与目录文字逐字相同时会被当成“加过的”删掉，ADR 已明确这是设计（`docs/adr/0250...md` 决定 1），生产暂无此类工具。
- **资源耗尽**：`activity` 截断前先 `oneLine` 再 `[...].slice(0,80)`（`:78-81`），字符串很大时会先展开成码点数组，但规模受模型输出限制；`input` 最终仍走 65536 截断（`:50-56`）。
- **规则/文档一致性**：ADR 0250 与代码在“同名参数逐字相同时按加过处理”“句柄工具看沿用的冻结工具”“结束记录字段为空”“网页空值不覆盖”上都对得上；`pi-development-guide.md:161` 与 `[ICON-1]` 断言一致。`.claude/rules/prompt-prefix.md` 第 6 条的“工具参数结构变了换新一次”与 `thread-prompt-bundle-service.ts:152-157` 的实现一致。
- **未核实**：新增三条 prompt 的 `sha256` 无法在本环境复算（相关检查在 `apps/agent-service/test/prompt-catalog.unit.test.ts:187,370-387`，作者称通过）；内置工具的 `constrainedSampling` 在加参数后是否仍与 schema 一致，仓库里没有 Pi 源码，未核实；手机端是否接受这 36 个图标名，未核实。

---

## 逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

- **第 3 轮这处改动本身是在“修复开头变化”**：旧冻结开头被恢复时，句柄工具不再被加上 activity 参数。`handleToolsCarryActivity` 现在读 `bundle.tools`（`pi-runtime-adapter.ts:1384-1390`），而真实请求用的非句柄工具也正是 `bundle.tools`（`:1394-1399`），两者一致，所以 pinned 旧开头后面追加的句柄工具定义不会突然多出参数。
- **整个 PR 会让每个老对话换新一次开头**：工具参数结构变了，`toolSchemaChanged` 会触发重新冻结（`thread-prompt-bundle-service.ts:152-157`）。这是 ADR 0250 前提 1、6 写明的，Andy 已同意。换新之后，同一对话内只追加。
- **每轮会变的值**：新增的 `activity`/`activityIcon` 参数说明、图标表都是固定文本（`packages/prompt-catalog/src/activity.ts`），不含时间/路径/哈希；图标表只在有工具带参数时加入（`packages/runtime-pi/src/tool-activity.ts:48-52`）。模型写的 `activity`/`activityIcon` 在工具调用参数里，属于追加的历史，不是服务器每轮注入到系统提示/工具定义里的值。结论：**没有把每轮变化的值塞进请求头部**。
- 但若问题 1 里“循环保护看到的输入”那条假设不成立，它影响的是循环保护语义，不改变发给模型的字节。

### 2. 同一段文字在不同请求里会不会变成不同字节？

- 头部：图标列表顺序固定（`activity.ts:3-41`），图标表是常量，工具参数顺序由 descriptor/bundle 决定并冻结；没有时间、随机数、Set/Map 遍历顺序进入头部。
- 过程记录：`oneLine` 是纯函数（`thread-execution-projection.ts:57-62`），`activity` 兜底只依赖 `toolName` 和 `thread.answerLocale`（`:78-81`），同一 locale 下确定。回答语言改了会导致兜底句子变语言，但这是显示层，且 ADR 已写明；不影响发给模型的内容。
- 遮盖：新字段走既有遮盖流程；同一历史 + 同一密钥下遮出的字节仍确定。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

- `[ICON-1]` 旧冻结用例：把 `handleToolsCarryActivity` 改回 `frozenDefinitions.some(...)`，本测试的 `diary_note` 会重新带上 activity 参数，`expect(offered.get("diary_note")).toEqual({...note...})` 会失败。**反向会失败，成立。**
- 网页合并 `[ICON-2]` 新用例：把 `activityIcon: record.activityIcon || ...` 改回 `record.activity ? record.activityIcon : ...`，第二条记录 `activity="查天气"` 非空且 `activityIcon=""`，结果会从 `"cloud"` 变成 `""`，**反向会失败，成立。**
- **U+061C 没有测试**，删除它不会失败（见问题 2）。
- 新冻结带 activity + 句柄工具的正向路径没有测试（见问题 3）。
- 清单哈希有自动检查（`prompt-catalog.unit.test.ts:300-318` 及反向 370-387），但我不能复算哈希值。
- 循环保护是否看到删后参数没有测试（见问题 1）。

### 4. 每个新值/字段，产生处和使用处两端都能接受吗？

- `activity`/`activityIcon` 过程记录字段：产生处是 `ThreadExecutionProjection`，所有记录都从 `base` 带上两字段（`:221-234`），工具记录额外由 `toolActivity` 返回（`:64-96, 304-332, 501-516`）；使用处是 `threadExecutionRecordSchema` 的 `displayText`（`thread-contracts-v3.ts:605-606`，≤65536，80 字/白名单图标都通过）和网页合并（`execution-view.ts:213-214`）。缺字段会被契约测试拒绝（`thread-contracts-v3.contract.test.ts:444-446`）。两端能接受，代价是旧客户端兼容性（ADR 已写）。
- 图标名：系统提示里列出的名字与服务器白名单由 `[ICON-1]` 测试逐字锁定（`prompt-catalog.unit.test.ts:442-449`），无效值兜底 `tools`，两头一致。
- `step.${kind}` 步骤文字：服务器 `PROCESS_STEP_TEXT`、网页 i18n、`processStepKind` 三方由 `[ICON-3]` 测试逐条比对（`apps/control-center/test/step-summary.unit.test.ts:139-150`、`process-step.contract.test.ts`），能对上。
- 新 prompt id：`chat.process-icons-section`、`tools.activity-parameter`、`tools.activity-icon-parameter` 都已进 `prompt-manifest.json`，并有 `changedIn`/`reason`；清单测试会校验缺失/过期/未知 id。哈希值我未复算。
- 潜在未核实项：内置工具的 `constrainedSampling` 未随新参数更新是否会有影响；手机端是否接受这 36 个图标名，仓库里看不到。
