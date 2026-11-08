## 复核结论（按严重度排列）

### 读代码证实的

**1.【低｜文档】新加的 ADR 链接指向不存在的目录**
- 位置：`docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md:110`
- 问题：`6be2e1eb` 给 V02-OUT-14 加的链接是 `[ADR 0183](../adr/0183-....md)`，从 `docs/execution/specs/` 出发解析成 `docs/execution/adr/`，该目录不存在（`docs/execution` 下只有 `plans/`、`specs/`；`docs/adr/0183-...` 才存在）。
- 证据：
  - 该行：`...（[ADR 0183](../adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)）`
  - 读取 `docs/execution` 目录：只有 `plans/`、`specs/`。
  - 同一提交另一处（`2026-09-10-control-center-local-acceptance-design.md:128`）用的是正确的 `../../adr/...`。
- 自动检查没接住：`scripts/check-instruction-links.mjs:7-12` 只扫描 `AGENTS.md`、`CLAUDE.md`、`.claude/rules`、`.agents/instructions`，不扫描 `docs/execution/specs`。所以提交说明里“check:instruction-links 通过”属实，但不能证明这个链接有效。
- 建议：改成 `../../adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md`；若要防回归，把 docs 跨文件链接检查纳入某个 check。

**2.【低｜文档】“网页导入记忆仍会整行丢弃”说过头了**
- 位置：`docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:73`
- 问题：只有粘贴/Codex 文本路径会整行丢弃；JSON 导出导入路径不丢弃。
- 证据：
  - `apps/control-center/src/memory-import.ts:86-89`：`if (mentionsSensitiveMaterial(line)) { dropped += 1; return; }`（在 `parseMemoryText` 内）
  - `apps/control-center/src/memory-import.ts:150-181`：`parseMemoryExport` 返回 `{ items, dropped: 0 }`，没有敏感检测。
  - `apps/control-center/src/components/memory-page.tsx:1966-1971`：`source === "codex" ? parseMemoryText(...) : parseMemoryExport(...)`，两条路径都算“网页导入”。
- 建议：把话说窄，例如“粘贴文本和 Codex Markdown 导入路径（`parseMemoryText`）仍会整行丢弃；JSON 导出导入（`parseMemoryExport`）不丢”。

**3.【低｜作者说法】“6be2e1eb 只改 3 份文档”不准确**
- `git show 6be2e1eb --name-only` 显示 8 个文件：3 份文档 + 5 个 `.agents/reviews/pr-308/round-2/*` 复核留档。留档本身正常，但“只改 3 份文档”与提交内容不符。

**4.【低｜文档，需确认口径】S0 的“Memory 保存主人的原文”对机器密钥不成立**
- 位置：`docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md:110`
- 问题：同一 PR 的 ADR 0183 第 69 行明说 `[密钥]` 无法还原；代码里机器密钥占位符是固定 `[密钥]`，不进入还原表。
- 证据：
  - `packages/sensitive-capture/src/redaction.ts:66`：`const MACHINE_SECRET_PLACEHOLDER = "[密钥]";`
  - `packages/sensitive-capture/src/restoration.ts:51-53`：只有带 `#` 的占位符才会被还原。
- 说明：主人的原始消息仍作为加密来源 payload 保存，所以“存了原文”在来源层成立；但记忆正文/标题里机器密钥会留 `[密钥]`。若这里“Memory”指记忆正文，则 S0 这句写宽了。
- 建议：明确写成“来源原文保存；密码/验证码可还原，机器密钥正文保留 `[密钥]`”。

### 推测（未完全核实）
- S0 同文件的 `V02-RULE-05` 摘要仍写“secret exclusion”（第 125 行）、第 202 行仍写“S1 负责全局排除”。这两处可能只是指“外部/能力边界排除”，不一定与 ADR 0183 冲突；本次提交只改了 V02-OUT-14，未一并澄清。未核实是否属于有意保留。
- `test/fixtures/v0.2/coverage-manifest.json` 的 `prd.sha256` 是否与最终 `docs/prd-v0.2.md` 一致，我无法在只读工具下重算，未核实（作者称 `check:v0.2-coverage` 通过）。

## 侧重检查

- **错误路径/不可信输入**：搜索查询在 `apps/agent-service/src/production-coding-workflow.ts:119-120`、`packages/platform-node/src/exa-public-search.ts:216`、`deepseek-web-provider.ts:71` 先 `redactForExternalText` 再发；没有发现仍会“整段拦下凭据”的路径，验收设计第 128 行的新说法与代码一致。`memory-import.ts` 的 `mentionsSensitiveMaterial` 仍会丢弃文本导入的敏感行（见上）。
- **安全**：删除 `reportMemoryAudit` 只影响拦截记录，不影响出口遮盖；历史拦截记录的 `part` 枚举仍保留 `memory_source`/`memory_candidate`（`packages/application/src/ports/sensitive-interceptions.ts:23-24`、`packages/gateway-contracts/src/contracts-v2.ts:693-694`）和界面文案，历史行可继续显示。
- **资源耗尽/不可撤销操作**：本 PR 未新增循环、重试、删除或破坏性操作；只删了两处审计写入。
- **规则/文档与代码一致性**：发现上面的断链和导入范围写宽；另确认没有冲突标记（`apps` 下无 `<<<<<<<`/`=======`/`>>>>>>>`）。
- **合并完整性**：`git diff 0f468696..0998093f` 中确认 `service-main.ts` 删掉了两处 `productionSensitiveInterceptionRecorder(...).reportMemoryAudit(...)`；三语文案两条 `chat.search.*` 均为 PR 版本；`i18n-runtime.unit.test.ts` 新增测试仍在。合并结果未被 main 冲掉。

## 必答问题

1. **发往模型的内容是否仍只在末尾追加、每轮变化的值是否都在最后一条消息？**
   是。本 PR 的改动文件只有：`service-main.ts`（删除审计调用）、control-center i18n 文案与测试、application 的审计类型/记录器、文档与测试。没有改 `packages/prompt-catalog`、`model-egress`、历史组装或压缩逻辑；i18n 是控制中心界面文案，不进入模型请求。代码 diff 中 `automatic-memory-service.ts` 只改类型联合，没有改变运行时行为（存储侧不拦的实际行为在基准 `0f468696` 已如此）。本 PR 没有新增每轮变化的值，也没有移动或重写历史。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。i18n 文案是固定字符串；删除的 `sha256([generationId, candidateOrdinal, part, ruleId])` 指纹属于审计记录，不在模型内容里。没有引入时间字段、无序集合或依赖后文的遮盖。

3. **有没有对应自动检查，反向用例是否真的会失败？**
   部分有：
   - 搜索文案：新增 `[mask-not-block]` 测试（`i18n-runtime.unit.test.ts`），正则禁止 `拦|blocked|遮断|止められ`。旧文案分别含“仍会拦截 / remain blocked / 遮断します / 止められます”，因此旧文案会失败，反向用例有效。
   - 审计结果码删除：没有新增“不能产生被删结果码”的反向测试；主要靠 TypeScript 联合类型约束，相关旧测试被删除或改写。
   - 文档修改：**没有**自动检查覆盖 `docs/execution/specs` 的跨文件链接，断链不会被发现。

4. **每个被改动的值，所有使用方都能接受吗？**
   - `MemoryExtractionAuditRecord["outcome"]` 删两个值：全仓 grep 未发现代码仍产生或比较这两个值；历史账本 `reasonCode` 是 `string`（`packages/application/src/ports/decision-ledger.ts:100,117`），历史行可读。
   - `AutomaticMemoryResult.status` 删 `"source_secret_excluded"`：调用方在 `production-memory-capture.ts:897` 及测试里，未发现按该值分支的消费方。
   - 拦截记录的 `memory_source`/`memory_candidate` 值和三语标签仍保留，历史行照常显示。
   - i18n message id 未变，三条资源都写入了新文案。
   - 合并结果中 PR 的三项改动都在，没有被 main 覆盖。
   - 唯一“使用方不能接受”的是文档内部引用：V02-OUT-14 的链接目标不存在（见问题 1）。

**作者说法核对结论**：第 1 条“本 PR 不改任何发往模型的字节”成立；“6be2e1eb 只改 3 份文档”不成立（还有 5 个复核留档）；两份规格的搜索/Memory 旧说法改得基本准确，但 S0 新加的 ADR 链接是断的，ADR 里“网页导入整行丢弃”也写宽了。
