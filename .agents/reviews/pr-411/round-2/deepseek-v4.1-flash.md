## 侧重检查

我先按你给的侧重方向查了这些路径：

- **错误路径**：`production-mcp-read.ts:826-848` 的 `#call` 在遮盖、工具执行或决策记录写入抛错时，`delivered` 保持 `undefined`，只回 `MCP_TOOL_RESULT_FAILED.text`，不会把未遮盖内容发出去。这一条是失败关闭的，现有实现没问题。
- **不可信输入**：稳定编号、项目名、远程地址里的凭据、控制字符/不可见字符。ADR 只写“带控制字符的拒绝”，但现有代码处理的是 `\p{Cc}\p{Cf}\p{Cs}` 和 U+2028/U+2029，规范比代码窄。见发现 4。
- **安全**：密钥放 URL 路径。内部 Fastify 是 `logger: false`（`packages/platform-node/src/http-gateway-server.ts:802`），但 Cloudflare、反向代理、访问日志是否记录完整路径没有核实；ADR 只承诺“自己的日志和决策记录不写路径”。见发现 3。
- **资源耗尽**：批量上限、请求体上限、`start_here` 字数都写成“后续按实测值定”，方向正确；但决定 13 的“按接入 + 天 + 工具汇总成一行”和现有 ledger 的字段/上限冲突。见发现 2。
- **不可撤销操作**：项目笔记“对方删了就跟着删”、以及用“全量编号缺席”推断删除，如果助手程序扫描不完整或超时，会误删。见发现 1。
- **规则、文档、代码一致性**：逐条核对了前提 9、决定 14、`machineString`、测试断言、四份旧 ADR 的 8 处注和 `amended_by`。下面把“证实”和“推测”分开写。

---

## 发现（按严重度）

### 1. 中 | `docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:103,120,142`
**问题**：把“这次名单里没有”直接当成“对方删了”，但助手程序扫描可能超时、部分目录读不到或程序失败；这些情况都会生成不完整的全量名单，从而误删项目笔记、撤下待确认项。现有文字没有要求“扫描完整”这个前提，也没有说部分名单必须拒绝。

**证据**：
- `:103`：“助手程序（决定 11）每次附上“我这边现有的全部编号”。以前推过、这次不在名单里的，算对方删了。”
- `:142`：“每次调用限时很短，超时就放行，不拖慢主人打字；失败记在本地日志和 Himawari 的统计里。”
- `:120`：“对方删了的项目笔记跟着删，留历史。”

这是设计缺口，当前没有对应代码；不是读代码证实的现有 bug。

**建议**：在协议里加显式完整性标记，例如只有助手程序声明 `scanComplete: true` 且服务端确认本次扫描成功时，才允许按缺席删除；超时、部分读取、权限错误一律不发送名单或发 `scanComplete: false`。补一条反向用例：助手只扫描一半目录时，库里的项目笔记不被删。

---

### 2. 中 | `docs/adr/0242-...md:150,195`；`packages/application/src/ports/decision-ledger.ts:102-131`；`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:33,144-160`
**问题**：决定 13 要求“每句话自动搜的读取，决策记录按接入 + 天 + 工具汇总成一行”，但现有 ledger 的 `DecisionInputs` 没有“读取次数、空手次数、有内容次数”这类计数字段；`insertLedgerRow` 只序列化固定的 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds`、`summary*`、`profileBudget`。`memoryIds` 还有 200 条上限。用现有字段无法表达汇总行，页面上“读了几次、空手几次、自动搜几次其中有内容几次”也无法从一行汇总记录反推。ADR 虽然说“改表”（`:195`），但没有写明汇总行的字段、唯一键/upsert 规则，也没有检查两端校验。

**证据**：
- `decision-ledger.ts:102-131`：`DecisionInputs` 只有 `memoryIds`、`summaryIds`、`summaryRead` 等，没有计数字段。
- `sqlite-decision-ledger-operations.ts:33`：`const MAX_IDS = 200;`
- `sqlite-decision-ledger-operations.ts:144-160`：只把这些固定键写进 `inputs`。
- `production-mcp-read.ts:861`：`id: \`ledger:${randomUUID()}\`,`；`:867`：`subjectRef: \`mcp-client:${client}\`,`
- ADR `:150`：“每句话自动搜的读取，决策记录按“接入 + 天 + 工具”汇总成一行。”
- ADR `:195`：“接入记录、读取上限和统计（决定 1、4、13，改表）”。

**建议**：在 ADR 里明确汇总行的存储方案：新增计数输入字段或单独统计表、确定“接入 + 天 + 工具”为唯一键、用 upsert 而不是随机 id + `ON CONFLICT DO NOTHING`，并给 `memoryIds` 上限和大批量场景补反向用例。这正是 I-73 那类“新值在一端产生、另一端不接受”的问题。

---

### 3. 中 | `docs/adr/0242-...md:76-77`
**问题**：密钥放 URL 路径，ADR 只用“查询参数容易被各级日志记下”来解释为什么不用查询参数，但路径同样常被 Cloudflare、反向代理、访问日志、客户端配置和错误上报记录。ADR 只承诺“日志和决策记录不写接入编号以外的密钥”，没有覆盖外部基础设施日志。

**证据**：
- `:76`：“日志和决策记录只写接入编号，不写密钥，也不写带密钥的路径。”
- `:77`：“密钥放在网址路径里。Cloudflare 的登录对带密钥的子路径不能照常工作时，改放请求头；不放查询参数，因为查询参数容易被各级日志记下。”
- 内部服务确实关了 Fastify 日志：`packages/platform-node/src/http-gateway-server.ts:802` 是 `logger: false,`，但这只证明项目自己的服务不打印请求日志。

Cloudflare/代理的日志行为未核实。

**建议**：默认优先放请求头；如果因为 Cloudflare Access 必须放路径，就在 ADR 里明确残余风险，并要求边缘日志对该路径脱敏或关闭访问日志，密钥短期轮换、可撤销，并加一条检查：请求日志和错误信息里不得出现路径中的密钥。

---

### 4. 中/低 | `docs/adr/0242-...md:100,119,208`；`apps/agent-service/src/production-mcp-memory-writer.ts:39,53`
**问题**：稳定编号和项目名只写“带控制字符的拒绝”，但现有代码对正文的不可见字符处理是 `\p{Cc}\p{Cf}\p{Cs}\u2028\u2029`，包括零宽字符、双向排版字符和代理项。若实现只按字面“控制字符”（通常理解成 `\p{Cc}`）拒绝，`\p{Cf}`/`\p{Cs}` 会漏过去，可能造成稳定编号看起来相同、实际不同，或项目名显示欺骗。另外项目名去凭据只写了 `https://用户:令牌@主机/仓库` 这一种形式，URL 里的 token 还可能出现在 query、path、百分号编码的 userinfo 里。

**证据**：
- ADR `:100`：“稳定编号和项目名按普通文字存，有长度上限，统一成 NFC 写法，带控制字符的拒绝；它们不进任何要求 `machineString` 的字段。”
- ADR `:119`：“远程地址里可能带用户名和令牌（`https://用户:令牌@主机/仓库`），助手程序发送前去掉这一段，只留主机和路径；服务端收到带这一段的项目名也拒绝。”
- 代码 `production-mcp-memory-writer.ts:39`：`const INVISIBLE_FORMATTING = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;`
- 同文件 `:53`：`normalizeProposalText` 用这个正则把不可见字符替换成空格。

**建议**：把 ADR 写成与现有代码同一套字符集（`\p{Cc}\p{Cf}\p{Cs}\u2028\u2029`），或直接复用 `normalizeProposalText` 的清洗逻辑；项目名用 `new URL()` 解析并移除全部 userinfo，同时拒绝任何仍含凭据的 query/path，并补零宽字符、双向控制符、百分号编码 userinfo 的拒绝用例。

---

### 5. 中/低 | `docs/adr/0242-...md:156`
**问题**：决定 16 新增了“接入密钥摘要 → 人”的共用索引表，但没有写这个新值的生产/消费一致性：创建接入时怎样和本人数据库里的接入记录一起写入、撤销时怎样删除、索引写入失败或残留时服务令牌路径会怎样。服务令牌没有登录身份，完全依赖这张索引找库；这是典型的两端校验问题。

**证据**：
- `:156`：“助手程序走服务令牌，没有登录的人，所以共用层要有一张“接入密钥的摘要对应哪个人”的索引表，只放摘要和人，不含私人内容，做法和 ADR 0229 的设备索引表一样。”

当前没有代码，属于推测/设计缺口。

**建议**：明确创建/撤销/迁移时索引与本人库的写入顺序或 outbox，规定索引缺失/残留时的失败关闭行为，并补“创建只写一半”“撤销后索引残留”“索引存在但本人库里密钥不属于他”的反向用例。

---

### 6. 低 | `docs/adr/0242-...md:76`；`packages/gateway-contracts/src/validation.ts:53-54`
**问题**：ADR 说接入编号“只含字母、数字和 `._:-`，不超过 128 个字符，能通过 `machineString`”，但 `machineString` 还要求**第一个字符必须是字母或数字**。只按 ADR 列出的字符集生成，可能生成 `._-abc` 这种开头，过不了校验。ADR 后半句“能通过”隐含了这个约束，但作为生成规则不够明确。

**证据**：
- `validation.ts:53-54`：`input.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)`
- ADR `:76`：“接入编号只含字母、数字和 `._:-`，不超过 128 个字符，能通过网关契约的 `machineString` 校验。”

**建议**：改成“以字母或数字开头，之后只含字母、数字和 `._:-`，长度 1–128”，并把这门契约测试列进接入记录任务的完成条件。

---

### 7. 低 | `docs/adr/0219-...md:71,84`；`docs/adr/0225-...md:63,69,80`；`docs/adr/0226-...md:61`；`docs/adr/0227-...md:71,118`
**问题**：作者说明里说“四份旧 ADR 上现在的 9 处注”，实际是 **8 处**：0219 两处、0225 三处、0226 一处、0227 两处。8 处引用的“ADR 0242 决定 N”我都逐条对过，**全部对得上**。另外，0219、0225、0226 在正文里也写明被 ADR 0227 部分取代，但新加的 `amended_by` 只列了 0242；如果 `amended_by` 语义是“所有修正过它的 ADR”，这三处元数据不完整（ADR 0227 自己当年也没写 `amends`，属于既有不一致）。

**证据**：
- 统计命令：`grep -n "2026-11-12 起" docs/adr/0219... docs/adr/0225... docs/adr/0226... docs/adr/0227...` 返回 8 行。
- `docs/adr/0219-...md:7`、`0225:7`、`0226:7`、`0227:7` 的 `amended_by` 都只有 0242。
- `docs/adr/0225-...md:57`：“本条由 [ADR 0227] 决定 1、3 取代。”

**建议**：把作者说明改成 8 处；如果元数据要完整，把 `amended_by` 写成 `0227..., 0242...`，或在文档规范里明确“只记最近一次 amend”。

---

### 8. 低 | `packages/sensitive-capture/test/redaction.unit.test.ts:380-384`；`docs/adr/0242-...md:207`
**问题**：ADR 说现有测试能证明“占位编号不随同批无关内容变化”，这本身是对的；但这条测试**不能**发现“把遮盖改成按字段各自遮”的回归：如果 `maskForExternalRead` 改成每个字符串单独遮，`withOthers[1]` 仍然等于 `alone[0]`，因为点名密码的那段自己就能遮住。真正能抓住按字段遮盖的，是 ADR 后果清单里那条尚未实现的 `start_here` 反例。

**证据**：
- `redaction.unit.test.ts:383`：`expect(withOthers[1]).toBe(alone[0]);`
- `redaction.ts:566-568`：`maskSensitiveTexts` 最后 `.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]")`，去掉序号。
- ADR `:207`：“验证码只在“今天的情况”里被点名、同一个值在概况里单独出现，`start_here` 的输出里两处都被遮；把遮盖换成各段分开遮，这条用例必须失败。”

**建议**：这条反向用例要落在读工具/MCP 层，而不是只落在 `maskSensitiveTexts` 的单元测试上；在读侧编码任务合并前，决定 14 没有真正的自动栏。

---

## 读代码证实的事实

- `maskSensitiveTexts` 在输出前确实去掉占位符序号：`packages/sensitive-capture/src/redaction.ts:566-568`；测试 `redaction.unit.test.ts:383` 断言同段文字不受同批无关内容影响。ADR 决定 14 对代码的判断正确。
- `machineString` 规则是 `^[A-Za-z0-9][A-Za-z0-9._:-]*$` 且长度 ≤128：`packages/gateway-contracts/src/validation.ts:53-54`。
- 前提 9 新增的两处代码引用都存在：`service-main.ts:2266` 的 `allowedClassifications: modelVisibleClassifications()`；`production-reminder-writer.ts:288` 的 `memory.dataClassification !== "restricted"`。
- 现有外部读取摘要确实按 `modelVisibleClassifications()` 取，且 `MODEL_VISIBLE` 是 public/private/sensitive 三级：`packages/application/src/services/model-visibility.ts:10-22`。
- 现有 MCP 读工具只有三个，`start_here`/`sync_memories` 还没进代码：`production-mcp-read.ts:94-95`。
- `runPolicy.mcpRead.proposals` 配置键存在，且仍控制写工具注册：`production-mcp-read.ts:458-463`、`service-main.ts:2211`。
- `subjectRef` 只校验 1–256 字符，接入编号（≤128）作为来源可以通过：`sqlite-decision-ledger-operations.ts:63-64`。
- `owner profile` 预算常量确实是 2000：`owner-profile-service.ts:14`。
- 现有 `Invisible` 字符清洗集合是 `\p{Cc}\p{Cf}\p{Cs}\u2028\u2029`：`production-mcp-memory-writer.ts:39`。
- ledger 的 `memoryIds` 上限是 200，`inputs` 只序列化固定字段：`sqlite-decision-ledger-operations.ts:33,144-160`。
- 四份旧 ADR 的 8 处 0242 注，决定编号全部对得上；作者说“9 处”不准确。

## 推测 / 未核实

- Cloudflare 和反向代理是否记录含密钥的完整路径：未核实。
- 助手程序扫描不完整/超时会导致误删：根据决定 6/11/8 的文字推断，当前无代码可验。
- 共用层“密钥摘要 → 人”索引的创建/撤销一致性：ADR 未写，当前无代码。
- 项目名 URL 里 token 的其他出现形式（query/path/百分号编码 userinfo）：未核实具体实现，当前无代码。
- `validate_docs.py --strict`、`check-glossary` 等脚本这次没有运行；作者说的“13 条旧 Runbook 封存错误、其余通过”我未核实。
- Codex 钩子跑命令行程序的限制：ADR 自己已标为未核实，我也没有额外资料。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

本轮是纯文档改动，没有代码变化，因此**不会改变任何现有请求的字节**。ADR 记录的未来实现里：

- Himawari 自己发给模型的请求不变；新增的使用说明和工具描述只注册在对外 MCP 服务上，ADR 明确要求不得进入 Himawari 自己的系统提示和工具定义，相关编码 PR 要过 `check:prompt-prefix`（`:196`）。
- 对外部 agent 来说，新增 `start_here`/`sync_memories` 会让它的工具清单变一次，这是规则第 6 条允许的“工具集合变了换新一次”，不是每轮变化。
- `start_here` 的日期、时间、记忆、摘要、提醒、版本摘要都是工具返回值，作为工具结果追加在对话末尾，不会写进系统提示或工具定义；工具描述本身要求固定、不含时间/名字（`:98`）。
- 遮盖沿用现有 `maskSensitiveTexts`，不会改变已发内容的字节；列表顺序固定也是为确定性服务的。

需要留意的是：全局 `proposals` 开关切换时，写工具会再次出现/消失，外部 agent 的工具清单会再变一次；这不是每轮变化，但不是严格“只变一次”。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？**

- 对 Himawari 自己的模型请求：不会，本轮不改代码。
- 对 MCP 返回：会保留 ADR 0219 决定 4 的“整批一起遮”，因此同一段文字如果和“后面才点名同一个密码/验证码”的段落同批返回，前面的裸值会被一起遮；换句话说，同一段文字的遮盖结果可以依赖**同一批返回里的其他段落**，包括后面的段落。这是决定 14 有意保留的取舍，不是本轮新引入；ADR 0219 决定 4 也写明了这个限制。
- 该依赖只对“同值相关”的内容成立；对“无关内容”，现有测试确实保证字节稳定，序号也被去掉。
- `start_here` 的键顺序固定、列表固定排序，是为了让同样的数据每次序列化成同样字节；日期/时间等会变的值只出现在工具结果里，不进入工具定义。
- 如果外部 agent 把 MCP 返回再拼进自己的模型请求，它是作为已经发生过的工具结果追加，不会回头改写前面已发内容。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- 本轮没有可执行改动，能对应的只有文档校验脚本；作者说 `validate_docs.py --strict` 等通过，我没有运行，标为未核实。
- 遮盖的现有单测能证明“同批无关内容不改变同一段文字”，但**不能**证明“改成按字段各自遮会失败”；按字段遮时该测试仍会通过。真正能抓住的是 ADR `:207` 新列的 `start_here` 反例，而它目前只是后续编码任务的完成条件，仓库里还没有这条测试。
- 后果清单里的其他反向用例（整批回滚、OAuth 请求带全名单不删、四个读工具的上限、稳定编号/项目名拒绝、超 200 条汇总等）也都是计划项，当前没有实现，无法实际运行。
- 就设计而言，`start_here` 那条反例一旦实现，按字段遮确实会失败：整批遮时概况里的裸验证码会被后文点名值遮掉，分段遮时不会。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

- **`amended_by`**：目标路径存在，格式与仓库既有用法一致；但 0219/0225/0226 也都被 ADR 0227 部分取代，新字段只列 0242，严格说元数据不完整（低）。
- **旧 ADR 的“决定 N”引用**：8 处全部与 ADR 0242 的决定编号对得上；作者说 9 处，实际 8 处（低）。
- **接入编号 → `machineString`**：`machineString` 还要求首字符是字母/数字，ADR 的字符集描述少了这一条；生产端若严格按 ADR 生成可能失败（低）。
- **接入编号 → 决策记录 `subjectRef`**：ledger 只要求 1–256 字符，128 字符的接入编号可以通过，现有校验接受（已证实）。
- **`runPolicy.mcpRead.proposals`**：配置类型和代码里都存在，仍决定写工具是否注册；接入设置只能在它之内收窄，两边一致（已证实）。
- **`start_here` / `sync_memories` 工具名**：当前 `MCP_READ_TOOL_NAMES`/`MCP_WRITE_TOOL_NAMES` 还没有它们；未来注册时要同步更新工具名联合类型和决策记录写入路径。ADR 的任务清单覆盖了读侧/写侧，但没有单独点出类型和 `reasonCode` 联合的改动（低）。
- **稳定编号、项目名**：ADR 说它们不进 `machineString` 字段，方向正确；但“控制字符”的集合比现有代码窄，且项目名去凭据只覆盖一种 URL 形式，需要在实现时与 `INVISIBLE_FORMATTING` 和 URL 解析对齐（中/低）。
- **“接入 + 天 + 工具”汇总行**：现有 ledger 没有计数字段，`memoryIds` 上限 200，随机 id + `ON CONFLICT DO NOTHING` 也不是 upsert；这个新值在现有消费端无法完整接受（中，见发现 2）。
- **共用索引“摘要 → 人”**：生产端（创建/撤销接入）和消费端（服务令牌找库）的一致性未写明，需要实现时补事务/对账和测试（中/低）。
