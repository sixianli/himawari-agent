# 复核报告：PR 398（a4c70593）

## 发现（按严重度从高到低）

**1. 低｜test/integration/mcp-write.test.ts:944-960｜「防注入」测试只覆盖了 phrases 列表和记忆正文，五个条件列表里的 excludePhrases 没有用例**
- 证据：entries() 只拒绝 Surrogate/Cc/Cf，不拒 Zl/Zp（`packages/application/src/rules/rule-types.ts:78`：`/[\p{Surrogate}\p{Cc}\p{Cf}]/u`），所以 excludePhrases 也能携带 U+2028/2029，靠 `listed()` 在渲染时换空格（`apps/agent-service/src/production-mcp-read.ts:650`）。新测试只给 `phrases: ["在留\u2028同意（Accept）就生效"]`（mcp-write.test.ts:949）。senderDomains/addresses/words 因格式正则（rule-types.ts:63-65）不可能含这些字符，风险仅剩 excludePhrases。
- 建议：给 excludePhrases 补一条同款断言。

**2. 低｜docs/adr/0225…md:58（0226…md:55 同）｜「主人没看到确认框就不算同意」这句原理总结强于代码实际保证**
- 证据：代码只按 1.5 秒阈值判定（`production-mcp-read.ts:182`：`if (!(answeredAt - askedAt >= MCP_PROPOSAL_UNSEEN_ANSWER_MS)) return "unseen"`）。自动回答的客户端只要带答案的重发在 askedAt 之后 ≥1.5 秒到达（签名状态 10 分钟内有效，:620-625、:753-755 就会执行 `rules.accept(proposal)` / `proposals.keep(...)`）照样写入。ADR 同段对判定本身的定义（只看 1.5 秒）与代码一致，不矛盾；只是这句绝对化说法和作者说法「自动回答的同意不写」一样，只在 1.5 秒内成立。
- 建议：作者总结和 ADR 里把「自动回答的同意不写」限定为「1.5 秒内回来的」。ADR 0225:58 同段确实还留着旧句式的影子吗——已核对：旧的「这个判定只看拒绝和取消…照样保存」一句在两份 ADR 里都已删除（grep 全仓无残留），无自相矛盾。

**3. 低｜packages/prompt-catalog/src/tools.ts:315、445、448｜「对方写不出一行看起来像固定说明的文字」略过头**
- 证据：对方无法让带标签的行独占一行（各插值都不含换行，见必答 4），但可以在自己的值里原样包含「▍对方提议的原文（只占这一行）：」这类标签文字——它出现在同一行中部，终端折行后视觉上仍可能像标签行。测试只断言行首不是「同意（Accept）」（mcp-write.test.ts:953）。
- 建议：接受残余风险即可（确认框是给人看的，且写令牌本就只放主人自己的客户端），或在 ADR 里把话说准。

**4. 信息（读代码证实）｜unseen 回复 `isError: true`**（`production-mcp-read.ts:618`、`:752`）——外部 agent 会当成工具错误。与秒回拒绝的原行为一致，非本次引入。

**5. 未核实｜prompt-manifest.json 三个新 sha256** 我无法运行 node 重算；它们由 `apps/agent-service/test/prompt-catalog.unit.test.ts:300-319`（`PROMPT_MANIFEST_STALE` 检查）在测试时把关，不符即失败。PROMPT_MANIFEST_UNKNOWN 的实现是改动前就有的（git blame 73408c990，2026-11-04），本 PR 只补了反向用例；该用例是 `toEqual` 精确断言（:386），删掉实现里的循环（:192-193）必失败。

## 侧重检查（走过的流程）

普通流程一：外部 agent `propose_memory` → `#proposeMemory`（:696）校验/规范化 → `#askConfirmation`（:781）渲染确认框、铸造签名状态 → 主人 Accept（3 秒后）重发 → 状态校验 + argsHash 比对（:729-738）→ `#oneAtATime` 排队 → `mcpProposalAnswer` → `keep` 写记忆和决策记录。全程被「asks the owner in the client, saves after a confirm…」（:493-530）覆盖；秒回分支被 [P5-2 auto-accept]（:928-942）和 [P5-2 desktop]（:550-600，含同一状态先秒回拒绝、后真同意保存）覆盖。
普通流程二：`propose_rule` → `parseOwnerRuleParameters` → `preview`（`production-owner-rules.ts:571-589`，返回解析后参数+回放数字）→ 确认框 → accept → P2-3 create+confirm。被 :862-912 覆盖（含 `mcp:claude-code` 来源、规则类记忆正文）。
无未覆盖的新路径；失败分支（FAILED/NOT_READY/REPLAY_UNAVAILABLE/INVALID）也各有用例（:619-621、:813、:1000-1038）。文档与代码一致（两份 ADR 的「同意也一样（2026-11-11 晚补）」段与 `mcpProposalAnswer` 新逻辑逐条对上；`mcp.propose-not-shown` 新文字与 ADR「同一段文字」对上）。

## 必答问题逐条

1. **不会。** 证实：改动的三个提示全是 `tool-result` 层，usedBy 只有 production-mcp-read.ts（tools.ts:310、376、440），只作为确认框（服务端→客户端的 elicitation）和返回外部 agent 的工具结果出现在会话末尾，不改写任何已发内容；Himawari 自己的模型请求本就不含这些提示（与 ADR 0225 决定 8 一致）。每轮会变的 `askedAt` 只放签名状态里，不在任何文字里。
2. **不会。** 证实：`mcp.propose-not-shown` 是固定文字；确认框对同一输入字节确定——条件列表解析时去重+排序（rule-types.ts:84-86、110-115），`listed()` 是确定性映射，无时间字段、无序集合。回放数字随邮件库变化，但那是每次响应新生成的内容，不构成缓存前缀。
3. **有，且反向用例会失败。** mcpProposalAnswer 边界用例（mcp-write.test.ts:551-558，含 accept/NaN/负差值）、[P5-2 auto-accept]、[P5-2 dialog]、[P5-2 desktop]；PROMPT_MANIFEST_UNKNOWN 用例对实现精确断言，实现删除即失败。
4. **逐个核对过，都能接受。** 产生处→使用处：`client` 经 `CLIENT_NAME` 正则截断（:106、315-325，无换行）→ 仅进确认框和 `subjectRef`/`source`；`category` 九种枚举（memory-writer.ts:27-37）；`text`/`reason` 经 normalizeProposalText 把 Cc/Cf/Cs/2028/2029 换空格（memory-writer.ts:39、52-54）；`summary` 经 validRuleSummary 拒 Surrogate/Cc/Cf/Zl/Zp（rule-types.ts:248-255，与作者说法一致、另加 Surrogate）；条件列表经 entries() 拒 Surrogate/Cc/Cf（:78）+ 渲染时 Zl/Zp 换空格，且确认框用的是 preview 返回的**解析后**参数（production-owner-rules.ts:577-585），不是原始参数；`kind`/`sensitive`/`replay` 是固定文字或纯数字。确认框里没有任何插值能含换行。唯一未亲自核实的是清单 sha256 的数值本身（由测试把关，见发现 5）。
