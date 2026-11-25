---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md"
date: "2026-11-11"
covers: "apps/agent-service/src/production-owner-rules.ts, apps/control-center/test/memory-source.unit.test.ts, packages/application/src/rules/rule-types.ts, packages/application/src/services/proactive-mail-check-service.ts, test/integration/mcp-write.test.ts, test/integration/memory-source-report.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0226：外部 agent 提议新规则，主人在客户端确认后按规则提议流程生效

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务 P5-2 让 Claude Code、Codex 这类外部 agent 通过 MCP（Model Context Protocol，让 AI 客户端调用外部工具的开放协议）往 Himawari 里写东西，每次都要 Andy 在他正在用的客户端里确认。[ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md) 做了第一部分：提议新记忆的工具 `propose_memory`。本 ADR 做第二部分：提议一条新的邮件长期规则的工具 `propose_rule`。Andy 在 2026-11-11 同意了变更清单（原文在 `/mnt/project-files/p5-2-mcp-write/change-list-pr-b.md`）。

任务块要求提议规则必须走任务 P2-3（[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md)）的规则提议和确认流程，不另起一套；拒绝就什么都不写。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 主人规则只有两种可写类型。来源 `packages/application/src/rules/rule-types.ts:202` 的 `RULE_TYPES`，第 204、209 行原话 `"mail_must_notify",`、`"mail_read_whole_thread",`。
2. P2-3 的写入器把不是明说的规则存成提议，确认后才写规则。来源 `apps/agent-service/src/production-owner-rules.ts:641` 原话 `if (explicit) return this.#activate(proposal, replayed);`，第 677 行 `confirm` 里原话 `return this.#activate(proposal, null);`。
3. 模型推断出来的只作提议，主人点头才生效。来源 [ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md) 第 32 行原话 “模型推断出来的只生成提议，主人点头才生效”。
4. 撤销后再点同一张提议卡的「生效」，规则会恢复。来源 ADR 0213 第 61 行原话 “撤销后再点同一张提议卡的“生效”……规则和规则类记忆一起恢复”。所以外部提议不能只靠 P2-3 的确认来防重放。
5. 多轮请求（MRTR）、`requestState` 防篡改、客户端不声明 elicitation 时不能发确认请求、Claude Code 的表单确认：同 [ADR 0225 的前提 1 到 4](0225-external-agents-propose-memory-with-in-client-confirmation.md#premises)，原话和来源见那里。
6. 生效的规则在之后每次检查邮件时命中会记进决策记录的 `ruleHits`。来源 `packages/application/src/services/proactive-mail-check-service.ts:982` 原话 `ruleHits[item.messageId] = [...new Set(ruled)].sort().slice(0, 16);`。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **新工具 `propose_rule`，出现条件和 `propose_memory` 一样**：只给写令牌、只在 2026-07-28 版连接上注册、客户端没声明表单确认就拒绝、提议状态的签名和有效期、同一提议按编号排队，全部沿用 ADR 0225 决定 1 到 3。
   - 2026-11-11 起：其中「只给写令牌」由 [ADR 0227](0227-mcp-entry-checks-cloudflare-access-sign-in.md) 决定 1、3 取代。入口只认 Cloudflare Access 凭证并核对是绑定的主人，`propose_rule` 和 `propose_memory` 一样由配置 `runPolicy.mcpRead.proposals` 打开。本条原文保留不改。
   - 参数：`type`（前提 1 的两种之一）；`params`（`senderDomains` 发件域名、`senderAddresses` 发件地址、`phrases` 词语、`words` 英文整词、`excludePhrases` 排除词，五个字符串列表）；`summary`（一句话的规则说明）；`reason`（对方为什么提，例如 Andy 在那个客户端里说过的原话）。
   - 参数校验用 P2-3 同一个 `parseOwnerRuleParameters`；`reason` 按 ADR 0225 的规则去掉看不见的字符后要 1 到 200 个字符。不合格的直接回「参数不合法」，不弹框。
   - 2026-11-12 补：上面的“两种之一”和五个参数说的是现在这两种规则类型。以后声明了“外部可提”的新类型，`type` 能给的值和参数说明照类型自己的声明生成（[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 7 下面的补注）；现有两种不变。
2. **第一次调用只校验、不写。** 写入器新加 `preview`：只校验参数，算出试算例子和近 30 天的回放数字（P2-3 已有的回放），不存提议。确认框里给 Andy 看：对方自称的客户端名、规则说明、做法（一定提醒并推送，或先读完整个邮件串）、五项条件、回放数字（写明是估计；算不出来时直说看不到）、对方给的理由，一个勾选框「让这条规则生效」（这是 2026-11-11 之前的做法）。后续（2026-11-11，Hermes 实机验收后 Andy 选定）：去掉勾选框，确认框不带字段，同意（Accept）就生效、拒绝（Decline）不生效；说明以一句问话开头、正文紧跟在后面，避免 Claude Code 折叠成“+N more lines”；对方能写任意文字的值（正文、规则说明、理由、各项条件）各占一行、前面有固定标签：正文和理由里的换行和行分隔符换成空格，规则说明和条件里有就直接拒收，所以对方写不出另起一行的文字，但仍能在自己那一行里写出和固定说明一样的字；客户端名、分类、做法、回放数字分别受格式、固定选项和数字限制，和标签写在同一行。原因是验收时 Andy 两次想拒绝却勾上后按了 Accept，多一步勾选反而让人点错。另外，Claude 桌面 App 的 Code 标签声明支持确认框，却不显示它，约 10 毫秒后就自动回拒绝（[anthropics/claude-code#105334](https://github.com/anthropics/claude-code/issues/105334)，原话 “No dialog appears. About 10 ms later the client retries the call with: `"inputResponses": {"airavata_input": {"action": "decline"}}`”）。所以从确认请求发出到带答案的重发到达不到 1.5 秒（`MCP_PROPOSAL_UNSEEN_ANSWER_MS`，从工具开始处理带答案的重发时计，不含之后读库和同一提议排队的时间，网络往返和进入工具前的排队算在内；到达时间算不出来也按没显示出来处理；状态里的发出时间不是有效数字，按状态损坏回「内容变了」）的拒绝或取消，由 `mcpProposalAnswer` 判为 `unseen`：什么都不写、不记拒绝、不记为已拒绝，回「没显示出来」（`mcp.propose-not-shown`）；同一个确认状态之后仍可以真正同意或拒绝。P5-3 的待确认写入（ADR 0228，2026-11-11 已做）复用这个判定结果：判为 `unseen` 的记忆提议留在“待确认”里，等 Andy 在 Himawari 网页上确认。同意也一样（2026-11-11 晚补）：不到 1.5 秒就回来的同意也判为 `unseen`，什么都不写，回「没显示出来」的同一段文字，包括主人自己配了自动回答确认框的钩子，因为这么快回来的同意不可能是主人看过确认框后点的；自动回答如果等满 1.5 秒再回，仍会照常保存，这个判定挡不住。确认框不是防恶意客户端的边界：持有写令牌的客户端本来就能自己回答确认框，所以写令牌只该放在 Andy 自己用的客户端里（见「后果」）。
   - 2026-11-12 补：给 Andy 看的“做法”和条件，现有两种照上面写；以后声明了“外部可提”的新类型，照它自己声明的写法（[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 7 下面的补注）。
3. **Andy 同意后，才走 P2-3 的流程。** 先 `create`（标为推断，所以一定只存成提议，见前提 2、3），紧接着 `confirm` 这条提议，规则和规则类记忆由 P2-3 的 `#activate` 写入。拒绝、取消，什么都不写：不存提议、不写规则、不写记忆。（2026-11-11 前的版本还要求勾选，勾选框已去掉。）
   - 规则来源写 `mcp:<客户端名>`，不写 P2-3 的 `chat:<对话>`，规则手册里看得出是外部提议的。写入器的 `create` 多一个可选的 `source`，存在提议里，`#activate` 优先用它。
   - 规则类记忆的正文是「外部 agent「客户端名」提议：理由」加一行规则说明。
   - 同一组参数已有规则时，按 P2-3 的做法返回那一条并重新确认，不新建；那条规则保留原来的来源和规则类记忆，不改成外部提议。
   - 2026-11-12 起：决定 1 至 3 里「在客户端的确认框里确认」的部分由 [ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 9 取代：规则提议的确认也改到 Himawari 里做。能提的规则种类和之后走 P2-3 流程不变。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
   - 2026-11-12 再补：上一条说的“能提的规则种类不变”指现在登记表里的这两种。以后能提哪些，由每种规则类型自己声明是否“外部可提”（[ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 7 下面的补注）；登记表里加了声明外部可提的新类型，外部 agent 就能提它。
4. **同一个提议只生效一次，撤销后旧确认不会让它复活。** 前提 4 说明 P2-3 的确认本身会恢复已撤销的规则，而旧的确认状态只在发出它的进程里、10 分钟内有效（签名密钥每个进程随机生成），所以三处一起挡：
   - 服务在内存里记下这个提议已生效，保留到确认状态的有效期结束；同一进程里再收到这个提议的确认，直接回「之前已经处理过」。这一处覆盖所有情况，包括同一组参数已有规则、生效时复用了那一条的情况。
   - 生效后在载荷库写一条加密的标记 `rule-decision:mcp:<提议编号>`（内容是规则编号）。规则已经生效、只是标记没写成时，回「已生效」并记一条诊断日志，不说失败。
   - 重发时也查这条标记，再查这个提议对应的规则编号在规则手册里有没有（包括已撤销的，写入器新加 `storedFor`）；有一个在就回「之前已经处理过」，不再调 `confirm`。
5. **同时收到「生效」和「拒绝」只算一种。** 同一提议在进程里按编号排队（同 ADR 0225）。拒绝不写任何东西，所以服务在内存里记下被拒绝的提议编号，和决定 4 的生效记录放在一起、同样保留到确认状态过期；排在后面的「生效」看到它就回「没有同意」。进程重启后旧的确认状态全部验不过签名，所以内存里的记录够用。
6. **记忆页和来源报表认出外部提议的规则类记忆。** 这类记忆编号是 `memory:rule:mcp:<提议编号>`，和 `memory:mcp:` 一样归为「外部」。
7. **决策记录照 P2-3，不另加种类。** P2-3 的提议和生效本身不写决策记录，这里也不写；生效的规则之后每次检查邮件命中时照常记进 `ruleHits`（前提 6）。拒绝不写任何决策记录，和「拒绝就什么都不写」一致。
8. **工具说明和确认框文字登记进提示词目录**：`mcp.propose-rule`、`mcp.propose-rule-confirm` 和它用到的做法、条件、回放、结果文字（勾选项已于 2026-11-11 去掉）。客户端不支持确认框、服务没准备好、内容变了这三种回复沿用 `propose_memory` 的文字。Himawari 自己发给模型的请求一个字节都不变。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 写操作的确认照 MCP 规范用 elicitation，原因同 [ADR 0225](0225-external-agents-propose-memory-with-in-client-confirmation.md#industry)。
- 规则的写入、校验、回放和撤销复用 P2-3 的现成流程，外部提议和对话里的推断提议只差一个来源字段；不为外部入口另写一套规则存储。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **第一次调用就存成 P2-3 的提议，让 Andy 回网页上点「生效」。** 任务要求在客户端里确认；而且拒绝时会留下没人处理的提议。
- **只靠 P2-3 的 `confirm` 防重复。** 前提 4：撤销后旧确认会把规则恢复。
- **拒绝也写一条决策记录或标记。** 任务要求拒绝什么都不写；并发时的一致由决定 5 的内存记录保证。
- **允许外部提议偏好（`soft`）类规则。** P2-3 只接受主人原话的偏好；外部 agent 的转述不是原话，提议偏好用 `propose_memory`。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 信任范围同 ADR 0225：写令牌只该放在 Andy 自己用的客户端里。
- 客户端不支持确认框时直接拒绝；以后改成「先存成待确认」由 P5-3 做。
- 测试在 `test/integration/mcp-write.test.ts`，用真实 SQLite、真实 P2-3 写入器、真实回放服务和官方 SDK 客户端：
  - 确认后规则在规则手册里、状态生效、来源 `mcp:claude-code`，规则类记忆的正文写明外部提议；规则表达式对入管局的邮件命中、对无关邮件不命中；确认框里有说明、条件、理由和回放数字。
  - 拒绝、取消，规则手册和载荷库里都没有新东西（2026-11-11 前还测没勾选）。
  - 参数不合法、类型不认识、多出的参数直接报错，不弹框；只读令牌和老版本连接调不到；客户端不支持确认框时拒绝；回放算不出来时确认框直说。
  - 重复和并发重发只生效一次；撤销后删掉标记再重放旧确认，仍回「之前已经处理过」，规则保持撤销。
  - 同一组参数已有规则时复用那一条；撤销后删掉标记再重放第二个提议的确认，规则保持撤销（去掉内存里的生效记录，这条用例会失败）。
  - 只有标记写不进去时回「已生效」、记诊断，撤销后重放仍不复活（标记写失败改回报错，这条用例会失败）。
  - 参数键序、列表顺序不同算同一提议；词语只有 1 个字时报参数不合法。
  - `test/integration/memory-source-report.test.ts`、`apps/control-center/test/memory-source.unit.test.ts`：`memory:rule:mcp:` 归为外部，P2-3 对话里立的规则类记忆不受影响。
  - 同时收到生效和拒绝，两种到达顺序都只算一种（去掉内存里的拒绝记录，这条用例会失败）。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0225：外部 agent 提议新记忆，主人在客户端确认后才保存](0225-external-agents-propose-memory-with-in-client-confirmation.md)
- [ADR 0213：主人的一句话变成长期规则，由测过的规则类型执行](0213-owner-sentence-becomes-a-standing-rule.md)
- [ADR 0219：对外只读 MCP 入口，静态令牌鉴权](0219-read-only-mcp-entry-with-static-token.md)

[返回阅读导航](#contents)
