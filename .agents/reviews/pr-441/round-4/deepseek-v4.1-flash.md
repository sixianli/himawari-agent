## 结论摘要

核对了第 4 轮增量（`f30de84..3c8c971`）以及相关生产/消费路径。四条摘要入口确实已统一成“去 SGR 颜色码 → 遮盖 → 查私钥标记”，但**同一类遮盖入口没有全部修复**：命令日志在写入和发布时仍然只做 `redactText`，被颜色码切开的密钥会留在 `.ci-output/public/reports/*.log` 和共享目录里；摘要里看不见，不代表文件里没有。另有 SGR 正则覆盖不全、security 作业实际没有命令日志、ADR 与代码的两处细节不一致。

---

## 发现的问题（按严重度）

### 1. 中：ANSI 遮盖只修了摘要，原始日志和发布/共享报告仍保留被颜色码切开的密钥

- 文件:行：
  - `scripts/ci/execute.mjs:45-49`
  - `scripts/ci/publish.mjs:26-27,96-99`
  - `scripts/ci/security-redaction.mjs:20-22`
  - 对照 `scripts/ci/ci-summary.mjs:75`
- 问题：第 4 轮只让 `ci-summary` 在遮盖前去掉颜色码。命令日志在 `execute.mjs` 写盘时、以及 `publish.mjs` 发布到 `.ci-output/public/reports/` 时，仍然直接调用 `redactText`，没有先去颜色码；校验函数 `assertClean` 也用同一个 `redactText`，所以会放行这种漏网文件。结果是：作业摘要和作业日志已经安全，但 public reports 和 `run-share put` 复制的共享目录里仍有被 `ESC[31m` 切开的密钥原文。
- 证据（已读到）：
  - `execute.mjs:47`：`` `${redactText(Buffer.concat(chunks).toString("utf8"))}\n${JSON.stringify(result)}\n` ``
  - `publish.mjs:27`：`if (kind !== "json") return redactText(text, { sentinels });`
  - `security-redaction.mjs:22`：`assert(redactText(text, { sentinels }) === text, "PUBLIC_ARTIFACT_CONTAINS_SECRET")`
  - `ci-summary.mjs:75`：`const redacted = redactText(text.replace(ANSI_COLOR, ""));`
- 建议：把“先去掉 ANSI，再遮盖”抽成公共函数，至少同时用于 `execute.mjs`、`publish.mjs`、`required.mjs` 的表格文字和 `ci-summary.mjs`；并加一条经过 `publish` 的反向用例：带 `ghp_AAAA<ESC>[31m...` 的 `.log` 必须被发布校验拒绝或遮盖，而不只是摘要里看不到。如果认为共享报告不在本 PR 范围，应在 ADR 里明确写清。
- 定性：代码路径已证实；“攻击者可控测试输出”是前提，属安全推理。

### 2. 中低：SGR 正则只认 `[0-9;]*`，冒号参数的颜色码仍可绕过摘要的“先去颜色码”

- 文件:行：`scripts/ci/ci-summary.mjs:23`（并在 `75,93,175,181` 使用）
- 问题：`const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu")` 不匹配 ISO 8613-6 的冒号参数，例如 `ESC[38:2::255:0:0m`、`ESC[4:3m`，也不匹配 OSC 超链接等其它转义序列。把这些序列插在密钥或私钥标记中间时，`redactText` 仍会看到 ESC 而认不出完整 token；之后控制字符替换只把 ESC 变成 `?`，密钥的其余字符仍会出现在输出里。
- 证据（已读到）：
  - `ci-summary.mjs:23`：`const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");`
  - 新测试只用了 `ESC[31m`：`test/tooling/ci-summary.test.mjs:359`：`` `${secret.slice(0, 10)}${esc}[31m${secret.slice(10)}${esc}[0m` ``
- 建议：改为去掉完整 CSI/OSC 序列（例如先匹配 `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)` 和 `\x1b\[[0-?]*[ -/]*[@-~]`，或至少把参数类扩到冒号），并统一在 `redactText` 前调用；补一条冒号参数 SGR 的反向用例。
- 定性：正则覆盖范围已证实；能否实际绕过取决于输入，属安全推理。

### 3. 低：security 作业没有任何 `diagnostic` `.log`，`--failed-logs` 对 security 实际不产生内容，与 ADR 补充说明不一致

- 文件:行：
  - `docs/adr/0243-ci-uses-no-github-artifacts.md:59`
  - `scripts/ci/run.mjs:253-260`
  - `scripts/ci/check-security.mjs:55-67,825-849`
  - `scripts/ci/ci-summary.mjs:257`
- 问题：ADR 写“build、browser、security 作业自己记日志，它们的日志按路径排序”，但 `runSecurityChecks` 的 `execute` 只用 `spawnSync` 收 stdout/stderr 到内存，只写 `security-report.json`；`run.mjs` 也只把该 JSON 登记为 `kind: "json"`。`ci-summary` 的命令日志只取 `kind === "diagnostic"` 且以 `.log` 结尾的文件，因此 security 失败时这一段为空，不会显示任何命令日志。
- 证据（已读到）：
  - `check-security.mjs:55-67`：`spawnSync(... maxBuffer: 64 * 1024 * 1024 ...)`，`return { exitCode, stdout, stderr }`，没有写日志文件。
  - `check-security.mjs:825-849`：只写 `security-report.json` 并返回 `reportPath`。
  - `run.mjs:260`：`files.push({ path: security.reportPath, kind: "json" });`
  - `ci-summary.mjs:257`：`const logs = new Set(reportPaths(result, "diagnostic", ".log"));`
- 建议：要么给 security 增加登记为 `diagnostic` 的日志（并在发布前遮盖），要么让摘要渲染 `security-report.json` 的失败 findings；如果都不做，应修改 ADR，不再声称 security 有按路径排序的命令日志。
- 定性：已证实。

### 4. 低：ADR 说“放不下的文件列出前 5 个名字”，但说明文字自身放不下时完全不写

- 文件:行：`scripts/ci/ci-summary.mjs:132-135`；`docs/adr/0243-ci-uses-no-github-artifacts.md:58`
- 问题：本轮新增了 `if (used + Buffer.byteLength(footer) <= limit) sections.push(footer);`，即 footer 本身放不下时直接不写。ADR 仍写成“放不下的文件列出前 5 个名字”，没有提这个例外。生产上限 64 KiB 下通常不会触发，但小上限或极端长文件名时输出会没有任何省略说明。
- 证据（已读到）：
  - `ci-summary.mjs:133-134`：`const footer = footerFrom(shown); if (used + Buffer.byteLength(footer) <= limit) sections.push(footer);`
  - 新测试 `test/tooling/ci-summary.test.mjs:393-400` 只检查字节数，不检查是否写了说明文字。
- 建议：要么始终输出一个最小说明（例如“其余 N 个文件未显示”），要么在 ADR 中补上“footer 本身放不下时不写说明”的例外，并相应增加测试。
- 定性：已证实。

### 5. 低：文件名里是完整 PEM 私钥时，实际显示 `[REDACTED]` 而不是 ADR 说的 `?`

- 文件:行：`scripts/ci/ci-summary.mjs:93-95`；`scripts/ci/redact-text.mjs:2`；`docs/adr/0243-ci-uses-no-github-artifacts.md:59`
- 问题：`safeName` 先 `redactText` 再查 `PRIVATE_KEY_MARKER`。完整 PEM 私钥会先被 `redact-text.mjs:2` 的整体替换成 `[REDACTED]`，标记消失，于是不会命中 `?` 分支；只有“遮盖规则不认、标记仍残留”的私钥（SSH2/PGP）才显示 `?`。ADR 写的是“用例名或文件名里带私钥开始或结束标记时，整个名字显示成 `?`”，与完整 PEM 的实际显示不完全一致。密钥本身仍被遮掉，所以严重度低。
- 证据（已读到）：
  - `ci-summary.mjs:93-95`：`const redacted = redactText(...); if (PRIVATE_KEY_MARKER.test(redacted)) return "?";`
  - `redact-text.mjs:2`：`/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END .../g`
- 建议：如果要求“名字里有标记就整个显示 `?`”，应在遮盖前对原始（去 ANSI 后）字符串做标记判断；否则把 ADR 改成只对遮盖后仍残留标记的名字显示 `?`。
- 定性：已证实。

### 6. 低（推测）：`readJsonInside` 存在 TOCTOU，且 JSON 报告数量本身没有上限

- 文件:行：`scripts/ci/ci-summary.mjs:148-154,193-219`
- 问题：`lstatSync` 确认普通文件/大小，再用 `readFileSync` 打开，中间可被替换为符号链接；`realpathSync` 校验与读取不是同一个文件描述符。另外 `failedTests` 会读取 `result.reports` 里所有 `kind: "json"` 的报告，每个上限 64 MiB，但没有限制报告数量或总读取量。
- 证据（已读到）：
  - `ci-summary.mjs:151-154`：`const stat = lstatSync(full); ... return JSON.parse(readFileSync(full, "utf8"));`
  - `ci-summary.mjs:195-197`：`for (const relative of reportPaths(result, "json", ".json").sort()) { const report = readJsonInside(reports, relative); ... }`
- 建议：用 `openSync` 后 `fstat`/`O_NOFOLLOW` 再读取，或至少在打开后核对 `fstat` 与 `realpath`；对报告数量/总读取字节设置上限。考虑到这些文件通常由 CI 自己产生，实际可利用性低，故标为推测/残余风险。
- 定性：代码结构已证实；实际攻击场景是推测。

---

## 侧重检查

- **遮盖/私钥路径**：逐一读了 `textTail`、`safeName`、`cleanLine`、`failureMessage`，四处的顺序本轮确实都是“去颜色码 → `redactText` → `PRIVATE_KEY_MARKER`”。但还发现 `execute`、`publish`、`required` 的同类遮盖入口没有做 ANSI 预处理（发现 1），以及 SGR 正则覆盖不全（发现 2）。
- **不可信输入/路径**：`reportPaths` 已拒绝绝对路径和含 `..` 的组件；`readJsonInside` 检查普通文件、64 MiB 上限、`realpath` 位于 `reports/` 内；测试覆盖了目录外路径和符号链接目录。残余问题见发现 6。
- **资源耗尽**：文本只读末尾 256 KiB，摘要总量 64 KiB，失败用例最多 30 条、每条报错 20 行、命令日志每个 120 行；这些上限有效。未限制的是 JSON 报告数量和“解析所有报告”的累计开销，属低风险。
- **日志注入**：`logLines` 对每一行加 `| `，且 `textTail`/`failureMessage` 替换控制字符、U+2028/U+2029，`safeName`/`cleanLine` 替换反引号和竖线；没有发现能重新变成 GitHub 工作流命令的路径。未处理 `\p{Cf}` 里的 bidi/零宽字符，可能造成显示层混淆，但不会绕过 `| ` 前缀，属推测性低风险。
- **错误路径**：`--failed-logs` 空串会被 `!argv[i + 1]` 拒绝；`result.json` 读不出来只输出一句说明；`reports` 目录不存在返回空；`status === "passed"` 不显示失败段。错误分支没有发现会抛出未捕获异常的地方（`listFiles` 对不可读目录仍会抛，但输入目录由 CI 控制）。
- **不可撤销操作**：本次改动本身只读文件并 `appendFileSync` 写 `GITHUB_STEP_SUMMARY`，没有删除、移动或覆盖操作；发布和 `run-share put` 是既有步骤，摘要步骤在其后执行，不会删除报告。
- **文档/规则一致性**：ADR 0243 的补充说明与摘要实现大体一致，但发现 3、4、5 三处与代码不完全一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。这个改动只动了 `scripts/ci/ci-summary.mjs`、`.github/workflows/ci.yml`、测试和 ADR/设计文档，不进入系统提示、工具定义、历史消息或模型输入遮盖的组装路径。发给模型的内容仍由现有请求组装逻辑保证“只在末尾追加、每轮变化的值放在最后一条消息里”，本改动没有新增任何每轮变化的值。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules) 第 4 条。
未核实：我没有重新审查提示词组装代码本身（不在本次 diff 内），只核对了本次改动没有触及那条路径。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

不会（就模型请求而言不相关）。摘要输出本身对相同输入是确定的：

- 文件列表按相对路径排序（`ci-summary.mjs:41`）；
- 失败用例的报告路径排序（`:195`）；
- `Set` 只用于成员判断，不用于决定输出顺序；
- 没有时间、运行号等每轮变化字段；
- `redactText` 只依赖当前字符串，不依赖前后文。

因此同一个文件内容、同一个 `limit` 每次会得到相同字节。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，但我没有运行测试（工具限制只能读代码）。

- `test/tooling/ci-summary.test.mjs:357-386` 覆盖了“颜色码夹在密钥/私钥标记中间”的场景。若把 `textTail`/`cleanLine`/`failureMessage` 的顺序退回“先遮盖、后去颜色码”，`expect(text).not.toContain(secret.slice(10, 30))`、`expect(text).not.toContain("keybody")`、`expect(text).toContain("`policy.log`：二进制文件")` 都会失败，反向用例有效。
- `test/tooling/ci-summary.test.mjs:387-392` 覆盖文件名带 SSH2 私钥标记显示 `?`。
- `test/tooling/policy.test.mjs:696-713` 覆盖 `--failed-logs` 缺失或目录错误时策略检查失败，反向用例有效。
- 未覆盖/不会失败的地方：`safeName` 的 ANSI 去码没有反向用例（只测了不带 ANSI 的标记）；没有冒号参数 SGR 的反向用例；没有经过 `publish`/`execute` 的集成反向用例，所以发现 1 不会被现有测试发现；`ci-summary.test.mjs:393-400` 只断言摘要不超上限，不检查“省略说明文字”是否应该存在。

### 4. 每个值、生产者和消费者是否都能对上？

逐个核对结果：

- `--failed-logs`：生产者是 `.github/workflows/ci.yml:68,111,159,232,280,323`；消费者是 `ci-summary.mjs:287,298-299`，策略校验是 `check-policy.mjs:563`，测试夹具在 `policy.test.mjs:129`。两端一致。`quality.yml` 和 `main.yml` 不传这个参数，也不需要，`main()` 仍会打印它们原有的摘要。
- `result.reports[].kind === "diagnostic"`：生产者 `publish.mjs:118` 用 `reportEntry(target, report.kind, reports)`，保留的是原始 `report.kind`（`"diagnostic"`），不是同函数里为白名单计算的显示 `kind`（`:101-110`）；消费者 `ci-summary.mjs:257` 正好按 `"diagnostic"` 过滤。目前能对上，但同一个函数里有两个 `kind` 概念，比较脆弱。`quality`/`main` 的 `ci-summary` 不读 `result.json`，不受影响。
- `details.json.commands[].name` → `${name}.log`：生产者 `run.mjs:173,183` 用同一 `name` 生成日志文件和命令记录；消费者 `ci-summary.mjs:246-247,267` 用 `${name}.log` 与日志基名比较。两端一致。
- `result.json` 位置和相对路径：生产者 `publish.mjs:122-125` 写到 `reports/result.json`，`reportEntry` 生成相对 `reports/` 的路径；消费者 `ci-summary.mjs:161,196,242` 用 `readJsonInside(reports, ...)` 和 `path.join(reports, relative)`。一致。
- 常量 `20/120/30`：`ci-summary.mjs:144-145,18` 与 ADR 0243 第 4 条补充一致；`ci-summary.test.mjs:401-405` 检查的是代码常量本身，不检查 ADR 文字，所以文档漂移不会被这个测试抓到。
- 不一致的地方：security 作业没有 `diagnostic` 日志（发现 3）；ADR 的 footer 说明与实际行为不一致（发现 4）；完整 PEM 文件名显示 `[REDACTED]` 而非 `?`（发现 5）。

**未核实**：我没有实际运行任何测试或 CI；以上测试效果均来自静态阅读。
