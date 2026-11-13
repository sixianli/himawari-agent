# PR 423 第 8 轮增量复核（b3615f5e）

## 侧重检查

我按错误路径、不可信输入、资源耗尽、不可撤销操作、规则/文档一致性逐项核对，只读代码，结论如下：

- **裁判失败/超时/格式错**：`judgeOrDefault` 的失败回调把 `settled` 置 false，只有 `settled` 才写缓存；失败结果不缓存、返回安全默认 `false`（`apps/agent-service/src/production-memory-capture.ts:1160-1176`、`apps/agent-service/src/production-memory-conversation-review.ts:773-789`）。符合 ADR 0249 决定 2。
- **不可信输入**：`parseSupportVerdict` 只接受布尔 `supports`，其余抛错（`production-memory-capture.ts:199-207`）；裁判提示词固定指令在前、数据在后，并声明不执行数据中的指令（`packages/prompt-catalog/src/memory.ts:62-79`）。
- **资源耗尽**：缓存上限 500，满则整表清空（`production-memory-capture.ts:171-173`）；裁判最多 2 次尝试（`auxiliary-judgment.ts:7-21`）。加分类后条目最多约 4 倍，但受同一上限约束。
- **不可撤销操作**：本用例第一次失败发生在 `#commit` 的 `assertActive`（`production-memory-conversation-review.ts:830`），早于任何 `recordChange`（同文件 `:837`），首轮没有落盘变更；重试确认后才写入。
- **安全/缓存隔离**：缓存键加 `classification`（`production-memory-capture.ts:176-182`）；复核路径把 `plan.request.dataClassification`（`production-memory-conversation-review.ts:661` 已覆盖为 episode 分类）同时用于缓存键和 `generate`，两端一致。
- **规则/文档一致性**：ADR 0249 第 52 行“结果按（数据分类、规矩文本、引用、提示词版本）”与代码一致；`prompt-prefix` 规则第 4/15 条未被本次增量触碰。

**作者四条说法与代码均一致，未发现高/中严重度代码错误。** 下面是测试覆盖与少量推测性提示。

---

## 读代码证实的问题

### 低｜`test/integration/memory-conversation-review.test.ts:670-693`｜“缓存键带数据分类”没有回归用例

问题：代码正确，但没有任何用例验证“同一 `(规矩文本, 引用)` 在另一数据分类下会重新问裁判”。删掉 `#key` 里的 `classification` 后现有测试仍然全过。

证据：唯一涉及分类的断言只覆盖“裁判调用本身带敏感级”，两轮都是同一分类：
```ts
684:      failAssertActiveAt: 4,
685:      episodeClassification: "sensitive",
...
690:    expect(resource.classifications).toEqual(["sensitive", "sensitive"]);
```
`SupportVerdictCache` 也没有单元用例（`apps/agent-service/test/production-memory-evidence.unit.test.ts` 只测 `supportCheckKey`/`parseSupportVerdict`）。当前测试即使键用外层 `request.dataClassification`（`private`）而非 `plan.request`（`sensitive`），也发现不了。

建议：补一条同一进程内先用 `private`、再用 `sensitive` 对同一文本/引用复核的用例，断言裁判被再问一次（`classifications` 增加一条、`prompts` 增加一条）。

### 低｜`apps/agent-service/src/production-memory-conversation-review.ts:764-765`｜“停止检查挪到查缓存之前”没有用例

问题：把 `#stopping` 检查放到缓存读取之前是正确的（`:764` 在 `:765` 之前），但把它挪回去也不会有任何测试失败。

证据：
```ts
764:      if (this.#stopping) throw new Error("MEMORY_CONVERSATION_REVIEW_STOPPING");
765:      const known = this.#supportCache.get(check, request.dataClassification);
```
现有 `:696` 的用例名为“loses its authority”，注入的是第 3 次 `assertActive`（`:710`），覆盖的是执行权而不是停止；全仓库没有对 `ProductionMemoryConversationReview.stop()` 的测试（`MEMORY_CONVERSATION_REVIEW_STOPPING` 只出现在源码两处，测试里没有）。

建议：补一条在裁判命中缓存后、提交前调用 `review.stop()` 的用例，断言不再确认、记忆仍 `tentative`。这同时能防止“停止检查被挪回缓存之后”的回归。

### 低｜`scripts/evals/memory-conversation-review-live.eval.ts:247,300`｜评测的 `judgeFailures` 只有人工跑，没有自动检查

问题：把裁判失败并入通过条件和汇总本身正确，但该脚本是 `describe.skipIf(!(CAP_USD > 0 || FLAT_RATE))` 的真实模型评测，CI 不会运行；`score()` 和汇总的改动没有单元测试兜底。回退这两行不会让任何自动检查失败。

证据：
```ts
247:      outcome.judgeFailures === 0 &&
...
300:        judgeFailures: results.reduce((sum, { outcome }) => sum + outcome.judgeFailures, 0),
```
计数来源为 `:192`，字段初始化在 `:126`。

建议：至少给 `score()`（或抽取出的纯函数）加一个离线单测：`judgeFailures=1` 且其他项全对时 `pass === false`；汇总能把该值累加。可选。

---

## 推测（未核实/非本次引入）

- `SupportVerdictCache.#key` 用 `\u0000` 拼接多个外来字段（`production-memory-capture.ts:176-182`），理论上内容里含 `\u0000` 时存在拼接歧义。但同样的拼接方式在本次改动前就存在于 `memoryText` 与 `quote` 之间，且新增的 `classification` 是固定枚举，不会引入新的歧义，故**不算本次增量引入**。
- 缓存键不含 `modelRef`，同一进程换模型时可能复用旧模型结论。这与 ADR 0249 明确写出的键组成一致，属于既有设计，未在本次增量改变。

---

## 必答问题

**1. 会不会改变模型已见过的请求开头？**
不会。本次增量没有改任何提示词文件、系统提示、工具定义、历史消息或遮盖逻辑；只改了进程内裁判结论缓存的键、缓存读取顺序、评测汇总和测试。裁判调用仍是“固定指令在前、数据在后”的独立后台调用（`memory.ts:62-79`），复核请求本身未变。发给模型的内容仍只在末尾追加，变化的只有每次的裁判数据（`memoryText`/`quote`），不含每轮变动字段。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。裁判提示词由固定文本加 `JSON.stringify({ pendingMemory, ownerQuote })` 组成，键顺序固定、无时间字段、无集合遍历；缓存键是原先的 SHA-256 字符串（现多拼一个固定枚举分类），不进入模型可见内容。不存在依赖前后文的遮盖变化。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
- 第（1）条：有。`test/integration/memory-conversation-review.test.ts:670-693` 在第 4 次 `assertActive`（`#commit`，`:830`）失败，此时裁判已判并写缓存、记忆未落盘；重试断言 `prompts` 仍为 2 且 `tentative` 变 false。若关掉缓存写入，重试会再问裁判并因 `outputs` 用尽而失败，用例确实会红。第 4 次检查的顺序也已核对：`runDue:489` → `#output:692` → `#judgeSupport:770` → `#commit:830`（重试时 `#output` 命中已存输出，`:687-689`）。
- 第（2）条：**没有**专门用例（见上）。
- 第（3）条：**没有**停止路径用例（见上）。
- 第（4）条：只有人工真实模型评测，无自动检查（见上）。

**4. 每个产生/修改的值，所有使用处都能接受吗？**
- `SupportVerdictCache.get/set/#key` 新增 `classification`：产生于 `#key`（`production-memory-capture.ts:176-182`）；使用处仅两对调用，均用 `plan.request` 的分类（`production-memory-capture.ts:1153,1175`；`production-memory-conversation-review.ts:765,788`）。全仓库 grep 无其他调用，`RuntimeRequest.dataClassification` 是必填 `DataClassification`（`packages/application/src/ports/intelligence.ts:179`），两端类型一致。
- `Outcome.judgeFailures`：初始化 `:126`、累加 `:192`、参与 `pass`（`:247`）、汇总求和（`:300`），仅写入评测输出 JSON，字段是新增而非替换，无既有 schema 会拒绝。
- 测试参数 `failAssertActiveAt: 4`：由 `test/...:319-322` 的计数器消费，与上述第 4 次检查一一对应。
- ADR 0249 决定 2 的文案：与 `#key` 实际组成一致（分类、规矩文本、引用、提示词版本）。
