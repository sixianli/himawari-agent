## 侧重检查

- **错误路径**：核对了撤销的实际校验顺序（`packages/memory-engine/src/consolidation.ts:441-451`）、界面分支优先级（`apps/control-center/src/components/memory-page.tsx:1853-1861`）、记忆被删除/回收后 `tidyUps` 直接跳过（`production-memory-control.ts:667-679` 的 `if (!text) continue`）。确认“记忆被改过后撤销必定失败”这一前提成立。
- **不合规范/不可信输入**：`undoable` 由服务端内部算出，客户端只按 schema 读取布尔值；没有新增外部输入、路径、命令或反序列化入口。
- **安全**：新增字段和方法不接触正文、密钥或遮盖；`memory.undoLocked` 是固定文案；没有把敏感内容带进新字段。
- **资源耗尽**：`touched` 最多由 30 条改动（`TIDY_UPS_SHOWN`）的 `memoryId`+`relatedMemoryId` 组成，最多 60 个，低于 `readMany` 的 1000 上限（`sqlite-memory-operations.ts:586-594`）；没有新增循环或大对象。
- **不可撤销的操作**：本次只隐藏按钮，不新增删除/覆盖；真正的撤销仍走原有 `revise`，没有放宽 CAS。
- **规则、说明文档与代码一致**：没有改模型提示词、工具定义、历史或遮盖；`prompt-prefix` 规则不适用。发现 ADR 0220 的文字与界面代码有一处不一致（见下）。

## 读代码证实的问题

### 1. 中低：新增必填字段会让新旧版本混用时整个记忆页解析失败，而不只是按钮
- 文件: `packages/gateway-contracts/src/contracts-v2.ts:1243`、`packages/gateway-contracts/src/validation.ts:174-180`、`apps/control-center/src/memory.ts:92-102`
- 问题：`undoable` 被加成必填字段；本项目的对象解析同时拒绝未知字段和缺字段。旧网页配新服务端时，旧 schema 把 `undoable` 当 unknown field；新网页配旧服务端时，报 missing required field。任一方向都会让整个 `memory.overview.snapshot` 校验失败，`memory.ts` 随即 `setFailed(true)`，记忆页整体不可用。
- 证据：
  - `validation.ts:174-175`：`for (const key of Object.keys(record)) { if (!expectedKeySet.has(key)) fail(... "unknown field"); }`
  - `validation.ts:180`：`if (!Object.hasOwn(record, key)) fail(... "missing required field");`
  - `contracts-v2.ts:1243`：`undoable: booleanValue,`
- 建议：如果允许旧网页跨过一次上线，兼容期把它做成可缺省或可空并在客户端给默认值；或明确要求发布后强制刷新，并把这一点写进发布说明。只靠“同一版本发布”不能覆盖仍开着的旧标签页。
- 说明：这是机制已证实；实际是否命中取决于上线时旧网页是否仍在使用（未核实）。

### 2. 低：ADR 说“按钮完全由 undoable 决定”，界面仍保留 hold 的 waiting 特判
- 文件: `docs/adr/0220-consolidation-conflicts-wait-for-the-owner.md:59`、`apps/control-center/src/components/memory-page.tsx:1788-1792`、`apps/control-center/test/memory-interactions.unit.test.ts:1229-1251`
- 问题：ADR 现在的表述是“撤销按钮由后端算出的 `undoable` 决定”。代码实际是先看 `!undone && !undoable`，再看 `item.action === "hold" && !waiting.has(item.memoryId)` 才决定是否给按钮。现有测试正好构造了 `undoable: true` 但记忆不 tentative 的 hold 改动，并断言没有按钮，说明这两处不一致。
- 证据：
  - `memory-page.tsx:1788-1792`：`...(!item.undone && !item.undoable ? { locked: true } : item.action === "hold" && !waiting.has(item.memoryId) ? {} : { undo: ... })`
  - 测试 `memory-interactions.unit.test.ts:1236-1237` 对 hold 改动写 `undone: false, undoable: true`，`1251` 断言 `buttons(...) === []`。
- 建议：二选一更清楚——让 `isConsolidationUndoable` 对 `hold` 同时要求记忆仍为 `tentative`，使 `undoable` 成为唯一条件，再删掉界面特判；或者把“hold 还需仍在待确认”补回 ADR。前者更符合“后端算能力、前端只展示”的方向。

### 3. 低：`undoneAt` 分支没有反向用例
- 文件: `packages/memory-engine/src/consolidation.ts:36-42`、`test/integration/decision-chain.test.ts:1133-1146`
- 问题：新集成用例只覆盖“修订号相等 → true、修订号变化 → false”，没有覆盖 `change.undoneAt !== null`。删掉 `change.undoneAt === null` 这个条件，现有测试都不会失败：界面先判断 `event.undone`，而 `undo()` 在调用 helper 之前已经单独检查过 `undoneAt`。因此这条分支等于没有自动检查。
- 证据：
  - `consolidation.ts:40-42`：`return (change.undoneAt === null && memory !== undefined && memory.revision === change.afterRevision);`
  - 新用例两次断言分别在 `decision-chain.test.ts:1133` 和 `1146`，都只改变记忆修订号。
- 建议：在该集成用例里先调用 store 的 `markUndone`（或走真实 undo）再查询 overview，断言 `{ undone: true, undoable: false }`；或直接为 helper 补一条单测。

## 推测/未核实

- **低，可达性未核实**：`undoable` 不检查 generation。`consolidation.undo()` 在通过 helper 后还会执行 `const generationId = await this.#options.generationFor(memory.id); if (!generationId) throw NOT_FOUND`（`consolidation.ts:449-451`）。如果投影作业记录可能缺失或被清理，界面仍会显示一个点击后失败的“撤销”。需要确认生产上 generation 是否一定存在。
- **低，UX 未核实**：锁定文案统一说“之后又改过，去历史里恢复”。对 `hold` 被确认、或 `merge` 目标被 unarchive/recover 的情况，历史恢复并不能撤销 tentative/归档效果；而 `memoryChain` 的 `versionRestorable` 还要求当前记忆是 active、历史节点也是 active、正文或立场不同（`apps/control-center/src/memory-history.ts:95-101`），因此这段建议不一定可操作。
- **作者声称的“把生产端改成恒 true 时该用例失败”未复跑**：本环境不能运行测试，只能从断言结构判断，恒 true 会使第二条断言失败、恒 false 会使第一条失败，反向验证在结构上成立；实际运行结果未核实。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动只在 owner 侧的 `memory.overview.snapshot`、控制中心界面、整理撤销的判定和 i18n 上；diff 没有修改 `packages/prompt-catalog`、系统提示、工具定义、历史消息或出口遮盖。`undoable` 不在模型请求里，因此仍满足“只在末尾追加”；“每轮会变的值放在最后一条消息”这条不涉及本改动。依据：[prompt-prefix.md 第 4 条](../../.claude/rules/prompt-prefix.md#rules)。

2. **不会让模型请求里的同一段文字变成不同字节。** 对模型路径没有新增、依赖前後文或带时间的字段；`undoable` 只随数据库状态变化，是 UI 快照的派生值，而且其计算对给定状态是确定的。`touched` 是新 Map，只用于查找，没有把无序集合序列化进任何输出；`tidyUps` 仍按 store 返回顺序遍历。对模型请求而言不适用。

3. **有自动检查，但反向覆盖不完整。**
   - 界面：`apps/control-center/test/memory-interactions.unit.test.ts` 新增 `[P3-8-undo]`，覆盖 `undoable:false` 无按钮且有说明、`undoable:true` 有按钮、`undone:true` 显示“已撤销”；删掉 locked 分支会失败。
   - 生产端：`test/integration/decision-chain.test.ts` 经真实的 `ProductionMemoryControl.query` 断言 `undoable:true → false`；改成恒 true/恒 false 两个方向至少各有一条断言会失败。
   - 撤销端：`test/integration/memory-consolidation.test.ts` 补充了 helper 的 true/false/undefined 断言，并保留真实 undo 被拒的断言。
   - 缺口：`undoneAt !== null` 分支没有反向用例（见上）。

4. **逐个使用点核对完毕，新增值都能被两端接受。**
   - `undoable` 的生产者：`production-memory-control.ts:679`；契约：`contracts-v2.ts:1243`（必填 boolean）；消费者：`apps/control-center/src/memory.ts` 推导的 `MemoryTidyUp` 与 `memory-page.tsx:1788-1792`。
   - 所有构造非空 `tidyUps` 的地方都已补字段：`packages/gateway-contracts/test/gateway-v2.fixture.ts:586/596`、`apps/control-center/test/memory-interactions.unit.test.ts:1108/1227/1237/1282/1292/1302/1611`；其余 fixture 是空的 `tidyUps: []`（例如 `test/e2e/fixtures/control-center-browser-server.mjs:769`）。
   - `memory.undoLocked`：`apps/control-center/src/i18n/message-ids.ts:621`、三种语言资源 `en.ts:685-687`、`ja.ts:692-694`、`zh-CN.ts:644`，使用点在 `memory-page.tsx:1856`；`i18n-runtime.unit.test.ts:48-66` 会核对每个 id 在每种语言都存在且集合一致。
   - `locked` 是界面内部字段，只在该组件产生和消费。
   - `isConsolidationUndoable` 从 `packages/memory-engine/src/index.ts:8` 导出，使用点为 `consolidation.ts:444`、`production-memory-control.ts:679` 和测试；`afterRevision` 本来就是非空 `number`（`packages/application/src/ports/memory-consolidation.ts:30`），没有新增空值语义。
   - 没有新增配置键、清单项、数据库列或持久化序列化格式。

## 作者说法核对

- “补了经 ProductionMemoryControl.query 的集成用例并做了反向验证”：**代码可证实**用例确实调用 `f.control.query` 并先断言 true、后断言 false（`decision-chain.test.ts:1121-1147`）；“恒 true 时失败”的实跑结果**未核实**，但从断言结构看成立。
- “更新了 ADR 0220”：**属实**，但 ADR 第 5 条仍把按钮条件写得比代码更简单（见问题 2）。
- “不改表、不改发给模型的内容”：**属实**，diff 中没有迁移、没有提示词/请求组装改动。
- “新旧版本错配时快照整页解析失败、点击时并发按既有做法不改”：**风险属实**；严格解析确实会让整个快照失败。是否存在“既有做法”我没有找到明确规则，只看到仓库对内部协议有“同版本发布”的惯例；旧浏览器标签页是否被强制刷新**未核实**。
