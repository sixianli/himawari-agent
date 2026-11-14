---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
---

# ADR 0199：自动带入和档案里的记忆带上日期

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Andy 问过：搜出来的记忆交给模型时，模型怎么知道这条记忆是很久以前的，还是刚记下的？“存入记忆的内容必须能被模型看到”整体方案第 3 版（Andy 2026-11-09 同意）第 4 条定了做法：自动带入和档案里，每条记忆后面加日期，格式写死。这是那个方案的第 3 个 PR，前两个是 [ADR 0193](0193-memory-is-visible-to-the-model.md) 和 [ADR 0196](0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md)。

对话里模型拿到记忆有三条路：每轮自动带入的相关记忆（资料块），主人档案（按类别整理的一段文字），以及模型自己调用的 recall 工具（按需查询）。recall 的结果本来就带日期，前两条路没有。对话以外，后台的邮件判断和记忆整理也把记忆交给模型，它们不在本次范围内，见[后果](#consequences)。

<a id="premises"></a>

## 前提

1. recall 结果已经带记下的时间和生效时间段：`apps/agent-service/src/production-memory-recall.ts:233`，`recordedAt: memory.recordedAt ?? memory.updatedAt,`，紧接着是 `validFrom`、`validTo`。
2. 自动带入的记忆交给上下文组装时只带 `updatedAt`，没有记下的日期和生效时间段：本改动之前的 `apps/agent-service/src/production-run-memory.ts:376`，`updatedAt: memory.updatedAt,`。
3. 记忆的 `recorded_at` 只在第一次写入时填，之后修改记忆不改它：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:725` 的插入语句带 `recorded_at`，同文件的 `UPDATE memory_records SET …` 不带它。所以同一条记忆每次算出的日期相同。`updated_at` 会在恢复归档时变（ADR 0196 的维护命令），不适合当“记于”。
4. 生效时间段由记忆提取填写，`validFrom` 是 `YYYY-MM-DD`：`packages/prompt-catalog/src/memory.ts:26`，“validFrom：如果这件事从某个日期开始才成立（例如“下个月搬到杭州”），按 messageSentAt 换算成 YYYY-MM-DD，否则填 null。”
5. 资料块只出现在最后一条用户消息里：本改动之前的 `packages/runtime-pi/src/pi-runtime-adapter.ts:627-628`，`contextBlockContent` 把每个块拼成 `${contextBlockMarker(block)}\n${block.content}`，由 `turnPrompt` 放进本轮的 `<himawari-context>`。
6. 档案每行原来只写记忆正文：本改动之前的 `packages/application/src/services/owner-profile-service.ts:296`，`` ...lines.map(({ text }) => `- ${text}`), ``。
7. 发给模型的内容只能追加，每轮会变的内容只放最后一条消息：`.agents/instructions/prompt-prefix.md` 第 2 条，“每轮都会变的内容只放在最后一条用户消息里。”

<a id="decision"></a>

## 决定

1. **格式写死，放在记忆正文后面：**
   - 没有生效时间段：`（记于 2026-11-09）`。
   - 有开始日期、到现在仍成立：`（2026-09-01 至今）`。
   - 开始日期晚于记下的日期、没有结束日期（例如“下个月搬到杭州”）：`（2027-01-01 起）`。只看记下的日期，不看今天，所以同一条记忆的字节不随日子变；模型从本轮的当前时间自己判断它开始没有。
   - 开始和结束日期都有：`（2021-03-01 至 2024-08-31）`。只有结束日期时，开始日期用记下的日期。
   - 一律 `YYYY-MM-DD`，按配置里的时区（`runPolicy.timeZone`，没配时 UTC）换算；本来就是 `YYYY-MM-DD` 的日期原样用。不写“三天前”这类相对时间，因为它每天都变。
   - 四段文字放在提示词目录（`packages/prompt-catalog/src/memory.ts` 的 `MEMORY_DATE_RECORDED`、`MEMORY_DATE_RANGE`、`MEMORY_DATE_ONGOING`、`MEMORY_DATE_UPCOMING`），拼法在 `packages/application/src/ports/memory-dates.ts`。
2. **“记于”用 `recordedAt`（第一次记下的时间），没有时退回 `updatedAt`**，和 recall 结果一致（前提 1、3）。
3. **自动带入：**生产的记忆查询（`production-run-memory.ts`）把日期随候选记忆交给上下文组装；组装把它写进上下文信封（每轮保存的一份上下文清单）的记忆块；组装复用信封和读回信封时都校验日期的形状（`YYYY-MM-DD` 或带时区的完整时间，比存储写入时的校验略宽），只有记忆块能带，形状不对就拒绝；从记忆取日期时，形状不对的生效日期当作没有，“记于”退回 `updatedAt`；Pi 适配器拼资料块时按配置时区在正文后面加日期。
4. **档案：**档案里按类别列出的记忆每行后面加日期；“主人的要求”那一块不加，它是做事规则，不是会过时的事实。档案的字数上限连日期一起算，因为它限制的是实际发给模型的长度；记忆页“已用 N / 2000 字”因此包含日期的字数，记忆页列出的档案行也带日期。
5. **系统提示不改。**“记于”“至今”自己说得清，不需要另加说明；改系统提示只对新对话生效，还要单独换新。

<a id="industry"></a>

## 业界怎么做

Zep 把记忆交给模型时给每条事实带生效时间段，格式是 “FACT (Date range: from - to)”，仍成立的写 “present”（https://help.getzep.com/retrieving-memory ）。这里采用同样的思路：写绝对日期，仍成立的写“至今”。

<a id="options"></a>

## 放弃的做法

- **写相对时间（“三天前”）：**每天都变，同一条记忆在不同的日子字节不同，也会让模型以为是“相对于今天”的精确说法。
- **把日期放进资料块标记的元数据 JSON：**模型读正文时更自然地看到括号里的日期；元数据是给系统区分资料来源用的。
- **用 `updatedAt` 当“记于”：**恢复归档、改分级这类操作会改它，不代表这件事是什么时候记下的（前提 3）。
- **给“主人的要求”也加日期：**要求是现行规则，过时的会被主人改掉或取代，日期对模型没有用，只占字数。

<a id="consequences"></a>

## 后果

- 不改模型已经见过的请求开头：发给模型时，日期只出现在最后一条用户消息的资料块里（前提 5、7）；同一条记忆每次算出的字节相同（前提 3，时区来自配置）。已经发出的历史里没有日期，不补。`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[MEMORY-DATE]` 用例三轮对话分别带三种日期，检查每轮请求都以上一轮开头。
- 档案每行多 14 到 25 个字（“（2027-01-01 起）”14 个字，“（记于 2026-11-09）”15 个字，起止日期都有的 25 个字），2000 字的上限里能放下的记忆少一些。记忆页列出的档案行按发给模型的样子带日期，所以页面上每行的字数（各加 3 个字的行首和换行）合起来就是“已用 N 字”。
- `recordedAt` 为空的老记忆退回用 `updatedAt`，恢复归档时它会变，这条记忆的“记于”会变一次（只在最后一条消息里，不影响缓存）；和 recall 结果的做法相同。
- 邮件判断（`proactive-mail-check-service.ts`）交给模型的记忆没有日期；记忆整理（`packages/memory-engine/src/consolidation.ts`）带的是另一种日期（取 UTC 日期，不按配置时区）。两处都是已知缺口，要做时另开改动，并按缓存规则评估后台请求字节的变化。
- 门槛（每条去掉对应修改都会失败，已实测）：
  - `packages/runtime-pi/test/prompt-prefix.compat.test.ts` `[MEMORY-DATE]`：真实 Pi 适配器发出的请求里，三种格式按东京时区换算（`2024-08-31T15:00Z` 写成 `2024-09-01`）。
  - `test/integration/memory-model-visible.test.ts` `[MEMORY-DATE]`：上下文组装 → 信封 → 读回 → Pi 适配器 → 本机模型桩，请求里是“主人对青霉素过敏（记于 2026-11-09）”。
  - `test/integration/context-projection.test.ts` `[MEMORY-DATE]`：信封里的日期带到读回结果；六种形状不对的日期（包括“下个月”这类非日期文字）被拒绝。
  - `apps/agent-service/test/production-model-composition.unit.test.ts` `[MEMORY-DATE]`：生产的记忆查询把 `recordedAt`、生效时间段交出去。
  - `test/integration/production-memory-capture.test.ts` `[MEM-PIN]`、`[MEM-CAT]`：记忆页列出的档案行带日期，各行字数加 3 的和等于“已用 N 字”。
  - `packages/application/test/owner-profile-service.unit.test.ts` `[MEMORY-DATE]`：档案行按东京时区带日期，“主人的要求”不带；开始日期晚于记下日期时写“起”，同一天写“至今”，按时区比较。

<a id="references"></a>

## 关联文档

- [ADR 0193：存入记忆的内容模型都能看到](0193-memory-is-visible-to-the-model.md)
- [ADR 0196：敏感记忆遮盖后进检索目录，停掉“久不用就归档”](0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md)
- [模型请求的 KV 缓存规范](../kv-cache-guide.md)
