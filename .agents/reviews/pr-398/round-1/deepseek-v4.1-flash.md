## 侧重检查

- **错误路径**：看了 `mcpProposalAnswer` 的 fast accept/decline/cancel、`NaN`、负时间、`askedAt` 非有限值；`state.askedAt` 非有限值在 `:590`、`:735` 已被判为「内容变了」。
- **不可信输入**：逐个看了确认框里插入的值：记忆正文、客户端名、分类、规则 `summary`、`reason`、五项条件、`kind`、回放数字。正文和理由经 `normalizeProposalText`；`summary` 经 `validRuleSummary`；条件词经 `entries` 和 `listed`；客户端名受正则、分类受枚举限制。发现条件里的 U+2028/2029 只改了显示、没改保存/匹配值。
- **安全 / 不可撤销操作**：`unseen` 分支在记忆和规则两条路径都先于任何持久化返回；`preview`、`decided`、`storedFor`、`OwnerRuleReplay.replay` 均为只读。
- **资源耗尽**：`listed` 最多 32×64 字符×5 列，正文受 MCP body 65 KB 和 2000 字上限约束；本次 diff 没有新增无界循环。自动同意客户端若把新的 `isError` 结果当失败重试，可能反复弹框/回放，属推测，未在代码里看到循环保护。
- **规则/文档一致性**：ADR 0225、0226 已同步成「同意也按 unseen」，和代码一致；只有少量「每个值各占一行」「同意就保存」的文案比代码宽泛。

## 发现

### 1. 低（偏中低）规则条件的显示值和实际保存/匹配值不一致

- **文件:行**：`apps/agent-service/src/production-mcp-read.ts:647-651`、`packages/application/src/rules/rule-types.ts:78`、`apps/agent-service/src/production-mcp-read.ts:598,620`
- **问题**：`listed` 只在渲染确认框时把条件里的 U+2028/2029 换成空格；但 `parseMailMatch.entries` 只拒绝 `\p{Cc}\p{Cf}`，允许 Zl/Zp，返回的 `parsed.params` 原样进入 `proposal.params`。业主同意后，`rules.accept(proposal)` 保存并用于匹配的仍是含 U+2028/2029 的原值。业主看到的是空格，实际生效的是行分隔符。
- **证据**：
  ```ts
  return Array.isArray(value) && value.length > 0
    ? value.map((entry) => String(entry).replace(/[\p{Zl}\p{Zp}]/gu, " ")).join("、")
    : "—";
  ```
  ```ts
  if (/[\p{Surrogate}\p{Cc}\p{Cf}]/u.test(entry)) invalid(`${key} 里有不可见字符`);
  ```
  ```ts
  params: parsed.params,
  ...
  await rules.accept(proposal);
  ```
  新 dialog 用例只断言消息里没有 U+2028/2029，且用 `decline` 结束，没有检查实际保存的参数：`test/integration/mcp-write.test.ts:944-959`。
- **建议**：在 `entries` 里直接拒绝 Zl/Zp（和 `validRuleSummary` 一致），或在提案阶段把 Zl/Zp 归一化成空格后再同时用于 `argsHash`、显示和存储；补一条「同意后读取 `storedRules().parameters`，断言不含 Zl/Zp」的测试。

### 2. 低 新增 auto-accept 用例没验证“同一 requestState 之后真同意仍可保存”

- **文件:行**：`test/integration/mcp-write.test.ts:928-942`；对照 `:576-583`、`:972-979`
- **问题**：代码当前是正确的：unseen 分支在 `production-mcp-read.ts:618`、`:752` 直接返回，未设置 `#decidedRules`，也未写 ledger。但新用例只断言“没写”和“另一个新提议能保存”。如果以后把 unseen accept 错误地记成已拒绝（尤其是 rule 的 `#decidedRules`），现有 `storedRules`/`rulePayloads` 为空仍可能通过，只有同一 state 再 accept 才会暴露。
- **证据**：现有 same-state 后续同意只覆盖 unseen **decline**：
  ```ts
  const later = await f.raw(client, {
    arguments: { text: COFFEE },
    requestState: first.requestState,
    inputResponses: { [MCP_PROPOSAL_CONFIRM_KEY]: { action: "accept", content: {} } },
  });
  expect(later.content?.[0]?.text).toBe(MCP_PROPOSE_MEMORY_SAVED.text);
  ```
  新 auto-accept 用例没有这一步。
- **建议**：在 `[P5-2 auto-accept]` 里保留第一次 `requestState`，超过 1.5 秒后用同一 state 重发 accept，断言 memory 和 rule 都能保存且只写一次。

### 3. 低 自动同意用例没有直接检查 rule 类记忆记录

- **文件:行**：`test/integration/mcp-write.test.ts:411-418`、`:935-938`
- **问题**：`f.external()` 只过滤 `memory:mcp:`（`production-mcp-memory-writer.ts:23`），而规则类记忆前缀是 `memory:rule:mcp:`（`production-mcp-rule-writer.ts:12`）。`rulePayloads()` 能间接覆盖 `memory-content:rule:` payload，但没有直接断言 `memory_records` 里没有 `memory:rule:mcp:`。如果回归只写了 rule 记忆记录、没写 payload/rule，测试会漏。
- **证据**：
  ```ts
  const external = async () =>
    (await repository.productMemoryState().listActive(OWNER_ID, AGENT_ID)).filter(({ id }) =>
      id.startsWith(EXTERNAL_PROPOSAL_MEMORY_PREFIX),
    );
  ```
  ```ts
  expect(await f.external()).toEqual([]);
  expect(await f.decisions()).toEqual([]);
  expect(await f.storedRules()).toEqual([]);
  expect(f.rulePayloads()).toEqual([]);
  ```
- **建议**：在 auto-accept 和 rule unseen 用例中直接查询 active records 里的 `memory:rule:mcp:`，或让 `external()` 接受前缀参数。

### 4. 低（文档/文案）ADR 的“每个值各占一行”和确认框的“同意就保存”略宽于代码

- **文件:行**：`docs/adr/0225-external-agents-propose-memory-with-in-client-confirmation.md:58`、`docs/adr/0226-external-agents-propose-rules-through-the-rule-proposal-flow.md:55`、`packages/prompt-catalog/src/tools.ts:318-322,450-457`
- **问题**：ADR 说外部给的每个值各占一行带固定标签，但代码里 `client`、`category`、`replay` 与固定标签在同一行。安全上没问题（这些值分别受正则、枚举、数字限制），但描述不精确。另外确认框首行写“同意（Accept）就保存/生效”，没有说明“1.5 秒内的同意会被判没显示”，与本次新增判定在文案上有小落差；`mcp.propose-not-shown` 是事后解释。
- **建议**：ADR 改成“正文、规则说明、理由、各项条件各自成行；客户端名、分类、回放数字受约束并同行”；若要在确认框里就避免误解，可加一句“看到本框后再确认”。

## 读代码证实的

- `mcpProposalAnswer` 的新逻辑：`:182` 先判断时间，再区分 accept；`accept` 在 1500ms 内返回 `unseen`，边界值 1500ms 返回 `accepted`。
- 记忆路径 `:751-758` 和规则路径 `:617-631` 都在 `unseen` 时直接返回，没有调用 `proposals.keep`/`proposals.decline`/`rules.accept`，也没有设置 `#decidedRules`。
- 规则 preview 链只读：`ProductionMcpRuleWriter.preview` 调 `ProductionOwnerRuleWriter.preview`（`:571-589`），`#replay` 调 `OwnerRuleReplay.replay`（`:130-188`），没有持久化。
- `ProductionMcpMemoryWriter.decided` 只读 ledger/memory state（`:104-117`）；`ProductionMcpRuleWriter.decided` 只读 payload/规则（`:62-68`）。
- 条件显示清洗和存储链路如发现 1；`text`/`reason` 的规范化确实覆盖 Cc/Cf/Cs/U+2028/U+2029（`production-mcp-memory-writer.ts:39,52-54`）。
- 三个改了文字的 prompt 的 manifest 哈希都更新了：`mcp.propose-memory-confirm`、`mcp.propose-not-shown`、`mcp.propose-rule-confirm`（`prompt-manifest.json:352-356,392-396,412-416`）；哈希是否正确没有重算，依赖现有 `digest()` 测试。
- 新测试：`mcpProposalAnswer` 边界、auto-accept、dialog 注入、`PROMPT_MANIFEST_UNKNOWN` 反向用例都存在。未实际运行。

## 推测

- 自动同意客户端如果对 `isError` 结果自动重试，可能在新的 unseen accept 分支反复弹框/回放；当前 diff 没有对同一提议的 unseen 重试做缓存或退避。是否真会循环取决于客户端，未验证。
- 修改这几个提示词会改变 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts:10-13`）。我核对到这些文字只被 `production-mcp-read.ts` 使用，不在 Himawari 内部模型请求路径；若旧文字曾出现在内部历史里，理论上会改变遮盖结果，但未找到这样的路径。
- `listed` 假设 `preview.params` 已经过 `parseOwnerRuleParameters`。当前生产实现满足；将来若新增规则类型返回非字符串或带换行的参数，`listed` 只替换 Zl/Zp 就不够。

## 必答问题

1. **不会改变 Himawari 自己模型已经见过的请求开头。** 改动只在 `production-mcp-read.ts` 的 MCP 确认/结果路径和 `prompt-catalog` 的 tool-result/elicitation 文字；`MCP_TOOL_PROPOSE_MEMORY`、`MCP_TOOL_PROPOSE_RULE` 等工具定义文字没改，`usedBy` 只有 `production-mcp-read.ts`，ADR 0225/0226 也写明内部模型请求一字节不变。对外部 agent 来说，新文字也是作为确认请求或工具结果追加在末尾，不重写历史。每轮会变的回放数字只在确认框说明里，不在系统提示或工具定义里。唯一需要留意的是提示词文字变化会改变 `TRUSTED_PROMPT_TEXTS`，但已核对没有内部请求使用这些文字。

2. **没有新引入“同一段文字在不同请求变成不同字节”的问题。** 条件列表经 `entries` 去重并排序，`listed` 按固定顺序输出；正文和理由 NFC 规范化并替换不可见字符；`summary` 校验；客户端名受正则、分类受枚举、回放是数字。确认框里的回放数字会随邮件数据变化，但这是既有的一次性说明值，不是由前后文决定的遮盖，也不在模型前缀里。发现 1 是显示值和保存值不一致，不是同一段文字在不同请求变字节。

3. **有自动检查，反向用例在旧代码上会失败。** `mcpProposalAnswer` 边界断言覆盖 accept/decline/cancel 和 `NaN`；auto-accept 集成用例在旧实现上会保存而不是返回 unseen；dialog 用例在旧 `listed` 下会看到 U+2028 或旧标签；`PROMPT_MANIFEST_UNKNOWN` 反向用例在删掉未知项检测时会失败。manifest digest 测试也会守哈希。我只读了代码，未运行测试；缺口是发现 2、3 的 same-state accept 和 rule 类记忆记录没有直接断言。

4. **两端核对结果**：`mcpProposalAnswer` 的 `unseen` 只被 `:618` 和 `:752` 使用，两处都在写之前返回；`preview`/`decided`/`storedFor`/`replay` 只读；`MCP_PROPOSE_NOT_SHOWN.text` 被记忆、规则两条路径和测试使用；两个确认 prompt 只被 `renderPrompt` 使用；三个改文字的 manifest 项都更新了哈希；`listed` 的输出只进入条件的渲染。唯一端到端不一致是发现 1：显示端的 Zl/Zp 被替换，保存端没有。
