## 结论概览

本轮提交 `b175bc28` 只改了 8 个文件：三语 i18n、两个集成测试、一个控制中心单测断言、ADR 0193、写入约定。核对结果：**读端代码确实没改，对齐方向正确**——`production-memory-control.ts:490` 仍是 `visible: reviewMemoryVisible`，而 `daily-review.ts:136-137` 直接转给 `isModelVisible`，`model-visibility.ts:11-19` 只让 `public/private/sensitive` 通过。因此把测试数据从 `sensitive` 改成 `restricted` 是对的，三语文案和文档也基本同步。

但“对齐完整”还有缺口，见下。

---

## 发现（按严重度）

### 中｜`docs/agent-rulebook-inventory.md:146` 仍把 sensitive 当作不可见

**问题**：M-4 条目仍写“分类为敏感的规则永远不会注入”，生效位置还指向已经删掉的 `PROFILE_CLASSIFICATIONS`。这正好是“还有地方把 sensitive 当作隐藏对象”，而且它把一条标为“硬”的规则写成了与当前代码相反。

**证据（读代码证实）**：
- `docs/agent-rulebook-inventory.md:146`：
  `| M-4 | 资格：……分类为敏感的规则永远不会注入 | ... | owner-profile-service.ts 的 PROFILE_CLASSIFICATIONS | 硬 | ... |`
- `packages/application/src/services/owner-profile-service.ts:151`：
  `CLASSIFICATION_RANK[modelVisibleCeiling()],`
  `modelVisibleCeiling()` 返回 `"sensitive"`（`model-visibility.ts:16-18`），且全文件已没有 `PROFILE_CLASSIFICATIONS`。
- `packages/application/test/owner-profile-service.unit.test.ts:179`：
  `it("[RULE-memory-visible] lets a sensitive relationship memory into the profile and marks the block sensitive", ...)`

**说明**：这一行在基准 `db18e13c` 里就已经如此，不是 `b175bc28` 新引入的，是 main 的 ADR 0192 没有回头改这份清单；但本轮任务就是“合入 main 后对齐模型可见规则”，应当一并收尾。

**建议**：改 M-4 的资格描述、出处、生效位置和测试列，或加一条指向 ADR 0192 的“已部分取代”注记，别让规则清单继续和新行为相反。

---

### 低｜受限档的“推断依据节点”被显示成“内容已不在”

**问题**：受限档的 basis node 正文在 `readDecisionChain` 里被置为 `null`，抽屉统一用 `decision.chain.noText` 兜底，文案是“（内容已不在）”。这把“受限而隐藏”和“记忆/内容已删除”混成同一种显示，主记忆用的是“受限记忆，模型也看不到”，两种说法不一致。

**证据（读代码证实）**：
- `apps/control-center/src/components/decision-chain-drawer.tsx:27`：
  `{node.text ?? message("decision.chain.noText")}`
- `apps/control-center/src/i18n/resources/zh-CN.ts:970`：
  `"decision.chain.noText": "（内容已不在）",`
- `test/integration/decision-chain.test.ts:594-624` 明确造了一个 `restricted` 的 basis node，并断言其 `text` 为 `null`。

**建议**：给 basis node 增加“hidden”状态（或单独文案“受限记忆，正文不显示”），区分 deleted 与 restricted；否则 ADR 0193 第 3 条“受限的推断依据节点正文不返回”在界面上表达成了错误含义。

---

### 低｜缺少“sensitive 仍可见”的反向用例

**问题**：decision-chain 集成测试现在只覆盖 private=visible、restricted=hidden，没有任何一条断言 **sensitive 记忆在抽屉里显示正文**。ADR 0193 第 3 条和写入约定都写了“敏感档照常显示”，但没有门槛。若以后有人把 `visible` 换成隐藏 sensitive 的实现，现有的 decision-chain 用例仍会全绿。

**证据（读代码证实）**：
- `test/integration/decision-chain.test.ts:409-411`：唯一显式的 `state: "visible"` 是 `memory-a`，它是 `private`（`proposal(...)` 默认 `classification ?? "private"`）。
- `test/integration/decision-chain.test.ts:520-540`：hidden 用例只造 `restricted`。
- `packages/application/test/model-visibility.unit.test.ts:5-10` 只覆盖了 `isModelVisible` 函数本身，不覆盖决策链的接线。

**建议**：补一条 sensitive 记忆正常显示正文（最好同时覆盖 supersededBy 与 basis node）的用例；反向用例应做到：把 `visible` 改成隐藏 sensitive 时测试会失败。

顺带：`test/integration/decision-chain.test.ts:286/298/300/523` 的参数名仍是 `{ sensitive?: boolean }`、id 仍是 `memory-sensitive`，实际写入的是 `restricted`，名实不符，建议改名，降低后续误读。

---

### 低（加固建议，非本轮引入）｜`sqlite-decision-ledger-operations.ts:325` 的 `JSON.parse` 没有保护

**问题**：`readOne` 直接 `JSON.parse(row["inputs"] as string)`，inputs 损坏时会抛 `SyntaxError` 而不是 `PORT_*` 错误。属于 P1-3 读路径的既有实现（`entryFromRow:138` 同样如此），不影响本轮对齐，但错误路径值得加 try/catch 或校验后转成端口错误。

---

## 作者说法核对

- **“读取端代码没有改动”**：证实。`git show b175bc28` 只有 8 个文件，没有 `production-decision-chain.ts` / `production-memory-control.ts` 等读端代码。
- **“reviewMemoryVisible 只对 restricted 档返回 false”**：实际上只对 `restricted` 返回 false 是对的（DB CHECK 限定四档）；严格说 `isModelVisible` 对任何不在白名单里的字符串都返回 false，但正常数据不会出现未知值。
- **“三语文案 / ADR 0193 / 写入约定同步”**：证实，三语 `hidden` 分支、ADR 0193 第 30/38/57 行、写入约定第 51/66 行都已改；写入约定的“主动提醒”也改成了词表里的“系统主动提醒”。
- **“单测和浏览器测试的断言文案同步”**：证实，`proactive-interactions.unit.test.ts:1039` 和 `decision-chain-browser.test.ts:122` 都已改成新文案。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本轮改动全部是 UI 文案、文档和测试；`decision.chain.read` 是控制中心只读查询，不在系统提示、工具定义、历史消息或遮盖路径上。读端只读，集成测试还断言 `f.writes` 为空（`decision-chain.test.ts:449`），符合“只追加”规则。需要单独说明的是：main 的 ADR 0192 本身会让老对话里以前被挡掉的 sensitive 历史出现在历史中间，那一次已在 `.claude/rules/prompt-prefix.md:35` 作为 ADR 0192 的例外写明；那不是本次 `b175bc28` 引入的。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增/修改的都是静态 i18n 字符串；决策链返回顺序用 `sortedUnique` 固定，截断上限固定，判断隐藏只看该记忆自身的 `dataClassification`，不依赖后面的内容。`changedSinceDecision` 只是控制中心响应字段，不进模型请求。没有发现带时间戳的序列化或无序集合。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
有一半。正向 `restricted` 隐藏用例（`decision-chain.test.ts:520`、`:594`、`:648`）和 UI 文案断言是真实门槛，如果读端把 restricted 当可见，这些用例会失败。但“sensitive 应可见”的反向用例缺失（见上），所以如果接线被改成隐藏 sensitive，decision-chain 测试不会失败；只有 `model-visibility.unit.test.ts` 能保护函数本身，保护不到决策链接线。文档同步没有自动检查（`validate_docs`/`check:glossary` 只做结构和词表）。

**4. 改动产生或修改的每个值，两端的校验都能接受吗？**
- `restricted`：`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:61` 等 CHECK 接受四档；`DataClassification` 包含 `restricted`；`reviewMemoryVisible` 对其返回 false；使用端 `production-decision-chain.ts:215` 据此置 `state: "hidden"`。两端一致。
- i18n key `decision.chain.memoryState`：`message-ids.ts:926/1443` 存在，三语资源齐全，抽屉 `decision-chain-drawer.tsx:69` 使用。
- 文档术语“系统主动提醒”：与 `docs/glossary.md:43` 一致，写入约定第 53 行已改。
- 唯一两端不一致的是 `docs/agent-rulebook-inventory.md:146` 的 M-4（见中严重度）。

---

## 侧重检查

- **错误路径**：不存在的决策记录返回 `PORT_NOT_FOUND`（`production-decision-chain.ts:86-89`）；每个记忆的 `readBasisChain` 有单独的 `try/catch`（`:170-180`）；`readText` 失败时 `catch(() => "")`。`readOne` 的 `JSON.parse` 没保护，见上（既有实现）。
- **不可信输入**：`decisionId` 限制长度 1..128（`sqlite-decision-ledger-operations.ts:311-317`）；规则编号里的控制字符用 `displayRuleId` 转成空格（`production-decision-chain.ts:57-64`）；记忆正文是否返回只取决于 `dataClassification`，不直接信任调用方。
- **安全 / 隐私**：受限档在主记忆、`supersededBy`、basis node 三个位置都不返回正文（`production-decision-chain.ts:215-236`）， identifiers 仍返回，符合 ADR 0193。sensitive 按 ADR 0192 显示是有意为之。另见 `apps/agent-service/src/production-web-push.ts:487` 仍对 sensitive/restricted 隐藏锁屏标题，那是推送策略，与模型可见性不冲突。
- **资源耗尽**：记忆最多 100 条、依据节点合计 200、每节点正文 500 字（`production-decision-chain.ts:15-17`、`:145-166`），次级正文集合有界；排序固定。
- **不可撤销操作**：`decision.chain.read` 只读，测试断言没有写调用（`f.writes` 为空）。
- **规则/文档一致性**：ADR 0193、写入约定、三语文案已同步；`docs/agent-rulebook-inventory.md` 的 M-4 未同步，是本次对齐遗漏的一处“sensitive 被当成不可见”。
