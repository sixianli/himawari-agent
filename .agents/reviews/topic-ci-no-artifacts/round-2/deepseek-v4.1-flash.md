## 结论

这个方案的方向（继续把大文件留在 CI 服务器、减少 GitHub 产物）是对的，但**当前写法有几个会直接让 CI 变红或让证据失效的问题**：`--from .ci-output/public` 会破坏 build 消费者；删 `retentionDays` 会破坏 base 策略迁移；新增 gate 目录的安装顺序和 service 配置没有闭环；`remove` 会立刻删掉所谓“保留 6 小时”的诊断。更稳妥的做法是**保留几 KB 的 gate 产物，只把诊断移出 GitHub**。

---

## 证实的

### 1. [高] `--from .ci-output/public` 会让 browser/coverage 取不到 build 的 result.json

**问题**：`publish.mjs` 把结果写在 `reports/result.json`，而 browser/coverage 把 build 取到 `.ci-output/input` 后直接读 `.ci-output/input/result.json`。改成 put 整个 `.ci-output/public` 后，实际路径会变成 `.ci-output/input/reports/result.json`。

**证据**：
- `scripts/ci/publish.mjs:81-84` 创建 `reports/`、`diagnostics/`；`:122-123` 写 `reports/result.json`。
- `.github/workflows/ci.yml:230`、`:285` 把 build 取到 `.ci-output/input`；`:234`、`:287` 读 `--input .ci-output/input/result.json`。
- 方案第 3 条说“六个检查作业 put 改为 `--from .ci-output/public`”。

**建议**：build 仍用 `--from .ci-output/public/reports`；诊断单独 put（例如 `<check>-diagnostics`），或明确改消费者为 `.ci-output/input/reports/result.json` 并补测试。不要只改生产端不改消费端。

### 2. [高] 删除 `retentionDays` 和 `upgradeArtifactRetention` 会让旧 base 上的策略校验失败

**问题**：`resolvePolicySource` 读的是 **base commit** 上的 `ci/policy.json`，并在校验前做迁移。新 schema 若删除 `retentionDays`（且 `additionalProperties: false`），这个 PR 自己的 base 仍然带该字段，第一次校验就会失败。

**证据**：
- `ci/policy.schema.json:3-12` 把 `retentionDays` 列为 required，`:183-195` 定义它，`:3` 是 `additionalProperties: false`。
- `scripts/ci/check-policy.mjs:188-197` 是 `upgradeArtifactRetention`，`:1185-1193` 在 `resolvePolicySource` 里调用迁移后再 `validatePolicy`。
- `test/tooling/policy.test.mjs:899-913` 明确测试“base 是 30/7 时升级成 1/1”。

**建议**：保留一次性迁移，把旧字段**删掉**（而不是校验失败），并让 schema 在过渡期继续接受它；或把字段删除放到后续 PR。若删 `export-evidence.mjs` 的 handoff，也要同步删 `export-evidence.mjs:110,161` 对 `quality.retentionDays.reports` 的使用和 `test/tooling/gate-lifecycle.test.mjs` 的用例。

### 3. [高] 新 gate 目录的安装/服务/卸载没有闭环，且顺序会让所有 PR CI 变红

**问题**：方案说“重跑安装脚本（建 gate 目录）”，但当前 `install-runner.sh` 只建共享目录；service 模板也没有 `HIMAWARI_CI_GATE` 和 `ReadWritePaths`。更严重的是，方案 PR 合并后，`ci/required` 的 gate 步骤会因缺目录或未加 `ReadWritePaths` 直接失败，**不是只让 main 退成完整 CI，而是所有 PR 的 `ci/required` 都红**。

**证据**：
- `scripts/operations/ci-runner/install-runner.sh:89-102` 只创建 `RUNNER_SHARE_ROOT`。
- `scripts/operations/ci-runner/gh-runner.service.in:21,36` 只有 `HIMAWARI_CI_SHARE` 和共享目录的 `ReadWritePaths`。
- `scripts/operations/ci-runner/runners.sh:5-7` 只有 share 变量。
- `uninstall-runner.sh:38-40` 只删 share，不删 gate。
- `test/tooling/ci-runner-scripts.test.mjs:780-783` 精确断言当前 `ReadWritePaths` 和 `HIMAWARI_CI_SHARE`。
- 方案“风险”一节说“所有 main 确认退成完整 CI”，与实际代码路径不符。

**建议**：拆成两个 PR：先只改安装脚本/service/卸载/preflight，建好 `/srv/gh-runner-gate` 但 workflow 不依赖它；Andy 执行 `pause-runners.sh` → `install-runner.sh` → `resume-runners.sh` 后，再合并切换 workflow 的 PR。或者更简单：保留 gate 产物。若坚持，必须补 `RUNNER_GATE_ROOT`、`@GATE@`、`Environment`、`ReadWritePaths`、创建/备份/恢复/卸载、`INSTALL_OK`、preflight、runbook 和测试，并把风险描述改对。

### 4. [高] `remove` 会立即删掉诊断，方案“6 小时内可 ssh 取”不成立

**问题**：方案仍在 `ci/required` 最后执行 `run-share.mjs remove`，它删除整个 `<share>/<runId>-<attempt>`，包括第 3 条刚 put 进去的诊断。

**证据**：
- `.github/workflows/ci.yml:407-409` 的 remove 步骤。
- `scripts/ci/run-share.mjs:138-140` `remove` 删整个运行目录。
- 方案第 1 条明确保留 `... → gate → remove`。

**建议**：要么把“保留 6 小时”改成事实（诊断只在作业摘要和日志里），要么让 remove 只删报告/构建、把诊断留到独立目录并明确清理周期和磁盘预算。若保留整个运行目录 6 小时，按每轮约 300 MB、并发多轮估算，16 GiB 下限可能不够。

### 5. [高] 硬规则禁止 upload/download，但 main.yml 仍上传 `main-confirmation-`

**问题**：方案第 5 条要求 `main-workflow` 禁止 `actions/upload-artifact`/`download-artifact`，但 main.yml 末尾仍上传 `main-confirmation-<runId>-<attempt>`；方案只明确删了 gate 上传，没有给 main 确认报告安排替代。

**证据**：
- `.github/workflows/main.yml:95-101` 的 `main-confirmation-` 上传。
- 方案第 5 条“check-policy、main-workflow、quality-policy 三处都禁止……”。

**建议**：为 main.yml 也加摘要步骤，并决定确认报告放共享目录还是只留摘要；或者在 `main-workflow.mjs` 里为 `main-confirmation-` 保留一个有明确理由的窄例外，不要写一条自己马上违反的硬规则。同步改 `main-workflow.mjs:66-70,99-116` 和 `test/tooling/ci-optimization.test.mjs:91-104`。

### 6. [中] gate 放共享盘后，跨运行不可篡改性下降；方案说“和今天同级”不准确

**问题**：现在 gate 是 GitHub 产物，按运行绑定、不可变；放到 `/srv/gh-runner-gate` 后，两个 runner 都在 `gh-ci-share` 组，任何 PR 作业都能读、删、改任意运行目录。ADR 0238 接受的是“同一 runner 上任务互相能改”，并没有接受“另一个 PR 能改本轮 gate”。7 天保留把窗口进一步放大。

**证据**：
- ADR 0238:91 明确说的是同一 runner 上的任务威胁模型。
- `gh-runner.service.in:12,36` 两个 runner 都拿到 `gh-ci-share` 和共享目录写权限。
- `run-share.mjs:72-90` 的“只写一次”只防同名覆盖，不防先 `rm -rf` 再写。

**影响**：造成“假绿”需要目标 PR 的 ci 运行本身在 GitHub API 上也是成功，难度较高；但**删除/替换/DoS**是确认可行的。方案应把这一点写成“跨运行可篡改”，不要写成“同级”。

**建议**：保留 gate 作为几 KB 的 GitHub 产物（成本可忽略），只移走诊断；若必须上盘，把 gate 保留期缩到 24–48 小时，并明确接受跨运行篡改，或增加独立用户/独立写入路径（成本更高）。

### 7. [中] 读取 gate 的路径没有定义清楚，不能复用 `runName(env)`

**问题**：`run-share.mjs` 的 `runName(env)` 取当前 `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`。main 的 plan 作业里，这是 **main 运行号**，不是被确认的 PR 运行号。要读 PR gate，必须用 `discover` 返回的 `candidate.runId`/`attempt`。方案没有说明这一点，也没有给 gate 读命令和布局。

**证据**：
- `scripts/ci/run-share.mjs:34-38` `runName` 来自当前 env。
- `scripts/ci/main-evidence.mjs:123-129` discover 返回 `runId`/`attempt`；`:213-215` verify 读 `.ci-output/main-evidence/gate/context.json`。
- 方案说“写入 `<runId>-<attempt>/`（沿用 put）”但 put 的实际布局是 `<root>/<run>/<name>`，两者不一致。

**建议**：定义明确的 gate 布局和读取命令（例如 `run-share.mjs gate-get --run <runId>-<attempt> --digest … --to .ci-output/main-evidence/gate`），读取时用 `candidate` 的值而不是当前 env，并核对摘要；补测试。

### 8. [中] plan→confirm 的 main-evidence 没有 remove，靠 6 小时清理

**问题**：plan 把 `main-evidence` put 到共享目录，confirm get；但没有任何 remove。方案没有提这一点。

**证据**：ADR 0238 的 remove 只在 `ci/required`；`main.yml` 没有 remove 步骤。`clean-old.sh:24-26` 只在 6 小时后清理。

**建议**：在 confirm 末尾加 `if: always()` 的 remove，或在 plan/confirm 之外加清理；若 plan 失败走 full，也要保证最终清理或接受最多 6 小时残留。

### 9. [中] 自动检查不足，且部分现有反向用例会被“删掉”而不是“反转”

**问题**：方案只说“每条配一个反向用例”和“ci-optimization.test 改为三个工作流没有任何产物 action”，但没有覆盖新代码；同时现有反向用例如果不改写，会失去意义。

**证据**：
- `test/tooling/main-evidence.test.mjs:164-221` 仍用 artifacts API 数据；新 discover 读磁盘后这些用例不再测试真实路径。
- `test/tooling/run-share.test.mjs` 没有 gate 命令/清理/布局用例。
- `test/tooling/quality-policy.test.mjs:248-276` 用固定 step 下标测 upload/handoff，删 handoff 后必须重写。
- `test/tooling/policy.test.mjs:645-694` 测“必须有一个 gate 上传/不能没有 gate 上传”，改成“禁止上传”后应反转成“重新加回上传必须失败”，不能直接删。
- `test/tooling/ci-optimization.test.mjs:91-104` 现在断言 `uploads.length > 0`，改写后要保留“重新加回 upload 会失败”的反向用例。
- 没有任何 `ci-summary.mjs` 的 64 KiB 截断、二进制、排序、遮盖测试；没有 installer 创建 gate 目录的测试。

**建议**：至少补：gate 目录缺失→main 退 full；gate 内容被改→verify 拒绝；gate 读取用错 runId→失败；`ci-summary` 超 64 KiB 截断、二进制只列元数据、文件排序确定、敏感文本被遮盖；installer/uninstaller 的 gate 创建/删除；workflow 反向加回 upload/download 会失败。用“在旧实现上必须失败”验证反向用例。

### 10. [中] `ci-summary.mjs` 的红action、流式读取和确定性没有写进方案

**问题**：诊断里可能有敏感文本；若一次性 `readFileSync` 大日志会占内存；文件和列表顺序不确定会让摘要字节不稳定。

**证据**：
- `publish.mjs:87-118` 对非二进制诊断走 `redactReport`，但摘要脚本应复用 `redactText`/`redactReport`，不能只依赖 GitHub 的自动 secret masking。
- GitHub 文档：step summary 每步上限 1 MiB，且“Summaries automatically mask any secrets…”（https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands）。方案的 64 KiB 更小，但仍应自己红action。
- `export-evidence.mjs:130` 用 `JSON.stringify(summary)` 比较 gate，说明证据输出需要稳定顺序。

**建议**：流式读文件尾部、按路径排序、跳过符号链接/特殊文件、单文件和总量双上限、UTF-8 边界安全、复用现有 redaction；补测试。

### 11. [中] 计费前提的解读不准确，影响第 7 条的说服力

**问题**：GitHub 计费页明确说日志和作业摘要**不计入产物存储额度**；Changelog 说“Artifacts and logs count toward your billable GitHub Actions storage”。两份材料确实冲突，但方案进一步说“免费账号 500 MB、按整月累计、周期内超了就一直被拦”，这不准确：计费页说删除产物后“Current storage decreases immediately / Future hourly charges stop accumulating”，已发生的 accrued 才留在账单里。降低保留期会在保留窗口后释放当前存储，不是“下一账单周期才开始”。

**证据**：
- 计费页原话：“If you run a workflow that generates many log files and a long job summary, these files do not count towards the repository owner's artifact storage allowance.”（https://docs.github.com/en/billing/concepts/product-billing/github-actions）
- 同一页：“Current storage decreases immediately”“Storage already accrued during the current billing cycle remains in your total”。
- Changelog 原话：“Artifacts and logs count toward your billable GitHub Actions storage.”（https://github.blog/changelog/2026-08-27-actions-retention-will-cover-checks-workflow-runs-and-statuses/）

**建议**：把这段写成“材料冲突，保守按日志也计费处理；实际是否占用 500 MB 产物额度未核实”；保留期 3 天可以作为预防措施，但不要把“下一账单周期”当成确定结论。最好先看当前账单的 storage 构成再决定是否值得为日志改设置。

### 12. [低] ADR 引用错位

**问题**：方案说“ADR 0238 决定 1‘GitHub 上只留 gate 和诊断’”，但 ADR 0238 的决定 1 是共享目录和 run-share；决定 3 才是“GitHub 上只留很小的东西”。

**证据**：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:56-70`；`:64` 是决定 3。

**建议**：改成“决定 3”，并在 ADR 0242 里同时说明决定 1（共享目录）和决定 3（gate/诊断）的修订关系。

---

## 推测 / 未核实

- 跨运行伪造 gate 能否造成“假绿”：需要目标 PR 的 ci 运行在 GitHub API 上也是 success，按现有 `verifyGate` 的 testedCommit/tree/parents 校验，直接伪造代码树很难；但删除/替换/DoS 是确认可行的。**假绿风险是推测，跨运行可篡改是事实。**
- 日志是否真的占用 500 MB artifact 额度：两份一手材料冲突，未在账单上核实。
- `actions/download-artifact` 的 `pattern` 无匹配时是否直接失败：未核实；但 `export-evidence` 缺 reports 会失败。
- “8 条不是密钥例外”和 PR 409 的具体内容：未核实。
- 当前仓库设置里的 artifact/log retention 实际值：未核实。
- 没有运行测试，因此“改后哪些测试会红”是按代码静态推断。

---

## 侧重检查

我重点查了以下路径：

- **错误路径**：`HIMAWARI_CI_GATE` 缺失/目录不存在时，`ci/required` 的 gate 步骤会失败，所有 PR CI 变红，不只是 main 退 full；方案风险描述需改。
- **不合规范/不可信输入**：`resolvePolicySource` 读 base 上的旧策略；删 `retentionDays` 会让旧 base 校验失败。这是“清单里的值能不能通过后端校验”的同类问题（I-73）。
- **安全**：gate 放共享目录后，两个 runner 同组，任意作业可读/删/改任意运行的 gate；与 GitHub 产物的不可变性不同。诊断尾部进 job summary 需要自己红action，不能只靠自动 masking。
- **资源耗尽**：`ci-summary.mjs` 读大诊断必须流式+上限；诊断保留 6 小时与 `remove` 冲突；保留整个运行目录 6 小时可能压到 16 GiB 磁盘下限。
- **不可撤销操作**：`remove` 立即删除诊断；gate 清理按 mtime 删 7 天目录，需限制只删匹配 `<runId>-<attempt>` 的目录、不跟随符号链接、清理失败不应连带 gate 步骤失败。
- **规则/文档/代码一致性**：`check-policy`/`main-workflow`/`quality-policy` 的硬规则与 main.yml 的 `main-confirmation-` 上传冲突；ADR 0238 决定编号引用错；installer/uninstaller/runbook/preflight 没有 gate 目录；`quality.yml` handoff 删除后 `export-evidence` 成为死代码但测试还在跑。

---

## 如果由我来定

1. **保留 gate 作为小的 GitHub 产物**（几 KB、1 天），不要新建 `/srv/gh-runner-gate`。当前 GitHub 产物的大头是诊断和报告；ADR 0238 已经把 300 MB 报告移走，gate 不是成本问题。这样可完全避免安装顺序、跨运行篡改、main-evidence 重写和大量测试改动。
2. **只把诊断移出 GitHub**：六个检查作业仍 put `reports` 供构建/汇总使用；诊断单独 put 到共享目录或独立目录，`ci-summary.mjs` 只读诊断，做红action、排序、流式尾部、64 KiB 上限。
3. **保留 build 的 `reports/result.json` 布局**，不改消费者路径；若坚持 put 整个 `public`，必须同时改 browser/coverage 的 `--input` 并补端到端测试。
4. **不要在同一 PR 删 `retentionDays`**；先加迁移删除字段、保持 schema 过渡兼容，等所有 base 都过了再删。若删 handoff，同时删 `export-evidence.mjs` 及其测试，或保留 quality 的 `retentionDays`。
5. **main.yml 的 `main-confirmation-` 要么保留窄例外，要么改成摘要+共享目录**；不要写“禁止 upload”又留着 upload。
6. **补测试**：gate 缺失→full、gate 篡改→拒绝、summary 截断/红action/二进制、installer/uninstaller、quality 无产物、旧 base 迁移、反向加回 upload/download 失败。
7. **计费叙述改成“材料冲突、未核实”**，保留期 3 天作为预防，不作为唯一依据。
8. **部署顺序**：若最终仍要 gate 目录，先合并安装脚本/service 改动并让 Andy 执行 pause→install→resume，再合并依赖它的 workflow PR；否则第一个 PR 和 main 都会红。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个方案只改 CI 工作流、产物存放和作业摘要，不组装发给模型的内容；系统提示、工具定义、历史消息、遮盖结果都没有改。发给模型的内容仍然只在末尾追加，每轮会变的值仍然只在最后一条消息里——因为这条链路没有被触碰。依据：[.claude/rules/prompt-prefix.md#rules](../../.claude/rules/prompt-prefix.md#rules)。如果以后把 CI 摘要或 gate 内容喂给模型，需要重新按该规则审。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求不会。对 CI 证据要注意：`export-evidence.mjs:130` 用 `JSON.stringify(summary)` 比较 gate，说明 gate/summary 必须顺序稳定；`ci-summary.mjs` 也要排序文件、不要写当前时间/随机值。当前方案没有明确这些，属于需要补的 CI 可复现性要求，不是 KV 缓存问题。原则同样来自规则第 10、11 条（确定性 JSON/列表顺序、遮盖确定）。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
不够。现有测试要改：`main-evidence.test.mjs` 仍用 artifacts API；`run-share.test.mjs` 没有 gate；`quality-policy.test.mjs` 按 step 下标测 handoff/upload；`policy.test.mjs` 的 gate 上传反向用例要反转而不是删除；`ci-optimization.test.mjs` 的 upload 断言要替换成“任何产物 action 都失败”。新增的 gate 读写/清理、`ci-summary`、installer、main-evidence put/get、旧 base 迁移都没有测试。反向用例必须验证“在旧实现上失败”，不能只验证新实现通过。

**4. 每个值的使用方都能接受吗？逐个核对：**
- `HIMAWARI_CI_GATE`：生产方应是 service 模板/安装脚本；消费方是 `run-share.mjs gate` 和 main discover。当前 `install-runner.sh`、`uninstall-runner.sh`、preflight、runbook、`ci-runner-scripts.test.mjs` 都没有它，且 service 需要 `ReadWritePaths`，否则 `ProtectSystem=strict` 下写不进去。
- gate 目录名 `<runId>-<attempt>`：生产方用 PR 运行的 `runName`；消费方必须用 `candidate.runId`/`attempt`，不能用 main 运行的 `GITHUB_RUN_ID`。方案没有定义读命令和布局（`<root>/<run>/<name>` vs `<root>/<runId-attempt>`），两端要统一。
- `main-evidence` 摘要：生产方是 plan 的 put 输出；消费方是 confirm 的 get、`main-workflow.mjs:66-70` 的 `steps.retain.outputs.artifact-id` 断言、`main.yml:22` 的 outputs。都要改成新的 output key。
- `retentionDays`：生产方是 `ci/policy.json`、`ci/quality-policy.json`、schema；消费方是 `check-policy.mjs:188-197`、`export-evidence.mjs:110,161`、`quality-policy.mjs:44,154,161,210`、`policy.test.mjs`、`quality-local.test.mjs`、`runner.test.mjs`。删字段会同时破坏 base 迁移和 export-evidence。
- `ci_run_id`：生产方是 `quality.yml` 的 workflow_dispatch；消费方是 handoff、`quality-policy.mjs:180,205,219`、`quality-policy.test.mjs`。删 handoff 后要一起删输入和测试，否则 quality policy 校验对不上。
- `actions/upload-artifact`/`download-artifact`：生产方是 `ci/toolchain-lock.json`；消费方是 `validateWorkflow`、`validateMainWorkflow`、`validateQualityWorkflow` 和测试 fixture。删 lock 条目前必须确认 main.yml 的 `main-confirmation-` 上传也已处理，否则 `action-lock` 校验会失败。
- `main-confirmation-<runId>-<attempt>`：生产方是 `main.yml:95-101`；消费方是人。方案没有替代出口，和“全部禁止 upload”冲突。
- `--from .ci-output/public`：生产方是 `publish.mjs`（`reports/result.json`）；消费方是 browser/coverage 的 `.ci-output/input/result.json`。两端不匹配，已列为高严重度。
- `ci-summary` 的输入/输出：输入是 `.ci-output/public/diagnostics`，输出是 `$GITHUB_STEP_SUMMARY`；要接受 1 MiB 上限、红action、排序、二进制元数据和流式读取，方案只写了 64 KiB，其他未写。

**未核实**：没有实际运行测试；没有查看 GitHub 仓库当前 retention 设置；没有核实 PR 409 的 8 条例外；没有在真实账单上确认日志是否占 500 MB 产物额度。
