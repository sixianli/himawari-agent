## 范围

本次 diff 只改了 `docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md` 一个文件，工作区干净，没有代码改动。以下核对基于提交 `9c19385` 的代码。

## 作者说法核对

1. **正确。** `apps/agent-service/src/production-mcp-rule-writer.ts:16` 原文 `export const EXTERNAL_RULE_TYPES = ["mail_must_notify", "mail_read_whole_thread"] as const;`；`production-mcp-read.ts:613` 用它生成枚举，`:671` 用它校验。
2. **正确。** `packages/application/src/rules/rule-types.ts:202-213` 的 `RULE_TYPES` 只有这两项。
3. **正确。** `production-mcp-read.ts:324-326` 原文就是 `rule.id === "quiet_hours"` / `rule.id === "floor_important_sender"`。
4. **正确。** `production-mcp-read.ts:1262-1264` 的 `#startHere` 只取 `enforcedOwnerRule(row)?.summary`，不带 `params`。
5. **基本正确，但不完整。** `production-mcp-memory-writer.ts:46-56` 的 `EXTERNAL_PROPOSAL_CATEGORIES` 确实不含 `rule`；但另有一份在 `packages/persistence-sqlite/src/data-export/schemas.ts:153-163`，数据库还有 `migrations/0093_external_memory_proposals.sql:11-14` 的 CHECK 清单。实际不止“另抄一份”。
6. **正确。** `docs/adr/0213-owner-sentence-becomes-a-standing-rule.md:32` 原文含“模型推断出来的只生成提议，主人点头才生效”。
7. **正确。** `production-mcp-read.ts:1240-1241` 调用 `sources.profile`；`service-main.ts:2265-2294` 已接线；`owner-profile-service.ts:14,78-81` 有 `OWNER_PROFILE_CHARACTER_BUDGET = 2000` 和 `maxClassification`。

## 读代码证实的问题

### 高：登记表并不是通用的外部规则参数表，“不用改对外入口代码”不成立

**文件:行**：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:123,193,248`；`packages/application/src/rules/rule-types.ts:43-50`；`apps/agent-service/src/production-mcp-read.ts:613-622,764-774`

**问题**：补注说“`propose_rule` 的类型和参数说明从登记表生成，表里加一种规则类型，外部 agent 就能提这一种，不用再改对外入口的代码”。但登记表本身的接口就写死了邮件匹配参数；对外入口的输入 schema 和确认框也写死了五个邮件字段和两种“做法”。任务 C 如果照补注直接删掉 `EXTERNAL_RULE_TYPES` 改用 `RULE_TYPES`，新增的非邮件规则会通过校验，却在确认框里被显示成错误的行为、空的参数——而主人点头是规则生效的唯一闸门。

**证据**：

```ts
// rule-types.ts:43-50
export interface RuleTypeDefinition {
  readonly id: string;
  readonly gate: RuleGate;
  readonly outcome: RuleOutcome;
  readonly tests: string | null;
  parse(value: unknown): MailMatchParameters;
  expression(parameters: MailMatchParameters): string;
  examples(parameters: MailMatchParameters): readonly RuleExample[];
}
```

```ts
// production-mcp-read.ts:613-622
type: { type: "string", enum: [...EXTERNAL_RULE_TYPES] },
params: {
  type: "object",
  properties: {
    senderDomains: list,
    senderAddresses: list,
    phrases: list,
    words: list,
    excludePhrases: list,
  },
```

```ts
// production-mcp-read.ts:764-774
kind:
  preview.type === "mail_must_notify"
    ? MCP_PROPOSE_RULE_KIND_NOTIFY.text
    : MCP_PROPOSE_RULE_KIND_WHOLE_THREAD.text,
conditions: renderPrompt(MCP_PROPOSE_RULE_CONDITIONS, {
  senderDomains: listed("senderDomains"),
  senderAddresses: listed("senderAddresses"),
  phrases: listed("phrases"),
  words: listed("words"),
  excludePhrases: listed("excludePhrases"),
}),
```

**建议**：在每个规则类型定义里加“可否由外部提议”的显式标志，以及对外参数描述、行为标签、确认框渲染函数；由这些元数据同时生成输入 schema 和确认文字。未完成前保留 `EXTERNAL_RULE_TYPES` 白名单，不要用“登记表全量”替代。测试必须逐类型断言确认框里的做法和条件，不能只断言“接受这个类型”。

### 高：未知类别按“其他”收，会削弱敏感分类，并与现有 schema、ADR 0228 冲突

**文件:行**：`docs/adr/0242...:105`；`apps/agent-service/src/production-mcp-read.ts:532,818`；`apps/agent-service/src/production-mcp-memory-writer.ts:92-98`；`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:11-14`；`packages/persistence-sqlite/src/data-export/schemas.ts:153-163`；`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:77`

**问题**：补注要求“清单里没有的值，按‘其他’收，不因此拒收”。现在两层都在拒绝：MCP 输入 schema 的 `enum` 和 `#readProposalArgs` 的 `includes`。更关键的是，分类提示参与敏感判断：`proposalClassification` 先看类别是不是 `health`/`finance`，不是才扫描证件号等标识。若对方本意是 `health` 但拼错或用了新类别，落到 `other` 后，正文里没有标识就不会被判为 sensitive。另外补注说“不另抄一份”，但清单实际存在于 writer、data-export schema 和数据库 CHECK 三处；将来 `MEMORY_CATEGORIES` 加一个值，writer 可能接受，数据库或导出 schema 却拒绝。

**证据**：

```ts
// production-mcp-memory-writer.ts:92-98
export function proposalClassification(
  text: string,
  category: ExternalProposalCategory,
): "private" | "sensitive" {
  return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category)
    ? "sensitive"
    : classificationWithIdentifiers(text, "private");
}
```

```sql
-- 0093_external_memory_proposals.sql:11-14
category TEXT NOT NULL CHECK (
  category IN (
    'identity', 'preference', 'relationship', 'goal', 'project', 'health', 'finance',
    'event', 'other'
  )
),
```

```ts
// production-mcp-read.ts:818
!(EXTERNAL_PROPOSAL_CATEGORIES as readonly string[]).includes(category) ||
```

ADR 0228 决定 3 也写明：“分类不在九种里……由工具参数格式挡下，整次调用被拒”。补注直接改变了这条行为，却没有在 ADR 0242 的 `amends` 里列入 ADR 0228，也没有说要改 schema/导出。

**建议**：明确选择一种行为并同步所有使用方：
- 若保留“按其他收”，必须去掉 MCP schema 的 `enum`、改 `#readProposalArgs`、更新 ADR 0228，并保证未知类别不会被用于降低敏感级别（至少对 `health`/`finance` 的近义/未知值做保守处理，或记录原值供主人看）。
- 若保留拒绝，就删掉补注里的“不因此拒收”。
- 增加一个门：断言“外部可用类别 = `MEMORY_CATEGORIES` 去掉 `rule`”与数据库 CHECK、data-export enum 完全一致；不要只改 writer 的一份。

### 中：“项目不限于代码仓库”与“去凭据、带凭据一律拒绝”互相矛盾

**文件:行**：`docs/adr/0242...:130-131,248`

**问题**：原文要求服务端把项目名规范化、去凭据，并“收到仍带这些部分的项目名一律拒绝”；补注又说服务端“只把它当一段文字……不假设它是 git 地址”。如果项目名真的不限于代码仓库，聊天项目名可能合法地含 `?`、`#`、`@`、`:`（例如“Q3?计划”“调研#2”），按原规则会被当成查询参数、锚点或凭据而拒绝或改写。补注新增的测试只覆盖“中文、带空格”，没有覆盖这些字符，无法证明通用。

**证据**：

```text
// ADR 0242:130
远程地址里可能带用户名和令牌（`https://用户:令牌@主机/仓库`，令牌也可能写在查询参数里）……
服务端收到仍带这些部分的项目名一律拒绝。

// ADR 0242:131
服务端只把它当一段文字（规范化、去凭据、长度和字符检查同上），不假设它是 git 地址
```

**建议**：把“项目名语法”和“git 远程地址清洗”分开。只有助手程序声明来源是 git 远程时才做凭据剥离；其余来源把 `? # @ :` 当普通文字（在键里编码或转义），不要按 URL 解释。测试补上非 git 名称含这些字符的正向用例，以及确实带凭据的拒绝用例。

### 中：`ruleParameters` 补注把内置规则手册和外部规则类型登记表混在一起

**文件:行**：`docs/adr/0242...:193`；`apps/agent-service/src/production-mcp-read.ts:324-326`；`packages/application/src/rules/rule-book.ts` 的 `RuleRecord` / `ruleBookFor`

**问题**：`ruleParameters` 处理的是 `ruleBookFor(settings)` 产出的内置/设置规则（`quiet_hours`、`floor_important_sender`、`floor_public_domain`、`floor_money_words`），不是 `rule-types.ts` 的 `RULE_TYPES`。`RuleRecord` 没有“规则自己的定义”或参数暴露元数据；`quiet_hours`/`floor_important_sender` 的参数来自 `settings`，也不在 `RuleRecord` 里。补注说“由规则自己的定义声明对外给哪些参数”，编码线程可能去改 `RULE_TYPES`，结果 `rule_book` 的内置规则仍然写死。

**证据**：

```ts
// production-mcp-read.ts:324-326
function ruleParameters(rule: RuleRecord, settings: ProactiveSettings): Record<string, unknown> {
  if (rule.id === "quiet_hours") return { quietHours: settings.quietHours };
  if (rule.id === "floor_important_sender") return { importantSenders: settings.importantSenders };
  return {};
}
```

**建议**：给内置/设置规则加显式的“对外参数”声明（例如在 `ruleBookFor` 产出的对象上带一个 `exposeParameters(settings)`，或单独一张内置规则元数据表），并明确它和外部 `RULE_TYPES` 是两套东西。测试要覆盖“新增一条带参数的内置规则，不改 `production-mcp-read.ts` 也能在 `rule_book` 里出现参数”。

### 中：新增的测试条目不是可执行检查，部分反向用例按现有代码无法成立

**文件:行**：`docs/adr/0242...:248`；`apps/agent-service/src/production-mcp-read.ts:613,752`；`test/tooling/rule-type-tests.test.ts`

**问题**：本次 diff 没有新增任何自动检查，line 248 只是计划条目。作者说“文档检查的结果由作者在提交说明里写明”，这与“没有跑测试”一致，但不能回答“反向用例是否真的会失败”。其中几条按现有结构无法直接写：
- “在测试用的登记表里加一种规则类型，`propose_rule` 就接受这一种”：MCP 层没有注入 registry 的入口，`EXTERNAL_RULE_TYPES` 是直接 import 的常量。
- “类别提示给了清单里没有的值，按‘其他’收”：当前 schema `enum` 会先拒绝。
- “登记一个没接读取上限的读工具，检查失败”：现在没有统一强制读取上限的注册机制。
- `test/tooling/rule-type-tests.test.ts` 对所有登记类型都用同一组 `SAMPLE_PARAMETERS`（五个邮件字段），新增非邮件类型会先在这个测试里失败。

**建议**：先加测试缝（registry 注入、读工具注册时强制 ceiling、类别解析入口），再写这些反向用例；否则测试只能覆盖“新类型恰好也是邮件匹配类型”的假通用，漏掉确认框写死的问题。

### 低：补注还改了前提 16，和“原文不动、补注写在各条决定下面”的约束不一致

**文件:行**：`docs/adr/0242...:62`

**问题**：diff 在前提 16 里直接追加了一句“这是写本 ADR 时 main 上的样子；PR 413 合并后……”，不是在决定下面加带日期的补注。虽然保留了原文，但与作者自述的写法约束不一致。

**建议**：把这句话移到前提后面的带日期补注，或放到“后果/补注”小节，保持原文段落不动。

### 低：“表里加一种规则类型就能提”忽略了没有测试的类型，并与 ADR 0226 的补注冲突

**文件:行**：`docs/adr/0242...:123,191`；`packages/application/src/rules/rule-types.ts:47,224-231`；`apps/agent-service/src/production-owner-rules.ts:458-460`；`docs/adr/0226...:61`

**问题**：`RuleTypeDefinition.tests` 可以为 `null`，`writableRuleType` 会以 `RULE_TYPE_UNTESTED` 拒绝；`#draft` 也调用它。所以“表里加一种规则类型，外部 agent 就能提”只对“带测试的类型”成立。另外 ADR 0226 的 2026-11-12 补注写“能提的规则种类……不变”，和 ADR 0242 的“登记表加类型就能提”在长期政策上矛盾。

**证据**：

```ts
// rule-types.ts:224-231
export function writableRuleType(...) {
  const found = ruleType(id, registry);
  if (found.tests === null || found.tests.length === 0)
    throw new RuleTypeError("RULE_TYPE_UNTESTED", `规则类型 ${id} 没有测试，不能承载硬规则`);
```

**建议**：把措辞改成“登记表里带测试的类型”；同时更新 ADR 0226 的补注，说明未来登记表扩展时外部可提范围如何变化。

## 推测（未完全证实）

- **规则提议的预演/回放成本可被外部 agent 放大。** `propose_rule` 第一次调用就执行 `rules.preview`，`preview` 会调用 `#replay`（`production-mcp-read.ts:752`，`production-owner-rules.ts:585`），按 ADR 0213 决定 6 在近 30 天、每种结论最多 300 封邮件上重算。外部 agent 只要每次改参数或说明就能触发一次新的回放，而“直接存只管记忆”只保证规则不会自动生效，并不限制提议次数和回放成本。建议按接入给 `propose_rule` 单独配额，或把回放推迟到主人打开提议时再做。外部模型是否能看到回放数字，未核实。
- **“以登记表为准”是权限面的扩大。** 当前 `EXTERNAL_RULE_TYPES` 是独立的外部白名单；改成 `RULE_TYPES` 全量后，未来任何为“主人可立”而加的规则类型都会自动变成“外部可提”。主人点头能阻止自动生效，但挡不住提议轰炸、参数语义暴露，以及上面说的确认框误导。建议在类型定义里保留 `externallyProposable` 显式标志，而不是用“主人可立”等同于“外部可提”。

## 侧重检查

- **错误路径/不可信输入**：`#readProposalArgs` 现在对未知类别返回 `invalid`；补注改成“按其他收”，会放宽不可信输入的校验。`propose_rule` 的 `reason` 长度和参数有校验，但新增规则类型没有“外部是否可提”的校验。项目名的“任意文字”与凭据拒绝规则冲突。结论：有需要补的校验和契约。
- **安全/隐私**：未知类别降级可能让本应按健康/财务敏感保存的内容落到 `other`，只靠正文标识扫描兜底。登记表全量 + 确认框写死会破坏“主人知情同意”。遮盖逻辑本次未改，`start_here` 的遮盖仍沿用 `maskForExternalRead`。结论：敏感分类和确认框是主要风险。
- **资源耗尽**：`propose_rule` 在主人批准前就做回放；补注扩大了可提类型范围，可能放大计算量。现有每分钟限流不能按“规则提议”单独计量。结论：建议加配额或延迟回放。
- **不可撤销操作**：本次没有新增不可逆操作。规则仍需主人确认才生效；`sync_memories` 的删除有版本标记和“一天一半”刹车（ADR 0242 决定 6）。结论：未发现新的不可逆路径。
- **规则文件/文档一致性**：发现前提 16 的内联修改；ADR 0226 的“种类不变”与 ADR 0242 的“登记表扩展”矛盾；ADR 0228 的“分类不在九种里整次拒绝”与补注矛盾；ADR 0246 的 data-export schema 还有一份类别清单；作者说法 5 的“另抄一份”实际不止一份。结论：需要统一修订。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**Himawari 自己发给模型的请求：不会。** 本次是纯文档改动，没有改系统提示、工具定义、历史或遮盖。ADR 0242:233 也明确写“Himawari 自己发给模型的请求不变；新工具只注册在对外的 MCP 服务上”。

**对外部 agent：** `start_here`、`rule_book`、`sync_memories` 的输出是工具结果，追加在对方对话的末尾；每轮会变的 `today`、`now`、提醒、摘要、概况版本都在工具结果里，不在系统提示或工具定义里。`rule_book` 的设置参数只在主人改设置时变，不是每轮。**但** `propose_rule` 的类型枚举如果改成从 `RULE_TYPES` 生成，登记表一变就会改变对外 MCP 的工具定义，导致外部 agent 的请求开头变一次；这不是 Himawari 自己的请求，ADR 0242:233 已承认“外部 agent 那边，工具清单会变一次”，但 `check:prompt-prefix` 不覆盖外部 MCP 侧，建议在任务 C 的记录里单独写明这个缓存代价。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**本次文档改动不会。** 新增的清单都是固定数组；项目名规范化是确定性的；没有新增时间、随机数或无序集合。实现时要注意：从 `Set`、对象遍历或数据库返回生成 enum/参数说明时，顺序必须固定；ADR 0242 的后果已经要求“同样的数据每次顺序相同”。`start_here` 里的 `today`/`now` 是每轮变化的值，但它们在工具结果里，不是同一段文字被改成不同字节；遮盖规则本次未改。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**没有可执行检查。** 本次只加了 line 248 的计划条目，没有新增测试。作者说“文档检查的结果由作者在提交说明里写明”，这与“没有跑测试”一致，但不能证明反向用例会失败。而且其中几条按现有代码无法直接成立：MCP 层没有 registry 注入入口；类别 `enum` 会先拒绝未知值；没有强制读工具接读取上限的注册机制；`rule-type-tests` 对所有登记类型都用邮件参数样例。建议先补测试缝，再把这些写成真正的反向用例，并增加“确认框文字/条件来自类型元数据”的断言。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- **规则类型 id**：产生于 `RULE_TYPES`（`rule-types.ts:202-213`）；使用于 MCP 输入 schema（`production-mcp-read.ts:613`）、运行时校验（`:671`）、`parseOwnerRuleParameters`/`writableRuleType`、`ProductionMcpRuleWriter.accept`、确认框渲染（`:764-774`）。**不能全部接受新类型**：`RuleTypeDefinition` 的参数类型写死为 `MailMatchParameters`，确认框把非 `mail_must_notify` 一律显示成“先读完整个邮件串”，条件只列五个邮件字段。需要改接口和确认框。
- **记忆类别**：产生于 `MEMORY_CATEGORIES` 去掉 `rule`（`memory-projection.ts:13-24`）；使用于 writer 的 `EXTERNAL_PROPOSAL_CATEGORIES`（`production-mcp-memory-writer.ts:46-56`）、MCP schema（`production-mcp-read.ts:532`）、处理函数（`:818`）、数据库 CHECK（`0093...sql:11-14`）、data-export schema（`schemas.ts:153-163`）、ADR 0246 的导出/导入。**不能全部接受**：未知值按“其他”收与现有 `enum`/`includes`/ADR 0228 的拒绝冲突；将来 `MEMORY_CATEGORIES` 新增值可能通过 writer 却过不了数据库或导出校验。这正是 I-73 那类“清单里的 id 能不能过后端校验”的问题。
- **项目名**：产生于助手程序；使用于服务端规范化/去凭据、唯一键、`find_memories` 的 `project`。**“任意文字”和“带凭据一律拒绝”不能同时成立**，需要先定义统一语法。
- **`rule_book` 参数**：产生于内置规则定义和 `settings`；使用于 `rule_book` 的 `ruleParameters`。**没有“规则自己的定义”这个载体**，需要新增元数据。
- **读取上限**：不是新值；当前只有 `start_here` 使用（`production-mcp-read.ts:1240`），另外三个读工具尚未接；补注说的“不接就过不了自动检查”目前没有实现机制。
- **配置键/清单项/序列化格式**：本次 diff 没有改这些；`sync_memories`、项目表、统计表都还没实现，相关值属于任务 C 的设计，未核实。

**结论**：不是每个使用方都能接受补注产生的新值。至少规则类型、记忆类别、项目名三处需要同时改生产端和消费端的校验，并加跨端一致性测试。
