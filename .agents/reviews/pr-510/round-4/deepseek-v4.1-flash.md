## 复核范围

本轮只核对 `8620bd5687de442a2aa4052d7fe65ec98afa0199..def372b2dda64ad40b6f2e1c4a1342cf351cff8a` 的增量，并顺着证据回看 PR 510 的搜索代码：

- 增量只有两个提交：`9612f77d2`（把 `origin/main` 并入 PR 510）和 `def372b2d`（biome 格式化）。
- `def372b2d` 只改 `production-approval-gateway.ts`，我逐行看了 `git show`：全部是换行、缩进和 import 合并，条件与分支没有语义变化。
- `9612f77d2` 的冲突只在 `production-approval-gateway.ts`；`git show --cc` 显示合并结果同时保留 `search.ask.read` 路由和 `proposals.*` 路由，`production-http-composition.ts`、`service-main.ts`、`contracts-v2.ts` 等文件是干净合并。
- 其余大量文件是 main 上已有的提案、主人意图、感知、用量限额等改动，不属于 PR 510。我只核对了这些增量值在搜索/网关直接使用端是否自洽，没有整份重审 main 的新功能。

上一轮“成立且已修改”的意见清单为空，本轮没有可逐条验证的旧错误。

## 意见

### 1 低：MemoryEpisodeService 的 lexicalOnly 缺少“不调 embedder”的反向测试

- 文件:行：`packages/memory-engine/src/episodes.ts:308`；`apps/agent-service/test/production-search.unit.test.ts:256`；对照 `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:277-290`
- 问题：作者说“lexicalOnly 为真时 HybridMemoryProvider 和 MemoryEpisodeService 都不调 embedder”。代码确实两边都写成 `input.lexicalOnly === true ? null : embedder`，但只有 Hybrid 有反向单测：既断言 `embedQuery` 没被调用，又断言不传 lexicalOnly 时会被调用。Episode 只被断言“把 `lexicalOnly: true` 传下去了”，没有断言 `MemoryEpisodeService` 层真的不调用 embedder。若 `episodes.ts:308` 以后被改坏，现有测试不会红。
- 证据：
  - `production-search.unit.test.ts:256`：`expect(f.episodeSearch.mock.calls[0]?.[0]).toMatchObject({ lexicalOnly: true });`
  - `hybrid-memory-provider.unit.test.ts:286-289`：`expect(lexical.embedder?.embedQuery).not.toHaveBeenCalled(); ... await lexical.search({ ... }); expect(...).toHaveBeenCalledTimes(1);`
- 建议：给 `MemoryEpisodeService` 补一条与 Hybrid 对称的单测：带 `lexicalOnly: true` 时 embedder 的 `embedQuery` 调用次数为 0，不带时调用一次。

### 2 低：basisLimit 大于 1 时，“依据”可能包含与最终答案无关的候选

- 文件:行：`apps/agent-service/src/production-search.ts:301-304`、`319-325`；`packages/application/src/ports/configuration.ts:251-257`
- 问题：答案固定取 `ranked[0]`，但依据是 `ranked.slice(0, settings.basisLimit)`。配置允许 `basisLimit` 到 10，因此界面可能把覆盖率更低的、甚至不是答案来源的记忆/对话列成这条答案的依据。默认 `basisLimit: 1` 时不会发生。
- 证据：
  - `production-search.ts:304`：`const best = ranked[0];`
  - `production-search.ts:319`：`basis: ranked.slice(0, settings.basisLimit).map(({ basis }) => ({`
  - `configuration.ts:251-257`：`basisLimit: 1` 为默认值。
- 建议：依据只取与 `best` 覆盖率相同的候选，或者把该字段明确为“候选来源”并在界面文案上区分；至少不要默认扩大到与答案无关的候选。

### 3 低：一次问答会逐条读取并解密最多 candidateLimit 条完整原文，建议路径会扫描全部活跃记忆

- 文件:行：`apps/agent-service/src/production-search.ts:229-268`、`186-206`；`packages/application/src/ports/configuration.ts:251-257`
- 问题：`candidateLimit` 允许到 200。每条命中都要 `readText`（取 payload、解保护、UTF-8 解码）并对完整文本做 coverage；无答案时还会再搜对话摘要。空查询（建议）会 `listActive` 全量记忆后遍历实体。默认 `candidateLimit: 20`、`askLimit: 0` 时影响小，但一旦调大，单次请求的 IO/CPU 没有单独的字节或时间上限。
- 证据：
  - `production-search.ts:255`：`const text = singleLine((await this.#options.readText(memory).catch(() => "")) ?? "");`
  - `production-search.ts:186`：`const active = await this.#options.state.listActive(ownerId, agentId);`
  - `production-search.ts:196-197`：对每条记录的每个实体做遍历。
- 建议：给一次查询设定读取总字节/总条目的硬上限，或在 `listActive` 层做分页/限制；这些上限也应可配置并与 `candidateLimit` 分开。

### 4 低（推测，未核实）：新增快照的 `basis.memoryId` 走 `machineString`，而记忆 id 理论上可能超过 128

- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:970-975`；`packages/gateway-contracts/src/validation.ts:49-62`；`apps/agent-service/src/production-memory-control.ts:1555`
- 问题：搜索快照把 `memory.id` 原样放进 `basis[].memoryId`，契约要求 `machineString`（最长 128、且符合字符集）。而主人新建记忆的 id 是 `memory:owner:${command.idempotencyKey}`，命令信封的 `idempotencyKey` 本身允许到 128 字符，拼接后可达 141 字符，理论上会让搜索快照校验失败。
- 证据：
  - `validation.ts:49-58`：`MACHINE_STRING_MAX_LENGTH = 128`，`input.length > MACHINE_STRING_MAX_LENGTH` 即失败。
  - `production-memory-control.ts:1555`：`id: \`memory:owner:${command.idempotencyKey}\` as MemoryId,`
- 说明：`memory.basis.read` 等既有接口同样用 `machineString` 接收 memoryId，所以这不是搜索新增的独有风险；我也没有核实实际设备是否会用接近 128 字符的 idempotencyKey，故标为推测。
- 建议：确认 idempotencyKey 的实际长度上限；若确有可能超长，记忆 id 生成时统一限长，或给 memoryId 使用与 `machineString` 不同的、明确允许该前缀长度的 schema。

## 侧重检查

- **错误路径**：`readText` 单条失败被 `.catch(() => "")` 吞掉并跳过该候选（`production-search.ts:255`）；对话摘要搜索失败转空数组（`production-search.ts:281`）；但 `provider.search`、`state.readMany`、`listActive` 失败会直接抛给网关，不会伪装成 `not_found`。这是读代码证实的行为，未见新增吞错。
- **不可信输入**：查询在契约里被限制为 `nullable(boundedString(500))`、`locale` 是枚举（`contracts-v2.ts:959-962`）；服务端再经 `singleLine` 去掉控制字符和空白（`production-search.ts:128-130`）；分词进 FTS 时引号被转义且最多取 64 个词（`sqlite-memory-operations.ts:185-191`）。未发现可注入路径。
- **敏感、过期、待确认记忆**：`SEARCH_VISIBLE = ["public","private"]` 排除 sensitive/restricted；`currentlyShown` 排除 `supersededBy`、`tentative`、`validTo <= now`（`production-search.ts:114-126`）。读代码证实；单测也覆盖了敏感、过期、被取代、待确认四种反向用例。
- **不触发模型请求**：Hybrid 和 Episode 在 `lexicalOnly === true` 时都把 embedder 置 null（`hybrid-memory-provider.ts:152`、`episodes.ts:308`）；service-main 装配的 provider 就是 `memoryComposition.projection`（`service-main.ts:3081-3092`），即带 embedder 的 Hybrid。搜索路径没有其他 `embedQuery` 调用。
- **资源耗尽**：见意见 3；路径成立，严重度取决于配置，默认值下影响有限。
- **不可撤销操作**：`search.ask.*` 是只读查询，没有写库或删除动作。
- **规则与文档一致性**：仓库内没有描述 `search.ask` 的文档，因此不存在“文档说了一套、代码做了一套”的问题；PR 说明里的三条说法与代码一致（见下）。增量里的规则文档改动（`.claude/rules/owner-standing-rules.md`、`docs/architecture-v0.1.md` 等）属于 main 的提案/主人意图功能，不在 PR 510 范围，我未审。

## 作者说法核对

- **“lexicalOnly 为真时 HybridMemoryProvider 和 MemoryEpisodeService 都不调 embedder”**：属实。`hybrid-memory-provider.ts:152` 与 `episodes.ts:308` 都是 `input.lexicalOnly === true ? null : this.#options.embedder`。但自动检查只完整覆盖了 Hybrid（见意见 1）。
- **“answer 要求查询词覆盖率不低于配置值”**：属实。`production-search.ts:224-225` 取 `queryTerms` 和 `minimumCoveragePercent/100`，`256-257`、`285-286` 对 `matched < minimum` 直接跳过。默认 `minimumCoveragePercent: 50`，即覆盖率需 ≥ 50%。
- **“建议问题默认 0 条”**：属实。`DEFAULT_SEARCH_ASK.askLimit = 0`（`configuration.ts:251-257`），`#suggestions` 在 `settings.askLimit === 0` 时直接返回空（`production-search.ts:185`）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。PR 510 只新增网关查询和设备能力，不进入系统提示、工具定义、历史或遮盖逻辑；增量也没有改任何提示组装代码。搜索本身不调模型。发给模型的内容仍按既有规则只在末尾追加。依据：[prompt-prefix.md#rules](../../.agents/instructions/prompt-prefix.md#rules)。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及模型输入。搜索响应里的 `generatedAt` 和依据日期标签确实依赖 `now`/`timeZone`，但它们是给设备的快照，不是发给模型的内容；建议列表的排序也固定为 uses、updatedAt、名称（`production-search.ts:207-213`），不是无序集合。
3. **有没有对应的自动检查，反向用例真的会失败？** 有：`production-search.unit.test.ts` 覆盖回答、多语言依据、敏感/过期/被取代/待确认不显示、覆盖率不足返回 not_found、默认不建议、长度/控制字符、配置上限；`device-gateway.test.ts:563-645` 覆盖设备通道和未装配搜索时不可用；`startup-configuration.unit.test.ts:1104-1131` 覆盖配置边界和未知键。反向断言是实质性的（例如敏感记忆必须 `not_found`、无建议时 `listActive` 不得被调用）。缺口是 Episode 的 lexicalOnly 只有正向传参断言（意见 1）。按约束我没有运行测试，以上是读断言得出的结论。
4. **每个产出值的使用端都能接受吗？** 搜索侧：`search.ask.read`/`search.ask.snapshot` 同时进了 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、客户端能力表、契约夹具和网关路由；`search.ask.read` 能力项与设备测试一致；`candidateLimit/basisLimit/askLimit/answerCharacters/minimumCoveragePercent` 在 `strict-configuration.ts` 解析、默认值和 `production-search.ts` 使用端字段一一对应。增量侧：`PROPOSAL_ACTIONS` 与 `ProductionProposalBox.adopt/reject` 一致，`PROPOSAL_ORIGINS` 与 SQLite 的 `ORIGINS`（`sqlite-owner-proposal-operations.ts:15`）一致；`proposals.read`/`proposal.respond` 在消息类型、schema、客户端能力、网关路由和 `ProductionProposalControl` 之间一致；设备通道把命令 actor 设为 `owner`（`device-gateway.ts:208`），满足 `ProductionProposalControl.execute` 对 `actorType === "owner"` 的要求。唯一的不确定项是 `basis.memoryId` 的 `machineString` 长度上限（意见 4，推测且既有接口同样存在）。
