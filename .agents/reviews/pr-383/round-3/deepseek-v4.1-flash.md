## 结论

读代码后没有发现会破坏“同一提议只落一种结论”的高危缺陷；排队实现本身的异常传播、`Map` 清理和链式等待逻辑是正确的。主要问题在新用例的断言方式：它在正确实现下也可能偶发失败。另有一些错误路径和测试覆盖上的小缺口。

## 问题（按严重度）

### 中：并发用例的断言依赖请求到达顺序，正确实现也可能假失败

- 位置：`test/integration/mcp-write.test.ts:455-460`
- 证据：

```ts
const final = kept ? MCP_PROPOSE_MEMORY_ALREADY_SAVED.text : MCP_PROPOSE_MEMORY_DECLINED.text;
expect(outcomes.slice(1).map((outcome) => outcome.content?.[0]?.text)).toEqual([
  final,
  final,
  final,
]);
```

- 问题：`outcomes` 的顺序是 `Promise.all` 的数组顺序（第 445-450 行：accept、decline、accept、decline），但 `#oneAtATime` 的获胜者取决于请求真正到达 `#oneAtATime` 的顺序，不保证是数组第一个。若实际先处理的是数组第 3 个请求（`clients[1]` 的 accept），则返回 `SAVED` 的是 `outcomes[2]`，而 `outcomes[1]` 和 `outcomes[3]` 都是 `ALREADY_SAVED`；`kept` 为 true、`final` 为 `ALREADY_SAVED`，断言期望 `outcomes[2] === ALREADY_SAVED`，于是失败。此时“只记录一个结论”其实是对的，用例却红。
- 建议：不要假设哪个数组元素获胜。按重数断言：`kept` 时恰好一个 `SAVED`、其余三个 `ALREADY_SAVED`；否则四个都 `DECLINED`。或者只断言集合/计数，再用 `rows` 判断最终结论。

### 低：`normalizeProposalText` 在 `try` 之外调用，异常不会走 `onFailure`/`FAILED`

- 位置：`apps/agent-service/src/production-mcp-read.ts:354-369`
- 证据：

```ts
const started = Date.parse(this.#options.clock.now());
const text = normalizeProposalText(typeof args["text"] === "string" ? args["text"] : "");
...
const state = context.mcpReq.requestState<ProposalState>();
try {
```

- 问题：当前 `normalize()` 使用固定合法参数、正则替换不会抛，所以这条路径目前应该不会失效；但一旦以后规范化里加入会抛的校验或运行环境差异导致异常，它会直接逃出 `#proposeMemory`，既不调用 `this.#options.onFailure(error)`，也不会返回 `MCP_PROPOSE_MEMORY_FAILED`。
- 建议：把 `started`、规范化、`argsHash` 计算也放进 `try`，保证所有不可信输入处理都由同一个错误出口兜住。

### 低：“对方自称”的客户端名没有写进签名状态，重发时可以变化

- 位置：`apps/agent-service/src/production-mcp-read.ts:112-116`、`337-343`、`389-394`，以及 `production-mcp-memory-writer.ts:133`
- 证据：

```ts
interface ProposalState {
  readonly tool: "propose_memory";
  readonly proposalId: string;
  readonly argsHash: string;
}
```

```ts
const proposal: ExternalMemoryProposal = {
  proposalId: state.proposalId,
  text,
  category,
  client,
};
```

- 问题：`text`、`category` 都用签名状态里的 `argsHash` 核对过，但 `client` 是每次请求从当前的 envelope/User-Agent 重新解析的。初始确认框显示的客户端名和重发时写入拒绝账本的 `mcp-client:<客户端名>` 可能不同。这个值本来就是“自称”、不可信，不是安全边界，但会让审计记录与主人当时看到的确认框不一致。
- 建议：把初始解析出的 `client` 也放进签名状态并在重发时核对/复用它；至少要在代码注释或 ADR 里明确 `subjectRef` 来自最后一次请求的元数据，不是确认时看到的值。

### 低：测试覆盖缺口与文档措辞

- 位置：`apps/agent-service/src/production-mcp-read.ts:414-427`（队列实现）、`test/integration/mcp-write.test.ts:463-476`、`docs/adr/0225-...md:71,114`
- 问题：
  - 没有直接用例覆盖“队列里的 `work` 抛异常后，后一个请求仍能执行、`Map` 条目被清理、同一提议可继续处理”。实现读起来正确，但这条错误路径只有推理，没有自动检查。
  - 没有测试覆盖不同 ref、但解析出相同密钥值时构造器抛 `MCP_WRITE_SECRET_REUSED`（`production-mcp-read.ts:223-224`）；配置测试只覆盖了 `writeSecretRef === secretRef` 这种同一个 ref 的情况。
  - `normalizeProposalText` 的新类（`\p{Cf}`、`\p{Cs}`、U+2028/2029）只测了纯函数返回值；端到端只验证了长度，没有断言确认框和存下的正文确实使用规范化后的文本（既有的 U+202E 用例覆盖了一部分 Cf）。
  - ADR 写“落单的代理项……所以先去掉”，代码实际是“换成空格”（`production-mcp-writer.ts:52-54`）。语义上空格会参与 2000 字长度计数，和“去掉”不完全一致。
- 建议：补一个直接单测，向 `#oneAtATime` 注入一次会 reject 的 work 再发一个同 id 的 work；补同一密钥值不同 ref 的启动测试；在新格式化用例里断言 elicit 消息和 `readText`；把 ADR 的“去掉”改成“换成空格”。

## 推测（未完全证实）

- 理论上，新增提示词目录条目会扩大 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts:10-14`、`entry.ts:61-70`）。如果一段老历史恰好逐字包含新增的、不少于 24 字符的固定文字，出口遮盖结果可能改变，从而使该对话的请求开头变一次（`prompt-prefix.md` 第 11 条明确提醒过）。新增文字都是 MCP 提议/确认专用长句，老对话命中的现实概率极低，所以我认为实际不会改变已有请求开头；但这是推理，不是跑 `check:prompt-prefix` 验证的结果。
- 生产是否严格单进程，我只看到 ADR 0225 和 ADR 0222 的文字以及 `apps/agent-service` 里没有 cluster/fork 代码；没有核查实际部署配置。若将来改成多进程，跨进程重发不会被排队，但会被 HMAC 状态校验拒绝，表现为错误而不是重复落账。

## 侧重检查

- **错误路径**：空/超长/非法分类走 `INVALID`（`production-mcp-read.ts:359-364`）；不支持 elicitation 走 `UNSUPPORTED`（371-372）；未就绪走 `NOT_READY`（373-374）；状态不匹配走 `CHANGED`（381-388）；`keep`/`decline` 抛错走 `FAILED`（408-410）。队列的 `settled` 永远 resolve，一个 work 失败不会阻断后续 work（414-427）。唯一缺口是规范化在 `try` 外，见上面“低”。
- **不可信输入**：`text` 先做类型检查；`category` 既过 JSON Schema enum 又过代码列表；客户端名被 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}` 截断（`production-mcp-read.ts:76`），不能注入换行；`requestState` 用 HMAC 保护，篡改用例期望抛错。
- **安全**：写工具只在现代协议且 `himawari:write` scope 下注册（311-345）；写令牌和读令牌是两个 `BearerGate`（217-232），构造器拒绝同一密钥值；`admit` 先判断写令牌再走对应 gate（243-249）。没有发现绕过确认框的写入口。
- **资源耗尽**：请求体上限 64 KiB（`MCP_READ_BODY_LIMIT`，63-64）；规范化是 O(n)；`#deciding` 只保存正在处理的提议，最后一个 work 的 `finally` 会删除（414-427）；未发现按请求无限增长的集合。若底层数据库调用永久挂起，对应提议的队尾会一直等待，这是理论风险。
- **不可撤销操作**：这个改动只新增“主人确认后保存记忆”，没有新增删除/覆盖/对外副作用；保存的记忆可通过既有记忆删除路径撤销。队列先到先得意味着并发的拒绝/保存只有先到的生效，这是 ADR 明示的取舍。
- **文档与代码一致性**：ADR 0225 的 `writeSecretRef`、双令牌、MRTR、状态绑定、队列、规范化、报表分类与代码一致；ADR 0143 新增的 `mcp_proposal_kept/declined` 与 `decision-ledger.ts` 和校准 SQL 一致；ADR 0186 新增的 `memory:mcp:` 判断顺序与 `memory-source.ts`、报表 SQL 一致。唯一措辞偏差是 0225 的“先去掉”实际为“换成空格”。

## 必答问题

### 1. 是否改变模型已见过的请求开头？

**正常路径下不会。** 新增的 `mcp.propose-memory*` 条目只被 `production-mcp-read.ts` 的对外 MCP 服务器引用，没有进入 Himawari 自己组装模型请求的工具/系统提示列表；ADR 0225:77 的“Himawari 自己发给模型的请求一个字节都不变”与代码引用关系一致。正文规范化只影响新保存的外部记忆内容，将来检索到时会作为本轮资料追加在最后一条用户消息里，不改系统提示、工具定义或历史。去掉 `maxLength` 只改对外 MCP 的工具 schema，不是 Himawari 的模型请求。

需要保留的例外：新增目录文字会改变 `TRUSTED_PROMPT_TEXTS`，理论上可能改变老历史中逐字命中新固定文字的遮盖；新增文字不太可能出现在老对话里，因此我判断不构成本次实际前缀变化，但这一点未用 `npm run check:prompt-prefix` 跑过（未核实）。

### 2. 同一段文字是否会在不同请求里变成不同字节？

**规范化后的正文不会。** `NFC → 固定字符类替换 → 合并连续空格 → trim` 只取决于输入字符串本身，不依赖时间、其他消息或对象遍历顺序（`production-mcp-memory-writer.ts:52-54`）。`argsHash` 也按固定数组顺序计算（`production-mcp-read.ts:365-367`）。没有新增无序集合或时间字段进入这段文字。

会随请求变化的只有确认框里的“对方自称”客户端名：它来自每次请求的 envelope/User-Agent，且不在签名状态里；但它不进入存储正文，只影响确认显示和拒绝账本的 `subjectRef`，见上面的低严重度问题。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有新用例，但我没有执行测试，以下按代码路径推断：

- `records exactly one outcome…`（`mcp-write.test.ts:430-461`）：去掉排队后，四个请求会各自先读到“未决定”，随后保存和拒绝会各写一条不同 id 的账本行，`rows` 会变成 2，因此 `toHaveLength(1)` 会失败，能达到反向检查目的。但它的 `outcomes.slice(1)` 断言有顺序假设，正确实现下也可能假失败，见“中”问题。
- `removes invisible formatting…`（463-476）：旧正则不含 U+061C、U+180E、U+2028/2029 和落单代理项时纯函数断言会失败；恢复 `maxLength` 时，带 50 个零宽字符的请求会在 SDK schema 层被挡掉，拿不到 `input_required`，也会失败。这个反向用例是有效的。
- 既有 `saves one memory however many times… concurrently`（398-428）在“无排队且无重试”时也会出现一个 `FAILED`，因此也能抓到组合回归。
- 缺口：没有直接测队列 work 抛异常后的清理/继续执行；没有测 `MCP_WRITE_SECRET_REUSED`；新增 Cf/Cs/2028/2029 没有端到端断言确认框和存储正文。提示词清单哈希我没有工具重算，属于未核实，但 `prompt-catalog.unit.test.ts:300-319` 会在清单陈旧时失败。

### 4. 每个产生的值，使用它的地方都能接受吗？

- `memory:mcp:<uuid>`：47 字符，符合领域标识 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`（`packages/domain/src/identifiers.ts:39`）；控制中心按同一前缀识别（`memory-source.ts:4,24`），报表 SQL 同样按 `memory:mcp:%` 分类（`memory-source-report.mjs:23`），且有一致性测试读取两处源码。
- `memory-content:mcp:<uuid>`：作为 payload ref 存入/读取；`sqlite-durable-operations.ts:1695-1742` 没有更严的长度/字符校验，能接受。
- 账本 id `ledger:mcp-proposal:<uuid>:kept|declined`：约 65 字符，`validateLedgerWrite` 允许 id 1–128、reasonCode 1–64、subjectRef 1–256（`sqlite-decision-ledger-operations.ts:51-65`）；`kept`/`discarded` 在 `memory_candidate` 的结果列表里（`decision-ledger.ts:44-58`）；分类值都在 `DECISION_CATEGORIES` 里（85-96）。
- `runPolicy.mcpRead.writeSecretRef`：严格配置允许该键、要求引用唯一且 purpose 为 `mcp-write` 的密钥（`strict-configuration.ts:1104-1113,1466-1472`），启动时按同一 purpose 查找（`service-main.ts:1767-1772`），构造器再拒绝与读密钥同值（`production-mcp-read.ts:223-224`），`BearerGate` 再检查最小长度；配置用例覆盖了同 ref、错 purpose、缺失和类型错误。
- 报表 state `external`：控制中心 union、计数、三种语言文案、报表 `SOURCE_STATES` 和标签都补齐；`memory-source-report.test.ts` 还校验了前缀和 writer 常量一致。
- 新增提示词 id：都已写入 `prompt-manifest.json`，清单测试会检查缺失/陈旧；具体 sha256 是否正确未重算（未核实）。另有一个小风险：`MCP_PROPOSE_MEMORY_INVALID` 和控制中心文案里的“2000”是硬编码，和 `EXTERNAL_PROPOSAL_TEXT_MAXIMUM` 没有测试绑定，改常量时可能漂移。
