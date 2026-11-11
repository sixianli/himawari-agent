# PR 382 第 1 轮判断

- r1-1、r1-2（中，成立，两个模型都提）：决策记录写入约定第 35、45 行还写着“其他种类只落四个键”“summary 六项只由 proactive 写”，约定自己要求改 `insertLedgerRow` 后同步改约定。已改：写明 `external_read` 可带六项、别的种类拒绝、抽屉不显示这六项。
- r1-3（低，成立）：ADR 0216 决定 7 说摘要只接在 Gmail 检查上，范围测试也没盯 `.recent({`。ADR 0216 决定 7 末尾补一句指向 ADR 0219 决定 7（不改原决定，聊天路径仍不读）；范围测试改名，新增 `.recent({` 只出现在三个文件的断言，以后有人把摘要接进聊天路径会失败。
- r1-4（低，成立）：`insertLedgerRow` 本身不按种类拒绝，记忆整理直接调用它、不经 `validateLedgerWrite`。`insertLedgerRow` 开头加拒绝；新单元用例 `packages/persistence-sqlite/test/decision-ledger-summary-inputs.unit.test.ts` 用真实 SQLite 断言 consolidation 带六项时抛错、表里不多一行；删掉这条拒绝后用例失败（已实测）。
- r1-5（可以更好，采纳）：`sqlite-proactive-operations.ts` 和 `sqlite-decision-ledger-operations.ts` 互相引用。`summaryInputsValid` 挪到单独的 `sqlite-decision-summary-inputs.ts`，两边都从那里引。
- r1-6（低，成立）：摘要读取失败（工具照常成功）也写 `mcp-read.failed` 日志。新增 `onSummariesFailed`，生产写 `mcp-read.summaries-failed`；集成用例断言摘要失败只进这个回调、`onFailure` 不被调用。
- r1-7（不成立）：提示词目录哈希未核实。`check:prompt-catalog` 在 `npm run check` 里通过，哈希不对会报 `PROMPT_MANIFEST_STALE`。
- r1-8（可以更好，不采纳）：摘要读取没有中止信号。提醒读取本来也没有；两者都是读本机 SQLite 的几行，最多 8 段，没有网络调用。列给 Andy。
- r1-9（低，成立，两个模型都提）：没接摘要源时不返回 `recentDays`，工具说明没写。ADR 0219 决定 7 写明这种情况不返回该字段（工具说明是给外部模型的固定文字，不为部署形态加分支）。
- r1-10（低，成立，GLM 提，DeepSeek 在侧重检查里也提）：提醒先读失败时摘要还没读，决策记录却写 `summaryRead: "failed"`。改为记下摘要是否读过：没读过记 `off`，读过但这次没交出记 `failed`。新集成用例（提醒读取失败）断言 `off`，旧写法会写 `failed`。ADR 0219 决定 7 同步。
- r1-11（低，成立）：`partial` 分支没有用例。新集成用例让今天那段摘要正文读不到，断言只返回昨天、`recentDaysComplete: false`、决策记录 `summaryRead: "partial"`。
- r1-12（低，成立，两个模型都提）：约定第 5 条要求读取端测试能列出新字段。`decision-chain.test.ts` 新增 external_read 用例：记录的输入字段含六项、依据链的邮件区为空、规则区为“不涉及”。
- r1-13（不成立）：`SUMMARY_READS` 对 external_read 也接受 `off`。现在 external_read 确实会写 `off`（见 r1-10），这是需要的取值。
