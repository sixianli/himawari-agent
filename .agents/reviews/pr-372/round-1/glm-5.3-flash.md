# 代码复核报告：PR 372（P5-1 对外只读 MCP 入口）

## 结论（先说重点）

改动本身与作者说法基本一致，我没有发现会破坏「发给模型的请求只追加」或字节确定性的问题。发现的问题都是低严重度的覆盖与一致性问题；另有两处我无法直接核实（SDK API 面、测试是否真的跑过）。

---

## 问题清单（严重度从高到低）

### 1.（低，流程风险）新集成测试不在 `npm run check` 里，作者的「check 48 步通过」没有覆盖它
- 文件：package.json:27
- 问题：`check:steps` 的 48 步里没有任何一步跑 `test/integration/`（`npm test` 即 `scripts/ci/local.mjs --check coverage` 才会经 `scripts/ci/check-coverage.mjs:72-73` 把 integration 项目纳入）。作者说「npm run check 48 步、npm run build 通过」——这句是真的，但**不能证明** `test/integration/mcp-read.test.ts` 通过。
- 证据：package.json:27 的 `check:steps` 串里无 `test:integration`；scripts/ci/check-coverage.mjs:72-73 `["unit", "contracts", "tooling", "integration"].includes(project.id)`。
- 建议：在 ADR 或复核记录里写明该测试由哪条命令覆盖；如要进 check，可仿照 `check:data-export` 加一个定向步骤。

### 2.（低，一致性）i18n 只改了 zh-CN，en/ja 的 `external_read` 标签没跟上
- 文件：apps/control-center/src/i18n/resources/en.ts:1045、ja.ts:1046、zh-CN.ts:983
- 证据：diff 只含 zh-CN.ts 的 `decision.chain.kind` 改为「外部程序读取记忆」；en 仍是 "External read"、ja 仍是「外部の読み取り」，与 zh-CN 新措辞（强调是外部**程序**读**记忆**）不再对应。
- 建议：同步 en/ja，或说明刻意不改。

### 3.（低，账目准确性）`find_memories` 失败时已发生的嵌入费用记为 0
- 文件：apps/agent-service/src/production-mcp-read.ts（`#call`/`#record`/`#findMemories`，新文件约 242–301 行）
- 证据：`outcome` 只在成功时赋值；`catch` 后 `#record` 写 `costMicros: outcome?.costMicros ?? 0`。而 `context.costMicros` 是 `#findMemories` 的局部 `MailEmbeddingContext`，嵌入可能已计费后才抛错，这笔钱在决策记录上丢失。
- 建议：失败时也把 context 的 costMicros 带进记录（可挂在错误对象上）。

### 4.（低，健壮性）`ruleParameters` 对未来规则的回退值有隐患
- 文件：apps/agent-service/src/production-mcp-read.ts（`ruleParameters`，新文件约 146–150 行）
- 证据：`if (rule.gate === "mail_delivery") return { quietHours: ... }; return { importantSenders: ... };` —— 任何非 `mail_delivery` 的 `owner_setting` 规则都会被塞上 `importantSenders`。当前 `ruleBookFor`（packages/application/src/rules/rule-book.ts:368-377）只返回 4 条规则所以安全，但将来加新 owner_setting 规则会静默带错参数。
- 建议：按规则 id 显式分支，默认返回 `{}`。

### 5.（低，测试缺口）配置解析和装配路径没有新测试
- 文件：packages/platform-node/src/strict-configuration.ts:1081-1088、1169、1427-1433；apps/agent-service/src/service-main.ts:1723-1762
- 证据：全仓库测试中搜 `mcpRead|mcp-read` 只命中 test/integration/mcp-read.test.ts；`parseMcpRead`（未知键拒绝、secretRef 校验）和「配了 `runPolicy.mcpRead` 但没登记密钥 → 启动抛 `MCP_READ_RUNTIME_UNAVAILABLE`」均无用例（对比 museIntake 有 service-failure-reason 等覆盖路径，mcpRead 没有对应改动）。另外 429 限流对这条新路由没有用例（BearerGate 本身有测试）。
- 建议：补 strict-configuration 的反向用例和启动失败用例。

### 6.（未核实）官方 SDK 的 API 面无法直接验证
- 文件：apps/agent-service/src/production-mcp-read.ts（`CLIENT_INFO_META_KEY`、`context.mcpReq`、`handler.fetch(req, { parsedBody })`）
- 证据：本检出目录没有 node_modules，无法读 `@modelcontextprotocol/server` 2.0.0 的类型定义。package-lock.json 确实把它从 dev 依赖转为正式依赖（2.0.0）。间接证据：集成测试用官方 `@modelcontextprotocol/client` 走真实 HTTP，新旧两版协议各连一遍并断言了 `subjectRef: mcp-client:mcp-read-test-modern`（客户端信息）和 `mcp-client:node`（User-Agent 回退）——如果这些 API 用错，测试会失败；但**测试是否真的跑过，我无法核实**（读到的只是代码）。
- 建议：以 CI 绿灯为准。

---

## 读代码证实的（与作者说法逐条对照）

- 「挂在现有 Fastify、没配密钥不注册路由」：属实。production-http-composition.ts:1159 `if (options.mcpRead) registerMcpReadRoute(...)`；service-main.ts 只在找到 `purpose === MCP_READ_SECRET_PURPOSE` 的密钥时构造，配了却没密钥则抛 `MCP_READ_RUNTIME_UNAVAILABLE`。
- 「复用 BearerGate，30/60 每分钟，401 + WWW-Authenticate」：属实。bearer-admission.ts:4-5、32；registerMcpReadRoute 的 `onRequest` 在进 handler 前拦截，鉴权失败不写库（与 ADR 一致）。鉴权失败不写决策记录——这符合 ADR，但注意这也意味着**限流触发（429）也不写库**，`onFailure` 只接 SDK handler 和工具错误。
- 「三个只读工具、固定顺序、readOnlyHint」：属实。注册顺序即 `MCP_READ_TOOL_NAMES` 顺序；`annotations: { readOnlyHint: true, openWorldHint: false }`。
- 「返回前 maskSensitiveText 遮盖」：属实。`maskDeep` 对输出里每个字符串递归调用 `maskSensitiveText`（来自 @himawari-agent/sensitive-capture，符合「敏感识别规则只能在 sensitive-capture 包」的约束）。注意它是**逐字符串独立遮盖**，不具各自出口的跨消息「点名值」联动——这是新的对外面，不违反约束，但比 Himawari 自己出口的遮盖弱，值得在 ADR 后果里写明（未写）。
- 「每次读取写 external_read，失败写 `<工具>_failed`」：属实。`#record` 在 `finally` 里，成功/失败都会写；写入形状经 `validateLedgerWrite`（sqlite-decision-ledger-operations.ts:49-96）校验：`external_read` 只允许 `outcome: "read"`（decision-ledger.ts:48）、reasonCode ≤64、memoryIds 每条 1–256 字符且去重 ≤200——`memory:reminder:<key>` 等都满足；`insertLedgerRow`（:117-122）只落 memoryIds/ruleIds/batchId/resultMemoryIds 四个键，与 ADR「inputs 只写记忆编号」一致。
- 「ruleBookFor 不返回表达式」：属实，`#ruleBook` 只挑 id/revision/gate/outcome/origin/source/status 加 owner_setting 参数。
- 「提示词登记进 prompt-catalog」：属实，manifest 只新增 4 条、未动旧条目；且存在自动校验和反向用例（apps/agent-service/test/prompt-catalog.unit.test.ts:187 `PROMPT_MANIFEST_STALE`、:370 反向用例），由 `check:prompt-catalog` 跑。
- 「10 条测试」：属实（2+2+1+1+1+1+1+1），反向用例真实断言失败（401/错误令牌拒绝连接且 ledger 为空、无密钥 404、失败作为工具错误且不外泄错误码、72 小时后提醒不出现、密码不出现）。

---

## 侧重检查（普通使用流程走查）

流程：配置 `runPolicy.mcpRead.secretRef` + 登记 `mcp-read` 密钥 → 启动 → 外部 agent `POST /api/mcp/v1` 调 `find_memories`。

1. 配置解析：`parseMcpRead`（strict-configuration.ts:1081-1088，只许 secretRef）+ `assertIdentitySecretReference`（:751-766，恰好一条同用途密钥）。**无测试覆盖**。
2. 启动装配（service-main.ts:1723-1762）：找密钥 → `provider.resolve` → 构造（密钥 <32 字符由 BearerGate 构造器抛 `MCP_READ_SECRET_TOO_SHORT`，bearer-admission.ts:19）→ 路由注册在 production-http-composition.ts:1159。装配和失败分支**无测试覆盖**。
3. 请求路径：BearerGate 限流/鉴权（bearer-admission.ts，无新用例）→ SDK handler → 工具 → `embedForExternalRead`（同 mail 检查的 mailScope，费用归属有单元测试 production-mail-embedding.unit.test.ts）→ `recallOutsideRun`（走 `modelVisibleClassifications()`，与聊天同一可见档）→ maskDeep → 响应，`finally` 写决策记录。**有 10 条集成测试覆盖**。
4. 与聊天共用 `ProductionReminderWriter`（service-main.ts:1289-1307 提升为共享实例）：该类无实例状态（只有 `#options`，production-reminder-writer.ts:134-139），共享安全。

未经测试覆盖的代码路径：上面 1、2，以及 429 分支和 `webRequest` 对多值请求头的展开（集成测试间接覆盖了单值头）。

---

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。读代码证实：① prompt-catalog 只新增 4 个 id，旧条目和 manifest 旧哈希一字未动（diff 证实）；② `ProductionMemoryRecall` 的重构是等价的——`recallWithClassification` 把原来的 `invocation.dataClassification` 原样传入 `#recall`，`embedWithin` 仍以 `(invocation, slot, op)` 调用，返回给聊天路径的 `output` 逐字段相同，新增的 `memoryIds` 只在返回值上，聊天侧解构 `const { output, contentClassification }`（production-runtime-tools.ts:607）不使用；③ `ProductionRuntimeTools`、系统提示、工具定义零改动；④ MCP 路由是纯新增的外部入口，不触碰 Himawari→模型的请求组装。会变的值（时间、now、ledger 时间戳）都在 MCP 响应/写库侧，不在模型请求里。`check:prompt-prefix` 阻断检查仍在 check:steps 里。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 对模型请求：不会（同上）。对 MCP 输出本身：顺序确定（ruleBookFor 是字面冻结数组 rule-book.ts:371-376；工具注册顺序固定；reminders 按库内查询顺序）；`maskSensitiveText` 按规则文档是确定的；时间字段（`today`、`now`）本来就随请求变化，属于功能本身且只影响外部调用者，不影响缓存。`randomUUID` 只用于决策记录 id（写库），不进任何提示。未核实项：`maskSensitiveText` 内部实现细节（未读 sensitive-capture 源码）。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 有：`test/integration/mcp-read.test.ts` 10 条含 4 组反向用例（无令牌/错令牌→401 且不写库、无密钥→404、失败→isError 且不外泄内部错误码、遮盖→断言密码原文不出现），这些断言是真实反向的，改坏了会失败。prompt-manifest 有自动校验+反向用例（PROMPT_MANIFEST_STALE）。但要指出：这套集成测试**不在 `npm run check` 里**（见问题 1），且配置解析/装配/429 无用例（见问题 5）。

**4. 产生的每个值，使用端都能接受吗？** 逐个核对过：`runPolicy.mcpRead.secretRef`（生产端 `parseMcpRead`+`assertIdentitySecretReference` 要求恰好一条 mcp-read 用途密钥 ↔ 消费端 service-main 用同样的 ref+purpose 查找并 resolve，两端一致）；`MCP_READ_SECRET_PURPOSE`（定义与使用同文件导出导入）；`RecallResult.memoryIds`（生产端 `#recall` 只 push 实际读出正文的记忆 ↔ 消费端 MCP 记账、聊天侧不使用）；`ListedReminder.memoryId`（生产端 SQL `r.memory_id AS memoryId` ↔ 消费端 today_context 记账）；决策记录写入形状（生产端 `#record` ↔ 消费端 `validateLedgerWrite`/`insertLedgerRow`，键和长度都在限内，`external_read:["read"]` 合法）；`mcp-client:<名>`（正则限 64 字符，≤ subjectRef 256 上限）。唯一没核对上的值是 SDK 的 `CLIENT_INFO_META_KEY`/`mcpReq`/`parsedBody`（node_modules 缺失，未核实），但集成测试用官方客户端双向验证了这条路。发现的使用端不匹配只有低严重度的两处：失败时 costMicros 归零（问题 3）和 `ruleParameters` 的回退分支（问题 4）。
