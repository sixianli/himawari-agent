---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amended_by: "docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md"
date: "2026-11-11"
covers: "apps/control-center/test/memory-source.unit.test.ts, packages/application/src/ports/decision-ledger.ts, packages/application/src/services/durable-memory-service.ts, packages/platform-node/test/startup-configuration.unit.test.ts, scripts/operations/memory-source-report.mjs, test/integration/mcp-write.test.ts, test/integration/memory-source-report.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0225：外部 agent 提议新记忆，主人在客户端确认后才保存

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

[ADR 0219](0219-read-only-mcp-entry-with-static-token.md) 给 Claude Code、Codex 这类外部 agent 开了一个只读的 MCP（Model Context Protocol，让 AI 客户端调用外部工具的开放协议）入口。任务 P5-2 要让外部 agent 也能往 Himawari 里写：提议一条新记忆，或提议一条新规则。每一次写入都要 Andy 在他正在用的客户端里点确认，拒绝就什么都不写，没有绕过确认的后门。Andy 在 2026-11-11 同意了变更清单（原文在 `/mnt/project-files/p5-2-mcp-write/change-list.md`）。

本 ADR 只管第一部分：提议新记忆的工具 `propose_memory`。提议规则要走任务 P2-3 的规则确认卡，等 P2-3 合并后另开 ADR。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 2026-07-28 版协议只准用「多轮请求」（MRTR，服务端回一个「需要输入」的结果，客户端带着答案重发同一个调用）向客户端提问，旧的服务端主动发请求方式作废。来源 <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr> 原话 “Servers **MUST** send server-to-client requests (such as … `elicitation/create`) using the MRTR pattern. The previous pattern of server-initiated requests is no longer supported.”
2. 客户端重发时原样带回服务端发出的 `requestState`（一段服务端自己编码的状态字符串）；服务端要防篡改，并自己保证只用一次。同一页原话 “servers **MUST** protect its integrity (e.g. HMAC or AEAD)”；“Servers for which a given `requestState` must be consumed at most once … **MUST** enforce that invariant server-side.”
3. 客户端没声明支持 elicitation（服务端请客户端向人要输入的功能）时，不能发确认请求。同一页原话 “if a client does not declare support for `elicitation`, the server **MUST NOT** include any `elicitation/create` requests”。
4. Claude Code 在 2026-07-28 版连接上声明表单确认。来源 <https://code.claude.com/docs/en/mcp>「Elicitation modes Claude Code declares」原话 “Claude Code declares `elicitation: {form: {}, url: {}}` on … Connections that use protocol revision 2026-07-28”；表单模式 “Claude Code shows a dialog with form fields defined by the server”。
5. 官方 SDK `@modelcontextprotocol/server` 2.0.0 默认不校验 `requestState`，老版本连接默认由「兼容垫片」改用旧方式主动发请求，可以关掉。来源 `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts` 原话 “The SDK applies no integrity protection by default”；“`false` disables the shim: an `input_required` return on a 2025-era request fails loudly”。
6. 新建记忆的现成写法遇到同编号、同内容会直接返回已有那条。来源 `packages/application/src/services/durable-memory-service.ts` 的 `applyProposal`，以及 `production-memory-control.ts` 的 `#create` 用 `id: memory:owner:${command.idempotencyKey}`。
7. 决策记录的 `memory_candidate` 类已经允许 `kept`、`discarded` 两种结果，不用改表。来源 `packages/application/src/ports/decision-ledger.ts` 里 `memory_candidate` 的结果列表，开头两项原话 `"kept",`、`"discarded",`。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **写操作用单独的令牌。** 新配置项 `runPolicy.mcpRead.writeSecretRef`，密钥用途写 `mcp-write`，必须和只读令牌不是同一把（配置解析和服务启动都会拒绝同一把）。
   - 拿只读令牌连上来，只看到 ADR 0219 的三个只读工具；拿写令牌连上来，多一个 `propose_memory`，读的工具也能用。
   - 理由：ADR 0219 按「只读」发出的令牌，升级后不该悄悄变成能写。依据「边界与可逆性」原则。
   - 两把令牌各有一个 `BearerGate`，各自限流。
   - 2026-11-11 起：本条由 [ADR 0227](0227-mcp-entry-checks-cloudflare-access-sign-in.md) 决定 1、3 取代。两把令牌都去掉，写工具由配置 `runPolicy.mcpRead.proposals` 打开。本条原文保留不改。
2. **确认按 2026-07-28 版的多轮请求做，不用旧的服务端主动请求。**
   - 第一次调用：服务端规范化正文，生成一个新的提议编号，回「需要输入」：一张表单，正文、分类、对方自称的客户端名都写在说明里，只有一个勾选框「保存这条记忆」（这是 2026-11-11 之前的做法）。后续（2026-11-11，Hermes 实机验收后 Andy 选定）：去掉勾选框，确认框不带字段，同意（Accept）就保存、拒绝（Decline）不保存；说明以一句问话开头、正文紧跟在后面，避免 Claude Code 折叠成“+N more lines”；对方能写任意文字的值（正文、规则说明、理由、各项条件）各占一行、前面有固定标签：正文和理由里的换行和行分隔符换成空格，规则说明和条件里有就直接拒收，所以对方写不出另起一行的文字，但仍能在自己那一行里写出和固定说明一样的字；客户端名、分类、做法、回放数字分别受格式、固定选项和数字限制，和标签写在同一行。原因是验收时 Andy 两次想拒绝却勾上后按了 Accept，多一步勾选反而让人点错。另外，Claude 桌面 App 的 Code 标签声明支持确认框，却不显示它，约 10 毫秒后就自动回拒绝（[anthropics/claude-code#105334](https://github.com/anthropics/claude-code/issues/105334)，原话 “No dialog appears. About 10 ms later the client retries the call with: `"inputResponses": {"airavata_input": {"action": "decline"}}`”）。所以从确认请求发出到带答案的重发到达不到 1.5 秒（`MCP_PROPOSAL_UNSEEN_ANSWER_MS`，从工具开始处理带答案的重发时计，不含之后读库和同一提议排队的时间，网络往返和进入工具前的排队算在内；到达时间算不出来也按没显示出来处理；状态里的发出时间不是有效数字，按状态损坏回「内容变了」）的拒绝或取消，由 `mcpProposalAnswer` 判为 `unseen`：什么都不写、不记拒绝、不记为已拒绝，回「没显示出来」（`mcp.propose-not-shown`）；同一个确认状态之后仍可以真正同意或拒绝。P5-3 的待确认写入（ADR 0228，2026-11-11 已做）复用这个判定结果：判为 `unseen` 的记忆提议留在“待确认”里，等 Andy 在 Himawari 网页上确认。同意也一样（2026-11-11 晚补）：不到 1.5 秒就回来的同意也判为 `unseen`，什么都不写，回「没显示出来」的同一段文字，包括主人自己配了自动回答确认框的钩子，因为这么快回来的同意不可能是主人看过确认框后点的；自动回答如果等满 1.5 秒再回，仍会照常保存，这个判定挡不住。确认框不是防恶意客户端的边界：持有写令牌的客户端本来就能自己回答确认框，所以写令牌只该放在 Andy 自己用的客户端里（见「后果」）。
   - 客户端带着 Andy 的答案和原样的 `requestState` 重发。同意（Accept）才写记忆；拒绝、取消都算没同意，只记一条拒绝的决策记录，但不到 1.5 秒就回来的回答（同意、拒绝、取消）按上面的后续说明判为没显示出来，不写也不记。（2026-11-11 前的版本还要求勾选保存，勾选框已去掉。）
   - `requestState` 用官方 SDK 的 `createRequestStateCodec` 加 HMAC，有效期 10 分钟，绑定调用的方法名（`tools/call`）和令牌种类；工具名、提议编号、参数哈希、确认框里显示的客户端名和发出确认请求的时间（`askedAt`，只用于上面的 1.5 秒判定，不写库）写在签了名的状态里，重发时核对前三项，决策记录用状态里的客户端名，不用重发时对方报的名字。签名密钥在进程启动时随机生成 32 字节，不从令牌派生，所以拿到令牌的人也伪造不了状态。代价是服务重启后正在等确认的提议失效，重新提议即可（生产是单进程）。
   - SDK 选项里关掉兼容垫片（`legacyShim: false`），老版本连接上不注册写工具。
   - 2026-11-11 起：本条的取消处理由 [ADR 0228](0228-external-memory-proposals-wait-for-owner-confirmation.md) 决定 3 取代。取消和判为 `unseen` 的回答不再只记拒绝或什么都不写，而是让提议留在「待确认」里；拒绝（Decline）仍记为已拒绝。
   - 2026-11-12 起：在客户端里确认的做法由 [ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 6、9 取代：`propose_memory` 换成 `sync_memories`，确认统一在 Himawari 里做，默认仍然每条都要 Andy 确认。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
3. **同一个提议只写一次。**
   - 记忆编号是 `memory:mcp:<提议编号>`，正文存在 `memory-content:mcp:<提议编号>`。
   - 重发时先看决策记录里这个提议是否已有「保存」或「拒绝」，再看记忆本身是否存在（包括已删除、回收站里的）；有结论就直接回已有结论，不再写。
   - `requestState` 里存了正文和分类的哈希（按固定字段顺序算）；重发时参数和状态不符，回「内容变了」，不写。
   - 同一个提议的重发在服务里按提议编号排队，一次只处理一个：前一个做完决定，后一个才去查「已决定」。所以同时收到「保存」和「拒绝」时，只有先处理的那个生效，后面的都回已有结论。这只在一个进程里成立；签名密钥本来就只在这个进程里有效，服务重启后旧状态全部失效，所以不会有两个进程处理同一个提议。
   - 2026-11-11 起：本条由 [ADR 0228](0228-external-memory-proposals-wait-for-owner-confirmation.md) 决定 2、3 部分取代。第一次调用就存一条「待确认」提议；同一正文去重改为看提议表里的正文摘要，已保存的回「已经保存过」，已拒绝的回「拒绝过」。
   - 2026-11-12 起：本条由 [ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 6 取代：`sync_memories` 里同一个稳定编号可以重复推，内容没变不产生任何东西，内容变了算更新并留历史。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
4. **决策记录。** 类别 `memory_candidate`。保存记 `kept`、原因码 `mcp_proposal_kept`、`subjectRef` 是记忆编号；拒绝记 `discarded`、原因码 `mcp_proposal_declined`、`subjectRef` 是 `mcp-client:<客户端名>`。正文不进决策记录（`contentRef` 为空）。
   - 拒绝写不进决策记录时，回工具错误，不说「已拒绝」。
   - 每日回顾显示保存的那条，跳过主人拒绝的，和主人在网页上拒绝的提议同样处理。
   - 自动记忆的校准（统计自动记忆门槛准不准的样本）排除这两种原因码：这些记忆不是 Himawari 自己判断要记的，混进去会让统计失真。
5. **正文和分类。**
   - 正文先规范化：NFC，把控制字符、Unicode 格式字符（零宽字符、双向排版字符、软连字符这类看不见的字符，即 `\p{Cf}`）、落单的代理项（不成对的 UTF-16 半个字符，存储时会变成替换字符，所以先换成空格，确认框和存下的正文才一致）和行、段分隔符换成空格，合并连续空格，去掉首尾空白；规范化后要 1 到 2000 个字符。确认框、存储和哈希都用规范化后的同一份。工具参数说明里不写长度上限，长度只按规范化后的正文算，否则一段原文超长、规范化后合格的正文会被 SDK 先挡掉，拿不到说明。
   - 分类只能选九种之一（身份、偏好、关系、目标、项目、健康、财务、事件、其他），不能选「规则」：规则走另一条路。
   - 健康、财务两类按敏感记忆保存；其他类别正文里有证件号这类标识时，也按敏感保存，判断交给 `@himawari-agent/sensitive-capture` 的 `classificationWithIdentifiers`。确认框里会提示「会按敏感记忆保存」。
   - 重要度固定 500，置信度 1000，不是推断。
6. **客户端不支持确认框时，直接拒绝，不写。** Andy 在 P5-3 里同意了以后改成「先存成待确认，Andy 批量确认」，那部分由 P5-3 做；这里只把这个分支单独写成一处，方便替换。
   - 2026-11-11 起：本条由 [ADR 0228](0228-external-memory-proposals-wait-for-owner-confirmation.md) 决定 3 取代。客户端不支持确认框、记忆本没准备好时，提议留在「待确认」里，等 Andy 在 Himawari 网页上确认。
   - 2026-11-12 起：本条由 [ADR 0242](0242-external-agents-join-the-memory-hub-through-one-entry.md) 决定 9 取代：不再区分客户端支不支持确认框，一律进 Himawari 的待确认。对应的编码任务合并之前，代码仍按本条。本条原文保留不改。
7. **网页和运维报表认出这类记忆。** 记忆页的来源显示「外部 agent 提议、主人确认的」（三种语言），重要度标为主人定的；`scripts/operations/memory-source-report.mjs` 多一类 `external`。
8. **工具说明和确认文字登记进提示词目录**：`mcp.propose-memory`、`mcp.propose-memory-confirm` 和十个结果文字。Himawari 自己发给模型的请求一个字节都不变。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- MCP 规范给写操作确认的标准做法就是 elicitation（前提 1、3），Claude Code 会弹出服务端定义的表单（前提 4）。我们照规范做，不自造确认通道。
- ChatGPT 和 Claude 的记忆只接受自家客户端写入，没有外部写入口；它们的「保存记忆」在自家界面里提示用户。这里的确认框起同样的作用，只是出现在外部客户端里。
- 写操作的结论放在服务端：客户端只负责把问题给人看，改不了服务端的判断。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **读写共用一把令牌。** 放弃原因见决定 1。
- **从令牌派生签名密钥。** 拿到令牌的人就能伪造 `requestState`，跳过确认。
- **新建一张提议状态表。** 要改表排队；决策记录、记忆状态和失败时关闭已经能保证只写一次。
- **每日写入配额。** 每条都要 Andy 亲手确认，写令牌单独发，并且有每分钟 30 次的限流；配额挡不住令牌泄露。以后需要时再加。
- **按正文哈希做提议编号。** 拒绝过的正文就再也提不了，还能用来探测某条记忆是否存在。
- **提议时先写一条「待确认」记录。** 没确认的提议会在每日回顾里留下悬空条目。P5-3 的待确认存储会另行设计。
- **取消和拒绝分开记。** 两者都是「没同意」，结果一样，都不写记忆。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 信任范围：拿到写令牌的人，如果自己就是客户端，可以自己回答确认框。所以写令牌只该放在 Andy 自己用的客户端里；它和只读令牌分开，可以单独撤销。
- 服务重启会让正在等确认的提议失效：旧的 `requestState` 验不过签名，客户端收到错误，需要重新提议。
- 只在交互会话里有确认框；Claude Code 的非交互模式不弹框，这时按决定 6 拒绝。
- 提议规则（`propose_rule`）等 P2-3 合并后另开 PR 和 ADR。后续：已由 [ADR 0226](0226-external-agents-propose-rules-through-the-rule-proposal-flow.md) 实现。
- 测试：
  - `test/integration/mcp-write.test.ts` 用真实 SQLite、真实记忆服务和官方 SDK 客户端：只读令牌看不到写工具、老版本连接看不到写工具；确认后保存，并能被 `find_memories` 找到；拒绝、取消都不写（2026-11-11 前还测没勾选）；客户端不支持确认框时不写；并发和重复重发只写一条；同一提议同时收到保存和拒绝只记一种结论（把读取放慢制造竞争，去掉排队这条用例会失败）；看不见的字符先去掉再算长度；参数键序不同算同一提议；篡改过的状态被拒；状态拿去配别的内容回「内容变了」；硬删除后重放不会复活；拒绝记录写不进去时回错误；每日回顾和校准的处理。
  - `test/integration/memory-source-report.test.ts`：报表认出 `external`，前缀和网页一致。
  - `apps/control-center/test/memory-source.unit.test.ts`：网页把这类记忆的来源显示为外部提议，不算「来源已不可查」。
  - `packages/platform-node/test/startup-configuration.unit.test.ts`：`writeSecretRef` 只接受一把用途是 `mcp-write`、和只读令牌不同的密钥（已被 [ADR 0227](0227-mcp-entry-checks-cloudflare-access-sign-in.md) 取代：固定令牌和这两个配置项都已去掉）。
  - 没有自动测试的地方：`requestState` 过期（SDK 用的是真实时钟，测试里拨不动），以及老版本连接上的 `legacyShim: false` 兜底（写工具根本不在老版本连接上注册，碰不到那一步）。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0219：对外只读 MCP 入口，静态令牌鉴权](0219-read-only-mcp-entry-with-static-token.md)
- [ADR 0143：模型门槛决策的决策记录](0143-decision-ledger-for-model-gate-decisions.md)
- [决策记录写入约定](../execution/specs/2026-11-09-decision-record-write-convention.md)

[返回阅读导航](#contents)
