# 复核结论

## 发现（按严重度）

### 1. 低（读代码证实）：新增的「逐条隔离」分支没有用例，且会静默吞掉非 `RuleTypeError`

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:181-190`、`test/integration/mcp-read.test.ts:151-163`
- 问题：新加的 `try/catch` 只在 `enforceableOwnerRule` 抛出**非** `RuleTypeError` 时才有意义；现有测试里的 `owner:unknown` 和 `owner:empty` 都是 `RuleTypeError`，在 `enforceableOwnerRule` 内部已经被吞掉，走不到新分支。因此作者说的 r1-6 修改没有自动用例锁住。
- 证据：

```ts
// production-mcp-read.ts:184-189
try {
  const rule = enforceableOwnerRule(row);
  return rule ? { rule, params: parseOwnerRuleParameters(row.parameters).params } : undefined;
} catch {
  return undefined;
}
```

```ts
// rule-types.ts:304-309
if (row.status === "retired") return undefined;
try {
  return ownerRuleRecord(row, registry);
} catch (error) {
  if (error instanceof RuleTypeError) return undefined;
  throw error;
}
```

测试只有：

```ts
// mcp-read.test.ts:151-163
{ type: "mail_unknown_kind", summary: "看不懂的规则", params: {} },
{ type: "mail_must_notify", summary: "参数不全的规则", params: {} },
```

- 建议：把这条容错逻辑抽成可注入 registry 的单元函数，或增加一个确实能让 `assertRuleExamples` 等抛出普通 `Error` 的用例；同时在该分支记录一条日志，避免代码 bug 被伪装成 `enforced: false`。

### 2. 低（读代码证实）：新用例不在 `npm run check` 里，只在 CI 的 integration 项目里

- 文件:行：`package.json:27`、`package.json:59`、`ci/policy.json:158-160`
- 问题：`npm run check` 的 `check:steps` 没有跑 `test/integration/mcp-read.test.ts`；`check:rule-registry` 只列了 `decision-chain` 和 `decision-email`。该用例只在 CI 的 `integration` 项目（`test/integration/**/*.test.ts`）里跑。若开发只跑本地 `npm run check`，这次新增的排序、撤销、归一化反向用例不会执行。
- 建议：把 `mcp-read.test.ts` 加进某个 `check:*` 项目，或明确记录该门的验证依赖 CI integration，避免本地“全绿”误判。

### 3. 低（读代码证实）：工具说明说主人规则都“带参数”，代码对不可执行的规则不给参数

- 文件:行：`packages/prompt-catalog/src/tools.ts:285`、`apps/agent-service/src/production-mcp-read.ts:177`
- 问题：说明文字写的是「主人在对话里立的长期规则……带类型、一句话说明、参数和是否正在执行（enforced）」；实际 `owner:empty`、`owner:unknown` 这类 `enforced: false` 的规则没有 `parameters`。ADR 0219 第 8 条明确写的是「能执行的再带……参数」，但工具说明没写这个条件。
- 证据：

```ts
// tools.ts:285
...主人在对话里立的长期规则编号以 owner: 开头，带类型、一句话说明、参数和是否正在执行（enforced）。
```

```ts
// production-mcp-read.ts:177
...(enforced ? { parameters: enforced.params } : {}),
```

- 建议：工具说明改为「能执行的规则还带参数」，与 ADR 和实现一致。

### 4. 低 / 推测：`type`、`summary` 用原始存储值，`parameters` 用解析后的值

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:161-177`
- 问题：`type` 和 `summary` 直接取 `row.parameters` 的原始字段，`gate`、`outcome`、`parameters` 来自解析后的规则。正常写入路径 `#activate` 存的是已 trim 的 `parsed.summary`，所以生产数据一致；但如果数据库里存在直接写入或历史脏数据，对外会显示未 trim 的 `summary`，而执行时用的是 trim 后的值。
- 证据：

```ts
const stored =
  row.parameters !== null && typeof row.parameters === "object"
    ? (row.parameters as Record<string, unknown>)
    : {};
...
...(typeof stored["type"] === "string" ? { type: stored["type"] } : {}),
...(typeof stored["summary"] === "string" ? { summary: stored["summary"] } : {}),
...(enforced ? { parameters: enforced.params } : {}),
```

正常生产写入：

```ts
// production-owner-rules.ts:521
parameters: { type: parsed.type, params: parsed.params, summary: parsed.summary },
```

- 建议：强制执行时也用 `parseOwnerRuleParameters` 返回的 `type`/`summary`，或在 ADR 里说明原始值就是展示值。当前正常数据下影响很小。

### 5. 设计确认（读代码证实）：`ownerRules` 读取失败会让整次 `rule_book` 失败

- 文件:行：`apps/agent-service/src/production-mcp-read.ts:435-441`
- 问题与判断：这和我读到的一致，和 `settings` 失败一样，整次工具失败并记 `rule_book_failed`。我认为可以接受：`rule_book` 是让外部程序了解主人规矩的完整性工具，静默只返回内置规则会让对方误以为没有主人规则；失败关闭比返回不完整清单安全。代价是主人规则表的一处故障会连带隐藏内置规则。
- 建议：如果以后希望降级，可仿照 `today_context` 的摘要做法返回 `rulesComplete: false` 并记一条独立的失败日志；当前不构成缺陷。

---

## 侧重检查

- **错误路径**：
  - `ownerRules` 拒绝时 `#ruleBook` 直接抛出，`#call` 捕获并返回工具错误，同时仍写失败决策记录（`production-mcp-read.ts:298-320`）。
  - 单条规则参数非法或类型未知由 `enforceableOwnerRule` 返回 `undefined`，标 `enforced: false`，不给 gate/outcome/parameters。
  - 非 `RuleTypeError` 现在被逐条 catch，但无日志、无测试（见发现 1）。
  - 遮盖异常会由外层 `#call` 捕获；不会把未遮内容发出。
- **不合规范/不可信输入**：
  - `ownerRules` 来自本地 SQLite，不是网络输入；参数在写入时由 `parseOwnerRuleParameters` 校验，读取时再次解析。类型未知、参数缺项、参数不合法都被隔离为 `enforced: false`。
  - `type`/`summary` 的原始值直接输出，但正常写入路径已校验和 trim（见发现 4）。
- **安全**：
  - 返回内容整体经 `maskForExternalRead` / `maskSensitiveTexts`，机器密钥、密码、验证码、银行卡、证件号按现有规则遮盖。
  - 不返回规则表达式，符合 ADR 0219 决定 8。
  - 规则参数（发件域名、词语等）确实随静态令牌对外。`find_memories` 本来就能读到规则类记忆，ADR 0219 把该令牌定义为主人的全部只读权限，因此 r1-3 的结论我同意；残余风险是共享令牌无法按程序分开授权，属于 P5-3。
  - `source` 只输出 `chat:<threadId>` 一类出处，不输出 `source_memory_id`；未发现敏感信息直接泄漏。
- **资源耗尽**：
  - 生产创建路径把非 retired 规则限制在 `ACTIVE_RULE_LIMIT = 32`（`production-owner-rules.ts:52,507-508`），单条参数上限 16 KiB；没有发现新增的无界循环。
  - 底层 `list` 还有 `LIMIT 200`（`sqlite-owner-rule-operations.ts:83-91`），超过 200 条时会先按 `updated_at DESC` 截断再按编号排序；正常生产被 32 条上限挡住，但如果是手工写库的异常数据，列表就不再是“全部规则按编号排序”。这是边界观察，不是本 PR 的正常路径缺陷。
- **不可撤销操作**：本改动只读，没有写库、删除或状态变更。
- **规则/文档/代码一致性**：
  - ADR 0219 第 8 条与实现基本一致：内置规则之后追加、按编号排序、不列 retired、needs_review 仍 `enforced: true`、不可执行不给参数、整体遮盖。
  - 唯一不一致是工具说明没有写明“只有能执行的规则才带参数”（见发现 3）。
  - prompt-prefix 规则方面：`mcp.rule-book` 只被 `production-mcp-read.ts` 使用，不进入 Himawari 自己的模型请求；但改提示词目录会改变全局 `TRUSTED_PROMPT_TEXTS` 白名单。由于旧的 `mcp.rule-book` 文字从未出现在 Himawari 的模型请求里，既有对话的请求开头不会因此变化。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？

**Himawari 自己发给模型的请求：不会。**

依据：
- `MCP_TOOL_RULE_BOOK` 只出现在 `apps/agent-service/src/production-mcp-read.ts:275`；grep 没有发现它被模型提示组装使用。
- `production-mcp-read.ts` 是外部 MCP 入口，不属于 Himawari 自己的模型请求。
- 本 PR 没有改系统提示、工具集合、历史消息或模型请求的组装顺序。

例外说明：修改 `packages/prompt-catalog/src/tools.ts` 会改变 `TRUSTED_PROMPT_TEXTS` 这份全局遮盖白名单（`packages/prompt-catalog/src/trusted.ts:10-14`）。但旧的 `mcp.rule-book` 文本从未进入过 Himawari 的模型请求，所以既有对话没有需要重新遮盖的旧固定文本。新的工具说明也不会进入 Himawari 的模型请求。

`rule_book` 的返回内容是每次请求重新生成的，不是历史消息；外部客户端如果把工具结果追加到它自己的模型请求末尾，那是追加，不是改写已有开头。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**对 Himawari 模型请求：没有发现新的来源。**

对 `rule_book` 响应本身：
- 顺序确定：内置规则顺序固定，主人规则按 `ruleId` 排序（`production-mcp-read.ts:437-441`）。
- 字段顺序确定：对象字面量固定；参数数组由 `parseOwnerRuleParameters` 去重并排序（`rule-types.ts:86,109-115`）。
- 没有时间字段；`updatedAt` 没有输出。
- 遮盖有一个设计内的跨字段影响：`maskSensitiveTexts` 先扫一遍全部文字，记住认出的密码/验证码，再遮第二遍（`redaction.ts:552-568`）。因此同一响应里后面的主人规则可能改变前面某段文字的遮盖结果。ADR 0219 决定 4 明确采用这个两遍设计，且 `rule_book` 不是持久化的模型历史，不会改写已经发过的请求开头。同一规则集合下结果仍是确定的；规则集合变化时输出本来就会变化。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有，但覆盖不完整。

- 新增的 `test/integration/mcp-read.test.ts` 覆盖了：
  - 内置规则之后按编号排序：`mcp-read.test.ts:552-561`；
  - retired 不出现：同一 `toEqual` 列表；
  - needs_review 仍 `enforced: true`：`mcp-read.test.ts:571-576`；
  - 未知类型、参数不全：`mcp-read.test.ts:577-583`；
  - 参数归一化：`owner:immigration` 存 `@ISA.go.jp `，断言 `isa.go.jp`（`mcp-read.test.ts:120-130,562-570`）。
- 按代码推理，这些反向用例会失败：
  - 去掉客户端排序后，数据库按 `updated_at DESC, rule_id` 返回的顺序与期望的编号顺序不同（`owner:empty`、`owner:unknown` 会排在前面），断言会失败；
  - 把 `includeRetired` 改成 `true`，`owner:retired` 会出现在列表里，`toEqual` 会失败；
  - 回退成原始 `stored.params`，`toMatchObject({ senderDomains: ["isa.go.jp"] })` 会失败。
- 但发现 1 的新逐条容错分支没有用例；发现 5 的整体读取失败也没有新增用例。
- `check:prompt-catalog` 会用 `prompt-catalog.unit.test.ts:184-192` 核对 manifest 摘要；我无法运行它，所以 manifest hash 是否正确未核实。
- 该集成测试不在本地 `npm run check` 的步骤里，只在 CI 的 integration 项目里（发现 2）。

### 4. 每个新值/字段，生产端和使用端能对上吗？

逐个核对结果：

- `ownerRules?: () => Promise<readonly StoredOwnerRule[]>`：
  - 生产端：`service-main.ts:1806-1811` 传 `ownerRuleStore.list({ includeRetired: false })`；测试端：`mcp-read.test.ts:298` 传同一调用。
  - 使用端：`production-mcp-read.ts:437-441` 期望 `StoredOwnerRule[]`。类型和字段（`ruleId`、`revision`、`status`、`source`、`parameters`）匹配。
  - 可选字段，未传的旧测试不会坏。
- `includeRetired: false`：
  - 生产端：`service-main.ts:1810`、测试：`mcp-read.test.ts:298`。
  - 使用端：`sqlite-owner-rule-operations.ts:88` 的 SQL 用 `(? = 1 OR status IN ('active', 'needs_review'))`，两端一致；retired 被排除，needs_review 保留。
- `ruleId` 排序：
  - 生产端：`production-mcp-read.ts:438-440`。
  - `ruleId` 由 `owner:` 前缀和 `[A-Za-z0-9_-]` 组成（`rule-types.ts:280`、`sqlite-owner-rule-operations.ts:8`），字符串比较稳定，确定性可以接受。
- `parameters`：
  - 生产端：`parseOwnerRuleParameters` 返回规范化后的 `MailMatchParameters`（`rule-types.ts:257-274`）。
  - 使用端：外部 JSON 输出；测试验证了域名归一化。两端的参数语义与 Gmail 检查执行用的是同一个解析函数，一致。
- `gate`、`outcome`：
  - 生产端：`enforceableOwnerRule` 返回的 `RuleRecord`（`rule-types.ts:283-293`）。
  - 使用端：只在 `enforced` 为真时输出。`needs_review` 不会被 `enforceableOwnerRule` 当成 retired，仍可执行，符合 ADR 0211。
- `enforced`：
  - 生产端：`rule !== undefined`；`RuleTypeError` 和 retired 都返回 `undefined`。
  - 使用端：外部程序据判断规则是否在执行；测试锁住了已知类型但参数不合法时为 false。
- `type`、`summary`：
  - 生产端：原始存储值；正常写入时 `production-owner-rules.ts:521` 存的是校验后的 `parsed.type` / `parsed.summary`。
  - 使用端：原样 JSON 输出并整体遮盖。正常数据一致；异常/手工写入数据有轻微差异（发现 4）。
- `MCP_TOOL_RULE_BOOK.text`：
  - 生产端：`tools.ts:285`。
  - 使用端：`production-mcp-read.ts:275` 作为外部 MCP 工具说明。
  - 清单端：`prompt-manifest.json` 的 `mcp.rule-book.sha256` 已同步修改；是否与当前 `segments` 完全一致，未核实（有 `check:prompt-catalog` 会检查）。
- 序列化格式：
  - `JSON.stringify(maskForExternalRead(outcome.output))`；字段顺序固定，数组顺序固定，没有依赖数据库返回顺序。

---

## 未核实

- `prompt-manifest.json` 中 `mcp.rule-book` 的 `sha256` 是否真的等于新文字的摘要（无法运行 hash/测试）。
- `npm run check` 的 `format:check`、`check:secrets` 是否在干净 main `949d2fa9` 上确实失败、是否来自 PR 380（我没有运行这两步；只确认本 PR 的 diff 没碰 `evals/owner-rule/*.json` 和 `scripts/evals/owner-rule-live.eval.ts`）。
- 集成测试实际执行结果（本轮只读代码和 git，不运行测试）。
- 生产数据库中是否存在 `summary` 未 trim、类型/参数与正常写入路径不同的历史行（没有生产库可查）。
