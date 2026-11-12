## 侧重检查

- **错误路径**：`removeToolActivity()` 只对 `activityTools`（参数里带我们这两个参数的 object schema 工具）调用；`carriesToolActivity()` 对非 object/无 properties 的输入返回 false（`packages/runtime-pi/src/tool-activity.ts:38-41`）。未发现把非法输入传进 `delete` 的路径。
- **不可信输入/安全**：`activity`、`activityIcon` 是模型写的文本，展示前由 `oneLine()` 去掉控制符和双向控制符（`packages/application/src/services/thread-execution-projection.ts:57-62`）；本次新增的 U+061C 正好在该正则里。`activityIcon` 不在 36 个名字内时回退 `tools`（同文件 92-94）。
- **资源耗尽**：循环保护 `consecutive >= 4`、12 次双输入窗口、16 次四输入窗口（`packages/runtime-pi/src/pi-tool-progress-guard.ts:85-89`）；新增测试锁的是第一条阈值路径。
- **不可撤销操作**：本次提交只改测试；生产侧的 `removeToolActivity()` 改的是 Pi 校验后的参数对象，历史记录里的原参数由更早的 `[ICON-1]` 测试锁住仍保留（`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2628-2632`）。未发现新增不可逆写操作。
- **规则/文档一致性**：ADR 0250 与代码的参数增删、图标表、过程记录字段基本一致；但测试清单没有随本轮新增测试更新（见下面低严重度条目）。

## 结论

第 4 轮提交 `7987ca0d1` 确实只增加了两个测试文件的内容和复核记录，没有改生产代码。读代码看，三条测试声称的行为与实现一致；未发现中、高严重度问题。作者关于“329 例全过”“三条反向验证都失败过”和 Pi `agent-loop.js` 内部对象复用的说法，本环境无法运行测试、也没有 `node_modules`，均未核实。

## 读代码证实的问题

1. **低** `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2713-2715`
   - **问题**：测试只断言 `tools.execute` 调用了 4 次，没有断言“第 5 次调用是被循环保护拦下的”。如果第 5 次模型响应没有被发出、或流程因别的原因在 4 次后结束，这条测试仍会通过。
   - **证据**：
     ```ts
     await collect(adapter.run(request));

     expect(tools.execute).toHaveBeenCalledTimes(4);
     ```
   - **建议**：像同文件已有循环测试那样，捕获 `faux` 上下文并断言最后一条请求里出现 `CHAT_TOOL_LOOP_STOPPED.text`，或断言 `events.at(-1)` 为 `{ type: "runtime.failed", errorCode: "PI_TOOL_LOOP_DETECTED" }`（参考 `pi-runtime-adapter.compat.test.ts:4216-4234`）。

2. **低** `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:3099-3107`
   - **问题**：期望值由生产代码的 `withToolActivityParameters()` 现算，测试只证明“适配器调用了同一个函数”，不能独立证明参数内容正确；若该函数本身把说明文字或参数名写错，这条测试会一起错着通过。
   - **证据**：
     ```ts
     expect(offered.get("diary_note")).toEqual(
       withToolActivityParameters({ ... }),
     );
     expect(offered.get("weather")).toEqual(withToolActivityParameters(weatherParameters));
     ```
   - **建议**：至少对 `diary_note` 写死一次期望对象（包含 `activity`/`activityIcon` 的说明文字），或额外断言 `description === TOOL_ACTIVITY_PARAMETER.text` / `TOOL_ACTIVITY_ICON_PARAMETER.text`。

3. **低** `test/integration/thread-run-lifecycle.test.ts:3843`
   - **问题**：U+061C 被塞进已有的一条多控制符用例里，没有独立用例名；将来失败时不容易定位是 U+061C 还是 U+202E/U+0007 的清洗退化。
   - **证据**：
     ```ts
     activity: "  查东京\n明天的\u202e天气\u0007\u061c  ",
     ```
   - **建议**：用表驱动按控制符拆成独立用例，或给 `oneLine()`/投影加一个直接的单测，明确锁住 U+061C。

4. **低** `docs/adr/0250-tools-carry-model-written-activity-and-icon.md:93`、`docs/pi-development-guide.md:161`
   - **问题**：ADR 的“测试”条目没有提到本轮新增的“换 activity 不绕过循环保护”和“冻结工具带参数时句柄工具也带”两条测试；Pi 规范只提删参数不落到 `preflight`/`execute`，也没提循环保护。不是错误，但文档落后于测试。
   - **证据**：ADR 第 93 行仍只列了工具定义、图标表、执行参数、历史、旧冻结工具等场景；`pi-development-guide.md:161` 只描述删参数对执行的影响。
   - **建议**：在本轮测试提交里补一句测试清单，写清 `[ICON-1]` 已覆盖循环保护路径。

## 推测

1. **低（未来兼容性）** `packages/runtime-pi/src/tool-activity.ts:38-41`
   - **问题**：`carriesToolActivity()` 用“当前提示词原文”当身份标记。将来如果有人改了 `TOOL_ACTIVITY_PARAMETER.text`，旧对话冻结 bundle 里的参数说明仍是旧文字，会被判定为“不是我们的参数”；于是 `handleToolsCarryActivity` 变 false，句柄工具不再带这两个参数，但冻结的系统提示仍告诉模型所有工具都可以带 `activity`。模型若照做，句柄工具的参数结构里没有该字段，可能被 Pi 校验拒绝。
   - **证据**：
     ```ts
     return isRecord(activity) && activity["description"] === TOOL_ACTIVITY_PARAMETER.text;
     ```
     `pi-runtime-adapter.ts:1384-1388` 用这个结果决定句柄工具是否带参数。
   - **状态**：当前提示词未改，现有冻结 bundle 不会触发；这是未来改提示词文字时的风险，代码里没有“旧文字也算”的兼容分支，也没有对应测试。
   - **建议**：不要在运行时用可变的展示文字做身份标记；可用稳定的内部字段/版本号（若 schema 允许扩展）或同时接受版本化标记。至少加一条“冻结 bundle 里是旧说明文字”的用例，明确期望行为。

## 未核实

- 作者说“两个测试文件 329 例全过”“三条反向验证都失败过”：无法运行测试，未核实。
- 作者说 Pi 1.5.0 `agent-loop.js` 里 `beforeToolCall` 和 `afterToolCall` 拿同一个 `validatedArgs` 对象：当前检出没有 `node_modules`，未核实；测试是否真能锁住该行为依赖这个前提。
- 第 3 轮 `judgments.md` 的“没有中、高严重度意见”：复核记录文件被工具策略拒绝读取，未核实。
- iOS 客户端是否接受新增的必填 `activity`/`activityIcon` 字段：客户端不在本仓库，未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加？**
   - 第 4 轮本身不改任何发给模型的内容，只改测试，因此不改变请求开头。
   - 整个 PR 的功能改动会改请求开头：工具定义增加 `activity`/`activityIcon`，系统提示末尾增加“过程图标”一节（`packages/runtime-pi/src/pi-runtime-adapter.ts:607`）。对已有对话，适配器优先使用冻结的 `bundle.systemPrompt` 和 `bundle.tools`（同文件 1391-1398）；但 `thread-prompt-bundle-service.ts:204-205` 在 `toolSchemaChanged` 时会新建一代 bundle，所以老对话下一轮会一次性换新请求开头，之后才恢复只追加。ADR 0250 明确记录 Andy 已同意这次换新（ADR 第 87 行），符合规则第 6 条的例外，但**不是纯追加**。
   - 每轮会变的值：只有模型自己写的 `activity`/`activityIcon`，它们进入的是追加的 assistant 工具调用消息/历史尾部，不在系统提示或工具定义里；图标表和参数说明都是固定文字。因此没有把每轮变化的值放进请求头。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 不会由本次代码引入。`withToolActivityParameters()` 的键顺序固定（原有 properties 后依次加 `activity`、`activityIcon`），说明文字来自固定提示词；`processIconsSection()` 只返回固定整段或空；`oneLine()` 对每个值独立清洗，U+061C 已被明确替换；图标校验是固定数组的 `includes`。没有依赖前后文的遮盖、时间字段或无序集合。
   - 一个已文档化的例外：模型没给 `activity` 时，投影按 `thread.answerLocale` 生成模板句子（`thread-execution-projection.ts:78-81`），改回答语言后同一旧步骤的展示文字会变；这只影响展示，不进入发给模型的内容，ADR 0250 第 90 行已写明。

3. **有没有对应自动检查，反向用例真的会失败吗？**
   - 有：测试在 `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 和 `test/integration/thread-run-lifecycle.test.ts`，是自动用例。
   - 静态推理反向用例都会失败：
     - 去掉 `removeToolActivity()`：第 5 次调用的 `activity` 不同，`PiToolProgressGuard` 的 `consecutive` 到不了 4，`tools.execute` 会变成 5，断言 4 失败。
     - 去掉 `\u061c`：`oneLine()` 保留 U+061C，投影出的句子与 `"查东京 明天的 天气"` 不等，集成测试失败。
     - 破坏句柄工具条件：新增正向用例失败；已有的负向用例 `[ICON-1] leaves handle tools without activity...`（同文件 2718 起）也会在“无条件加参数”时失败。
   - 但反向验证只是作者手工做过，仓库里没有提交反向/mutation 测试；测试是否真的全过无法在本环境运行。另见上面第 1 条：循环测试只断言执行次数，没有锁住“因循环保护而停”的具体信号。

4. **改动产生/修改的每个值，使用方都能接受吗？**
   - `activity`/`activityIcon` 字段名：生产侧 `tool-activity.ts:5-6` 和投影 `thread-execution-projection.ts:13-14` 用同一组常量；网关契约要求两个字段且是 `displayText`（`thread-contracts-v3.ts:605-606`）；投影为每条记录初始化这两个字段（同文件 221-232），工具记录填值；网页 `execution-view.ts:212-213` 也按字段合并。集成测试还逐条 `threadExecutionRecordSchema.parse()`（`thread-run-lifecycle.test.ts:3918`）。两端一致。
   - 图标名：`PROCESS_ACTIVITY_ICONS` 与系统提示图标表由 `[ICON-1]` 测试逐项比对（`apps/agent-service/test/prompt-catalog.unit.test.ts:442-449`），服务器回退值 `tools` 在表内。
   - 过程步骤类型和模板句子：`processStepKind`/`processStepText` 与网页 i18n 由 `[ICON-3]` 测试逐项比对（`apps/control-center/test/step-summary.unit.test.ts:140` 起），`Object.hasOwn` 防原型键（`gateway-contracts/test/process-step.contract.test.ts`）。
   - U+061C：只用于输入用例，投影正则覆盖它，使用方是 `oneLine()`，无额外校验需要。
   - 未核实：`prompt-manifest.json` 新增三条的 SHA 是否与当前文字一致（需要运行测试或计算哈希）；iOS 客户端是否能解析新增必填字段。
   - 遗留风险见“推测 1”：`TOOL_ACTIVITY_PARAMETER.text` 同时被当作展示说明和身份标记，文字变更会影响旧冻结 bundle 的识别，建议改为稳定标记或补旧文字兼容。
