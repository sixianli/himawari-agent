我来确认一下我即将引用的具体行号。
# 复核报告：PR 314（周报 Muse 差距线与案例清单，d04cc0c8）

## 侧重检查（我走的流程）

普通使用流程：主人打开周报页 → `useProactive` 发 `proactive.weekly.read`（apps/control-center/src/proactive.ts:154）→ production-approval-gateway.ts:108 路由到 `ProductionObservation.query()` → `readGapCandidates` + `buildGapCases`（逐案例 `seal.open`）+ `marks.list` → 快照经 `gatewayV2MessageSchema.parse`（production-observation.ts:297）→ 网页渲染差距线和案例（weekly-report.tsx:1087-1182）→ 点「加入 Backlog」→ 命令 `proactive.gapcase.mark` → approval gateway → `#markGapCase`（production-observation.ts:314-331）重算当周案例、加密快照、写 `gap_case_marks` → 刷新后显示已标记 → 每周开发会话 `GET /api/gap-cases/v1/export`（Cloudflare Access 外层 + `BearerGate`）→ `export()` 解封、预填、`mask` 后返回。

结论：这条主链的计算逻辑和标记/导出闭环有测试覆盖（gap-lines 单测、gap-cases 集成测试、weekly-report 单测）。**没有测试覆盖的路径**：① `registerGapExportRoute` 在真实 composition 里的接线（production-http-composition.ts:1143，集成测试只在裸 Fastify 上注册）；② `service-main.ts:1688-1710` 的 gapExport 装配和 `GAP_EXPORT_RUNTIME_UNAVAILABLE` 分支；③ `ProductionObservation.query()` 用真实数据产出 gap/gapCases 并过 schema 校验的全链路（单测用的是手写 fixture）；④ `GAP_MARKS_UNAVAILABLE`（production-observation.ts:316）；⑤ 导出路由的 429 限流路径（共享的 `BearerGate` 由 muse-intake-http.test.ts:353 覆盖）；⑥ `export()` 里 `JSON.parse` 失败路径。作者自己说的「真实网页验收未做」与此吻合。

## 问题（按严重度从高到低）

**1）中 · apps/agent-service/src/production-gap-cases.ts:30-32 —— 按 Unicode 码点截断，与合约按 UTF-16 长度校验不一致，可让整份周报打不开。**
证据：`clean()` 用 `[...text...].slice(0, limit).join("")`（码点数）截到 500/300；而合约校验 `boundedString` 用 `input.length > maximum`（UTF-16 单元，packages/gateway-contracts/src/validation.ts:78-94）。若 Muse 文字里超过一半是非 BMP 字符（如 emoji），截断后 UTF-16 长度可到 1000 > 500，`gatewayV2MessageSchema.parse(snapshot)`（production-observation.ts:297）抛错，整个 `proactive.weekly.read` 失败——不是该案例显示不了，而是整份周报（含原有各节）都出不来，且对该周是确定性复现。这正是 I-73 式「生产端产生的值没对过后端校验」：集成测试只用 ASCII 标题，反向用例缺失。建议：截断按 UTF-16 单元（或对齐合约按码点校验），并补一条 emoji 夹具的用例。
（读代码证实；触发概率取决于 Muse 文字内容，属边界情形。）

**2）中 · packages/calibration/src/index.ts:426 —— 配对差区间的连续性修正是单向的。**
证据：`const corrected = e > n / 2 ? e - n / 2 : e >= 0 ? 0 : e;`——e 为正且大于 n/2 时减 n/2，0 ≤ e ≤ n/2 记 0，但 **e < 0 时原样保留**，负向没有对称的 `e + n/2`（或记 0）处理。若实现目标是 ADR 0187 写的 Newcombe 1998 方法 10，其连续性修正应对正负对称；现在 e 为负时 φ 偏向负相关，会不对称地拉伸/压缩区间两端。（「与 Newcombe 方法 10 的偏离」这一判断属于我的推测，需作者对照原文确认；代码本身的非对称是读代码证实的。）且测试没有 e 为负、|e| > n/2 的用例（gap-lines.unit.test.ts 的两个区间用例 e 分别为 100 和 0）。建议：补对称分支和负向用例，或注明采用的公式出处。

**3）低 · packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:498-516（readGapCandidates）—— 同一封邮件可产生多个案例编号，与差距线分母不一致。**
证据：`readGapCandidates` 按条目返回（JOIN `muse_reference_entries`，不对 `paired_message_id` 去重），同一邮件两条 Muse 提醒会生成两个不同 `caseId`（`gapCaseId` 含 entryId，production-gap-cases.ts:34-36），可分别标记；而差距线按 `pairEntriesByMail`（index.ts:311-323）每邮件只取一条，两边口径不同，且重复案例会占用 50 条上限（production-gap-cases.ts:53）。建议：要么去重，要么在文档写明这是有意的。

**4）低 · apps/agent-service/src/production-gap-export.ts（export 方法，约 ：122）—— `JSON.parse(text) as GapCaseSnapshot` 无防护。**
证据：`const snapshot = JSON.parse(text) as GapCaseSnapshot;`——某个 `snapshotRef` 对应的载荷损坏或旧版本字段变化时，整个导出请求 500，而不是跳过该条。unmark 流程（production-observation.ts:318-319）没有同类问题。建议：try/catch 跳过并计数。

**5）信息 · 作者说法「只写 Himawari 自己的数据」与代码不一致。**
证据：案例清单展示 Muse 的标题和文字（production-gap-cases.ts:63-66 `museTitle`/`museText`），ADR 0187 第 3 条也写「每条带 Muse 的标题和文字」。若作者本意是「归因只依据 Himawari 自己的数据」，则与代码一致（`attributeGap` 只读 `decision_ledger.inputs`，index.ts:523-539）。措辞需要澄清，避免读者误解案例内容来源。

**6）信息 · 新界面词不在词表里，词表检查管不到它们。**
证据：`scripts/check-glossary.mjs` 只拦「旧叫法」出现（:101-136），新词「差距线」「归因」「加入 Backlog」等没有 `docs/glossary.md` 条目，三语言一致性只靠人工。三种语言文案本身齐全（en.ts/ja.ts/zh-CN.ts 各 24 条）。建议：给新词补词表行。

**7）建议 · 标记命令不做最近登录校验。**
证据：`proactive.observation.start` 走 `assertRecentAuthentication`（production-approval-gateway.ts:212-217），而 `proactive.gapcase.mark` 直接放行（:219-220）。写库 + 加密载荷风险低，可接受，但 ADR 0187 未写这个取舍。

**正面（读代码证实）**：`BearerGate` 抽取是行为保持的重构（限流参数、恒时比较、错误码名都保留了）；`gap_case_marks` 的 CHECK（`GLOB 'gap_*' AND length = 24`）与 `gapCaseId` 产出精确匹配；unmark 先删行再释放载荷、重复标记释放多余载荷的路径都处理了；导出遮盖有带真实密码的反向用例（gap-cases.test.ts「masks passwords…」）。

## 作者说法核对

- 迁移 0082、ADR 0187、导出路径、`gap-export` 独立用途、401 空体、样本不足不写「追平/落后」、归因四标签、点一次标记再点取消、约 40 个文件——**均与代码一致**。
- 「测试通过、tsc -b、glossary、egress-redaction 通过」——**未核实**（我无法运行测试），只核对了这些测试和检查在代码里存在且含反向用例。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本 PR 不组装任何发给模型的内容：周报快照只发给网页（gateway → control-center），Markdown 只写文件（scripts/calibration-report），导出只给外部开发会话。没有改系统提示、工具定义、历史消息或遮盖规则（`check-egress-redaction.mjs` 只是把新文件登记进 `REDACTOR_ONLY_FILES`，是收紧不是放宽）。ADR 第 8 条的说法与代码相符。
2. **不会让同一段文字在不同请求里变成不同字节（就模型请求而言，因为根本不进模型请求）。** 新增的序列化本身是确定的：案例顺序来自 `ORDER BY e.muse_at, e.id`，导出顺序 `ORDER BY marked_at, case_id`，案例编号是确定性哈希；`generatedAt`/`markedAt` 是响应字段不是模型输入；遮盖走 `redactForEgress`（确定性）。无序集合（`markedIds` 的 Set）只用于布尔标记，不直接序列化顺序。
3. **有对应的自动检查，多数反向用例会真失败。** gap-lines 单测含「样本不足/区间跨 0」反例；集成测试含无头/错令牌/错方案 401、标记不存在案例被拒、密码必须被遮；UI 单测含标记失败保持原状；配置校验含「指向 Muse 令牌/不存在的引用被拒」。**但缺口在问题 1 条目**：码点截断 vs UTF-16 校验这个反向用例（emoji 长文）不存在；429、`GAP_MARKS_UNAVAILABLE`、真实 composition 接线也未覆盖。
4. **逐值核对（产生端 → 使用端）：**
   - `proactive.gapcase.mark`：合约（GATEWAY_V2_MESSAGE_TYPES、schemasByType、fixture）→ UI 发送（risk low）→ gateway 路由 → observation 执行，两端校验一致 ✓；
   - `gap_*` 编号：`gapCaseId`（24 字符）↔ DB CHECK ↔ `machineString` ↔ UI key ✓；
   - `gap-export` 用途：`strict-configuration.ts:978` 定义、`service-main.ts` 消费、正反配置用例齐全 ✓；
   - `himawari-gap-cases.v1`：仓库内只产不校验，消费方（定时开发会话）在仓库外，未核实；
   - `gapCaseMarks()` 端口：composition stub、repository、durable adapters 三端齐 ✓；
   - **不合格的一处**：案例的 `museTitle`/`museText`/`himawariReason`——产生端按码点截断、使用端（快照 schema）按 UTF-16 校验，即问题 1。
