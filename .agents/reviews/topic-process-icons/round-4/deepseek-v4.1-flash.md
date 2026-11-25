CLAIM|1|一致|apps/control-center/src/step-summary.ts:32|现在这句话是网页按工具名套模板拼出来的（`apps/control-center/src/step-summary.ts`）|`  const kind = stepKind(name);`；`  return { id: \`step.${kind}\` as MessageId, target };`
CLAIM|2|一致|apps/control-center/src/components/tool-icon.tsx:22|图标也是网页按工具名查表|`export function toolCategory(name: string): keyof typeof symbols {`
CLAIM|3|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:207（f7cbbf01）|苹果客户端的详细设计还没合进 main，在 PR 405 的提交 f7cbbf01 上|`<a id="process-row-icons"></a>`
CLAIM|4|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:207（f7cbbf01）|它定了做法：每个工具加两个可选参数，执行前取走，随过程事件发给网页和设备|`做法：每个工具的参数里加两个可选项，一句话说明（暂名 \`activity\`，用回答的语言，说的是事不是工具名）和图标名（暂名 \`activityIcon\`，只能取下表 40 个名字之一）；服务器在执行工具前把这两项取走，不传给工具，随这一步的过程事件发给网页和设备。`
CLAIM|5|一致|docs/pi-development-guide.md:143|仓库里的转述见 [Pi 二次开发规范](../pi-development-guide.md#pattern-tool-call)|`出处：\`docs/extensions.md\` 第 973 行“tool_call”：“Fired after \`tool_execution_start\`, before the tool executes. **Can block.**”；示例 \`examples/extensions/permission-gate.ts\`。`
CLAIM|6|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1367|冻结的工具……都从它取（`frozenDefinitions`）|`      const frozenDefinitions = frozenDescriptors.map((descriptor) =>`；`        this.toolDefinition(descriptor),`
CLAIM|7|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1393|带执行句柄的工具……都从它取（`requestTools`）|`            ...handleDescriptors.map((descriptor) => providerTool(this.toolDefinition(descriptor))),`
CLAIM|8|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1379|系统提示里的工具说明都从它取（`productSystemPrompt`）|`          systemPrompt: productSystemPrompt(projection.systemInstruction, frozenDefinitions),`
CLAIM|9|一致|packages/application/src/services/thread-prompt-bundle-service.ts:155|`toolSchemaChanged`：“`current.has(name) && current.get(name) !== schema`”|`    ([name, schema]) => current.has(name) && current.get(name) !== schema,`
CLAIM|10|一致|.claude/rules/prompt-prefix.md:41|规则 `.claude/rules/prompt-prefix.md` 第 6 条：“工具集合变了（工具名，或者去掉说明文字后的参数结构）……才换新一次”|`工具集合变了（工具名，或者去掉说明文字后的参数结构）`
CLAIM|11|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:2375|`case "tool_execution_start"`：`arguments: event.args` 写进 `tool_intent` 记录|`      case "tool_execution_start": {`；`            arguments: event.args,`
CLAIM|12|一致|packages/gateway-contracts/src/validation.ts:175|`packages/gateway-contracts/src/validation.ts` 第 175 行：`if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");`|`        if (!expectedKeySet.has(key)) fail(\`${path}.${key}\`, "unknown field");`
CLAIM|13|一致|packages/runtime-pi/src/tool-activity.ts:16|工具自己已经有同名参数的，不加，也不删它的参数|`    !isRecord(properties) ||`；`    TOOL_ACTIVITY_PARAMETER_NAME in properties ||`；`    TOOL_ACTIVITY_ICON_PARAMETER_NAME in properties`
CLAIM|14|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1529|在已有的隐藏扩展 `himawari-tool-outcomes`|`            name: "himawari-tool-outcomes",`；`            hidden: true,`
CLAIM|15|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1532|的 `tool_call` 钩子|`              pi.on("tool_call", (event) => {`
CLAIM|16|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1533|从 `event.input` 删掉它们|`                if (activityTools.has(event.toolName)) removeToolActivity(event.input);`
CLAIM|17|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2609|所以权限判断（`preflight`）、审批、工具本身和“工具循环停止”的判断看到的都是去掉后的参数|`    expect(executed.get("activity-call")).toEqual({ query: "beef" });`；`    ).toContainEqual({ query: "beef" });`
CLAIM|18|一致|packages/application/src/services/thread-execution-projection.ts:301|`ThreadExecutionProjection` 生成 `kind` 为 `tool` 的过程记录|`                kind: "tool",`
CLAIM|19|一致|packages/application/src/services/thread-execution-projection.ts:73|`activity` 去掉首尾空白、最多 80 个字符|`      ? [...rawActivity.trim()].slice(0, PROCESS_ACTIVITY_MAX_LENGTH).join("")`
CLAIM|20|一致|packages/application/src/services/thread-execution-projection.ts:85|`activityIcon` 在 36 个名字之内就原样给，否则给 `tools`|`    activityIcon: (PROCESS_ACTIVITY_ICONS as readonly string[]).includes(icon)`；`      ? icon`；`      : PROCESS_ACTIVITY_FALLBACK_ICON,`
CLAIM|21|一致|packages/application/src/services/thread-execution-projection.ts:79|记录的 `input` 里不再有这两项|`        value && typeof value === "object" && !Array.isArray(value) ? rest : (value ?? {}),`
CLAIM|22|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:605|网关契约 `threadExecutionRecordSchema` 加这两个字段|`  activity: displayText,`；`  activityIcon: displayText,`
CLAIM|23|一致|apps/control-center/src/execution-view.ts:213|网页按 `itemId` 合并同一步的多条记录时，空值不覆盖已有的值|`    const previous = items.get(record.itemId);`；`      activity: record.activity || previous?.activity || "",`
CLAIM|24|一致|packages/application/src/services/thread-execution-projection.ts:501|执行结束的那条记录两个字段为空字符串|`        activity: "",`；`        activityIcon: "",`；`            ...(ended`；`              ? {}`
CLAIM|25|一致|packages/application/src/services/thread-execution-projection.ts:74|模型没给 `activity` 时，服务器按这个对话的回答语言（`thread.answerLocale`）用模板补一句，例如“搜索网页”|`      : "") || processStepText(toolName, locale);`；`                ...toolActivity(call["arguments"], text(call["name"]), thread.answerLocale),`
CLAIM|26|一致|packages/gateway-contracts/src/process-step.ts:54|模板和“工具名对到哪一类”的表放在 `packages/gateway-contracts/src/process-step.ts`，三种语言一份|`export const PROCESS_STEP_LOCALES = ["zh-CN", "en", "ja"] as const;`
CLAIM|27|一致|packages/gateway-contracts/src/process-step.ts:24|“工具名对到哪一类”的表|`const KIND_BY_TOOL: Readonly<Record<string, ProcessStepKind>> = {`；`  web_search: "search",`
CLAIM|28|一致|apps/control-center/src/step-summary.ts:50|网页的过程区仍从自己的 i18n 文字表取同样的句子|`  return { id: \`step.${kind}\` as MessageId, target };`；`      return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");`
CLAIM|29|一致|apps/control-center/test/step-summary.unit.test.ts:140|`apps/control-center/test/step-summary.unit.test.ts` 的 `[ICON-3]` 锁住网页那几条和共享表逐字相同|`describe("[ICON-3] step names shared with the server", () => {`；`        expect(catalog[\`step.${kind}\` as keyof typeof catalog]).toBe(`；`          PROCESS_STEP_TEXT[locale][kind],`
CLAIM|30|一致|apps/control-center/src/step-summary.ts:1|网页按工具名分类也改用共享表的 `processStepKind`|`import { type ProcessStepKind, processStepKind } from "@himawari-agent/gateway-contracts";`；`  return processStepKind(name);`
CLAIM|31|一致|packages/runtime-pi/src/pi-runtime-adapter.ts:1537|“工具循环停止”的判断用的是 `tool_result` 事件里的参数|`              pi.on("tool_result", (event) => {`；`                    event.input,`
CLAIM|32|不一致|apps/control-center/src/components/tool-icon.tsx:22|服务器按工具名套图标|`export function toolCategory(name: string): keyof typeof symbols {`
CLAIM|33|一致|apps/control-center/src/components/tool-icon.tsx:3|这正是要换掉的写死的表|`const symbols = {`；`  unknown: "wrench",`
CLAIM|34|一致|apps/control-center/src/components/execution-process.tsx:95|网页暂时不显示模型写的那句话|`      return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");`
CLAIM|35|一致|apps/control-center/src/components/execution-process.tsx:95|网页的过程区仍按界面语言显示模板句子|`      return message(tool ? toolStepSummary(tool.name, tool.input).id : "step.other");`
CLAIM|36|一致|packages/application/src/services/thread-execution-projection.ts:304|模板句子在服务器那边按回答语言，在网页上按界面语言，两者可能不同|`                ...toolActivity(call["arguments"], text(call["name"]), thread.answerLocale),`
CLAIM|37|一致|packages/runtime-pi/package.json:11|`[ICON-1]` 用真实的 Pi 1.5.0 会话和假模型|`    "@earendil-works/pi-coding-agent": "1.5.0",`
CLAIM|38|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2585|工具定义带这两个参数|`    expect(offered.get("restaurant_search")).toMatchObject({`；`        activity: { type: "string", description: TOOL_ACTIVITY_PARAMETER.text },`
CLAIM|39|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2605|系统提示只出现一次图标表|`    expect(head?.content.split(CHAT_PROCESS_ICONS_SECTION.text)).toHaveLength(2);`
CLAIM|40|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2609|工具执行和权限判断拿到的参数里没有它们|`    expect(executed.get("activity-call")).toEqual({ query: "beef" });`；`    ).toContainEqual({ query: "beef" });`
CLAIM|41|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2596|工具自己的同名参数原样保留|`    expect(offered.get("diary_note")).toEqual({`；`      required: ["activity"],`
CLAIM|42|一致|packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2619|过程事件里仍有它们|`    const intents = projection.captures.filter(`；`    expect(JSON.stringify(intents)).toContain("找附近的牛肉店");`
CLAIM|43|一致|test/integration/thread-run-lifecycle.test.ts:77|`[ICON-2]` 用真实 SQLite|`  useSqliteContractExecution(execution);`
CLAIM|44|一致|test/integration/thread-run-lifecycle.test.ts:3905|锁住过程记录的两个字段、退回 `tools`|`    expect(tools.map(({ activity, activityIcon }) => [activity, activityIcon])).toEqual([`；`      ["查东京明天的天气", "cloud"],`；`      ["查资料", "tools"],`
CLAIM|45|一致|test/integration/thread-run-lifecycle.test.ts:3914|`input` 里不再有它们|`      expect(tool.input).not.toContain("activity");`
CLAIM|46|一致|test/integration/thread-run-lifecycle.test.ts:3917|用网关契约逐条解析|`    for (const record of records)`；`      expect(() => threadExecutionRecordSchema.parse(record)).not.toThrow();`
CLAIM|47|一致|packages/runtime-pi/test/fixtures/d4-golden-requests.json:14|`packages/runtime-pi/test/fixtures/d4-golden-requests.json` 的两条请求体换成带新参数和图标表的版本|`      "body": "{\"model\":\"deepseek/deepseek-v4.1-flash\",\"messages\":[{\"role\":\"developer\",\"content\":\"You are a controlled restaurant assistant.\\n\\n过程图标：`
CLAIM|48|一致|packages/runtime-pi/test/fixtures/d4-golden-requests.json:4|其他字段不变|`      "method": "POST",`；`      "path": "/v1/chat/completions",`
CLAIM|49|一致|packages/gateway-contracts/src/thread-contracts-v3.ts:605|过程记录多了两个必填字段|`  activity: displayText,`；`  activityIcon: displayText,`
CLAIM|50|一致|packages/application/src/services/thread-prompt-bundle-service.ts:204|每个老对话下一轮换新一次冻结的系统提示和工具|`        else if (toolSchemaChanged(opened.tools, input.candidate.tools))`；`          origin = "tool_schema_changed";`
CLAIM|51|一致|packages/gateway-contracts/src/validation.ts:175|旧版网页解析新记录会报“unknown field”|`        if (!expectedKeySet.has(line)) fail(\`${path}.${key}\`, "unknown field");`
CLAIM|52|找不到|-|旧版手机解析新记录会报“unknown field”|-

未核对的部分：Pi、OpenAI、Claude Code 等外部资料以及 PR 405 编号没有在仓库里核对；iOS/手机客户端没有代码，手机共用模板、手机不再看到工具名、旧版手机解析等说法均未核实。详细设计的一节是从提交 f7cbbf01 读到的，不在当前 HEAD 的文件里；第 48 条来自 `git show 13b46cb69`，该提交对对照文件只有两行增删。
