## 结论

第 11 轮这个增量（8a70d7a6）没有发现高、中严重度的新问题。三处改动本身方向正确：说明和效果的上限与契约的 200 对齐、类型在入箱时要求“清洗后不变”堵住了分派值与被显示值不一致的口子、读列表和补做整理改用固定的 200 条上限，避免配置调低后已有提议读不到。下面两条是低严重度的测试/边界一致性问题。

## 读代码证实的问题（按严重度从高到低）

### 1. 低：把“读列表不受配置上限截断”改成固定 200，没有任何反向用例

- 文件:行：`apps/agent-service/src/production-proposals.ts:433`、`:481-485`；`test/integration/production-memory-capture.test.ts:2473-2511`、`:323`、`:336-340`
- 问题：这是一处有意的行为变化，但没有测试会在把它改回 `this.limit` 时失败。现有的“上限”用例虽然建了 `pendingLimit: 2` 的 tight box，读取却走了默认 box。
- 证据：
  - 代码已改成固定上限：`listPending({ ...scope, now, limit: PENDING_PROPOSAL_CEILING })`（`production-proposals.ts:433`），`list()` 里也是 `limit: PENDING_PROPOSAL_CEILING`（`:481-485`）。
  - 测试里 `full = (await proposalsQuery(context)).payload;`（`test:2499`）使用的是 `context.proposalControl`，它包装的是默认 `box = boxWith()`（`test:323`、`test:336-340`，默认上限 20）；所以 `pendingCount=2` 在两版代码下都能通过。全仓库也没有任何测试让“待采纳条数 > 配置上限”后再读列表。
- 建议：加一条真实 SQLite 用例：先绕过提议箱用 `repository.ownerProposals().propose({ ..., pendingLimit: 20 })` 写 3 条待采纳，再用 `pendingLimit: 1` 的 `ProductionProposalBox`/`ProductionProposalControl` 读列表，断言 `proposals.length === 3` 且 `pendingCount === 3`。旧代码会只返回 1 条，正好是反向下沉用例。另建议把 `PENDING_PROPOSAL_CEILING` 与存储层的 `MAX_LISTED` 统一成一个共享常量，避免以后只改一边被静默截断。

### 2. 低：迁移的 CHECK 与新上限不一致；文档只写“不得含控制符”，代码还拒绝了首尾空白

- 文件:行：`packages/persistence-sqlite/src/migrations/0095_owner_proposals.sql:6-7`；`apps/agent-service/src/production-proposals.ts:121-131`、`:134`、`:290-293`；`docs/architecture-v0.1.md:426`
- 问题：应用层现在只收 200 个 UTF-16 单元的说明/效果，但迁移的 CHECK 仍是 1–400；另外 `shownText` 会 `trim()`，所以类型除控制符外也不能有首尾空白，而文档只写了“不得含控制符”。
- 证据：
  - 迁移：`summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 400)`、`effect ... 1 AND 400`（`0095:6-7`）。
  - 应用：`const SENTENCE_LENGTH = 200;`（`production-proposals.ts:134`），`!sentence(input.summary, SENTENCE_LENGTH) || !sentence(input.effect, SENTENCE_LENGTH)`（`:292-293`）。
  - 类型校验依赖 `shownText` 的替换加 `trim()`：`.replace(/\p{Bidi_Control}/gu, "").replace(/\p{Cc}/gu, " ").trim()`（`:123-130`），再 `shownText(input.type, TYPE_LENGTH) !== input.type`（`:291`）。
  - 文档：类型“不得含控制符”、说明/效果“各最长 200”（`docs/architecture-v0.1.md:426`）。
- 建议：0095 只在本分支、从未上线，直接把 `summary`/`effect` 的 CHECK 收到 200，让存储层也守住同一不变量（拒绝值的方向是 DB 更宽，不会误拒应用产出的值，但“两端校验”并不一致）；文档补一句“类型还不得有首尾空白”，或把类型校验拆成显式的 `input.type === input.type.trim()` 加控制符判断，避免读文档的人误以为 64 个字符（含首尾空格）也可以。

## 推测 / 未核实

- 推测：待采纳条数不会超过 200，因此固定 200 的上限在现有流程下不会造成新的截断。依据是 `sqlite-owner-proposal-operations.ts:114-151` 在事务内先 `expire` 再数 `pending`，`pending >= input.pendingLimit` 就拒绝，而 `input.pendingLimit = this.limit` 又被构造函数限制在 1–200（`production-proposals.ts:200-208`），插入/重开都受这个数约束，SQLite 操作串行。未做并发压测。
- 未核实：材料里“typecheck、lint、integration 等已通过”无法在本环境验证（只能读文件和执行 git 命令，不能跑测试）。
- 未核实：0095 从未应用到任何持久库。git 上它只出现在本分支的 `147c5c63`、`ba4cb513` 两个提交里（`git log -- 0095` 的结果），但无法访问部署数据库确认。

## 侧重检查

- 错误路径 / 不可信输入：入箱校验全部发生在写依据载荷之前（`production-proposals.ts:288-295` 先校验，`:301` 才 `#writeBasis`），所以本轮的非法类型/超长说明不会留下孤儿载荷；存储层再次校验 id、时间、上限、origin、fingerprint、source（`sqlite-owner-proposal-operations.ts:98-113`），没有绕过新校验的口子。
- 资源耗尽：`list()` 现在每次最多解密 200 条输出依据，另外每个登记的处理方还会在 `settle()` 里再解密最多 200 条（`:428-437`、`:481-485`，`list()` 在 `:476-480` 对每个处理方调用），最坏约 400 次解密/次读。有上界、不随配置无限放大，不构成新的 DoS；但如果以后处理方变多，值得注意这是常数级的成本增加。
- 不可撤销操作：采纳仍是“先认领 pending→accepted，再执行处理方，失败退回 pending”（`:354-392`），本轮没有改这条路径；新增校验只在入箱前置，不影响认领顺序。
- 拒绝/过期清理：`#sweep` 只清 rejected/expired 且 `evidence_ref` 未变的行（`production-proposals.ts:458-471`、`sqlite-owner-proposal-operations.ts:314-324`），本轮未改。
- 安全 / 展示：类型与依据文字在入箱和出箱两端都去 Bidi/Cc（`:121-131`、`production-proposal-control.ts:53-78`），不会把方向控制符带进界面；这些值也不进系统提示或工具定义，没有新的提示注入面。
- 规则/文档/代码一致性：文档 `docs/architecture-v0.1.md:426` 与代码的三条限制一致，仅“首尾空白”“迁移 CHECK 400”两处边界如问题 2 所述。
- 真实 SQLite：`test/integration/production-memory-capture.test.ts` 使用真实 SQLite，并在这条路径上用 `gatewayV2MessageSchema.parse(wire)`（`:2212`）校验快照，等于把“产生值”交给“契约消费者”核对了一遍，符合 I-73 的要求。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 全量 diff 的文件清单里没有 `packages/prompt-catalog`，也没有系统提示或运行时工具描述文件的改动；`ownerRuleToolDescriptors` 里的 `rule_set` 参数结构未动。改动只发生在提议表的校验、列表和网页卡片按钮上；对模型而言新增的只是追加在末尾的 `rule_set` 工具结果，其中提议编号是内容哈希（不含时间）；唯一带时间和随机数的 `evidenceRef` 只在加密载荷引用里使用（`production-proposals.ts:297-298`），不会被发给模型。按 [prompt-prefix 规则第 4 条](../../.claude/rules/prompt-prefix.md#append-only)只追加、[第 2 条](../../.claude/rules/prompt-prefix.md#order)把会变的值放最后一条消息，本轮没有违反。规则文件在稀疏检出里没有，我通过 `git show 0d989adb:.claude/rules/prompt-prefix.md` 读到了原文。

2. **不会让同一段文字在不同请求里变成不同字节。** 提议编号用 `canonicalJson([ownerId, agentId, type, params, summary, quote])`（`production-owner-rules.ts:793-802`），指纹用 `canonicalJson([type, summary, effect, origin, evidence, data])`，而 `canonicalJson` 会按键排序（`production-proposals.ts:145-156`）；存储层的待采纳列表按 `proposed_at, id` 固定排序（`sqlite-owner-proposal-operations.ts:226-229`）。会随时间/随机变化的只有 `evidenceRef`（`:297-298`）和列表响应的 `generatedAt`（`production-proposal-control.ts:87`），前者不进模型内容，后者是网关响应，不属于模型请求。规则提议的 `data` 里带着回放数字，邮件状态变化时指纹确实会变、版本加一（`:313-324`，存储层 `:122`），这是有意的“内容变了”，不是同一内容的不确定序列化。

3. **大部分有自动检查，但列表上限这一条没有。** 说明/效果上限和类型控制符都有会让旧代码失败的反向用例：`test/integration/production-memory-capture.test.ts:3042-3045`（201 字、201 个 UTF-16 单元的 emoji、`price\u202esearch`），200 个 UTF-16 单元的 emoji 正向用例在 `:3027`；旧代码（`SENTENCE_LENGTH=400`、只做 `sentence`）会接受这些值，因此这些用例在旧代码上会失败。契约 fixture 和集成测试的 `gatewayV2MessageSchema.parse`（`:2212`）覆盖了新快照字段。缺口是问题 1：把 `limit: PENDING_PROPOSAL_CEILING` 改回 `this.limit`，现有测试不会失败。另：类型只测了 Bidi 控制符，没有测中间夹 C0 的 `price\u0007search`，但两者走的是同一条 `shownText(...) !== input.type` 分支，风险很低。测试是否真的全绿未核实（不能运行测试）。

4. **逐个核对了两端，本轮产生的值都能被使用方接受。**
   - `type`：产生处强制 1–64、无 Cc/Bidi、无首尾空白（`production-proposals.ts:290-291`）；使用处是处理方分派（`:224-226`、`:350`）、列表的 `shownText(type, 64)`（`production-proposal-control.ts:53`）、契约 `boundedString(64)`（`contracts-v2.ts:1667`）和迁移 `length(type) BETWEEN 1 AND 64`（`0095:5`）。清洗后等于原值后，契约要求的“非空、≤64、无 <0x20/0x7f”必然满足（`packages/gateway-contracts/src/validation.ts:89-104`），且分派值与显示值现在一致，正是 I-73 的教训。
   - `summary` / `effect`：产生处 ≤200（`production-proposals.ts:292-293`）；使用处是 `shownText(..., 200)`（`production-proposal-control.ts:54-55`）、契约 `boundedString(200)`（`contracts-v2.ts:1668-1669`）、迁移 CHECK 1–400（`0095:6-7`）。应用产出的值都能被契约和迁移接受；迁移更宽，所以不存在“清单/字段的值过不了后端校验”这类反向问题，但如问题 2 所述两端不相等。规则路径的 summary 另有 `OWNER_RULE_SUMMARY_LIMIT = 200`（`packages/application/src/rules/rule-types.ts:16`、`:248-254`），不会因为这次收紧而被误拒。
   - `PENDING_PROPOSAL_CEILING = 200`：作为 `listPending` 和 `settle` 的 `limit`，存储层 `Math.min(Math.max(1, trunc(limit)), MAX_LISTED=200)` 接受（`sqlite-owner-proposal-operations.ts:13`、`:221`、`:293`）；返回给界面的 `limit` 仍是配置值（1–200，构造函数 `:200-208`），契约 `integer(1)` 接受。
   - `proposalId` / `version` / `fingerprint` 本轮未改：编号符合存储层 `PROPOSAL_ID` 和 `machineString`，指纹是 64 位十六进制，能被 `machineString` 和迁移 `length(fingerprint)=64` 接受；集成测试的 fixture 也已经用真实 schema 校验过。
