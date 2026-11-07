## 侧重检查

本次改动只是加了一个检查脚本及其测试，不触碰任何运行时代码。我沿最普通的流程走了一遍：开发者改代码 → `npm run check`（package.json:27 里确认有 `check:egress-redaction`，:44 对应 `node scripts/check-egress-redaction.mjs`）→ CLI 入口（scripts/check-egress-redaction.mjs:365-371）跑 `findEgressViolations` + `findSensitiveGateViolations` → 报错退出。

用 grep 逐文件核对了全部 50 处 gate 调用（packages 30 + apps 20）与 `SENSITIVE_GATE_CALLS` 的 27 个登记项：计数、函数名、文件路径逐项一致，合计恰好 50，无漏登、无多登；也没有发现 `as` 别名导入导致漏计。三个外部出口正则在 packages/apps 的 `/src/` 范围内只命中三个已登记文件，未核实范围内仅测试和 scripts 目录（不被扫描）。

未覆盖的代码路径：CLI 的失败分支（console.error 循环 + `exit(1)`，:367-370）没有测试执行；外部出口「近邻字符串不误伤」（如 `https://mcp.exa.ai` 不带 `/mcp`、`typesafe-systemone`）的仓库级自动通过测试不存在——「外部出口」相关测试全用临时 fixture（test/tooling/egress-redaction-check.test.mjs:132-159），不对真实 repo 跑 `findEgressViolations()`。

## 发现的问题（读代码证实的）

**低 · scripts/check-egress-redaction.mjs:298-304 ·「`findEgressViolations` 行为不变」的说法不准确**
证据：diff 显示 `EXTERNAL_EGRESS_PATTERNS` 检查是被加进 `findEgressViolations` 函数体内(:298)，不是并列的新函数；该函数现在会对新一类违规报警，属行为变更。准确说法是「原有四类检测逻辑不变、原有 9 条测试的期望不受影响」。
建议：作者更正措辞即可，代码无需改。

**低 · scripts/check-egress-redaction.mjs:68-70 · 外部出口正则偏宽，且缺「近邻不误伤」的反向测试**
证据：`/v1/tools/(?:search|fetch)` 无边界（假设别的文件写注释 `GET /v1/tools/search-api` 也会命中）；`/\/v1\/systemone` 与 `typesafe-systemone` 的区分靠字面巧合。目前 grep 核实 packages/apps `/src/` 内无不合法命中（web-providers.ts:21-22 的 `https://mcp.exa.ai` 和 `mcp.exa.ai:443` 确实不命中 Exa 正则，作者说法 3 成立），但这只有我人工核实，没有自动化用例钉住。
建议：加一条 fixture 用例：文件里只写 `https://mcp.exa.ai` 和 `typesafe-systemone` 时 `findEgressViolations` 返回空。

**低 · scripts/check-egress-redaction.mjs:113-118, 190-254 · `decision`/`reason` 无任何代码消费，结论写错不会失败**
证据：`findSensitiveGateViolations` 只用 `entry.file` 和 `entry.calls`(:344, :351)，`decision`（KEEP/MASK/PASS）和 `reason` 纯文档。某项标成 MASK 但后续 PR 忘了改、或理由与代码行为矛盾，检查都通过。
建议：属 PR1 定位内可接受；后续落地时保证有对应行为检查，或加注释说明这两个字段靠人复核。

**低 · scripts/check-egress-redaction.mjs:25, 67 · 四个 gate 函数名单硬编码，将来新增整段拦下函数不会被发现**
证据：`SENSITIVE_GATE_FUNCTIONS`(:113 附近) 与 `SENSITIVE_SIGNATURES` 均为手写冻结数组；若后续 PR 新造第五个拦下函数，检查不覆盖。
建议：无需现在改，但后续扩建时这里必须同步，建议在规则文档里写明。

以上均为读代码证实的；推测部分：作者称「真实源文件临时加一处调用会失败、恢复后通过」的手工验证无法在此环境重演，但对应的 fixture 反向用例（test/tooling/egress-redaction-check.test.mjs:170-220）真实走完整函数路径且断言了失败文案，反向用例确实会失败，可信。

## 必答问题逐条回答

1. **不会改变模型见过的请求开头。** 本次 diff 只改 `scripts/check-egress-redaction.mjs` 和 `test/tooling/…`，是构建期检查，不进入任何发给模型的内容；系统提示、工具定义、历史消息、遮盖结果一概未动。逐轮变化的值（调用计数）不存在于消息里。
2. **不会。** 无任何运行时序列化、时间戳、集合顺序的改动；唯一排序相关的是 `sameCounts` 用 `Set` 遍历，只影响报错文案顺序，不影响字节稳定性，且根本不发给模型。
3. **有对应自动检查，反向用例会失败。** `findSensitiveGateViolations` 三类违规（新增未登记、计数不符、登记失效）+ 外部出口两类（登记内放行、未登记报错）各有 fixture 用例并断言具体报错文案，测试走真实函数路径。缺口：外部出口的「近邻不误伤」没有反向用例（见上文低级别第 2 条）。
4. **每个新产生的值核对过，两端均可接受。** ① `SENSITIVE_GATE_CALLS`：27 项文件/路径/计数与代码一一对应（我逐项 grep 核对），仅被本检查消费；② `EXTERNAL_EGRESS_PATTERNS`/`ALLOWED_EXTERNAL_EGRESS_FILES`：三个登记文件的相对路径与 `sourceFiles` 生成的相对路径一致（均在 `packages|apps` 且含 `/src/`），仅被 `findEgressViolations` 消费；③ `KEEP/MASK/PASS` 仅被 `SENSITIVE_GATE_CALLS` 引用，无下游校验（见第 3 条问题）；④ `check:egress-redaction` 命令名字面上容易被理解为「出口遮盖检查」，现在额外含敏感闸门检查，属可接受的命名兼守。没有发现任何一端校验失配。
