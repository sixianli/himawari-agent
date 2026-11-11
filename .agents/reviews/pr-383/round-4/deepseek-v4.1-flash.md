## 结论

未发现高、中严重度问题。第 4 轮的三项代码改动与 ADR 0225 的描述一致；合入 main 后，写工具与 P3-6 今日上下文摘要的代码路径互不相交，4 个 `ProductionMcpRead` 构造点都补上了必填的 `onSummariesFailed`。下面几条都是低严重度或文档一致性问题。

## 发现（按严重度，均为读代码证实）

### 低：ADR 0219 合并后内部自相矛盾，且测试说明没跟上写令牌
`docs/adr/0219-read-only-mcp-entry-with-static-token.md:28`、`:66`、`:115`、`:124`

- 背景仍写“把「近一两天的对话摘要」留到任务 P3-6 合并以后再接”（第 28 行），决定 3 仍写“近一两天的对话摘要等任务 P3-6 合并后再加”（第 66 行）；但后果已写“已在 P3-6 合并后补上，见决定 7”（第 115 行），决定 7 也已存在。
- 第 124 行仍写“`runPolicy.mcpRead` 只接受一把用途是 `mcp-read` 的密钥”，未提 ADR 0225 新增的 `writeSecretRef` / `mcp-write`。
- 证据（我读到的原文）：
  - `:66` “近一两天的对话摘要等任务 P3-6 合并后再加。”
  - `:115` “「今日上下文」的近两天对话摘要已在 P3-6 合并后补上，见决定 7。”
  - `:124` “`packages/platform-node/test/startup-configuration.unit.test.ts`：`runPolicy.mcpRead` 只接受一把用途是 `mcp-read` 的密钥。”
- 说明：这些旧句子在 main（949d2fa9）上就已存在，不是本轮引入；但本次合并只加了 ADR 0225 链接，没有顺手改掉，作为文档一致性问题记录。
- 建议：把第 28、66 行改为指向决定 7，第 124 行补上写令牌的测试说明。

### 低：`elicitationSupported` 对畸形能力对象过于宽松
`apps/agent-service/src/production-mcp-read.ts:236-240`

```
const elicitation = (capabilities as Record<string, unknown>)["elicitation"];
if (elicitation === null || typeof elicitation !== "object") return false;
const modes = Object.keys(elicitation);
return modes.length === 0 || modes.includes("form");
```

- 问题：`elicitation: []`（数组）或 `{}` 都会被当成支持确认框。数组不是合法的能力声明；服务端随后会发 `elicitation/create`，但对方可能根本没实现表单确认。依据 ADR 0225 前提 3，客户端没声明支持时服务端 MUST NOT 发确认请求。
- 影响：不会造成越权或数据损坏，最坏是确认流程走不下去；但这是不可信输入的校验缺口。
- 建议：至少加 `!Array.isArray(elicitation)`，并考虑只接受 `modes.includes("form")`；如果要接受空对象，请在注释/ADR 里写明理由。

### 低：分类非法时返回的是“正文为空或超长”的错误文字
`apps/agent-service/src/production-mcp-read.ts:396-401`；`packages/prompt-catalog/src/tools.ts:393`

```
if (
  text.length === 0 ||
  [...text].length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM ||
  !(EXTERNAL_PROPOSAL_CATEGORIES as readonly string[]).includes(category)
)
  return proposalReply(MCP_PROPOSE_MEMORY_INVALID.text, true);
```

- 工具文字只写“text 去掉不可见字符后为空或超过 2000 字，没有保存。”（tools.ts:393），没提分类不合法。
- 正常情况下 SDK 的 enum 会先挡住非法分类，所以多数时候不可达；但如果参数校验被绕过或 SDK 行为变化，外部 agent 会收到误导性的原因。
- 建议：为分类非法单独一条结果文字，或让现有文字也包含“分类不在允许范围”。

### 低（测试缺口）：写工具与 P3-6 摘要没有组合用例
`test/integration/mcp-write.test.ts:228-236`

```
sources: {
  recall: ...,
  embedOutsideRun: ...,
  reminders: ...,
  settings: ...,
},
...
onSummariesFailed: (error) => failures.push(error),
```

- 写工具测试只补了必填的 `onSummariesFailed`，没有提供 `sources.summaries`，所以没有一条测试同时启用“写令牌 + today_context 摘要”。代码路径我看过是分开的（写工具不走 `#call/#record`，摘要只挂在 `today_context`），因此不认为有功能缺陷；但合并前的“互相影响”目前只靠静态检查兜底。
- 建议：加一条冒烟用例，用写令牌调 `today_context` 且提供 summaries，确认返回 `recentDays` 的同时 `propose_memory` 仍正常。

### 信息（设计取舍，非缺陷）：跨客户端重发时，审计归属是“最初提议者”，不是“实际确认者”
`apps/agent-service/src/production-mcp-read.ts:270-273`、`:284-285`、`:431`

```
bind: (context) => `${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? ""}`,
...
const access = writing ? WRITE_ACCESS : READ_ACCESS;
return { status, authInfo: { token: "", clientId: access, scopes: [access] } };
...
client: state.client,
```

- 状态只绑定到“令牌种类”（`himawari:write`），不绑定具体客户端；因此任何持有同一把写令牌的客户端都能带着别人的 `requestState` 完成确认，而决策记录会记成最初提议的客户端名。新用例 `records the client name the owner saw...` 正是在验证这个行为。
- ADR 0225 已明确“拿到写令牌的人可以自己回答确认框”的信任范围，所以这是有意取舍；只是审计记录反映的是提议者，不是实际点确认的客户端，值得在运维排查时知道。
- 建议：若以后需要审计“谁确认的”，可考虑把重发时的客户端名单独记到 `inputs` 或日志里（现在 `insertLedgerRow` 对 `external_read` 之外只保留固定字段，需要另开改动）。

## 侧重检查

我按你的侧重逐项查过：

- **错误路径**：正文为空/超长、分类非法、客户端不支持确认框、记忆世代未就绪、拒绝记录写失败、保存失败、状态篡改、参数被换、重复重发、并发保存/拒绝。主要证据是 `production-mcp-read.ts:396-449` 和 `mcp-write.test.ts` 的用例；错误都转成工具错误或固定结果文字，拒绝写不进账本时不会回“已拒绝”。
- **不可信输入**：`normalizeProposalText` 先 NFC、去控制/格式/孤立代理项再算长度（`production-mcp-memory-writer.ts` 的 `INVISIBLE_FORMATTING`）；正文最多 2000 个码点；客户端名有 `CLIENT_NAME` 正则限制（`production-mcp-read.ts:224`）；`requestState` 有 HMAC、TTL、方法+令牌种类绑定；分类走枚举校验。除上面提到的 elicitation 宽松和分类错误文字外，没有发现可注入路径。
- **安全**：读写令牌必须是不同的引用且解析后的值也不能相同（`production-mcp-read.ts:260-261`、`strict-configuration.ts:1129-1132`），写工具只对 modern + `himawari:write` 注册（`:348-353`），只读令牌看不到写工具；确认前不写记忆；`propose_memory` 的 `text` 不会写进决策记录正文（`contentRef: null`）。
- **资源耗尽**：MCP 请求体上限 65,536 字节，正文再收敛到 2000 码点；两把令牌各自限流；`#deciding` 按 proposerId 排队并在结束后清理（`:452-465`）；摘要最多 8 条、底层最多取 32 条（`episodes.ts:216-239`）。未发现无界增长的路径。
- **不可撤销操作**：本 PR 只新增“确认后写记忆”，没有删除/覆盖已有记忆；拒绝和取消只写一条拒绝账本。已保存记忆的删除仍走原有网页删除流程。
- **规则/文档与代码一致性**：ADR 0225 的规范化措辞（“先换成空格”）与代码一致；`memory:mcp:` 前缀在 writer、网页、运维报表、报表测试四处一致；`mcp_proposal_*` 原因码在账本校验、每日回顾、校准三处一致；ADR 0219 的问题见上。
- **合入 main 后写工具与 P3-6 摘要**：写工具的 `#proposeMemory` 不经过 `#call`/`#record`，摘要只在 `today_context` 的 `#recentDays` 里产生；共享的只有 `ProductionMcpReadOptions.onSummariesFailed`，4 个构造点（service-main、mcp-read 测试、mcp-write 测试、production-http-composition 测试）都已提供。未发现互相覆盖或状态污染。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加，每轮会变的值是否都在最后一条消息里？**

不会改变 Himawari 自己发给模型的请求开头。

- 本 PR 新增的 `mcp.propose-memory*` 文字只被 `apps/agent-service/src/production-mcp-read.ts` 使用（`packages/prompt-catalog/src/tools.ts` 里的 `usedBy` 也这么标），是 MCP 工具描述和工具结果，不进 Himawari 的模型系统提示/工具定义。
- `propose_memory` 工具只加在外部 MCP 客户端的工具列表里；对同一写令牌、同一协议版本，工具顺序是固定的（三个只读工具之后追加），不会每轮变化。
- 外部提议保存后的记忆通过现有记忆注入机制进入模型上下文，属于每轮追加在末尾的内容；正文在确认时冻结，不会改写历史。
- P3-6 的 `recentDays` 只出现在外部 MCP `today_context` 的工具结果里，属于对方对话的末尾，不是 Himawari 的请求开头。
- `prompt-manifest.json` 新增的是固定文字条目；它只可能影响恰好包含这些新串的内容的遮盖结果，而这些串是 MCP 专用文字，实际不会出现在已有模型请求里。没有发现会让已有请求开头变字节的改动。
- 因此：仍然只在末尾追加；`today_context` 里的 `now`/`today`/摘要这类会变的值都在工具结果（末尾），不在系统提示或工具定义里。符合 `.claude/rules/prompt-prefix.md` 第 1、2、4 条。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

- 写工具保存的正文：`normalizeProposalText` 是确定性的（NFC + 固定字符替换 + 合并空格 + trim），不含时间字段；同一个 `requestState` 对应的正文和分类由 `argsHash` 固定，确认框、存储、哈希用的是同一份。提案编号是随机 UUID，但它不进入正文。
- 账本记录里有 `decidedAt`、`durationMs` 等时间值，但那是审计字段，不是模型文字。
- `today_context` 的摘要顺序是确定的：`ORDER BY e.day DESC, e.ended_at DESC, e.id ASC`（`sqlite-memory-operations.ts:1536`）；同一批摘要每次顺序相同。但摘要内容会随时间新增，且 `maskSensitiveTexts` 的遮盖在同一响应内会受“同一次返回里别处点名了密码/验证码”的影响（ADR 0219 决定 4 已写明）。这是外部 MCP 响应，不是 Himawari 的模型请求，不会影响 Himawari 的 KV 缓存；对调用方来说，`today_context` 本来就是一个末尾的、会随数据变化的工具结果。
- `requestState` 每次 mint 都带随机 UUID 和新 HMAC，但这是协议状态，不是发给模型的文字。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- 客户端名写进状态：有。`mcp-write.test.ts` 新用例用 `another-agent` 重发并要求 `subjectRef === "mcp-client:claude-code"`；旧代码会用重发方名字，预期值不同，所以反向确实会失败。
- 并发比较：`mcp-write.test.ts` 的两个并发用例已不再假设第一个数组元素先处理；带 `slowDecisionRead` 的“保存和拒绝同时到达”用例是能验证排队逻辑的反向用例，去掉 `#oneAtATime` 时会出现多条 SAVED 或混合结果，预期数组不匹配。第一个纯并发保存用例改为排序后整体比较，也能发现“多于一条 SAVED”。
- 合并 main：`onSummariesFailed` 是必填字段，TypeScript 会强制所有构造点补上；我确认 4 个构造点都有。摘要本身由 `test/integration/mcp-read.test.ts` 覆盖。
- 文档措辞（ADR 0225）没有对应自动检查；属于人工核对，本次代码和文字一致。
- 缺口：没有“写工具 + 摘要同时启用”的组合测试；也没有覆盖 `requestState` 过期、`legacyShim: false` 的自动化（ADR 0225 已说明这两项测不了）。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**

逐个核对如下（均读代码证实）：

- `ProposalState.client`：产生于 `#askConfirmation`（`production-mcp-read.ts:413`），消费于重发校验和决策记录（`:423`、`:431`、writer 的 `subjectRef`）。两端都按 string 接受；值来自 `clientNameOf`，最长 64 字符且字符集受限，账本 `subjectRef` 上限 256，能通过。
- `writeSecretRef` / `mcp-write`：配置端 `strict-configuration.ts:1123-1132` 生成并校验“必须与只读引用不同”，启动端 `service-main.ts:1786-1791` 按 `purpose === MCP_WRITE_SECRET_PURPOSE` 查找，两端一致；解析后的密钥值相同还会在 `production-mcp-read.ts:260-261` 拒绝。
- `memory:mcp:` / `memory-content:mcp:`：writer 产生（`production-mcp-memory-writer.ts:23`），控制中心（`memory-source.ts:4`）、运维报表（`memory-source-report.mjs:23`）、报表测试（`memory-source-report.test.ts:33-39`）都按同一前缀识别；测试还会交叉检查三处常量一致。
- `mcp_proposal_kept` / `mcp_proposal_declined`：账本校验允许 1–64 字符的任意原因码（`sqlite-decision-ledger-operations.ts:60`），每日回顾把 declined 当主人拒绝跳过（`daily-review.ts`），校准 SQL 用 `LIKE 'mcp!_proposal!_%' ESCAPE '!'` 排除两者（`calibration/src/index.ts:640,655-656`）。两端一致。
- 记忆本身的值：`memoryId` 长度约 47、`contentRef`、`sourceRefs` 非空，`category` 在 `CATEGORIES` 内，`importancePermille=500`、`confidencePermille=1000`、`sensitiveTopic` 在 `SENSITIVE_TOPICS` 内，均能通过 `assertMemoryShape`（`sqlite-memory-operations.ts:639-676`）和 `validateLedgerWrite`。
- 摘要六项：`#record` 产生（`production-mcp-read.ts:556-568`），`summaryInputsValid` 校验只允许 `external_read`（`sqlite-decision-summary-inputs.ts:7-42`、`sqlite-decision-ledger-operations.ts:73-77`），字段名和类型两端一致。
- `onSummariesFailed`：类型上必填，4 个构造点都已提供。
- 提示词目录的 12 个新 id：代码和 manifest 条目一一对应；manifest 的 sha256 我无法在此环境运行校验脚本，未核实。

## 未核实 / 推测

- **未运行**任何测试、lint 或 `check:prompt-prefix`（本次只能用 read/grep/glob 和 git 只读命令），所以“测试通过”是静态阅读结论，不是运行结果。
- 官方 SDK 的 `createRequestStateCodec.verify` 在状态过期/篡改时是抛错还是返回 undefined，以及 `handler.fetch` 如何填充 `context.http.authInfo`，仓库里没有 `node_modules`，**未核实**；我只能依据现有测试和类型声明判断。
- `prompt-manifest.json` 新增条目的 sha256 是否与文字一致，**未核实**。
- P2-3（长期规则）本身的行为不在本 PR 的对比范围内，我只确认了合并没有破坏 P5-2 的构造点和类型；P2-3 的模型工具变更属于 main 的改动，**未逐项复核**。
- “跨客户端用同一写令牌完成确认会让审计归属为最初提议者”是读代码证实的机制；它是否可接受属于 ADR 0225 已声明的信任取舍，我按“信息”记录，不判为缺陷。
