> 说明：`git show` 读取 `.agents/reviews/pr-337/round-1/judgments.md` 和 `verdicts.jsonl` 被仓库策略拒绝（records-path），工作区也没有这两个文件，因此作者对第 1 轮结论的转述无法核实。另外我只被允许读文件和少量 git 命令，**没有实际运行测试**；下面关于“用例会不会失败”的判断来自逐条阅读断言，不是执行结果。

## 一、读代码证实的问题（按严重度）

### 1. 中：r1-ds-2 的核心修复“比较读全部条目”没有任何会失败的用例
- 文件:行：`test/integration/decision-email.test.ts:300-343`，`apps/agent-service/src/production-observation.ts:347-361`
- 问题：新增用例只断言 `entries.length` 和 `truncated`，从头到尾没有断言 `comparison`。而用例里 21 条记录全部用 `rate({timingOk:true, contentOk:true})` 生成，存储层把每条都写成 `muse_reminded = 1`（`packages/persistence-sqlite/src/sqlite-muse-intake-operations.ts:497-501`）。因此无论比较用的是“前 20 条”还是“全部”，`pairEntriesByMail` 都会选中一条 reminded 条目，结论不变。把 `production-observation.ts:347` 的 `trace.museEntries.map(...)` 改回 `trace.museEntries.slice(0, MAIL_TRACE_MUSE_LIMIT).map(...)`，这组用例仍然全绿。
- 证据：
  - `production-observation.ts:333-334` 展示用 `slice(0, MAIL_TRACE_MUSE_LIMIT)`；`:347` 比较用全量 `trace.museEntries.map`；`:383` `truncated: trace.museEntries.length > MAIL_TRACE_MUSE_LIMIT`。
  - 用例 `:331-339` 只写 `expect(twenty.muse.entries)...` / `expect(twenty.muse.truncated)...` / `expect(over.muse.entries)...` / `expect(over.muse.truncated)...`。
- 建议：加一条只有“第 21 条是 reminded（或用 `recordMuse` 造出前 20 条 `museReminded:false` + 第 21 条 `true`）”的数据，并断言 `over.comparison` 因看到第 21 条而变成 `both`/`museOnly`。这样反向改动才会真正失败。

### 2. 低：规则编号在邮件页没有做与决策链一致的清洗，可能让整页读取失败
- 文件:行：`apps/agent-service/src/production-observation.ts:321-322`、`:378`；`packages/gateway-contracts/src/contracts-v2.ts:1104`；对照 `apps/agent-service/src/production-decision-chain.ts:56-62`
- 问题：`forMail("floorHits")` 原样返回 `inputs.floorHits[messageId]`；`ruleIds` 契约是 `array(boundedString(256))`，而 `boundedString` 明确拒绝控制字符（`packages/gateway-contracts/src/validation.ts:96-99`）。决策链对同一种数据会先用 `displayRuleId` 把控制字符换成空格，仓库里还专门有用例保证这种“奇怪规则编号”不应让整页失败（`test/integration/decision-chain.test.ts:686-704`，`"rule\nwith\tcontrol"` → `"rule with control"`）。同一个决策在邮件页会走到 `:387 gatewayV2MessageSchema.parse(snapshot)` 抛错，整页只显示“读取失败”。
- 证据：
  - `production-observation.ts:322`：`[...new Set(inputs[field][messageId] ?? [])].sort()`（未清洗）。
  - `contracts-v2.ts:1104`：`ruleIds: nullable(array(boundedString(256)))`。
  - `production-decision-chain.ts:56-62`：控制字符映射为空格。
- 建议：`forMail("floorHits")` 也走同一套清洗（复用 `displayRuleId`/`clean`），或把邮件页规则编号的契约换成与决策链一致的展示值约定。

### 3. 低：r1-ds-3 的放宽没有任何用例，类型检查也兜不住
- 文件:行：`packages/gateway-contracts/src/contracts-v2.ts:1105`（`memoryIds: boundedString(256)`）、`:1112`（`entryId: boundedString(128)`）
- 问题：现有用例里的记忆编号/条目编号全是 `memory-a`、`muse-1`、`rating-*`（`test/integration/decision-email.test.ts:281-292`、`:326`；`apps/control-center/test/weekly-report.unit.test.ts:1175`、`:1181`），这些在旧的 `machineString` 下也合法。把这两处改回 `machineString`，没有任何测试会失败；`boundedString` 与 `machineString` 都是 `Schema<string>`，`tsc` 也发现不了。若第 1 轮确实有真实编号过宽/首字符非字母数字的案例，这个修复等于没有回归保护。
- 建议：仿照 `LONG_ID` 加一个“记忆编号/条目编号以 `_` 开头、长度接近上限”的正向用例，并加一个超长/含控制字符的反向用例。

### 4. 低：`gmail-decisions` 的 `json_each` 修复没有针对性反向用例
- 文件:行：`scripts/operations/prod-read.sh:95-104`，`test/tooling/prod-read.test.mjs:240-288`
- 问题：改动是为了避免把 `message_id` 拼进 JSON path。但用例用的 `message_id` 是 `mail-a_1`（`:269`、`:280`），不含引号/反斜杠，旧的 `json_extract(d.inputs, '$.floorHits."' || p.message_id || '"')` 在它身上同样能通过。把脚本改回旧写法，这个测试不会失败。
- 证据：旧/新差异见 diff；测试输入 `floorHits: { "mail-a_1": [...] }`、`message_id = "mail-a_1"`。
- 建议：用含 `"`（或 `\`）的 `message_id` 造一条记录并断言计数正确，或直接断言生成的 SQL 使用 `json_each(... ) j WHERE j.key = ...`。

### 5. 低：录屏脚本的文案仍说“每一环都能点到原始记录”，与 ADR/演示文档自相矛盾
- 文件:行：`scripts/demo/record-email-decision.mjs:114`；对照 `docs/adr/0197-one-page-for-one-email-decision.md:39`、`docs/execution/specs/2026-11-10-email-decision-page-demo-script.md:40`
- 问题：作者说 r1-ds-6 已把 ADR 和演示脚本改成“规则和评价只显示”。ADR 与 spec 确实改了，但真正录屏用的脚本第 114 行仍写 `每一环都能点到原始记录：这里跳到来源对话`。而代码里规则/评价确实不可点（`apps/control-center/src/components/decision-chain-drawer.tsx` 的规则块只有文本；`mail-decision-page.tsx:140-145` 评价只有文本）。按 spec 第 40 行“面试时不要说成‘每一环都能点’”，这条录屏文案正好相反。
- 证据：`record-email-decision.mjs:114` 原文如上；spec:40 明确“规则和评价这两环这一版只显示，不能点开，面试时不要说成‘每一环都能点’”。
- 建议：改成“记忆能点到来源对话；规则和评价这一版只显示”，并重录存档。

### 6. 低：`GapCaseSnapshot` 的类型与真实落盘内容不一致
- 文件:行：`apps/agent-service/src/production-gap-export.ts:16`、`apps/agent-service/src/production-observation.ts:421`
- 问题：`GapCaseSnapshot extends Omit<GapCase, "messageId">`，但 `const snapshot: GapCaseSnapshot = { ...found, ... }` 中 `found` 是带 `messageId` 的 `GapCase`；对象展开不受多余属性检查，`JSON.stringify` 仍会把 `messageId` 封进快照。若本意是“新封存快照也不带 messageId”，这里没做到；若本意是“旧快照不要求、新快照可以带”，则 `Omit` 只是误导性的类型。功能上目前没有消费者读它（`isGapCaseSnapshot` 不检查该字段），所以我按低严重度记。
- 建议：明确取舍——要保留 messageId 就去掉 `Omit`；要在落盘时剔除，就显式解构 `const { messageId: _ignored, ...rest } = found;`。

## 二、推测（未证实）

- 推测：`readMailTrace` 去掉 `LIMIT` 后，若某个 `paired_message_id` 被灌入大量 Muse 条目，单次查询会把这些行全部载入内存（`sqlite-decision-ledger-operations.ts:528-541`），比较逻辑再对全部条目建 Map（`production-observation.ts:347-353`）。正常每封邮件条目数很少，且是已认证的控制中心只读请求，故我判断风险低；但没有硬上限。建议用 SQL 直接算 `MAX(muse_reminded)` 之类做比较、只查前 20 条做展示，避免把“全量与展示”混在一次查询里。
- 推测：`forMail` 在 `inputs[field]` 为 `null`/标量而非对象时会抛 TypeError（`production-observation.ts:321-322` 只检查字段存在，不检查形状）。现有 `production-decision-chain.ts:99` 也有同样假设，因此不算本改动新引入，但属于同一类“决策 inputs 是自由 JSON”的健壮性隐患。

## 三、侧重检查

- 错误路径：读了 `test/integration/decision-email.test.ts:373-396` 和 `production-observation.ts:354-382`。未知邮件、他人 owner、`text_withheld` 三种路径分别返回 `mail:null`/空条目/不打开封存文本，`readMailTrace` 的 SQL 也按 `owner_id/agent_id` 过滤（`sqlite-decision-ledger-operations.ts:538`），结论：已覆盖，行为正确。
- 不合规范/不可信输入：`decision.email.read` 的 `messageId` 由契约 `gmailMessageId` 校验（`contracts-v2.ts:1089`），SQL 全参数化；gap case 的非 Gmail 形状 `pairedMessageId` 现在落成 `null`（`production-gap-cases.ts:82-84`），但 `id` 仍用原始字符串做哈希，稳定且不含原始串。缺陷见上面第 2 条（规则编号）。
- 安全：跨 owner 读取有测试且 SQL 有过滤；扣留正文不会调用 `seal.open`（`production-observation.ts:340-341`）；`prod-read.sh` 仍 `readOnly` 且不选正文列。结论：未发现新的越权/泄漏。
- 资源耗尽：见“推测”第一条；展示侧固定 `slice(0,20)`，不随条目数增长；比较侧全量扫描。结论：低残余风险。
- 不可撤销操作：本次只新增只读查询与只读 prod 查询；`proactive.gapcase.mark` 仍可 `unmark`，没有新的不可逆写操作。结论：无。
- 规则/文档一致：ADR 0197、spec 与代码在“记忆/推断可点开、规则/评价只显示”上一致；但录屏脚本文案不一致（第 5 条）。`.agents/instructions/test-and-production-hosts.md` 已把 `gmail-decisions` 纳入固定的三个只读查询，与脚本行为一致。

## 四、必答问题

1. **会不会改变模型已见过的请求开头？** 不会。改动集中在 Observation 只读快照、控制中心展示、gateway 契约、只读 SQL 与运维脚本；我确认 `ProductionObservation`/`buildGapCases`/`readMailTrace` 只被 gateway 读模型和测试引用，不在系统提示、工具定义或消息历史组装路径中；新增的 `decision.email.read` 只进入 `installedGatewayV2Operations`（给控制中心的配置，不是模型请求）。因此仍是“只在末尾追加”，且本改动每轮变化的值（邮件决策、Muse 条目、周报数字）只存在于控制中心的只读响应里，不进入模型前部。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会影响模型请求。用于展示/导出的集合处理是确定的：`forMail` 先 `new Set` 再 `.sort()`（`production-observation.ts:322`）；`readMailTrace` 用 `ORDER BY e.muse_at, e.id`（`sqlite-decision-ledger-operations.ts:539`）；`pairEntriesByMail` 的“优先 reminded”规则是固定的（`packages/calibration/src/index.ts:311-323`）。没有发现依赖后文遮盖或无序遍历进入模型输入的情况。

3. **有没有对应的自动检查，反向用例真的会失败？** 部分有。会用失败的：20/21 条的 `truncated` 正反例（`decision-email.test.ts:300-343` 确实能区分 `>=`/`>`）；gap case 非 Gmail 形状 → `messageId: null`（`gap-cases.test.ts:434-454`，改回原始字符串会失败）；跨 owner/扣留/256 长度（`decision-email.test.ts:373-413`）。不会失败的：比较是否真用第 21 条（第 1 条）；契约 `nullable(gmailMessageId)` 的运行时端到端（不过 `production-observation.ts:222` 的 `: GatewayV2Snapshot` 类型标注会让改回非空在 `tsc` 阶段失败）；r1-ds-3 的两处放宽（第 3 条）；`json_each` 的引号场景（第 4 条）；`weekly-report.tsx:1278` 的 `messageId !== null` 分支没有用例（现有负例只测 `onOpenMail` 未安装）。以上均为阅读断言得出，未执行测试。

4. **每个新增/修改的值，产生方与使用方两端都能接受吗？**
   - `gapCases[].messageId`：产生方 `production-gap-cases.ts:82-84`（`string | null`）；消费方 `contracts-v2.ts:849`（`nullable(gmailMessageId)`，接受 null）、`weekly-report.tsx:1278`（显式判空）、`gapCaseId` 不依赖它；`GapCaseSnapshot` 的类型 `Omit` 与运行时展开不一致（第 6 条）。结论：除类型表述外两端可接受。
   - `decision.email` 的 `messageId`：产生方来自已校验的 query payload（`contracts-v2.ts:1089`），消费方同契约与 UI，一致。
   - `memoryIds`/`entryId`：产生方 `#emailTrace` 原样取决策 inputs / 数据库 id；消费方已放宽为 `boundedString`（`contracts-v2.ts:1105`、`:1112`），能接受更宽的字符串，但无测试保护（第 3 条）。
   - `ruleIds`：产生方未清洗任意 inputs，消费方 `boundedString` 拒绝控制字符，和决策链的清洗行为不一致（第 2 条）。
   - `truncated`/`comparison`：产生方布尔/固定枚举，契约与 UI 的 `MUSE_BUCKETS` 都覆盖；`noMuseEntry` 不落在周报五桶里，UI 因此不高亮，符合语义。
   - `decision.email.read` 操作名：已在 `GATEWAY_V2_MESSAGE_TYPES`、`PRODUCTION_OBSERVATION_OPERATIONS`、前端 `proactive.ts` 和测试中出现，按 `scripts/check-operations.mjs` 的匹配规则（后端/调用方/测试三处）能通过，未发现缺项。
