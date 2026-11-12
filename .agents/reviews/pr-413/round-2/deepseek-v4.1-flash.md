## 结论摘要

共发现 4 个需要处理的问题（1 个安全/确定性、1 个提醒漏读、1 个读取上限未覆盖、1 个文档/清单不一致），以及几处低风险缺口。没有发现向 Himawari 自己模型请求的组装代码被改动；`start_here` 的三段顺序是固定的在前，`now` 等变化值在最后的 `today` 段。

---

## 读代码证实的问题（按严重度）

### [中] 提醒先取 20 条再按 `readCeiling` 过滤，被过滤掉的不会回填

- 文件:行：`apps/agent-service/src/production-reminder-writer.ts:267-286`
- 问题：`listUpcoming` 只取 `LISTED + 1`（21 条），循环只看前 20 条。某条提醒因为超过 `readCeiling` 被 `#textOf` 丢掉后，不会继续读第 21 条及以后。于是 `start_here` 可能返回 0 条或少数提醒，而后面明明还有符合 private 级别的提醒；`more` 又只按未过滤的 21 条计算，外部 agent 无法判断是“没有提醒”还是“都被过滤了”。
- 证据：

```ts
limit: LISTED + 1,                                        // 271
for (const reminder of upcoming.slice(0, LISTED)) {       // 274
  const text = await this.#textOf(reminder, ceiling);     // 275
  if (text === undefined) continue;                       // 276
...
return { reminders: listed, more: upcoming.length > LISTED }; // 286
```

- 影响：这是第 2 轮新增 `readCeiling` 后才明显放大的问题。以前只排除 restricted，现在默认 private 会把 sensitive 全部排除；前 20 条里 sensitive 越多，越可能漏掉后面的 private 提醒。
- 建议：在查询层按分级过滤，或循环读取直到凑够 `LISTED` 条合格提醒；`more` 应按过滤后的剩余条数计算。补一个“前 20 条都被过滤、第 21 条合格”的反向用例。

### [中] `profile.version` 是对遮盖前文字做的 SHA-256，泄露秘密指纹

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:1049-1052`，输出遮盖在 `:866`
- 问题：`version` 在 `maskForExternalRead` 之前，用未遮盖的 `requirements`/`sections` 计算。如果 profile 里含密码、验证码、PIN，正文会被遮成 `[密码]`，但 `version` 仍是含秘密原文的哈希。外部 agent 拿到的是一个可离线暴力验证的短哈希；两段遮盖后完全相同的文字，只要原文秘密不同，`version` 也会不同。这既违反“只取文字、不带内部编号”的目标，也与“同一段文字字节相同”的说法冲突。
- 证据：

```ts
const versionBase = JSON.stringify([requirements, sections]);              // 1049
const profile = {
  version: createHash("sha256").update(versionBase).digest("hex").slice(0, 12), // 1051
...
text: JSON.stringify(maskForExternalRead(outcome.output)),                 // 866
```

- 建议：去掉 `version`，或改为对遮盖后的稳定段计算；如果要防伪造/防关联，用服务端密钥做 HMAC，而不是裸 SHA-256。

### [中] `readCeiling` 只作用于 `start_here`，`find_memories` 仍能读到 sensitive

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:951`，`apps/agent-service/src/production-memory-recall.ts:144-149,185`
- 问题：`start_here` 默认把 profile、提醒、摘要都压到 private；但 `find_memories` 仍走 `recallOutsideRun`，后者固定 `allowed = modelVisibleClassifications()`，其中包含 `sensitive`。因此外部 agent 完全可以绕过 `start_here` 的 private 默认值，直接用 `find_memories` 取 sensitive 记忆。若“读取级别上限”是入口级安全边界，这里是漏洞；若刻意只限制 `start_here`，需要文档写明，否则容易被误认为整个外部读取入口已受上限保护。
- 证据：

```ts
recallOutsideRun(...) {
  return this.#recall(args, "public", within);   // 148
}
...
const allowed = modelVisibleClassifications();   // 185
```

- 建议：把 `readCeiling` 传入 `recallOutsideRun`，或在 `find_memories` 入口按同一上限过滤；至少在 ADR/说明里写清“只限 start_here”。

### [中] 整批遮盖使稳定段 `profile` 的字节可能依赖会变化的 `today`

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:272-281`，`packages/sensitive-capture/src/redaction.ts:552-569`；对应用例 `apps/agent-service/test/production-mcp-read.unit.test.ts:11-15`
- 问题：`maskForExternalRead` 把整个响应里的所有字符串一起交给 `maskSensitiveTexts`；后者先扫一遍全部文字、记录“被点名的秘密”，再遮第二遍。因此 `today` 里如果出现“验证码是 X”，`profile` 里单独出现的 X 也会被遮。反过来，`today` 没有这条时，`profile` 里的 X 会原样输出。也就是说，同一段 `profile` 文字在不同 `start_here` 响应里可能变成不同字节，取决于当天的提醒/摘要。
- 证据：

```ts
const masked = maskSensitiveTexts(texts);                    // 278
...
for (const input of inputs) redactForEgress(input, options); // 565
return inputs.map((input) =>
  redactForEgress(input, options).text.replace(...)          // 566-567
);
```

- 说明：ADR 0219 决定 4 确实要求“全部文字一起遮”，所以这不是实现偏离，而是与新目标“固定段稳定”之间的冲突。第 1 轮的测试 `[P5-A]` 还明确验证了这种跨字段遮盖。
- 建议：明确取舍。若稳定段必须稳定，可对稳定段单独遮盖；若保持整批遮盖，就要在文档和测试里承认“profile 的字节可随 today 变化”，不要宣称固定段完全稳定。

### [低] `start_here` 在 profile 来源失败时整次失败，且没有测试

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:1042`
- 问题：`#startHere` 先 `await sources.profile?.(ceiling)`，profile 抛错会直接冒到 `#call`，整次 `start_here` 只回通用失败文字，rules 和 today 也不会返回。对于“开场一次取全貌”的工具，这会让一次 profile 读取故障导致整个入口不可用。
- 证据：

```ts
const outline = await this.#options.sources.profile?.(ceiling); // 1042
```

- 现状：`[P5-A]` 没有 `failProfile` 之类的失败用例；现有测试只覆盖了 reminders/summaries/ledger 失败。
- 建议：明确是否要“profile 失败就整次失败”。若希望降级，捕获 profile 错误后返回空的 profile/带省略说明的 profile，并继续给 rules/today；无论哪种，补失败路径测试。

### [低] 决策记录里的 `memoryIds` 顺序取自未排序的提醒列表

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:1018-1035`
- 问题：返回给外部的 `reminders` 已经排序，但 `memoryIds: listed.reminders.map(...)` 仍用 `listed.reminders` 的原始顺序（来自数据库）。返回内容本身有序，决策记录里的 `memoryIds` 顺序却可能随数据库返回顺序变化。
- 证据：

```ts
reminders: [...listed.reminders].sort(...).map(...), // 1018-1031
...
memoryIds: listed.reminders.map(({ memoryId }) => memoryId), // 1035
```

- 建议：排序一次后同时用于输出和 `memoryIds`，保证记录也可复现。

### [低] `recentDays` 从“日期倒序”改为“日期、id 升序”，改变了旧 `today_context` 的顺序

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:987-990`；数据库顺序在 `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1556`
- 问题：原来 `listDaySummaries` 返回 `ORDER BY e.day DESC, e.ended_at DESC, e.id ASC`，旧 `today_context` 直接使用该顺序。现在统一按 `day` 升序、再按 `id` 排序。多天时从“今天在前”变成“昨天在前”；同一天多段摘要时，`ended_at` 的时间顺序也被 `id` 取代。
- 证据：

```ts
const ordered = [...found.summaries].sort(
  (a, b) => compareText(a.day, b.day) || compareText(a.id, b.id),
); // 987-989
```

- 说明：固定排序本身是好事，但排序键的选择未必符合“近两天摘要”的自然顺序。
- 建议：确认期望顺序（通常按日期倒序、同一天按 `ended_at` 或序号），并补多天、多段的顺序测试。

---

## 文档与清单不一致（读代码证实）

### [中] 清单引用的 `ADR 0242` 不存在；ADR 0219 仍写“三个只读工具”

- 文件:行：`packages/prompt-catalog/prompt-manifest.json:349,484-509`；`docs/adr/0219-read-only-mcp-entry-with-static-token.md:64`
- 问题：所有新改的 MCP 提示词条都把 `changedIn` 写成 `"ADR 0242"`，但仓库里没有 `docs/adr/0242*`，`grep 0242` 也找不到对应决定文档。与此同时，ADR 0219 的决定 3 仍写“三个只读工具”。这让提示词清单的审计链断开，也让“第四个只读工具 `start_here`”没有对应的架构决定记录。
- 证据：

```json
"mcp.find-memories": {
  "sha256": "...",
  "changedIn": "ADR 0242",
  "reason": "外部 agent 读记忆：新增 start_here 和服务使用说明，三个读工具的描述写明触发条件"
}
```

```md
3. **三个只读工具，列出时顺序固定，都标为只读（`readOnlyHint`）。**
```

- 建议：补上 ADR 0242（或在 ADR 0219 增补决定并更新引用），同时把清单里的“三个读工具”改为准确的“四个读工具 / 三个原有工具加 start_here”。
- 自动检查缺口：`prompt-catalog.unit.test.ts` 只要求 `changedIn` 非空，不检查对应 ADR 文件是否存在，因此这条不会被 CI 抓住。

### [低] `start_here` 两个 `omitted` 的用途/文案与清单 reason 不完全对应

- 文件:行：`packages/prompt-catalog/prompt-manifest.json:487-505`
- 问题：`mcp.start-here-omitted` 和 `mcp.start-here-rules-omitted` 的 `reason` 混用了同一条“规则摘要截断提示指向 rule_book”，但前者实际是 profile 截断、指向 `find_memories`。不影响校验，但会让人误读变更范围。
- 建议：把两个条目的 reason 分开写。

---

## 推测 / 未核实

- **`auto` 的处理器级校验被删掉**：第 2 轮删掉了 `if (auto !== undefined && typeof auto !== "boolean") throw ...`，改为完全依赖 MCP 输入 schema。现代协议测试 `test/integration/mcp-read.test.ts:991-995` 覆盖了 `auto: "yes"`，但 handler 现在会把任何非 `true` 的 `auto` 当普通查询处理（`production-mcp-read.ts:931`）。如果某个协议版本或 SDK 路径没有严格校验 schema，畸形参数会静默成功而不是报错。未核实旧协议路径的 schema 校验是否同样严格；建议保留一行廉价校验或在 legacy 连接上也测一次。
- **`auto` 的“最多 3 条”是否包含 `conversations`**：代码只把 `limit` 降到 3，`episodes.search` 也用 `Math.min(5, input.limit)`（`production-memory-recall.ts:329`），所以可能返回 3 条 memories 加最多 3 条 conversations。若“3 条”指总数，则超出；测试只查了 `memories.length`。未核实产品意图。
- **提示词清单的 sha256 是否正确**：本环境不能运行测试或 `sha256sum`，没有逐条复算。`prompt-catalog.unit.test.ts` 会计算 `JSON.stringify(entry.segments)` 的摘要，但我没有执行。此项标“未核实”。
- **`McpServer` 构造参数 `instructions` 是否被当前 SDK 版本接受**：仓库没有 `node_modules`，未核实 SDK 类型；若类型不匹配会在编译期暴露。
- **测试没有实际运行**：以下“反向用例会失败”的判断来自读代码，不是执行结果。

---

## 侧重检查

- **错误路径**：profile 失败 → 整次 `start_here` 失败（无测试）；reminders 失败 → 原有 `today_context` 失败路径不变；summaries 失败 → 降级为 `recentDaysComplete:false` 并记录 `failed`；ledger 写失败 → 不交出内容（原有行为）。结论：新增的主要缺口是 profile 失败无降级/无测试。
- **不合规范或不可信输入**：`auto`/`query`/`from`/`to`/`limit` 由 MCP schema 约束；`auto` 在转发给 `ProductionMemoryRecall` 前被剥离，避免检索层拒绝未知参数；客户端名有正则白名单；输出整批遮盖。结论：主要残余风险是 `auto` 处理器级校验被删、旧协议校验未核实。
- **安全**：`start_here` 的 profile/reminders/summaries 都经过 private 上限；但 `find_memories` 未受 `readCeiling` 约束；`profile.version` 对未遮盖原文做哈希；整批遮盖会让稳定段依赖可变段。结论：有 3 个安全/信息泄露面需要处理或明确记录。
- **资源耗尽**：`start_here` 无参数、只读；profile 有 2000 字预算但会先读取全部 active 记忆；提醒最多 20 条输出；摘要最多 8 条；入口限流沿用 30 次/分钟。结论：没有新增写操作或不可逆操作；主要资源点是每次调用都做一次完整 profile 扫描和逐条正文解密。
- **不可撤销操作**：`start_here` 只读，不新增写路径；决策记录 append 是原有行为。结论：无新增不可撤销操作。
- **规则文件、说明、代码一致**：`prompt-manifest.json` 有新增条目，文字与提示词目录大体对应；但 `changedIn: ADR 0242` 指向不存在的文档，ADR 0219 仍写三个工具。结论：文档一致性需要补。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**对 Himawari 自己发给模型的请求：没有发现改动。** 本次 diff 只改 MCP 入口、MCP 提示词文字、决策记录约定和测试；没有改 Himawari 的请求组装、系统提示、工具定义、历史写入路径。`start_here`/`SERVER_INSTRUCTIONS` 只用于外部 MCP 客户端。

**对新的 `start_here` 响应：** 结构是固定的 `profile`、`rules` 在前，`today` 在最后；`today` 里包含 `now`、当天日期、提醒和摘要，这些变化值都在最后一段。工具描述和服务说明是固定文字，没有每轮变化的值。

但有三个限定：
- 外部客户端升级后会看到新增的 `start_here` 工具，工具列表会变一次；这不是每轮变化，但会改变该客户端下一次请求的头部。
- 整批遮盖使 `profile` 的字节可能随 `today` 内容变化（见上文“整批遮盖”）。
- `today` 里的 `now` 每次调用都不同，所以“同一份数据两次 `start_here` 字节相同”只在测试的固定时钟下成立（`test/integration/mcp-read.test.ts:886-887`，`ManualClock` 在 `:196`），生产中两次调用不会字节相同。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**会，主要有三处：**
- **遮盖**：`maskForExternalRead` 是整批遮盖，`today` 里点名某个秘密时，`profile` 里的同一值也被遮；`today` 不点名时则不遮。同一段 profile 文字因此可能在不同请求里字节不同。这是 ADR 0219 决定 4 的既定行为，但与“固定段稳定”目标冲突。
- **`profile.version`**：对遮盖前原文做哈希，不同秘密即使遮成相同文字，版本也不同；同时 leaks 一个秘密指纹。
- **时间字段**：`today.now` 和当天日期每次不同，这是预期行为，且位于最后一段。

**没有发现的新增无序集合问题：** 提醒和摘要都加了固定排序，profile sections 按固定类别顺序，owner rules 按 `ruleId` 排序。唯一未排序的是决策记录里的 `memoryIds`（不返回给外部 agent），见上文低风险项。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有新增检查，但覆盖不完整：**
- `[P5-A]` 单元测试覆盖整批遮盖：一个字段点名、另一个字段出现同一值时也遮；反向普通文字保持不变。若退回按字段遮盖，前者会失败。
- 集成测试覆盖：`start_here` 三段顺序、profile 预算及 `omitted` 条数、private 默认值、sensitive profile 的隐藏/放开、sensitive 提醒和摘要的隐藏/放开、`auto` 最多 3 条、`auto` 空结果去掉 `note`、非布尔 `auto` 报错。
- 反向用例确实针对行为：去掉分级过滤，sensitive 用例会失败；不去掉空结果 `note`，`toHaveProperty("note")` 会失败；不限制 schema，非布尔 `auto` 用例会失败。
- **缺口**：没有 profile 来源失败用例；没有“前 20 条提醒被过滤后仍能回填后面的合格提醒”用例；提醒/摘要的排序测试没有构造乱序输入，去掉排序代码也可能继续通过；`second.text === first.text` 使用固定时钟，不能证明生产中的字节稳定；清单只校验 `changedIn` 非空，不校验 ADR 0242 是否存在。
- 我没有执行测试，以上是读测试代码得出的判断。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？

逐项核对结果：

- **`start_here` 工具名**：已加入 `MCP_READ_TOOL_NAMES` 和注册表；`mcp-read`/`mcp-write` 测试用该常量动态断言；决策记录 `reasonCode` 长度上限 64，`start_here`/`start_here_failed` 都满足。**接受。**
- **`memoryIds`**：`start_here` 用 `Set` 去重后 `slice(0, 200)`；SQLite 侧 `MAX_IDS = 200`，且 `idList` 要求去重、每项 1–256 字符。**两端一致。** 但顺序没有排序，见低风险项。
- **摘要六项**：`#record` 在 `start_here`/`today_context` 有摘要来源时一起写六项，`summaryGenerated: 0`；`summaryInputsValid` 要求六项齐全、ids 去重、days 格式正确、`summaryInjected === ids.length > 0`。**接受。**
- **`auto`**：schema 限 boolean；handler 在转发前剥离 `auto`；`ProductionMemoryRecall.argumentsOf` 会拒绝未知键和非法 `limit`，`limit` 1–10；`auto:true` 时最多把 limit 降到 3。**接受。** 处理器级校验被删、旧协议未核实，见“推测”。
- **`readCeiling``**：profile 通过 `OwnerProfileService` 按分级过滤并再与 `modelVisibleCeiling()` 取小；reminders 显式排除 restricted 并比较 rank；summaries 在查询前过滤 `modelVisibleClassifications()`。**这三处接受。** `find_memories` 不消费该值，见“中”风险项。
- **提醒/摘要源签名**：`reminders(windowMs, ceiling?)`、`summaries({days,limit,maxClassification?})` 已同步更新 `service-main.ts` 和测试；只传一个参数的旧实现仍然可赋值。**接受。**
- **提示词 id/清单项**：新 id 在 `tools.ts` 和 `prompt-manifest.json` 中都能对上；但 `changedIn: ADR 0242` 没有对应文档，ADR 0219 仍写三个工具；sha256 未复算。**清单项存在，但审计链不完整。**
- **输出新字段 `profile.version/rules.note/omitted`**：没有输出 schema 校验，JSON 序列化和遮盖能处理字符串；`version` 的哈希来源有问题，见“中”风险项。

---

## 建议的优先顺序

1. 修提醒过滤回填（`production-reminder-writer.ts`），否则 `start_here` 会漏提醒。
2. 处理 `profile.version`：去掉、改为遮盖后计算，或 HMAC。
3. 明确 `readCeiling` 是否覆盖 `find_memories`；若覆盖就接线，若不覆盖就写清边界。
4. 决定稳定段与整批遮盖的取舍，并同步测试/文档。
5. 补 ADR 0242 或更新 ADR 0219 + 清单 reason；补 profile 失败和排序反向测试。
