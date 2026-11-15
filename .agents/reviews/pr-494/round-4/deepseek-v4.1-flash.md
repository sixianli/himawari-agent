本轮查过的范围：`b0b6f9b..6d849b1` 的增量（`scripts/ci/aggregate.mjs`、`test/tooling/aggregate.test.mjs`、`docs/incidents-and-gates.md`、二进制记账文件 `usage.jsonl`），以及改动的生产端和使用端：`required.mjs`、`export-evidence.mjs`、`run.mjs`、`publish.mjs`、`browser.mjs`、`run-share.mjs`、`qualify-control-center-browser.mjs`、`test-execution-chain-browser.mjs`，还有 `evidence.test.mjs`、`gate-lifecycle.test.mjs`、`check-incident-gates.mjs`、`check-agent-rulebook-inventory.mjs` 和 `prompt-prefix.md`。未发现高、中严重度问题；以下三条是低严重度或测试完整性建议。

### 1. 低 —— 嵌套跳过规则理论上会静默忽略放在另一检查目录下的真实 `result.json`

文件：`scripts/ci/aggregate.mjs:250-258`

问题：`holdsResult` 会沿目录树向下传播；只要某目录直接含有 `result.json`，它下面所有子目录里的 `result.json` 都不再被读。如果真有一个检查的结果被放到另一个已有 `result.json` 的检查目录之下，它会被跳过，汇总随后只会报“Missing required matrix member report”而失败。这是失败方向（不会误通过），但诊断会误导，且是新增的“忽略”语义。

证据（读代码证实）：
```js
const holdsResult =
  insideResult || entries.some((entry) => entry.isFile() && entry.name === "result.json");
...
if (entry.isDirectory()) walk(filename, holdsResult);
else if (entry.name === "result.json" && !insideResult) {
```

当前 CI 布局不会触发：`run-share.mjs:121` 用 `${job}-${member}` 作为成员目录名，`run-share.mjs:137` 把每个成员放到 `to` 下的独立目录；`publish.mjs:122-123` 又把检查自己的 `result.json` 写在每个成员目录根部。因此实际结构始终是 `<job>-<member>/result.json`，浏览器证据只是它下面的子目录。

建议：更稳妥的判定是只在 `result.json` 能通过 `CheckResult` 校验、且 `checkId/matrixKey` 对应期望成员时才当作 envelope；或只扫描明确的成员目录，而不是用“父目录已有 `result.json`”来决定是否读取。

### 2. 低（推测） —— 用 `Dirent.isFile()` 判定 `result.json`，在文件系统返回 `DT_UNKNOWN` 时可能失效

文件：`scripts/ci/aggregate.mjs:252-253`

问题：`entries.some((entry) => entry.isFile() && entry.name === "result.json")` 依赖 `readdirSync(..., { withFileTypes: true })` 给出的文件类型。如果底层文件系统对某个目录项返回 `DT_UNKNOWN`，Node 的 `Dirent.isFile()` 会是 false，即使它是普通文件。于是 `holdsResult` 漏判，子目录里的浏览器 `execution-chain/result.json` 又会被当成检查结果读入，I-102 在这类文件系统上复发。

证据（推测，未在真实环境复现）：当前 CI 工作区一般是本地 ext4/overlay，`DT_UNKNOWN` 少见，所以实际风险低；但代码确实把“是否是文件”的判定交给了 `Dirent`。

建议：改用 `entry.name === "result.json" && !entry.isDirectory()`（符号链接在下一行已经统一拒绝），或对候选文件显式 `lstatSync`。

### 3. 低 —— 新增用例没有把嵌套文件声明为浏览器证据，无法防止“证据哈希被一并丢掉”的回归

文件：`test/tooling/aggregate.test.mjs:470-506`

问题：用例只把 `browser/reports/execution-chain/result.json` 放成“孤儿文件”，没有把它写进浏览器 envelope 的 `result.reports`。因此它证明的是“嵌套文件不再被当成一份检查结果”，但没有证明“该文件仍作为浏览器证据被哈希核验”。真实生产里 `browser.mjs:115` 的 `browserReportFiles(reportDirectory)` 会把这个嵌套文件列入浏览器结果。

证据（读代码证实）：用例在 `aggregate.test.mjs:496-499` 只写入 `{ cases: [], scope: "fixture" }`；浏览器 envelope 的 `reports` 来自 `positive()` 的 `report.json`/`report.artifact`，并不包含该嵌套文件。

建议：在该用例里把 `browser/reports/execution-chain/result.json` 也加进浏览器 `result.reports`，并断言 `readReportEnvelopes` 为浏览器 envelope 计算出的 `artifacts` 含该路径且摘要正确；这样能同时锁住“不当 envelope”和“仍是证据”两个性质。

**作者说法核对（读代码证实的）**
- 原实现递归读取所有 `result.json`：证实，diff 中被删代码是 `if (entry.isDirectory()) walk(filename); else if (entry.name === "result.json")`。
- 浏览器把场景结果放进报告目录：证实，`qualify-control-center-browser.mjs:344-346` 传入 `.../reports/execution-chain`，`test-execution-chain-browser.mjs:851` 写入 `result.json`，`browser.mjs:86` 的报告目录是 `destination/reports`。
- 新规则“目录里已有 `result.json`，其下不再读”：证实，见上面第 250-258 行。
- 符号链接检查仍覆盖整棵目录：证实，`walk` 对每个目录都会递归，且先执行 `entry.isSymbolicLink()` 抛错（`aggregate.mjs:256-257`），不受 `insideResult` 影响。
- `export-evidence.mjs` 用同一函数后行为仍正确：证实其消费逻辑（`export-evidence.mjs:120`、`134-142`）只依赖合法成员 envelope 的 `source`；当前收集布局下合法成员的 `source` 仍是 `<job>-<member>/result.json`，安全报告的 `dirname` 定位也不变。嵌套文件不再成为 envelope 正是修复目的。
- `docs/incidents-and-gates.md` 的 I-102 行：证实状态为“已落门槛”，门槛栏中的 `test/tooling/aggregate.test.mjs` 存在；`check-incident-gates.mjs:48-70` 接受 `I-\d{2,}`、检查重复与路径存在性。I-101 不是独立行（`incidents-and-gates.md:130` 说明已并入 I-97），所以 I-102 没有编号冲突。
- “去掉修改时新用例失败”：静态推断成立——旧代码会把嵌套文件读成 envelope，`not.toContain` 和 `aggregate(...).status === "passed"` 都会失败；但符号链接那一段改动前后都会通过，不是反向判别点。

**未核实**
- 作者给出的“aggregate 61 个、gate-lifecycle 15 个用例通过”、lint/format/incident-gates 通过、`validate_docs.py --strict` 错误数不变：受工具限制我没有执行测试或 Node/Python，未核实。
- 增量中的 `.agents/reviews/pr-494/usage.jsonl` 是二进制复核记账，内容未核实，不影响运行代码。

**侧重检查**
- 错误路径：嵌套的非法 `result.json` 现在被静默忽略而不是报错；对必需成员来说最终仍会因缺失报告失败，属于 fail-closed。符号链接仍在读取前抛错。
- 不合规范/不可信输入：新逻辑扩大了对嵌套 `result.json` 的忽略范围；目前无法借此跳过必需检查（缺失会报错），但会少报“意外的额外结果文件”。路径安全仍依赖原有的 `existingInside`，本改动未新增路径拼接。
- 资源耗尽：每层仍只调用一次 `readdirSync`，额外只多一次 `entries.some` 扫描；没有新增无界递归。嵌套结果不再作为 envelope 解析，工作量略减。
- 不可撤销操作：`aggregate`/`export-evidence` 的输出仍用 `flag: "wx"`，本改动未触碰。
- 规则、说明与代码一致：I-102 行与代码行为一致；`prompt-prefix.md` 与本改动无关；事故门槛路径存在且能被 `check-incident-gates` 接受。

**必答问题**

1. 不会改变模型已经见过的请求开头。`readReportEnvelopes` 只被 `scripts/ci/required.mjs` 和 `scripts/ci/export-evidence.mjs` 使用（另有测试），不在任何模型请求组装路径上；因此发给模型的内容没有变化，仍然只在末尾追加，每轮会变的值仍只能在最后一条消息里，符合 `.claude/rules/prompt-prefix.md:27-29、34` 的要求。

2. 不会让同一段文字在不同请求里变成不同字节。本改动不碰系统提示、工具定义、历史、遮盖或任何发送给模型的序列化。CI 侧 `readReportEnvelopes` 的 envelope 顺序仍依赖 `readdirSync` 顺序（本改动前后都如此），但这只影响 CI 汇总，不进入模型请求。

3. 有自动检查。`test/tooling/aggregate.test.mjs` 在 tooling 项目中，会由 `npm run test:tooling` 和 CI 的 tooling 作业运行。反向判别成立：去掉修复后旧代码会把嵌套文件读成 envelope，`not.toContain` 和 `aggregate(...).status === "passed"` 都会失败；符号链接断言本身不是反向判别点。测试实际执行结果未核实。

4. 逐个使用端都核对过：`I-102` 这个新清单项被 `check-incident-gates.mjs` 的 `^I-\d{2,}$`、唯一性检查和路径存在性检查接受，且没有 I-101 冲突；新测试标题被文档引用但不参与机器解析；`readReportEnvelopes` 的返回值结构未变，合法结果的 `source` 仍是 `<job>-<member>/result.json`，`required.mjs:27`、`export-evidence.mjs:120` 及 `export-evidence.mjs:134-142` 的安全报告定位都能接受；没有新增配置键或序列化格式。唯一需要留意的是第 1、2 条所述的“嵌套跳过”边界，但当前真实收集布局不会让任何必需检查结果落在被跳过位置。
