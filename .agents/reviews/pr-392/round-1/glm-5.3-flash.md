# 复核报告：PR 392（P5-2 实机验收脚本 + 确认框改版 + unseen 拒绝）

## 读代码证实的结论（按严重度排列）

### 1.（中低）ADR 保留的旧句子与现在的代码行为矛盾
- 文件：`docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md:58`、`docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:54-55`
- 问题：0225 决定 2 后半段仍写着「拒绝、取消、提交但没勾，都算没同意，**只记一条拒绝的决策记录**」；0226 决定 2 仍写「一个勾选框『让这条规则生效』」、决定 3 仍写「拒绝、取消、**提交但没勾**，什么都不写」。改动后：勾选框已不存在（`requestedSchema: { type: "object", properties: {} }`，production-mcp-read.ts:665、:781），且不到 1.5 秒的 decline/cancel **不记**决策记录（production-mcp-read.ts:605、:737 在 `proposals.decline`/`#decidedRules.set` 之前返回）。虽然前面 appended 的「后续（2026-11-11…）」句子已说明，但紧跟着的旧结论句没改，两段在同一节里直接打架。
- 建议：把旧句改成修订后语义，或明确标注「此句已被上面的后续修订取代」。

### 2.（低）阈值会误伤极快的真人拒绝，且 accept 完全不受 unseen 保护
- 文件：`apps/agent-service/src/production-mcp-read.ts:170-177`
- 证据：
  ```ts
  if (action === "accept") return "accepted";
  return answeredAt - askedAt < MCP_PROPOSAL_UNSEEN_ANSWER_MS ? "unseen" : "declined";
  ```
- 问题 A：真人若在 1.5 秒内按了 Decline/Esc（弹窗已聚焦、键盘流的用户完全可能），会被判 `unseen`：不记拒绝、返回 isError，外部 agent 可能马上再提一次，主人要再拒一次。代价有限，且是 ADR 明写的取舍，不算错。
- 问题 B（推测为已知限制，但 ADR 未写）：`accept` 不做任何时间检查。如果桌面 App 那个 bug 的变体是自动回 accept（而不是 decline），10ms 后记忆就会在主人没看到的情况下写入。ADR 0225/0226 只描述了自动 decline 症状，未提这个盲区。建议在 ADR 里注明「unseen 判定不覆盖 accept」这一限制。

### 3.（低）两条路径的 answeredAt 取法不一致
- 文件：`apps/agent-service/src/production-mcp-read.ts:736` vs `:600-604`
- 证据：memory 路径用 `started`（在 ：687 请求一进来就采集，早于 `await proposals.decided(...)` 的读库，:731）；rules 路径用评估时刻的 `Date.parse(this.#options.clock.now())`（:603，晚于 `await rules.decided(...)`，:595）。
- 问题：同一延迟在两条路径测得的值不同，一个偏小、一个偏大，1.5 秒边界附近行为可能分叉。实际影响很小（真人都在秒级以上），但属于无理由的不一致。
- 建议：统一成「评估回答时取 clock.now()」（rules 路径的取法），或在 mint 的同一处取。

### 4.（低/信息）manifest 里规则提示词的 `changedIn` 从 "ADR 0226" 改成了 "ADR 0225"
- 文件：`packages/prompt-catalog/prompt-manifest.json`（diff 中 `mcp.propose-rule`、`mcp.propose-rule-confirm` 两行）
- 证据：ADR 0161 对 `changedIn` 的语义是「改动的条目写 changedIn: 该 ADR」；这两条提示词起源于 ADR 0226，本次修订同时写在 0225 和 0226 的「后续」里，却把 changedIn 改成时间上更早的 0225。哈希本身有 gate 兜底（见下），但溯源信息变得可疑。
- 建议：改成 0226 或写清 P5-2 归属约定。

### 5.（未发现问题）验收脚本令牌处理
- 文件：`scripts/operations/mcp-write-acceptance.mjs:56-59`、:135-138
- 证据：`writeSecret` 用 `writeFile(file, value, { mode: 0o600, flag: "wx" })` 再 `chmod 600`；令牌随机生成，从不打印；stdout 只输出监听地址；stderr 只输出 `{event, code}`（`code: error?.code ?? error?.message`，理论上错误消息可能带内容，但此处错误不涉及令牌）。`report` 用 `readonly: true, fileMustExist: true` 打开 SQLite，只 SELECT 四类结果（:236-256）。「不泄露令牌」这一说法成立。

## 作者说法逐条核对结果
- 「mcpProposalAnswer…1.5 秒…unseen…不写记忆、不写拒绝决策记录、不记进 #decidedRules、回 mcp.propose-not-shown（isError）」：**与代码一致**（production-mcp-read.ts:93、:170-177、:600-618、:736-743；`MCP_PROPOSE_NOT_SHOWN` 注册于 tools.ts:360、manifest:392）。
- 「askedAt 放进签名 requestState，每次发确认请求用 clock.now() 生成」：**一致**（:674、:790；校验在 ：573、:720）。
- 「确认框去掉勾选框、正文第一行」：**一致**（tools.ts 两个 confirm 模板的 segments 重排，正文/summary 移到第一行；测试断言 `startsWith("把这条存进…\n「…」")`）。
- 「这些文字只发给外部 MCP 客户端，Himawari 自己发给模型的请求不变」：**一致**（grep 全仓，改动的提示词常量只被 production-mcp-read.ts 引用）。
- 「桌面 App 约 10ms 自动回 decline（anthropics/claude-code#105334）」：**未核实**（外部 issue，无法上网）。
- 「manifest 哈希正确」：**未核实具体哈希值**（不能运行命令重算），但存在强制 gate，见问题 3。

## 侧重检查（正常流程走查）

流程：外部 Claude Code 带 write 令牌 POST `/api/mcp/v1` → `registerMcpReadRoute` 的 onRequest 里 `mcp.admit`（BearerGate 校验/限流）→ `#server` 注册 `propose_memory`（仅 modern + WRITE_ACCESS）→ `#proposeMemory`：参数校验 → argsHash → 无 requestState 时 `elicitationSupported` 检查 → `#askConfirmation`（preview…此处为 memory：分类敏感判定 → 签名 mint 带 askedAt 的状态）→ 客户端弹框 → 重发带 `inputResponses` + 原样 requestState → codec.verify（HMAC + 600s TTL + method/clientId 绑定，:364-368）→ 状态字段核对（含 askedAt 类型，:714-723）→ `#oneAtATime` 串行 → `proposals.decided` 查账本 → `mcpProposalAnswer` → keep/decline/NOT_SHOWN → ledger 落账。

- **已覆盖**：正常 accept（断言正文第一行、无字段 schema）、人速 decline/cancel（answerAfterMs 默认 3000ms，会记拒绝）、unseen（10ms/0ms，断言 `decisions()==[]`、之后同状态 accept 仍能保存，规则侧断言之后 accept 仍 SAVED）、不能弹框拒绝、并发只生效一次、规则参数非法。
- **无测试覆盖的路径**：① unseen 之后同状态再回 **decline**（只测了再 accept）；② memory 路径在 `proposals.decided()` 读库很慢时与 1.5s 阈值的交互（测试有 slowDecisionRead 选项但未与 unseen 组合）；③ `#decidedRules` 的 TTL 清理分支（:587-588）；④ 验收脚本只有参数校验的负例（作者自己也只声称测参数校验，说法相符），serve/report 的实际行为没有自动化测试。
- **文档 vs 代码**：除发现 1 外，ADR 增补段与代码一致；`check:prompt-prefix` 相关路径本次未触碰。

## 必答问题

1. **请求开头**：不会变。改动的提示词（工具说明、确认框文字）只进入发给外部 MCP 客户端的工具描述和 elicitation 消息，不进入 Himawari 自己发给模型的任何请求（grep 证实唯一使用处是 production-mcp-read.ts）。发给模型的内容仍只追加，每轮变化值（askedAt 等）根本不进模型请求——它只进签名的 requestState 发给外部客户端。`check:prompt-prefix` gate 未受本改动影响。
2. **字节确定性**：没有新引入的问题。askedAt 每次不同，但只存在于 HMAC 签名的不透明状态里，不参与任何模型可见文本；确认框文字由固定模板 + 提议参数渲染，无时间、无集合遍历；unseen 回复是固定文字。遮盖结果不受影响（本次没动遮盖路径）。
3. **自动检查**：有。unseen 逻辑有单测断言（1500-1ms=unseen、1500ms=declined 的边界）+ 两条集成用例；去掉判定时 memory 用例会失败（instant decline 会走 `proposals.decline` 落账 reasonCode `mcp_proposal_*`，`decisions()==[]` 断言必炸；rules 用例的 later-accept 会变 DECLINED 而非 SAVED）——这是我按代码推理的反向失败，**未实际运行测试核实**。manifest 哈希有 `prompt-catalog.unit.test.ts` 的 digest 比对 + REVERSE 用例兜底；验收脚本有 5 个参数校验负例（含 `--token` 诱导泄露的用例，断言不打印监听行）。
4. **每个值的两端核对**：`MCP_PROPOSAL_UNSEEN_ANSWER_MS`（产 ：93 / 用 ：176+测试）✓；`askedAt`（mint :674/:790，两端校验 ：573/:720，HMAC+TTL+方法绑定防篡改，旧状态过 TTL 直接失效，缺 askedAt 回 CHANGED）✓；`MCP_PROPOSE_NOT_SHOWN`（tools.ts:360，manifest:392 登记，:605/:737 使用）✓；`MCP_PROPOSAL_SAVE_FIELD` 删除后全仓无残留引用，对应 manifest 两行同步删除 ✓；`mcpProposalAnswer` 返回值三态在生产两处和测试中消费一致 ✓。唯一存疑的是 manifest 的 `changedIn` 元数据（发现 4），不影响校验。
