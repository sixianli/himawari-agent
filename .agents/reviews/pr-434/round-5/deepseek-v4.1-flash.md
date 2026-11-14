output format from user: 按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。 Also "在结论之前单独写一节「侧重检查」". Need output complete conclusion in Chinese, no tools. Must include statement max steps reached? The system says response must include statement max steps reached. We can weave it. Need be concise but complete. No tools.

Let's write final answer. Need answer mandatory questions 1-4. Include 侧重检查 section. Include severity list. Since no confirmed issues, say no high/medium/low confirmed code issues. But maybe report low observations? We should not fabricate. Could list "未发现确认问题" under issue list. We can include "未核实" items separately.

Need cite evidence lines read. Let's recall exact lines:

- mcp-read.test.ts lines 152-157 insert columns; line 238 review_after.
- migration 0095 lines 364-365 checks; 579/632 triggers set review_after.
- c44b main had source_memory_id but no review_after (from git show); a6f94 PR had review_after but NULL source memory (from combined diff). We can mention based on git diff/show.
- production-memory-capture.test.ts lines 278-300 setup reviews/ledger/unitOfWork; 334-350 protect agentId; P4-1 at 2342 etc.; iOS at 2647? We saw [iOS] at line 2644? The current file [iOS] starts around 2647? From diff hunk `@@ -2441,6 +2644,131 @@` so [iOS] at 2647. P4-1 at 2342. Good.
- home-feed.test.ts lines 167-170 reviews.
- prompt-prefix.md lines 27-29, 67.
- rule-review-service.ts lines 50-60 ruleReviewPrompt; test lines 233-246.
- rule-types.ts lines 72-88 entries sorted; 90-117 fixed key order.
- rule-review-service.ts lines 99-146 error paths; 190? etc.
- correction-propagation-migration.contract.test.ts lines 275-320, 425-448; data-export-rules.test.ts lines 287+.
- production-proactive.ts lines 342-347 reviewRules before check; 362-371.
- rule-book.ts line 18 ruleIsEnforced; rule-types.ts 301-305 enforceableOwnerRule; gateway contracts lines 1926/1992 etc.
- data-export import lines 701 etc.

Need mention no lost assertions:
- current production-memory-capture has both P4-1 and iOS; main's P3-5 tests present. We read current file and diff c44b..0f4 showing only PR additions; diff a6f94..0f4 showing main additions. We can say "读代码证实".
- mcp-read merged insert has both columns; `git show --cc` showed conflict resolution; both sides' data present.
- home-feed only +1 line; current has reviews.

Need "侧重检查" list: error paths, untrusted input, security, resource exhaustion, irreversible ops, docs consistency. Mention:
- Error paths: RuleReviewService handles model failure, invalid JSON, disclosure denied, unreadable source, stale revision, retries max 3; tests.
- Untrusted input: parseRuleReviewAnswer catches; data export schema/assert; rule IDs validated.
- Security: prompt injection data-only statement; dataClassification from source memory; no secrets in logs; review text clipped 200.
- Resource: output 64KB cap, batch 3, retry 3, chain depth 8/200, list limits.
- Irreversible: migration 0095 destructive but contract tests; rule suspend/adopt/confirm/restore; import; no issue found.
- Docs consistency: ADR 0232 vs code; prompt manifest; no mismatch found; one unverified: manifest hashes and full test counts.

Need answer Q1: Merge/increment does not change model-seen request prefix. The only model-facing addition in PR is background rule review prompt, fixed first, variable JSON last; not appended to conversation. Merge is test-only. Existing system prompt/tool definitions/history unchanged by merge. Every-round values in rule review prompt are last. Cite.

Q2: Same text different bytes? New rule review prompt deterministic: fixed text + JSON.stringify; params normalized/sorted; test asserts byte-for-byte same with reordered/uppercase params. Merge test values fixed. No time-dependent field in prompt. `review_after` not model-facing. Caveat: prompt manifest hash not verified; not about bytes.

Q3: Automatic checks: mcp-read integration test inserts needs_review with review_after and DB CHECK would fail if wrong; migration contract tests; rule-review service unit tests; data-export roundtrip; reverse cases. But note the specific merge resolution itself has no dedicated unit test; it is exercised by integration test. Also full suite not run.

Q4: Values:
- `review_after`: produced by mcp-read test (line 238) and data-export import (line 701) and migration triggers; consumed by DB CHECK (migration 364-365), listDue (190-192), rechecking (346-349), index. All accept needs_review non-null and others null; suspended null accepted. Verified.
- `suspended`: produced by rule review resolve; consumed by gateway schemas, ruleIsEnforced, enforceableOwnerRule, MCP rule_book, export, control-center. Verified main consumers; maybe not every UI path but key ones.
- `reviews`: passed to ProductionOwnerRuleWriter and ProductionMemoryControl; consumers require act/memory reviews; repository provides. Verified.
- `source_memory_id`: merged test sets for non-orphan; main consumers accept; test seeds classification. Verified.
- `suspendReason`: export/import schema and assert; import sets; verified.
- `memory_review` kind/outcomes: decision ledger CHECK, gateway, export schema; verified.
Potential unverified: all auto-merged files outside three not audited; full test suite.

Now issue list: We can say "未发现确认的高/中/低严重度问题". But maybe include a low observation: "mcp-read.test.ts 的 review_after 用 updatedAt（过去时间），使该规则在测试时钟下已到期；当前测试不运行 RuleReviewService，所以不影响断言；若以后在读取路径接入自动重审，这条测试数据会立刻触发重审，建议用与 NOW 一致的受控时间或明确注释。" Is this a real issue? It's a low test robustness issue. It is a "推测" future risk. We can put under "推测/低". The user wants issues. Could list as low severity with evidence line 238 and migration trigger semantics. But it may be seen as noise. However, it's a legitimate observation: review_after = updatedAt means due immediately; the test's intent is just DB constraint, but if any code path runs review, it changes. But not a current defect. We can include as "低（推测，未影响当前断言）". That satisfies "报告你发现的任何问题". Let's include it carefully.

Another low: The author's claim "第4轮之后没有改功能代码" — we saw a3c8bce0 merge of main, and `git log a6f94..a3c8bce0` includes many commits from main; no PR functional commit after a6f94 except docs 7984503b2. We can say claim appears consistent for PR branch, but the increment includes main changes; not a defect. Don't list.

Another low: The merge resolution's `review_after` for needs_review uses `updatedAt` but the migration backfill uses updated_at; consistent. No issue.

Another possible low: `review_after` for needs_review in mcp-read test uses `updatedAt` but the test's `ruleSources` seeding archived memory; if RuleReviewService runs, it would suspend as source_removed because archived, not because of review_after. Not relevant.

Maybe list only the test robustness low. But if we list a low issue, we must give file:line, problem, evidence, suggestion. Do so.

Need state max steps reached. At top or bottom. "本次复核在达到最大工具步数时停止；以下结论基于已读到的代码，未再调用工具。" This satisfies system.

Let's craft in Chinese with sections:

1. 说明（达到步数）
2. 侧重检查
3. 问题清单（按严重度）
   - 高/中：无
   - 低：test/integration/mcp-read.test.ts:238 review_after=updatedAt; evidence lines; current no review service in test; suggestion.
4. 读代码证实的 / 推测（未核实）
5. 必答问题 1-4

Need ensure "证据（引用你亲自读到的那几行代码）" for low issue. Quote line 238 and migration 364-365. For no issues, cite evidence of correctness.

Let's write concise but complete. Avoid overlong. Use file:line references.

Let's produce final.本次复核在达到最大工具步数时停止，以下结论基于已读到的代码，之后未再调用工具。

## 侧重检查

- **错误路径**：`RuleReviewService` 对模型失败、非 JSON、参数不合法、披露被拒、来源记忆读不出、修订号过期都有分支（`packages/application/src/services/rule-review-service.ts:99-146`），失败走 `recordFailure`，最多 3 次、间隔 1 小时（`packages/application/src/ports/rule-review.ts:4-6`）。未发现会吞掉成功结果或无限重试的路径。
- **不可信输入**：模型输出经 `parseRuleReviewAnswer` 的 `JSON.parse` 并有异常捕获；导出导入的 `suspendReason`、`status` 受 schema 和 `assertRuleHistory` 约束（`packages/persistence-sqlite/src/data-export/rules.ts:300-302`）。未发现新增注入点。
- **安全**：规则重检提示明确把 `memory`/`currentRule` 当数据而非指令（`packages/prompt-catalog/src/background.ts` 的 `RULE_REVIEW`），模型调用按来源记忆的 `dataClassification` 走 `model.prepare`。未发现新的越权读取。
- **资源耗尽**：模型输出上限 64KB、每批 3 条、重试 3 次、依据链 8 层/200 条（`rule-review-service.ts:19-20`、`rule-review.ts:5-6`、ADR 0232 前提/决定）。未发现无界循环。
- **不可撤销操作**：迁移 0095 重建多张表，但契约测试覆盖迁移前后数据；规则暂停可由 Owner adopt/confirm/restore。未发现新增不可恢复路径。
- **规则/文档/代码一致性**：ADR 0232 与 `ruleIsEnforced`、`suspended` 状态、`review_after` 触发器和导出说明基本一致；**prompt manifest 的 SHA256 未核实**，**全套测试失败数/失败文件清单未核实**（未运行测试）。

## 问题清单（按严重度）

### 高 / 中
未发现确认的高、中严重度问题。

### 低（测试健壮性，推测风险，不影响当前断言）
- **文件:行**：`test/integration/mcp-read.test.ts:238`
- **问题**：合并后的插入把待重审规则的 `review_after` 设为 `updatedAt`。当前测试时钟下这是过去时间，规则一插入就是“已到期”。当前 `mcp-read` 测试没有运行 `RuleReviewService`，所以断言不受影响；但若以后读取路径接入自动重审，这条测试数据会立刻触发重审，可能改变 `rule_book` 输出。
- **证据**：
  ```ts
  status === "needs_review" ? updatedAt : null,
  ```
  ```sql
  CHECK (review_after IS NULL OR status IN ('needs_review', 'suspended')),
  CHECK (status <> 'needs_review' OR review_after IS NOT NULL)
  ```
  （`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:364-365`）
- **建议**：保留当前写法也可以；若担心未来自动重审接入，可在测试里把 `review_after` 设为明确受控的将来时间，或注释说明“这里只验证迁移约束，不启动重审”。

## 读代码证实的

- **mcp-read 合并正确**：合并后同时写 `source_memory_id` 和 `review_after`，占位符与参数数量一致；待重审规则 `review_after = updatedAt`，其他为 `NULL`（`test/integration/mcp-read.test.ts:152-157`、`230-239`）。这同时满足迁移 0095 的两条 CHECK（`0095_correction_propagation.sql:364-365`），且与迁移回填逻辑 `CASE WHEN status = 'needs_review' THEN updated_at END` 一致。
- **主分支一侧未被覆盖**：对比 `c44b83961..0f4de9b62` 的三个文件，`mcp-read.test.ts` 只增加 `review_after` 相关行；`production-memory-capture.test.ts` 只增加 PR 一侧的导入、`reviews`、`ledger` 和 `[P4-1]` 用例；`home-feed.test.ts` 只增加 `reviews: repository.ruleReviews()`。主分支原有的 `[iOS]` 用例、`protect` 的 `agentId`、P3-5 用例都仍在。
- **PR 一侧未被覆盖**：当前 `production-memory-capture.test.ts` 同时存在 `[P4-1]`（约 `2342` 行）和 `[iOS]`（约 `2647` 行）；`ProductionOwnerRuleWriter` 和 `ProductionMemoryControl` 都拿到 `reviews`，控制层还保留 `unitOfWork`、`ledger`（`278-300` 行）；`protect` 同时支持 `agentId` 参数（`334-350` 行）。
- **home-feed 合并正确**：`ProductionOwnerRuleWriter` 已补 `reviews: repository.ruleReviews()`（`test/integration/home-feed.test.ts:167-170`），满足该 writer 的必填项（`apps/agent-service/src/production-owner-rules.ts:265`）。
- **提示词顺序**：规则重检提示固定说明在前，`memory`/`currentRule` 的 JSON 最后（`packages/application/src/services/rule-review-service.ts:50-60`）；单测明确断言“固定在前、变化数据最后、参数顺序/大小写不同也逐字节相同”（`packages/application/test/rule-review-service.unit.test.ts:233-246`）。
- **确定性**：`parseOwnerRuleParameters` 会把列表去重并排序（`packages/application/src/rules/rule-types.ts:72-88`），参数对象字段顺序固定（同文件 `90-117`）。
- **自动检查**：迁移契约测试覆盖 `review_after` 的到期/清空/再次排队（`packages/persistence-sqlite/test/correction-propagation-migration.contract.test.ts:275-320`、`324-341`、`425-448`）；数据导出往返覆盖 suspended/suspendReason 与未导出项（`test/integration/data-export-rules.test.ts:287` 起）；规则重检单测覆盖失败、非法答案、披露拒绝、来源不可读（`rule-review-service.unit.test.ts:200-231`）。若把 `needs_review` 的 `review_after` 写成 `NULL`，或给非 `needs_review` 写非空值，mcp-read 的插入会直接被迁移 CHECK 拒绝，反向用例确实会失败。

## 推测 / 未核实

- **未核实**：作者说“全套测试 14539 条里 130 条失败，全部在 17 个只能在测试主机或 CI 机器上跑的文件里”，本次没有运行测试，无法独立确认。
- **未核实**：`packages/prompt-catalog/prompt-manifest.json` 中 `rule.review` / `rule.review.instructions-header` 的 SHA256 是否与当前文本一致。
- **未核实**：除上述三个测试文件外，最终合并提交里所有自动合并的生产文件未逐行复核；本次只核对了这三个文件及相关消费端。
- **推测**：上述低严重度问题只是未来接入自动重审时的测试稳定性风险，不是当前代码缺陷。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本增量里三个文件都是测试；合并没有改系统提示、工具定义、历史消息或遮盖逻辑。PR 新增的规则重检是独立后台调用：固定说明在前，`memory`/`currentRule` 的 JSON 在最后一条（`rule-review-service.ts:50-60`），符合 `.claude/rules/prompt-prefix.md:27-29` 和后台调用第 67 行“固定的在前、会变的在后”。发给模型的内容仍然只在末尾追加，每轮会变的值放在最后的数据块里。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**不会（就本增量和规则重检提示而言）。** 规则重检提示的变量部分由固定键顺序的 `JSON.stringify` 生成，参数列表会排序（`rule-types.ts:72-117`）；单测断言参数顺序/大小写变化时提示逐字节相同（`rule-review-service.unit.test.ts:233-246`）。`review_after` 是数据库字段，不进入模型内容。合并测试里的时间值是固定字符串，不依赖当前时间。未发现无序集合或带时间字段进入模型提示。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
**有。**
- `review_after` 的正确性由迁移 CHECK 和 mcp-read 集成测试共同保证；错误写法（`needs_review` 为 NULL，或非待重审为非 NULL）会被数据库直接拒绝。
- 规则重检有服务单测、迁移契约测试、数据导出往返测试；失败路径、非法模型输出、来源不可读、修订号过期都有用例。
- 但“这次合并解决”本身没有单独的合并测试，依赖上述集成测试整体跑通；全套测试结果**未核实**。

### 4. 每个产生或修改的值，使用它的地方都能接受吗？
- **`review_after`**：产生于 mcp-read 测试插入（`mcp-read.test.ts:238`）、数据导出导入（`packages/persistence-sqlite/src/data-export/import.ts:701` 一带）和迁移触发器（`0095:579`、`0095:632`）。使用方是迁移 CHECK（`0095:364-365`）、`RuleReviewStorePort.listDue`（`sqlite-correction-review-operations.ts:190-192`）、`rechecking` 计算（同文件 `346-349`）和索引。两端一致：`needs_review` 非空，`active`/`retired`/`suspended` 可为空。
- **`source_memory_id`**：合并后 mcp-read 测试为除 orphan 外的规则写入来源记忆，并为这些来源种子了记忆分类；`ownerRulesWithin` 需要来源分类已知才显示（`production-mcp-read.ts:1252-1273`），测试已补种子，能通过。
- **`reviews`**：`ProductionOwnerRuleWriter` 需要 `act`（`production-owner-rules.ts:265`），`ProductionMemoryControl` 需要 memories/rules 两个 review store（`production-memory-control.ts:237-240`）；三处测试传的都是 `repository.ruleReviews()` / `repository.memoryReviews()`，类型和运行时实现匹配。
- **`suspended`**：`ruleIsEnforced` 只认 active/needs_review（`rule-book.ts:18`），`enforceableOwnerRule` 随之排除 suspended（`rule-types.ts:301-305`）；网关 `memory.rules.snapshot` 和 `decisionChain` 已允许 suspended（`gateway-contracts/src/contracts-v2.ts:1583`、`1926`）；数据导出 `RULE_STATUSES` 已允许 suspended 并校验 suspendReason（`data-export/schemas.ts:313-333`）；控制中心规则卡也处理 suspended（`apps/control-center/src/components/rule-receipt.tsx:193-205`）。未发现拒绝 suspended 的关键消费方。
- **`memory_review` 决策类型/结果**：迁移 CHECK、网关契约、数据导出 schema 都已加入；`agreement` 计算按这些结果计数（`sqlite-correction-review-operations.ts:601-623`），与 P4-1 测试期望一致。
