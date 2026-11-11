## 侧重检查

我按「错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性」逐项看了这些地方：

- **不可信输入**：`normalizeProposalText` 会去掉控制字符、格式字符和换行（`production-mcp-memory-writer.ts:39,52-54`）；`reason`/`summary`/`params` 在弹框前校验；`askedAt` 只从 HMAC 状态里取，并检查 `Number.isFinite`（`production-mcp-read.ts:574,717`）。
- **错误路径**：状态损坏/`askedAt` 非数字回 `CHANGED`；时间算不出来按 `unseen`；`decided` 读取失败走 `FAILED`；验收脚本参数错误在碰任何文件前抛错。
- **安全**：写令牌和确认框的信任边界已在 ADR 里写明「确认框不是防恶意客户端的边界」；验收脚本令牌 600 权限且不打印。
- **资源耗尽**：没有新增无界集合；`#decidedRules` 仍按确认状态 TTL 清理；慢读取只存在于测试 Proxy。
- **不可撤销操作**：`unseen` 不写库、不写拒绝记录；真实拒绝在规则路径会进 `#decidedRules` 并挡住后续同意 10 分钟（`production-mcp-read.ts:611-615`），这是既有设计，但下面第 1 条会提到误判风险。
- **规则/文档一致性**：发现 ADR 里仍有旧勾选框表述，见第 2 条；其余 `askedAt`、边界说明与新文字一致。

## 发现（按严重度）

### 1.（中）1.5 秒判定只排除了读库时间，没有排除请求进入 handler 之前的排队；ADR 的「不含服务端排队」说法过宽，测试也没覆盖这个缺口

**【读代码证实】** 计时起点取在工具 handler 内部：

```ts
// apps/agent-service/src/production-mcp-read.ts:533
const received = Date.parse(this.#options.clock.now());
```

```ts
// apps/agent-service/src/production-mcp-read.ts:601
const outcome = mcpProposalAnswer(answer.action, state.askedAt, received);
```

```ts
// apps/agent-service/src/production-mcp-read.ts:684
const started = Date.parse(this.#options.clock.now());
// :733
const outcome = mcpProposalAnswer(answer.action, state.askedAt, started);
```

读库和 `#oneAtATime` 的等待确实在起点之后，所以被排除了；但 HTTP 服务器队列、事件循环积压、网络往返没有排除。ADR 写的是「按重发到达时计，不含服务端排队和读库的时间」（`docs/adr/0225-...:57`、`0226-...:54`）。

**【推测影响】** 如果服务器繁忙或客户端往返超过 1.5 秒，桌面 App 的秒回拒绝会被记成「主人真拒绝」：记忆路径写 `discarded`，规则路径写入 `#decidedRules` 并挡住后续真正同意 10 分钟。新增的慢读取测试只模拟了 `decided()` 返回之后把时钟拨快（`test/integration/mcp-write.test.ts:296-308,580-587`），没有模拟 handler 之前就延迟的情况。

**建议**：要么在 HTTP 入口记录到达时间并把它传进工具 handler，使「不含服务端排队」真正成立；要么把 ADR 改成「按进入工具处理时计，包含网络和进入前排队」，并考虑给 1.5 秒留余量。补一条在 handler 之前延迟、而不是只在 `decided` 之后延迟的用例。

### 2.（低）ADR 里仍有「没勾选」的旧说法，ADR 0226 规则确认还写成「保存」，与代码和本轮「勾选框已去掉」不一致

**【读代码证实】** 代码已经没有勾选字段：

```ts
// apps/agent-service/src/production-mcp-read.ts:662,778
requestedSchema: { type: "object", properties: {} },
```

但文档里还留着：

```md
// docs/adr/0225-...:114
拒绝、取消、没勾选都不写
// docs/adr/0226-...:98
拒绝、取消、没勾选，规则手册和载荷库里都没有新东西。
```

ADR 0226 规则确认的文字仍写成「保存」：

```md
// docs/adr/0226-...:54
同意（Accept）就保存、拒绝（Decline）不保存
```

而实际提示词是「同意（Accept）就生效」（`packages/prompt-catalog/src/tools.ts:434`）。另外 `MCP_PROPOSE_NOT_SHOWN` 的 purpose 仍只写「立刻回了拒绝」（`tools.ts:362`），正文已经是「拒绝或取消」（`tools.ts:366`）。

**建议**：把这两处测试清单里的「没勾选」删掉或标成旧版本；ADR 0226 改为「生效」；purpose 改为「拒绝或取消」。本轮「旧勾选框句子已标为 11-11 之前」只完成了决定段，后果段和元数据没完成。

### 3.（低）ADR 明确写了「状态里的 askedAt 无效回内容变了」，但没有对应自动用例；慢读取用例本身也没有断言 Proxy 真的生效

**【读代码证实】** 校验存在：

```ts
// apps/agent-service/src/production-mcp-read.ts:574,717
!Number.isFinite(state.askedAt) ||
```

测试只直接测了 `mcpProposalAnswer` 的 `answeredAt` 为 NaN：

```ts
// test/integration/mcp-write.test.ts:528-533
expect(mcpProposalAnswer("decline", 0, Number.NaN)).toBe("unseen");
```

没有一条用例构造 `askedAt` 无效的签名状态并断言回 `MCP_PROPOSE_MEMORY_CHANGED`。另外慢读取用例没有断言时钟被拨快或 `decided` 被包装调用；如果以后 `slowDecided` 包装失效，用例仍会因为 10ms < 1.5s 而通过，不再证明「读库后计时会失败」。

**建议**：补一条 `askedAt` 无效（例如用返回非法时间的测试时钟签出状态）回 `CHANGED` 的用例；慢读取用例加一个「时钟确实被推进」的断言或计数器。

### 4.（低）验收脚本的 serve/report 路径没有自动检查，只有参数错误用例

**【读代码证实】**

```js
// test/tooling/mcp-write-acceptance.test.mjs:11-24
it.each([...])("refuses %j before touching anything", (args) => { ... });
```

只覆盖了参数解析。`scripts/operations/mcp-write-acceptance.mjs` 里真正创建数据库、启动 Fastify、报告查询的路径没有测试；如果 `seed` 的表结构或 `report` 的 SQL 和实际 writer 前缀不匹配，只有人工验收时才会发现。前缀我对照过 writer 常量：`memory:mcp:`、`memory:rule:mcp:`、`rule-decision:mcp:`、`mcp_proposal_*`，目前看是对得上的，但 `serve`/`report` 本身未核实可运行。

**建议**：至少加一个用临时目录启动 `serve` 再调用一次 `report` 的 smoke test；如果环境允许。否则在 ADR/验收记录里明确这是人工路径。

### 5.（信息/低）测试 Proxy 对所有用例都生效，而不只在 slowDecidedMs 设置时；未发现会改变其他方法行为，但包装面比需要的大

**【读代码证实】**

```ts
// test/integration/mcp-write.test.ts:296-308
const slowDecided = <T extends object>(target: T): T =>
  new Proxy(target, {
    get(inner, key) {
      const value = Reflect.get(inner, key, inner);
      if (typeof value !== "function") return value;
      if (key !== "decided" || options.slowDecidedMs === undefined)
        return value.bind(inner);
      ...
```

`Reflect.get(inner, key, inner)` 用真实对象作为 receiver，`bind(inner)` 也保留了私有字段和原型；我读了两个 writer 的公开方法，没有发现返回 `this`、比较方法身份或依赖 Proxy receiver 的代码，所以**目前没有看到会改变其他方法行为的证据**。但它对所有测试都换了方法身份，未来若有人依赖方法引用就会踩到。

**建议**：只在 `options.slowDecidedMs !== undefined` 时包一层，其他情况直接返回原对象。

### 6.（低，推测）确认框把不可信的提议正文放在最前面，正文里可以出现「」和与固定说明相似的文字，存在视觉误导空间

**【读代码证实】** 记忆确认框现在是：

```ts
// packages/prompt-catalog/src/tools.ts:313-321
text("把这条存进 Himawari 的长期记忆？\n「"),
slot("text"),
text("」\n\n同意（Accept）就保存，拒绝（Decline）就不存。\n提议方："),
slot("client"),
text("（对方自称）；分类："),
```

规则确认框同样把 `summary` 放在最前面（`tools.ts:430-437`）。`normalizeProposalText` 会把换行/控制字符换成空格（`production-mcp-memory-writer.ts:39,52-54`），所以不能直接插入多行；但正文仍可包含 `」`、`提议方：`、「同意（Accept）就保存」这类字样，在客户端里可能与真正的固定说明混在一起。

**【推测】** 实际渲染由外部客户端决定，我没有看到客户端如何展示、是否隔离固定文字和正文，所以不能确认能否成功冒充。ADR 选择这个顺序是为了避免 Claude Code 折叠成 “+N more lines”，这个取舍可以理解，但安全上应确认客户端不会把正文里的 `」` 和固定说明渲染成同一层级。

**建议**：如果客户端渲染无法保证固定说明与正文的视觉边界，考虑把固定问句放最前、正文单独成段/引用块，而不是让不可信正文先出现；或至少在正文里对 `」` 等会破坏引用边界的字符做转义/替换。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会改变 Himawari 自己发给模型的请求。** 本轮改的 `MCP_TOOL_PROPOSE_MEMORY`、`MCP_TOOL_PROPOSE_RULE`、`MCP_PROPOSE_*_CONFIRM`、`MCP_PROPOSE_NOT_SHOWN` 只被 `apps/agent-service/src/production-mcp-read.ts` 使用（`usedBy` 和 grep 都只指向这个外部 MCP 入口），不是 Himawari 内部模型请求的系统提示/工具定义/历史。`askedAt` 只写进签名后的 `requestState`，不写库、不进模型历史。因此对 Himawari 的模型请求，仍然只在末尾追加，新增的每轮变化值没有进入开头。

**一个需要说明的边界**：这些文本是给外部 MCP 客户端看的工具说明/确认框文字；外部客户端（如 Claude Code）可能把工具定义放进它自己的模型请求开头，升级后它重新拉取工具时可能变一次。这不在 Himawari 的请求拼接范围内，也不是本轮代码引入的每轮变化值。遮盖方面，这些文本会进入 `TRUSTED_PROMPT_TEXTS`，但它们不含日期、长时间戳或类似敏感数字，且不是 Himawari 模型请求里的固定文字；没有发现会导致旧对话遮盖字节变化的证据。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**模型可见的固定文字没有新增时间字段或无序集合。** `askedAt` 是带时间的字段，但它只在签名 `requestState` 里，同一个确认状态重发时 `askedAt` 不变；新文字没有日期、时间或随机值。`#decidedRules` 是 Map，但只用于查找，不参与输出顺序。规则回放数字本来就会随邮件和时间变化，而且只出现在确认框里，不是模型请求开头。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有，且边界检查比较完整：

- `mcpProposalAnswer` 直接测了 1499/1500ms、`cancel`、NaN、负时间（`test/integration/mcp-write.test.ts:528-533`）。
- 两条路径都有 10ms 秒回拒绝的集成用例（`:580-587`、`:886-921`）。
- 按代码推断，把规则/记忆路径改成「读完库再取时间」会让慢读取用例失败，因为 Proxy 在 `decided()` 返回后把时钟拨快 2000ms，而期望仍是 `unseen`；作者说已手动验证，逻辑上成立。
- 提示词清单有现有的 digest/反例测试（`apps/agent-service/test/prompt-catalog.unit.test.ts`）。

**缺口**：`askedAt` 无效状态没有自动用例；慢读取用例没有断言 Proxy 真的执行了；验收脚本 serve/report 没有端到端用例；我在这里不能实际运行测试，所以「会失败」是代码推断，不是运行结果。

### 4. 每个新产生/修改的值，使用它的地方都能接受吗？

逐项核对：

- `mcp.propose-not-shown`：已加入 `packages/prompt-catalog/prompt-manifest.json`，`production-mcp-read.ts` 导入并在两条路径使用，测试导入并断言；无残留引用。**manifest 的 sha256 我无法在不能运行脚本的情况下独立复算，标为「未核实」；现有 prompt-catalog 测试会校验。**
- 删除的 `MCP_PROPOSAL_SAVE_FIELD`、`MCP_PROPOSE_MEMORY_SAVE_LABEL`、`MCP_PROPOSE_RULE_SAVE_LABEL`：全仓库 grep 无残留引用，manifest 条目已删。
- `MCP_PROPOSAL_UNSEEN_ANSWER_MS`：生产代码和测试都使用，边界一致（不到 1.5 秒为 unseen，等于 1.5 秒为 declined）。
- `askedAt`：只在 `ProposalState`、`#askConfirmation`/`#askRuleConfirmation` 的 mint、两处 `Number.isFinite` 校验和 `mcpProposalAnswer` 使用；没有其他消费者依赖旧状态形状。
- 空的 `requestedSchema: { type: "object", properties: {} }`：测试明确断言了记忆和规则两条路径。
- 验收脚本里的 `memory:mcp:`、`memory:rule:mcp:`、`rule-decision:mcp:`、`mcp_proposal_*` 与 writer 常量一致；但 serve/report 可运行性未核实。

总体上，本轮修改的核心逻辑（unseen 判定、去掉勾选字段、补测试）是成立的；主要遗留问题是计时边界的文档/覆盖缺口，以及 ADR 后果段没有同步清理旧勾选框说法。
