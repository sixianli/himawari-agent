## 结论

本轮增量（`5858f0ca..ca818760`）的版本哈希修复方向正确：从代码看，`start_here` 的 `version` 已不再直接对未遮盖的 `requirements`/`sections` 做哈希，因此“今天”段点名的验证码不会再通过版本哈希泄露。名字正则的边界也正确：最长 57 字符，加 `_failed` 正好 64，能通过决策记录校验。

主要问题不在本增量本身，而在本轮新增的读上限过滤的有效性：主人规则的“分级”依赖出处记忆，而写入端对出处记忆的分级只认受限证件号和凭据，敏感主题本身不会被标成 `sensitive`；集成测试又手工把出处记忆设成 `sensitive`，绕过了真实写入端。

## 问题（按严重度）

### 中：主人规则的读上限过滤对“敏感主题但无凭据/证件号”的规则实际失效，测试夹具掩盖了这条路径

- 位置：
  - `apps/agent-service/src/production-owner-rules.ts:396-411`、`520-525`、`609-614`
  - `packages/sensitive-capture/src/identifiers.ts:20-27`
  - `apps/agent-service/src/production-mcp-read.ts:1246-1269`
  - `test/integration/mcp-read.test.ts:227-229`、`544-552`
- 问题：新过滤只用规则出处记忆的 `dataClassification`。写入端把来源文本交给 `classificationWithIdentifiers(text, "private")`，而该函数只把“受限证件号或密码/验证码/机器密钥”升到 `sensitive`。规则的来源文本是 `quote + summary`，不包含 `params`；像“心理诊所的邮件一律提醒”不含证件号/凭据，会被归为 `private`。默认 `private` 的外部读工具仍会通过 `rule_book`/`start_here` 读到它。测试里 `owner:clinic` 的出处记忆被直接 seed 成 `sensitive`，没有经过真实写入端，所以测不到这个差距。
- 证据：
  - `production-owner-rules.ts:404`：`dataClassification: classificationWithIdentifiers(text, "private"),`
  - `identifiers.ts:24-27`：只有 `containsRestrictedIdentifier(text) || containsCredential(text)` 才返回 `"sensitive"`。
  - `production-mcp-read.ts:1259-1266`：`classification !== undefined && ... classificationRank(classification) <= classificationRank(ceiling)` 才保留。
  - `mcp-read.test.ts:227-229`：`ruleSources.push([sourceMemoryId, ruleId === "owner:clinic" ? "sensitive" : "private"])`，随后 `544-552` 直接按这个分类 seed 记忆。
- 建议：在写入端把完整规则（至少包含 `summary` 的敏感主题判断，必要时包含 `params` 或显式分级）纳入分级，或给 owner rule 存一份显式的对外分级；测试应使用真实 `ProductionOwnerRuleWriter` 创建一条敏感主题规则，再断言默认 `private` 读不到。若暂不做，至少在 ADR/说明里明确“按出处记忆分级”目前只对凭据/证件号类内容有效，不要用夹具制造已覆盖的假象。
- 性质：读代码证实（分级函数、过滤逻辑、测试夹具均确认）；“某条具体规则会泄露”是代码推断，未跑真实写入端到读取端的端到端复现。

### 低：`sharedParameters.values` 在 `rule_book` 中最后展开，可以覆盖规则的身份字段

- 位置：`apps/agent-service/src/production-mcp-read.ts:1456-1465`，`1227-1238`
- 问题：`rule_book` 输出先写 `id/revision/gate/outcome/origin/source/status`，最后 `...parameters`。`parameters` 来自 `RuleRecord.sharedParameters.values`，类型是 `Readonly<Record<string, unknown>>`。当前两条内置规则只给 `importantSenders`/`quietHours`，没有问题；但未来任何规则源只要给出 `values: { id: ... }` 就能覆盖规则身份，且不会被校验。
- 证据：`production-mcp-read.ts:1456-1464`：
  ```ts
  id: rule.id,
  revision: rule.revision,
  ...
  status: rule.status,
  ...parameters,
  ```
- 建议：把 `...parameters` 放到固定字段之前，或显式拒绝/剔除保留键（`id`、`revision`、`gate`、`outcome`、`origin`、`source`、`status`）。
- 性质：读代码证实；实际利用需要内部规则源给出恶意/错误字段，未发现当前规则如此。

### 低：读工具失败原因码可能与另一个读工具的成功原因码重名

- 位置：`apps/agent-service/src/production-mcp-read.ts:244-246`、`1198`
- 问题：登记表只排除了“与已有读工具名重名”和“与写工具名重名”，没有排除 `${name}_failed`。例如同时登记 `peek` 和 `peek_failed` 都合法，`peek` 失败记录的原因码就是 `peek_failed`，与 `peek_failed` 的成功记录相同。消费端目前没有发现依赖 reasonCode 唯一性，但统计和排查会混淆。
- 证据：
  ```ts
  if (names.has(entry.name) || (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(entry.name))
    throw new Error(`MCP_READ_TOOL_DUPLICATE:${entry.name}`);
  ...
  reasonCode: memoryIds ? name : `${name}${MCP_READ_FAILED_SUFFIX}`,
  ```
- 建议：登记时同时保留/检查派生失败名，或把 reasonCode 加命名空间（例如 `read:${name}` / `read:${name}:failed`）。
- 性质：读代码证实；影响程度是推断，未找到会破坏功能的消费端。

### 低（说法与代码不完全一致）：版本哈希与最终输出的遮盖范围并非“完全同一次”

- 位置：`apps/agent-service/src/production-mcp-read.ts:1417-1427`，`#call` 的 `maskForExternalRead(outcome.output)`
- 问题：版本哈希传给遮盖的是 `[requirements, sections, rules, today.output]`；最终输出遮盖的是整个 `outcome.output`，其中还包括 `profile.version` 和 `profile.omitted`。不过后者是 12 位十六进制哈希和“还有 N 条”的固定文字，不会产生新的点名敏感值，所以我没有找到因此泄露的路径。作者说“和最终输出同一次遮盖的范围”不严谨。
- 证据：`1417-1422` 的数组只有四项；最终输出对象还包括 `profile.version` 和 `omitted`。
- 建议：要么把说明改成“与最终输出覆盖同样的资料字段”，要么在实现上从最终遮盖后的 `profile` 对象直接取字段计算版本，消除两处范围差异。
- 性质：读代码证实范围不同；“无泄露”是基于 `profile.version`/`profile.omitted` 内容的推断。

## 读代码证实的 / 推测的

- 读代码证实：
  - 版本哈希输入已改为遮盖后的 `requirements`/`sections`，且遮盖批次包含 `today.output`。
  - `_failed` 长度为 7，名字上限 57，决策记录 reasonCode 校验为 1–64 字符，边界匹配。
  - 读工具名正则 `^[a-z][a-z0-9_]{0,56}$` 与测试的 57/58 字符用例一致。
  - 主人规则过滤只使用出处记忆的 `dataClassification`。
  - 出处记忆的分类由 `classificationWithIdentifiers` 生成，只识别受限证件号和凭据。
  - `sharedParameters.values` 在 `rule_book` 中最后展开。
  - 现有“今日段变化、资料段不变时 version 不变”的用例在 `mcp-read.test.ts:1158-1172`，确实存在。
- 推测/未核实：
  - 我没有启动服务或运行测试，因此没有端到端证明“心理诊所”这类真实规则在默认 `private` 下会被读出；结论是基于分级函数和写入路径的代码推断。
  - reasonCode 重名对统计/校准的实际影响未找到具体消费端证据。
  - `sharedParameters.values` 覆盖身份字段目前没有实际规则触发。

## 侧重检查

- 错误路径：`start_here`/`rule_book` 在出处记忆分类读取失败时会整体失败并返回通用错误，不泄露内容；决策记录写入失败会撤回工具结果（现有逻辑）；无效读工具名在服务启动/构造时拒绝。均未发现新增的静默泄露。
- 不合规范或不可信输入：读工具名只能来自内部配置，不是外部请求输入；正则边界正确，且排除了写工具重名。外部 MCP 参数校验未在本增量改动。
- 安全与读上限：`ceilingOf` 对缺失/非法值退回 `public`，属于 fail-closed；`recallOutsideRun` 的正常模型调用路径（`ceiling === undefined`）与旧 `isModelVisible` 等价，不影响模型召回。主要安全缺口是上面的 owner rule 分级链路。
- 资源耗尽：owner rule 列表上限 200，`readMany` 上限 1000，规则摘要受 1200 字符预算约束，profile/today 输出有既有预算；版本计算多跑一次遮盖，输入规模有界，没有新增无界循环。
- 不可撤销操作：本增量没有新增写操作或不可撤销命令。
- 规则/文档与代码一致性：ADR 0219 的两条 2026-11-13 注与代码基本一致；ADR 0242 关于四个读工具和 `sharedParameters` 的描述与代码一致。不一致点主要是作者对“遮盖范围完全相同”的表述，以及主人规则分级测试绕过真实写入端。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 PR 改的是外部 MCP 读入口、规则手册输出和外部召回路径；没有改 Himawari 自己发给模型的系统提示、工具定义、历史消息或模型出口遮盖。`recallOutsideRun` 只被 MCP 源调用，普通 `#recall` 在 `ceiling === undefined` 时仍使用原来的 `modelVisibleClassifications()` 行为。`ruleBookFor` 的两个消费者（`proactive-overview`、`proactive-mail-check-service`）都只把它们用于规则判定，不拼进模型提示。因此发给模型的内容仍然是只在末尾追加；每轮变化的 `start_here` 内容属于外部 MCP 响应，不是 Himawari 模型请求的历史前缀。外部 agent 若把 `start_here` 当作自己的提示前缀，则 `version` 在 `profile` 段内、`today` 在最后，但这不属于本仓库的模型请求。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   遮盖函数本身是确定的：`maskSensitiveTexts` 会把占位符里的序号去掉，且同批无关文字不会改变某段文字的字节（`packages/sensitive-capture/test/redaction.unit.test.ts:380-384`）。新增的版本哈希也使用这份去掉序号的遮盖结果，所以不会再哈希原始秘密。需要注意：同一段 profile 文字仍可能因为“今天”段是否点名同一个值而一处是原文、一处是 `[验证码]`；这是 ADR 0219 已有的“一次返回整体遮盖”设计，不是本增量新引入的不确定性。版本哈希会随这种遮盖结果变化，但最终输出也同步变化。没有引入无序集合；读工具顺序固定，owner rule 按 `ruleId` 排序。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`mcp-read.test.ts:1307-1322` 覆盖“今天点名验证码时换号码版本不变”和“没点名时版本随号码变”；前者在旧实现（只遮 profile，不含 today）会失败，后者在版本被写成常量时会失败。`1077-1096` 覆盖读工具重名、与写工具重名、58 字符、空格名和 57 字符正向。反向用例在没有新校验时会让 `setup` 成功，因此测试会失败。缺口：57 字符正向用例只调用了 `listTools`，没有真正调用这个长名工具并写一条 `_failed` 决策记录；虽然我核对了决策记录上限是 64，但这条边界没有端到端用例。另：主人规则敏感主题的反向用例使用手工 seed 的 `sensitive` 出处，没有经过真实写入端，不能证明实际链路。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - 读工具名：用于 MCP `registerTool`/`listTools` 和决策记录 `reasonCode`。名字最长 57，加 `_failed` 为 64；`sqlite-decision-ledger-operations.ts:62` 校验 1–64，`contracts-v2.ts:1341` 和 data export 也接受 64。可以接受。唯一边界是派生失败名没有查重。
   - `readCeiling`：`admit` 写进 `authInfo.extra`，`ceilingOf` 只接受 `public/private/sensitive`，否则退回 `public`；默认值 `MCP_READ_DEFAULT_CEILING = "private"`。可以接受。
   - `sharedParameters`：`rule_book` 直接展开 `values`，当前 `importantSenders`/`quietHours` 与 ADR 0219 的预期一致；但最后展开允许覆盖规则身份字段，见上面的低severity问题。
   - `profile.version`：只出现在 `start_here` 输出和测试里，12 位十六进制，没有其他消费者依赖旧算法。可以接受。
   - `MCP_READ_TOOL_NAMES`：改为从 `MCP_READ_TOOLS` 派生，仓库内已无消费者，属于保留导出；不影响生产。
   - ADR 0219 的两条新注与代码一致：主人规则按出处记忆分级过滤，出处找不到不给；内置规则按 `sharedParameters.classification` 决定是否带参数。它们没有覆盖“出处记忆的分级只识别凭据/证件号”这一限制。
