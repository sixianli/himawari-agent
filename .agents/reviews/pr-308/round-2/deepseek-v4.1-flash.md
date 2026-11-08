## 侧重检查

- **搜索外部出口**：`packages/platform-node/src/exa-public-search.ts:216` 先 `redactForExternalText` 再发；`deepseek-web-provider.ts:71` 同样；遮盖后仍为空或超长会报 `WEB_SEARCH_INPUT_INVALID`，不会带着原文外发。搜索 URL 也走遮盖。
- **模型出口**：`packages/application/src/services/model-egress.ts:219-244` 先遮、再 `assertMachineSecretFree`，遮完仍检出就拒绝发送；占位符 tag 用 HMAC(key, kind+value)，同一密钥下是确定的。
- **推送正文 / 锁屏泄露**：`production-web-push.ts:486-498` 只在 `dataClassification` 为 `sensitive`/`restricted` 时隐藏正文；`identifiers.ts:8-16` 只会因 18 位证件号或 16–19 位数字把 private/public 提到 sensitive，密码、密钥不会。ADR 0183 新增的这条已知缺口与代码一致。
- **不可信导入输入**：`apps/control-center/src/memory-import.ts:86-89` 仍会把命中 `mentionsSensitiveMaterial` 的整行丢弃；`check:egress-redaction` 的 `SENSITIVE_GATE_FUNCTIONS`（`scripts/check-egress-redaction.mjs:103-108`）不包含这个函数。
- **迁移 / 不可撤销操作**：`sqlite-authority-transfer.ts:1082-1103` 的导出清单包含所有未删除的 Payload 和被引用的 memory 文件，因此“记忆随迁移包带走”在代码上成立；包是加密的，host secrets 仍排除。本次没有新增迁移、删除或不可撤销动作。
- **资源耗尽 / 错误路径**：本 PR 只改文档、UI 文案、一个控制中心单测和覆盖清单，没有新增网络、循环、存储或并发路径；新测试只遍历 3 个 locale × 2 个 id。

## 发现（按严重度）

### 1.【高】同一验收设计里还留着“凭据检测继续阻止发送”

- 文件：`docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md:128`
- 问题：第 47 行已改成“机器秘密先遮盖再发出”，但第 128 行仍写“凭据检测继续阻止发送”。这与代码和本次改动直接矛盾。
- 证据（我实际读到的行）：
  - 第 128 行：`查询词可包含对话提供的信息，发送给固定 Exa 服务；这项授权不增加文件、命令或附件权限，凭据检测继续阻止发送。`
  - `packages/platform-node/src/exa-public-search.ts:216`：`const query = redactForExternalText(input.query.trim()).text;`
  - `packages/platform-node/src/deepseek-web-provider.ts:71`：`const query = redactForExternalText(input.query.trim()).text;`
- 建议：把第 128 行改成“检测到的凭据先遮盖再发送”，或明确引用 ADR 0183；同一文档内不能同时存在“阻止发送”和“遮盖后发送”。

### 2.【高】S0 覆盖表 V02-OUT-14 仍写“machine secret 不进入 Memory”

- 文件：`docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md:110`
- 问题：PRD 现在明确“长期记忆和内部存储保存主人的原文”，但覆盖表仍把 V02-OUT-14 总结成“machine secret 不进入模型/Memory/readable Trace”。本次只更新了同一文件的 PRD SHA-256，没有重新审计受影响的条款总结。
- 证据：
  - 第 110 行：`| V02-OUT-14 | 本版本不包含 14 | S1 | S4、S5、S6、S7 | machine secret 不进入模型/Memory/readable Trace |`
  - `docs/prd-v0.2.md:152-153`：`记忆提取和记忆后端是内部存储，保存主人的原文，不再整段排除`、`主人在对话里写下的机器秘密，作为私人正文保存在记忆里（含随迁移包带走）`
  - 同文件第 42 行自己写着：`PRD 内容或 digest 再次改变时，本表必须重新审计，不能沿用“已覆盖”结论。`
  - `scripts/check-v0.2-coverage.mjs:226-238` 只比对实际 SHA-256 和列表条款数，不校验第 110 行这种语义总结，所以错误的旧总结仍会通过自动检查。
- 建议：把 V02-OUT-14 总结改成“原文不进入模型可见上下文/可读 Trace；内部 Memory 保存原文”之类，并重新核对 S1/S4/S5/S6/S7 的归属和验收映射。

### 3.【中】“含随迁移包带走”与多份仍在生效的规格/计划互相矛盾

- 文件：
  - `docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md:132,460,764,793`
  - `docs/execution/plans/2026-08-26-v0.2-spec-suite-integration-plan.md:162`
  - `docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md:382,545`
- 问题：PRD 第 153 行说主人在对话里写下的机器秘密会作为私人正文保存在记忆里并随迁移包带走；ADR 0183 也这么决定。但基础设计仍要求“任何提取、嵌入或模型调用前排除”，计划里还把“machine secret 原值不进入 Memory/迁移包”标成已完成。代码实际上会把 Memory 的加密 Payload 和 memory 文件放进迁移包，因此 PRD 这半句与代码一致，但和这些旧文档不一致。
- 证据：
  - `sqlite-authority-transfer.ts:1082-1093` 把每个 `payloadRows(database)` 的密文文件加入 `sourceFiles`；`1097-1103` 把 `data/memory/*` 加入清单。
  - `2026-08-26-portable-durable-web-agent-design.md:132`：`检测到密码...必须在任何提取、嵌入或模型调用前排除`
  - 同文件第 460 行流水线：`→ machine-secret exclusion`
  - 同文件第 764 行：`任何 machine secret 进入 Memory 或 provider input 都是 release blocker。`
  - 同文件第 793 行：`验证 decrypted archive 不含 machine secrets`
  - `2026-08-26-v0.2-spec-suite-integration-plan.md:162`（已勾选）：`验证 machine secret 原值不进入模型、Memory…或迁移包。`
  - `2026-08-26-portable-durable-web-agent-plan.md:382`（已勾选）：`committed Run 后先执行 machine-secret exclusion 和 classification，再运行增量 extraction`
- 建议：ADR 0183 的“后续”清单需要把这些仍在使用的规格/计划纳入，逐条注明“已被 ADR 0183 部分取代”；已经与实现不符的 `[x]` 项要改成实际状态或补说明。

### 4.【中】记忆导入仍整行丢弃敏感内容，和“内部存储保存原文”不一致

- 文件：`apps/control-center/src/memory-import.ts:86-89`
- 问题：导入记忆文件时，只要行内命中 `mentionsSensitiveMaterial`（密码、token、secret、api key、身份证、卡号等），整行直接丢弃并 `dropped += 1`。这不是“重新判分类”，而是旧的整段拦下行为；PRD 和 ADR 0183 说内部存储保存原文，至少没有说明导入是例外。
- 证据：
  - `memory-import.ts:86-89`：`if (mentionsSensitiveMaterial(line)) { dropped += 1; return; }`
  - `packages/sensitive-capture/src/identifiers.ts:18-23` 的 `SENSITIVE_MENTION` 包含 `密码|口令|password...|token|secret|api key|身份证|银行卡|卡号`
  - ADR 0183 第 46 行说“新增整段拦下调用的未登记文件仍会让检查失败”，但 `scripts/check-egress-redaction.mjs:103-108` 的 `SENSITIVE_GATE_FUNCTIONS` 不包含 `mentionsSensitiveMaterial`，所以这条导入路径不会被该检查发现。
- 建议：明确导入路径的产品决定。如果要“保存原文”，改为写入原文并至少标为 sensitive；如果导入确实是例外，就写进 ADR 的已知缺口，并把 `mentionsSensitiveMaterial` 纳入检查或单独登记。

### 5.【低】新测试只做了否定词黑名单，反向用例会失败但没有正向断言

- 文件：`apps/control-center/test/i18n-runtime.unit.test.ts:93-100`
- 问题：测试只断言文案不含 `拦|blocked|遮断|止められ`。撤回三语旧文案时确实会失败（我对照了旧字符串：中文“仍会拦截”、英文“remain blocked”、日文“遮断します”），但未来若改成“removed”“stripped”等词，测试仍会通过，却没有验证“遮盖后发送”这个新语义。
- 证据：新测试第 97 行 `expect(messages[id], ...).not.toMatch(/拦|blocked|遮断|止められ/u);`；旧英文、旧日文、旧中文都能被这四个词命中。
- 建议：增加正向断言（例如包含 `redact|mask|遮盖|マスキング`），或对两条 UI 文案做精确快照；如果保留黑名单，至少加 `/iu` 并覆盖更多“拒绝发送”的近义表达。

### 6.【低】ADR 的“只有卡号、证件号会”说得过绝对

- 文件：`docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:70`
- 问题：“密码、密钥不会把分类提到 sensitive（只有卡号、证件号会）”对 `classificationWithIdentifiers` 本身成立，但完整分类路径还会接受模型自报的 `sensitive`/`restricted` 和来源分类下限。因此“含它们的提醒在推送通知正文里会原样显示”只对未自报敏感、来源也是 private 的提醒成立。
- 证据：
  - `packages/sensitive-capture/src/identifiers.ts:8-16`：只在 `containsRestrictedIdentifier` 命中时提升。
  - `apps/agent-service/src/production-memory-capture.ts:329-341`：`value["classification"] === "sensitive" || ... "restricted" ? value["classification"] : "private"`，再与 `input.sourceClassification` 取较高值。
  - `apps/agent-service/src/production-reminder-writer.ts:205`：提醒写入时只调用 `classificationWithIdentifiers(text, "private")`。
- 建议：改成“自动检测只会在卡号/证件号时把 private/public 提到 sensitive；模型自报或来源分类仍可提高，推送是否显示取决于最终 `dataClassification`”。

## 读代码证实的

- 搜索确实是先遮盖再发送：`exa-public-search.ts:216`、`deepseek-web-provider.ts:71`。
- 推送正文只在 `sensitive`/`restricted` 时隐藏：`production-web-push.ts:486-498`。
- 密码/密钥不会由 `classificationWithIdentifiers` 提升分类：`identifiers.ts:8-16`。
- 迁移包会包含 Memory 相关的 Payload 密文和 memory 文件：`sqlite-authority-transfer.ts:1082-1103`。
- 记忆候选正常路径已不再整段排除，且会还原占位符：`production-memory-capture.ts:328-341` 及 `test/integration/production-memory-capture.test.ts` 的 `[mask-not-block]` 用例。
- 导入路径仍整行丢弃敏感内容：`memory-import.ts:86-89`。
- 新测试的反向用例会失败：旧三语分别含“拦截”“blocked”“遮断”，均匹配正则。
- `SENSITIVE_GATE_CALLS` 当前没有存储侧登记项，只剩模型、配置、导出等登记：`scripts/check-egress-redaction.mjs:114-139`。

## 推测或未核实

- **PRD 新 SHA-256 的具体值未独立核实**：工具限制不能运行 `sha256sum`，也读不到可复算的旁证。能确认的是 `test/fixtures/v0.2/coverage-manifest.json:6` 和 S0 规格第 42 行都改成了同一个值；`check:v0.2-coverage` 会实际计算并比对（`scripts/check-v0.2-coverage.mjs:226-238`），如果值错，该检查会失败。
- **“等外部方”的覆盖范围未完全核实**：`check-egress-redaction` 只登记了模型、Exa、DeepSeek、TypeSafe 这几类外部出口（`scripts/check-egress-redaction.mjs:70-100`）。如果 PRD 第 71 行的“等外部方”意图覆盖 GitHub 推送、Calendar 等未来/其他出口，我没有找到同等的出口遮盖证据；目前只能确认模型和搜索路径。
- **模型是否实际把密码自报为 sensitive**：取决于提示词和模型行为，未在本次运行中验证。因此 ADR 那条缺口的实际触发频率只能说是“可能”，不是必然。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本 PR 的运行时改动只有控制中心 UI 文案、一个控制中心单测和文档/覆盖清单；`packages/prompt-catalog`、系统提示、工具定义、历史消息和 `model-egress` 都没有改。发给模型的内容仍然只在末尾追加；每轮会变的值本来就在最后一条消息里。依据 `prompt-prefix.md:27-36`（固定在前、会变的在后、已发内容只追加、历史存实际发出的那条）。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   本 PR 没有新增这种路径。新增的字符串是 UI 文案，不进入模型请求。既有搜索遮盖用 `redactForExternalText`，单次调用内从固定序号开始，相同输入得到相同占位符；模型出口的占位符 tag 用 HMAC 密钥对 `kind+value` 计算（`model-egress.ts:120-125`），同一密钥下也是确定的。没有引入时间、随机数或无序集合到模型内容里。注意这是针对“本 PR”的结论；此前 PR 让记忆保存原文后，后续检索把原文送模型时仍依赖既有确定性遮盖规则。

3. **有没有对应自动检查？反向用例真的会失败吗？**
   - 有：新增 `i18n-runtime.unit.test.ts` 用例。反向用例会失败：撤回三语文案后分别命中“拦截/blocked/遮断”。
   - 有：`check:v0.2-coverage` 会实际计算 PRD 的 SHA-256 和 Markdown 列表条款数（`scripts/check-v0.2-coverage.mjs:226-238`）。
   - 没有：PRD/ADR 的语义一致性没有自动检查。S0 第 110 行的 V02-OUT-14 旧总结、验收设计第 128 行的旧“阻止发送”都不会让现有检查失败；覆盖检查只验 digest 和 clause count。导入路径的整行丢弃也没有被 `check:egress-redaction` 覆盖。
   - SHA-256 的具体值我无法独立复算，标为未核实。

4. **每个新产生/修改的值，使用它的地方都能接受吗？**
   - 新 SHA-256 `c503dcd1...` 只出现在 `test/fixtures/v0.2/coverage-manifest.json:6` 和 S0 规格第 42 行，两处一致；使用方是 `check-v0.2-coverage.mjs` 和人工覆盖审计，格式可接受。
   - `chat.search.disclosure` 和 `chat.search.sentLimits` 都在 `message-ids.ts` 中存在，分别被 `run-approval-card.tsx:211` 和 `search-authorization-control.tsx:116` 当字符串使用，测试也按 `MessageCatalog` 读取，类型和格式都能接受。
   - 新测试 ID 是测试内部字符串，无外部消费方。
   - 没有新增配置键、数据库字段或序列化格式。
   - 唯一“两端对不上”的是 V02-OUT-14 的语义总结：产生它的 PRD 条款已允许 Memory 保存原文，但使用它的 S0 覆盖表仍按旧说法审计，见上面第 2 条。
