---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "0242"
date: "2026-11-15"
---

# ADR 0281：外部 agent 推来的记忆，主人给这个接入设了“直接存”就马上存下

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

外部 agent（例如 Muse、Claude）经 MCP（让 agent 调用外部工具的协议）的写工具 `propose_memory`、`propose_memories` 推来记忆，本 ADR 之前一律先存进“待确认”，主人在 Himawari 里点过才保存。Andy 2026-11-15 在项目聊天里回答“MCP 写操作要不要改成直接写”：“直接写就行了”。对同一问题的另一个提问，他在决定卡上选了“记忆直接存，规则仍要你点头”。

ADR 0242 决定 9 早已设计了每个接入一个“先问我 / 直接存，可整批撤销”的开关，默认先问，只有主人能改；接入记录里也已经有 `push_policy` 一列，但网关一直拒绝把它设成“直接存”（`MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`），写工具也不看这一列。本 ADR 把这条路接通。

<a id="premises"></a>

## 前提

1. 开关已设计好：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md` 决定 9 的原文是“每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。”
2. “直接存”只管记忆：同文件决定 9 的 2026-11-12 补注原文是““直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效”。Andy 本次在决定卡选的“记忆直接存，规则仍要你点头”与它一致。
3. 待确认表和整批撤销已经存在：`ProductionMcpMemoryWriter.undoBatch`（`apps/agent-service/src/production-mcp-memory-writer.ts`）按批次号撤销，网关操作 `memory.external.undo`。
4. 改动前网关拒绝“直接存”：改动前的 `apps/agent-service/src/production-mcp-connections-control.ts` 里 `askFirstOnly` 对 `pushPolicy !== "ask"` 抛 `MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`。
5. 愿景 v2.2 起规则是 Andy 定的硬设定：`AGENTS.md` 产品愿景一节。

<a id="decision"></a>

## 决定

1. **开关是每个接入的 `pushPolicy`，没有新增全局配置。** 网关允许把它设成 `direct`；`runPolicy.mcpRead.proposals` 仍决定写工具出不出现（ADR 0227），关掉它就没有写工具，也就没有直接存。依据“用户主权”：只有主人在设置页能改。
2. **默认值：设置页新建接入时默认选“直接存”**（Andy 2026-11-15 的指示）；已有接入保持原来的“先问我”，主人在设置页改一次。接口层新建仍必须明写 `pushPolicy`，不靠隐含默认。
3. **直接存的流程复用待确认表，不另开一条写路径。** 先照常提交（去重、机器密钥拒收、分级、决策记录 `pending`），再由写入器的 `keepDirect` 在同一把队列锁里检查：分级是敏感的，留在待确认；否则按网页确认同一套代码保存（敏感内容一律待确认是本 ADR 的新决定，依据“边界与可逆性”：敏感内容存错的代价比普通记忆大，撤销也收不回已经被用掉的那一次；任务清单 `/mnt/project-files/p5-memory-hub/coding-tasks.md`（仓库外）里也有同样一条），批次号是 `batch-direct-` 加 24 位十六进制。`propose_memory` 一次调用一个批次，`propose_memories` 一次调用共用一个批次，所以主人在记忆页可以整批撤销，撤销后条目回到待确认。
4. **先全部提交、再逐条保存。** `propose_memories` 里被同一次调用后面同 `key` 条目替换的，不保存，仍回 `replaced`。某一条保存失败，它留在待确认，结果里回 `pending`，不影响别的条目。
5. **直接存的出处看得出来。** 记忆编号里带 `batch-direct-`；决策记录的原因码是 `mcp_proposal_kept_direct`（仍以 `mcp_proposal_` 开头，自动记忆校准照旧排除）；记忆详情的来源写“外部 agent 送来，未经确认直接保存”，不再写“你确认后保存”。依据“用户主权”：没经过主人点头的内容不冒充点过头。
6. **规则不变。** `propose_rule` 不看 `pushPolicy`，仍要主人在客户端确认框里同意才生效。需要不弹框的客户端也能立规则时，走 ADR 0242 决定 9 的待确认页，单独做。
7. **回执文字。** 新增 `mcp.propose-memory-saved-direct`；`propose_memory`、`propose_memories` 的工具说明改成对两种设置都成立的写法（外部 agent 的工具定义不随设置变），`propose_memories` 的结果多一种状态 `saved`。这些只发给外部客户端，Himawari 自己发给模型的请求一个字节都不变。

<a id="industry"></a>

## 业界怎么做

Claude 的“导入记忆”是直接存，事后在记忆面板里查看和删除（<https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>，ADR 0228 业界一节引用过）。MCP 规范对工具调用的要求是“there SHOULD always be a human in the loop with the ability to deny tool invocations”（<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>），这里的做法是：保存前不拦，但整批可撤销，敏感内容和规则仍要人点头。

<a id="options"></a>

## 放弃的做法

- **规则也直接生效。** 外部 agent 读邮件时可能被诱导，立一条“某类邮件不要提醒”的规则，主人发现不了漏掉的提醒，也与愿景 v2.2 起“Andy 定的规则是硬性设定”冲突。Andy 在决定卡上选了不要。
- **新增全局开关代替每个接入的开关。** ADR 0242 决定 1 写明全局配置 `runPolicy.mcpRead.proposals` 管写工具出不出现、接入上的设置只能在它之内再收窄；全局开关没法让 Muse 直接存、别的接入仍先问。
- **直接存时连敏感内容一起存。** 敏感内容存错的代价比普通记忆大，见决定 3。

<a id="consequences"></a>

## 后果

- 部署后已有的接入（例如 Muse）还是“先问我”，要主人在设置页“接入的 agent”里把它改成“直接存”。
- 同一个 `key` 带来新内容，只替换还在待确认的旧内容；已经直接存下的旧记忆不会被改写（更新版本留给 `sync_memories`，ADR 0242 决定 6），主人用整批撤销处理。
- **已知缺口：定级。** 敏感与否目前由 `proposalClassification` 判：外部 agent 自己声明的分类是健康或财务，或正文里有证件号、银行卡号这类标识，或有密码、验证码等凭据，才升敏感。外部 agent 把健康、财务内容标成别的分类时，会以 private 不经确认直接入库。规划线程正在写统一用模型定级的方案（动模型调用，要 Andy 同意），本 ADR 不解决它；在那之前主人可以把接入改回“先问我”，或整批撤销。
- 直接存的记忆在撤销前就会被 Himawari 使用和被别的 agent 读到；风险由敏感分级、机器密钥拒收、整批撤销三道兜住；其中敏感分级只认外部 agent 自己声明的分类、正文里的证件号和银行卡号，以及密码、验证码等凭据，上面的“已知缺口”没有补上，Andy 2026-11-15 已选“先接受缺口再合并”。直接存的条目提交的瞬间仍计入待确认和暂存的条数上限，保存后不再计入；接近上限时直接存也会返回已满，另外还受每分钟调用次数和每次 50 条的限制，主人可整批撤销。
- 自动检查：`test/integration/mcp-write.test.ts` 里标了 `[direct]` 的用例，含反向用例（设成先问的接入仍进待确认、敏感留在待确认、规则不会自己生效）。
