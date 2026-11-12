CLAIM|1|一致|apps/control-center/src/step-summary.ts:50|现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`）。|return { id: `step.${kind}` as MessageId, target };
CLAIM|2|一致|apps/control-center/src/components/tool-icon.tsx:39|图标也是网页按工具名查表。|const category = glyph ?? toolCategory(name);
CLAIM|3|找不到|-|苹果客户端的详细设计还没合进 main。|-
CLAIM|4|一致|f7cbbf01:docs/execution/specs/2026-11-11-apple-device-body-design.md:208|在 PR 405 的提交 f7cbbf01 上。|**过程行的那句话和图标由 Himawari 自己给**（Andy 2026-11-12：“同意图标由 himawari 自己从这 40 个里面挑”）。
CLAIM|5|一致|f7cbbf01:docs/execution/specs/2026-11-11-apple-device-body-design.md:208|它定了做法：每个工具加两个可选参数，执行前取走，随过程事件发给网页和设备。|做法：每个工具的参数里加两个可选项，一句话说明（暂名 `activity`，用回答的语言，说的是事不是工具名）和图标名（暂名 `activityIcon`，只能取下表 40 个名字之一）；服务器在执行工具前把这两项取走，不传给工具，随这一步的过程事件发给网页和设备。
CLAIM|6|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1393|每个工具的定义都经过同一个函数。|this.toolDefinition(descriptor),
CLAIM|7|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1392|冻结的工具从它取（`frozenDefinitions`）。|const frozenDefinitions = frozenDescriptors.map((descriptor) =>
CLAIM|8|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1422|带执行句柄的工具从它取（`requestTools`）。|...handleDescriptors.map((descriptor) => providerTool(runToolDefinition(descriptor))),
CLAIM|9|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1404|系统提示里的工具说明都从它取（`productSystemPrompt`）。|systemPrompt: productSystemPrompt(projection.systemInstruction, frozenDefinitions),
CLAIM|10|一致|packages/application/src/services/thread-prompt-bundle-service.ts:205|参数结构变了，老对话会换新一次冻结的开头。|origin = "tool_schema_changed";
CLAIM|11|一致|packages/application/src/services/thread-prompt-bundle-service.ts:155|`toolSchemaChanged`：“`current.has(name) && current.get(name) !== schema`”。|([name, schema]) => current.has(name) && current.get(name) !== schema,
CLAIM|12|一致|.claude/rules/prompt-prefix.md:41|规则 `.claude/rules/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”。|只有下面这些情况才换新一次，并且每次都留记录：工具集合变了（工具名，或者去掉说明文字后的参数结构）、冻结的工具找不到了、模型变了、推理强度变了、回答语言变了、数据分类变低了，或者手动执行了 `thread prompt rebuild`。
CLAIM|13|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2407|开始执行时的过程事件里本来就带着模型给的参数。|arguments: event.args,
CLAIM|14|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2402|`case "tool_execution_start"` 的 `arguments: event.args` 写进 `tool_intent` 记录。|kind: "tool_intent",
CLAIM|15|一致|packages/gateway-contracts/src/validation.ts:175|网关的过程记录不接受多出来的字段。|if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
CLAIM|16|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1558|已有的隐藏扩展 `himawari-tool-outcomes`。|name: "himawari-tool-outcomes", hidden: true,
CLAIM|17|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1561|在已有的隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子里。|pi.on("tool_call", (event) => {
CLAIM|18|一致|packages/application/src/services/thread-execution-projection.ts:308|`ThreadExecutionProjection` 生成 `kind` 为 `tool` 的过程记录。|kind: "tool",
CLAIM|19|一致|apps/control-center/src/components/execution-process.tsx:250|网页的过程区仍从自己的 i18n 文字表取同样的句子。|{message("step.search")}
CLAIM|20|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1571|“工具循环停止”的判断用的是 `tool_result` 事件里的参数。|toolProgress.observe( event.toolName, event.input,
CLAIM|21|不一致|apps/control-center/src/components/tool-icon.tsx:22|服务器按工具名套图标。|export function toolCategory(name: string): keyof typeof symbols {
CLAIM|22|一致|packages/application/src/services/thread-execution-projection.ts:311|生成过程记录时不知道工具的参数结构。|...toolActivity(call["arguments"], text(call["name"]), thread.answerLocale),
CLAIM|23|找不到|-|目前生产里没有这样的工具。|-
CLAIM|24|一致|apps/control-center/src/i18n/resources/zh-CN.ts:89|网页的过程区仍按界面语言显示模板句子。|"step.search": "搜索网页",

未核实：苹果客户端详细设计是否仍未合进 main（本地没有 main 引用，只能确认 HEAD 的设计文件没有该节、而 f7cbbf01 有）；生产环境是否存在自带 `activity`／`activityIcon` 参数的工具；方案中新增测试和 golden 文件的具体断言未逐条核对。
