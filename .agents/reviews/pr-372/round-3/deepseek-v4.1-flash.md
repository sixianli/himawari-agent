## 复核结论

先说明：我只能读代码和跑 git 命令，**没有运行测试、`npm run check` 或 `npm run build`**；下面凡是“测试会/不会失败”的判断，都是按测试代码推断的。

---

## 发现（按严重度）

### 1. 中：新的 MCP 外部出口没有纳入 `check:egress-redaction`，门槛对这条路径是空的

**文件:行** `scripts/check-egress-redaction.mjs:72-103`、`:185-209`，`apps/agent-service/src/production-mcp-read.ts:92-101`，`docs/adr/0219-read-only-mcp-entry-with-static-token.md:71`

**问题** 当前代码确实会遮罩，但项目用来防止“以后有人绕过遮罩”的门槛没有覆盖 MCP 响应。删除或绕过 `maskForExternalRead` 时，`check:egress-redaction` 不会失败，只有现有单测/集成测会失败；ADR 却把这道门槛当成外部出口的保障。

**证据**
- `check-egress-redaction.mjs:72-76` 的外部出口只有 TypeSafe、Exa、DeepSeek：
  ```js
  export const EXTERNAL_EGRESS_PATTERNS = Object.freeze([
    { name: "TypeSafe review request", pattern: /\/v1\/systemone/u },
    { name: "Exa MCP request", pattern: /https:\/\/mcp\.exa\.ai\/mcp/u },
    { name: "DeepSeek web tool request", pattern: /\/v1\/tools\/(?:search|fetch)/u },
  ]);
  ```
- 同一文件 `:185` 只拦截直接调用 `redactForEgress(` 的文件：
  ```js
  if (/\bredactForEgress\(/u.test(text) && !REDACTOR_ONLY_FILES.includes(relative))
  ```
- `production-mcp-read.ts:92-101` 用的是 `maskSensitiveTexts`，不是 `redactForEgress`，路径 `/api/mcp/v1` 也不在外部出口清单里。
- ADR `:71` 说“出口检查 `check:egress-redaction` 只允许敏感包和出口模块直接调用它”。

**建议** 把 MCP 响应出口显式登记进 `check-egress-redaction.mjs`（或新增一项工具检查），要求响应路径必须调用 `maskSensitiveTexts`/`maskForExternalRead`；并加反向用例：去掉调用时检查必须失败。

---

### 2. 中：跨文本遮盖只在“同一次返回”内成立；裸值单独返回不会遮，且没有反向用例

**文件:行** `packages/sensitive-capture/src/redaction.ts:552-568`、`:411-425`，`apps/agent-service/src/production-mcp-read.ts:92-101`，`apps/agent-service/test/production-mcp-read.unit.test.ts:7-19`

**问题** `maskSensitiveTexts` 的安全边界是“同一次返回里的其他文字点过这个值”。如果检索只返回裸出现的那条记忆，没有任何文字点过它，它不会被遮。测试把“裸值”和“点名值”放在同一个响应里，所以没有覆盖这个边界。

**证据**
- `redaction.ts:552-568` 先整批预跑一遍，把点名值放进共享 `known`，再对每条文字重跑：
  ```ts
  for (const input of inputs) redactForEgress(input, options);
  return inputs.map((input) =>
    redactForEgress(input, options).text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]"),
  );
  ```
- `redaction.ts:411-425` 只在 `known` 里有点名值时替换裸值：
  ```ts
  if (known !== undefined && known.size > 0) {
    for (const [value, placeholder] of known) {
      if (!text.includes(value)) continue;
  ```
- 单测 `production-mcp-read.unit.test.ts:7-19` 同时放了：
  ```ts
  { text: `路由器背面贴着 ${WIFI_VALUE}` },
  { text: `家里 Wi-Fi 密码：${WIFI_VALUE}` },
  { text: `客人来了就告诉他 ${WIFI_VALUE}` },
  ```
  因此只证明了“同一批里点名后裸值也被遮”。
- 如果只有 `{ text: "路由器背面贴着 Sunflower-8841" }`，没有“密码/验证码”等关键词，也没有机器密钥特征，`maskSensitiveTexts([bare])` 会原样返回。

**建议** 先把预期写清楚：如果接受“只能遮同一次返回里被点名的值”，就在 ADR 和工具说明里明确这是限制，并加 `maskSensitiveTexts([bare])`、`maskForExternalRead({ text: bare })` 的用例来固定行为；如果不接受，需要另设计跨请求的已知秘密机制（例如由记忆写入时登记，而不是靠检索结果自证）。同一段文字在不同请求里可能一处被遮、一处不遮，这一点也应写进文档。

---

### 3. 中：第 3 轮“两路检索都结束才报失败”没有能区分旧实现的测试

**文件:行** `apps/agent-service/src/production-memory-recall.ts:191-219`，`test/integration/mcp-read.test.ts:335-344`

**问题** 代码确实改成了等两路都 settle 再抛错，但现有失败用例让两路检索都立即抛错，旧的 `Promise.all` 也会通过；也没有断言 tentative 那一路的嵌入费进入了 `costMicros`。

**证据**
- 新代码：
  ```ts
  const [confirmed, tentativeHits] = await Promise.all([
    within("memory-recall", () => this.#options.provider.search({...})).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
    ...
  ]);
  if (confirmed.status === "rejected") throw confirmed.reason;
  ```
- 集成测试的 `failRecall` 在 `setup` 里让所有 `provider.search` 直接抛错（`mcp-read.test.ts:149-151`），两路同时失败；断言只有：
  ```ts
  expect(row?.costMicros).toBeGreaterThan(0);
  ```
  没有证明“等 tentative 结束”，也没有证明 tentative 的费用被计入。

**建议** 加一条测试：confirmed 立即 reject，tentative 延迟成功/延迟失败；断言失败返回发生在 tentative 结束之后，并且 `costMicros` 包含两路嵌入费。否则第 3 轮这个改动没有可失败的回归用例。

---

### 4. 低：`MCP_READ_RUNTIME_UNAVAILABLE` 两条启动失败路径没有自动测试

**文件:行** `apps/agent-service/src/service-main.ts:670-671`、`:2119-2120`

**问题** 这是本轮新增的“配置了 mcpRead 却建不起入口就启动失败”的保证，但仓库里没有测试引用 `MCP_READ_RUNTIME_UNAVAILABLE`；现有 composition 测试只覆盖“没配时 404 / 配了时 200”，不覆盖启动失败。

**证据**
- `service-main.ts:670-671`：
  ```ts
  if (configuration.runPolicy?.mcpRead !== undefined && !webEnabled)
    throw new Error("MCP_READ_RUNTIME_UNAVAILABLE");
  ```
- `service-main.ts:2119-2120`：
  ```ts
  if (configuration.runPolicy?.mcpRead !== undefined && !mcpRead)
    throw new Error("MCP_READ_RUNTIME_UNAVAILABLE");
  ```
- 全仓库搜索只有源码命中，没有测试文件命中。

**建议** 用 `service-orchestration.unit.test.ts` 或启动夹具加两条用例：没开网页服务但配 `mcpRead` 必须启动失败；开了网页但密钥/入口没建起来也必须启动失败。另外 `:2119` 在 `if (memoryComposition)` 里，建议明确它是否应移到外层以覆盖所有“配置了但未建起”的情况。

---

### 5. 低：48 小时窗口没有边界测试；ADR 一处写 72 小时

**文件:行** `apps/agent-service/src/production-mcp-read.ts:36`，`test/integration/mcp-read.test.ts:38,144`，`docs/adr/0219-read-only-mcp-entry-with-static-token.md:114`

**问题** 代码是 48 小时，ADR 测试清单写“72 小时后的提醒不出现”，而集成测试的 TRIP 是 `2026-11-15`，距 `NOW`（`2026-11-11T03:00Z`）约 96 小时；48 小时和 72 小时实现都能通过这个测试。

**证据**
- `production-mcp-read.ts:36`：
  ```ts
  export const TODAY_CONTEXT_REMINDER_WINDOW_MS = 48 * 3_600_000;
  ```
- `mcp-read.test.ts:38`：`NOW = "2026-11-11T03:00:00.000Z"`；`:144`：`due: "2026-11-15T09:00"`。
- ADR `:114`：“反向：……72 小时后的提醒不出现”。

**建议** 增加约 47 小时（出现）和约 49/60 小时（不出现）的边界用例；把 ADR 的 72 小时改成 48 小时。

---

### 6. 低：银行卡占位符保留后四位，与 ADR “占位符不含原值任何信息”不一致

**文件:行** `packages/sensitive-capture/src/redaction.ts:385`、`:565-568`，`docs/adr/0219-read-only-mcp-entry-with-static-token.md:70`

**问题** `maskSensitiveTexts` 只去掉 `#tag`，银行卡占位符仍保留原卡号后四位；ADR 说“返回给对方的占位符只写类别……不含原值的任何信息”，这句话对银行卡不成立。项目原有测试明确期望保留尾号，所以这更像文档承诺过宽；但外部 agent 确实会看到原值的一部分。

**证据**
- `redaction.ts:385`：
  ```ts
  return mask("bank-card", `银行卡 尾号${digits.slice(-4)}`, match, digits, false);
  ```
- `redaction.ts:565-568` 只做：
  ```ts
  ...text.replace(EGRESS_PLACEHOLDER_PATTERN, "[$1]")
  ```
  没有把 `银行卡 尾号1234` 改成 `银行卡`。
- ADR `:70`：“占位符只写类别（例如 `[密码]`）……不含原值的任何信息。”
- 既有测试 `redaction.unit.test.ts:23-31` 期望 `[银行卡 尾号1111]`。

**建议** 如果外部读取要求比模型出口更严格，`maskSensitiveTexts` 应单独把银行卡占位符换成 `[银行卡]`，并加一条有效 Luhn 卡号的用例，断言响应里不出现后四位；否则修正 ADR，不要声称“不含原值任何信息”。

---

### 7. 低（部分推测）：MCP 请求没有整体超时/取消传递，GET/DELETE 响应被全量缓冲

**文件:行** `apps/agent-service/src/production-mcp-read.ts:320-331`、`:334-340`、`:356`

**问题** `webRequest` 创建 `Request` 时没有把 Fastify 连接的 abort 传进去；`#todayContext`/`#ruleBook` 也忽略 `signal`。客户端断开后服务端仍会继续读、继续写决策记录。GET/DELETE 与 POST 共用 `sendWebResponse`，而它用 `response.arrayBuffer()` 把整个响应收完再发；如果 SDK 对 GET 返回长连接 SSE，就会长时间占住连接和内存。SDK 的 GET 行为我没有核实（仓库里没有 `node_modules`）。

**证据**
- `webRequest` 没有 `signal`：
  ```ts
  return new Request(new URL(request.url, `${request.protocol}://${host}`), {
    method: request.method,
    headers,
    ...(request.method === "POST" ? { body: JSON.stringify(request.body ?? null) } : {}),
  });
  ```
- `sendWebResponse`：
  ```ts
  return reply.send(Buffer.from(await response.arrayBuffer()));
  ```
- 路由允许：
  ```ts
  method: ["GET", "POST", "DELETE"],
  ```

**建议** 把 Fastify 请求的 abort 传到 `Request` signal；给整个工具调用加超时和响应字节上限；如果不确定 SDK 的 GET/SSE 行为，先只开放 POST，或改为流式转发并设置超时。

---

### 8. 低：外部读取的嵌入费用只有每分钟次数限流，没有日/每次费用上限

**文件:行** `apps/agent-service/src/bearer-admission.ts:4`，`apps/agent-service/src/production-mcp-read.ts:262-277`，`docs/adr/0219-read-only-mcp-entry-with-static-token.md:108`

**问题** 每次 `find_memories` 可能触发 confirmed、tentative、episodes 多条嵌入；BearerGate 只限制 30 次/分钟，没有每日或每次读取的费用上限。ADR 已明确承认“没有单独的每日上限；有限流兜底”，所以这是已接受的风险，不是隐藏 bug；但如果外部 token 泄露，费用放大倍数不小。

**证据**
- `bearer-admission.ts:4`：`export const AUTHORIZED_PER_MINUTE = 30;`
- `production-mcp-read.ts:262-277` 只累计 `context.costMicros`，没有上限判断。
- ADR `:108`：“没有单独的每日上限；有限流兜底，每分钟最多 30 次。”

**建议** 至少在配置里加每日/每 key 的嵌入费用上限或每次读取的 token/费用上限；如果坚持不加，把这个数字和风险写进 ADR 的后果。

---

## 推测 / 未核实

- **GET/SSE 的 SDK 行为**：`@modelcontextprotocol/server` 的 `createMcpHandler` 对 GET 到底返回 405 还是长连接 SSE，我没有核实（仓库里没有安装包）；第 7 条里的“挂住”是推测。
- **`webRequest` 的 `content-length` 不匹配**：它复制原请求头，但 POST body 是 `JSON.stringify(request.body)` 重新序列化的；如果 SDK 读原始 body 而不是 `parsedBody`，带空白/换行的请求可能出现长度不一致。集成测试用的紧凑 JSON 不一定覆盖。未核实。
- **测试和构建结果**：作者说 `test/integration/mcp-read.test.ts` 10 条、`npm run check` 48 步、`npm run build` 通过；我没有运行，无法确认。
- **`subjectRef` 的未来风险**：`clientNameOf` 的 `CLIENT_NAME` 允许 `/`（`production-mcp-read.ts:39`），而 gateway contracts 的 `machineString` 不允许 `/`。当前 `subjectRef` 没有进入 `machineString` 合同，数据导出只要求 1-256 字符，所以现在能通过；以后若把 `subjectRef` 放进 `machineString` 字段，会重演 I-73。

---

## 侧重检查

我查了这些路径：

- **鉴权/不可信输入**：`BearerGate` 用 SHA-256 + `timingSafeEqual`，密钥至少 32 字符，有效 30 次/分钟、无效 60 次/分钟；路由的 `onRequest` 对 GET/POST/DELETE 都先鉴权；未带/错令牌 401、超限 429，测试断言 401 时不写记录。输入侧有 MCP schema（`query` 1-500、`limit` 1-10、`from/to` 格式）和 `argumentsOf` 二次校验；请求体上限 64 KiB；客户端名正则截断到 64 字符且限制字符集。
- **安全/敏感输出**：`#call` 对所有工具输出统一走 `maskForExternalRead`；错误只返回固定失败文案，不返回原始错误；决策记录不写正文。发现两个边界：裸值单独返回不遮（第 2 条），银行卡占位符保留后四位（第 6 条）；另外外部出口没进 `check:egress-redaction`（第 1 条）。
- **资源耗尽**：有限流、请求体上限、嵌入 deadline；但没有 MCP 整体请求超时、客户端断开不传递、GET 全量缓冲、嵌入费用无日上限（第 7、8 条）。
- **不可撤销操作**：本改动只有只读工具和写决策记录；决策记录写不进去时不交出内容（`production-mcp-read.ts:227-235`），符合 ADR。
- **规则/文档/代码一致性**：发现 48h vs 72h（第 5 条）、银行卡后四位 vs “不含原值信息”（第 6 条）、启动失败测试缺失（第 4 条）、`check:egress-redaction` 覆盖不足（第 1 条）。
- **下游校验（I-73 式）**：逐个核对了 `mcpRead.secretRef`、`MCP_READ_SECRET_PURPOSE`、`external_read`/`read`、`reasonCode`、`subjectRef`、`inputs.memoryIds`、`costMicros`、`durationMs`、`ListedReminder.memoryId`、`RecallResult.memoryIds`、prompt id/hash、i18n key。当前没有发现会被下游直接拒绝的值；主要注意点是 `subjectRef` 的 `/` 与未来 `machineString` 的潜在冲突，以及 `inputs.memoryIds` 若 provider 返回重复 memory id 会触发 `validateLedgerWrite` 的唯一性检查（`sqlite-decision-ledger-operations.ts:40-46`），导致整次读取变成工具错误。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**对 Himawari 自己发给模型的请求：读代码看没有改变。**
- `ProductionMemoryRecall` 只是多返回了 `memoryIds`，给模型的 `output` 对象没有变；`production-runtime-tools.ts:607` 仍然只解构 `{ output, contentClassification }`，额外字段不会进入工具结果。
- `production-reminder-writer.ts:260-284` 的 `ListedReminder` 新增了 `memoryId`，但模型侧的提醒工具在 `production-reminder-writer.ts:355-362` 明确只映射 `reminderId/text/due/repeat`，不会把 `memoryId` 发给模型。
- 新提示词只被 `production-mcp-read.ts` 引用，不在 Himawari 的系统提示或工具定义里。
- prompt catalog 新增条目会进入 `TRUSTED_PROMPT_TEXTS`，但新字符串不出现在已有请求内容里，不会改变已有请求的字节；这只是推断，没有跑 `check:prompt-prefix`。

结论：Himawari 的模型请求仍然只在末尾追加，每轮变化的值仍然只在最后一条用户消息里；MCP 返回是给外部 agent 的工具响应，不属于 Himawari 的模型请求。依据 `.claude/rules/prompt-prefix.md:27-29,35-36`。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- **对 Himawari 自己的模型请求：不会新增这种问题。** 遮盖仍是原有出口；新增的 prompt 文本不会出现在已有请求里。
- **对 MCP 外部读取：会。**
  - `today_context` 返回 `now`、`today` 和相对当前时间的提醒（`production-mcp-read.ts:280-297`），每次请求必然可能不同。
  - `find_memories` 的结果依赖检索顺序/相似度；同一段记忆文本在不同查询里可能顺序不同。
  - `maskSensitiveTexts` 是上下文相关的：裸值只有在同一次返回里被别的文字点名时才会被遮（`redaction.ts:552-568,411-425`）。所以同一段记忆文字可能在一次返回里是 `[密码]`，在另一次只返回裸值时是原文；同一批文字换了顺序，也可能因为 `known` 里先记住的类别不同而出现不同占位符。
  - `rule_book` 取决于设置，设置不变则顺序由 `ruleBookFor` 固定。
- 因为这是外部工具响应，不是 KV 缓存前缀；但“同一段文字字节稳定”这个性质在 MCP 读取上不成立，文档里不要把它说成通用保证。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，但不完整。**
- 已读到：`test/integration/mcp-read.test.ts`（10 条，含 401/无记录、失败读取、决策记录写不进则不返回内容、48h 提醒、rule_book 无表达式）、`production-http-composition.unit.test.ts`（未配置 404、只凭令牌 200/401）、`startup-configuration.unit.test.ts`（配置解析正反例）、`redaction.unit.test.ts`（`maskSensitiveTexts` 正例）、`production-mcp-read.unit.test.ts`（`maskForExternalRead` 正例）。
- 反向用例中，鉴权 401、决策记录写失败、失败读取、`expression` 不出现这些确实会在回归时失败；`maskSensitiveTexts` 的“同字节”用例也会在去掉 `#tag` 清理时失败（因为不同批次会得到不同 tag）。
- 但以下没有会失败的用例：
  - `MCP_READ_RUNTIME_UNAVAILABLE` 的两条启动失败路径（第 4 条）。
  - 第 3 轮“confirmed 失败也等 tentative 结束、两路费用都计入”的行为（第 3 条）。
  - 48 小时窗口边界（第 5 条）。
  - 银行卡后四位、裸值单独返回、遮罩抛错分别如何处理（第 2、6 条）。
  - `check:egress-redaction` 对 MCP 外部出口的守护（第 1 条）。
- 我没有运行这些测试，不能确认作者说的 10 条和 `npm run check` 实际通过。

### 4. 每个新产生/修改的值，下游都能接受吗？

逐个核对结果：

- **`runPolicy.mcpRead.secretRef`**：产生于 `parseMcpRead`（`strict-configuration.ts:1081-1086`），要求 `secretReferences` 中恰好一条同 ref、purpose 为 `mcp-read`；运行时 `service-main.ts:1725-1740` 用同样条件查找。两端一致。
- **`MCP_READ_SECRET_PURPOSE = "mcp-read"`**：配置解析、运行时查找、测试三处一致。
- **决策记录 `kind: "external_read"` / `outcome: "read"`**：`DECISION_OUTCOMES` 和迁移 `0069_decision_ledger.sql:48-55` 都允许。
- **`reasonCode` = 工具名或 `<工具名>_failed`**：数据库 `reason_code` 只要求 1-64 字符；decision-chain 合同 `contracts-v2.ts:1027` 用的是 `boundedString(64)`，不是 `machineString`，所以带下划线也能过。`proactiveReviewItem` 不暴露 `reasonCode`；proactive overview 的 `reasonCode: machineString` 只针对 proactive 记录。当前可接受。
- **`subjectRef = mcp-client:<client>`**：数据库 1-256；数据导出 `subjectRef: nullable(text(1,256))`；客户端名正则最多 64 字符，所以长度安全。当前没有下游 `machineString` 校验；但正则允许 `/`，将来若放进 `machineString` 会失败（I-73 类风险）。
- **`inputs.memoryIds`**：`validateLedgerWrite` 要求每项 1-256 且**不重复**。提醒的 `memory_id` 在表里有 UNIQUE（`0055_memory_reminders.sql:5`），所以 `today_context` 不会重复；`find_memories` 的 `shownIds` 依赖 provider 返回不重复的 hit，理论上若 provider 重复返回同一个 memory id，会让整次读取因记录校验失败而变成工具错误。
- **`costMicros` / `durationMs`**：`validateLedgerWrite` 要求安全整数、非负；`durationMs` 上限 86,400,000。嵌入费用来自 `mail.costMicros`（整数累加）；`durationMs` 用两次时钟差，正常读取远小于一天。可接受。
- **`ListedReminder.memoryId`**：只有 `ProductionReminderWriter.list` 生产；MCP 使用它写决策记录，模型侧提醒工具在 `production-reminder-writer.ts:355-362` 明确不发送该字段。两端可接受。
- **`RecallResult.memoryIds`**：`ProductionRuntimeTools` 只解构 `output/contentClassification`；MCP 使用它写记录。可接受。
- **prompt id / manifest**：四个新 id 已加入 `prompt-manifest.json`，`usedBy` 指向实际文件；`check:prompt-catalog` 会核对 hash/清单。未运行，按代码看登记完整。
- **i18n key**：`decision.chain.kind` 在 en/ja/zh-CN 三份资源里都改了，`message-ids.ts` 里已有该 key。可接受。
- **`MCP_READ_PATH`、`MCP_READ_TOOL_NAMES`、`mcpRead` 配置项**：路由、组合、测试、端口类型都已接上；没有发现下游拒绝点。

总体：没有发现“新值一定过不了下游”的硬错误；最值得补的是 `subjectRef` 的 `/` 未来风险和 `inputs.memoryIds` 重复时会导致整次读取失败。
