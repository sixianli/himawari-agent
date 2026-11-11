I'll start by examining the diffs and relevant code.
已核对增量 `0c8e8908..4f066f6e`，并对照了相关生产代码与测试。结论：作者第 1、3 条说法与代码一致；第 2 条的文字已改、清单也换了哈希，但哈希值本身无法用只读工具复算，只能说“已更新”，不能说“已同步正确”。另外发现同文件里还有一处工具说明与校验规则相反。

## 发现（按严重度）

### 中：`propose_rule` 的工具说明仍允许“只给 excludePhrases”

- 文件：`packages/prompt-catalog/src/tools.ts:421`
- 问题：`MCP_TOOL_PROPOSE_RULE` 把五个参数列完后写“至少给一项”，按字面理解，只给 `excludePhrases` 也算一项；但实际校验要求 `senderDomains`、`senderAddresses`、`phrases`、`words` 至少一项。本轮只改了错误提示，没有同步这条外部 agent 最先看到的工具说明。
- 证据（读代码证实）：
  - `packages/prompt-catalog/src/tools.ts:421`：`params 写匹配条件：senderDomains 发件域名、senderAddresses 发件地址、phrases 词语、words 英文整词、excludePhrases 排除词，至少给一项；`
  - `packages/application/src/rules/rule-types.ts:107-108`：`if (senderDomains.length + senderAddresses.length + phrases.length + words.length === 0) invalid("至少要有一个发件域名、发件地址、词语或英文整词");`
  - `packages/prompt-catalog/src/tools.ts:556`：`params 里 senderDomains、senderAddresses、phrases、words 至少给一项（只给 excludePhrases 不算）...`
- 建议：把工具说明改成“senderDomains、senderAddresses、phrases、words 至少给一项（只给 excludePhrases 不算条件）”，并同步更新 `mcp.propose-rule` 的清单哈希（当前条目在 `packages/prompt-catalog/prompt-manifest.json:397`）。这会改变外部 MCP 客户端的工具定义，但不影响 Himawari 自己发给模型的请求。

### 低：缺少 `excludePhrases` 单独出现时的反向用例

- 文件：`test/integration/mcp-write.test.ts:797-804`
- 问题：现有非法用例包含 `params: {}`、`phrases: ["留"]` 等，但没有 `params: { excludePhrases: ["広告"] }`。`params: {}` 只覆盖“总和为 0”的结果；如果以后把判断条件误改成把 `excludePhrases` 也算进去，这条测试仍然会通过，无法锁住本轮文字要表达的规则。
- 证据（读代码证实）：`test/integration/mcp-write.test.ts:798` 是 `params: {}`，而同文件没有只含 `excludePhrases` 的用例；实际条件在 `packages/application/src/rules/rule-types.ts:107-108`。
- 建议：在非法用例数组里加一条 `{ ...RULE, params: { excludePhrases: ["広告"] } }`，断言返回 `MCP_PROPOSE_RULE_INVALID.text`。这样“文字说法”和“代码行为”都有正反用例。

## 读代码证实的与推测的

### 读代码证实

- 作者说法 1 正确：`test/integration/mcp-write.test.ts:757` 新增了 `row?.sourceMemoryId?.startsWith(EXTERNAL_RULE_MEMORY_PREFIX)`；`test/integration/mcp-write.test.ts:935-950` 的两个元素、相反顺序也确实存在。
- 作者说法 2 的文字部分正确：`packages/prompt-catalog/src/tools.ts:556` 已明确“只给 excludePhrases 不算”；`packages/prompt-catalog/prompt-manifest.json:428` 的哈希也从 `382189df...` 改成了 `c795670a...`。
- 作者说法 3 正确：`docs/adr/0186-memory-jumps-to-the-owners-original-message.md:44` 已追加 `memory:rule:mcp:` 归入“外部 agent 提议、主人确认的”一句，且与 `docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:64`、页面和脚本一致。
- `memory:rule:mcp:` 的实际生成路径正确：`apps/agent-service/src/production-mcp-rule-writer.ts:72` 传入 `key = mcp:<提议编号>`，`apps/agent-service/src/production-owner-rules.ts:424` 拼成 `memory:rule:${key}`，因此是 `memory:rule:mcp:<uuid>`。
- 该记忆编号能通过下游校验：`packages/persistence-sqlite/src/sqlite-owner-rule-operations.ts:9` 的 `^[\x21-\x7e]{1,128}$` 接受它；迁移 `0087_rule_book_memory_link.sql:247` 的长度约束也接受。
- 页面、脚本、测试三处前缀一致：`apps/control-center/src/memory-source.ts:5,26-29`、`scripts/operations/memory-source-report.mjs:24`、`test/integration/memory-source-report.test.ts:42-51,127`。

### 推测或未核实

- `packages/prompt-catalog/prompt-manifest.json:428` 的 `c795670a...` 是否是当前 `tools.ts:556` 文字的真实 SHA-256，未核实：允许的工具无法重新计算摘要。若它过期，`apps/agent-service/test/prompt-catalog.unit.test.ts:187` 会报 `PROMPT_MANIFEST_STALE`；该测试还有 `370-381` 行的反向用例，但那是通用反向用例，不针对这一条目。
- 外部 agent 看到 `tools.ts:421` 后是否真的会只给 `excludePhrases`，是推测；但说明与校验相反这一点是读代码证实的。
- 我没有实际运行测试；以下关于“反向用例会失败”的判断来自代码推理，不是执行结果。
- `BearerGate` 的限流和密钥比较内部细节未逐行读；本轮改动也没有改它，因此未核实。

## 侧重检查

- 不可信输入：读了 `apps/agent-service/src/production-mcp-read.ts:430-488` 和 `packages/application/src/rules/rule-types.ts:71-116`。参数先经过 JSON Schema 和 `parseOwnerRuleParameters`；长度、条目数、不可见字符、域名字符集都有上限，未发现本轮文字改动绕过校验。
- 错误路径：`production-mcp-read.ts:475-488` 解析失败只返回 `MCP_PROPOSE_RULE_INVALID`，不写提议、不弹确认框；`:520-596` 的异常会走 `MCP_PROPOSE_RULE_FAILED`。`ProductionMcpRuleWriter.accept` 里标记写失败只记诊断，不谎报失败，符合 ADR 0226。
- 资源耗尽：`MCP_READ_BODY_LIMIT = 65_536`；每个列表最多 32 项、每项最多 64 字、整个规则 JSON 最多 16_384 字符。未发现本轮改动引入新的无界循环或无界字符串。
- 不可撤销操作：规则只在 elicitation 明确 `accept` 且勾选后写入；撤销有 `undo`；旧确认由内存记录、`rule-decision:mcp:*` 标记和 `storedFor` 三重拦截。读代码确认，未实际跑测试。
- 文档/代码一致性：ADR 0186、ADR 0226、页面和脚本对 `memory:rule:mcp:` 的说法一致；唯一不一致是 `tools.ts:421` 的工具说明与校验/错误文字相反。
- 安全：写工具只对现代连接和写令牌注册；客户端名受 `CLIENT_NAME` 限制；规则字符串经 `JSON.stringify` 生成 CEL 列表。未发现本轮改动新增泄露路径。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   读代码证实：本轮改动没有改 Himawari 自己的系统提示、内部工具定义或历史消息。`MCP_PROPOSE_RULE_INVALID` 的 `layer` 是 `tool-result`（`packages/prompt-catalog/src/tools.ts:550-557`），它是追加在末尾的工具结果；新增的 `propose_rule` 是面向外部 MCP 客户端的工具，不是 Himawari 内部模型的工具。因此发给 Himawari 模型的内容仍然是“只在末尾追加”，每轮会变的确认框内容（客户端名、回放数字）也在 elicitation/工具结果一侧，不在系统提示或工具定义里。
   需要注意的边界：`TRUSTED_PROMPT_TEXTS` 会包含 `tools.ts` 里所有不少于 24 字的固定文字（`packages/prompt-catalog/src/trusted.ts:10`，`packages/prompt-catalog/src/entry.ts:61-70`）；修改固定文字会改变这个清单。按 `prompt-prefix.md:53`，只有旧文字出现在历史里时才可能影响已有对话的遮盖。这些 MCP 文案不写入 Himawari 自己的对话历史，所以我没有找到实际会改变旧对话请求开头的路径；这一点属于推测性边界，未用真实对话验证。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   读代码证实：本轮错误文字是固定字符串，没有日期、时间、UUID 或哈希。规则参数在放入 `argsHash` 前已经排序：`packages/application/src/rules/rule-types.ts:86` 的 `[...seen].sort()` 和 `:110` 的 `new Set(...).sort()` 固定了列表顺序，`production-mcp-read.ts:489-493` 用解析后的对象计算哈希。外部提议的 UUID 只用于提议/记忆编号，不进入提示文字。
   确认框里的回放数字会随请求变化，但那是 elicitation/工具结果，不是被缓存的前缀；同一构建、同一输入下，固定文案的字节是稳定的。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - `sourceMemoryId` 前缀：有断言（`mcp-write.test.ts:757`）。若 `production-owner-rules.ts:424` 不再使用 `mcp:` key 或前缀常量改变，断言会失败。
   - 列表顺序：有测试（`mcp-write.test.ts:935-950`）。若 `rule-types.ts` 去掉排序，第二次请求的 `argsHash` 会不同，`production-mcp-read.ts:512` 会返回“内容变了”，测试期望 `SAVED`，会失败。
   - 提示词清单：`prompt-catalog.unit.test.ts:187` 会检查哈希；若文字和 `prompt-manifest.json:428` 不一致会失败。通用反向用例在 `prompt-catalog.unit.test.ts:370-381`，但不是针对这一条目的。
   - `excludePhrases` 单独出现的语义：没有专门反向用例；`params: {}` 覆盖不到“只给 excludePhrases”这个具体回归，建议补上。
   - ADR 0186 的那句话没有语义自动检查；只有 `scripts/check-adr-numbers.mjs` 这类链接检查。我没有运行测试，以上是读代码推断。

4. **改动产生或修改的每个值，使用方都能接受吗？**
   - `memory:rule:mcp:<uuid>`：产生于 `production-mcp-rule-writer.ts:72` 与 `production-owner-rules.ts:424`；使用方包括 `mcp-write.test.ts:757`、`memory-source.ts:5,26-29`、`memory-source-report.mjs:24`、`memory-source-report.test.ts:42-51,127`。规则存储的 `MEMORY_ID` 校验和数据库长度约束都接受；页面/脚本按前缀分类也接受。未发现碰撞，因为 `memory:rule:mcp:` 不以 `memory:mcp:` 开头。
   - `mcp.propose-rule-invalid` 清单项：由 `tools.ts:556` 产生，由 `prompt-catalog.unit.test.ts:172-187` 按 `sha256(JSON.stringify(segments))` 消费；清单键存在、哈希字段已更新，但哈希值本身未核实。
   - ADR 0186 新增的 `0226-...md` 链接：目标文件存在；链路检查会接受，具体治理脚本未运行。
   - `sourceMemoryId` 在新规则场景下是 `memory:rule:mcp:*`；但 `production-owner-rules.ts:507` 的“同条件复用已有规则”分支会返回原规则的 `sourceMemoryId`。如果原规则是对话里建立的，其编号是 `memory:rule:<hash>`，不满足新断言。这是 ADR 0226 决定 3 的预期行为，不是缺陷；但不要把 `mcp-write.test.ts:757` 的断言推广成“所有外部提议最终规则的记忆编号都必须有该前缀”。

总体结论：作者三项修改基本落实；需要补的是 `tools.ts:421` 的工具说明（以及它的清单哈希）和 `excludePhrases` 单独出现的反向用例；`mcp.propose-rule-invalid` 的清单哈希值请在可运行环境里跑一次 `prompt-catalog.unit.test.ts` 或 `PROMPT_MANIFEST_WRITE` 复核。
