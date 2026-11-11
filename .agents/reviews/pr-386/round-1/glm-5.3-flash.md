# PR 386 复核（rule_book 列出主人规则）

## 发现（按严重度从高到低）

### 1. 中 · test/integration/mcp-read.test.ts:513-545 · 测试缺口：决定 8 的关键行为没有反向用例
读代码证实的：新增用例只覆盖「能执行」「类型不认识」两条主人规则。以下行为在这次改动的测试路径上没有用例：
- 已撤销（retired）规则不列——唯一防线是 `sqlite-owner-rule-operations.ts:88` 的 `AND (? = 1 OR status IN ('active', 'needs_review'))`，MCP 路径上没有「建一条 retired 规则、断言它不出现在 rule_book」的用例。
- needs_review 规则照常列出且 `enforced: true`——ADR 0219 决定 8 明确写了这一点，但无用例。
- ownerRules 读取失败时整次 rule_book 失败（作者自己也问“是否可接受”）——无用例。失败路径是 `production-mcp-read.ts:289-291` catch 后返回 `MCP_TOOL_RESULT_FAILED`。
- `sources.ownerRules` 未提供时只列内置——可选字段的默认路径无用例。

建议：补这四条用例，尤其前两条是 ADR 明文承诺的行为。

### 2. 低 · apps/agent-service/src/production-mcp-read.ts:173 · 对外参数用原始存储值，不是执行时用的解析值
读代码证实的：`ownerRuleEntry` 在 `enforced: true` 时输出 `stored["params"]`（原始存储 JSON），而执行端用的是 `enforceableOwnerRule` → `parseOwnerRuleParameters` 归一化后的参数（trim、fold、去 `@`、去重、排序，rule-types.ts:79-115）。目前一致，因为唯一写入口存的就是解析产物（`production-owner-rules.ts:521` `parameters: { type: parsed.type, params: parsed.params, summary: parsed.summary }`）；但持久层 `create` 只校验参数的形状和大小、不校验内容（sqlite-owner-rule-operations.ts:125-132），将来若出现第二个写入口写入未归一化参数，对外显示的参数会和实际执行的不一致。建议改为输出解析产物，或在端口层校验。

### 3. 低 · packages/application/src/rules/rule-types.ts:305-310 · enforceableOwnerRule 只吞 RuleTypeError，另一类错误会让整次 rule_book 失败
读代码证实的：`ownerRuleRecord` 里 `assertRuleExamples`（rule-book.ts:474-480）抛的是普通 `Error`（例子和 CEL 表达式不符时），`enforceableOwnerRule` 的 catch 只接 `RuleTypeError`，会把它继续抛出 → `#ruleBook` 失败 → 对外返回工具错误。这与执行端（proactive-mail-check-service.ts:590 同样 `assertRuleExamples`）行为一致，方向上可接受；推测正常归一化数据不会触发（类型测试保证例子与表达式一致），但这条新失败路径同样没有测试。归入发现 1 一并补用例即可。

### 4. 未核实 · 作者关于 npm run check 的说法
读代码证实的：`scripts/run-all-checks.mjs:15-25` 对所有步骤一视同仁，无豁免清单——若 format:check、check:secrets 在干净 main 上失败，`npm run check` 整体失败，与本 PR 无关。推测合理但无法验证“是否真的失败、是否来自 PR 380”（我不能运行命令）。本次改动新增的文字（`isa.go.jp`、`wrong-secret-…` 沿用旧例）不会触发 `scripts/scan-machine-secrets.mjs:5-19` 的任何规则。
另外 `prompt-manifest.json:337-341` 的新 sha256 值我无法复算（不能运行命令），但由 `prompt-catalog.unit.test.ts:300-319` 的清单一致性检查保证，且 370-381 行有「改了文字不更新清单就报 PROMPT_MANIFEST_STALE」的反向用例。

### 读代码证实的其他结论
- 对外 MCP-only：全库 grep，`MCP_TOOL_RULE_BOOK` 只被 `production-mcp-read.ts:259` 引用；`packages/runtime-pi` 里没有 rule_book。Himawari 自己发给模型的请求不含这个工具说明。
- ADR 0219 决定 8、`tools.ts` 新文案、代码三者一致：`owner:` 前缀（rule-types.ts:13、OWNER_RULE_ID）、类型、说明、参数、`enforced`、不给表达式（ownerRuleEntry 无 expression 字段，测试 541 行断言）。
- 失败语义与 settings 相同：都在 `#ruleBook` 里 await，抛错走同一条 catch。

## 侧重检查（普通使用流程走查）
外部程序持静态 token → HTTP MCP 入口（`service-main.ts:1784` 只有配了 `mcpReadSecret` 才装配）→ `tools/list` 看到新文案 → `tools/call rule_book` → `#ruleBook`（settings + ownerRules().list，includeRetired:false）→ `maskForExternalRead` → 决策记录 `reasonCode: "rule_book"`。
- 有测试覆盖：入口鉴权（test:547）、内置+两条主人规则的输出与排序（test:513）、遮盖入口对全部输出生效（`#call`:285，遮盖规则本身另有 trusted-prompt-egress 等检查）。
- 无测试覆盖的路径：retired 排除、needs_review 列出、ownerRules 存储失败、ownerRules 未装配、assertRuleExamples 抛错路径（见发现 1、3）。
- 文档与代码一致性：决定 8 的每句都可对照代码（除了 sha256 数值未核实），未发现文档与代码不一致。

## 必答问题
1. **不改变。** 读代码证实：这个 prompt 只进对外 MCP 服务器的工具说明（production-mcp-read.ts:259），Himawari 自己的模型请求（runtime-pi）不引用它；prompt-catalog 清单照常由 `check:prompt-catalog` 校验。发给模型的内容仍只追加，本改动根本没碰那条链路。
2. **不会。** 读代码证实：rule_book 输出不含时间/日期字段（`updatedAt` 没有输出），内置规则顺序固定（rule-book.ts:489-498），owner 规则按 ruleId 字符串排序（production-mcp-read.ts:420-424），字段为字面量顺序，同数据同字节；工具说明是静态文字，`volatileProblems`（prompt-catalog.unit.test.ts:321）挡住日期/时间/哈希。遮盖确定性是项目级既有保证，maskSensitiveTexts 内部实现未深查（未核实）。
3. **部分有。** 读代码证实：清单哈希检查带真实反向用例（会失败）；integration 用例覆盖能执行/类型不认识两条。缺口：retired 排除、needs_review 列出、存储失败三条承诺行为没有用例，反向场景目前不会被抓到——这是本次最大的问题（发现 1）。
4. **能接受，但有一处低风险。** 新值逐一核对：`owner:` 编号（端口正则 OWNER_RULE_ID 校验通过）、`status`（枚举 active/needs_review）、`origin: "owner_setting"`（与内置 origin 枚举一致）、`enforced`/`gate`/`outcome`（与内部规则列表 production-owner-rules.ts:653-660 同源同义）、`parameters`（写端存解析产物，读端吐原始值——两端目前一致，见发现 2 的隐患）；`rule_book` 整体失败语义与 settings 一致，作者已声明、可接受，但缺测试。清单 sha256 由自动检查兜底（数值本身未核实）。
