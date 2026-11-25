CLAIM|1|一致|apps/control-center/src/step-summary.ts:32|现在这句话是网页按工具名套模板拼出来的（apps/control-center/src/step-summary.ts）|const kind = stepKind(name);
CLAIM|2|一致|apps/control-center/src/components/tool-icon.tsx:39|图标也是网页按工具名查表。|const category = glyph ?? toolCategory(name);
CLAIM|3|找不到|-|苹果客户端的详细设计还没合进 main|-
CLAIM|4|找不到|-|详细设计在 PR 405 的提交 f7cbbf01 上|-
CLAIM|5|找不到|-|它定了做法：每个工具加两个可选参数，执行前取走，随过程事件发给网页和设备。|-
CLAIM|6|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1368|冻结的工具从 toolDefinition() 取|this.toolDefinition(descriptor),
CLAIM|7|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1390|带执行句柄的工具从 toolDefinition() 取|this.toolDefinition(descriptor, handleToolsCarryActivity || !isHandleTool(descriptor));
CLAIM|8|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1379|系统提示里的工具说明从 toolDefinition() 取|systemPrompt: productSystemPrompt(projection.systemInstruction, frozenDefinitions),
CLAIM|9|一致|packages/application/src/services/thread-prompt-bundle-service.ts:204|参数结构变了，老对话会换新一次冻结的开头。|else if (toolSchemaChanged(opened.tools, input.candidate.tools))
CLAIM|10|一致|.claude/rules/prompt-prefix.md:41|规则 .claude/rules/prompt-prefix.md 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”|工具集合变了（工具名，或者去掉说明文字后的参数结构）
CLAIM|11|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2376|开始执行时的过程事件里本来就带着模型给的参数。|kind: "tool_intent",
CLAIM|12|一致|packages/gateway-contracts/src/validation.ts:175|网关的过程记录不接受多出来的字段。|if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
CLAIM|13|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1533|在已有的隐藏扩展 himawari-tool-outcomes 的 tool_call 钩子里|name: "himawari-tool-outcomes",
CLAIM|14|一致|apps/control-center/src/components/execution-process.tsx:95|网页暂时不显示模型写的那句话。|return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");
CLAIM|15|一致|apps/control-center/src/components/execution-process.tsx:95|网页的过程区仍按界面语言显示模板句子|return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");
CLAIM|16|一致|packages/application/src/services/thread-execution-projection.ts:311|模板句子在服务器那边按回答语言|...toolActivity(call["arguments"], text(call["name"]), thread.answerLocale),
CLAIM|17|找不到|-|目前生产里没有这样的工具。|-

未核对的部分：Pi 1.5.0/1.5.1 官方文档原文属于外部资料；当前仓库没有 `origin/main` 引用，无法确认详细设计是否已合进 main 或 f7cbbf01 的 PR 归属，也无法从仓库证明“目前生产里没有这样的工具”。方案中打算新增或修改的测试和请求对照文件不属于现状，未列入。
