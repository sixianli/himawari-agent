# 复核结论

仓库当前 `git status` 干净，改动范围与作者描述基本一致。下面先列读代码证实的问题，再列推测，最后逐条回答必答问题。

## 一、读代码证实的问题（按严重度）

### 1. 中：rule 路径的 `answeredAt` 取在多次 await 之后，与 memory 路径不一致，慢 I/O / 重复重发会把 unseen 误记成真拒绝

- 文件：`apps/agent-service/src/production-mcp-read.ts:600-604`、`:687`、`:736`
- 问题：memory 路径在进入处理函数时先取 `const started = Date.parse(this.#options.clock.now())`（`:687`），回答时用 `mcpProposalAnswer(answer.action, state.askedAt, started)`（`:736`），量的是“请求到达时”的间隔；rule 路径却在 `#oneAtATime` 内、`await rules.decided(...)` 之后才取 `Date.parse(this.#options.clock.now())`：

```ts
// :585-604
return await this.#oneAtATime(state.proposalId, async () => {
  ...
  if (await rules.decided(proposal.proposalId))
    return proposalReply(MCP_PROPOSE_RULE_ALREADY_SAVED.text, false);
  const answer = inputResponse(context.mcpReq.inputResponses, MCP_PROPOSAL_CONFIRM_KEY);
  ...
  const outcome = mcpProposalAnswer(
    answer.action,
    state.askedAt,
    Date.parse(this.#options.clock.now()),
  );
```

- 后果：若 `rules.decided` 的两次读库超过 1.5 秒（I-29 记录过数据库操作排到 1.8 秒），或同一 `requestState` 的第二个重发在 `#oneAtATime` 队列里排了超过 1.5 秒，本来 10ms 的桌面 App 自动 decline 会被判成 `declined`，写入 `#decidedRules` 的 `saved:false`（`:614-618`）；之后同一状态真正 Accept 时会在 `:589-594` 直接回 `MCP_PROPOSE_RULE_DECLINED`，再也保存不了。测试只覆盖“单次、无排队”的情况，抓不到这个差别。
- 建议：两处都用请求进入处理函数时的时间（像 memory 的 `started`），在 `#proposeRule` 开头取一次，传给 `mcpProposalAnswer`。

### 2. 中：ADR 0225 / 0226 与代码以及同一段文字自相矛盾

- 文件：`docs/adr/0225-...md:58`、`docs/adr/0226-...md:55`、`:66`
- 证据：PR 在 0225:57 追加了“去掉勾选框，确认框不带字段，同意（Accept）就保存”，紧接着 0225:58 仍写：

> 只有「提交」并且勾了保存，才写记忆；拒绝、取消、提交但没勾，都算没同意，只记一条拒绝的决策记录。

ADR 0226:55 同样仍写：

> Andy 勾选并提交后，才走 P2-3 的流程。……拒绝、取消、提交但没勾，什么都不写

而代码已经完全不看勾选字段：`requestedSchema: { type: "object", properties: {} }`（`production-mcp-read.ts:665`、`:781`），`outcome === "accepted"` 就写（`:738-740`、`:606-612`）。另外 0226:66 仍把“勾选项”列为登记进提示词目录的内容，但 `mcp.propose-rule-save-label` 已删除。
- 建议：改掉 0225:58、0226:55 的“提交但没勾”表述，删 0226:66 的“勾选项”；如保留历史说明，应明确标注“旧做法”。

### 3. 低：`askedAt` 只校验 `typeof === "number"`，NaN / 时钟回退会静默改写判定

- 文件：`apps/agent-service/src/production-mcp-read.ts:573`、`:720`、`:176`
- 证据：

```ts
typeof state.askedAt !== "number" ||
```

```ts
return answeredAt - askedAt < MCP_PROPOSAL_UNSEEN_ANSWER_MS ? "unseen" : "declined";
```

`Date.parse(clock.now())` 返 `NaN` 时 `typeof NaN === "number"` 仍通过；`NaN < 1500` 为 false，会被当成真拒绝并写记录。时钟回退导致差值为负时又会把真拒绝判成 unseen。`requestState` 有 HMAC，外部伪造不了，所以只算健壮性问题。
- 建议：校验 `Number.isFinite(askedAt)`，并明确差值 `< 0` 时的处理；或让 clock 提供单调时间。

### 4. 低：rule 两个提示词的 `changedIn` 被改成 ADR 0225，与同组 rule 条目及 ADR 0226 不一致

- 文件：`packages/prompt-catalog/prompt-manifest.json:399`、`:414`
- 证据：`mcp.propose-rule` 和 `mcp.propose-rule-confirm` 的 `"changedIn": "ADR 0225"`，而紧邻的 `mcp.propose-rule-already-saved`、`-conditions` 等仍是 `ADR 0226`，规则流程由 ADR 0226 定义。测试只要求 `changedIn` 非空（`apps/agent-service/test/prompt-catalog.unit.test.ts:188`），不会失败，但来源记录错了。
- 建议：改回 ADR 0226，或在两个 ADR 之间明确谁负责这次措辞改动。

### 5. 低：验收脚本没有正向自动检查，令牌不泄露 / 0600 / report 只读这些性质没有被测

- 文件：`test/tooling/mcp-write-acceptance.test.mjs:13-24`
- 证据：全部用例都是 `refuses %j before touching anything`，只断言非零退出、stderr 含 `ARGUMENT_INVALID`、stdout 不含 `MCP_ACCEPTANCE_LISTENING`。没有用例启动 `serve`、检查 token 文件权限/内容、或验证 `report` 输出。
- 建议：用临时空目录加一个不依赖完整 build 的单元化入口测 `options`/`writeSecret`；正向 `serve` 用例可标记为需 `build:node` 的独立测试，至少断言 stdout/stderr 不含 token、两个文件是 0600。

### 6. 低：`--host` 任意值可直接把带真实写入器的入口监听到非回环地址

- 文件：`scripts/operations/mcp-write-acceptance.mjs:34-41`、`:217`
- 证据：

```js
if (!["--dir", "--host", "--port"].includes(key) || value === undefined) ...
...
await app.listen({ host: input.host, port: Number(input.port ?? 0) });
```

脚本会打印 `MCP_ACCEPTANCE_LISTENING`。令牌只在 600 文件里，影响有限，但测试机上 `--host 0.0.0.0` 会把写能力暴露到网络。
- 建议：默认或强制 `127.0.0.1`；非回环地址要求显式额外开关并打印警告。

### 7. 低：rule 确认框的 `requestedSchema` 没有自动断言，只有 memory 有

- 文件：`test/integration/mcp-write.test.ts:465`（memory 断言了 `requestedSchema`），rule 用例 `:782-800` 只检查 message，没有检查 schema。
- 后果：以后若有人只在 rule 的 `#askRuleConfirmation` 里把勾选框加回来，现有测试不会失败。
- 建议：rule 用例同样断言 `elicitations[0].requestedSchema` 为 `{ type: "object", properties: {} }`。

### 8. 低：作者“说明文字把正文放在第一行”与实际模板不完全一致

- 文件：`packages/prompt-catalog/src/tools.ts:311-313`、`:431-434`
- 证据：memory 确认文字是 `"把这条存进 Himawari 的长期记忆？\n「"` + 正文，正文实际在第 2 行；rule 是 `"让这条邮件长期规则生效？\n「"` + summary。功能上确实把正文提到了开头附近，但与“第一行”的说法不一致，ADR 里也沿用了这句话。
- 建议：措辞改成“正文紧跟标题、放在最前面”，避免以后按字面理解。

## 二、推测（依赖外部客户端或运行条件，未在代码中证明）

### 9. 中：Accept 完全没有 unseen 检查，声明支持却自动 accept 的客户端会无确认写入

- 文件：`apps/agent-service/src/production-mcp-read.ts:175`
- 证据：

```ts
if (action === "accept") return "accepted";
```

已知桌面 App 的缺陷是自动 decline，所以当前风险低；但这个 PR 的前提正是“客户端声明支持却可能不弹框”。如果某个客户端自动回 accept，记忆/规则会直接写入，后果比自动 decline 严重得多。
- 建议：至少对“极快 accept”做记录/诊断，或者对 accept 也应用同一时间窗判定为 unseen；如果确定不做，应在 ADR 里明确写“客户端自动 accept 不在防护范围、视为客户端已获主人授权”。

### 10. 低：1.5 秒阈值的方向性风险

- 证据：`mcpProposalAnswer`（`:170-177`）
- 说明：Accept 不受阈值影响；Decline/Cancel 在 1.5 秒内一律算 unseen，安全方向是“不写”，但会忽略主人非常快的一次真实“不保存”。反过来，服务端排队/读库慢会把 10ms 的自动 decline 推过 1.5 秒而记成真拒绝（第 1 条已具体化）。阈值本身是启发式，不是安全边界。

## 三、侧重检查

- 错误路径：unseen 分支在 `proposals.decline` / `rules.accept` 之前返回（`:605`、`:737`），不会写记录；`try/catch` 仍回 `MCP_PROPOSE_MEMORY_FAILED` / `MCP_PROPOSE_RULE_FAILED`。读写异常路径未改动。
- unseen 后重复回答：memory 侧 unseen 不写 ledger、不写记忆，之后同一状态 accept 走 `proposals.decided` 返回 `undefined` 正常写一次；rule 侧 unseen 不写 `#decidedRules`、不写 marker，之后 accept 正常写一次。集成测试 `test/integration/mcp-write.test.ts:509-545`、`:837-854` 覆盖了“unseen 后再 accept”。并发重发由 `#oneAtATime` 串行化，未发现重复写。唯一例外是上面第 1 条的排队误判。
- 不可信输入：`askedAt` 在 HMAC 签名的 `requestState` 里，外部不能篡改；传输参数仍走既有规范化/`parseOwnerRuleParameters`。弱点仅是 `typeof number` 校验。
- 安全 / 令牌：验收脚本用 `randomBytes(32)` 生成令牌，`writeFile(..., { mode: 0o600, flag: "wx" })` 后 `chmod(600)`（`:78-81`），只把令牌写进 `read-token` / `write-token`，stdout 只打印监听地址（`:101-105`、`:217-221`）。读代码未见令牌泄露；实际文件权限和 `serve` 能否在 `dist/node-runtime` 下启动未运行验证（未核实）。
- 资源耗尽：`report` 一次性 `rows(...)` 载入验收库，验收库很小；`requestTimeoutMs: 30_000`、Body 上限和 BearerGate 限流沿用生产入口（`:213-214` 等）。没有新增无界循环。
- 文档 / 代码一致：ADR 0225/0226 的矛盾见第 2 条；manifest 的 `changedIn` 见第 4 条。
- I-73 式“产生的值能否被使用方接受”：验收脚本的 `memory:mcp:`、`memory:rule:mcp:`、`owner:%`、`rule-decision:mcp:`、`mcp_proposal_*` 与 `rule_book_rules.source_memory_id` 均已对照迁移和写入器核对（`production-mcp-memory-writer.ts:23,69-75`、`production-owner-rules.ts:424,496`、`production-mcp-rule-writer.ts:11-14`、迁移 `0087`），SQL 能命中；但脚本实际启动、种子数据能否通过所有约束未运行验证（未核实）。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   对 Himawari 自己发给模型的请求：不会。改动的 `MCP_TOOL_PROPOSE_MEMORY` / `MCP_TOOL_PROPOSE_RULE` 以及确认文字在 `packages/prompt-catalog` 里 `usedBy` 只有 `apps/agent-service/src/production-mcp-read.ts`（grep 确认无其他引用），服务对象是外部 MCP 客户端，不是 Himawari 的模型。`askedAt` 只放进签名的 `requestState`（`:668-677`、`:784-793`），不写进 tool description、系统提示或历史消息；`mcp.propose-not-shown` 是工具结果文字。对 Himawari 而言仍是“只在末尾追加、每轮变值只在最后一条消息”。需要提醒：这些工具定义会被外部客户端（如 Claude Code）放进**它们自己的**模型请求开头，升级后会变一次；这不属于本仓库的 KV 缓存约束，ADR 0226:66 的“Himawari 自己发给模型的请求一个字节都不变”成立。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   新逻辑没有把时间/随机值写进提示词文本：确认消息仍是固定标题 + `text`/`summary`/`client`/`replay` 等既有 slot，`askedAt` 只在签名状态里。`requestState` 每次不同是设计使然，且是协议令牌，不参与提示词前缀。列表仍按固定 slot 顺序拼接，没有新增无序集合。因此对模型可见文字没有新增非确定性；memory/rule 确认消息里的 `replay` 命中数仍是既有行为（依赖邮件数据，但属于外部工具的当次结果）。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   有，而且反向有效：`test/integration/mcp-write.test.ts:509-513` 直接断言 1499ms→unseen、1500ms→declined、accept→accepted；`:514-545`（memory）和 `:837-854`（rule）跑真实 SDK 客户端验证 10ms decline 返回 `MCP_PROPOSE_NOT_SHOWN` 且不写记录、之后同状态仍可 accept；`:491-507` 和 `:823-835` 用 3 秒验证真实 decline 仍写入/记录。删掉调用处的 `outcome === "unseen"` 分支或把阈值改成 0，desktop 用例会失败。提示词目录测试 `prompt-catalog.unit.test.ts:175-194,299-319` 会检查新 id 的清单项和摘要。缺口：验收脚本只有参数校验，没有令牌保密/0600/report 的正向自动检查（第 5 条）；rule 的 `requestedSchema` 没有断言（第 7 条）。

4. **每个新值的使用方都能接受吗？**
   - `ProposalState.askedAt`：两处 `#propose*` 都校验了 `typeof === "number"`（`:573`、`:720`），mint 两处都写入（`:674`、`:790`），使用处为 `mcpProposalAnswer`。语义上两端接受，但校验偏弱（第 3 条）、rule 侧的时间取值点不一致（第 1 条）。
   - `MCP_PROPOSAL_UNSEEN_ANSWER_MS` / `McpProposalAnswer`：只在 `production-mcp-read.ts` 与测试使用，导出正常。
   - `mcp.propose-not-shown`：`tools.ts:360` 定义、`production-mcp-read.ts:27,605,737` 使用、manifest `:392-396` 登记；`prompt-catalog` 测试会检查缺项/多项。摘要是否与当前 segments 一致未能离线计算（未核实）。
   - 删除的 `MCP_PROPOSAL_SAVE_FIELD`、两个 `*-save-label` 提示词：全仓库 grep 已无残留引用，manifest 条目也已删除。
   - `requestedSchema: { type: "object", properties: {} }`：memory 集成测试由真实 SDK 客户端实际走通（`:465`），rule 没有显式断言（第 7 条）。
   - 验收脚本产生的 id / 列名：前面“侧重检查”已逐个对照迁移和写入器，能匹配；脚本能否在真实构建产物上启动、种子数据是否满足全部约束未运行验证（未核实）。
   - `mcp.propose-rule` / `-confirm` 的 `changedIn`：测试只要求非空，能接受，但语义错误（第 4 条）。

## 五、未核实项

- manifest 中 `mcp.propose-memory`、`mcp.propose-memory-confirm`、`mcp.propose-not-shown`、`mcp.propose-rule`、`mcp.propose-rule-confirm` 的 sha256 是否与当前 segments 一致（需要运行 `prompt-catalog.unit.test.ts` 或 `PROMPT_MANIFEST_WRITE=1`，本次不能运行）。
- `scripts/operations/mcp-write-acceptance.mjs` 的 `serve` 在真实 `dist/node-runtime` 下能否完整启动（`fastify`、`better-sqlite3`、各 `@himawari-agent/*` 产物路径），以及种子数据在实际迁移后的全部约束下能否插入成功。
- 命令禁止运行，故未跑 typecheck/lint/测试；以上结论均来自读代码。
