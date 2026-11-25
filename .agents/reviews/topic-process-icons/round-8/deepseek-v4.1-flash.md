CLAIM|1|一致|apps/control-center/src/step-summary.ts:50|现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`）|  return { id: `step.${kind}` as MessageId, target };
CLAIM|2|一致|apps/control-center/src/components/tool-icon.tsx:22|图标也是网页按工具名查表|export function toolCategory(name: string): keyof typeof symbols {
CLAIM|3|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:208@f7cbbf01ce61df6c3927e99c0e8407bc0a59fbe0|Andy 2026-11-12 批准了过程行用的 40 个图标|**过程行的那句话和图标由 Himawari 自己给**（Andy 2026-11-12：“同意图标由 himawari 自己从这 40 个里面挑”）。
CLAIM|4|找不到|-|苹果客户端的详细设计里讲这件事的那一段还没合进 main|-
CLAIM|5|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:206@f7cbbf01ce61df6c3927e99c0e8407bc0a59fbe0|在提交 f7cbbf01 上|<a id="process-row-icons"></a>
CLAIM|6|找不到|-|在 PR 405 的提交 f7cbbf01 上|-
CLAIM|7|一致|docs/pi-development-guide.md:143|仓库里的转述见 Pi 二次开发规范（`../pi-development-guide.md#pattern-tool-call`）|出处：`docs/extensions.md` 第 973 行“tool_call”：“Fired after `tool_execution_start`, before the tool executes. **Can block.**”；示例 `examples/extensions/permission-gate.ts`。
CLAIM|8|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1398|每个工具的定义都经过同一个函数 `toolDefinition()`：冻结的工具、带执行句柄的工具、系统提示里的工具说明都从它取（`frozenDefinitions`、`requestTools`、`productSystemPrompt`）|        this.toolDefinition(descriptor),
CLAIM|9|一致|packages/application/src/services/thread-prompt-bundle-service.ts:155|`toolSchemaChanged`：“`current.has(name) && current.get(name) !== schema`”|    ([name, schema]) => current.has(name) && current.get(name) !== schema,
CLAIM|10|一致|.agents/instructions/prompt-prefix.md:42|规则 `.agents/instructions/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”|6. **系统提示和工具按对话冻结**（[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)）。同一对话一直沿用第一次发出时的字节。只有下面这些情况才换新一次，并且每次都留记录：工具集合变了（工具名，或者去掉说明文字后的参数结构）、冻结的工具找不到了、模型变了、推理强度变了、回答语言变了、数据分类变低了，或者手动执行了 `thread prompt rebuild`。
CLAIM|11|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2418|`case "tool_execution_start"`：`arguments: event.args` 写进 `tool_intent` 记录|            arguments: event.args,
CLAIM|12|一致|packages/gateway-contracts/src/validation.ts:212|网关的过程记录不接受多出来的字段（第 212 行）|        if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
CLAIM|13|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1566|在已有的隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子里|            name: "himawari-tool-outcomes",
CLAIM|14|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1569|在已有的隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子里|              pi.on("tool_call", (event) => {
CLAIM|15|一致|packages/application/src/services/thread-execution-projection.ts:308|`ThreadExecutionProjection` 生成 `kind` 为 `tool` 的过程记录时|                kind: "tool",
CLAIM|16|一致|apps/control-center/src/execution-view.ts:213|网页按 `itemId` 合并同一步的多条记录时，空值不覆盖已有的值|      activity: record.activity || previous?.activity || "",
CLAIM|17|一致|packages/application/src/services/thread-execution-projection.ts:231|执行结束的那条记录两个字段为空字符串|        activity: "",\n        activityIcon: "",
CLAIM|18|一致|apps/control-center/src/components/execution-process.tsx:95|网页的过程区仍从自己的 i18n 文字表取同样的句子|      return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");
CLAIM|19|一致|apps/control-center/test/step-summary.unit.test.ts:140|`apps/control-center/test/step-summary.unit.test.ts` 的 `[ICON-3]` 锁住网页那几条和共享表逐字相同|describe("[ICON-3] step names shared with the server", () => {
CLAIM|20|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1581|“工具循环停止”的判断用的是 `tool_result` 事件里的参数|                    event.input,
CLAIM|21|一致|apps/control-center/src/components/tool-icon.tsx:3|这正是要换掉的写死的表|const symbols = {
CLAIM|22|一致|packages/application/src/services/thread-execution-projection.ts:513|过程记录每次读取时按这个对话当时的回答语言补模板句子|                  thread.answerLocale,
CLAIM|23|一致|apps/control-center/src/components/execution-process.tsx:386|网页的过程区仍按界面语言显示模板句子|            const summary = toolStepSummary(item.name, item.input);
CLAIM|24|一致|packages/application/src/services/thread-execution-projection.ts:513|注意模板句子在服务器那边按回答语言，在网页上按界面语言，两者可能不同|                  thread.answerLocale,
CLAIM|25|找不到|-|目前生产里没有这样的工具|-
CLAIM|26|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2466|`[ICON-1]` 用真实的 Pi 1.5.0 会话和假模型|  it("[ICON-1] offers activity and activityIcon on every tool and removes them before the tool runs", async () => {
CLAIM|27|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2614|工具定义带这两个参数、系统提示只出现一次图标表、工具执行和权限判断拿到的参数里没有它们、工具自己的同名参数原样保留、过程事件和下一次请求的历史里仍有它们|    expect(head?.content.split(CHAT_PROCESS_ICONS_SECTION.text)).toHaveLength(2);\n    expect(executed.get("activity-call")).toEqual({ query: "beef" });\n    expect(JSON.stringify(intents)).toContain("找附近的牛肉店");
CLAIM|28|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2837|没有冻结工具、或者沿用的冻结工具（例如升级前冻结的旧版）不带这两个参数时，执行句柄带来的工具也不带、系统提示里没有图标表，沿用的冻结工具带参数时句柄工具也带|    expect(head?.content).not.toContain(CHAT_PROCESS_ICONS_SECTION.text);\n    expect(offered.get("diary_note")).toEqual(
CLAIM|29|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2723|还锁住模型每次换一句 `activity` 时，同样的调用仍会被工具循环停止拦下|      errorCode: "PI_TOOL_LOOP_DETECTED",
CLAIM|30|一致|test/integration/thread-run-lifecycle.test.ts:3813|`test/integration/thread-run-lifecycle.test.ts` 的 `[ICON-2]` 用真实 SQLite|  it("[ICON-2] puts the model's activity and icon on the tool step and keeps them out of its input", async () => {
CLAIM|31|一致|test/integration/thread-run-lifecycle.test.ts:3917|锁住过程记录的两个字段、句子里的换行和控制字符被换掉、退回 `puzzle`、`input` 里不再有它们|    expect(tools.map(({ activity, activityIcon }) => [activity, activityIcon])).toEqual([\n      ["查东京 明天的 天气", "cloud"],\n      ["查资料", "puzzle"],\n      expect(tool.input).not.toContain("activity");
CLAIM|32|一致|test/integration/thread-run-lifecycle.test.ts:3930|并用网关契约逐条解析|      expect(() => threadExecutionRecordSchema.parse(record)).not.toThrow();
CLAIM|33|一致|packages/runtime-pi/test/fixtures/d4-golden-requests.json:14|请求字节的对照文件更新了：`packages/runtime-pi/test/fixtures/d4-golden-requests.json` 的两条请求体换成带新参数和图标表的版本，其他字段不变|\"activity\":{\"type\":\"string\",\"description\":\"可选。用回答的语言写一句话告诉主人这一步在做什么，说事情本身，不写工具名，例如“查东京明天的天气”。不超过 30 个字，不影响工具执行。\"}

未核实部分：Pi 官方文档的 1.5.0/1.5.1 行号和原文、Claude Code/OpenAI 等外部说法、PR 405 编号、main 分支本身（仓库没有 main 引用），以及“目前生产里没有这样的工具”无法从仓库证明；详细设计那一段在 HEAD 的对应文件里也没有读到。
