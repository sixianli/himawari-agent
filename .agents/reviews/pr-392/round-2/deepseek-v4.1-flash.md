## 复核结论

范围：按 `51bc13b..3f901671` 的增量核对，并在必要时回看全量改动。未运行测试；未能读取 `.agents/reviews/pr-392/round-1/judgments.md`（records 路径被工具拒绝，且工作区没有该文件），因此第 1 轮判断只能按作者摘要核对。manifest 的 sha256 也没有现场复算。

---

### 发现（按严重度）

#### 1. 中：删掉勾选框后，任何 `accept` 都等于主人同意，自动同意不再有服务端门槛

- 文件：`apps/agent-service/src/production-mcp-read.ts:733-737`，`apps/agent-service/src/production-mcp-read.ts:175`
- 问题：旧实现要求 `answer.action === "accept"` 且 `content.save === true` 才写入；现在只看 action。一个不回显确认框、直接自动回 `{action:"accept", content:{}}` 的客户端会把记忆/规则写进去。ADR 明确接受“主人自己配了自动同意钩子”的情况，但这也意味着“写令牌 + 能自答确认框的客户端”本身就是写权限，确认框不是安全边界。这个风险在本 PR 中由“去掉勾选框”扩大了：旧代码里空内容的 accept 不会写入。
- 证据：
  - 当前：`if (action === "accept") return "accepted";`（`production-mcp-read.ts:175`）
  - 当前：`if (outcome === "accepted") { await proposals.keep(proposal, started); ... }`（`production-mcp-read.ts:735-737`）
  - 基线 diff 中的旧条件：`if (answer.action === "accept" && answer.content?.[MCP_PROPOSAL_SAVE_FIELD] === true)`
- 建议：如果这是有意取舍，请在 ADR 0225/0226 里把“确认框不是防恶意客户端的边界，持有写令牌者可以自答”写清楚，而不是只写“主人在自己客户端里的设置”；如果主人同意必须是安全门槛，就不要只依赖客户端回传的 accept，改用 Himawari 自己的确认通道或 P5-3 的批量确认。

#### 2. 中：第 2 轮最核心的“按重发到达时计时”没有能失败的反向用例

- 文件：`test/integration/mcp-write.test.ts:347`、`:363-368`、`:214-217`；`packages/testing/src/deterministic.ts:15-25`
- 问题：测试里的 `ManualClock` 只在 elicitation 回调和 `answered()` 里前进；`slowDecisionRead` 用真实 `setTimeout` 制造延迟，但假时钟不走。把代码改回“排队/读库之后再取 `Date.parse(clock.now())`”，现有用例仍然全部通过，因为那些操作期间时钟值没有变。也就是说作者声称的“不含服务端排队和读库的时间”没有自动检查能证明。
- 证据：
  - `clock.advance(input.answerAfterMs ?? HUMAN_ANSWER_MS);`（`mcp-write.test.ts:347`）
  - `if (params["inputResponses"] !== undefined && params["answeredAfterMs"] !== 0) clock.advance(HUMAN_ANSWER_MS);`（`:364-365`）
  - `ManualClock.now()` 只返回已存的字符串，`advance` 只改字符串（`deterministic.ts:15-25`）
  - `slowDecisionRead` 只是 `await new Promise((resolve) => setTimeout(resolve, 100));`（`mcp-write.test.ts:214-217`）
- 建议：在重发路径的 `decided`/`rules.decided` 读操作里显式 `clock.advance(2000)`（或注入一个在读库时前进的时钟），再用 10ms 的自动拒绝断言仍是 `unseen`。这样旧实现会因 `2000+10 >= 1500` 判成 `declined`，反向用例才能真正失败。

#### 3. 低：ADR 说“时间算不出来按没显示出来处理”，但非有限 `askedAt` 实际回“内容变了”

- 文件：`apps/agent-service/src/production-mcp-read.ts:574`、`:717`、`:577`、`:720`；`docs/adr/0225-...md:57`、`docs/adr/0226-...md:54`
- 问题：`!Number.isFinite(state.askedAt)` 会先返回 `MCP_PROPOSE_MEMORY_CHANGED`（“内容变了”），而不是 ADR 写的 `mcp.propose-not-shown`。生产 `clock.now()` 是 ISO 字符串，实际很难触发；但这是代码和 ADR 字面不一致，且正是第 2 轮新加的校验。
- 证据：
  - `!Number.isFinite(state.askedAt) ||` → `return proposalReply(MCP_PROPOSE_MEMORY_CHANGED.text, true);`（`:574-577`、`:717-720`）
  - ADR：`时间算不出来也按没显示出来处理`（0225:57、0226:54）
- 建议：二选一：把非有限 `askedAt` 也映射到 `MCP_PROPOSE_NOT_SHOWN`，或在 ADR 里写清楚“状态里的时间戳不可用视为状态损坏，回内容变了”。同时给这个分支补一个用例（当前只有 HMAC 篡改用例，`mcp-write.test.ts:699-707`）。

#### 4. 低：ADR 列签名状态字段时漏了 `askedAt`

- 文件：`docs/adr/0225-...md:59`；`apps/agent-service/src/production-mcp-read.ts:158-164`、`:671`、`:787`
- 问题：ADR 写“工具名、提议编号、参数哈希和确认框里显示的客户端名写在签了名的状态里”，实际 `ProposalState` 还包含 `askedAt`，两个 mint 点都会写入。ADR 0226 决定 1 又声明状态签名沿用 ADR 0225 决定 1–3，所以规则路径同样受影响。
- 证据：
  - `interface ProposalState { tool; proposalId; argsHash; client; askedAt: number }`（`:158-164`）
  - `askedAt: Date.parse(this.#options.clock.now()),`（`:671`、`:787`）
  - ADR 0225:59 未提 `askedAt`
- 建议：在 ADR 0225 决定 2 的状态字段说明里补 `askedAt`，并说明它只用于 1.5 秒判定、不参与写库。

#### 5. 低：ADR 里“只有一个勾选框”的旧说法并未完全去掉，作者摘要与事实不符

- 文件：`docs/adr/0225-...md:57`、`docs/adr/0226-...md:54`
- 问题：作者说“ADR 0225、0226 去掉勾选框的旧说法”，但两条决定的“第一次调用”描述仍写着“只有一个勾选框「保存这条记忆」/「让这条规则生效」”，后面才用“后续……去掉勾选框”纠正。作为当前行为的说明，前后矛盾；至少与作者摘要不一致。
- 证据：
  - `...只有一个勾选框「保存这条记忆」。后续（2026-11-11...）：去掉勾选框...`（0225:57）
  - `...一个勾选框「让这条规则生效」。后续（2026-11-11...）：去掉勾选框...`（0226:54）
- 建议：把“第一次调用”改成当前行为（确认框不带字段，Accept/Decline），把旧版勾选框降为历史附注；或者明确标注这一段是 2026-11-11 之前的历史描述。

#### 6. 低：`mcp.propose-not-shown` 的文字只提“拒绝”，但取消也会返回它

- 文件：`packages/prompt-catalog/src/tools.ts:366`；`apps/agent-service/src/production-mcp-read.ts:602`、`:734`
- 问题：`mcpProposalAnswer` 对 `decline` 和 `cancel` 都返回 `unseen`，但提示词写“几乎立刻就收到了拒绝”。外部 agent 可能把主人的“取消”误报成“拒绝”。
- 证据：
  - `text: "确认框发出后几乎立刻就收到了拒绝..."`（tools.ts:366）
  - `if (outcome === "unseen") return proposalReply(MCP_PROPOSE_NOT_SHOWN.text, true);`（两处）
- 建议：改成“拒绝或取消”，与 ADR 0225/0226 的措辞一致。

#### 7. 低：规则路径缺少“先 unseen 再真拒绝”的对称用例

- 文件：`test/integration/mcp-write.test.ts:859-877`、`:541-558`
- 问题：记忆路径已补“秒回取消后再真拒绝会记一条拒绝”，规则路径只补了“unseen 后再 accept”。规则路径的拒绝会写 `#decidedRules`，逻辑与记忆不同，缺少同样的反向/顺序覆盖。
- 证据：规则测试 `unseen` 后接 `later = ... accept`（`:874-876`）；记忆测试有 `ignored`（cancel）后接 `refused`（decline，`:541-558`）。
- 建议：给规则路径补“unseen 后同一状态再 decline，回 declined 且内存记下已拒绝、之后 accept 被挡”的用例。

---

### 侧重检查（错误路径、非法输入、安全、资源、不可撤销、文档一致性）

- **篡改/非法状态**：HMAC 篡改抛错（`mcp-write.test.ts:699-707`）；`argsHash` 不匹配、`askedAt` 非有限、`tool`/`proposalId`/`client` 类型不对都回“内容变了”，不写库（`:568-577`、`:711-720`）。结论：未发现可绕过签名直接写入的路径。
- **错误分支**：`unseen` 在规则和记忆两条路径都直接返回，不 `keep`/`decline`/`accept`、不写决策记录（`:601-602`、`:733-734`）。结论：符合 ADR “不记拒绝”。
- **不可撤销操作**：`accept` 写记忆/规则，无法从“自动同意”海报区分真人；见发现 1。另有一个残留风险：客户端自动拒绝若晚于 1.5 秒（慢网络/客户端延迟）会被记成真拒绝；记忆路径会写永久 `mcp_proposal_declined` 决策记录（`production-mcp-memory-writer.ts:73-75`、`:104-116`），同一状态之后即使主人同意也会被 `decided()` 挡住（`production-mcp-read.ts:728-730`）。机制由代码证实；实际触发频率是推测。建议在 ADR 中写明这个“误拒绝会锁掉同一确认”的后果。
- **资源耗尽**：本次没有新增循环或无界集合；`#oneAtATime`、`#decidedRules` 是已有结构。重复“无答案重发”会重新跑 `rules.preview`（近 30 天回放），这是已有行为，本次未加重。
- **时钟**：生产时钟是 `new Date().toISOString()`（`service-main.ts:214-216`），`Date.parse` 正常；`answeredAt` 为 NaN 已在 `mcpProposalAnswer` 里按 unseen 处理，并有测试（`mcp-write.test.ts:514`）。`askedAt` 为 NaN 的路径见发现 3。
- **文档一致性**：ADR 0225/0226 与代码主要行为一致（计时起点、只看拒绝/取消、去掉勾选后的写入条件），但存在发现 3、4、5 的文字偏差；代码、manifest、测试里没有残留的 `MCP_PROPOSAL_SAVE_FIELD`、`*-save-label` 引用（全仓 grep 无结果）。
- **验收脚本**：`scripts/operations/mcp-write-acceptance.mjs` 的 token 以 0600 独占写、不打印（`:78-81`、`:104-105`），`report` 只读打开数据库（`:233-237`）；`test/tooling/mcp-write-acceptance.test.mjs` 只覆盖参数拒绝，没有 `serve` 成功路径的自动检查，属于手工验收脚本，未见安全缺陷。

---

### 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会改变 Himawari 自己发给模型的请求开头。改动只涉及 `mcp.propose-*` 提示词，它们 `usedBy` 都是 `apps/agent-service/src/production-mcp-read.ts`（`tools.ts:301,310,418,427`），只用于对外 MCP 服务（`production-mcp-read.ts:451,486,638,772`）。同一对话的自由冻结、系统提示、工具定义、历史都没有被改。

但要说清楚：外部 agent 的模型会看到 `propose_memory`/`propose_rule` 的工具说明和确认框文字变了。这是版本升级导致的工具定义变化，不是每轮变化；也不在 Himawari 自己的“按对话冻结”机制内。确认框里每轮会变的 `askedAt`、回放数字都只出现在新返回的 MCP 工具结果/状态里，是追加内容，不是重写已有请求开头。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

固定提示词本身是确定的。但有两处带时间/环境的值：
- `requestState` 里新签入了 `askedAt`，同一逻辑确认在不同时间 mint 会得到不同字节（`production-mcp-read.ts:671`、`:787`）。
- 规则确认框包含 `preview.replay` 的 30 天回放数字，重新渲染时可能不同（`production-mcp-read.ts:652-659`）。

这些都不是 Himawari 自己请求开头的一部分，而是外部 MCP 的工具结果/协议状态，按“只追加”看没有重写历史。外部客户端的模型是否会把 `requestState` 原样放进它的提示词，属于 SDK/客户端行为，**未核实**。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**

部分有：
- `mcpProposalAnswer` 有边界、NaN、负差值用例（`mcp-write.test.ts:510-515`），其中 NaN 用例在旧 `<` 实现下会返回 `declined`，所以是有效反向用例。
- 规则/记忆都有“10ms 自动拒绝 → `mcp.propose-not-shown`”的集成用例（`:517-520`、`:859-864`），记忆还有“先 unseen 取消、再真拒绝记一条拒绝”（`:541-558`）。
- 提示词目录有 `PROMPT_MANIFEST_STALE` 和反向用例（`apps/agent-service/test/prompt-catalog.unit.test.ts:370-381`），manifest 文字/hash 不一致会失败。

但第 2 轮最关键的“计时起点从读库后挪到重发到达时”没有真正的反向用例，见发现 2；`Number.isFinite(askedAt)` 分支也没有用例；规则路径缺少 unseen→真拒绝的对称用例。

**4. 每个改动值的产生/使用两端是否都能接受？**

- `askedAt`：产生于 `:671`/`:787`，重发时在 `:574`/`:717` 校验 `Number.isFinite`，再交给 `mcpProposalAnswer`（`:601`/`:733`）。两端都按 number 处理，能接受；`ProposalTicket` 只是 mint 入参去掉 `askedAt`，结构上兼容。
- `requestState` 的序列化格式：只被同一个 `RequestStateCodec<ProposalState>` 生产/消费，新增字段不影响其他读取方；ADR 的字段清单需要补（发现 4）。
- `requestedSchema: { type: "object", properties: {} }`：产生于 `:662`/`:778`，消费方是外部客户端；服务端不再读取 `content.save`，测试也断言了空 schema（`mcp-write.test.ts:806` 等）。能接受。
- `MCP_PROPOSE_NOT_SHOWN`：`tools.ts:360` 定义，`index.ts:8` 经 `export *` 导出，`production-mcp-read.ts:27` 导入并在 `:602`/`:734` 使用，manifest `:392` 已登记。两端完整。
- 删掉的 `MCP_PROPOSAL_SAVE_FIELD`、`mcp.propose-memory-save-label`、`mcp.propose-rule-save-label`：全仓 grep 无残留引用，manifest 也已删除。两端一致。
- manifest 的 `changedIn`：`mcp.propose-rule`、`mcp.propose-rule-confirm` 已是 `ADR 0226`（`prompt-manifest.json:397-414`），与作者说法一致；该字段只被测试检查“非空”，没有机器校验具体 ADR 是否正确。

**作者说法核对（逐条）**

- “两条路径按重发到达时计时”：代码属实（`received`/`started` 在方法开头），但自动检查不足（发现 2）。
- “askedAt 用 Number.isFinite 校验”：属实（`:574`/`:717`），但和 ADR“时间算不出来按 unseen”不一致（发现 3）。
- “mcpProposalAnswer 满 1.5 秒才算 declined，NaN 和负差值按 unseen”：属实（`:176`，测试 `:514-515`）。
- “补 requestedSchema 断言”：属实（`mcp-write.test.ts:806`）。
- “补秒回取消后再真拒绝记一条拒绝的用例”：记忆路径属实（`:541-558`），规则路径没有对称用例（发现 7）。
- “manifest changedIn 改回 ADR 0226”：属实。
- “ADR 0225、0226 去掉勾选框的旧说法”：不完全属实，旧句子仍在（发现 5）。
