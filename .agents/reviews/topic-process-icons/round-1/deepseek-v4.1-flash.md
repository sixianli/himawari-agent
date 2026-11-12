CLAIM|1|一致|apps/control-center/src/step-summary.ts:74|现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`）|  const kind = stepKind(name);
CLAIM|2|一致|apps/control-center/src/components/tool-icon.tsx:39|图标也是网页按工具名查表|  const category = glyph ?? toolCategory(name);
CLAIM|3|找不到|-|苹果客户端的详细设计（`docs/execution/specs/2026-11-11-apple-device-body-design.md` 的“过程行的那句话和图标由 Himawari 自己给”一段，在 PR 405 的分支上）定了做法|-
CLAIM|4|找不到|-|详细设计同一段：“工具的参数结构变了，每个老对话的请求开头换新一次（Andy 2026-11-12 同意）”|-
CLAIM|5|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1368|每个工具的定义都经过同一个函数。|        this.toolDefinition(descriptor),
CLAIM|6|一致|packages/application/src/services/thread-prompt-bundle-service.ts:155|参数结构变了，老对话会换新一次冻结的开头。|    ([name, schema]) => current.has(name) && current.get(name) !== schema,
CLAIM|7|一致|.claude/rules/prompt-prefix.md:41|规则 `.claude/rules/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”|只有下面这些情况才换新一次，并且每次都留记录：工具集合变了（工具名，或者去掉说明文字后的参数结构）
CLAIM|8|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2375|开始执行时的过程事件里本来就带着模型给的参数。|            arguments: event.args,
CLAIM|9|一致|packages/gateway-contracts/src/validation.ts:175|网关的过程记录不接受多出来的字段。|        if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
CLAIM|10|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1529|在已有的隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子里|            name: "himawari-tool-outcomes",
CLAIM|11|一致|packages/application/src/services/thread-execution-projection.ts:299|`ThreadExecutionProjection` 生成 `kind` 为 `tool` 的过程记录时|                kind: "tool",
CLAIM|12|一致|apps/control-center/src/execution-view.ts:213|网页按 `itemId` 合并同一步的多条记录时，空值不覆盖已有的值|      activity: record.activity || previous?.activity || "",
CLAIM|13|一致|apps/control-center/src/i18n/resources/en.ts:95|模板要三种语言，在网页的 i18n 里|  "step.search": "Searching the web",
CLAIM|14|一致|apps/control-center/src/components/execution-process.tsx:386|网页暂时不显示这句话。网页的过程区仍用模板句子|            const summary = toolStepSummary(item.name, item.input);
CLAIM|15|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2605|`[ICON-1]` 用真实的 Pi 1.5.0 会话和假模型锁住：工具定义带这两个参数、系统提示只出现一次图标表、工具执行和权限判断拿到的参数里没有它们、工具自己的同名参数原样保留、过程事件里仍有它们|    expect(head?.content.split(CHAT_PROCESS_ICONS_SECTION.text)).toHaveLength(2);
CLAIM|16|一致|test/integration/thread-run-lifecycle.test.ts:3905|`[ICON-2]` 用真实 SQLite 锁住过程记录的两个字段、退回 `tools`、`input` 里不再有它们，并用网关契约逐条解析|    expect(tools.map(({ activity, activityIcon }) => [activity, activityIcon])).toEqual([
CLAIM|17|一致|packages/runtime-pi/test/fixtures/d4-golden-requests.json:14|`packages/runtime-pi/test/fixtures/d4-golden-requests.json` 的两条请求体换成带新参数和图标表的版本，其他字段不变|过程图标：调用任何工具时，都可以顺带给 activity（一句话说这一步在做什么）和 activityIcon（下面的名字之一），主人会在过程行上看到它们。
CLAIM|18|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1544|“工具循环停止”的判断用的是 `tool_result` 事件里的参数|                    event.input,
CLAIM|19|一致|apps/control-center/src/components/tool-icon.tsx:22|服务器按工具名套图标。这正是要换掉的写死的表。|export function toolCategory(name: string): keyof typeof symbols {
CLAIM|20|找不到|-|40 个图标里“结果”那 4 个（`hand-stop`、`alert-circle`、`player-stop`、`check`）是服务器知道的状态，不给模型挑|-
CLAIM|21|一致|packages/prompt-catalog/src/activity.ts:3|其余 36 个连同每个名字的意思写成系统提示里的“过程图标”一节|export const PROCESS_ACTIVITY_ICONS = Object.freeze([

未核对的部分：Pi 的 `docs/extensions.md`、`pi-ai` 的 `validation.js` 等第三方资料，以及 Andy 2026-11-12 的批准；PR 405 分支上的详细设计段在当前检出的 spec 文件里没有读到，已按「找不到」处理。
