# 复核报告：PR 393（规则手册进入数据导出）

## 复核范围说明（重要）

`git diff 3ede75ba..6856c8c0` 显式包含约 1500 行与规则手册无关的“删除”（memory checkup 整套、迁移 0090、`memorySourceState` 下沉、`clean()` 改写等）。核对提交历史：`git log 3ede75ba..6856c8c0` 只有 2 个提交（`230459ed` feat、`6856c8c0` docs），且 `git show --stat 230459ed`（27 个文件）**不含**那些文件；`git show 3ede75ba:...memory-checkup.ts` 存在、HEAD 不存在，但两个提交都没删它。结论：给定的基准 3ede75b 含有本分支没有的其他主线工作（P4-6 体检、迁移 0090），两点 diff 的“删除”部分是基准差异，**不是本 PR 所为**。本 PR 实际只改：数据导出的规则部分、网页 UI/i18n、响应头、测试、文档。以下复核只针对这两个提交。

## 发现（按严重度从高到低）

**1.【中低】packages/persistence-sqlite/src/data-export/schemas.ts（ruleVersionFields）— parameters 长度上限 16384 与数据库约束不一致，可能出现“能导出、导不进”的自产包**
- 证据：schema 里 `parameters: text(2, 16_384)`；而 `migrations/0086_rule_book.sql:6`、`0087_rule_book_memory_link.sql:270` 对 `parameters` 只有 `json_valid` 校验、**无长度上限**；`export.ts` 的 `buildPortableExport` 不做 `validateAgainst`（schema 校验只发生在导入前的 `parsePortable`）。
- 后果：若库里存了超 16KB 的参数（应用写路径目前都很短，风险低但存在），导出成功，但这个 zip 连自己的 `verify` 都过不了，规则带不走且导出端不报警。
- 建议：导出端对规则行跑一次 schema 校验，或放宽 schema 上限与 DB 对齐。

**2.【低】export.ts（ruleLines 构造处）— 源库历史不变量被破坏时，整个导出（包括所有记忆）失败，且无测试覆盖这条路径**
- 证据：`export.ts` 对每条规则调 `assertRuleHistory`，失败抛 `REFERENCE_BROKEN`；`apps/agent-service/src/production-data-export.ts:145-149` 把任何错误折成 `DATA_EXPORT_FAILED` 返回。`data-export-rules.test.ts` 的篡改用例全部针对**导入端**，没有“源库规则历史与当前行不一致 → 导出失败”的用例。
- 后果：一条脏规则让主人连记忆都导不出。fail-loud 本身合理，但至少应有测试锁定该行为，或评估降级（跳过该规则并在 omitted 计数）。
- 建议：补导出端反向用例，或出 ADR 决定降级策略。

**3.【低】verify.ts（withheld 分支）— 扣留版本跳过 `storedRuleProblem`，导入端补校验无直接测试**
- 证据：verify.ts 新增循环里 `if (version.withheld === true) continue;`；补校验在 import.ts 的 `restoreVersion`（恢复原文后跑 `storedRuleProblem`，失败抛 `SEAL_MISMATCH`）。
- 后果：逻辑是闭合的（无原文→整条跳过，fail-closed；有原文→补校验），但“封存原文不合法 → SEAL_MISMATCH”没有专门测试。且 `sealed.enc` 是 AES-256-GCM + AAD（seal.ts:56-58,105-107），篡改封存文件在解密层即失败——要触达 `restoreVersion` 的校验需持口令者篡改，属低危。
- 建议：补一条 restore 失败的用例即可。

**4.【低/信息】import.ts:64-74 — `EMPTY_TARGET_TABLES` 不含 `rule_book_history`**
- 证据：列表只加了 `rule_book_rules`。
- 后果：目前不变量成立（0086/0087 的写路径和触发器保证历史行必有对应当前行，历史行有 `no_delete` 触发器），且若真出现“有历史无当前行”，导入会撞主键回滚、不会静默成功——失败模式安全。仅信息级。

**5.【文档/说明不一致】作者说明写“决定写在 docs/adr/0232-...”，实际文件是 `docs/adr/0233-rule-book-joins-the-data-export.md`**
- 证据：`6856c8c0` 提交信息自述“0232 已分给 P4-1”。说明文字未同步，代码与文档一致（0233）。

**6.【已证实与代码一致的说法**（逐条核对过）：parameters 原样导出（export.ts `ruleParameters` 无机密时直接 `str(raw)`）；`sqlite-proactive-operations.ts:354` 确为原字符串比较、366-374 先写当前行再复制进历史；verify 和 export 都用 `assertRuleHistory`；扣留路径（明文层 `JSON.stringify(maskLeaves(parsed))`、原文进 `originals`、无口令整条跳过）；来源记忆链接置空 + omitted 计数；内置规则只列在 RULES.md、`storedRuleProblem` 拒绝 `floor_public_domain`（有反向用例）；目标库 `rule_book_rules` 为空 + v1 拒绝（有反向用例）；按钮三语改名；响应头值 = `enforcedRules`（非 retired）。

## 侧重检查

**走查的普通流程（网页导出）**：记忆页按钮 `memory-page.tsx` ExportPanel → `apps/control-center/src/data-export.ts` `requestDataExport`（读三个响应头）→ `production-data-export.ts` `registerDataExportRoute`（鉴权、sec-fetch-site、单飞 429、只读库）→ `buildPortableExport`（snapshot 读 rules/rule_history → ruleLines → rules.jsonl + RULES.md → zip）→ 响应头 + 下载 + 完成文案。
- 有覆盖：http 集成测试（正常含规则数/RULES.md、无规则反向、未登录反向）；UI 单测（stub fetch、断言新文案和按钮名）；导入端覆盖充分（逐字节往返、5 个篡改反向、非空目标、无口令跳过）。
- **无测试覆盖的路径**：发现 2 的导出端不变量失败；`MAXIMUM_ARCHIVE_BYTES` 的 `DATA_EXPORT_TOO_LARGE`；429 并发路径（既有缺口）；RULES.md 渲染遇到未知 kind 的 owner 规则（有 `KIND_LABELS.unknown` 兜底但无用例）。
- **未核实**：`data-cli.test.ts` 是否直接覆盖规则的加密导出（CLI 走同一 `buildPortableExport`，间接覆盖）；测试未实际运行（本复核无执行权限）。

## 必答问题

1. **不改。** PR 两个提交只含导出包、网页 UI、i18n、测试、文档；grep 证实 `RULES.md`/`rules.jsonl` 只在 data-export 和 i18n 文案中出现，无任何 prompt/工具/历史代码引用。发给模型的内容完全未触碰，“只追加”规则不适用也无违反。
2. **不会。** 导出物不是模型请求；包内排序固定（SQL `ORDER BY rule_id` / `revision`）、parameters 为原样字符串、遮盖无状态（`redactForExternalText` 每次调用新建 tagger，结果只依赖该字符串本身，external.ts:60-84）。重复导出同一库状态，除既有字段 `manifest.exportedAt` 外字节稳定。
3. **有自动检查，结构上反向用例会失败，但我未执行。** `check:data-export` 加入了新测试文件且下限 53→68；新增 15 = rules 13 + http 反向 1 + v1 用例 1，数目吻合。反向用例均为 `rejects.toMatchObject({ code })` 加“库中写入数为 0”双断言，结构正确；运行结论标注为未亲自验证。
4. **每个新值两端都核对过，均接受**：manifest 三个新计数字段（schema required / export 写 / verify 重算比对 / import 填 / 头与 UI 消费）；`x-himawari-export-rules`（produced `production-data-export.ts:139`，consumed `data-export.ts` + 单测 stub + 集成测试）；封存键 `rule/<id>[/history/<rev>]/parameters`（两端同一 `ruleParametersKey` 函数，import.ts:102 有数量对账）；`rulesWithoutOriginal`（类型 + 填充 + 测试；CLI 把整个 report 展开进输出，无遗漏）；`rules.jsonl`/`RULES.md`/`RULE_SCHEMA` 在 export/verify/import 三端闭环。未发现接受不了的使用处。

**读代码证实的**：以上所有引用行；**推测的**：发现 1 的实际触发条件（取决于是否存在超长参数的真实数据）、测试在 CI 中实际通过。
