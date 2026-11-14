# 复核结论

增量 `1de2aa550` 的三处代码修改（查分类缓存、全敏感已记忆判 `skipped`、日上限写诊断）与作者说法基本一致；但有两个反向测试实际覆盖不到、一处 ADR 与代码不符；另有一个整条功能层面的出口策略问题需要确认。以下先列发现，再单独列“侧重检查”，最后逐条回答必答问题。说明：本次只能读代码，不能运行测试，凡涉及“测试是否通过/哈希是否一致”的都标为未核实。

## 发现（按严重度）

### 1. 中（需产品确认）：判重请求绕过模型出口的数据分级检查，把私有已记忆直接发到外部网关
- 文件:行：`apps/agent-service/src/production-memory-import-duplicates.ts:201-219`、`packages/platform-node/src/memory-import-duplicate-decision.ts:81-90`
- 问题：新功能自己 new 了 `MemoryImportDuplicateDecision`，用裸 `fetch` 请求 `${base}/decisions`；没有走 `ProductionMemoryClassifier` 那条模型组合（那里有 `descriptor.allowedDataClassifications.includes(dataClassification)` 的检查，见 `apps/agent-service/src/production-model-composition.ts:530-532`），也没有按美元计费。也就是说，只要配了 `runPolicy.importDuplicates`，主人的私有已记忆就会发给该网关，限制只有“配置存在、确定性遮盖、请求数上限”，没有“这个模型/服务商是否被允许看 private 数据”的校验。
- 证据：
  - `production-memory-import-duplicates.ts:201-219`：`decision: new MemoryImportDuplicateDecision({ model: route.model, apiKey: ... })`
  - `memory-import-duplicate-decision.ts:81`：`const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {`
  - 对照 `production-memory-classification.ts:200-205`：分类调用走 `model.generate({ ..., dataClassification: "private" })`，由模型组合统一校验。
- 建议：给这条路由补一个显式的数据分级/服务商要求（例如必须登记为允许 private 的模型），或在 ADR 里写明为什么这条路径可以绕过、以及由谁保证只有被批准的网关能收到私有记忆。

### 2. 中（已证实）：新增的“已有记忆全是敏感/受限 → 判 skipped”没有对应测试，删掉这一行不会有测试失败
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1383-1391`
- 问题：这是本轮作者声称修的第 2 条（“已有记忆全是敏感/受限时判 skipped”），但唯一相近的单测是把一个“确定性敏感”的已记忆直接传给 checker（`apps/agent-service/test/production-memory-import-duplicates.unit.test.ts:124-126`），走的是 `production-memory-import-duplicates.ts:127-131` 的 `known.length === 0` 分支；集成测试 `[A4]` 也预置了一条 private 已记忆。没有任何测试构造“active 非空、但全部是 sensitive/restricted”的 control 路径。删掉第 1391 行，现有测试仍会通过。
- 证据：
  - `production-memory-control.ts:1391`：`if (existing.length === 0 && active.length > 0) complete = false;`
  - `production-memory-import-duplicates.ts:127-131`：`if (known.length === 0) { if (existing.length === 0 && scan.complete) ... }`（这条是 checker 层，不等于 control 层的新分支）
- 建议：在 `production-memory-capture.test.ts` 或 control 单测里加一条反向用例：只放敏感/受限记忆，导入一条普通文字，断言服务端不发判重请求且返回 `skipped`。

### 3. 中低（已证实测试无效）：“声明长度超过 1 MiB”的反向用例实际可能没测到声明长度分支
- 文件:行：`packages/platform-node/test/memory-import-duplicate-decision.unit.test.ts:131-136`
- 问题：用例声明 `content-length: 2 MiB` 却只写 `"{}"`，断言接受 `IMPORT_DUPLICATE_RESPONSE_TOO_LARGE|fetch failed|terminated`。即使把 `declared > MAX_RESPONSE_BYTES` 这一行删掉，截断的响应也会让 fetch 抛 `terminated`/`fetch failed`，用例仍然通过，所以它证明不了声明长度检查存在。
- 证据：
  - 测试：`.rejects.toThrow(/IMPORT_DUPLICATE_RESPONSE_TOO_LARGE|fetch failed|terminated/);`
  - 代码：`memory-import-duplicate-decision.ts:93-95` 的声明长度检查。
- 建议：改用 mock fetch 返回一个 `content-length` 超大但 body 正常的 `Response`，断言必须精确抛 `IMPORT_DUPLICATE_RESPONSE_TOO_LARGE`；流式那条精确断言可以保留。

### 4. 低（已证实文档与代码不一致）：ADR 说“已有记忆读不全……所有条目也判 skipped”，代码只把 `different` 降级
- 文件:行：`docs/adr/0265-memory-import-duplicates-judged-by-the-model.md:54`
- 问题：ADR 第 5 条新增“已有记忆读不全……时，所有条目也判 skipped”。但代码在 `scan.complete === false` 时仍会把 `same`/`unsure` 返回给网页，只有 `different` 需要 `scan.complete`。
- 证据：
  - `production-memory-import-duplicates.ts:171-178`：`if (verdict === "same" || verdict === "unsure") ... else if (verdict === "different" && !incomplete.has(index) && scan.complete) ...`
  - ADR 第 54 行原文：“已有记忆读不全，或全部被挡掉……时，所有条目也判 `skipped`。”
- 建议：把 ADR 改成“读不全时，无法证明不同的条目判 skipped；已找到的 same/unsure 仍保留”，或按 ADR 改代码（后者会让已确认的重复也不再标出，不建议）。

### 5. 低（已证实测试名过宽）：名为“coding note that gets different still stays off”的用例没有 coding 条目
- 文件:行：`apps/control-center/test/memory-interactions.unit.test.ts:1817-1838`
- 问题：用例只设置 `classifyFails = true`，粘贴“我对青霉素过敏/我住在上海”，没有任何 coding 条目，也不会让 coding 条目得到 `different`。解析层用例给 coding 条目的是 `skipped`（`:1959-1964`），不是 `different`。因此“coding + different 仍不勾选”这条行为没有被测试。
- 证据：`classifyFails = true;` 之后只有两条普通事实；`applyImportDuplicates(parsed.items, ["different", "different", "same", "unsure", "skipped"])` 中 coding 项拿的是 `"skipped"`。
- 建议：要么在该 UI 用例里加入一条 General Tips/Codex 条目并给它 `different`，要么改掉测试名，避免 `check:untested-claims` 或后续复核误以为已覆盖。

### 6. 低（已证实，资源浪费）：候选全被挡掉时仍扫描并解密最多 1000 条已有记忆
- 文件:行：`apps/agent-service/src/production-memory-control.ts:1361-1396`
- 问题：如果传入的 refs 全部是敏感/受限（`sendable.length === 0`），代码仍继续 `listActive`、逐条 `readText`（解密）最多 `existingLimit` 条已有记忆，然后才用空候选调用 checker。正常网页不会这样调用（`askable` 为空就不发请求），但直接调用接口可以反复触发无用的解密扫描。
- 证据：`sendable` 在候选循环里填充，随后 `const active = [...(await this.state.listActive(...))]` 与 `readText(record.contentRef)` 无条件执行（`:1377-1396`）。
- 建议：候选循环结束后若 `sendable.length === 0` 直接返回全 `skipped`，不必扫描已记忆。

### 7. 低（已证实，早先提交，可能不在本轮增量）：词表门槛对“英文并列正则”有盲区，且与文档说法不一致
- 文件:行：`scripts/check-meaning-word-lists.mjs:58-62`、`docs/meaning-word-lists.md:22`、`apps/control-center/src/memory-import.ts:33-34`
- 问题：文档说脚本会找“含三个以上并列词的正则”，但脚本在 `alternatives.length >= 3` 后还要求整段含中日文字符或命中固定的 `ENGLISH_WORDS` 列表（`ignore|remind|always|...`）。像 `SKIPPED_SECTION = /what's in memory|older memory topics|^task \d+|rollout_summary_files|keywords/i` 这种 5 个并列英文词的正则不会被报出，也没有登记。属于 I-100 那类门槛的盲区。
- 证据：脚本第 62 行 `if (!NATURAL.test(body) && !ENGLISH_WORDS.test(body)) continue;`；`memory-import.ts:33-34` 的 5 段正则；登记表里没有 `memory-import.ts`/`SKIPPED_SECTION`。
- 建议：要么把这条正则登记为“格式解析”，要么让脚本与文档一致（去掉额外的英文白名单或把规则写进文档）。

## 侧重检查

- **错误路径**：HTTP 非 2xx、非 JSON、`model` 不匹配、答案数量不对、答案键非法、模型拒答、超时、响应超限，最终都落到 `skipped`，不会当成“不重复”；已核对 `memory-import-duplicate-decision.ts:91-122`、`packages/application/src/services/memory-import-duplicates.ts:77-102`。部分已记忆读不出来时，按发现 4 只降级 `different`。
- **不合规范/不可信输入**：`contentRefs` 由契约限制 1–500 条（`contracts-v2.ts:1594-1607`）；服务端通过 `readText` 要求 `text/plain` 并按 owner/agent 解密。任意不存在或不属于自己的 ref 会让整条查询抛错（前端整批降为 `skipped`，属于安全但会丢掉同批其它结果）。服务端判敏感的模型结果依赖先前 `memory.classify.read` 的进程内缓存；直接调用判重接口、跳过分类的客户端仍可让“未被确定性规则命中”的私有文字发给外部模型——这条路径在正常网页流程里分类模型本来也会看到该文字，因此增量风险有限，但不是硬保证。
- **安全/出口**：已有记忆和候选文字都先过 `redactForExternalText`，请求带 `zeroDataRetention: true`；但见发现 1 的模型分级检查缺口。`memoryId` 只会返回给通过网关认证的 owner。
- **资源耗尽**：单查询最多 150 个模型请求、每天 1500 个、每个 15 秒、并发 4（`production-memory-import-duplicates.ts:27,164-168`）。最坏情况一次查询约 150/4×15 秒 ≈ 9 分钟（估算，未实测）；没有美元级上限，只有请求数上限。候选全被挡掉时仍扫描已记忆（发现 6）。
- **不可撤销操作**：本次新增的是只读查询，不新增不可撤销操作。`memory.import.commit` 仍不做服务端判重（`production-memory-control.ts:1548-1577`），所以判重只是网页预览的建议值，客户端跳过预览仍能写入重复记忆；有批次 undo，但不是判重保证。
- **规则/文档一致性**：`MEMORY_IMPORT_DUPLICATE_QUESTION` 只被 `memory-import-duplicate-decision.ts` 使用（`grep` 仅此一处），已进 manifest；ADR 的价格说法已删干净，日上限与默认值一致；不一致处见发现 4、7。

## 读代码证实的与推测分开

- **读代码证实**：发现 1–7 的代码事实、各值上下游的注册（消息类型、契约 schema、`PRODUCTION_MEMORY_OPERATIONS`、前端 operation 检查、测试 fixture、配置默认值/范围/密钥用途检查）都能对上；发现 2、3 的测试覆盖缺口是直接比对测试与代码分支得出的。
- **推测/需确认**：发现 1 是否违反项目数据分级政策取决于产品对“Jev + Vercel AI Gateway”的批准范围；最坏 9 分钟延迟是估算；“updatedAt 相同导致 `m` 编号跨请求不一致”只是理论可能；新提示词加入 `TRUSTED_PROMPT_TEXTS` 后，若某条冻结消息恰好包含其 ≥24 字原文，理论上遮盖字节会变，实际概率极低；`importDuplicateRequestBody` 里 `input` 字段在 `questions` 之前，若网关按 JSON 顺序拼提示词，会与“固定指令在前”的后台调用原则不一致，这一点未核实网关行为。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本改动没有任何修改系统提示、工具定义、历史消息或主对话遮盖的代码；新增的 `MEMORY_IMPORT_DUPLICATE_QUESTION` 只在 `memory-import-duplicate-decision.ts` 的后台判重请求里使用，不属于主对话请求。主对话仍是“只在末尾追加”，每轮会变的值仍只放在最后一条用户消息里。唯一的理论旁路是提示词目录新增文字会进入 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts:11-15`），只影响恰好包含这些原文片段的文字，实际可忽略；后台请求本身的 `input`/`questions` 拼接顺序未核实。
2. **会不会让同一段文字在不同请求里变成不同字节？** 后台判重请求内部是确定的：JSON 键顺序固定，`existing` 按 `updatedAt` 降序，`m0..mN` 按固定顺序生成，没有时间或随机字段。两点保留：同一段文字在遮盖时的占位符编号取决于它前面已出现的敏感值（规则第 11 条允许只看前面，但同一段文字在不同请求里可能得到不同占位符）；`updatedAt` 完全相同时的先后依赖 `listActive` 返回顺序。主对话请求不受这些影响。
3. **有没有对应的自动检查，反向用例是否真会失败？** 有，且大部分有效：网页只问非敏感条目（`memory-interactions.unit.test.ts` 中 4 条里 2 条敏感、`duplicateAsked` 长度断言）、分类失败不发（`classifyFails` + `duplicateAsked === []`）、流式响应超 1 MiB（精确断言 `IMPORT_DUPLICATE_RESPONSE_TOO_LARGE`）、日上限回调、判为敏感的引用不发（`production-memory-capture.test.ts` 中 `payload-d5` 用例，删掉缓存检查会导致 `duplicateRequests` 增长而失败）都能真正失败。缺口是：声明长度那条反向用例可被 `terminated` 蒙混（发现 3）；“全敏感已记忆 → skipped”没有测试（发现 2）；“coding + different 不勾选”没有测试（发现 5）。
4. **每个值的使用端都能接受吗？** 消息类型 `memory.import.duplicates.read/.snapshot` 同时出现在 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`（`contracts-v2.ts:68-69,1594-1617,3141-3142`）、`PRODUCTION_MEMORY_OPERATIONS`（`production-memory-control.ts:84`）、前端 operation 检查（`memory.ts:253-262`）和契约 fixture，能对上；`verdict` 四个值在服务端、契约枚举、前端 `ImportDuplicateVerdict`、`applyImportDuplicates` 一致；`memoryId` 是契约允许的 nullable string，前端不消费；配置的默认值和范围键通过 `Record<keyof ImportDuplicateTuning, ...>` 对齐，`strict-configuration.ts` 拒绝未知键并要求 `secretRef` 用途为 `model-auth`；`existingLimit` 与 `check` 由 control 直接使用。需要留意的使用端是手工维护的 operation 清单（如 `test/e2e/fixtures/control-center-browser-server.mjs:2227-2256` 没加新操作）——当前没有 e2e 导入用例，所以不会坏，但以后加导入 e2e 会静默变成“全部 unchecked”。另外 `IMPORT_DUPLICATE_RANGES.maximumExistingMemories` 允许 0（`configuration.ts:332`），配成 0 会让所有导入都因 `existing.length === 0 && active.length > 0` 判 `skipped`，语义上像“检查失败”而不是“未比较”，建议最小值改 1 或写明。提示词 manifest 哈希我未运行检查，未核实。
