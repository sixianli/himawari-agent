# 复核报告：#308 去掉整段拦下 PR5（收尾清理和文档）

## 读代码证实的发现（按严重度从高到低）

### 1.【中】搜索“仍会拦截”的旧文案漏改了一处，与实际行为和新文案自相矛盾
- 文件：行
  - `apps/control-center/src/i18n/resources/en.ts:176`
  - `apps/control-center/src/i18n/resources/ja.ts:179`
  - `apps/control-center/src/i18n/resources/zh-CN.ts:169`
- 问题：本 PR 的第 3 件事是把“像密码的搜索词会被拦下”改成“先遮盖再发出”，但只改了 `chat.search.sentLimits`；同一界面的另一条文案 `chat.search.disclosure`（搜索授权说明）三语都还写着“拦截”。中文版原话：“检测到凭据的查询仍会拦截。”英文版："Detected credentials remain blocked."日文版：“認証情報は引き続き検出・遮断します。”
- 证据：搜索提供方实际行为是遮盖后发送——`packages/platform-node/src/deepseek-web-provider.ts:71` `const query = redactForExternalText(input.query.trim()).text;` 随后 line 76-78 直接 POST 该 query；`packages/platform-node/src/exa-public-search.ts:216` 同样。没有任何“拦下”路径。新改的 `sentLimits`（en.ts:929-930）与这条旧文案在同一语言文件里互相矛盾。
- 建议：三语 `chat.search.disclosure` 一并改成与 `sentLimits` 一致的“先遮盖再发出”，或至少把“拦截”改为“遮盖”。

### 2.【低】ADR 0183 决定第 1 条关于 `SENSITIVE_GATE_CALLS` 的表述会误导
- 文件：行：`docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:46`
- 问题：原文“`npm run check:egress-redaction` 的 `SENSITIVE_GATE_CALLS` 登记同步删除”。实际上登记机制没有删除：`scripts/check-egress-redaction.mjs:114-139` 的 `SENSITIVE_GATE_CALLS` 数组仍在，含 4 条 KEEP/MASK 登记（model-egress、trusted-model-provider、strict-configuration、pi-output-export）；删除的只是存储侧的登记项，且那发生在 PR3/PR4（`git log -- scripts/check-egress-redaction.mjs` 显示 ce21ff75/38133377），不是本 PR。紧接着的半句“新增整段拦下调用的未登记文件会让检查失败”（脚本 line 285 的报错逻辑成立）恰恰依赖这份登记存在——按字面读“登记删除”则前后矛盾。
- 建议：改写为“存储侧的登记项已随 PR3/PR4 删除，检查机制保留；新增整段拦下调用的未登记文件仍会让检查失败”。

### 3.【低·观察】ADR 0143 第 12 条补注后，同条内“含机密或受限的不存正文”未加说明
- 文件：行：`docs/adr/0143-decision-ledger-for-model-gate-decisions.md:53`
- 问题：行尾补注只说了“不再有‘含机密’这一种丢弃原因”，但同条正文中段仍有“含机密或受限的不存正文”。现在含机密的候选根本不会被丢弃，读者可能误以为该分支仍生效。测试侧已对应只查 restricted（`test/integration/automatic-memory-golden.test.ts:519-520`）。
- 建议：补注里加半句说明该分支只剩“受限”。属文档完善，不算错误。

### 4.【低·观察，部分未核实】ADR 0167 原文“记忆、提醒和 Muse 在存储时用它”疑似过时
- 文件：行：`docs/adr/0167-sensitive-capture-package.md:55`
- 证据：全仓库 `containsRestrictedIdentifier` 现在只在 `packages/sensitive-capture/src/identifiers.ts:4,13`（被 `classificationWithIdentifiers` 内部调用）出现；使用方为记忆捕获（production-memory-capture.ts:329）、提醒写入（production-reminder-writer.ts:205）、控制中心添加记忆/提醒（apps/control-center/src/memory.ts:160,167）。`production-muse-intake.ts`、`production-muse-intake-control.ts` 里 grep 不到任何分类调用。这句是原有文字，本 PR 只在其后加了允许范围内的补注，未核实 Muse 是否曾走别的路径。
- 建议：下次触碰该文件时顺手核实并修正。

## 侧重检查（一条普通使用流程 + 覆盖结论）

流程：主人对助手说“记住我家的 Wi-Fi 密码是 abc12345”→
1. `production-memory-capture.ts:819` 组提示（owner 消息经 JSON.stringify 嵌入，line 178-191）→ 模型生成 → `placeholderTable`+`restorePlaceholders` 还原占位符（line 833-850）——有测试（trusted-prompt-egress、production-memory-capture.test.ts）。
2. `automatic-memory-service.ts` 提交候选：restricted 仍丢（line 133-136），敏感进审批（line 326-338），密码原文入库——本 PR 的正向测试 `memory-credential-storage.unit.test.ts:72-85` 覆盖（committedMemoryIds=4、stored 含密码原文），REVERSE 测试（restricted 仍丢）保留。
3. 审计走 `onAudit` → `service-main.ts:1943-1951`、`2032-2040`，现在只剩诊断日志；账本行由 service 自己写（reasonCode 来自 outcome，line 549），golden 测试用 ledger/audit 对账（automatic-memory-golden.test.ts:485-493）兜底。
4. 拦截记录页读历史 `memory_*` 行：迁移 `0078_sensitive_interceptions.sql:13` 的 CHECK、契约 `contracts-v2.ts:682-695` 枚举、i18n `sensitive.part.memory_*` 三语（en.ts:1311-1312 等）、e2e fixture（control-center-browser-server.mjs:598）都在，历史行可照常读出和显示。

无测试覆盖的路径：`service-main.ts` 两处 onAudit 接线（删掉 recorder 调用后只剩诊断，无测试断言拦截记录器不再收到 memory 观察）；所有 i18n 文案与实际行为的一致性没有自动检查——发现 1 的漏改正是从这里漏掉的。ADR 与代码的一致性同样只能靠人工复核。

## 必答问题逐条回答

1. **会不会改变模型已经见过的请求开头？** 不会。diff 里没有任何 prompt、工具定义、历史消息、遮盖逻辑的改动；`service-main.ts` 删的两处调用在 `onAudit` 审计回调里（审计记录只进诊断日志和账本，不进请求）；其余改动是 i18n 界面文案、文档、类型收窄和测试。发给模型的内容仍只在末尾追加、每轮可变值在最后一条消息（本 PR 未触碰该机制；记忆提示见 production-memory-capture.ts:168-193，还原对照表按“刚才实际发出的提示”重建）。作者说法成立。
2. **同一段文字会不会在不同请求里变成不同字节？** 本 PR 不改 `redactForEgress`/`redactForExternalText`/`restoration` 任何逻辑，也未引入时间戳、无序集合或依赖前后文的遮盖；新 ADR 是纯文档。无此风险（PR3/PR4 已有机制的细节本次未逐一复核，标部分未核实）。
3. **有没有对应的自动检查、反向用例会不会失败？** 有且会失败：若重新引入“秘密整段丢弃”，`memory-credential-storage.unit.test.ts` 正向断言（stored 含密码、4 条提交）失败；golden 测试的丢弃对账（automatic-memory-golden.test.ts:485-493，账本 discarded 数必须等于五个剩余 outcome 的审计数）失败；TS 类型层面已删联合成员无法直接复用；`check:egress-redaction` 会对未登记的整段拦下调用报错（check-egress-redaction.mjs:285），且有工具反例测试（test/tooling/egress-redaction-check.test.mjs）。
4. **每个值两端核对。** 全部核实通过，仅一处措辞问题：删除的两个结果码在代码中零残留（grep 只剩 ADR 历史叙述和指向 0183 的补注）；账本 `reason_code` 是自由文本 CHECK（0069_decision_ledger.sql:19，仅限长度 1-64），`outcome` 的枚举（line 48-55）与 reason code 无关，历史行照常可读；`AutomaticMemoryResult.status` 收窄后使用方（automatic-memory-service.ts:118-125、production-memory-capture.ts:853、golden 测试）都只判 `completed`/`extraction_failed`；`reportMemoryAudit`/`MEMORY_EXCLUSIONS`/`memoryCategory` 无残留引用，recorder 其余方法仍被 service-main 四处使用（line 299,352,1555,1813）；`memory_source`/`memory_candidate` 类别在迁移、契约、i18n、e2e fixture 四端都保留；i18n key `chat.search.sentLimits` 只改值未改 key，三语同步。例外即发现 1（`chat.search.disclosure` 漏改）和发现 2（ADR 0183 对 `SENSITIVE_GATE_CALLS` 的描述与现状不符）。

**推测（未逐条核实代码）**：ADR 0183 决定第 1 条列举的各写入点“存原文”（提醒、Muse 收件、沙箱诊断、检查点、反思、执行动态、流式输出落库）属 PR3/PR4 范围，本次只核实了记忆和标题两处；决定第 3 条的“对照表排除 Himawari 固定文字”已由 `TRUSTED_PROMPT_TEXTS` 传入证实（production-memory-capture.ts:833-836）。
