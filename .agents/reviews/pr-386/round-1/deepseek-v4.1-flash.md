## 结论

没有发现高风险问题。作者关于“Himawari 自己的模型请求一字节不变”的说法与代码一致；主要问题在测试覆盖和对外暴露的参数范围。

## 读代码证实的问题

### 1（中）核心行为没有完整反向用例：已撤销、待重审、排序都没被测试锁住

- 文件：`test/integration/mcp-read.test.ts:222-240`、`test/integration/mcp-read.test.ts:513-541`
- 问题：
  - 测试只造了两条规则，都是 `active`，且都用同一个 `now: NOW`：`["owner:immigration", ...]`、`["owner:unknown", ...]`。
  - 两条规则按 id 升序创建；数据库列表顺序是 `ORDER BY updated_at DESC, rule_id`（`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:88-89`），两行 `updated_at` 相同，所以返回顺序本来就是 `owner:immigration`、`owner:unknown`。把 `production-mcp-read.ts:421-424` 的排序删掉，这条测试仍然会通过。
  - 没有创建 `retired` 规则，也没有创建 `needs_review` 规则。把 `service-main.ts:1810` 的 `includeRetired: false` 改成 `true`，或把数据库过滤条件改成只取 `active`，这条测试也不会失败。ADR 0219 决定 8 的“不列已撤销的”“待重新确认照常列”因此没有对应的门槛。
  - 也没有覆盖“已知类型、参数不合法”的 `enforced:false` 分支，只覆盖了类型不认识的分支。
- 证据：
  ```ts
  for (const [ruleId, parameters] of [
    ["owner:immigration", { type: "mail_must_notify", ... }],
    ["owner:unknown", { type: "mail_unknown_kind", ... }],
  ] as const)
    await repository.ownerRules().create({ ...scope, ruleId, parameters, ..., now: NOW });
  ```
  ```ts
  expect(output.rules.map(({ id }) => id)).toEqual([
    "floor_important_sender", ..., "owner:immigration", "owner:unknown",
  ]);
  ```
- 建议：加三条规则，让 `updated_at` 顺序与 id 顺序相反，验证排序；一条 `needs_review` 必须出现且 `enforced:true`；一条 `retired` 必须不出现；一条已知类型但参数非法必须 `enforced:false` 且不带 `gate`、`parameters`。这样才验证了本 PR 的核心声明。

### 2（中，设计风险）主人规则的 `phrases` / `words` 是聊天里的自由文本，会随静态令牌整体对外暴露

- 文件：`apps/agent-service/src/production-mcp-read.ts:161-172`、`packages/application/src/rules/rule-types.ts:35-41`、`docs/adr/0219-read-only-mcp-entry-with-static-token.md:87-90`
- 问题：ADR 0219 决定 8 明确决定返回 `parameters`，代码与 ADR 一致；但返回的不只是发件域名，还包括 `senderAddresses`、`phrases`、`words`、`excludePhrases`。这些是主人聊天原话里提炼出的自由文本，可能包含疾病、关系、姓名等普通个人内容。出口遮盖只处理密码、验证码、证件号、银行卡等固定模式（ADR 0219 决定 4），不会遮这些普通个人内容。MCP 入口又是一把静态令牌，任何持有令牌的外部 agent 都能拿到全部规则参数。
- 证据：
  ```ts
  ...(rule && stored["params"] !== undefined ? { parameters: stored["params"] } : {}),
  ```
  ```ts
  readonly senderDomains: readonly string[];
  readonly senderAddresses: readonly string[];
  readonly phrases: readonly string[];
  readonly words: readonly string[];
  readonly excludePhrases: readonly string[];
  ```
- 建议：如果外部 agent 都在主人信任范围内，可保留现状，但建议在 ADR 中写明 `phrases`/`words` 也属于对外数据，并考虑按外部 agent 分发不同令牌、或只对明确授权的外部 agent 返回参数。若不想扩大暴露面，可以只返回 `summary` 和结构化的类型/是否执行，参数延迟到以后按需提供。

### 3（低）返回的是原始存储参数，不是规则实际使用的规范化参数

- 文件：`apps/agent-service/src/production-mcp-read.ts:156-172`、`packages/application/src/rules/rule-types.ts:95-115`
- 问题：`enforceableOwnerRule` 会通过 `parseOwnerRuleParameters` / `parseMailMatch` 对参数做去空格、全半角折叠、去重、排序，并把域名开头的 `@` 去掉；但 `ownerRuleEntry` 返回的是 `row.parameters.params` 原样 JSON。生产写入路径 `production-owner-rules.ts:517-522` 存的是已经解析过的参数，所以正常路径差别很小；但通过其他写入路径、历史数据或直接调用 `repository.ownerRules().create` 写下的行，对外显示的参数可能与实际执行时使用的参数不完全一致。
- 证据：
  ```ts
  ...(rule && stored["params"] !== undefined ? { parameters: stored["params"] } : {}),
  ```
  ```ts
  const senderDomains = entries(record["senderDomains"], "senderDomains").map((entry) =>
    entry.replace(/^@/u, ""),
  );
  ...
  return Object.freeze({ senderDomains: Object.freeze([...new Set(senderDomains)].sort()), ... });
  ```
- 建议：对能执行的规则再调用一次 `parseOwnerRuleParameters(row.parameters)`，返回解析后的 `params`，这样对外显示的参数就是实际执行参数。或者在 `RuleRecord` 中暴露解析后的参数，避免二次解析。

### 4（低）`ownerRules` 读取失败会让整个 `rule_book` 失败，单行异常没有隔离

- 文件：`apps/agent-service/src/production-mcp-read.ts:420-425`、`apps/agent-service/src/production-mcp-read.ts:282-304`、`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:31-41`
- 问题：`#ruleBook` 先读 settings，再整体读 owner rules；任意一步抛错都会让这次工具调用变成工具错误，内置的四条规则也拿不到。`fromRow` 对每一行做 `JSON.parse`，一行异常就会让整个 list 抛错。数据库层已经有 `json_valid(parameters) AND json_type(parameters)='object'` 检查，正常写入不会产生坏 JSON，所以实际风险低；settings 和 owner rules 又共用同一个 SQLite，数据库不可用时本来两边都会失败。因此“整次失败”与现有 settings 行为一致，可以接受，但“单行异常连坐全部”不是最优。
- 证据：
  ```ts
  const settings = await this.#options.sources.settings();
  const owned = this.#options.sources.ownerRules
    ? [...(await this.#options.sources.ownerRules())].sort(...)
    : [];
  ```
  ```ts
  parameters: JSON.parse(row.parameters) as unknown,
  ```
- 建议：在 `#ruleBook` 里逐条包一层 try/catch，失败的规则以 `enforced:false` 返回，或者单独记日志，不要因为一条坏规则丢掉整本规则手册。

## 侧重检查

- **错误路径**：`ownerRules` 抛错 → `#call` 捕获 → 返回 `MCP_TOOL_RESULT_FAILED` 工具错误并写失败决策记录（`production-mcp-read.ts:282-304`）。与 settings 出错一致，未发现内容泄漏；单行异常问题见上。
- **不可信输入**：主人规则的 `type`/`params` 通过 `enforceableOwnerRule` 校验后才给 `gate`/`outcome`/`parameters`；`summary` 和参数作为文本返回，并整体经过 `maskForExternalRead`。未发现执行路径和展示路径使用不同的校验函数。原始参数未规范化的问题见第 3 条。
- **安全**：静态令牌持有者能读到所有主人规则参数，这是 ADR 0219 决定 8 的有意选择；`maskSensitiveTexts` 只遮密码、验证码、证件号、银行卡等秘密，不遮普通个人内容，见第 2 条。`source` 字段还会暴露 `chat:<threadId>` 形式的内部对话编号（`production-owner-rules.ts:522`），外部 agent 目前没有使用线程编号的工具，风险低。
- **资源耗尽**：写入路径每人最多 32 条生效规则（`production-owner-rules.ts:52`），单条参数上限 16,384 字符（`rule-types.ts:17`），列表上限 200（`sqlite-owner-rule-operations.ts:11`）；`rule_book` 输出有界，限流由现有 `BearerGate` 负责。未发现本 PR 新增无界路径。`maskSensitiveTexts` 对这次返回的全部文字做两遍处理，规则多时会增加延迟，但规模有上限，未实测。
- **不可撤销操作**：本 PR 只增加只读 MCP 输出，没有写操作、没有不可撤销副作用。
- **规则/文档/代码一致性**：ADR 0219 决定 8 与代码基本一致。轻微出入：ADR 说每条都带“类型、说明”，代码在 `stored["type"]` / `stored["summary"]` 不是字符串时会省略（只影响异常数据行）；工具说明只说“是否正在执行”，没解释 `status: needs_review` 的含义。测试未覆盖这些声明，见第 1 条。
- **自动检查**：没有运行 `npm run check`。作者说 `format:check`、`check:secrets` 在干净 main 上同样失败，这一点未核实；本 PR 未改 `evals/owner-rule/*.json`，从 diff 看不出与这两步有关。`prompt-manifest.json` 的 sha256 也没有独立复算。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。

- `MCP_TOOL_RULE_BOOK` 只用于对外 MCP 服务的工具说明：`production-mcp-read.ts:259` 把它传给 `server.registerTool`，全仓库只有这一处使用（grep `MCP_TOOL_RULE_BOOK` 只命中 `production-mcp-read.ts` 和 `prompt-catalog` 本身）。
- `prompt-manifest.json` 只是提示词目录的校验清单，不进入模型请求。
- 本 PR 没有改系统提示、工具集合、历史消息、模型请求组装或出口遮盖函数。
- `rule_book` 返回的是对外 MCP 响应，不是 Himawari 发给模型的请求；返回内容里没有当前时间、日期、哈希等每轮会变的值（`updatedAt` 也没有返回）。因此“只在末尾追加、每轮会变的值都在最后一条消息里”这一条没有被触碰。

补充：`packages/prompt-catalog/src/trusted.ts:10-14` 会把目录里的所有固定文字放进 `TRUSTED_PROMPT_TEXTS`，本次改的 MCP 工具说明也会进入这个列表。但它不会出现在模型请求里，所以不会改变任何已有对话的遮盖结果；只有实际出现在模型请求中的固定文字才会受影响。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

在同一份规则数据下，没有新增的不确定性：

- 主人规则按 `ruleId` 排序（`production-mcp-read.ts:421-424`），规则 id 只允许 ASCII 字符，排序结果确定。
- 输出的对象字面量键顺序固定；没有时间戳、随机 id、Set/Map 遍历顺序。
- `parameters` 的 JSON 键顺序来自数据库里存储的 JSON 文本，对同一条规则同一份存储是稳定的；生产写入路径存的是解析后固定键顺序的对象。

需要注意的既有特性：整个响应的文字会一起交给 `maskSensitiveTexts`，这个函数会在这一批文字里共享“已点名的秘密”。如果某条主人规则的说明或参数点名了一个密码/验证码，同一批响应里其他位置单独出现的同一个值也会被遮掉。这是 ADR 0219 决定 4 明确接受的批内行为，不是本 PR 新增的模型请求问题；它只影响对外 MCP 响应的字节，不影响 Himawari 发给模型的请求。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有检查，但覆盖不完整。

- 现有：`test/integration/mcp-read.test.ts:513-545` 验证了内置规则之后出现一条能执行的主人规则和一条类型不认识的主人规则。
- 真正有效的反向用例：`owner:unknown` 期望 `enforced:false`、没有 `gate`、没有 `parameters`。如果实现错误地始终输出 `enforced:true` 或始终输出参数，这条测试会失败，所以这个反向用例是有效的。
- 缺失的反向用例：已撤销规则不出现、`needs_review` 照常出现且 `enforced:true`、多条主人规则的排序、已知类型但参数非法时的 `enforced:false`。这些都没有测试。按现有测试，删掉 `production-mcp-read.ts:421-424` 的排序、把 `includeRetired` 改成 `true`、或把数据库过滤改成只取 `active`，测试都不会失败。见第 1 条。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对结果：

| 值 | 产生处 | 使用处 | 结论 |
| --- | --- | --- | --- |
| `ownerRules` 可选源 | `production-mcp-read.ts:60` | `production-mcp-read.ts:421` | 只有 `#ruleBook` 使用；不提供时按空列表处理。可接受。 |
| `includeRetired: false` | `service-main.ts:1810` | 端口 `packages/application/src/ports/owner-rules.ts:22-24`；SQL `sqlite-owner-rule-operations.ts:83-92` | 两端都接受；SQL 过滤 `active`/`needs_review`。可接受，但未被 rule_book 测试覆盖。 |
| `id`、`revision`、`source`、`status` | `StoredOwnerRule` / 数据库 | 只进入对外 MCP 文本，没有内部输出契约校验 | 没有 I-73 式的后端校验不匹配；`status` 在 `includeRetired:false` 下只会是 `active` 或 `needs_review`。 |
| `gate`、`outcome`、`enforced` | `enforceableOwnerRule` | 与 Gmail 检查共用同一判定（`proactive-mail-check-service.ts:640-642`）；`assertRuleExamples` → `assertRuleShape` 保证 gate/outcome 合法 | 一致，可接受。 |
| `type`、`summary`、`parameters` | 原始 `row.parameters` | 对外 MCP 文本，整体经过 `maskForExternalRead` | `type`/`summary` 可接受；`parameters` 是原始值，可能和实际执行的规范化参数不同，见第 3 条。 |
| `mcp.rule-book` 文字 | `packages/prompt-catalog/src/tools.ts:279-286` | `production-mcp-read.ts:259`、`prompt-manifest.json`、`TRUSTED_PROMPT_TEXTS` | 只用于对外 MCP 和提示词目录校验；不进入模型请求。manifest 已同步，但 sha256 未独立复算。 |

没有发现有内部代码把 `rule_book` 的返回当作结构化输入再校验；它只作为自由文本交给外部 MCP 客户端，所以不存在“清单里的 id 过不了后端校验”那类问题。
