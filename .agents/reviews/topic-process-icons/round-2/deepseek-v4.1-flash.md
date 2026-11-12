CLAIM|1|一致|apps/control-center/src/step-summary.ts:92|现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`）|  return { id: `step.${kind}` as MessageId, target };
CLAIM|2|一致|apps/control-center/src/components/tool-icon.tsx:23|图标也是网页按工具名查表|  const value = name.toLowerCase().split(/[.:/]/).at(-1) ?? name;
CLAIM|3|一致|f7cbbf01:docs/execution/specs/2026-11-11-apple-device-body-design.md:199|苹果客户端的详细设计还没合进 main，在 PR 405 的提交 f7cbbf01 上|**过程行的那句话和图标由 Himawari 自己给**（Andy 2026-11-12：“同意图标由 himawari 自己从这 40 个里面挑”）。
CLAIM|4|一致|f7cbbf01:docs/execution/specs/2026-11-11-apple-device-body-design.md:201|它定了做法：每个工具加两个可选参数，执行前取走，随过程事件发给网页和设备|做法：每个工具的参数里加两个可选项，一句话说明（暂名 `activity`，用回答的语言，说的是事不是工具名）和图标名（暂名 `activityIcon`，只能取下表 40 个名字之一）；服务器在执行工具前把这两项取走，不传给工具，随这一步的过程事件发给网页和设备。
CLAIM|5|找不到|-|Pi 允许在工具执行前就地改参数，而且改动会作用到真正的执行|-
CLAIM|6|找不到|-|@earendil-works/pi-coding-agent@1.5.0 的 docs/extensions.md 第 973 行“Fired after `tool_execution_start`, before the tool executes”|-
CLAIM|7|找不到|-|@earendil-works/pi-coding-agent@1.5.0 的 docs/extensions.md 第 982 行“Mutations to `event.input` affect the actual tool execution”|-
CLAIM|8|找不到|-|@earendil-works/pi-coding-agent@1.5.0 的 docs/extensions.md 第 984 行“No re-validation is performed after your mutation”|-
CLAIM|9|找不到|-|1.5.1 同一段在第 975、984、986 行，说法相同|-
CLAIM|10|找不到|-|Pi 的 `prepareArguments` 不是给这种用途的；同一文件第 2302 行“Use it to mimic an older accepted input shape when Pi resumes an older session …… Keep the public schema strict.”|-
CLAIM|11|找不到|-|Pi 校验参数时用的是副本|-
CLAIM|12|找不到|-|对话记录里保留模型的原样参数；来源是 `@earendil-works/pi-ai@1.5.0` 的 `dist/utils/validation.js` 第 53 行“A copy, so tools that modify their arguments never modify the tool call in the transcript.”|-
CLAIM|13|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1368|每个工具的定义都经过同一个函数 `toolDefinition()`：冻结的工具、带执行句柄的工具、系统提示里的工具说明都从它取|        this.toolDefinition(descriptor),\n            ...(handleDescriptors.map((descriptor) => providerTool(this.toolDefinition(descriptor)))),
CLAIM|14|一致|packages/application/src/services/thread-prompt-bundle-service.ts:155|`toolSchemaChanged`：“`current.has(name) && current.get(name) !== schema`”|    ([name, schema]) => current.has(name) && current.get(name) !== schema,
CLAIM|15|一致|.claude/rules/prompt-prefix.md:41|规则 `.claude/rules/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”|6. **系统提示和工具按对话冻结**（[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)）。同一对话一直沿用第一次发出时的字节。只有下面这些情况才换新一次，并且每次都留记录：工具集合变了（工具名，或者去掉说明文字后的参数结构）、冻结的工具找不到了、模型变了、推理强度变了、回答语言变了、数据分类变低了，或者手动执行了 `thread prompt rebuild`。
CLAIM|16|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2375|`case "tool_execution_start"`：`arguments: event.args` 写进 `tool_intent` 记录|            arguments: event.args,
CLAIM|17|一致|packages/gateway-contracts/src/validation.ts:175|网关的过程记录不接受多出来的字段；第 175 行 `if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");`|        if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
CLAIM|18|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1533|在已有的隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子里，对加过这两个参数的工具，从 `event.input` 删掉它们|            name: "himawari-tool-outcomes",\n              pi.on("tool_call", (event) => {\n                if (activityTools.has(event.toolName)) removeToolActivity(event.input);
CLAIM|19|一致|packages/application/src/services/thread-execution-projection.ts:299|`ThreadExecutionProjection` 生成 `kind` 为 `tool` 的过程记录|                kind: "tool",
CLAIM|20|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:587|网关契约 `threadExecutionRecordSchema`|export const threadExecutionRecordSchema = object({
CLAIM|21|一致|apps/control-center/src/execution-view.ts:213|网页按 `itemId` 合并同一步的多条记录时，空值不覆盖已有的值|      activity: record.activity || previous?.activity || "",\n      activityIcon: record.activity ? record.activityIcon : previous?.activityIcon || "",
CLAIM|22|一致|apps/control-center/src/i18n/resources/{zh-CN.ts:89,ja.ts:97,en.ts:95}|模板要三种语言，在网页的 i18n 里|  "step.search": "搜索网页",\n  "step.search": "ウェブ検索",\n  "step.search": "Searching the web",
CLAIM|23|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:605|网关契约变了，过程记录多了两个必填字段|  activity: displayText,\n  activityIcon: displayText,
CLAIM|24|一致|apps/control-center/src/components/execution-process.tsx:95|网页暂时不显示这句话。网页的过程区仍用模板句子|      return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");
CLAIM|25|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2461|`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 的 `[ICON-1]` 用真实的 Pi 1.5.0 会话和假模型|  it("[ICON-1] offers activity and activityIcon on every tool and removes them before the tool runs", async () => {
CLAIM|26|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2585|`[ICON-1]` 锁住工具定义带这两个参数|    expect(offered.get("restaurant_search")).toMatchObject({\n      properties: {\n        query: { type: "string" },\n        activity: { type: "string", description: TOOL_ACTIVITY_PARAMETER.text },\n        activityIcon: {\n          type: "string",\n          description: TOOL_ACTIVITY_ICON_PARAMETER.text,\n        },\n      },\n      required: ["query"],\n    });
CLAIM|27|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2605|`[ICON-1]` 锁住系统提示只出现一次图标表|    expect(head?.content.split(CHAT_PROCESS_ICONS_SECTION.text)).toHaveLength(2);
CLAIM|28|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2609|`[ICON-1]` 锁住工具执行和权限判断拿到的参数里没有它们|    expect(executed.get("activity-call")).toEqual({ query: "beef" });
CLAIM|29|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2610|`[ICON-1]` 锁住工具自己的同名参数原样保留|    expect(executed.get("own-activity-call")).toEqual({\n      activity: "跑步",\n      activityIcon: "walk",\n    });
CLAIM|30|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2622|`[ICON-1]` 锁住过程事件里仍有它们|    expect(JSON.stringify(intents)).toContain("找附近的牛肉店");\n    expect(JSON.stringify(intents)).toContain("map-pin");
CLAIM|31|找不到|-|把钩子里的删除去掉，这条测试会失败|-
CLAIM|32|一致|test/integration/thread-run-lifecycle.test.ts:3801|`test/integration/thread-run-lifecycle.test.ts` 的 `[ICON-2]`|  it("[ICON-2] puts the model's activity and icon on the tool step and keeps them out of its input", async () => {
CLAIM|33|一致|test/integration/thread-run-lifecycle.test.ts:77|`[ICON-2]` 用真实 SQLite|  useSqliteContractExecution(execution);
CLAIM|34|一致|test/integration/thread-run-lifecycle.test.ts:3905|`[ICON-2]` 锁住过程记录的两个字段、退回 `tools`、`input` 里不再有它们|    expect(tools.map(({ activity, activityIcon }) => [activity, activityIcon])).toEqual([\n      ["查东京明天的天气", "cloud"],\n      ["查资料", "tools"],\n      ["", ""],\n      ["查东京明天的天气", "cloud"],\n      ["查资料", "tools"],\n      ["", ""],\n    ]);
CLAIM|35|一致|test/integration/thread-run-lifecycle.test.ts:3918|`[ICON-2]` 用网关契约逐条解析|      expect(() => threadExecutionRecordSchema.parse(record)).not.toThrow();
CLAIM|36|一致|packages/runtime-pi/test/fixtures/d4-golden-requests.json:14|请求字节的对照文件更新了：`packages/runtime-pi/test/fixtures/d4-golden-requests.json` 的两条请求体换成带新参数和图标表的版本|      "body": "{\"model\":\"deepseek/deepseek-v4.1-flash\",\"messages\":[{\"role\":\"developer\",\"content\":\"You are a controlled restaurant assistant.\\n\\n过程图标：调用任何工具时，都可以顺带给 activity（一句话说这一步在做什么）和 activityIcon（下面的名字之一），主人会在过程行上看到它们。
CLAIM|37|一致|packages/runtime-pi/test/fixtures/d4-golden-requests.json:14|其他字段不变|      "body": "{\"model\":\"deepseek/deepseek-v4.1-flash\",\"messages\":[{\"role\":\"developer\",\"content\":\"You are a controlled restaurant assistant.\\n\\n过程图标：调用任何工具时，都可以顺带给 activity（一句话说这一步在做什么）和 activityIcon（下面的名字之一），主人会在过程行上看到它们。

Pi 的 `docs/extensions.md`、`prepareArguments` 说明和 `@earendil-works/pi-ai` 的 `dist/utils/validation.js` 都不在仓库里，相关原文与行号未能核对；`[ICON-1]` 中“去掉钩子里的删除就会失败”属于未实际运行的推断，也未能核对。
