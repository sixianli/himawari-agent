说明：本轮已达到工具调用上限，以下结论完全基于已读代码，未运行任何测试或 typecheck；凡依赖 `node_modules` 的 SDK 行为均标「未核实」。

## 结论（按严重度）

### 1. 中：同一提议并发收到「同意」和「拒绝」时，两个结论都会落账
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:394-404`、`apps/agent-service/src/production-mcp-memory-writer.ts:104-117,185-199`
- 问题：`decided()` 查到无结论后，`keep()` 和 `decline()` 都继续执行；两条路径没有按 proposalId 做互斥。并发时可能既写出一条 `kept` 记忆，又写出一条 `mcp_proposal_declined` 决策记录；之后 `decided()` 先查 `kept`，返回「已保存」。这使「拒绝就什么都不写」在并发冲突答案下不成立，审计上也会出现同一提议一 kept 一 declined。
- 证据：
  - `production-mcp-read.ts:394-404`：`const decided = await proposals.decided(state.proposalId);` 之后直接 `await proposals.keep(...)` 或 `await proposals.decline(...)`。
  - `production-mcp-memory-writer.ts:104-116`：`decided()` 只读两条固定 id 的账本行或记忆是否存在，没有锁或 CAS。
  - `production-mcp-memory-writer.ts:185-199`：`keep()` 与 `decline()` 都直接写各自决策记录。
- 建议：按 proposalId 做服务端互斥（同一事务/唯一决策行/条件更新），或让 `decline()` 在发现 `kept` 已存在时变成无条件幂等空操作，并补一条「accept 与 decline 并发」的测试。该问题只能由持有写令牌的客户端制造，且它本来就能自行 accept，所以严重度定为中而非高。

### 2. 中：`legacyShim: false` 没有真正的反向用例，现有老版本测试去掉该设置也会通过
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:256`、`test/integration/mcp-write.test.ts:302-309`
- 问题：ADR 声称老版本连接不能走旧的服务端主动请求方式，但自动测试只验证「老版本连接的工具列表里没有 `propose_memory`，调用它会报错」。由于写工具本来就没注册，即使删掉 `inputRequired: { legacyShim: false }`，未注册工具仍会报错，测试依旧通过。该安全行为没有任何自动检查。
- 证据：
  - `production-mcp-read.ts:256`：`inputRequired: { legacyShim: false },`
  - `mcp-write.test.ts:302-309`：`const legacy = await f.connect({ era: "legacy" });` 后断言工具列表只有只读三个，并 `await expect(legacy.callTool({ name: "propose_memory", ... })).rejects.toThrow();`
  - ADR 0225:118 自己写明「老版本连接上的 `legacyShim: false` 兜底……碰不到那一步」。
- 建议：增加一个只在测试中注册、会返回 `inputRequired` 的探针工具，用 legacy 客户端调用并断言其「响亮失败」而不是被兼容垫片改写；或直接对 server 选项做可观测断言。若做不到，至少在 ADR 和测试名里明确这是「未覆盖」。

### 3. 中低：已有 payload 只比较分类，不比较正文摘要；一旦 contentRef 复用，确认框看到的内容可能与实际保存内容不同
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:206-210`
- 问题：`#storeText()` 发现 `contentRef` 已存在时，只检查 `dataClassification` 相同就返回，不校验正文/摘要。当前靠 `randomUUID()` 生成的 proposalId 和 requestState 里的 `argsHash` 堵住了正文替换，所以不是现成可利用漏洞；但这是安全关键路径上的弱校验，未来若 proposalId 生成策略改变或出现 contentRef 碰撞，会把「确认的是 A、保存的是 B」变成可能。
- 证据：
  ```
  const existing = await this.#options.payloads.get(contentRef);
  if (existing) {
    if (existing.dataClassification !== dataClassification)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MCP_PROPOSAL_CONTENT_CHANGED");
    return;
  }
  ```
  （`production-mcp-memory-writer.ts:206-210`）
- 建议：对已有 payload 校验 `contentDigest`，或对同 ref 的已有内容与本次规范化正文做一致性检查；不一致时返回 `MCP_PROPOSAL_CONTENT_CHANGED`。

### 4. 低：`requestState` 校验在 try 之外，被篡改/过期时不会走 `onFailure` 诊断
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:367-368`
- 问题：`context.mcpReq.requestState<ProposalState>()` 在 `try {` 之前调用。篡改或过期状态导致的异常直接抛给上层，不经过 `this.#options.onFailure(error)`，不会记录 `mcp-read.failed` 诊断；这对排查客户端重放/过期问题不利。
- 证据：
  ```
  const state = context.mcpReq.requestState<ProposalState>();
  try {
  ```
  （`production-mcp-read.ts:367-368`）
- 建议：把取 state 放进 try，或在 catch 外层单独记录诊断后再抛；同时注意不要把状态原文写日志。

### 5. 低：不可见字符清洗没有覆盖全部格式字符，也没有处理行/段分隔符
- 文件:行：`apps/agent-service/src/production-mcp-memory-writer.ts:39,52-53`
- 问题：`INVISIBLE_FORMATTING` 覆盖了 `\p{Cc}`、U+200B–U+200F、U+202A–U+202E、U+2060–U+2069、U+FEFF，但没有覆盖 U+00AD（软连字符）、U+061C、U+180E 等 `Cf`，也没有 U+2028/U+2029（行/段分隔符）。确认框的防伪装意图因此是不完整的：外来 agent 仍可能插入不可见字符或制造额外换行。
- 证据：`const INVISIBLE_FORMATTING = /[\p{Cc}​-‏‪-‮⁠-⁩﻿]/gu;`（第 39 行）以及 `text.normalize("NFC").replace(INVISIBLE_FORMATTING, " ")...`（第 53 行）。
- 建议：改为显式覆盖 `\p{Cf}` 加 U+2028/U+2029（若不想删换行，可把它们替换为空格并单独说明），并补一条含软连字符/行分隔符的单元测试。

### 6. 低：工具 schema 的 `maxLength` 作用在规范化之前，和实际校验口径不一致
- 文件:行：`apps/agent-service/src/production-mcp-read.ts:323,354-363`
- 问题：schema 对原始 `text` 做 `maxLength: 2000`，而 handler 对 NFC + 清洗后的文本按 Unicode 码点判断 `[...text].length > 2000`。原始文本超过 2000 但规范化后合规时，会在 SDK 校验阶段被拒，拿不到 `MCP_PROPOSE_MEMORY_INVALID` 的友好说明。
- 证据：`text: { type: "string", minLength: 1, maxLength: EXTERNAL_PROPOSAL_TEXT_MAXIMUM }`（第 323 行）；`if (text.length === 0 || [...text].length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM || ...)`（第 358-362 行）。
- 建议：把 schema 上限放宽到原始文本的安全上界（例如按 UTF-16 留余量），最终仍以规范化后的码点数为准；或在说明中写清这是原始长度限制。

### 7. 低：配置了 `writeSecretRef` 但找不到对应密钥时，写工具会静默消失
- 文件:行：`apps/agent-service/src/service-main.ts:1767-1772,1776-1796,2176-2177`
- 问题：`mcpWriteSecret` 找不到时，`ProductionMcpRead` 仍会以只读方式构造；启动检查只验证 `mcpRead` 是否构造成功，不验证「配置了写令牌但没接上写工具」。正常经过 `parseProductConfiguration` 时写引用必被校验，所以生产不容易触发；但这是错误路径上的静默降级，未来重构或测试直接构造配置时容易踩到。
- 证据：`const mcpWriteSecret = mcpReadConfiguration?.writeSecretRef ? ...find(...) : undefined;`（1767-1772）；`...(mcpWriteSecret ? { write: {...} } : {})`（1780-1796）；`if (configuration.runPolicy?.mcpRead !== undefined && !mcpRead) throw new Error("MCP_READ_RUNTIME_UNAVAILABLE");`（2176-2177）。
- 建议：增加 `if (mcpReadConfiguration?.writeSecretRef && !mcpWriteSecret) throw new Error("MCP_WRITE_RUNTIME_UNAVAILABLE")`，或在 ADR 里明确这是有意静默降级。

### 8. 低：文档与代码/其他 ADR 有漂移
- 文件:行：`docs/adr/0225-external-agents-propose-memory-in-client-confirmation.md:59`（实际文件名见仓库）、`docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53`、`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:44`
- 问题：
  - ADR 0225 说 requestState「绑定工具名和令牌种类」，代码的 `bind` 是 `` `${context.mcpReq.method}\0${context.http?.authInfo?.clientId ?? ""}` ``（`production-mcp-read.ts:235`）；工具名实际放在签名 payload 的 `state.tool` 里校验（同文件 380-387），不是 `bind` 的一部分。
  - ADR 0143 仍把 `memory_candidate` 的丢弃原因列为固定的几种，没有列新增的 `mcp_proposal_declined`。
  - ADR 0186 的「依次判断」分类顺序没有 `external`，而代码和报表把 `external` 插在 owner 之后、source_thread 之前。
  - ADR 0225 前提 6 引用 `DECISION_OUTCOMES.memory_candidate` 为 `["kept","discarded","pending_approval"]`，实际代码已有 `capture_retrying/capture_queued/capture_gave_up`（`packages/application/src/ports/decision-ledger.ts:44-58`）。
- 证据：上述行；`production-mcp-read.ts:235`；`production-mcp-memory-writer.ts:23-24`；`apps/control-center/src/memory-source.ts:22-24`；`scripts/operations/memory-source-report.mjs:21-23`。
- 建议：修正 ADR 0225 的 bind 描述；在 ADR 0143 增加两种新原因码；在 ADR 0186 的分类顺序中加入 `external`，并注明它与 ADR 0225 的关系。

### 9. 低（可能触发 lint）：`daily-review.ts` 对同一模块重复 import
- 文件:行：`packages/application/src/services/daily-review.ts:6-7`
- 问题：同一个 `../ports/decision-ledger.js` 被连续 import 两次；功能无影响，但可能触发 Biome 的重复 import 规则。是否真的导致 `npm run lint` 失败「未核实」。
- 证据：第 6 行原有的多行 import 结束后，第 7 行又 `import { EXTERNAL_PROPOSAL_REASON_CODES } from "../ports/decision-ledger.js";`。
- 建议：合并到同一 import 块。

## 读代码证实的正向核对（不是问题，供交叉验证）

- 写令牌与只读令牌分离：`strict-configuration.ts:1104-1115` 新增 `writeSecretRef`，同 ref 直接拒绝；`service-main.ts:1767-1772` 用 `MCP_WRITE_SECRET_PURPOSE` 查找；`ProductionMcpRead` 构造函数 `production-mcp-read.ts:222-223` 对解析后的密钥值再拒绝一次；启动配置测试 `startup-configuration.unit.test.ts:1495-1524` 覆盖同 ref、错 purpose、缺失、非字符串。
- 只读令牌看不到写工具：`production-mcp-read.ts:310-315` 只在 `proposals && context.era === "modern" && context.authInfo?.scopes.includes(WRITE_ACCESS)` 时注册；`admit()` 在 242-248 行按写令牌命中与否赋 scope。测试 `mcp-write.test.ts:289-311` 覆盖只读/写/老版本三种连接。
- 记忆 ID 和 payload ref 能过后端校验：`memory:mcp:<uuid>` 通过 `packages/domain/src/identifiers.ts:39` 的 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`，也通过 gateway 的 `machineString`（`packages/gateway-contracts/src/validation.ts:49-59`，允许冒号/连字符）；`memory-content:mcp:<uuid>` 在 `putPayload`（`sqlite-durable-operations.ts:1695-1701`）只做唯一性检查，无格式限制，检索端要求 `text/plain` 也满足。
- 决策记录两端校验：`mcp_proposal_kept`/`mcp_proposal_declined` 长度合规；`outcome` `kept`/`discarded` 在 `DECISION_OUTCOMES`（`decision-ledger.ts:44-58`）和当前 DB CHECK（`migrations/0088_memory_capture_backlog.sql:64-75`）里都允许；`reason_code` 在 DB 只限 1–64 字符（同文件 35 行）；`ledger:mcp-proposal:<uuid>:declined` 长度约 65，未超 128（同文件 18 行）。
- 每日回顾和校准的消费端都接受新值：`daily-review.ts:245-248` 用常量集合跳过 declined；`calibration/src/index.ts:640,655-656` 用 `LIKE 'mcp!_proposal!_%' ESCAPE '!'` 排除两种原因码；`mcp-write.test.ts:489-518` 用真实账本断言 kept 出现在回顾、declined 不出现、校准查询里没有 memory_candidate。
- 来源前缀消费端一致：写入端 `production-mcp-memory-writer.ts:23`、网页 `apps/control-center/src/memory-source.ts:4,24`、报表 `scripts/operations/memory-source-report.mjs:23` 都是 `memory:mcp:`；`test/integration/memory-source-report.test.ts:31-43` 三处交叉锁定；三种语言都增加了 `external` 分支。
- 正文、分类、哈希都用同一份规范化文本：`production-mcp-read.ts:354-366` 先 `normalizeProposalText`，再算 `argsHash`，再传给确认框；`mcp-write.test.ts:408-423` 覆盖键序不同算同一提议。

## 侧重检查

- 错误路径：`#proposeMemory` 的 keep/decline/ledger 错误都落在 catch，返回 `MCP_PROPOSE_MEMORY_FAILED` 且 `isError: true`；拒绝写账失败有专门测试（`mcp-write.test.ts:480-487`）。未覆盖：`requestState` 校验异常不经过 `onFailure`（第 4 条）；`keep()` 在 `applyProposal` 已经写入记忆但后置账本读取/追加失败时，会先回 FAILED，重试再回 ALREADY_SAVED，可能与「保存必有一条 kept 记录」不完全一致（该后置追加在正常事务路径上通常已被 `saveWithProjection` 覆盖，属边缘）。
- 不合规范/不可信输入：正文有长度、空串、分类白名单、NFC、控制/零宽/双向字符清洗；工具 schema 还有 `additionalProperties: false`。但清洗集不全（第 5 条），且 `maxLength` 口径在规范化之前（第 6 条）。`client` 名由 `CLIENT_NAME` 限制为 64 个 `[A-Za-z0-9._/-]`，不会注入 subjectRef。
- 安全：写令牌独立、构造函数防复用、`randomBytes(32)` 签名密钥、`requestState` 绑定方法+令牌种类，设计方向正确。但「主人必须在客户端确认」无法在服务端强制：持有写令牌的客户端可以自己回 `accept`，ADR 已在「后果」承认；这是信任边界，不是本改动新增后门。确认框展示的正文是外部 agent 原文（仅清洗控制字符），客户端若按 Markdown/HTML 渲染仍有社会工程空间，属于残余风险。
- 资源耗尽：正文上限 2000、HTTP body 64 KiB、写令牌 30 次/分钟、无每日配额（ADR 明确接受）。每次成功才写 payload，失败重试复用同一 contentRef，没有明显的无界增长；但没有「同正文重复提议」的去重，这是 ADR 有意放弃的。
- 不可撤销操作：写入的是普通记忆，可删除/回收；确认框有明确「保存」勾选；拒绝/取消/未勾选都不写记忆（只写拒绝决策记录）。并发冲突答案下的双结论见第 1 条。
- 规则/文档/代码一致性：`prompt-catalog` 新条目都登记进 manifest 并带 `changedIn`/`reason`；`prompt-catalog.unit.test.ts` 会校验 manifest digest、未知/缺失条目，`prompt-wording.unit.test.ts` 会校验禁用词和强调词；但 manifest 里的 sha256 我无法计算，标「未核实」。文档漂移见第 8 条。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
结论：**没有发现会改变 Himawari 自己发给模型的请求开头。**

依据：
- 新增的 `mcp.propose-memory*` 提示词只被 `apps/agent-service/src/production-mcp-read.ts` 使用（`packages/prompt-catalog/src/tools.ts` 的 `usedBy` 也这么写），没有进入会话系统提示或主模型工具定义；`prompt-manifest.json` 只是登记表，被 `prompt-catalog.unit.test.ts` 读取，不是模型请求的组装来源。
- 现有提示词文本没有任何改动；新增条目只是加进 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts` 会把 `tools` 模块的所有条目汇总）。这只有在历史内容里**已经出现**这些全新字符串时才可能改变出口遮盖结果；这些字符串是本 PR 新造的，旧历史不可能包含，所以不会让已发出的历史字节变化。
- 每轮会变的值（client 名、category、text、requestState）只出现在给外部客户端的确认框和 `requestState` 里，不在主模型请求里；外部记忆正文即使之后被检索进模型上下文，走的是既有的「本轮资料/最后消息」通道，不是系统提示或工具定义。

需要保留的例外说明：外部 agent（Claude Code 等）自己的工具列表确实多了一个 `propose_memory`，这会改变**外部客户端**自己的模型请求开头；这不属于 Himawari 主模型的请求，ADR 0225 也明确写的是「Himawari 自己发给模型的请求一个字节都不变」。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
结论：**对主模型请求：不会。对 MCP 写协议本身：同一段正文每次提议会得到不同的标识和 requestState，但这是设计使然，不是模型提示字节。**

- `argsHash` 使用固定顺序的 `JSON.stringify([text, category])`（`production-mcp-read.ts:364-366`），同样规范化后的正文和分类得到同一哈希；`mcp-write.test.ts:408-423` 覆盖键序不同。
- 每次初始提议用 `randomUUID()` 生成新的 `proposalId`，因此 memory id、contentRef 不同；`requestState` 用进程随机密钥和 TTL 生成，每次字节不同。这些值只影响存储/账本/确认协议，不进入主模型提示；ADR 也明确放弃「按正文哈希做提议编号」。
- 新增的 trusted text 列表本身是排序固定的（`trustedPromptTexts` 按长度、再按字典序），不会引入非确定性；遮盖仍然是确定性的。
- 未发现依赖时间、无序集合、对象遍历顺序写入提示词的路径。结论依据是已读代码；出口遮盖/提示组装未实际运行验证。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
结论：**有相当完整的自动检查，但不是所有声称的反向用例都真的会失败。**

已确认存在的检查：
- `test/integration/mcp-write.test.ts`：只读令牌看不到写工具、写令牌能看到；老版本连接看不到；确认后保存并能被 `find_memories` 找到；拒绝/取消/未勾选不写；客户端不支持确认框不写；并发重复重发只写一条；键序不同算同一提议；篡改状态被拒；状态配别的内容回 CHANGED；硬删除后重放不复活；拒绝账本写失败回 FAILED；每日回顾和校准行为。
- `test/integration/memory-source-report.test.ts`、`apps/control-center/test/memory-source.unit.test.ts`、`packages/platform-node/test/startup-configuration.unit.test.ts` 分别覆盖来源分类和配置。
- `apps/agent-service/test/prompt-catalog.unit.test.ts` 会用 manifest digest 检查新增提示词是否登记正确（未运行，未核实哈希是否真的匹配）。

不成立/有缺口的反向用例：
- 第 2 条：删掉 `legacyShim: false`，现有老版本用例仍会通过，因为写工具根本没注册；「不能用旧的服务端主动请求方式」没有被真正验证。
- `bind` 的「令牌种类」绑定没有测试：测试没有用不同令牌种类重放同一 requestState（只读令牌也无法调用写工具，因此也没有自然入口）。
- 写密钥「解析后的值相同」只在构造函数里检查（`production-mcp-read.ts:222-223`），没有测试覆盖；启动配置测试只覆盖了同 ref。
- 「拒绝后重放返回 DECLINED 且不写」没有单独直接测试；现有测试覆盖了拒绝，但没有重放该状态。
- `requestState` 过期没有自动测试；ADR 0225:118 自己承认，因为 SDK 用真实时钟。
- 提示词 manifest 的 sha256 是否与新增文本一致：未核实（未运行检查）。

### 4. 每个新增/修改值的生产者与消费者是否都能接受？
结论：**已逐个核对，除下面几处外两端能对上；SDK 相关的类型/运行时行为未核实。**

- `memory:mcp:<uuid>`：生产者 `production-mcp-memory-writer.ts:23,69-71`；消费者 `memory-source.ts:4,24`、`memory-source-report.mjs:23`、`mcp-write.test.ts` 的前缀交叉测试。`MemoryId` 域校验允许冒号和连字符（`identifiers.ts:39`），gateway `machineString` 也允许（`validation.ts:49-59`），能通过后端校验。
- `memory-content:mcp:<uuid>`：生产者 `production-mcp-memory-writer.ts:24,147`；`putPayload` 不限制 ref 格式，检索端要求 `text/plain`，写入时 `contentType: "text/plain"`（`production-mcp-memory-writer.ts:217`），两端一致。
- `ledger:mcp-proposal:<uuid>:kept|declined`：生产者 `production-mcp-memory-writer.ts:73-75`；消费者 `ProductionMcpMemoryWriter.decided`、`DecisionLedgerPort.read`、每日回顾。长度 ≤128，通过 `validateLedgerWrite` 和 DB 的 `id` 长度检查（`migrations/0088...:18`）。
- 原因码 `mcp_proposal_kept`/`mcp_proposal_declined`：生产者 `decision-ledger.ts:60-65`；消费者 `daily-review.ts:245-248` 与 `calibration/src/index.ts:640,655-656`。账本只要求 1–64 字符，DB `reason_code` 也只限长度；`kept`/`discarded` 是 `memory_candidate` 合法 outcome。
- `writeSecretRef`/`mcp-write` purpose：生产者 `strict-configuration.ts:1104-1115,1466-1472`；消费者 `service-main.ts:1767-1772` 与 `production-mcp-read.ts:222-223`；启动测试覆盖同 ref、错 purpose、缺失。两端校验一致；但「配置了写令牌却静默不接」缺少启动断言（第 7 条）。
- 记忆字段：`category` 九种都在 `DECISION_CATEGORIES` 和 SQLite `CATEGORIES` 里；`sensitiveTopic` 只产生 health/finance/other，均在 `SENSITIVE_TOPICS`；`importancePermille: 500`、`confidencePermille: 1000`、`inference: false` 在允许范围内；`policyVersion "memory-mcp:v1"` 只要求非空，无其他白名单消费者。
- 提示词 manifest 条目：ID 与 `tools.ts` 导出名一一对应，`changedIn: "ADR 0225"`，`reason` 非空；digest 是否匹配**未核实**。
- 网页/i18n：`external` 已加入 zh-CN/en/ja 三种语言的 `memory.page.origin`；`importanceValue` 对 external 走 owner 分支；`MemorySourceState` 联合类型和报表 `SOURCE_STATES` 都加了 `external`，测试覆盖「`memory:mcpx:` 不算 external」。

未核实项汇总：SDK 的 `createRequestStateCodec`/`inputRequired`/`legacyShim`/`authInfo` 传递是否与 2.0.0 的真实 API 完全一致（仓库里没有 `node_modules`）；prompt manifest 哈希是否正确；任何测试或 typecheck 是否实际通过。
