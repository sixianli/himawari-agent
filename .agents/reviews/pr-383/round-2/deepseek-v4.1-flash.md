## 结论

以当前检出的代码为准：**作者列出的第 2 轮代码修改没有出现在仓库里**。`a3d28f` 相对 `b5f36a` 只新增了 `.agents/reviews/...` 复核记录，`apps/agent-service/src/production-mcp-read.ts`、`production-mcp-memory-writer.ts`、`test/integration/mcp-write.test.ts` 都没有变化；`grep oneAtATime` 在整个仓库没有任何匹配。因此下面按实际代码复核。

---

## 发现（按严重度）

### 1. 高：并发下“保存”和“拒绝”仍可能同时落账，`#oneAtATime` 不存在

**文件:行**：`apps/agent-service/src/production-mcp-read.ts:394-404`；`apps/agent-service/src/production-mcp-memory-writer.ts:73-75,104-117,185-198`

**问题**：这是典型的 check-then-act：两个请求先分别 `decided()` 得到“还没有结论”，然后一个走 `keep()`、一个走 `decline()`。两种结论使用的决策记录 id 不同：

```ts
// production-mcp-memory-writer.ts:73-75
function ledgerId(proposalId: string, decision: ExternalProposalDecision): string {
  return `ledger:mcp-proposal:${proposalId}:${decision}`;
}
```

而底层插入只对相同 id 去重：

```sql
-- sqlite-decision-ledger-operations.ts
ON CONFLICT (id) DO NOTHING
```

所以 `:kept` 和 `:declined` 两行都能插入：

```ts
// production-mcp-read.ts:394-404
const decided = await proposals.decided(state.proposalId);
if (decided === "kept") ...
if (decided === "declined") ...
...
if (answer.action === "accept" && ... === true) {
  await proposals.keep(proposal, started);
  ...
}
await proposals.decline(proposal, started);
```

两个并发重发（一个 accept、一个 decline）可以都通过 `decided() === undefined`；`decline()` 只写拒绝记录，`keep()` 写记忆和保存记录。结果是主人拒绝了，但记忆仍然保存，或者同一提议同时出现 `kept` 和 `discarded` 两条结论。这正是作者声称排队要解决的问题，但代码里没有排队。

**建议**：不要只靠进程内 Map。更稳的是让“同一提议只能有一个结论”成为持久层不变量：用只含 proposalId 的唯一约束/单独状态表，或让 kept/declined 共用同一个 ledger id，并用 `INSERT ... ON CONFLICT` + 回读赢家；`keep()` 只有在赢得“保存”结论后才写记忆。若仍要加进程内队列，必须按 proposalId 串行、在 `finally` 清理 Map，并覆盖异常/重入；测试要真正制造 accept 与 decline 的并发。

### 2. 高：作者列出的第 2 轮修改与提交内容不符

**文件:行**：`production-mcp-read.ts:323`、`production-mcp-memory-writer.ts:185-191`；提交 `b5f36a..a3d28f`

**问题**：

- 作者说“`keep()` 里撞主键后重试的分支已删除”，但实际还在：

```ts
// production-mcp-memory-writer.ts:185-191
try {
  await this.#options.memory.applyProposal(proposalRecord, generation, write);
} catch (error) {
  if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.CONFLICT)
    throw error;
  await this.#options.memory.applyProposal(proposalRecord, generation, write);
}
```

- 作者说“工具参数说明去掉了 text 的 maxLength”，实际还在：

```ts
// production-mcp-read.ts:323
text: { type: "string", minLength: 1, maxLength: EXTERNAL_PROPOSAL_TEXT_MAXIMUM },
```

- 作者说“ADR 0225、0143、0186 的文字修正”，但 `git diff 1222bc..a3d28f -- docs` 只改了 0219 和新增 0225；`git log 1222bc..HEAD -- docs/adr/0143... docs/adr/0186...` 为空。

- `git diff --stat b5f36a..a3d28f` 只列出 review 文件；`git log b5f36a..a3d28f -- apps/agent-service/src/production-mcp-read.ts ...` 为空。

**建议**：确认这些修改是否真的丢了或被放到了别的分支；把声称的修改落到实际提交里，再按实际 diff 复核。当前提交说明和代码不一致，不能用作者说法作为复核前提。

### 3. 中：`maxLength` 仍按原始文本/UTF-16 单元限制，与“只按规范化后字符数”矛盾

**文件:行**：`production-mcp-read.ts:320-328,358-363`；`production-mcp-memory-writer.ts:26`

```ts
text: { type: "string", minLength: 1, maxLength: EXTERNAL_PROPOSAL_TEXT_MAXIMUM },
```

处理函数却按规范化后的码点数检查：

```ts
const text = normalizeProposalText(...);
if (text.length === 0 || [...text].length > EXTERNAL_PROPOSAL_TEXT_MAXIMUM || ...)
```

后果：大量不可见字符但规范化后不足 2000 字的正文，会被 schema 的原始 `maxLength` 提前拒绝；emoji 等星形平面字符在 schema 里按 2 个 UTF-16 单元计，而处理函数按 1 个字符计，边界不一致。若 SDK/客户端真的执行 schema，`MCP_PROPOSE_MEMORY_INVALID` 里“去掉不可见字符后……超过 2000 字”的分支对超长原文不可达。

**建议**：按作者说法删掉 `maxLength`（保留 `minLength: 1`），由处理函数统一按规范化后的字符数判断；或把 schema 上限调到能覆盖合法 UTF-16 表示，并补“长不可见字符 + 规范化后合法”和“emoji 边界”的正反用例。

### 4. 中：规范化正则没有覆盖声称的 `\p{Cf}` 和 U+2028/U+2029，仍有双向控制字符漏网

**文件:行**：`production-mcp-memory-writer.ts:39,52-53`

```ts
const INVISIBLE_FORMATTING = /[\p{Cc}​-‏‪-‮⁠-⁩﻿]/gu;
...
return text.normalize("NFC").replace(INVISIBLE_FORMATTING, " ").replace(/ {2,}/gu, " ").trim();
```

实际覆盖的是 `\p{Cc}` 加 U+200B–U+200F、U+202A–U+202E、U+2060–U+2069、U+FEFF；没有 `\p{Cf}`，也没有 U+2028/U+2029。遗漏的包括 U+061C（阿拉伯字母标记，双向控制）、U+206A–U+206F（旧式双向控制）、U+00AD、U+180E 等。确认框直接展示这段文本，主人看到的显示顺序仍可能被双向控制字符影响，存在“看到的内容和逻辑内容不一致”的欺骗面。作者说“把 \p{Cc}、\p{Cf}、U+2028、U+2029 换成空格”，与代码不符。

**建议**：显式使用 `\p{Cf}`（并考虑 `\p{Cc}`、U+2028/U+2029），或者列出完整集合；补充 U+061C、U+206A、U+00AD、U+2028/U+2029 的测试，确认规范化、确认框文本、存储文本和哈希使用同一结果。

### 5. 中：新增的并发用例抓不住真正的竞争，也不是“读取放慢制造竞争”

**文件:行**：`test/integration/mcp-write.test.ts:376-406`

**问题**：用例只是把同一个 `accept` 重发并发执行两次：

```ts
const [one, two] = await Promise.all([f.raw(client, retry), f.raw(client, retry)]);
...
expect(texts.every(text =>
  text === MCP_PROPOSE_MEMORY_SAVED.text || text === MCP_PROPOSE_MEMORY_ALREADY_SAVED.text
)).toBe(true);
```

文件里没有 `setTimeout`、慢读钩子或屏障；而且两条都是 accept，不覆盖 `keep` 与 `decline` 的冲突。keep/keep 本身可以靠 `applyProposal` 的“同内容返回已有”和 ledger 的 `ON CONFLICT (id) DO NOTHING` 收敛，所以这个用例即使没有队列也可能通过，不能证明队列存在或竞争被解决。

**建议**：增加同一 `requestState` 下 accept 与 decline 并发的用例，断言最终只能是“有记忆 + kept”或“无记忆 + declined”，绝不能两者都有；在 `decided()` 或 ledger 读之间注入屏障/慢读，确保两个请求都越过检查再继续；不要依赖 HTTP 客户端的调度顺序。

### 6. 中：校准排除用例不能证明只排除了外部提议

**文件:行**：`test/integration/mcp-write.test.ts:495-500`；`packages/calibration/src/index.ts:640,655-656`

用例断言：

```ts
expect(rows.filter(({ kind }) => kind === "memory_candidate")).toEqual([]);
```

这只能证明“所有 memory_candidate 都被排除了”。如果 SQL 被误写成排除全部 `memory_candidate`，这条用例仍然通过。没有一条普通原因码（例如 `capture_retried`、`approval_rejected` 之外的正常 memory_candidate）作为对照。

**建议**：构造一条非外部的 `memory_candidate`（普通 reason code）和一条外部 kept/declined，断言前者保留、后两者排除；再加一条 reason code 里含下划线但不是 `mcp_proposal_` 前缀的记录，验证 `ESCAPE '!'` 的转义确实生效。

### 7. 中/低：新增提示词会自动进入 `TRUSTED_PROMPT_TEXTS`，可能改变模型出口遮盖结果

**文件:行**：`packages/prompt-catalog/src/trusted.ts:10-13`；`packages/application/src/services/model-egress.ts:225`；`packages/sensitive-capture/src/redaction.ts:244-275`；`packages/prompt-catalog/src/tools.ts` 新增 12 个条目

`TRUSTED_PROMPT_TEXTS` 会把 `tools.ts` 里所有 ≥24 字符的文本片段加入“可信文本”清单，出口遮盖对这些文本不检查。新增的 `mcp.propose-memory`、确认模板片段、各种结果文字都是外部 MCP 专用，却被自动加入同一清单。按 `.claude/rules/prompt-prefix.md` 第 11 条，这份清单本身会影响遮盖结果；如果某段新可信文字碰巧出现在模型请求的既有内容里，那个对话的遮法会变，字节就不是“一个都不变”。

实际碰撞概率不高，但这说明“Himawari 自己发给模型的请求一个字节都不变”不是仅凭“新增内容只被 MCP 使用”就能证明的；需要把这批外部专用提示词排除出可信清单，或至少加一个检查/黄金用例，证明现有系统提示和历史遮法不变。

**建议**：把 MCP 专用提示词放到不参与 `trustedPromptTexts` 的模块，或给 `trustedPromptTexts` 加来源过滤；同时补一条回归用例，比较改动前后已有提示词和历史消息的遮盖字节。

### 8. 低：`requestState` 的读取在 `try` 之外，篡改/过期异常不走统一失败日志

**文件:行**：`production-mcp-read.ts:367-368`

```ts
const state = context.mcpReq.requestState<ProposalState>();
try {
```

如果 `requestState()` 校验失败并抛异常，不会进入下面的 `catch`，`this.#options.onFailure(error)` 也不会被调用。结果是协议层直接报错，服务端没有按统一路径记录失败。安全上仍是 fail-closed（不会写），但错误处理和日志不一致。

**建议**：把读取放进 `try`，或明确捕获并返回 `MCP_PROPOSE_MEMORY_FAILED`；同时补一条“过期/篡改状态也会调用 onFailure”的用例。

### 9. 低：文档与代码不一致

**文件:行**：`packages/application/src/ports/decision-ledger.ts:45-52`；`docs/adr/0225-...md`

ADR 0225 前提 7 引用“原话”：

```text
memory_candidate: ["kept", "discarded", "pending_approval"],
```

实际代码已包含 `capture_retrying`、`capture_queued`、`capture_gave_up` 六种。ADR 决定 3 仍写“后到的那个撞上记忆主键冲突，重读一次即可”，这个描述只覆盖 keep/keep，不覆盖 keep/decline 的竞争。作者声称修改的 ADR 0143/0186 也没有在本次 diff 中。

**建议**：更新 ADR 0225 的引用和“只写一次”的机制描述，说明 kept/declined 的持久化互斥方式；若要引用 ADR 0143/0186，先把实际修改提交进来。

---

## 读代码证实的

- `a3d28f` 相对 `b5f36a` 只有 review 文件变化；相关源码文件没有变化。
- 全仓库没有 `#oneAtATime` 或 `oneAtATime`。
- `keep()` 的 CONFLICT 重试分支仍存在（writer:185-191）。
- `propose_memory` 的 inputSchema 仍有 `maxLength`（read:323）。
- kept/declined 使用不同 ledger id（writer:73-75），底层 `ON CONFLICT (id) DO NOTHING` 只去重相同 id。
- `decided()` 先读 kept、再读 declined、再读记忆，没有原子占位（writer:104-117）。
- `normalizeProposalText` 的正则只含 `\p{Cc}` 加若干显式范围，没有 `\p{Cf}`、U+2028/U+2029。
- 新并发用例只有两个相同的 accept，没有慢读/屏障（test:376-406）。
- 校准排除逻辑本身写成 `LIKE 'mcp!_proposal!_%' ESCAPE '!'`，与 reason code 前缀一致（calibration:640,655-656）。
- daily-review 对 declined 的跳过、对外部 kept 的展示路径与 reason code 一致（daily-review:245-248,277-278）。
- memory id、content ref、ledger id、subject ref、category、sensitiveTopic 都能通过各自的后端校验，具体见必答问题 4。
- 报表和网页都加了 `external`，前缀一致，并有交叉检查用例。
- ADR 0143/0186 在 `1222bc..HEAD` 中没有任何提交。

## 推测 / 未核实

- SDK 是否在服务端强制执行 inputSchema 的 `maxLength`：未核实（`node_modules` 不在当前检出里）。即使不强制，客户端也可能按 schema 拒绝。
- `context.http.authInfo.clientId` 是否总能拿到 `BearerGate` 写入的 `clientId`：未核实（SDK 内部实现不可读）；若拿不到，state 只绑定到 method，不绑定令牌种类。
- 并发用例的两个 `client.request` 是否真的同时到达服务端，还是被同一传输串行化：未核实；这也是该用例不能证明竞争已解决的原因之一。
- 提示词 manifest 的 sha256 是否与新文本匹配：无法在只允许 `git` 的环境里计算，未核实；仓库里有 `prompt-catalog.unit.test.ts` 会校验。
- 新增可信提示词是否真的与现有模型请求内容碰撞：未核实，按文本内容判断概率很低。
- `requestState` 过期路径和老版本 `legacyShim` 兜底仍无自动测试，这一点 ADR 自己也承认。

---

## 侧重检查

- **错误路径**：拒绝写不进决策记录时返回 `MCP_PROPOSE_MEMORY_FAILED`，用例存在；`keep()` 的 CONFLICT 只重试一次且非 CONFLICT 会抛出；`requestState()` 读取在 try 外，异常不走 `onFailure`；`#storeText` 在 `applyProposal` 非冲突失败时会留下孤立 payload（资源泄漏面，较小）。
- **不合规范/不可信输入**：category 有白名单；client 名有正则和长度限制；正文做 NFC 和部分不可见字符替换；但正则不完整，见发现 4；`maxLength` 与规范化长度不一致，见发现 3；未配对代理项（lone surrogate）会导致哈希基于 JS 字符串、存储基于 UTF-8 替换字符，存在边界不一致。
- **安全**：写令牌与只读令牌分开，构造器和配置解析都拒绝同一把；HMAC state 每次进程随机密钥，篡改/跨重启失效；未声明 elicitation 的客户端直接拒绝，fail-closed；双向控制字符未清干净，见发现 4；写令牌持有者可自行回答确认框，这一点 ADR 已明确为信任边界。
- **资源耗尽**：请求体 64 KiB，写令牌限流 30 次/分钟；没有每日写入配额（ADR 有意不做）；没有队列，因此不存在队列 Map 泄漏；但每次接受提议都会持久化记忆和 payload，长期无上限。
- **不可撤销操作**：决策记录 append-only；记忆删除后旧确认重放返回 `ALREADY_SAVED`，不会复活（用例覆盖）；但并发 keep/decline 会留下两条互相矛盾的不可撤销结论，见发现 1。
- **规则/文档与代码一致**：`docs/adr/0143`、`0186` 未改；ADR 0225 的引用已过时；作者口述的 maxLength/队列/重试删除三项均与代码不符。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**结论：不会（针对 Himawari 自己发给内部模型的内容）。** 本次新增的提示词条目 `usedBy` 只有 `apps/agent-service/src/production-mcp-read.ts`，供外部 MCP 客户端使用；内部模型组装、系统提示、工具定义、历史消息都没有引用它们。daily-review、calibration、报表都是读取/统计路径，不进入模型请求。因此没有把每轮会变的值挪到请求头，发送内容仍是“固定内容在前、变化内容在末尾”的结构。写令牌拿到的外部工具列表多一个 `propose_memory`，那是外部客户端自己组装的请求，不是 Himawari 发给模型的请求。

需要保留的注意点：新增提示词会自动进入 `TRUSTED_PROMPT_TEXTS`（见发现 7），这属于出口遮盖的“清单”变化；按规则第 11 条，它原则上可能改变老对话的遮盖字节。实际是否改变未核实；当前没有证据表明新文字会出现在既有模型请求里，但不能说“代码层面绝对不会”。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**结论：新增的 MCP 提议路径没有引入依赖前后文的遮盖或不稳定序列化。** 正文 NFC + 固定正则 + 固定空格合并，argsHash 和存储都用同一份规范化文本；结果文字是固定提示词；读工具原有的 `maskSensitiveTexts` 没有改。
但有三类“同一段文字不同字节”的边界要注意：
- `requestState` 每次 mint 都带随机/时间信息，ledger 的 `decidedAt`、`id` 也每次不同；这些不是模型可见文本，是设计使然。
- 同一段正文两次提议会得到不同 UUID 记忆 id，这是“不按正文哈希做提议编号”的有意设计，不是序列化不确定。
- 未配对代理项：argsHash 对 JS 字符串做 JSON 序列化，存储经 `TextEncoder` 会变成 U+FFFD，确认框、哈希、存储并非在所有输入上都字节一致（低概率边界）。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，但覆盖不足，且部分反例并不像作者说的那样有效。**
已有的检查包括：只读/写令牌工具列表、老连接不注册写工具、确认/拒绝/取消/未勾选、客户端不支持确认框、键序不同算同一提议、篡改状态、状态配别的内容、硬删除后重放、拒绝写库失败、每日回顾、校准排除、报表 `external`、网页来源、`writeSecretRef` 配置校验。
不足：
- 并发用例只测 accept+accept，不测 accept+decline，也没有慢读/屏障；没有队列时它也可能通过，不能证明竞争被解决。
- 校准用例只断言所有 `memory_candidate` 都被排除，不能证明普通 memory_candidate 仍被保留。
- 没有针对 `maxLength` 删除后行为、`\p{Cf}`/U+2028/U+2029、同值不同 ref 的写密钥、`requestState` 过期/篡改失败日志的用例。
- 提示词 manifest 的摘要是否与文本一致无法在本次环境验证（未核实）。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐个核对结果：

- **原因码 `mcp_proposal_kept` / `mcp_proposal_declined`**：长度符合 ledger 的 1–64；daily-review 用 Set 跳过 declined（daily-review:245-248）；校准用 `LIKE 'mcp!_proposal!_%' ESCAPE '!'` 排除（calibration:640,655-656）；决策记录校验接受 `memory_candidate` 的 `kept`/`discarded`（decision-ledger:44-58）。一致。
- **决策记录 id `ledger:mcp-proposal:<uuid>:kept|declined`**：长度约 65，低于 128；`read` 和 `append` 使用同一 `ledgerId`。但两种结论 id 不同，导致并发下无法互斥，见发现 1。
- **`subjectRef`**：kept 用 `memory:mcp:<uuid>`（约 47 字符），declined 用 `mcp-client:<client>`（client 经正则限制到 64 字符，总约 75），都低于 256，ledger 校验接受。
- **`inputs.memoryIds` / `ruleIds`**：memoryIds 最多一项，id 长度合规；ruleIds 为空；`contentRef: null`、`confidencePermille: 1000`、`inferred: false`、`costMicros: 0` 都通过 `validateLedgerWrite`。
- **`category`**：`EXTERNAL_PROPOSAL_CATEGORIES` 的九种全部在 `DECISION_CATEGORIES` 和 `MemoryCategory` 中；排除 `rule` 符合 ADR。后端 ledger 校验和 memory 校验都能接受。
- **`sensitiveTopic`**：`health`、`finance`、`other` 都在 `SENSITIVE_MEMORY_TOPICS` 中（automatic-memory:117-128）。
- **记忆 id / 内容 ref 前缀**：`memory:mcp:` 能通过 domain 的 `MACHINE_IDENTIFIER_PATTERN`（允许 `:`，1–128）；报表和网页使用同一前缀并有交叉测试；除报表/网页外没有找到其他按旧前缀分类的消费方。payload 的 `put/get` 签名也匹配。
- **`policyVersion: "memory-mcp:v1"`**：memory 校验只要求非空；`sourceRefs` 非空（提供 `[contentRef]`）；payload 必须先存在且分级一致，`keep()` 先 `#storeText` 再 `applyProposal`，满足。
- **配置键 `runPolicy.mcpRead.writeSecretRef`**：类型、strict parse、purpose 断言、service-main 解析、构造器同值拒绝都接上了；测试覆盖了 ref 字符串相同/purpose 不对/不存在/类型不对。**未覆盖**“ref 不同但解析出的秘密值相同”（只有构造器会拒绝），建议补一条启动测试。
- **新增提示词 id**：`prompt-manifest.json` 里有对应 12 条；`prompt-catalog` 测试会校验缺失/摘要过期/未登记，但本次环境无法计算摘要，未核实。
- **报表/网页 `external`**：`SOURCE_STATES`、标签、`CASE` 表达式、网页 `MemorySourceState`、三种语言文案都加了；`external` 判断在 `deleted`/`tidy` 之前，外部记忆没有来源线程，顺序无冲突；测试覆盖了前缀一致和计数。

总体：**值的两端校验基本对齐，唯一的结构性问题不是某个字段过不了校验，而是“同一提议的两个结论使用两个不同 ledger id”，使并发互斥失效。**
