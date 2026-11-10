## 发现（读代码证实）

### 1.【中】未来的 `validFrom` 会被写成“至今”，把“还没发生”说成“目前成立”
- 文件：`packages/application/src/ports/memory-dates.ts:40-46`；相关：`packages/prompt-catalog/src/memory.ts:26`、`packages/application/src/services/owner-profile-service.ts:98-103`、`packages/persistence-sqlite/src/sqlite-memory-operations.ts:242-246`
- 问题：代码只按 `validTo === null` 判断“至今”，没有判断 `validFrom` 是否已经到来。记忆提取明确允许未来日期，而档案的 `currentlyValid` 只检查 `validTo`，检索也没有排除未来的 `validFrom`，所以“下个月搬到杭州”这类记忆会显示成“（2027-01-01 至今）”。
- 证据：
  ```ts
  return dates.validTo === null
    ? renderPrompt(MEMORY_DATE_ONGOING, { from })
    : renderPrompt(MEMORY_DATE_RANGE, { from, to: localDate(dates.validTo, timeZone) });
  ```
  ```ts
  // memory.ts:26
  "validFrom：如果这件事从某个日期开始才成立（例如“下个月搬到杭州”）..."
  ```
  ```ts
  // owner-profile-service.ts:102
  return attributes.validTo === null || attributes.validTo > now;
  ```
- 建议：为“尚未开始”增加格式，或对 `validTo === null` 统一用“（from 起）”；不要用每轮变化的 `now` 决定同一记忆的字节。补未来 `validFrom` 的测试。

### 2.【中】`isMemoryDates` 只检查键名和非空字符串，坏日期会原样进入提示词
- 文件：`packages/application/src/ports/memory-dates.ts:25-28,49-61`；`packages/application/src/services/context-projection-service.ts:775-776`；`packages/application/src/services/context-formation-service.ts:774-789`
- 问题：信封校验只要求三个键、值为非空字符串，不校验 `YYYY-MM-DD` 或规范 ISO 时间。`localDate` 解析失败时又把原值原样返回，所以 `recordedAt: "not-a-date\n..."` 之类会直接拼进模型提示词。另一个信封校验器 `context-formation-service.ts` 完全没有校验 `dates`，两边校验强度不一致。
- 证据：
  ```ts
  const optionalText = (field: unknown) =>
    field === null || (typeof field === "string" && field.length > 0);
  ...
  typeof record["recordedAt"] === "string" &&
  record["recordedAt"].length > 0
  ```
  ```ts
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return value;
  ```
  `context-projection.test.ts` 的反向用例只覆盖空串、数字、缺键、多键，没有覆盖非日期字符串。
- 建议：抽一个共享校验器，对 `recordedAt` 要求规范 ISO，对 `validFrom/validTo` 要求 `YYYY-MM-DD` 或规范 ISO，并拒绝换行/控制字符；两个信封校验器都调用它。补“非日期字符串被拒”的反向用例。

### 3.【中/低】ADR 说“模型拿到记忆有三条路”，但邮件判断也把记忆交给模型且没有日期
- 文件：`docs/adr/0199-show-memory-dates-to-the-model.md:30`；`packages/application/src/services/proactive-mail-check-service.ts:174-180,386-398,1210-1236`；对照：`packages/memory-engine/src/consolidation.ts:105-111`
- 问题：ADR 声称只有自动带入、档案、recall 三条路，但邮件判断的提示词也直接包含记忆正文，而且 `PromptMemory` 没有日期字段。后台整理至少带了 `day()`，邮件判断则完全没有日期。邮件是否紧急可能依赖记忆的新旧，因此这是实际缺口，不只是文档措辞问题。
- 证据：
  ```ts
  interface PromptMemory {
    readonly mailId: string;
    readonly id: string;
    readonly text: string;
    readonly tentative?: true;
    readonly dataClassification: DataClassification;
  }
  ```
  ```ts
  memories.map(({ mailId, id, text, tentative }) => ({
    mailId, id, text, ...(tentative ? { tentative } : {}),
  }))
  ```
- 建议：要么把日期加进 `PromptMemory`，要么在 ADR 中明确写成“本次不覆盖，已知缺口”，并删掉“只有三条路”的说法。

### 4.【低/中】档案日期与自动带入日期的时区来源不是同一个配置
- 文件：`packages/application/src/services/owner-profile-service.ts:178-180`；`apps/agent-service/src/production-run-composition.ts:278,426`；`apps/agent-service/src/production-http-composition.ts:1043-1055`
- 问题：档案使用 `options.memoryCapture?.timeZone`，运行时自动带入使用 `options.timeZone`，内存概览用的另一份 `OwnerProfileService` 根本没传 `timeZone`。正常 `service-main.ts:1924-1929,2052-2054` 两者都来自 `runPolicy.timeZone`，但一旦 `memoryCapture` 缺失或配置不同，同一条记忆在档案和资料块里可能显示不同日期。
- 证据：
  ```ts
  ? memoryDateNote(memoryDatesOf(memory), this.#options.timeZone ?? "UTC")
  ```
  ```ts
  ...(options.memoryCapture?.timeZone ? { timeZone: options.memoryCapture.timeZone } : {}), // profile
  ...
  ...(options.timeZone ? { timeZone: options.timeZone } : {}), // runtime
  ```
- 建议：档案和自动带入统一使用同一个 `runPolicy.timeZone`；内存概览的 `OwnerProfileService` 也传入同一时区，并加一条非 UTC 的生产路径测试。

### 5.【低】界面“已用 N 字”含日期，但档案行文本本身不含日期；ADR 的“每行约 15 字”对区间格式也不准确
- 文件：`packages/application/src/services/owner-profile-service.ts:131-132,217-221,305`；`apps/agent-service/src/production-memory-control.ts:555-581,701-705`；`docs/adr/0199-show-memory-dates-to-the-model.md:79`
- 问题：`usage.used` 用 `limit - remaining` 计算，确实包含 `dateNote.length`；界面直接显示这个 `used`。但 `outline()` 返回给界面的 `text` 没有拼 `dateNote`，所以界面列出的字数和实际看到的行文本不一致。区间日期“（2021-03-01 至 2024-08-31）”是 25 个字符，不是 ADR 说的约 15 个。
- 证据：
  ```ts
  const line = ({ memory, text }: { memory: ProductMemoryRecord; text: string }) =>
    Object.freeze({ memoryId: memory.id, text, updatedAt: memory.updatedAt });
  ```
  ```ts
  used: limit - remaining,
  ```
- 建议：让 `outline` 同时返回展示用文本（含日期）和预算用文本，或明确说明界面列表不展示日期；修正 ADR 的字数说明。

## 推测 / 未核实
- **未运行测试**：本次只能用只读工具和 git 命令，没有执行 `vitest`、`npm run check`，所以“反向用例真的会失败”只做了代码推断，没有实测。
- **未核实 manifest SHA**：无法运行哈希计算，`prompt-manifest.json` 新增三条的 SHA 只核对了键名、`changedIn`、`reason`，数值未验证。`prompt-catalog.unit.test.ts:172-194,300-319` 会在运行时校验，按代码设计能发现错误。
- **邮件判断的影响程度是推断**：代码证实它发送无日期记忆；是否真的影响紧急程度判断，需要产品或评测确认。
- **时区不一致是否在生产配置中出现**：代码路径存在；正常 `service-main.ts` 路径下两者同源，是否会出现 `memoryCapture` 缺失或时区不同，未核实。

## 侧重检查
- **错误路径 / 不可信输入**：找到 `isMemoryDates` 的格式校验缺口和 `localDate` 的原值回退；这是本次最值得修的输入校验问题。旧信封没有 `dates` 时仍被接受，未发现误拒旧信封。
- **资源耗尽**：没有新增无界循环；日期格式化次数受记忆选择上限和档案预算限制。`localDate` 每次新建 `Intl.DateTimeFormat`，量大时有额外开销，但未构成明显风险。
- **不可撤销操作**：本改动没有删除或覆盖操作；档案 payload 写入前有 `payloads.get(input.ref)` 幂等检查，日期变化只会产生新的 payload ref。
- **规则 / 文档一致性**：ADR 的前提 1、2、3、5、6 基本与代码相符；但“模型拿到记忆有三条路”与邮件判断代码不符，时区来源和每行字数说明也有偏差。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。日期只在 `turnPrompt` 生成的 `<himawari-context>` 资料块里，`pi-runtime-adapter.ts:610-628` 拼好后由 `session.prompt(turn, ...)` 作为本轮最后一条用户消息发出（`pi-runtime-adapter.ts:1287,1765`）；系统提示和工具仍由 `projection.systemInstruction` 及冻结工具单独生成（`1307-1318`）。历史消息中没有新增日期，旧信封没有 `dates` 时也不会补。每轮变化的是“本轮选中哪些记忆”，日期随资料块位于最后一条消息，符合只追加规则。需要注意：时区来源不一致（发现 4）会让同一条记忆在档案和资料块中出现不同日期，但不影响已发历史的前缀。

2. **同一段文字在不同请求里会不会变成不同字节？**
   主要路径是确定的：`localDate` 对 `YYYY-MM-DD` 原样返回，对 ISO 时间用固定 `en-US` 和配置时区格式化；没有“今天”“三天前”这类依赖当前时间的值；`recordedAt` 来自持久化的 `recorded_at`（插入时写入，更新语句不改，见 `sqlite-memory-operations.ts:725,769-775,482`）。但有三点例外：坏日期字符串会被原样返回（发现 2）；时区来源不一致会让同一记忆在不同路径/配置下不同（发现 4）；配置时区本身变化时，同一 ISO 时间会显示不同日期（这是配置变化的预期结果）。

3. **有没有自动检查，反向用例是否真的会失败？**
   有：`prompt-prefix.compat.test.ts` 的 `[MEMORY-DATE]` 检查末尾资料块和追加性；`context-projection.test.ts` 的四类坏日期；`memory-model-visible.test.ts` 的端到端；`production-model-composition.unit.test.ts` 的查询交出日期；`owner-profile-service.unit.test.ts` 的档案日期和预算。按代码推断，删掉 `isMemoryDates` 或允许 `dates` 无条件通过时，四类坏日期用例会失败。但缺少：非日期字符串、未来 `validFrom`、同一记忆跨请求字节稳定、档案/自动带入时区一致性的用例。未实际运行，标为未核实。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `MemoryDates`：由 `memoryDatesOf` 在 `production-run-memory.ts:378` 和 `owner-profile-service.ts:179` 产生；`context-formation-service.ts:607-614` 写入信封；`context-projection-service.ts:775-776` 读回；`pi-runtime-adapter.ts:635` 消费。写入端不校验，读回端只做形状校验，两端强度不一致（发现 2）。
   - `ProductContextBlock.dates` / `RuntimeProjectionContextBlock.dates`：只允许 memory 块带日期，读回校验限制 `kind === "memory"`，这一点两端一致。
   - 旧信封：`dates === undefined` 允许通过，未发现误拒。
   - `memory.date.recorded/range/ongoing`：源码 id 与 manifest 键一致，`usedBy` 指向 `memory-dates.ts`，字数和层定义一致；SHA 未核实。
   - `OWNER_PROFILE_CHARACTER_BUDGET` / 界面“已用 N 字”：预算和 `usage.used` 都含日期；界面列表文本不含日期（发现 5）。
   - 时区配置键：运行时与档案未统一来源（发现 4）。
