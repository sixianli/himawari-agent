## 一、读代码证实的问题（按严重度）

### 1. 中（安全）：`start_here` 的 `profile.version` 在统一遮盖之前计算，跨段被遮的值仍会进入哈希
- 文件：`apps/agent-service/src/production-mcp-read.ts:1387`（另见 `:1149-1150`）
- 问题：`profile.version` 只对本段 `requirements/sections/omittedProfile` 做遮盖；而最终输出是在 `#call` 里对整份 `outcome.output` 统一遮盖。若某值只在 `today` 段被点名、在 `profile` 段单独出现，最终 JSON 里 profile 中的值会被遮掉，但 `version` 的哈希输入仍含未遮的原值。`version` 是 12 位十六进制（48 bit），对 6 位验证码这类低熵值可离线枚举验证。
- 证据：
  - `production-mcp-read.ts:1387`：`const versionBase = JSON.stringify(maskForExternalRead([requirements, sections, omittedProfile]));`
  - `production-mcp-read.ts:1149-1150`：`delivered = { text: JSON.stringify(maskForExternalRead(outcome.output)), ... }`
  - 新用例 `test/integration/mcp-read.test.ts:1282-1296` 只断言 `result.text` 不含 `482913`，没有检查 `profile.version` 是否基于遮后的 profile 计算。
- 建议：让 `version` 基于最终会被输出的、已按跨段上下文遮过的 profile 计算（先构造 output、统一遮盖，再用遮后的 profile 计算版本），或不要把可能含未遮低熵值的文本用于对外哈希。需要接受一个代价：跨段点名会改变稳定段的 version，和现有“只有 today 变时 profile/rules 不变”的用例要做协调。另加用例：跨段点名场景下，用可见 profile 加候选值重算哈希，不应命中 `version`。

### 2. 中（安全/可用性）：主人规则过滤完全依赖出处记忆的分级，而写入端只按凭据/证件号升 sensitive；出处为空的规则还会被永久隐藏
- 文件：`apps/agent-service/src/production-mcp-read.ts:1238-1259`；`apps/agent-service/src/production-owner-rules.ts:396-411,430-438`；`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:252-256`
- 问题：
  1. `ownerRulesWithin` 把 `sourceMemoryId` 的 `dataClassification` 当作唯一分级来源。`source_memory_id` 为 `null` 或读不到时，规则在 `rule_book` 和 `start_here` 中会直接消失。迁移 0087 把当时所有旧行都写成 `NULL`，数据导入也允许 `NULL`，因此这可能误伤正常规则。
  2. 真实的规则写入路径 `ProductionOwnerRuleWriter.#writeMemory` 调用 `#writeText`，而 `#writeText` 使用 `classificationWithIdentifiers(text, "private")`。该函数只对证件号、银行卡号、密码/验证码等升到 sensitive，不识别健康、财务主题。因此“心理诊所的邮件一律提醒”“慢性病复诊”这类规则在真实写入路径里仍是 `private`，默认 private 的外部接入仍能看到。测试用手工 SQL 和手工 `sensitive` 记忆绕过了真实写入路径，所以没有覆盖这个缺口。
- 证据：
  - `production-mcp-read.ts:1251-1257`：
    ```ts
    const classification = sourceMemoryId ? classifications.get(sourceMemoryId) : undefined;
    return (
      classification !== undefined &&
      classification !== "restricted" &&
      classificationRank(classification) <= classificationRank(ceiling)
    );
    ```
  - `production-owner-rules.ts:404`：`dataClassification: classificationWithIdentifiers(text, "private"),`
  - `production-owner-rules.ts:430`：`const classification = await this.#writeText(contentRef, input.text);`，`:438` 直接写进记忆。
  - 迁移 0087 `:252-256`：`SELECT ... NULL ... FROM rule_book_rules;`
  - 测试 `mcp-read.test.ts:545-553` 手工把规则出处记忆种成 `sensitive`，不是经真实规则写入器产生。
- 建议：
  - 对 `sourceMemoryId` 为空/读不到的情况采用显式策略（回填迁移、给规则行存独立分类、或按最严格级别处理并告警），不要静默丢弃；至少补一条“旧数据/无出处规则”的期望行为用例。
  - 规则记忆写入时使用与记忆采集/外部提案一致的分级逻辑（健康、财务、敏感主题也升 sensitive），或在规则表存独立分类后按它过滤。
  - 加一条端到端用例：经真实 `ProductionOwnerRuleWriter` 写入健康/财务规则，再以默认 private 调 `rule_book`/`start_here`，确认看不到。

### 3. 低（测试有效性）：工具顺序测试变成“用注册表验注册表”
- 文件：`apps/agent-service/src/production-mcp-read.ts:1501-1503`；`test/integration/mcp-read.test.ts:570-577`；`test/integration/mcp-write.test.ts:501-509`
- 问题：`MCP_READ_TOOL_NAMES` 现在由 `MCP_READ_TOOLS.map(...)` 派生，而注册也使用同一个数组。测试用 `MCP_READ_TOOL_NAMES` 作为期望值，等于用注册表验证注册表；以后重排、改名或改描述，测试会跟着变，不会报失败。ADR 要求对外工具清单/顺序稳定，这个反向保护丢了；描述和 `inputSchema` 也没有快照检查。
- 证据：
  - `production-mcp-read.ts:1501-1503`：
    ```ts
    export const MCP_READ_TOOL_NAMES: readonly string[] = Object.freeze(
      MCP_READ_TOOLS.map(({ name }) => name),
    );
    ```
  - `test/integration/mcp-read.test.ts:576`：`expect(tools.map(({ name }) => name)).toEqual([...MCP_READ_TOOL_NAMES]);`
- 建议：在测试里硬编码期望的工具名和顺序（以及至少一份描述/参数结构快照），不要从 `MCP_READ_TOOLS` 派生；保留该反向用例。

### 4. 低（值契约/错误路径）：登记表不校验工具名，`#record` 却把它当 1-64 字符的决策记录 `reasonCode`
- 文件：`apps/agent-service/src/production-mcp-read.ts:224-241,1193`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:62`
- 问题：`mcpReadToolRegistry` 只校验 `readCeiling.sources`，不校验 `name`；`#record` 直接把 `tool.name` 写进 `reasonCode`。后端要求 `reason_code` 1-64 字符（SQLite CHECK 和入口校验都有），超长读工具名能通过登记，但每次调用都会在写决策记录时失败，工具返回失败。另外，登记只查读工具之间重名，不查与 `MCP_WRITE_TOOL_NAMES` 重名；重复名分支也没有测试。
- 证据：
  - `production-mcp-read.ts:227-239` 只做 `sources` 和 `names` 检查。
  - `production-mcp-read.ts:1193`：`reasonCode: memoryIds ? name : `${name}_failed`,`
  - `sqlite-decision-ledger-operations.ts:62`：`if (!text(write.id, 1, 128) || !text(write.reasonCode, 1, 64))`
- 建议：登记时同时校验 `name` 的长度/字符集，并检查与写工具名不重名；给重复名、超长名各加反向用例。或者 `#record` 对自定义工具名做截断/映射到固定原因码。

### 5. 低（文档一致性）：ADR 0219 仍写着另外三个读工具的上限未做
- 文件：`docs/adr/0219-read-only-mcp-entry-with-static-token.md:69,71,92`
- 问题：第 71 行仍写“`project` 参数和另外三个读工具的上限，在对应的编码任务合并之前仍按本条”，与本次已把四个读工具接上读取上限的代码不一致；第 69/92 行也仍按“无条件列出全部主人规则/设置值”描述，没有提读取上限会隐藏部分规则和参数。
- 建议：按“每个任务合并时在被改的 ADR 上补注”给 0219 加 2026-11-13 补注，或把这些段落改为指向 ADR 0242 的读取上限决定。

## 二、推测与未核实

- `[推测]` 生产库里是否真的存在 `source_memory_id IS NULL` 的 `owner:` 规则：迁移 0087 会把当时旧行置空，但 `ProductionOwnerRuleWriter` 的现有创建路径都写 `sourceMemoryId`。需要查实际数据，未核实。
- `[推测]` 健康/财务规则的实际文本是否都不带凭据：代码只按凭据/证件号升 sensitive；具体是否命中取决于真实规则内容，仓库无法确认。
- `[未核实]` `fromJsonSchema` 是否修改传入的 schema 对象。`start_here`、`today_context`、`rule_book` 现在共用同一个冻结的 `NO_ARGUMENTS`；如果 `fromJsonSchema` 会原地改写，可能造成共享对象污染。依赖未安装，未核实。
- `[未核实]` ADR 0242 第 268 行要求的“对外 MCP 描述不出现在 Himawari 自己发给模型的系统提示/工具定义里”的自动检查，本次 diff 中没有看到；可能在别处已有，未核实。
- `[未核实]` 没有运行测试、类型检查和 `check:prompt-prefix`，因此“这些用例当前确实全绿”未核实；只按代码逻辑判断反向用例应当失败。

## 三、侧重检查

- **错误路径**：登记失败在构造器内抛出（`production-mcp-read.ts:484`），服务起不来，符合 ADR；`declaredSource` 缺源抛错由 `#call` 捕获（`:1262-1268`）；`memoryClassifications` 或 `ownerRules` 抛错会让 `rule_book`/`start_here` 整体失败并记 `*_failed`；`start_here` 的 profile 失败已有真实调用用例（`mcp-read.test.ts:1269-1279`）。
- **不合规范/不可信输入**：对外读工具的输入仍由 MCP `inputSchema` 校验；`find_memories` 的 `auto`/`limit` 处理未变；自定义 `readTools` 来自代码/配置，不是外部请求。
- **安全**：读取上限来自服务端 `admit` 写入的 `authInfo.extra`，不是客户端自报；`#server` 用 `ceilingOf(context.authInfo)` 取值；四个读工具都只通过 `read` 取声明过的数据源，未发现绕过绑定直接读 `sources` 的路径；`context.embedOutsideRun` 只做嵌入，不返回存储内容。发现的安全问题是上面的 version 哈希和规则分级依赖。
- **资源耗尽**：`ownerRuleStore.list` 最多 200 条，`readMany` 上限 1000，提醒扫描上限 200，`start_here` 的 memory id 截到 200；未发现新增无界循环或批量放大。
- **不可撤销操作**：本次改的都是只读工具和规则输出，没有新增写/删/撤销路径。
- **规则文件/文档与代码一致性**：ADR 0242 的 2026-11-13 补注与代码基本一致；ADR 0219 有过期描述，见问题 5。另注意 `ceilingOf` 在 `authInfo.extra` 缺失时回退到 `public`，比文档“默认 private”更严格；正常路由始终由 `admit` 写入 `private`，所以当前不是实际漏洞，但未来若有入口绕过 `admit` 会与文档表述不一致。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   - Himawari 自己的请求：不会。本 diff 没有改系统提示、内部工具定义或历史消息；`MCP_READ_TOOLS` 只用于对外 MCP 服务。
   - 对外 MCP 的四个工具：名称、顺序、描述、`inputSchema` 与改动前逐项对照未变（`start_here`、`find_memories`、`today_context`、`rule_book`，注册顺序相同）。发给外部模型的内容仍是工具结果，属于追加内容；每次请求变化的 `today`/`now`、上限过滤结果都在工具结果里，不在工具定义或系统提示里。
   - 但顺序保护被问题 3 削弱：测试不再能发现注册表重排。
   - 依据：`.claude/rules/prompt-prefix.md` 第 4、10 条。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   - 未发现新增的序列化非确定性。内置规则顺序由 `ruleBookFor` 固定；`ownerRulesWithin` 按 `ruleId` 排序；`today_context` 提醒用多字段排序；`sharedRulesWithin` 保持原规则顺序。
   - 读取上限目前是服务级一个值，但设计上属于请求级；改成按接入取之后，不同接入看到同一内容的子集不同，这是授权差异，不是同一请求内字节不稳定。
   - `start_here` 的 `version` 会因“没列出的条数”变化而变，这是本次有意修复。
   - 遮盖函数本身未改；但 `profile.version` 的跨段哈希问题见问题 1。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：四个工具的上限正反用例、登记缺/空/未知数据源的失败用例、新工具只能读声明数据源的用例、内置规则声明参数的用例、`start_here` 版本号/概况失败/跨段遮盖的真实调用用例。
   - 按代码逻辑，去掉版本号里的 omitted 计数、把整段遮盖改成逐段遮盖、让各工具忽略 ceiling，对应用例都会失败。
   - 弱点：工具顺序测试循环自证（问题 3）；重复名分支没有测试；真实规则写入器的分级路径被手工种数据绕过（问题 2）；跨段 version 哈希没有断言（问题 1）；ADR 0242 第 268 条要求的描述隔离检查未在本次 diff 中看到。未运行测试，无法确认当前全绿。

4. **每个新值/字段/配置键，使用它的地方都能接受吗？**
   - `readCeiling.sources`：产生于 `MCP_READ_TOOLS`，由 `MCP_READ_SOURCE_NAMES` 校验，`#reader` 按声明取出；两端一致。未校验工具名与决策记录 `reasonCode` 的 1-64 字符约束，见问题 4。
   - `RuleRecord.sharedParameters`：产生于 `rule-book.ts` 的内置规则，消费于 `sharedRulesWithin`；分级和值均按预期使用。没有运行时校验 `values` 形状或 `classification` 合法性，但这些来自内部代码，风险低。
   - `memoryClassifications`：生产端键是 `ProductMemoryRecord.id`，消费端是 `sourceMemoryId`；测试和 `service-main` 都把前者按 `sourceMemoryId` 查，字符串表示一致（`createMemoryId` 只是品牌化，不加前缀）。找不到时当前实现是隐藏规则，见问题 2。
   - `READ_CEILING_KEY = "readCeiling"`：`admit` 写入，`ceilingOf` 读取，字面量一致；缺失时回退 `public`，是 fail-closed，但与“默认 private”的文档表述略有出入。
   - `MCP_READ_DEFAULT_CEILING`：替代 `START_HERE_DEFAULT_CEILING`，未发现仍有旧常量的消费者。
   - `MCP_READ_TOOL_NAMES`：类型从字面量元组变为 `readonly string[]`，测试消费者能接受；但测试因此失去独立期望值，见问题 3。
   - `source_memory_id = NULL`：生产端允许，消费端 `ownerRulesWithin` 直接丢弃；迁移会造出这类旧行，见问题 2。
   - ADR 0219 的旧描述与代码不一致，见问题 5。
