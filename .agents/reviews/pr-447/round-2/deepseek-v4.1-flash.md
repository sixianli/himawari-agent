## 作者说法逐条核对

1. **正确。** `production-mcp-memory-writer.ts:92-99` 的 `proposalClassification` 确实按 `MEMORY_SENSITIVE_CATEGORY_NAMES`（`packages/gateway-contracts/src/contracts-v2.ts:1197` 的 `["health", "finance"]`）直接判 sensitive，否则调用 `classificationWithIdentifiers(text, "private")`。
2. **不完整，不是“三处”。** 文档列的三处确实存在且当前一致：`production-mcp-memory-writer.ts:46-56`、`packages/persistence-sqlite/src/data-export/schemas.ts:153-163`、迁移 `0093_external_memory_proposals.sql:11-16`。但 `packages/gateway-contracts/src/contracts-v2.ts:1185-1201` 还有一份 `MEMORY_CATEGORY_NAMES` 和派生的 `MEMORY_EXTERNAL_CATEGORY_NAMES`，并且 `:1588` 的 `externalProposals` 快照就是用后者校验的。所以“三处”不是完整清单。
3. **正确。** `rule-types.ts:43-51` 的 `RuleTypeDefinition.parse` 返回 `MailMatchParameters`；`:224-231` 的 `writableRuleType` 在 `tests` 为空时抛 `RULE_TYPE_UNTESTED`。
4. **正确。** `production-mcp-read.ts:765-767` 确实是 `preview.type === "mail_must_notify" ? MCP_PROPOSE_RULE_KIND_NOTIFY.text : MCP_PROPOSE_RULE_KIND_WHOLE_THREAD.text`。
5. **正确。** `ruleParameters` 只认 `quiet_hours`、`floor_important_sender`（`production-mcp-read.ts:324-327`）；这两条来自 `rule-book.ts:489-498` 的 `ruleBookFor`；`RuleRecord`（`rule-book.ts:23-33`）没有“对外给哪些参数”的字段。
6. **大体正确，但“每次 propose_rule 都会调”过于绝对。** 参数不合法、类型不在 `EXTERNAL_RULE_TYPES`、客户端不支持 elicitation、以及第二次带答案的调用，都不会走到 `rules.preview`（`production-mcp-read.ts:665-673`、`:680-681`、`:726-732`、`:752`）。`#replay` 在没有配置或抛错时返回 `null`（`production-owner-rules.ts:478-485`），也不保证一定试算。默认 30 天这一点是对的（`strict-configuration.ts:1171`）。

---

## 发现的问题（按严重度）

### 高：自动筛与“确认前不调模型、不进任何请求”的既有决定正面冲突

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140`、`:247`；`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:63`、`:80`；`docs/adr/0246-external-proposals-join-the-data-export-and-web.md:89`
- 问题：新增的“收到就自动筛”必须读待确认表并把正文发给模型，但 0228 明确说这张表没有任何组装发给模型内容的代码读它、写入路径不调模型；0246 明确说待确认提议不进任何发给模型的请求；0242 自己的后果一边说“请求不变”“不进任何请求”，一边又承认新增两处后台模型调用。没有同日补注取代这些句子，实施者会拿到互相矛盾的规则，而且这是敏感内容在主人确认前进入模型的隐私边界变化。
- 证据：
  - `0242:140`：“每批推来的内容存好之后，Himawari 自己用模型筛一遍”
  - `0228:63`：“这张表只有 MCP 写工具和记忆页的确认操作读写，没有任何组装发给模型内容的代码读它。”
  - `0228:80`：“只做校验、分级、加密、写表，不调模型、不算向量”
  - `0246:89`：“待确认的提议不进任何发给模型的请求，本 ADR 不改模型请求。”
  - `0242:247`：“Himawari 自己发给模型的请求不变……待确认的内容和项目笔记不进 Himawari 自己的任何请求……‘先筛一遍’和‘解析贴回的文本’是两处新的后台模型调用”
- 建议：在 0228 决定 1/3、0246 后果、0242 后果分别加同日补注，明确自动筛是独立后台调用，不是对话请求；写清它读哪些字段、按什么分级路由、是否遮盖、允许哪些模型、失败如何计费和重试；把 0242 的“请求不变”改成“对话请求不变，新增独立后台调用”；补一条“待确认正文不出现在对话请求”的自动检查。

### 高：类别清单“三处”漏掉 web/gateway 的第四处，重复 I-73

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:105`、`:266`；`packages/gateway-contracts/src/contracts-v2.ts:1185-1201`、`:1588`；`packages/application/src/ports/memory-projection.ts:13-24`；`packages/persistence-sqlite/src/data-export/schemas.ts:153-163`；`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:11-16`
- 问题：文档说“这份清单现在有三处各写了一遍”，并计划只检查三处。但 gateway-contracts 还有独立的 `MEMORY_CATEGORY_NAMES` 和 `MEMORY_EXTERNAL_CATEGORY_NAMES`，待确认快照的 `category` 就是用后者校验的。只让 MCP 写入端、导出 schema、迁移 CHECK 三处一致，网页读快照仍可能拒绝或丢失新类别；这正是“清单里的 id 能通过写入端、却过不了读取端校验”的 I-73 模式。
- 证据：
  - `0242:105`：“这份清单现在有三处各写了一遍”
  - `contracts-v2.ts:1185`：`export const MEMORY_CATEGORY_NAMES = [`
  - `contracts-v2.ts:1198`：`export const MEMORY_EXTERNAL_CATEGORY_NAMES = MEMORY_CATEGORY_NAMES.filter(`
  - `contracts-v2.ts:1588`：`category: enumeration(MEMORY_EXTERNAL_CATEGORY_NAMES),`
- 建议：把 `MEMORY_EXTERNAL_CATEGORY_NAMES` 作为唯一外部类别清单（或让它从 `MEMORY_CATEGORIES` 派生），检查改成“所有清单和 CHECK 都恰好等于它”，把 `contracts-v2.ts` 纳入。注意迁移 0093 是历史文件，未来加类别不能靠改它；检查要读当前迁移链/建表结果，而不是只 grep 0093。

### 高：项目名凭据识别有绕过，旧测试和新测试还互相冲突

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:133`、`:259`、`:265`
- 问题：文档只把“以 `协议://` 开头”或“`用户@主机:路径` 且整段没有空白”当远程地址。以下写法能混过去：`//user:token@host/path`（协议相对 URL，不以 `协议://` 开头）、`HTTPS://user:token@host/path`（大小写）、`https:\\user:token@host\path`（反斜杠）、`host/path?token=...`（不带 scheme 的查询令牌）、前后带空白的 URL（“整段没有空白”被破坏）。反过来，普通名字里同时有 `@` 和 `:` 且没有空白时又可能被误判成远程地址。更直接的是测试清单自相矛盾：`0242:259` 说“项目名带用户名、密码、令牌、查询参数或 `#` 后面的部分，都被拒绝”，`:265` 又说普通名字带 `?`、`#`、`@`、`:` 照常收。
- 证据：
  - `0242:133`：“只管长得像远程地址的名字：以 `协议://` 开头的，或者 `用户@主机:路径` 这种写法、整段没有空白的……别的名字里的 `?`、`#`、`@`、`:` 都是普通字符”
  - `0242:259`：“项目名带用户名、密码、令牌、查询参数或 `#` 后面的部分，都被拒绝。”
  - `0242:265`：“项目名不是仓库地址的一批（中文、带空格、带 `?`、`#`、`@`、`:`）照常收”
- 建议：先做 `trim`、NFC、scheme 小写；只要含 `://`、以 `//` 开头、或匹配 `^[^@\s]+@[^:\s]+:`，就交给标准 URL 解析（scp 形式可加 dummy scheme），检查 userinfo、query、fragment；对不带 scheme 但形如 `host/path?query` 的也要么处理、要么明确不当作地址。把 `0242:259` 改成“远程地址形式且仍带凭据/查询/`#` 才拒绝”，并补上述每种写法的反向用例。

### 中：自动筛按批触发，没有按接入限频/去重，Andy 实例又没有统一费用上限

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140`、`:205`、`:125`；`docs/adr/0234-one-program-per-person-database-file.md:76`、`:81`；`docs/adr/0076-no-model-cost-budget-limits.md:92`
- 问题：文档给 `propose_rule` 加了按接入限频，理由是“每次提议都会用近 30 天的邮件试算一遍”；但记忆推送的自动筛没有同样的限频。对方可以用同一稳定编号反复推新内容（每次 superseded 都触发新批次），或反复推不同内容，让 Himawari 反复调用模型。文档说“产品里统一的花费上限照常管着它们”，但 ADR 0234 写明 Andy 本人默认不设上限，ADR 0076 也写明产品内不设累计总额上限，只记账。这构成资源耗尽/钱包耗尽路径。
- 证据：
  - `0242:140`：“每批推来的内容存好之后，Himawari 自己用模型筛一遍”
  - `0242:205`：“本 ADR 不给它们另设花费门槛；产品里统一的花费上限照常管着它们”
  - `0234:76`：“Andy 本人默认不设上限。”
  - `0076:92`：“Andy 本人仍默认不设上限，产品内仍不设累计总额上限”
- 建议：自动筛也按接入限频/配额；只对新增或内容变化的条目筛，被 superseded 的批次取消或合并；给每批/每条设模型调用上限；把筛的次数、跳过、失败、限频拒绝记进决定 13 的指标；补“反复推同一批只筛一次/超额度被拒”的反向用例。

### 中：自动筛的结果没有指定存储、导出和网关契约，新增字段会撞 0228/0246 的已定格式

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140`、`:247`；`docs/adr/0246-external-proposals-join-the-data-export-and-web.md:55-59`、`:62`；`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql`；`packages/gateway-contracts/src/contracts-v2.ts:1582-1602`
- 问题：“待确认页面打开就是筛好、排好的”意味着建议要持久化。但 0228 的表没有建议列，0246 的导出 v3 字段固定，待确认快照 `externalProposals.items` 的字段也固定。文档没写建议存哪、是否进导出、导出格式是否升级、快照契约怎么变。若加进待确认表，需要新迁移并影响导出 v3/网关契约；若不持久化，则“打开就是筛好”不成立。
- 证据：
  - `0246:57`：导出的字段是固定的 `id、subjectRef、client、sourceKey、textSha256、normalization、category、classification、status、receivedAt、decidedAt、batchId、memoryId、supersededBy` 加 `content`、`keys`、`unkeyedClients`
  - `contracts-v2.ts:1586-1592`：快照 items 只有 `proposalId`、`text`、`category`、`dataClassification`、`client`、`receivedAt`
- 建议：明确建议的存储位置（新表/新列）、是否进入导出（要进就升 v4 或加可选字段并写清旧文件拒绝规则）、快照契约字段、失败/过期清理；给存储、导出、快照三处各列一条消费端用例。

### 中：自动筛的提示词数据没有固定排序和序列化要求，可能违反规则第 10 条

- 文件：`.claude/rules/prompt-prefix.md` 第 10 条；`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:205`
- 问题：规则第 10 条要求“同样的内容，每次都要序列化成同样的字节”，列表、JSON 键顺序都要固定。新补注只说“固定的指令在前、这次的数据在后”，没有说待确认条目、已有记忆、“重复或矛盾”候选按什么稳定键排序，也没说 JSON 键顺序固定。自动筛还要把“已有记忆”作为数据，数据库返回顺序或对象遍历顺序会让同一批内容序列化成不同字节。
- 证据：
  - `.claude/rules/prompt-prefix.md` 第 10 条：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定，不能依赖对象遍历顺序或数据库返回顺序。”
  - `0242:205`：“这两处是后台调用，固定的指令在前、这次的数据在后。”
- 建议：写明按稳定键排序（例如“接入编号 + 项目编号 + 稳定编号”“记忆编号”），JSON 键顺序固定，时间只放最后且只放一次；补一条“同一批数据两次构造提示词，字节相同”的用例。

### 低：“每次 propose_rule 都会调 rules.preview”不准确

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:125`；`apps/agent-service/src/production-mcp-read.ts:665-673`、`:680-681`、`:726-732`、`:752`；`apps/agent-service/src/production-owner-rules.ts:478-485`
- 问题：参数不合法、类型不在 `EXTERNAL_RULE_TYPES`、客户端不支持 elicitation、第二次带答案的调用都不会走 preview；`#replay` 没有配置或抛错时返回 `null`，也不是“一定在近 30 天邮件上试算”。限频理由仍成立（每次有效提议的第一次调用会试算），但措辞应改成“每次进入确认框的提议”或“每次有效提议”。
- 证据：
  - `production-mcp-read.ts:665-666`：`} catch { return proposalReply(MCP_PROPOSE_RULE_INVALID.text, true);`
  - `production-mcp-read.ts:680-681`：`if (!elicitationSupported(context.mcpReq.envelope)) return ...`
  - `production-mcp-read.ts:726-732`：`if (outcome === "accepted") { await rules.accept(proposal); ...`
  - `production-owner-rules.ts:479-480`：`if (!this.#options.replay) return null;`
- 建议：改措辞；测试按“第一次有效调用触发一次 replay、第二次回答不重复触发、无效参数/不支持 elicitation 不触发”写。

### 低：ADR 0226 的决定 1、2 仍写“两种之一/两种做法”，新补注只加在决定 3 下

- 文件：`docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:54`、`:56`、`:62`
- 问题：新补注说以后可以由类型自己声明“外部可提”，但决定 1 仍写 `type（前提 1 的两种之一）`，决定 2 仍写确认框只展示“一定提醒并推送，或先读完整个邮件串”。读者会认为只能有两种类型、确认文字只能两套。
- 证据：
  - `0226:54`：“`type`（前提 1 的两种之一）”
  - `0226:56`：“做法（一定提醒并推送，或先读完整个邮件串）”
  - `0226:62`：“以后能提哪些，由每种规则类型自己声明是否‘外部可提’”
- 建议：在决定 1、2 各加一条同日补注，指向 ADR 0242 决定 7 的补注，说明新类型的参数说明和确认文字由类型声明生成，现有两种保持原样。

### 低：“原样存”与“统一成 NFC 写法”措辞冲突

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:104` 与 `:133`
- 问题：`:104` 说项目名“统一成 NFC 写法”，`:133` 说普通名字“原样存、原样比，不拆开、不改写”。NFC 规范化会改写字节。应明确“除 NFC 统一写法外原样”。
- 建议：改措辞；用 NFC/非 NFC 等价串补一条“落到同一项目编号”的用例。

### 低：规则提议的用量/限频没有加到决定 13 的指标清单

- 文件：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:125`、`:164-165`
- 问题：文档说“用量在页面上看得见（决定 13）”，但决定 13 只列了读、推、自动/模型调用、失败等，没有规则提议次数和限频拒绝次数；测试只测“超过频率额度被拒”，没有页面数字的正反向用例。
- 建议：在决定 13 加规则提议次数、限频拒绝次数，各配正向/反向用例。

---

## 读代码证实的 / 推测的

### 读代码证实

- 本次改动只涉及 `docs/adr/0226`、`docs/adr/0242` 和 `.agents/reviews/pr-447`，没有代码改动（`git diff --name-status`）。
- `proposalClassification`、`EXTERNAL_PROPOSAL_CATEGORIES`、`MEMORY_CATEGORIES`、三处现有类别清单、迁移 0093 的 CHECK，以及 `contracts-v2.ts` 的第四份类别清单，均已核对。
- `RuleTypeDefinition.parse` 返回 `MailMatchParameters`，`writableRuleType` 用 `RULE_TYPE_UNTESTED` 拒绝无测试类型，已核对。
- `production-mcp-read.ts` 的 `preview.type` 三元表达式、五个邮件字段、`ruleParameters` 的两处 ID 判断、`#startHere` 只取 summary，已核对。
- `ruleBookFor` 和 `RuleRecord` 没有对外参数字段，已核对。
- `rules.preview` → `#replay` → `options.replay` → `proactive.replayRule` → `ruleReplayDays`（默认 30）这条链存在；但不是每次 `propose_rule` 都走，且 `#replay` 可返回 `null`。
- 现有 `bearer-admission` 的 30 次/分钟是每个 `BearerGate` 实例的全局窗口，不是按接入分别限频。

### 推测或未核实

- 项目名凭据识别的绕过写法（协议相对 URL、大小写 scheme、反斜杠、无 scheme 查询令牌）尚未实现，属于按文档文字推出的风险。
- 自动筛的反复触发能否被现有系统挡住，取决于任务 B/C 尚未实现的限频和模型路由；未核实。
- 自动筛结果若持久化，具体会撞哪些导出/契约字段，取决于实现选择；按现有 0228/0246 结构推出需要改。
- 自动筛模型能否接收 sensitive 内容、是否需要遮盖、走哪条路由，文档只说“模型走现有的路由”，未写清；未核实。

---

## 侧重检查

- **错误路径**：文档写了“筛失败不影响已存内容，只是没有建议”，这是对的；但没有写失败后的重试、旧建议失效、是否重复计费。`#replay` 抛错被吞成 `null`（`production-owner-rules.ts:478-485`），确认框会显示“算不出来”，可接受，但自动筛的失败路径还没有同等明确。
- **不合规范/不可信输入**：类别值目前写入端会校验（`production-mcp-memory-writer.ts:181`、`production-mcp-read.ts:815-824`），规则参数校验较完整；项目名是新输入面，凭据识别有绕过；粘贴回来的存量文本是外部 agent 写的、不可信，文档没有写“当数据不当指令”、长度截断和注入防护。
- **安全**：待确认的敏感内容在主人确认前发给模型，分级、遮盖、模型白名单都没有写；项目名里的凭据可能被换个写法保留下来。这两条需要补设计。
- **资源耗尽**：规则提议已经加按接入限频；记忆自动筛没有对应的按接入限频或去重，且 Andy 实例默认没有统一费用上限，存在被反复推送刷模型调用的路径。
- **不可撤销的操作**：本次改动没有新增删除、覆盖或对外副作用；自动筛和贴回解析都只产生建议/待确认。项目改名、合并没有被本次改动影响。
- **规则/文档/代码一致**：发现 0228、0246、0242 之间关于“确认前不进模型”的冲突；0226 决定 1/2 仍写死两种类型；类别清单不止三处；测试清单 259 与 265 冲突；NFC 与“原样存”措辞冲突。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**现有对话不会。** 本次只改文档；计划中的 Himawari 自己的新能力（自动筛、贴回解析）是独立后台调用，文档也写了“固定的指令在前、这次的数据在后”，不碰已有对话的系统提示、工具定义和历史。外部 agent 那边会变一次：`propose_rule`/`sync_memories` 的工具定义随规则类型登记表和工具集合变化，文档已承认“变的是外部 agent 那边的请求开头，不是 Himawari 自己的”。

但文档的内部说法要修：`0242:247` 同时写“Himawari 自己发给模型的请求不变”和“两处新的后台模型调用”，严格说“请求不变”是错的，应改成“对话请求不变；新增独立后台调用”。另外“待确认的内容……不进 Himawari 自己的任何请求”与自动筛直接矛盾，必须改成“不进对话请求，只进按分级路由的独立后台调用”。每轮会变的值（待确认内容、已有记忆）应全部放在数据段末尾，且列表顺序固定。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**现有对话路径不会。** 新后台调用有风险：文档没有要求待确认条目、已有记忆、重复/矛盾候选按稳定键排序，也没有要求 JSON 键顺序固定；这违反 `.claude/rules/prompt-prefix.md` 第 10 条“同样内容每次同样字节”。项目名还有 NFC 规范化和“原样存”的措辞冲突；同一远程地址的不同写法（大小写 scheme、协议相对、反斜杠）可能被当成不同名字，或一个被拒绝、一个被接受。建议在文档里补“按稳定键排序、JSON 键顺序固定、时间只放最后、先 trim + NFC + scheme 小写”，并补字节相同的用例。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**本 PR 没有代码改动，也没有新增可运行的自动检查。** 文档新增的检查是任务 B/C 的未来项，尚未实现，无法验证“反向用例会失败”。按当前写法，至少有几条不够：

- “三处类别清单不一致时检查失败”漏掉 `contracts-v2.ts` 的第四份清单，第四份漂移时它不会失败。
- 项目名反向用例只覆盖 `协议://用户:令牌@主机/路径`，协议相对 URL、大小写 scheme、反斜杠、无 scheme 查询令牌都不会让它失败。
- `0242:259` 与 `0242:265` 的测试要求互相冲突，真正实现时必有一条无法通过。
- “外部可提”的逐类型断言方向是对的，但还要断言参数说明和确认文字确实来自类型声明，而不只是“接受”。
- 自动筛没有对应的提示词顺序/字节稳定、敏感分级、失败不丢内容、不触发重复模型调用的用例。

### 4. 每个值两端校验是否都能接受？

- **类别值**：当前三处现有清单和 `MEMORY_CATEGORIES` 去掉 `rule` 一致，但读取端还有 `contracts-v2.ts` 的 `MEMORY_EXTERNAL_CATEGORY_NAMES`。只改三处或只检查三处，会出现“写入端接受、网页快照/读取端拒绝”的 I-73 问题。
- **规则类型**：现有 `EXTERNAL_RULE_TYPES` 的两个值都能过 `parseOwnerRuleParameters`/`ruleType`；未来声明“外部可提”的新类型必须同时过 `writableRuleType`、`parse`、对外 schema 和确认文字生成。文档的逐类型断言方向正确，但 ADR 0226 决定 1/2 仍写死两种，需补注。
- **项目名**：产生端是助手程序规范化，消费端是服务端校验、项目表、`find_memories` 按名查找、页面改名/合并。凭据识别有绕过；旧测试 259 与新测试 265 冲突；NFC 与“原样存”冲突。这些都要在两端统一后再写用例。
- **`rule_book` 参数**：`RuleRecord` 现在没有对外参数字段，`ruleBookFor` 只返回内置规则；加字段会影响所有 `RuleRecord` 构造点（包括 `ownerRuleRecord`）。可以按文档给 `ruleBookFor` 的条目加声明，但更小的方案是单独的“内置规则对外参数声明表”，不污染 `RuleRecord`；无论哪种，都要核对 `ruleParameters` 之外还有没有消费者。
- **自动筛建议**：这是新产生的值，但文档没有定义存储、导出、网关快照字段；按现有 0228/0246 结构，直接加字段会漏掉导出 v3 和网页契约。
- **限频用量**：文档说“用量在页面上看得见”，但决定 13 没有规则提议次数/限频拒绝字段，需补指标和正反向用例。
