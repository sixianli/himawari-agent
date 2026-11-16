你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 799a1d36dbe1ac234bb216cc79781cd3edd651c3。
本 PR 的基线提交是 5834935d102709955c38e76220c6ed8a6df5cc51（main 与 799a1d36dbe1ac234bb216cc79781cd3edd651c3 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0281-memory-from-outside-agents-saves-directly-when-the-owner-turns-it-on.md（在提交 799a1d36dbe1ac234bb216cc79781cd3edd651c3 里的内容）

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

外部 agent（例如 Muse、Claude）经 MCP（让 agent 调用外部工具的协议）的写工具 `propose_memory`、`propose_memories` 推来记忆，现在一律先存进“待确认”，主人在 Himawari 里点过才保存。Andy 2026-11-15 在项目聊天里回答“MCP 写操作要不要改成直接写”：“直接写就行了”。对同一问题的另一个提问，他在决定卡上选了“记忆直接存，规则仍要你点头”。

ADR 0242 决定 9 早已设计了每个接入一个“先问我 / 直接存，可整批撤销”的开关，默认先问，只有主人能改；接入记录里也已经有 `push_policy` 一列，但网关一直拒绝把它设成“直接存”（`MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`），写工具也不看这一列。本 ADR 把这条路接通。

<a id="premises"></a>

## 前提

1. 开关已设计好：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md` 决定 9 的原文是“每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。”
2. “直接存”只管记忆：同文件决定 9 的 2026-11-12 补注原文是““直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效”。Andy 本次在决定卡选的“记忆直接存，规则仍要你点头”与它一致。
3. 敏感内容一律待确认：`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md` 任务 C 清单里写的是“写入时同步判敏感，敏感一律待确认”（`/mnt/project-files/p5-memory-hub/coding-tasks.md`）。
4. 待确认表和整批撤销已经存在：`ProductionMcpMemoryWriter.undoBatch`（`apps/agent-service/src/production-mcp-memory-writer.ts`）按批次号撤销，网关操作 `memory.external.undo`。
5. 现在网关拒绝“直接存”：改动前的 `apps/agent-service/src/production-mcp-connections-control.ts` 里 `askFirstOnly` 对 `pushPolicy !== "ask"` 抛 `MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`。
6. 愿景 v2.2 起规则是 Andy 定的硬设定：`AGENTS.md` 产品愿景一节。

<a id="decision"></a>

## 决定

1. **开关是每个接入的 `pushPolicy`，没有新增全局配置。** 网关允许把它设成 `direct`；`runPolicy.mcpRead.proposals` 仍决定写工具出不出现（ADR 0227），关掉它就没有写工具，也就没有直接存。依据“用户主权”：只有主人在设置页能改。
2. **默认值：设置页新建接入时默认选“直接存”**（Andy 2026-11-15 的指示）；已有接入保持原来的“先问我”，主人在设置页改一次。接口层新建仍必须明写 `pushPolicy`，不靠隐含默认。
3. **直接存的流程复用待确认表，不另开一条写路径。** 先照常提交（去重、机器密钥拒收、分级、决策记录 `pending`），再由写入器的 `keepDirect` 在同一把队列锁里检查：分级是敏感的，留在待确认；否则按网页确认同一套代码保存，批次号是 `batch-direct-` 加 24 位十六进制。`propose_memory` 一次调用一个批次，`propose_memories` 一次调用共用一个批次，所以主人在记忆页可以整批撤销，撤销后条目回到待确认。
4. **先全部提交、再逐条保存。** `propose_memories` 里被同一次调用后面同 `key` 条目替换的，不保存，仍回 `replaced`。某一条保存失败，它留在待确认，结果里回 `pending`，不影响别的条目。
5. **直接存的出处看得出来。** 记忆编号里带 `batch-direct-`；决策记录的原因码是 `mcp_proposal_kept_direct`（仍以 `mcp_proposal_` 开头，自动记忆校准照旧排除）；记忆详情的来源写“外部 agent 送来，未经确认直接保存”，不再写“你确认后保存”。依据“用户主权”：没经过主人点头的内容不冒充点过头。
6. **规则不变。** `propose_rule` 不看 `pushPolicy`，仍要主人在客户端确认框里同意才生效。需要不弹框的客户端也能立规则时，走 ADR 0242 决定 9 的待确认页，单独做。
7. **回执文字。** 新增 `mcp.propose-memory-saved-direct`；`propose_memory`、`propose_memories` 的工具说明改成对两种设置都成立的写法（外部 agent 的工具定义不随设置变），`propose_memories` 的结果多一种状态 `saved`。这些只发给外部客户端，Himawari 自己发给模型的请求一个字节都不变。

<a id="industry"></a>

## 业界怎么做

Claude 的“导入记忆”是直接存，事后在记忆面板里查看和删除（<https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>，ADR 0228 业界一节引用过）。MCP 规范对工具调用的要求是“there SHOULD always be a human in the loop with the ability to deny tool invocations”（<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>），这里的做法是：保存前不拦，但整批可撤销，敏感内容和规则仍要人点头。

<a id="options"></a>

## 放弃的做法

- **规则也直接生效。** 外部 agent 读邮件时可能被诱导，立一条“某类邮件不要提醒”的规则，主人发现不了漏掉的提醒，也与愿景 v2.2“规则是主人定的”冲突。Andy 在决定卡上选了不要。
- **新增全局开关代替每个接入的开关。** 一个全局开关放宽了 ADR 0242“接入上的设置只能在全局之内收窄”的方向，也没法让 Muse 直接存、别的接入仍先问。
- **直接存时连敏感内容一起存。** 违反上面前提 3。

<a id="consequences"></a>

## 后果

- 部署后已有的接入（例如 Muse）还是“先问我”，要主人在设置页“接入的 agent”里把它改成“直接存”。
- 同一个 `key` 带来新内容，只替换还在待确认的旧内容；已经直接存下的旧记忆不会被改写（更新版本留给 `sync_memories`，ADR 0242 决定 6），主人用整批撤销处理。
- 直接存的记忆在撤销前就会被 Himawari 使用和被别的 agent 读到；风险由敏感分级一律待确认、机器密钥拒收、整批撤销三道兜住。
- 自动检查：`test/integration/mcp-write.test.ts` 的四个 `[direct]` 用例，含反向用例（设成先问的接入仍进待确认、敏感留在待确认、规则不会自己生效）。
