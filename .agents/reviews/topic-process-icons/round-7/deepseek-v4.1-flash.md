CLAIM|1|一致|apps/control-center/src/step-summary.ts:32|现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`）|  const kind = stepKind(name);
CLAIM|2|一致|apps/control-center/src/components/tool-icon.tsx:22|图标也是网页按工具名查表|export function toolCategory(name: string): keyof typeof symbols {
CLAIM|3|不一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:9|苹果客户端的详细设计还没合进 main|# Himawari 的身体：iPhone、Apple Watch、Mac 和随身麦克风的详细设计
CLAIM|4|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:206@f7cbbf01ce61df6c3927e99c0e8407bc0a59fbe0|在 PR 405 的提交 f7cbbf01 上|<a id="process-row-icons"></a>
CLAIM|5|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:208@f7cbbf01ce61df6c3927e99c0e8407bc0a59fbe0|它定了做法：每个工具加两个可选参数，执行前取走，随过程事件发给网页和设备。|**过程行的那句话和图标由 Himawari 自己给**（Andy 2026-11-12：“同意图标由 himawari 自己从这 40 个里面挑”）。它最清楚自己这一步在做什么，所以不由程序按工具名或关键词去猜。做法：每个工具的参数里加两个可选项，一句话说明（暂名 `activity`，用回答的语言，说的是事不是工具名）和图标名（暂名 `activityIcon`，只能取下表 40 个名字之一）；服务器在执行工具前把这两项取走，不传给工具，随这一步的过程事件发给网页和设备。模型没给、或给的名字不在表里时，图标用 `tools`，那句话退回现在按工具名套的模板（`apps/control-center/src/step-summary.ts`）。网页的过程区可以用同一句话，图标仍按网页自己的表（`apps/control-center/src/components/tool-icon.tsx`）。
CLAIM|6|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2075|每个工具的定义都经过同一个函数。|  private toolDefinition(descriptor: RuntimeToolDescriptor, activity = true): PiToolDefinitionText {
CLAIM|7|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1398|冻结的工具从 `toolDefinition()` 取（`frozenDefinitions`）。|        this.toolDefinition(descriptor),
CLAIM|8|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1420|带执行句柄的工具从 `toolDefinition()` 取。|        this.toolDefinition(descriptor, handleToolsCarryActivity || !isHandleTool(descriptor));
CLAIM|9|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1423|系统提示里的工具说明从 `toolDefinition()` 取（`productSystemPrompt`）。|        productSystemPrompt(projection.systemInstruction, descriptors.map(runToolDefinition)),
CLAIM|10|一致|packages/application/src/services/thread-prompt-bundle-service.ts:205|参数结构变了，老对话会换新一次冻结的开头。|          origin = "tool_schema_changed";
CLAIM|11|一致|packages/application/src/services/thread-prompt-bundle-service.ts:155|来源：`packages/application/src/services/thread-prompt-bundle-service.ts` 的 `toolSchemaChanged`：“`current.has(name) && current.get(name) !== schema`”|    ([name, schema]) => current.has(name) && current.get(name) !== schema,
CLAIM|12|一致|.agents/instructions/prompt-prefix.md:42|规则 `.agents/instructions/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”|6. **系统提示和工具按对话冻结**（[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)）。同一对话一直沿用第一次发出时的字节。只有下面这些情况才换新一次，并且每次都留记录：工具集合变了（工具名，或者去掉说明文字后的参数结构）、冻结的工具找不到了、模型变了、推理强度变了、回答语言变了、数据分类变低了，或者手动执行了 `thread prompt rebuild`。
CLAIM|13|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2418|开始执行时的过程事件里本来就带着模型给的参数。|            arguments: event.args,
CLAIM|14|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2413|`arguments: event.args` 写进 `tool_intent` 记录。|          kind: "tool_intent",
CLAIM|15|一致|packages/gateway-contracts/src/validation.ts:212|网关的过程记录不接受多出来的字段。|        if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
CLAIM|16|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1566|已有的隐藏扩展 `himawari-tool-outcomes`|            name: "himawari-tool-outcomes",
CLAIM|17|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1569|在 `himawari-tool-outcomes` 的 `tool_call` 钩子里|              pi.on("tool_call", (event) => {
CLAIM|18|一致|apps/control-center/src/components/execution-process.tsx:432|网页的过程区仍从自己的 i18n 文字表取同样的句子|                        {item.kind === "tool" ? message(summary.id) : message("chat.responseText")}
CLAIM|19|一致|apps/control-center/src/components/execution-process.tsx:432|网页暂时不显示模型写的那句话|                        {item.kind === "tool" ? message(summary.id) : message("chat.responseText")}
CLAIM|20|一致|apps/control-center/src/components/execution-process.tsx:432|网页的过程区仍按界面语言显示模板句子|                        {item.kind === "tool" ? message(summary.id) : message("chat.responseText")}
CLAIM|21|一致|packages/application/src/services/thread-execution-projection.ts:311|模板句子在服务器那边按回答语言|                ...toolActivity(call["arguments"], text(call["name"]), thread.answerLocale),
CLAIM|22|找不到|-|目前生产里没有这样的工具。|-
CLAIM|23|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1581|“工具循环停止”的判断用的是 `tool_result` 事件里的参数|                    event.input,
CLAIM|24|一致|docs/pi-development-guide.md:156|仓库里的转述见 Pi 二次开发规范|- 顺序：`tool_call` 先于工具的 `execute` 运行，官方原话“Mutations to `event.input` affect the actual tool execution”（`docs/extensions.md` 第 984 行），所以在这里改了参数，Himawari 在 `execute` 里做的权限判断（[偏离 D2](#current-deviations)）看到的是改后的参数。`pi-runtime-adapter.compat.test.ts` 的 `[ICON-1]` 用真实 Pi 会话锁住了这一点：`tool_call` 里删掉的 `activity`、`activityIcon` 不会出现在 `preflight` 和 `execute` 收到的参数里（[ADR 0250](adr/0250-tools-carry-model-written-activity-and-icon.md)）。

未核实：Pi 官方文档的版本和行号（外部链接未上网），以及生产里是否绝对没有名为 activity/activityIcon 的既有工具参数（只能在仓库源码里确认没搜到）。另：详细设计文件在 HEAD 已存在，但“过程行”一节只在 f7cbbf01 提交里读到，PR 405 的合并状态只按本地提交判断。
