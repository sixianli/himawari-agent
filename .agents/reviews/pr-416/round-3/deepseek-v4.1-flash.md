## 结论摘要

本轮增量里，`publicGate` 接入日志的方向是对的，私钥标记兜底也基本覆盖了标准 PEM 头被截断的两种方向。但发现一个高严重度的安全/一致性缺陷：**作业摘要表里的失败原因没有遮盖也没有转义**，与同一提交改的 ADR 冲突，且既有测试按代码逻辑会失败。另有私钥标签覆盖缺口和测试接线缺口。

---

## 读代码证实的问题

### 1. 高 — 作业摘要表的失败原因未遮盖、未转义

- **文件:行**：`scripts/ci/required.mjs:49`（写入在 `scripts/ci/required.mjs:79`）
- **问题**：`publicGate` 只作用在写进步骤日志的那份副本上；作业摘要表仍用原始 `summary`，而表格中的 `reasons` 是直接 `join` 的，没有经过 `cell`（`cell` 才做 `redactText` 和控制字符/竖线转义）。结果：失败原因里的密钥会原样进入公开的 GitHub 作业摘要，换行和 `|` 还能破坏/伪造表格。ADR 0243 决定 1 明确说表里的失败原因“同样先遮盖”，但代码没有。
- **证据**：
  - `scripts/ci/required.mjs:49`：
    `` `| ${cell(check.checkId)}/${cell(check.matrixKey)} | ${cell(check.status)} | ${cell(check.reasons.join("；") || "-")} |` ``
  - `scripts/ci/required.mjs:77-79`：
    ```js
    write(encodeGate(publicGate({ context, summary })));
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, gateSummaryMarkdown(summary));
    ```
  - `docs/adr/0243-ci-uses-no-github-artifacts.md:55`：“它同时把每个检查的结果和失败原因（**同样先遮盖**）写成一张表”。
  - 既有测试 `test/tooling/ci-summary.test.mjs:142-162` 用 `Unsafe report path: a|b\n| forged | row | ${secret}` 断言表格不含 `secret` 且列数正确；按 `required.mjs:49` 的逻辑，这条用例会在 `expect(text).not.toContain(secret)` 失败（我未实际运行测试，环境只允许 git 只读命令）。
- **建议**：改为 `${cell(check.reasons.join("；") || "-")}`，或让表格使用 `publicGate(...)` 的结果；同时也应保留 `cell` 的换行/竖线转义，单纯 `redactText` 不足以防表格注入。

### 2. 中 — 私钥标记检查没有覆盖所有标签，正常诊断也会被误判

- **文件:行**：`scripts/ci/ci-summary.mjs:66`；相关：`scripts/ci/redact-text.mjs:2`
- **问题**：新增标记正则只接受 `[A-Z ]*`，遇到带数字或后缀的标签就漏掉，例如 `[已遮盖:private-key-header]`、`[已遮盖:private-key-header]`。`redactText` 的整块规则也只认 `RSA / EC / OPENSSH`。因此这两类私钥即使完整出现，也不会被遮盖，也不会被判为二进制，仍会显示在作业摘要里。反过来，任何只是“提到”PEM 头的正常诊断（例如测试日志、文档片段）都会被整份隐藏成“二进制文件”，这是安全优先的取舍，但会损失排障信息，且没有在输出里说明原因。
- **证据**：
  - `scripts/ci/ci-summary.mjs:66`：
    ```js
    if (/-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----/u.test(redacted)) return null;
    ```
  - `scripts/ci/redact-text.mjs:2`：
    ```js
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    ```
  - `SSH2` 中的 `2` 和 `PGP ... BLOCK` 的 `BLOCK` 都不匹配上述两条规则。
- **建议**：标记正则放宽到 `[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?`，并同步扩展 `redactText`；为 SSH2/PGP 标签补测试。若担心误判正常诊断，可至少把隐藏原因写进摘要（例如“因含私钥标记不显示”）。

### 3. 低 — 本轮日志遮盖没有端到端自动检查，反向用例保护不到接线

- **文件:行**：`test/tooling/ci-summary.test.mjs:133-141`；`test/tooling/gate-lifecycle.test.mjs:728-731`
- **问题**：新增测试只直接调用 `publicGate`，没有断言 `required.main` 打印出的日志经过遮盖。把 `required.mjs:77` 回退成 `write(encodeGate({ context, summary }))`，现有测试仍然会通过，因为 `gate-lifecycle` 的成功夹具里没有像密钥的字符串。也就是说，本轮真正要修的行为没有被反向用例锁住。另外，新增的“多字节截断”用例在本轮改动回退后仍会通过（它依赖的是已有的“丢弃首行片段”逻辑），不属于本轮的反向用例；`readSync` 短读分支也没有测试。
- **证据**：
  - `test/tooling/ci-summary.test.mjs:134-140` 直接对 `publicGate({...})` 断言，没有走 `main`。
  - `test/tooling/gate-lifecycle.test.mjs:728-731` 只比较打印结果与磁盘文件，夹具为通过状态、`reasons` 为空。
  - `scripts/ci/ci-summary.mjs:44` 新增的短读返回 `null` 分支没有对应用例。
- **建议**：增加一个 `required.main`/CLI 级用例：构造带密钥的失败原因，断言打印的 gate 日志里没有该密钥；同时补一个私钥只有 `BEGIN`、没有 `END` 的方向（现用例只覆盖 `END` 残留）。

### 4. 低 — ADR 决定 4 没有记录本轮新增的“二进制”条件

- **文件:行**：`docs/adr/0243-ci-uses-no-github-artifacts.md:58`
- **问题**：ADR 决定 4 仍只把“含 NUL 或找不到换行”列为按二进制处理的条件；本轮新增的“遮盖后仍残留私钥标记”和“短读字节数不符”都没有写进文档。设计文档第 129 行也只说“先遮盖”，没有说残留标记会导致整份文件不显示。作者说明中的“文档：ADR 0243 … 决定 4”与实际改动不完全一致：决定 4 只改了“每段摘要总量”的措辞。
- **证据**：`docs/adr/0243-ci-uses-no-github-artifacts.md:58` 的条件列表；`scripts/ci/ci-summary.mjs:44,65-66` 的新增分支。
- **建议**：在 ADR 决定 4 和设计文档对应段落补上这两个二进制条件及原因。

### 5. 低 — 单个诊断文件读取失败会中断整份摘要

- **文件:行**：`scripts/ci/ci-summary.mjs:42`、`scripts/ci/ci-summary.mjs:92-93`
- **问题**：`renderSummary` 对每个文件直接 `openSync`；如果文件在 `listFiles` 之后被删除、权限变化或是读取失败，异常会冒泡到 `main`，整份作业摘要都不会写，而不是把该文件标成不可读。这是本 PR 新增文件里的错误路径，不是本轮引入的，但与“失败时保留诊断”的目标相反。
- **证据**：
  ```js
  const handle = openSync(file.full, "r");
  ```
  以及 `renderSummary` 循环中直接调用 `textTail(file)`，没有 per-file `try/catch`。
- **建议**：对单个文件的 `openSync/readSync/TextDecoder` 失败按“二进制/不可读”处理并继续，至少不要让一个文件拖垮全部诊断。

---

## 推测 / 未核实

- **推测**：`redactText` 的私钥整块正则 `[\s\S]*?` 在 256 KiB 对抗性输入（大量 `BEGIN` 但无 `END`）下可能产生明显的回溯开销。未实测；该正则在本 PR 基线之前已存在，不是本轮引入。
- **推测**：如果将来某个检查 id 或矩阵键恰好命中遮盖规则，`publicGate` 会把 `summary.expected/observed/checks` 一起改成 `[REDACTED]`，`verifyGate` 用当前 policy 重新计算期望值时会不匹配，从而退回完整 CI。属 fail-closed，不会误放行，但会损失轻量确认路径；目前 policy 里的 id 均不命中。
- **未核实**：未运行任何测试（环境只允许 git 只读命令），因此“既有测试会失败”是按代码逻辑推断；未实际验证 SSH2/PGP 私钥的完整输出；未重新核实 Himawari 全仓现有实现是否仍满足 prompt-prefix 规则（本 PR 未触碰该部分）。

---

## 侧重检查

- **错误路径**：`readTail` 短读返回 `null`，`textTail` 第 53 行已处理；`textTail` 的私钥残留返回 `null`，`renderSummary` 第 96 行按二进制处理。失败路径的主要问题是第 5 条：单个文件读取异常会终止整份摘要。
- **不可信输入**：`summary.reasons` 可携带来自报告 `report.path`、`project.id`、Ajv `error.message` 的字符串；这些内容进入作业摘要表时没有经过 `cell`，既可泄露像密钥的字符串，也可注入换行/竖线（第 1 条）。`ci-summary` 处理的诊断内容来自 PR 代码，属于不可信输入；私钥标记是 fail-closed，方向正确。
- **安全**：完整 PEM 私钥会被 `redactText` 替换；残缺 PEM 由新标记检查兜底。但 SSH2/PGP 标签是缺口（第 2 条）。`.ci-output/gate/*.json` 仍保留未遮盖内容，但按 ADR 0238/0243 只留在 CI VPS，本次没有发现它被上传到公开处；公开的作业摘要表才是实际泄露面。
- **资源耗尽**：摘要输出有 64 KiB 上限，单文件最多读 256 KiB；新标记正则是线性的。未发现本轮新增的明显资源耗尽点。
- **不可撤销操作**：本增量没有删除/覆盖类操作，`required` 仍用 `wx` 写文件，`ci-summary` 只追加作业摘要；未见新增风险。
- **规则/文档/代码一致性**：ADR 0243:55 与代码不一致（第 1、4 条）；设计文档 129 与代码基本一致，但漏写新增二进制条件；设计文档 320/357/394 与代码/工作流一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
不会。本 PR 的文件清单只有 CI 脚本、工作流、文档、测试和复核材料，没有修改系统提示、工具定义、历史消息、遮盖实现或模型请求组装代码。因此对模型请求而言，仍然是“只在末尾追加、每轮变化的值在最后一条消息里”这一前提不受影响；本 PR 没有重新验证这一既有实现（未核实）。

### 2. 同一段文字会不会在不同请求里变成不同字节？
对模型请求不涉及。对 CI 侧：`publicGate` 和 `redactText` 都是纯函数，不依赖时间、随机数或前后消息，同一字符串每次遮出的字节相同。唯一附带观察是 `summary.observed` 的顺序来自 `readdirSync`（`scripts/ci/aggregate.mjs:249` 一带），同一组报告在不同文件系统顺序下会让 gate JSON 字节不同；但 `verifyGate` 对 `observed/expected` 都做了排序（`scripts/ci/main-evidence.mjs:226-227`），不影响验收，也不是模型请求。

### 3. 有没有对应的自动检查，反向用例会不会真的失败？
部分有：
- 私钥截断用例：有，且去掉新标记检查后会把 `KEYBODY` 显示出来，反向用例成立。
- `publicGate` 函数本身：有单元反向用例。
- `required.main` 把遮盖接进日志：没有端到端反向用例，回退接线测试仍绿（第 3 条）。
- 多字节截断用例：有，但它不是本轮改动的反向用例，回退本轮代码仍会通过。
- `readSync` 短读分支：没有测试。
- 既有“失败原因里的密钥、竖线、换行不会进表格”用例：按代码逻辑应失败（第 1 条）。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？
- **gate 日志字节**：产生于 `required.mjs:77`（`publicGate` + `encodeGate`），使用于 `main-evidence.mjs:172` 的 `decodeGate` 和 `verifyGate`。逐项核对：`repository/event/runId/attempt/baseSha/headSha/testedSha/policySha256/toolchainSha256/initialization` 都是小写 hex、数字、固定枚举或布尔，不会命中 `redactText` 的规则；`verifyGate` 用当前 policy 和本地文件哈希重新计算，红acted 值若被改动只会导致拒绝并退回完整 CI，不会误通过。当前 policy 的矩阵 id 也不会被误伤（当前结论：通过）。
- **`expected/observed/checks` 矩阵**：`publicGate` 对它们同样做遮盖；现有 id 不受影响。未来若命中规则，`verifyGate` 会因与未遮盖的 policy 期望不一致而拒绝（fail-closed）。
- **磁盘 `.ci-output/gate/*.json`**：仍不遮盖，`export-evidence` 和 `gate-lifecycle` 测试读它；生产轻量路径只读日志、不读这份磁盘文件。没有发现公开泄露路径，但“打印的 gate 等于磁盘 gate”这个测试不变量在失败原因含密钥时不再成立。
- **`readTail`/`textTail` 的 `null`**：唯一调用方 `renderSummary` 已把它当二进制处理，两端一致。
- **文档引用**：ADR 0243:55 的“失败原因同样先遮盖”与实际使用方 `gateSummaryMarkdown` 不一致（第 1 条）。

---

## 对作者三个核对点的直接回答

1. **`publicGate` 遮盖后 `decodeGate → verifyGate` 是否仍逐字段通过？** 对当前 policy 和通过状态是：SHA、摘要字段均为小写 hex，运行号是数字字符串，attempt 是数字，矩阵 id 不含冒号/等号/点分 JWT，不会被 `redactText` 命中；`verifyGate` 的 identity 循环比较的是同样被遮盖的 context 与 summary，仍相等。未来若 id 命中规则会 fail-closed 退回完整 CI，不会误放行。
2. **私钥标记检查是否覆盖截断切开私钥的所有位置？会不会误判正常诊断？** 标准 PEM（BEGIN/END 任一残留在读取窗口内）都能覆盖：截掉 BEGIN 时 END 会命中，截掉 END 时 BEGIN 会命中，整块完整时先被 `redactText` 替换。覆盖不到带数字/后缀的标签（SSH2、PGP BLOCK）。会误判：正常诊断只要出现这类标记文字，整份文件就不再显示——这是安全取舍，但会损失排障信息。
3. **文档改动和代码是否一致？** 不一致：ADR 0243:55 声称作业摘要表的失败原因“同样先遮盖”，代码 `required.mjs:49` 没有；ADR 决定 4 也没有记录新增的私钥标记/短读二进制条件。设计文档 129、320、357、394 与代码基本一致，但同样没写私钥标记兜底。作者说“作业摘要表不变”与代码一致，但和同一提交的 ADR 修改矛盾。
