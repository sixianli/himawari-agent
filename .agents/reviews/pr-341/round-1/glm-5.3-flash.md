# 复核结论（PR 341：记忆页档案行带日期）

## 读代码证实的

作者的说法全部与代码相符：

1. **outline 的 text 拼上 dateNote** — `packages/application/src/services/owner-profile-service.ts:131-144`，`line` 现在返回 `text: \`${text}${dateNote}\``；rules 和 sections 都走同一个 `line`，但 rules 在 `#select` 里以 `dated: false` 调 `take`（203-206 行），`dateNote` 为 `""`（190-192 行），所以「主人的要求」实际不带日期。
2. **和发给模型的档案行相同** — `compose` 渲染 `- ${text}${dateNote}`（317 行），outline 的 text = 同样的 `text+dateNote`，只少 `- ` 前缀。
3. **[MEM-PIN] 字数检查** — `test/integration/production-memory-capture.test.ts:1622-1626、1642`，`used` 等于各行（含日期）`length + 3` 之和；与 `#select` 的计长公式 `text.length + dateNote.length + 3`（193 行）一致。
4. **[MEM-CAT] 按带日期行判断** — 同文件 1799-1812 行，改为 `startsWith("我每天必须喝咖啡（记于 ")`。
5. **ADR 0199 改写两句** — diff 确认只改了前提 4 和后果里各一句，与代码一致。

## 发现的问题（按严重度）

**低 | packages/application/test/owner-profile-service.unit.test.ts:374-391**
问题：outline 新行为（行文本带日期）在单元层没有直接断言，`[MEM-PIN]` 单测只查 `outline.usage` 和分类，不查 `outline.sections[].lines[].text`。
证据：374-391 行只断言 category 和 used 计算。
建议：可在该测试加一行 `expect(outline.sections[0].lines[0].text).toBe(\`${TEXT["memory-name"]}（记于 2026-10-25）\`)`。集成测试已覆盖，非阻塞。

**低 | apps/control-center/test/memory-interactions.unit.test.ts:874-916**
问题：UI 侧 profile 行 fixture 仍是不带日期的文本（`profile: [...]` 里是“喝咖啡不加糖”），带日期行的渲染无 UI 测试。
证据：916 行 `expect(carry).toContain("喝咖啡不加糖")`。
推测：不会出错——已核实 UI 对 `line.text` 只做显示和 aria-label（`memory-page.tsx:1296、1310`），列表 key 用 `memoryId`（1289 行），无按文本匹配或截断。非阻塞。

**信息 | apps/control-center/src/components/memory-page.tsx:1294**
点击档案行打开的记忆详情显示 `item.text`（memories 列表的原文，不带日期），与档案行带日期并存。这是显示层取舍，不是缺陷。

## 侧重检查

走查的普通流程：主人打开记忆页 → control-center 请求 `memory.overview.snapshot` → `production-memory-control.ts:555` 调 `outline`（带日期行）→ 561-566 行 `lines()` 经 `singleLine` 映射 → 快照按 `contracts-v2.ts:1188-1199` schema（`boundedString(2000)`，行最长 text+dateNote+3 ≤ 2000，即 ≤1997 字符，安全）→ `memory-page.tsx` 1286-1315 渲染与置顶开关 → 点击按 `memoryId` 打开详情 → 编辑抽屉 `initial={item.text}`（memory-page.tsx:452，取自 memories 列表，非档案行）。
结论：全链路按 memoryId 关联，无按文本匹配的消费者；无测试覆盖的是 UI 渲染带日期行那一小段（见上），服务端路径有集成测试覆盖。

## 必答问题

1. **不会。** 本次改动只触及 `outline`，它唯一的非测试调用点是记忆页快照（production-memory-control.ts:555）；发给模型的 `compose`（owner-profile-service.ts:275-339）一字未改。发给模型的内容不受影响，追加性由 PR 339 已有的 `prompt-prefix.compat.test.ts:412` `[MEMORY-DATE]` 覆盖。
2. **不会。** `dateNote` 由 `memoryDatesOf`（recordedAt/validFrom/validTo，记忆固定属性，`memory-dates.ts:25-33`）加配置时区算出，不依赖 `now`（`memory-dates.ts:49-58`）；行序确定（ownerFirst → importance → id，105-115 行）。同一段文字每次字节相同。随时间变的只是哪些记忆入选（`currentlyValid` 用 now 过滤），属结果集变化，不是同一段文字变字节。
3. **有，反向用例会失败。** 撤掉 outline 的拼接后，集成测试 1621 行 `toEqual([dated(...)])` 要求行尾有 `（记于 \d{4}-\d{2}-\d{2}）`，1641 行同理，1800 行 `startsWith` 都必然失败；且 1623/1642 行 used 求和基于带日期行文本，也会对不上。单测 `[MEM-PIN]` 的 used 期望把规则行按无日期计入（381-388 行），若未来 rules 被错误地带日期，也会失败（间接覆盖）。
4. **都能接受。** 产生处：owner-profile-service.ts:131-144（text 拼接）与 185-201（计长）。使用处逐一核对：production-memory-control.ts:561-566（仅 `singleLine` 归一化后透传）、contracts-v2.ts:1194（`boundedString(2000)`，长度上限安全）、memory-page.tsx:1296/1310（显示与标签）、1375（按 memoryId）。未发现按 text 做相等匹配、编辑回填或解析日期的消费者；未发现 schema 或后端校验会拒绝新格式。
