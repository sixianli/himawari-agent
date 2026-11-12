## 结论摘要

我没有运行测试和 `npm run check`，下面结论都来自读代码。这个增量（`a6082675..cfd7126`）主体方向正确：模板句子只影响显示，活动参数仍由模型追加到历史里，系统提示里的图标表是固定文本。没有发现高严重度问题；发现 1 个需要修的边界实现、几处测试/文档与代码不完全一致，以及一个网站合并的潜在空值问题。

---

## 发现

### 1. 中低：判断「冻结工具是否带 activity」时看的是重新计算的定义，不是真正的冻结 `bundle.tools`

文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:1367-1395`

代码：

```ts
1367:      const frozenDefinitions = frozenDescriptors.map((descriptor) =>
1368:        this.toolDefinition(descriptor),
1369:      );
...
1384:      const handleToolsCarryActivity =
1385:        !bundle || frozenDefinitions.some(({ parameters }) => carriesToolActivity(parameters));
1386:      const runToolDefinition = (descriptor: RuntimeToolDescriptor) =>
1387:        this.toolDefinition(descriptor, handleToolsCarryActivity || !isHandleTool(descriptor));
...
1391:      const requestTools = bundle
1392:        ? [
1393:            ...(JSON.parse(bundle.tools) as Tool[]).map(providerTool),
```

`frozenDefinitions` 是用当前目录里的说明文字重新算出来的定义，默认 `activity = true`；而真正发给模型的是 `bundle.tools`。正常的新一轮运行中两者相同，因为 `#current()` 会用 `toolSchemaChanged` 重建旧 schema。但带 pin 的继续运行会直接返回旧 bundle：

`packages/application/src/services/thread-prompt-bundle-service.ts:174-182`

```ts
174:    const pin = await this.#readPin(input);
175:    if (pin) {
...
177:      const pinned = await this.#dependencies.store.get({ ...scope, generation: pin.generation });
...
179:      const opened = await this.#open(pinned);
180:      if (!this.#toolsAvailable(opened, input.identity))
181:        throw new Error("RUNTIME_PROMPT_BUNDLE_TOOL_MISSING");
182:      return opened;
```

这里没有调用 `toolSchemaChanged`。因此「暂停后跨部署恢复」的 run 可以拿回旧 bundle：冻结工具实际不带 activity，但 `frozenDefinitions` 现在带 activity，`handleToolsCarryActivity` 仍为 true，执行句柄工具会拿到 activity 参数，而系统提示是旧 bundle、没有「过程图标」一节。结果是工具定义里写着“从系统提示‘过程图标’一节挑”，但该节不存在。

这不是相对上一版的回归（上一版执行句柄工具无条件带 activity），也不影响旧对话的缓存字节；但作者说法“只在冻结的工具带 activity 参数时才带”和 ADR 的表述与代码不完全一致。

建议：从 `JSON.parse(bundle.tools)` 判断实际的冻结工具是否存在 `activity`/`activityIcon` 属性（按属性名，不要只按说明文字比较），或至少同时检查 `bundle.tools`；补一个“有冻结工具但冻结工具不带活动参数”的用例，以及一个 pin/旧 bundle 的用例。

---

### 2. 低：网页合并时 `activityIcon` 与 `activity` 是否为空绑定，空图标仍会覆盖旧图标

文件：`apps/control-center/src/execution-view.ts:212-214`

代码：

```ts
212:      input: record.input || previous?.input || "",
213:      activity: record.activity || previous?.activity || "",
214:      activityIcon: record.activity ? record.activityIcon : previous?.activityIcon || "",
```

`activity` 使用“空值回退”，但 `activityIcon` 是“只要当前记录有 activity 就采用当前图标”。如果某条记录 `activity` 非空、`activityIcon` 为空，会把之前的图标覆盖成空字符串。目前服务器端 `toolActivity()` 只要 `activity` 非空就一定会给 `activityIcon`（不在白名单时给 `tools`），所以当前生产路径不会触发；但合并语义与 ADR 说的“空值不覆盖已有的值”不完全一致，将来其他生产者或旧数据可能踩到。

建议：改成 `record.activityIcon || previous?.activityIcon || ""`，并补“当前记录有 activity 但图标为空”的用例；如果故意希望图标跟随当前句子，应在 ADR 里写明。

---

### 3. 低：句子清洗没有覆盖全部 Unicode 格式字符（不可见字符仍可能残留）

文件：`packages/application/src/services/thread-execution-projection.ts:57-61`

代码：

```ts
57: function oneLine(value: string): string {
58:   return value
59:     .replace(/[\p{Cc}\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
60:     .replace(/\s+/gu, " ")
61:     .trim();
62: }
```

控制字符 `Cc`、常见双向控制符都处理了，但 `U+061C`（阿拉伯字母标记）、`U+200B`、`U+200C`、`U+200D`、`U+2060-U+2064`、`U+FEFF` 等 `Cf` 格式字符不在范围内。它们不会像 `U+202E` 那样强制改变文字方向，但可以在过程行里制造不可见字符或视觉混淆。模型给的内容属于不可信显示输入。

建议：若目标是“过程行永远单行、无可操控不可见字符”，用 `\p{Cf}` 加显式范围一起替换，或在 ADR 里明确只处理 `Cc` 和双向覆盖符。

---

### 4. 低：测试没有覆盖“有冻结工具、但冻结工具都不带 activity”的分支

文件：`packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts:2635`、`2672-2686`

新用例名是“when no frozen tool offers the process icons”，但实际 `listAuthorized` 只返回一个执行句柄工具：

```ts
2672:    tools.listAuthorized = async (): Promise<readonly RuntimeToolDescriptor[]> => [
2673:      {
...
2676:        capabilityHandleRef: "handle-diary-note",
2677:        name: "diary_note",
```

也就是 `frozenDefinitions` 是空数组，覆盖的是 `[].some(...) === false`，不是“存在冻结工具但它们都不带这两个参数”。ADR 第 93 行写成“冻结的工具都不带这两个参数时”会让人以为这个分支被锁住了。另一个缺口是没有覆盖 pin/旧 bundle 与 `activityTools` 的一致性。

建议：增加一个用例：一个冻结工具（参数为对象但已自带不同说明的 `activity`，或参数结构不是对象）加一个执行句柄工具，断言句柄工具不带活动参数；再增加一个用假 `promptBundles.resolve` 返回旧 `bundle.tools` 的用例，锁住第 1 条发现的行为。

---

### 5. 低：ADR 说的“工具自己的同名参数不加也不删”和 `removeToolActivity` 在边界上不一致

文件：`docs/adr/0250-tools-carry-model-written-activity-and-icon.md:52`、`91`；`packages/runtime-pi/src/tool-activity.ts:38-46`

ADR：

```md
52: 1. **参数。**...工具自己已经有同名参数的，不加，也不删它的参数。...
...
91: - **服务器按参数名取这两项。**...工具执行拿到的参数不受影响。目前生产里没有这样的工具。
```

代码：

```ts
38: export function carriesToolActivity(parameters: unknown): boolean {
...
40:   const activity = parameters["properties"][TOOL_ACTIVITY_PARAMETER_NAME];
41:   return isRecord(activity) && activity["description"] === TOOL_ACTIVITY_PARAMETER.text;
42: }
...
44: export function removeToolActivity(input: Record<string, unknown>): void {
45:   delete input[TOOL_ACTIVITY_PARAMETER_NAME];
46:   delete input[TOOL_ACTIVITY_ICON_PARAMETER_NAME];
47: }
```

如果某个工具自己的 `activity` 参数说明恰好等于 `TOOL_ACTIVITY_PARAMETER.text`，它会被 `activityTools` 收录，`tool_call` 钩子会在执行前删掉工具自己的参数，这与“不删它的参数”和“工具执行拿到的参数不受影响”不完全一致。生产里目前没有这样的工具，且需要说明文字完全一致才触发，属于极窄边界。

建议：要么把 `carriesToolActivity` 与“是否是本适配器加的参数”用更可靠的标记区分（例如 schema 上记录来源），要么在 ADR 第 52 行把“不删”限定为“不加新参数；若同名参数说明与本目录一致，会按过程参数在钩子里移除”。

---

## 侧重检查

我查过并核对的错误/不可信输入路径：

- `activity` 是模型可控字符串：换行、`Cc`、主要双向控制符会被替换，图标只接受白名单，未知图标回退 `tools`。结论：主路径安全；残留 `Cf` 见发现 3。
- `activityIcon` 非字符串、空串、未知名字：投影里 `typeof rawIcon === "string" ? rawIcon.trim() : ""`，再按 `PROCESS_ACTIVITY_ICONS.includes` 校验，未知回退 `tools`。结论：不会把任意字符串传给客户端作为图标名。
- 工具名/语言不可信：`processStepKind` 用 `Object.hasOwn`，`"constructor"`/`"toString"` 走 `other`；未知 locale 回退 `zh-CN`，契约测试已覆盖。结论：无原型链取值问题。
- 参数名删除的不可逆操作：`removeToolActivity` 直接删 `event.input` 的两个键。主路径依赖“这是适配器自己加的参数”，但同名工具参数边界见发现 5；目前生产无此工具。
- 资源耗尽：`oneLine` 在截到 80 个字符之前处理完整字符串；模型输出有上限，读取 payload 也有 1 MiB 上限，未发现可实际放大的入口。
- 规则/文档一致性：ADR 0250 的“退回句子在读取时生成”“服务器按参数名取这两项”与投影代码一致；但“冻结工具带参数”的判断依据与 ADR 文字不完全一致（发现 1），“不删工具同名参数”的边界不严谨（发现 5）。
- 未核实：Pi 1.5.0 的 `tool_result` 事件里的 `input` 是否一定是钩子删除后的参数，因此“工具循环停止”的判断不会因模型每轮换一句 activity 而失效，我没有 Pi 源码可读，现有 `[ICON-1]` 也只断言了 `preflight`/`execute`，没有覆盖 `PiToolProgressGuard`。这一点不是本次增量引入的，但建议补一条真实 Pi 会话用例锁住。
- 未核实：作者说的 84 个测试文件/1422 例和 `npm run check` 50 步全过，我没有运行环境，不能证实；另外 `prompt-manifest.json` 的三个新 sha256 我也没有运行生成器复核，只确认了 id、层、文字与代码引用关系一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是不是仍然只在末尾追加？每轮会变的值是否都在最后一条消息里？

结论：本次增量本身没有把“每轮会变的值”放进系统提示或工具定义；`activity` 是模型自己写在工具调用参数里的内容，会作为历史追加；退回句子只进入过程记录，不发给模型。但整个 PR（不只本次增量）会给所有工具参数结构加 `activity`/`activityIcon`、给系统提示加图标表，因此老对话下一轮会按 `toolSchemaChanged` 换新一次冻结开头，这是 ADR 0250 前提里 Andy 已同意的一次性变化。换新之后同一对话仍只追加。

例外/边界：`pi-runtime-adapter.ts:1384-1395` 的执行句柄工具定义依赖冻结工具，而 `thread-prompt-bundle-service.ts:174-182` 的 pin 路径可以继续提供旧 bundle；这时句柄工具会带 activity，但系统提示没有图标表。这不是每轮变化，也不改旧缓存开头，但会形成“工具定义说去图标表挑、系统提示没这张表”的不一致，见发现 1。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

模型请求侧：没有发现新增的逐次变化字节。图标表是固定数组顺序，`processIconsSection` 只做 `some` 布尔判断，`withToolActivityParameters` 按固定顺序在 `properties` 末尾追加两个属性，`activityTools` 只是 `Set` 成员判断，不参与序列化。

显示侧：模型自己写的 `activity` 清洗是确定性的；但“模型没给 activity 时”的模板句子是在读取时按 `thread.answerLocale` 生成，改了回答语言后旧步骤的模板句子会跟着变语言。ADR 已把它列为已知局限，且它只影响显示，不影响发给模型的内容。因此不违反模型请求的确定性要求。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有覆盖，且从代码推理反向用例会失败：

- `[ICON-1]` 新用例：去掉 `handleToolsCarryActivity`/`runToolDefinition` 修复后，句柄工具会重新带 `activity`，`offered.get("diary_note")` 的精确断言会失败。
- `[ICON-1]` 原有断言：`executed.get("activity-call")` 和 `preflight` 参数必须是 `{ query: "beef" }`；删掉 `removeToolActivity` 会失败。新增的 `followUpContext` 断言也锁住了下一轮历史里保留模型原样参数。
- `[ICON-2]` 集成用例：把 `oneLine` 换回 `rawActivity.trim()` 后，`["查东京 明天的 天气"]` 的断言会失败。
- `[ICON-2]` 网页合并用例：去掉 `previous?.activity` 回退会失败。
- `[ICON-1]` 图标文字用例：文本与 `PROCESS_ACTIVITY_ICONS` 不一致会失败。
- `[I-78]`/`[PROMPT-CATALOG]`：`TRUSTED_PROMPT_TEXTS` 与整个目录模块不一致、manifest 缺项或 digest 过期会失败。

缺口：没有覆盖“冻结工具非空但都不带 activity”的分支；没有覆盖 pin/旧 bundle 与 `activityTools` 一致性；没有覆盖 `PiToolProgressGuard` 在 activity 被删除后的行为；`[ICON-1]` 的图标文字测试名义上“and nothing else”，但正则只抓特定格式，不能证明没有别的图标名混入。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

已核对：

- `activity`/`activityIcon` 记录字段：由 `thread-execution-projection.ts` 的 `base`、`toolActivity()`、`rememberStateRecords()` 产生；网关契约 `threadExecutionRecordSchema` 把两者都设为必填 `displayText`，空字符串合法；网页 `execution-view.ts` 会合并；其他生产代码没有另造 `ThreadExecutionRecord`。`displayText` 上限 65536，而 `activity` 最多 80 个码点，兼容。
- 图标名：`activity.ts` 的数组是服务器接受的唯一来源，`thread-execution-projection.ts` 用它校验，系统提示文字由测试锁住逐字一致；`tools` 回退值也在数组里。
- manifest id：`tools.activity-parameter`、`tools.activity-icon-parameter`、`chat.process-icons-section` 与 `fixedPrompt` 的 id 一致；`prompt-catalog.unit.test.ts` 会检查 manifest 的 digest、缺失和未知项。我未独立重算 sha256。
- `processStepKind`/`processStepText`：服务器投影用共享表；网页 `step-summary.ts` 改为用共享 `processStepKind`，网页 i18n 测试遍历所有 `PROCESS_STEP_KINDS` 与三种语言的文本逐字比对；契约测试覆盖常见工具名和 `constructor`/`toString`。
- 但两端不完全对称的地方是发现 1 的“bundle.tools 与重新计算定义不一致”，以及发现 2 的客户端空图标合并；前者当前正常路径不触发，后者当前服务器不会产生“activity 非空、icon 为空”的记录。
