# PR 441 第 1 轮复核

## 侧重检查

我走的流程：一个普通 PR 的 policy 作业失败，从入口走到结束：

1. `scripts/ci/run.mjs` 检查失败，`result.status = "failed"`（run.mjs:185、483），步骤日志只有 run.mjs:586 的 `checkId/matrixKey: failed (N passed, M failed)` 一行——这正是本次要修的缺口。
2. `publish` 步骤 `if: always()`（ci.yml:60）仍执行，`publish.mjs` 把 `.ci-output/check` 发布为 `.ci-output/public`：非二进制报告逐份 `redactReport` 遮盖（publish.mjs:96-100），并把发布版 `result.json` 写进 `reports/`（publish.mjs:122-123），status 原样保留。
3. 摘要步骤 `if: always() && steps.publish.outcome == 'success'`（ci.yml:66-68）运行 `ci-summary.mjs ... --failed-logs .ci-output/public/reports`：`checkFailed` 读发布版 result.json（ci-summary.mjs:126-132），失败时 `renderFailedLogs` 经 `renderSummary`/`textTail` 显示每个 `.log` 最后 120 行（ci-summary.mjs:134-142）。
4. `main` 把同一份文字 append 进 `GITHUB_STEP_SUMMARY`，再经 `logLines` 逐行加 `| ` 写 stdout（ci-summary.mjs:168-176）。

覆盖情况：步骤 3-4 有新单测（ci-summary.test.mjs:147-216，含敌意内容、passed 不显示、result.json 读不出、无内容不打印共 4 个用例）；工作流逐字比对有单元反向用例（policy.test.mjs:685-700）且真实 `ci.yml` 由 policy 作业里的 `check-policy.mjs` main 核验（check-policy.mjs:1363-1371）。**未测试覆盖的路径**：publish 步骤本身失败时摘要步骤不运行（ci.yml:67 条件），此时仍然查不到日志——作者已声明为约束，是残留缺口；GitHub runner 对 `::`/`##[` 命令的解析行为无法在本仓库实测，标「未核实」；「作业摘要没有 API 可读」无法上网核实，标「未核实」。

## 发现的问题（严重度从高到低）

**低** · `docs/adr/0243-ci-uses-no-github-artifacts.md:59`（补充段）／作者说法
问题：「`reports/` 里的文件已经由 `publish.mjs` 遮盖过」不完全准确。证据：`publish.mjs:95-96`——`const binary = diagnostic || report.kind === "artifact"; ... if (binary) copyFileSync(source, target);`——`kind === "artifact"` 的文件**原样复制、不遮盖**，只在发布前经密钥扫描（security-redaction.mjs:151-161、226，扫出密钥则 publish 失败）。若某检查把 `.log` 作为 artifact 发布，failed-logs 显示的是只经过扫描、未经遮盖管道的原文；`ci-summary` 的二次遮盖不带 sentinels（ci-summary.mjs:72 `redactText(text)`），sentinel 级秘密只能靠 publish 阶段拦截。不构成泄露（扫描拦截兜底），但措辞与代码有偏差。建议：ADR 补充改为「文本报告已遮盖；artifact 原样复制但发布前经密钥扫描」。

**低** · `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:320`
问题：该行仍写「每个文本文件最后 40 行，每段摘要不超过 64 KiB」，未提及本次新增的「检查失败时命令日志显示最后 120 行」（第 250 行已更新）。证据：320 行原文与 ci-summary.mjs:17 `FAILED_LOG_TAIL_LINES = 120` 不一致。建议：320 行补一句。

**低（信息）** · `scripts/ci/ci-summary.mjs:144-149`
问题：`logLines` 对末尾多出的空行会打出一行 `| `。证据：摘要段落以 `` ```text…````\n\n `` 结尾，`replace(/\n$/u,"")` 只删一个换行，`split("\n")` 产生尾部空串，映射成 `| \n`。纯外观，无安全影响。建议：可先 `trimEnd`，或不动。

**低（信息）** · `scripts/ci/ci-summary.mjs:157-164`
问题：参数解析只拒绝 `undefined`，`--failed-logs ""` 会以 cwd 作为 reports 目录扫全仓库 `.log`。当前 ci.yml 是写死路径且被逐字比对锁着，实际不可达。建议：可加空串校验，非必需。

读代码证实的结论：作者其余说法（120 行、64 KiB、`| ` 前缀、quality/main 命令行不变、`reports/` 随汇总作业删除（ci.yml:369-371）、check-policy 逐字比对同步）均与代码一致；「作业摘要无 API 可读」未核实。

## 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会。`git diff --stat` 显示改动只落在 `.github/workflows/`、`scripts/ci/`、`test/tooling/`、`docs/`、`.agents/reviews/`，没有任何组装模型请求的代码（prompt-catalog、runtime-pi 等）被碰。发给模型的内容不变，该规则（prompt-prefix.md）在此不适用。

**2. 同一段文字会不会在不同请求里变成不同字节？** 不会影响模型请求。CI 内部输出是确定的：文件按路径字典序排（ci-summary.mjs:38），`ci-summary` 自己不注入时间；日志内容随每次运行变化是测试输出本身的属性，且只进 GitHub 日志/摘要，不进模型请求。

**3. 自动检查与反向用例？** 有。硬规则在 `check-policy.mjs:560-563` 逐字比对（含 `--failed-logs`），真实 ci.yml 在 policy 作业被核验（check-policy.mjs:1363-1371）；`policy.test.mjs:129` 已同步，反向用例（missing/duplicated/only on success/wrong folder/wrong title，policy.test.mjs:685-700）在逐字比对下任何漂移都会抛错——没有专门「只去掉 `--failed-logs`」的具名用例，但同样会失败。新逻辑的 4 个单测齐全，敌意内容用例验证了每行都带 `| ` 前缀。

**4. 每个值的两端核对（I-73 口径）？** `--failed-logs`：产生于 ci-summary.mjs:159-171 的解析，使用于 ci.yml 六处命令（ci.yml:68 等）、check-policy.mjs:563、policy.test.mjs:129，三处字符串逐字一致。`FAILED_LOG_TAIL_LINES`：定义于 ci-summary.mjs:17，用于 renderFailedLogs:139 和文案，测试引用同值。`renderFailedLogs`/`logLines` 导出：仅测试与 main 内部使用，签名一致。stdout 新输出：消费者是读日志的人和代理；摘要步骤无 `id`、无 `steps.*` 引用，没有脚本解析其 stdout。`decodeGate` 只解析 PR 运行里 `ci/required` 作业的日志（main-evidence.mjs:162-172），而 ci/required 不调用 ci-summary（ci.yml:324-371 无该步骤），不受影响；即使 `HIMAWARI_GATE_BEGIN` 出现在检查作业日志里，也带 `| ` 前缀，且 decodeGate 要求 `begins.length === 1` 且行首精确匹配（gate-log.mjs:30-32），冒充不成立。

**补充回答作者问的 3/4/5**：密钥方面，reports/ 下非 artifact 文本经 `redactReport` 遮盖（publish.mjs:98），artifact 原样复制但发布前过密钥扫描（见上面第 1 条问题）；`textTail` 再做一次通用遮盖加私钥整份不显示（ci-summary.mjs:72-73）；result.json 读不出按失败显示是 fail-open（多显示、不漏），且 publish 成功时必然写出 result.json，触发场景罕见——合适。`\r` 在 `textTail:75` 已归一、控制字符在 :77 替换；U+2028/U+2029 不替换也不 split，但在原始日志里仍属同一行且行首有 `| `，runner 工作流命令只认行首，不构成命令注入。64 KiB 上限是诊断和命令日志各一段独立限额（ci-summary.mjs:168-172，每次 renderSummary 各自 ≤64 KiB），合计约 128 KiB/作业，行宽 ≤503 字符，日志规模可接受；多 `.log` 按路径字典序排、放不下时加计数 footer 后 break（ci-summary.mjs:115-118），截断与计数正确。main.yml 两个作业打印摘要到自己的日志，discover 不读这些日志，不受影响。
