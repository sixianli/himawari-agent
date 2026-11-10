## 发现（按严重度从高到低）

### 1. 中：日期渲染对非法值没有兜底，坏数据会让整轮上下文组装直接失败
**文件：行**：`packages/application/src/ports/memory-dates.ts:33-44`、`:47-56`

**读代码证实**：`localDate` 对非 `YYYY-MM-DD` 的值直接 `new Date(value)` 后交给 `Intl.DateTimeFormat.formatToParts`，没有 NaN 检查：

```ts
function localDate(value: string, timeZone: string): string {
  if (PLAIN_DATE.test(value)) return value;
  const instant = new Date(value);
  ...
  }).formatToParts(instant);
```

`Intl.DateTimeFormat.formatToParts(Invalid Date)` 会抛 `RangeError`。`memoryDateNote` 在自动带入、档案和 Pi 适配器三条路径上都会调用它。第 2 轮还删掉了上一轮原有的 `if (Number.isNaN(instant.valueOf())) return value;` 保护（见 diff）。

**推测（条件性）**：正常写入路径有 `sqlite-memory-operations.ts:154-158` 的 `validMemoryTime` 校验，所以新数据通常不会触发；但旧库、导入数据、维护脚本或其它 `ProductMemoryRecord` 来源如果留下非法 `validFrom`/`validTo`/空串 `recordedAt`，一条坏记忆就会让整轮 context formation 或档案组装失败，而不是跳过该条日期。生产环境是否存在这类旧数据，未查生产库，未核实。

**建议**：在 `memoryDatesOf` 或 `memoryDateNote` 入口用 `isDateText` 过滤；非法值时退化为不带日期或跳过该条记忆，并补一条坏数据用例。至少恢复 NaN 兜底，避免把数据问题升级为整轮不可用。

### 2. 低：档案的时区来源和自动带入/当前时间的时区来源可能不是同一个
**文件：行**：`apps/agent-service/src/production-run-composition.ts:278`、`:426`；`apps/agent-service/src/service-main.ts:1922-1929`、`:2052-2054`

**读代码证实**：

```ts
// production-run-composition.ts:278  OwnerProfileService
...(options.memoryCapture?.timeZone ? { timeZone: options.memoryCapture.timeZone } : {}),

// production-run-composition.ts:426  Pi 适配器
...(options.timeZone ? { timeZone: options.timeZone } : {}),
```

而 `memoryCapture` 只在 `modelComposition.composition.generateText` 存在时才注入（`service-main.ts:1922-1929`），运行时 `timeZone` 却始终来自 `runPolicy.timeZone`（`service-main.ts:2052-2054`）。

**影响**：未配置记忆提取模型的部署中，档案日期会用 UTC，而自动带入日期和本轮当前时间会用 `runPolicy.timeZone`。同一条记忆在档案里和自动带入里可能差一天；“已用 N 字”也可能因 `起`（14 字）和 `至今`（15 字）差 1 个字符。正常配置（有 `memoryCapture`）两者都来自 `runPolicy`，不受影响，所以是条件性问题。

**建议**：`OwnerProfileService` 的 `timeZone` 应直接来自运行配置的 `runPolicy.timeZone`/`options.timeZone`，不要依赖 `memoryCapture` 是否存在。

### 3. 低：两个“信封读回”校验器不一致，formation 侧完全不检查 `dates`
**文件：行**：`packages/application/src/services/context-projection-service.ts:775-776`；`packages/application/src/services/context-formation-service.ts:774-788`

**读代码证实**：projection 侧校验了形状和“只有 memory 能带”：

```ts
(item["dates"] === undefined ||
  (item["kind"] === "memory" && isMemoryDates(item["dates"])))
```

但 formation 的 `isProductContextEnvelopeV1` 的 `contextBlocks` 校验只检查 `kind`、`ref`、`payloadRef`、`sourceRef`、`dataClassification`，完全没有 `dates`：

```ts
value["contextBlocks"].every((item: unknown) => {
  ...
  isNonEmptyText(item["ref"]) &&
  isNonEmptyText(item["payloadRef"]) &&
  ...
  isDataClassification(item["dataClassification"])
})
```

**影响**：`ContextFormationService.readExistingEnvelope` 这一条“读回信封”路径会接受畸形 `dates`，也会接受非 memory 块上的 `dates`；只有后续 projection 才拒绝。当前模型最终仍会经过 projection，所以没有直接绕过，但与 ADR 第 56 行“读回信封时校验日期的形状，只有记忆块能带”不完全一致，也给未来其它消费者留下漏洞。属于防御深度和规则一致性缺口。

**建议**：抽出一个共享的 `isProductContextBlock`/`isMemoryDates` 校验，两个读回入口共用；补一条把畸形 `dates` 放进旧信封、走 formation reuse 的反向用例。

### 4. 低：ADR 说“和记忆存储的校验一致”，实际不一致
**文件：行**：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:264-267`；`packages/application/src/ports/memory-dates.ts:17-23`；`docs/adr/0199-show-memory-dates-to-the-model.md:56`

**读代码证实**：存储侧 `validIsoTimestamp` 要求 `new Date(value).toISOString() === value`，即只接受规范的 UTC 毫秒格式：

```ts
function validIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
```

而 `isMemoryDates` 的 `ISO_INSTANT` 接受带偏移的时间、无毫秒的时间：

```ts
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
```

**影响**：不会误拒存储产生的值（存储值恰好都符合严格正则），但会接受存储侧会拒绝的值；ADR 的“和记忆存储的校验一致”不准确。另外 `assertMemoryShape` 并不校验 `recordedAt`（`sqlite-memory-operations.ts:583-628` 只校验 `updatedAt`/`lastUsedAt`/属性时间），只是 INSERT 恰好用 `updatedAt` 写入 `recorded_at`（`:750`）。这不是当前可见的 bug，但两套规则以后容易漂移。

**建议**：抽一个共享的日期形状检查，或把 ADR 改成“信封接受 `YYYY-MM-DD` 或可解析且带时区的 ISO 时间，比存储写入校验略宽”。

### 5. 低：后台记忆整理已经显示日期，但格式和时区与本次不同；邮件判断仍没有日期
**文件：行**：`packages/memory-engine/src/consolidation.ts:105-111`；`packages/application/src/services/proactive-mail-check-service.ts:389-396`；`docs/adr/0199-show-memory-dates-to-the-model.md:82`

**读代码证实**：记忆整理并不是“完全没日期”，而是已有另一种：

```ts
function day(memory: ProductMemoryRecord): string {
  return (memory.attributes?.validFrom ?? memory.recordedAt ?? memory.updatedAt).slice(0, 10);
}
...
`${label}（${day(memory)}）${text}...`
```

这里 `recordedAt` 是 UTC ISO 即时串，`slice(0, 10)` 取的是 UTC 日期，不做配置时区换算；同一条记忆在整理提示里可能是 `（2026-11-08）`，在本 PR 的聊天资料块里按东京时区可能是 `（2026-11-09）`。邮件判断则只传 `mailId/id/text/tentative`，确实没有日期。

**判断**：ADR 明确把这两条列为范围外，作为本 PR 是可接受的；但“已知缺口”的措辞应区分：整理路径是“已有日期但格式/时区不同”，邮件路径才是“没有日期”。如果之后要在整理里复用 `memoryDateNote`，会改变后台请求字节，需要单独按规则评估缓存影响。

**建议**：把这条写进 ADR 的“后果”或另开后续任务；至少在文档里避免让读者以为整理提示完全看不到日期。

### 6. 低：ADR 的字数范围和界面文案与实际不一致
**文件：行**：`docs/adr/0199-show-memory-dates-to-the-model.md:80`；`packages/prompt-catalog/src/memory.ts:150-156`；`apps/control-center/src/i18n/resources/zh-CN.ts:827`、`:831-832`

**读代码证实**：upcoming 的模板是 `text("（") + slot("from") + text(" 起）")`，即 `（2027-01-01 起）` 共 14 个字符；ADR 写“每行多 15 到 25 个字”。另外档案页面展示的 `line.text` 不含日期，但 `profileUsage.used` 包含日期，而界面文案只说“已用 {used} / {limit} 字”，没有说明日期也计入，用户无法用可见文本对上这个数。

**建议**：ADR 改为 14–25；界面说明加一句“字数包含每条记忆后的日期”，或在记忆页的档案行展示日期。

## 推测与未核实

- 生产数据库里是否存在旧版本写入的非法 `validFrom`/`validTo` 或空 `recordedAt`：未核实，因此第 1 条的可达性是条件性的。
- `prompt-manifest.json` 中三段旧条目和新增 `memory.date.upcoming` 的 `sha256` 是否与实际分段一致：无法运行测试，未核实。代码形状上条目和导出都齐全。
- 后台整理/邮件判断改动后的真实模型输出质量：未运行，未核实。
- `Date.parse` 对 `2026-02-30` 这类日历上不存在的日期的具体归一化行为：未运行 Node，未核实；不过它和存储侧 `validMemoryTime` 用的是同类 `Date` 解析，正常路径两端一致。

## 侧重检查

- **错误路径**：信封读回对 `dates` 有校验，`recordedAt: ""`、数字、`"下个月"`、`"2026-11-09 08:00"`、缺字段、多字段都会被 projection 拒绝；旧信封没有 `dates` 会被接受。问题是 formation 侧读回没校验，以及生产/档案直接调用 `memoryDateNote` 时没有兜底。见发现 1、3。
- **不合规范/不可信输入**：`validFrom`/`validTo` 来自模型提取，最终由存储的 `validMemoryTime` 限制为 null、规范 ISO 或 `YYYY-MM-DD`；日期格式化最终只输出数字和固定文字，不会把任意文本注入提示词。失败模式是抛异常，不是提示词注入。
- **安全/隐私**：只多了“何时记下/生效时间段”，没有新增明文、日志或跨分类暴露；记忆的分类和遮盖逻辑未变。
- **资源耗尽**：每条记忆会构造新的 `Intl.DateTimeFormat`，档案预算最多约一百行、自动带入受搜索上限限制，没有新增无界循环或大对象；相对已有的多次 `readText`，CPU 开销可接受，但可在 `memoryDateNote` 内缓存 formatter。
- **不可撤销操作**：本改动只读、只渲染，没有删除/归档/发送类副作用。
- **规则/文档一致性**：提示词目录条目的 `layer: "last-user-message"` 与 `.claude/rules/prompt-prefix.md` 第 2、4 条一致；未改系统提示、工具定义或历史。ADR 与代码的偏差集中在第 4、5、6 条。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。日期只加在最后一条用户消息：
- `packages/runtime-pi/src/pi-runtime-adapter.ts:610-636` 的 `turnPrompt` 把 `contextBlockContent` 及其日期放在本轮 `<himawari-context>` 中；`contextBlockContent` 是 `` `${marker}\n${block.content}${dated}` ``。
- `packages/application/src/services/context-formation-service.ts:607-614` 只把 `dates` 写进信封的记忆块；`context-projection-service.ts:419-432` 把它带到运行投影；没有进入系统提示、工具定义或历史。
- `owner-profile-service.ts:302-306` 的档案日期写在当前档案块内容里，而档案块同样由 `turnPrompt` 放进最后一条消息。

系统提示、工具定义、历史消息和遮盖逻辑都没有改动；每轮变化的时间、本轮记忆、运行环境仍在最后一条消息里。旧历史不补日期，符合只追加。

**2. 同一段文字会不会在不同请求里变成不同字节？**
正常配置下不会：`memoryDateNote` 只依赖 `recordedAt`/`validFrom`/`validTo` 和配置时区，不依赖 `now`；档案行按 `ownerFirst`（置顶、重要度、id）确定性排序；`Intl` 输出在固定时区和固定运行环境下确定。

但有几个条件性例外：
- 时区来源不一致时（发现 2），同一记忆在档案和自动带入里可能差一天。
- 旧记忆 `recordedAt` 退回 `updatedAt` 时，恢复/更新可能让“记于”变一次；ADR 已提到，且只影响最后一条消息。
- 后台记忆整理已有日期用 `.slice(0, 10)`（UTC），与本 PR 的按时区换算可能不一致（发现 5）。

**3. 有没有自动检查？反向用例真的会失败吗？**
有，且多数是真实反向门：
- `test/integration/context-projection.test.ts:292-316`：6 种畸形 `dates` 必须被拒绝；其中 `validFrom: "下个月"` 和第 1 轮宽松校验相比是本轮新增的真实反向门。
- `packages/application/test/owner-profile-service.unit.test.ts:216-227`：UTC 下 `2026-11-09` 与 recordedAt 的 UTC 日期相同应写“起”，东京下写“至今”；若实现改成“和今天比”，这条会失败。
- 同文件预算测试（约 `:370`）断言 `usage.used` 包含日期长度；如果预算漏算日期会失败。
- `packages/runtime-pi/test/prompt-prefix.compat.test.ts:412-439`：真实适配器三轮请求必须 append-only，并包含三种日期格式。
- `test/integration/memory-model-visible.test.ts:394-420`：上下文组装→信封→读回→适配器，请求里必须出现日期。
- `apps/agent-service/test/production-model-composition.unit.test.ts` 与 `test/integration/production-memory-capture.test.ts` 覆盖生产查询交出日期和“已用”字数。

缺口：没有“非 memory 块带 dates 必须被拒绝”的反向用例；没有 formation reuse 路径的畸形 dates 用例；没有坏库数据触发 `localDate` 的用例；记忆页生产接线的时区只由 `production-http-composition` 改到，未看到对应端到端断言；`prompt-manifest` 的 sha 未运行验证（未核实）。

**4. 每个新值，产生端和使用端都能接受吗？**
逐个核对如下：
- `dates.recordedAt`：由 `production-run-memory.ts:369-380` 的 `memoryDatesOf` 从 `recordedAt ?? updatedAt` 产生；存储侧 `memoryFromRow` 返回的 `recordedAt` 实际是 `recorded_at ?? updated_at`（`sqlite-memory-operations.ts:482`），INSERT 时 `recorded_at` 写入 `updatedAt`（`:750`），是规范 ISO。消费端 `isMemoryDates` 接受规范 ISO/`YYYY-MM-DD`，不会误拒。
- `dates.validFrom`/`validTo`：存储侧 `validMemoryTime` 只允许 null、`YYYY-MM-DD` 或严格 `toISOString()` 形式（`:154-158`、`:264-267`）；消费端正则更宽，存储产生的值都能通过。没有发现会误拒合法存储值的路径。
- 信封 `dates`：`context-formation-service.ts:607-614` 产生，`context-projection-service.ts:775-776` 校验形状和“仅 memory”；projection 端能接受。formation 读回端不检查但也不会拒绝（发现 3），是两端校验不一致，不是误拒。
- `MemoryDates`/`dates` 类型和导出：`ports/index.ts:30`、`runtime-port.ts:106-107` 都已导出，Pi 适配器和测试可编译使用。
- 提示词 id `memory.date.*`：已在 `prompt-catalog/src/memory.ts` 定义并注册到 `prompt-manifest.json`；结构上和清单检查机制一致。清单 `sha256` 是否正确未运行验证。
- `timeZone`：使用端是 `memoryDateNote`，产生端有 `runPolicy` 和 `memoryCapture?.timeZone` 两个来源；发现 2 是唯一发现需要统一的地方。

I-73 角度的结论：新增的 `dates` 不经过任何对外网关契约，现有硬校验只有两个信封校验器，不会出现“清单 id 过不了后端”的同类问题；真正需要补的是 formation 侧校验器和 prompt-manifest 的运行验证。
