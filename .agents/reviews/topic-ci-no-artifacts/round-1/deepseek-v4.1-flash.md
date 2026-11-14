## 一、方案依赖的前提

### 已核实（读代码或一手来源）

1. **GitHub Free 的 Actions 产物额度只有 500 MB，且与 Packages 共享；额度用完后没有付款方式就会被拦。**
   来源：<https://docs.github.com/en/billing/concepts/product-billing/github-actions>
   原话：`GitHub Free | 500 MB`、`Actions artifacts and GitHub Packages storage share the same pooled allowance.`、`If your account does not have a valid payment method on file, usage is blocked once you use up your quota.`
   同一页还说删除产物只降低“当前存储”，已经累计的用量不会清零；这解释了为什么 4.2 GB 删除约 9 小时后仍会报配额被拦。

2. **日志和作业摘要不算进“产物存储额度”。**
   来源：同上。
   原话：`If you run a workflow that generates many log files and a long job summary, these files do not count towards the repository owner's artifact storage allowance.`
   注意：2026-08-27 的 GitHub Changelog 另有一句 `Artifacts and logs count toward your billable GitHub Actions storage.`（<https://github.blog/changelog/2026-08-27-actions-retention-will-cover-checks-workflow-runs-and-statuses/>）。两份一手材料有冲突；见“未核实”第 1 条。

3. **作业摘要会直接显示在运行摘要页，单步上限 1 MiB。**
   来源：<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands>
   原话：`Job summaries ... are shown on the workflow run summary page ... someone viewing the result of a workflow run doesn't need to go into the logs`、`each step is restricted to a maximum size of 1MiB`。

4. **作业日志和单步日志可以用 REST API 取，读权限即可。**
   来源：<https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28>
   原话：`Gets a redirect URL to download a plain text file of logs for a workflow job.`、`Anyone with read access to the repository can use this endpoint.`、另有 `Download step logs for a workflow run job` 端点。

5. **当前所有产物上传/下载点。**
   `ci.yml:66-73,114-121,167-174,245-252,298-305,346-353` 是六个检查作业的诊断上传；`ci.yml:399-406` 是 `ci/required` 的 `gate-` 上传。
   `main.yml:36-45` 下载 PR 的 gate 产物；`main.yml:52-60` 上传 `main-evidence-`；`main.yml:85-90` 再用 `artifact-ids` 下载；`main.yml:95-102` 上传 `main-confirmation-`。
   `quality.yml:48-63,86-101,130-145,168-183,206-221,254-269` 是各质量作业上传；`quality.yml:291-315` 的 `handoff` 下载 `report-*` 和 `gate-*` 后上传 `handoff-`。

6. **`check-policy.mjs` 现在明确允许 `ci.yml` 上传诊断/gate，只禁止下载。**
   `scripts/ci/check-policy.mjs:502-513`：下载一律拒绝；上传只要求路径是 `.ci-output/gate/` 或 `.ci-output/public/diagnostics/` 且保留 1 天。`scripts/ci/check-policy.mjs:546-552` 还要求 `required` 必须有一个 gate 上传步骤。
   `test/tooling/policy.test.mjs:668-694` 现在的反向用例是“接受 1 天诊断上传和 gate 上传”，必须一起改掉。

7. **main 的轻量确认现在完全依赖 gate 产物。**
   `scripts/ci/main-evidence.mjs:111-129` 用 GitHub API 找 `gate-<runId>-<attempt>` 产物；`scripts/ci/main-evidence.mjs:197-235` 从 `.ci-output/main-evidence/gate` 读 `context.json` 和 `summary.json`。`scripts/ci/main-workflow.mjs:99-116` 把 `actions/download-artifact` 的参数写死进校验。

8. **共享目录是短命的，不适合当长期证据库。**
   `scripts/operations/ci-runner/runners.sh:5-7`：`RUNNER_SHARE_ROOT=/srv/gh-runner-share`、`RUNNER_SHARE_KEEP_MINUTES=360`。
   `scripts/operations/ci-runner/clean-old.sh:24-26`：共享目录下面超过 360 分钟的条目全部删掉。
   `docs/runbooks/ci-vps-runner-runbook.md:50` 也写明“每轮运行一个子目录，汇总作业结束就删”。
   因此如果 gate 放在共享目录，必须新增长期子目录、改清理脚本和权限；这会让方案多出一套需要维护的存储。

9. **`ci/required` 的入口检查和 gate 上传条件已经固定。**
   `ci.yml:371-379` 先判草稿/取消；`ci.yml:399-406` 的 gate 上传和 `ci.yml:407-409` 的删除都带 `always() && steps.entry.outcome == 'success'`。
   `scripts/ci/check-policy.mjs:36-38` 定义 `REQUIRED_AFTER_ENTRY`；ADR 0241 决定第 2 条（`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:54`）写明入口失败后不删除、由每小时清理兜底。

10. **main 已经会拒绝“合并提交改动了 CI 校验代码”的情况。**
    `scripts/ci/main-evidence.mjs:57-71`：合并提交必须是双父提交，且 `.github`、`ci`、`scripts/ci` 在 `before..after` 之间没有差异，否则 `MAIN_VALIDATION_CHANGED`。这保证 main 轻量路径使用的 `ci/policy.json`、`ci/toolchain-lock.json` 和 CI 脚本就是 PR 运行时那套，没有被 PR 偷偷改掉。

11. **`quality.yml` 的 handoff 现在已经是死路径。**
    `quality.yml:296-307` 下载 `report-<runId>-<attempt>-*` 和 `gate-<runId>-<attempt>`，但 ADR 0238 之后 `ci.yml` 已经不再上传任何 `report-*`（`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:58-65`）；runbook `docs/runbooks/ci-vps-runner-runbook.md:39` 也写明 quality 停用。所以删掉 handoff 不是功能回退。

12. **改 `docs/` 必须走文档治理；新 ADR 用 0242。**
    `.agents/instructions/document-governance.md:18` 要求新 ADR 接在现有最大编号后；`:28-29` 列出会拦提交的 `docs/` 检查；`:55` 要求行为/操作变化在同一提交更新受影响文档。本次需要新 ADR 0242，并更新 Runbook、CI 规格/计划里的旧描述。

13. **提示前缀规则只管模型请求，本次改动不碰模型请求装配。**
    `.claude/rules/prompt-prefix.md:27-29`：固定在前、会变的在后，每轮会变的值只放最后一条用户消息；`:35`：已发内容只能末尾追加；`:51`：同样内容必须序列化成同样字节。
    本次只改 `.github/workflows`、`scripts/ci`、`test`、`docs`，不碰 `packages/prompt-catalog`、`runtime-pi`、系统提示、工具定义、历史或遮盖。

### 推断或未核实

1. **“日志不计入计费存储”与 2026-08-27 Changelog 的“logs count toward billable storage”冲突，未核实哪一个适用于当前账号。**
   建议上线前在 GitHub 账单页核对一次；即使按较严的解释，gate 只是追加到本来就会产生的 `ci/required` 日志里几 KB，不新增产物对象，也不会被产物上传的配额拦截。但“绝对不计费”不能只凭计费页一句话断言。

2. **GitHub 作业/步骤日志是否长期稳定地按官方 schema 返回、默认保留多久，未在真实 API 上验证。**
   主证据方案只要求“PR 运行结束后 24 小时内可读”；如果读不到就退完整 CI，不假装轻量通过。

3. **矩阵作业的显示名是否为稳定的 `build / linux-x64` 这种格式，未在真实 run 上核实。**
   所以主验证链不把显示名当唯一证据：只固定用 `ci/required` 这个由 `check-policy.mjs:441-445` 强制的工作流作业名；其他检查是否齐全由 gate 的 `summary.expected/observed` 和 GitHub run 的 `conclusion=success` 共同证明。

4. **二进制诊断（截图、Playwright trace）无法只靠日志/摘要让人直接查看，这是本方案的真实缺口。** 见“需要人拍板”。

---

## 二、推荐方案：把 gate 放进 `ci/required` 的步骤日志和作业摘要，不新增 CI 服务器持久目录

### 总体思路

1. **所有工作流删除 `actions/upload-artifact` 和 `actions/download-artifact`。**
2. **PR 的 gate 结论不再上传产物，而是由 `ci/required` 的一个固定步骤写成：**
   - `$GITHUB_STEP_SUMMARY`：给人看的 Markdown；
   - 标准输出：带标记、可机读的 gate 载荷，进入该步骤日志。
3. **main 通过 GitHub REST API 读取这次 PR 运行的 `ci/required` 步骤日志**，解码 gate，再用现有的 `verifyGate` 逻辑核对。
4. **诊断改成“作业摘要 + 步骤日志”**：文本诊断直接进摘要/日志；二进制诊断只列文件名、大小、SHA-256，不再上传 GitHub。
5. **quality.yml 删除上传/下载和 handoff 作业**；每个质量作业只写摘要/日志。

这样不占用共享目录磁盘，不需要新增 `/srv/gh-runner-share/evidence`，也不需要新增 7 天清理规则；gate 的寿命就是 GitHub 的 run/日志保留期，而 main 只接受 24 小时内的 PR 运行。

### 要改的文件（按职责）

| 文件 | 改动 |
| --- | --- |
| `.github/workflows/ci.yml` | 删除六个诊断上传；每个检查作业加“写诊断到作业日志和作业摘要”步骤；`required` 在 `required.mjs` 后加固定步骤 `gate-log.mjs --input .ci-output/gate`，删除 gate 上传；保留 `collect`、`required`、`remove`。 |
| `.github/workflows/main.yml` | 删除 plan 的 artifact 下载/上传；plan 只输出 `mode`；删除 confirm 的 artifact 下载和 `main-confirmation` 上传；confirm 直接调用 `main-confirm.mjs`（它自己重新 discover+verify）；加确认摘要步骤。 |
| `.github/workflows/quality.yml` | 删除所有上传；每个质量作业加摘要步骤；删除 `handoff` 作业和 `ci_run_id` 输入。 |
| `scripts/ci/gate-log.mjs`（新） | 生产者/消费者共用的 gate 编解码：读 `context.json`、`needs.json`、`summary.json`，按键排序序列化，Base64 分块，附带 SHA-256；输出固定标记。也是 CLI，供 `ci/required` 调用。 |
| `scripts/ci/required.mjs` 或 `ci.yml` 的 gate 步骤 | 在 gate 文件写好后调用 `gate-log.mjs`；成功/失败都可写，但 main 只接受 `summary.status === "passed"`。 |
| `scripts/ci/main-evidence.mjs` | `discoverEvidence` 不再查 artifacts；`verify` 改为查 run/attempt 的 jobs、找 `ci/required`、取该作业固定步骤的日志、解码 gate、走现有 `verifyGate`。任何一步失败都返回 `mode: "full"`。 |
| `scripts/ci/main-confirm.mjs` | 如果本地没有 `candidate.json`，先执行 discover；再 verify；后续构建/安全/烟测不变；摘要步骤替代上传。 |
| `scripts/ci/publish-summary.mjs`（新） | 从已发布、已遮盖的 `reports/result.json`、`diagnostics/`、`.ci-output/gate` 或 `.ci-output/main-public` 生成 Markdown；写 `$GITHUB_STEP_SUMMARY` 和标准输出；总量 < 900 KiB；文本诊断内联，二进制只列清单；文件缺失时打印 `CI_SUMMARY_UNAVAILABLE` 但不让检查变红。 |
| `scripts/ci/check-policy.mjs` / `main-workflow.mjs` / `quality-policy.mjs` | 三个工作流统一硬规则：任何 `actions/upload-artifact@` 或 `actions/download-artifact@` 都失败；删除上传路径/保留天的例外；要求新的 gate 日志步骤和摘要步骤；删除 main 的 `artifact-id` 输出与下载参数。 |
| `test/tooling/*` | 更新现有断言并新增反向用例，见“防回归”。 |
| `docs/adr/0242-...md`（新） | 记录：CI 不再使用 GitHub 产物；gate 放步骤日志/摘要；诊断放摘要/日志；main 通过日志证明；quality handoff 删除。`amends` ADR 0238、ADR 0174，并在 0238 frontmatter 的 `amended_by` 加 0242。 |
| `docs/runbooks/ci-vps-runner-runbook.md` | 共享目录仍只用于作业间报告；删除“GitHub 上留 gate-/diagnostic-”的验证说法；说明 gate/诊断改在 GitHub 日志和摘要；清理规则不变（6 小时仍只清共享目录运行目录）。 |
| `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md` 及对应 plan | 把 `docs/.../2026-09-03-github-ci-quality-gates-design.md:129` 的“GitHub 上只留 gate- 和 1 天诊断”改成新事实；plan 里 handoff/export-evidence 的描述标注为已删除或改为手工日志读取。 |

### gate 结论放在哪里、保存多久

- **位置：** `ci/required` 作业中固定名字的步骤（例如 `把汇总结论写到作业日志和作业摘要`）的**步骤日志**，以及同一作业的**作业摘要**。
- **机读格式：** 只用这个步骤日志里的固定标记块，例如：
  - `CI_GATE_V1_BEGIN <runId>-<attempt> <sha256>`
  - 若干行 `CI_GATE_V1_CHUNK <base64>`
  - `CI_GATE_V1_END <sha256>`
  载荷是 `{context, needs, summary}` 的统一序列化；`sha256` 防止截断/篡改；main 只接受完整且摘要匹配的块。
- **保存多久：** 不额外保存；跟随该 workflow run 的日志/摘要保留期。main 只接受 `updated_at` 在 24 小时内的 PR 运行（`main-evidence.mjs:107-109`），所以 24 小时足够。若仓库把日志保留期设得比 24 小时还短，轻量路径会自动退完整 CI，不会误判通过。
- **不占共享目录磁盘。** 共享目录仍然只放每轮报告，`remove` 后 6 小时兜底清理不变。

### main 确认怎么证明（等可信度）

`main/evidence` 的轻量路径按以下顺序验证；任何一步失败都返回 `full`，由 `main/full` 重跑完整 CI：

1. **推送身份：** `pushIdentity` 要求这是 main 的单 merge 提交，双父提交为 `before` 和 PR head，且 `.github`、`ci`、`scripts/ci` 在 `before..after` 没有变化（`main-evidence.mjs:57-71`）。
2. **PR/运行身份：** 找到唯一一个已合并、`merge_commit_sha === after`、`head.sha === history.head` 的 PR；再找到该 head 在 24 小时内、事件为 `pull_request`、路径为 `.github/workflows/ci.yml`、`conclusion === success` 的运行，不查任何 artifact（替换 `main-evidence.mjs:111-129`）。
3. **作业身份：** 对该 run/attempt 调用 GitHub “List jobs for a workflow run attempt”，要求存在 `name === "ci/required"`、`run_attempt` 等于候选 attempt、`conclusion === "success"` 的作业。可选地再要求 policy 里每个活动成员对应的作业都成功；若显示名变化导致对不上，直接退完整 CI，而不是放宽。
4. **取 gate：** 在该 `ci/required` 作业的 steps 里找固定名字的 gate 步骤，用 “Download step logs for a workflow run job” 下载该步骤日志，解码 `CI_GATE_V1_*`，校验块完整、只有一个完整块、SHA-256 匹配。
5. **gate 内容：** 复用现有 `verifyGate`：`context.repository`、`event === "pull_request"`、`runId`、`attempt`、`baseSha === identity.before`、`headSha === identity.head`、`testedSha`、`policySha256`、`toolchainSha256`；`summary.status === "passed"`、`expected/observed` 与 main 当前 policy 完全一致、无 `missing`/`failures`、每项 `status === "passed"`；`testedCommit.tree.sha === identity.tree`、parents 为 `[before, head]`。
6. **实际 main 提交确认：** 现有 `main-confirm.mjs` 在 main 提交上重跑 build、security 和安装服务烟测，结果写 `summary.json`。这一步不变，只是输出从 artifact 改成作业摘要/日志。

这比现在“下载一个 gate 产物”更直接：gate 来自该 run 自己的 `ci/required` 步骤日志，天然绑定 runId/attempt；本地共享目录不可写、不需要额外摘要传参。

### 诊断怎么给人看

- 每个检查作业在 `publish.mjs` 成功后运行 `publish-summary.mjs --mode check`：
  - 作业摘要：状态、checkId/matrix、计数、失败原因、项目结果；
  - 文本诊断：按文件名排序，内联到摘要和标准输出，受 1 MiB 摘要上限保护；
  - 二进制诊断（png/jpg/webp/zip）：只列文件名、大小、SHA-256，并写 `CI_BINARY_DIAGNOSTIC_NOT_PUBLISHED`。
- `ci/required` 的 gate 步骤写人类可读的 Markdown 摘要：run/attempt、testedSha/baseSha/headSha、policy/toolchain 摘要、expected/observed、失败项。
- `main/confirmation` 写 `summary.json`/`failure.json` 的摘要，不再上传报告。
- 人和代理都能在 GitHub 的 run 页面看作业摘要，或用 `actions:read` 调步骤日志；**不需要登录 CI 服务器**。
- **限制：** 截图和 trace 不能在 GitHub 上直接查看。如果 Andy 需要看截图，只能：接受文本诊断、或让 Andy 在作业结束前 SSH 取、或在 CI VPS 上新增一个只读 HTTP 服务（不推荐，增加攻击面）。这是需要拍板的取舍。

### 防回归

1. **硬规则：**
   - `check-policy.mjs` 对 `ci.yml` 每个 job 的所有 step：`uses` 匹配 `^actions/(upload|download)-artifact@` 就抛错；不再有“只允许诊断/gate 路径”的例外。
   - `main-workflow.mjs`：`plan` 只能有 discover/verify，不能有任何 artifact action；`plan.outputs` 只有 `mode`；`confirm` 不能下载 artifact。
   - `quality-policy.mjs`：所有质量作业和 handoff（若保留）都不能有 artifact action；推荐直接删 handoff。
   - 另加一个独立的 `test/tooling` 用例：解析三个 workflow YAML，扫描全部 step，出现 `actions/upload-artifact` 或 `actions/download-artifact` 即失败，不依赖三个 validator 的覆盖。
2. **反向用例必须真的失败：**
   - `test/tooling/policy.test.mjs`：给 `static`/`required` 加任一 artifact upload 或 download，`validateWorkflow` 必须抛错；删除 `required` 的 gate 日志步骤必须抛错；把 gate 日志步骤改名/改条件/改命令必须抛错。
   - `test/tooling/ci-optimization.test.mjs`：把现有的“artifact 只保存 1 天”改成“三个工作流完全没有 artifact action”；在 `main.yml`/`quality.yml` 注入 upload/download 必须抛错；删除 `main-confirm` 调用或改 mode 条件必须抛错。
   - `test/tooling/main-evidence.test.mjs`：模拟 jobs API、步骤日志和 gate 载荷；缺 `ci/required`、`ci/required` 非 success、步骤日志缺失、标记缺失、块截断、SHA-256 不匹配、gate context 任一字段不符、summary 有失败项——每种都必须返回 `mode: "full"`，不能返回 light。
   - 新增 `test/tooling/gate-log.test.mjs`：编码/解码 roundtrip；同内容两次编码字节相同；篡改任一字节、少一个 END、重复 BEGIN、块乱序都失败。
   - 新增 `test/tooling/publish-summary.test.mjs`：文本诊断内联、二进制只列清单、超过 900 KiB 截断、含 sentinel 的秘密被遮盖、文件缺失时退出 0 并打印 `CI_SUMMARY_UNAVAILABLE`。
   - `test/tooling/quality-policy.test.mjs`：把原来的 upload 反向用例改为“任何 upload/download 都失败”；`handoff`/`ci_run_id` 已删除后，重新加回必须失败。
   - `test/tooling/gate-lifecycle.test.mjs:461-482` 的“每个 public upload 都要 publish 成功”改成“三个工作流没有任何 public upload”。

3. **运行入口：** 以上都放在 `npm run check:ci-policy` 或 `tooling` 项目里；`ci.yml` 的 `policy` 作业已经在跑 `--check policy`，所以新增回归会被 PR 的 `ci/required` 拦住。

---

## 三、考虑过但不选的做法

1. **把 gate 放到 `/srv/gh-runner-share/evidence/<runId>-<attempt>/`，长期保留 7 天。**
   可行，但要在 `run-share.mjs` 新增 `evidence-put/get`、新增 evidence 命名/摘要校验、改 `clean-old.sh` 跳过 evidence 并单独按 7 天清理、改 Runbook 和权限说明。它能离线保留 gate，但共享目录本身对 Andy/代理不可见，且任何同 runner 的任务都能写，反而不如 GitHub 的步骤日志绑定得紧。放弃。

2. **用 GitHub Actions cache 存 gate。**
   cache 有单独的 10 GB 额度，但仍然是 GitHub 托管存储、可被驱逐、需要 `actions/cache`，且 ADR 0174 已经决定不用 cache。放弃。

3. **继续保留 gate/诊断产物，只缩短保留期或只保留 gate。**
   额度被拦时连几 KB 的 gate 也传不上去；目标明确要求完全不用产物。放弃。

4. **把 gate 写进 git 分支/commit、PR 评论、check run 或 repository variable。**
   都需要 `contents: write` 或 `checks: write`，违背只读权限；还会污染仓库或依赖写 token。放弃。

5. **main 直接看 `ci/required` 的整个 job 日志。**
   可行，但日志大、解析慢。改为看固定步骤的 step log，范围小、格式固定；`main-evidence` 只认这个步骤名。若步骤名变化则退完整 CI。

6. **保留 quality 的 handoff，改成读共享目录。**
   quality 现在跑在 `ubuntu-24.04` GitHub 托管 runner，读不到 `/srv/gh-runner-share`；而 `ci/required` 结束就删报告，handoff 需要的历史报告也不在。要保留就得把 quality 搬到 CI VPS 并保留报告，成本和风险都大。放弃 handoff。

7. **为二进制诊断在 CI VPS 上开只读 HTTP 端点。**
   能让截图在浏览器里看，但新增公网服务、认证和攻击面，且违反“不另租机器/不增加服务”的简洁目标。除非 Andy 明确要求，否则不选。

---

## 四、风险和反例

- **日志不是为机读设计的存储。** GitHub 可能调整日志格式、步骤日志 API 或保留策略；一旦解析失败，main 退完整 CI，不能误判轻量通过。反向用例会覆盖截断、缺标记、摘要不符。
- **日志保留期可能短于 24 小时。** 若仓库把“artifact and log retention”设得很短，轻量路径会频繁退完整 CI；需要接受“轻量是优化，不是保证”。
- **日志计费口径有冲突。** 见“未核实”第 1 条。即使按较严口径，gate 只是往本来就会产生的 `ci/required` 日志追加几 KB，不新增产物上传。
- **二进制诊断不可见。** 这是本方案最大的功能取舍；文本日志/JSON 能定位大多数失败，但截图和 trace 需要 SSH 或另建服务。
- **`ci/required` 步骤名/作业名变化。** 硬规则会拦住改名；如果 GitHub 侧显示名变化，main 退完整 CI。不会静默通过。
- **gate 载荷含失败原因时可能带敏感文本。** `gate-log.mjs` 在写日志前用现有 `redactReport`/`redactText` 规则遮盖；main 只接受 passed gate（`failures`/`reasons` 为空），进一步降低风险。
- **quality handoff 删除。** 它现在依赖的 `report-*` 已经不存在，删除不是功能回退；但如果有外部流程依赖 `handoff-` 产物，需要先确认。仓库内没有看到其他消费者，仍需用 `grep` 确认一次。
- **main confirm 重新 discover 可能选到另一个同样有效的 run。** 这不影响可信度，因为每个候选都必须通过同一套 base/head/tree/policy/toolchain/gate 校验；但如果要求“plan 和 confirm 必须用同一 run”，可以把 plan 的 `run_id`/`attempt` 作为 job output 传给 confirm，代价是多两个小值。
- **`retentionDays` 变成死配置。** 见“需要拍板”第 4 条。

---

## 五、需要人拍板的取舍

1. **机器可读 gate 用 GitHub 步骤日志，还是放 CI 服务器持久目录？**
   推荐前者：不改共享目录、不加清理/权限、gate 天然绑定 run。代价是依赖 GitHub 日志 API 和保留期。
2. **二进制诊断怎么办？**
   推荐接受“文本诊断 + 文件清单/摘要”，截图/trace 不上 GitHub；如果 Andy 要求必须在线看截图，需要另建只读服务或破例保留产物，二者都与当前目标有冲突。
3. **quality 的 `handoff` 是否直接删除？**
   推荐删除；它依赖的 `report-*` 已经不存在。若未来要恢复 CI 证据导出，应另出方案，从步骤日志/作业摘要和共享目录取，而不是 GitHub 产物。
4. **`ci/policy.json` 和 `ci/quality-policy.json` 的 `retentionDays` 怎么处理？**
   推荐：`ci/policy.json` 的字段先作为旧基线迁移兼容保留（`upgradeArtifactRetention` 仍读它），但新 ADR 写明它不再决定任何上传；`quality-policy` 的字段若删除 handoff 就没有工作流消费者，建议一并删除 schema/JSON 并更新测试，或保留但明确只用于手工导出。需要 Andy 选“清理干净”还是“最小改动”。
5. **`main/confirmation` 重新验证失败时，是否自动降级跑完整 CI？**
   推荐保持“红”，让问题暴露；如果希望更强可用性，可以把 `full` 改为同时依赖 `confirm`，`confirm` 失败也触发完整 CI。代价是 main 运行时间和复杂度增加。

---

## 六、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。**
本次改动只在 CI 工作流、CI 脚本、测试和文档；没有修改系统提示、工具定义、历史消息、资料块、遮盖规则或 `packages/prompt-catalog`。发给模型的内容仍然遵守 `.claude/rules/prompt-prefix.md:27-29`：固定内容在前，会变的内容只在最后一条用户消息；`:35`：已发内容只在末尾追加；`:51`：同样内容序列化成同样字节。
新加的 `runId`、`attempt`、`testedSha`、`baseSha`、gate 摘要、日志标记只出现在 GitHub Actions 日志/作业摘要里，不进入任何模型请求。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会（模型请求侧）。**
没有模型可见文本被改动。CI gate 的序列化采用固定键顺序、固定分块和 Base64，不含当前时间、随机数或无序集合；同一份 `context/needs/summary` 每次编码字节相同。这只影响 CI 日志，不影响模型请求。模型侧的确定性仍由现有 `npm run check:prompt-prefix` 反向用例守护（`.claude/rules/prompt-prefix.md:74`）。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且必须覆盖“实际注入会失败”：

- `npm run check:ci-policy` 中的 `validateWorkflow`：任一 `actions/upload-artifact`/`download-artifact` 都抛错；缺 gate 日志步骤、步骤名/条件/命令不对都抛错。
- `validateMainWorkflow`：plan 不能有 artifact action，输出只能是 `mode`；confirm 不能下载 artifact；改回 `artifact-id`/`artifact-ids` 必须失败。
- `validateQualityWorkflow`：任一 upload/download 都失败；`handoff`/`ci_run_id` 重新出现必须失败。
- `test/tooling/policy.test.mjs`、`ci-optimization.test.mjs`、`quality-policy.test.mjs`：对真实 workflow 文本做注入式反向用例，断言 `toThrow`。
- `test/tooling/main-evidence.test.mjs`：缺/坏 gate 步骤日志、缺 `ci/required`、非 success、SHA 不符、summary 不完整，全部必须返回 `mode: "full"`，不能 light。
- 新增 `gate-log` 和 `publish-summary` 的 roundtrip/篡改/截断/秘密遮盖用例。
- 这些用例在实现时必须先在旧行为上跑出失败、再修到通过；不能只写“正向能过”。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下（“产生 → 使用 → 两端校验”）：

| 值 | 产生 | 使用 | 两端校验/风险 |
| --- | --- | --- | --- |
| `CI_GATE_V1_BEGIN/CHUNK/END` 标记 | `scripts/ci/gate-log.mjs` | `scripts/ci/main-evidence.mjs` 解码 | 同一模块导出常量；测试覆盖缺 END、重复 BEGIN、块乱序、截断。 |
| gate 载荷 `{context,needs,summary}` | `required.mjs` 写文件，`gate-log.mjs` 编码 | main 解码后 `verifyGate` | `Context` schema、`aggregate` 的 summary 形状、`main-evidence.test.mjs` 的负例。 |
| 载荷 SHA-256 | `gate-log.mjs` 编码时算 | main 解码时重算 | 只接受完全相等；测试篡改一字节必须失败。 |
| `runId`/`attempt` | `context.mjs:134-145`、GitHub 环境变量 | `discoverEvidence`、`verifyGate`、jobs API | `Context` schema 要求 `runId` 是正整数字符串、`attempt >= 1`；`verifyGate` 要求与候选 run/attempt 相等；jobs API 要求 `run_attempt` 相等。 |
| `testedSha`/`baseSha`/`headSha`/`tree` | `createContext`、GitHub commit API/git | `verifyGate`、`pushIdentity` | 全部要求 40 位 SHA；`baseSha === identity.before`、`headSha === identity.head`、`testedCommit.tree === identity.tree`、parents 为 `[before,head]`。 |
| `policySha256`/`toolchainSha256` | `createContext` | main 读当前 `ci/policy.json`、`ci/toolchain-lock.json` 重算 | `verifyGate` 要求完全相等；`MAIN_VALIDATION_CHANGED` 保证 main 的 CI 配置没被合并提交改过。 |
| `summary.status/expected/observed/checks` | `aggregate.mjs` | `verifyGate` | 要求 `passed`、`missing=[]`、`failures=[]`、expected/observed 排序后完全一致、每个 check `passed` 且 reasons 为空。 |
| `mode`（`light`/`full`） | `main-evidence.mjs` | `main.yml` 的 `full`/`confirm` 条件、`validateMainWorkflow` | `validateMainWorkflow` 要求 `plan.outputs.mode` 来自 `steps.verify.outputs.mode`；测试覆盖非 light 走 full。 |
| `ci/required` 作业名 | `ci.yml:354-355` | `main-evidence.mjs` 找作业；`check-policy.mjs:441-445` 强制 | 任一侧改名会让 main 退 full，不会误判；硬规则要求 `name === "ci/required"`。 |
| gate 步骤名 | `ci.yml` 新步骤 | main 在 jobs API 的 steps 里按名字找 | `validateWorkflow` 要求精确步骤名；改名则 main 找不到，退 full。 |
| `artifact-id`/`artifact-ids`/`artifact_id` | 当前 plan/confirm 使用 | 本次全部删除 | 旧值不再产生；必须同步删除 `main-workflow.mjs:66-69,99-116` 和 `main-evidence.mjs:111-129` 的读取；测试里旧的 artifact fixture 全部改掉。 |
| `ci_run_id` 输入 | `quality.yml` 现在产生 | handoff 使用 | 删除 handoff 后两端都删除；`quality-policy.mjs` 的 `expectedEvents` 和测试同步改；若保留输入却无消费者，属于死值，应删。 |
| `retentionDays.reports`/`diagnostics` | `ci/policy.json`、`ci/quality-policy.json` | 原 `check-policy`/`quality-policy` 上传规则；`export-evidence` 的过期计算 | 上传规则删除后，`ci/policy` 字段只剩 `upgradeArtifactRetention` 迁移兼容；`quality` 字段只剩 `export-evidence` 手工路径。若删 handoff/export，建议连字段和 schema 一起删；若保留，ADR 要写明“不再代表 GitHub 产物保留期”。 |
| `$GITHUB_STEP_SUMMARY` 内容 | `publish-summary.mjs`、`gate-log.mjs` | GitHub run 摘要页、人和代理 | 单步上限 1 MiB（官方文档）；脚本限制在 900 KiB，超出写 `CI_SUMMARY_TRUNCATED`；文本先经过现有遮盖规则。 |
| `RUNNER_SHARE_KEEP_MINUTES=360` / `clean-old.sh` | `runners.sh:7`、`clean-old.sh:24-26` | 共享目录清理 | 本方案不新增 evidence 子目录，所以这两个值不改；反向风险是以后有人把 gate 放共享目录却忘了改清理，需在 ADR 0242 写明“不要再往共享目录加长期证据”。 |
| quality 的 `handoff-*` 产物名 | 当前 `quality.yml:310-314` | 外部手工流程（如果有） | 本方案删除；删除前需用仓库范围搜索确认没有仓库内消费者。仓库内没有看到；外部消费者未核实。 |

**结论：** 新值都有明确的产生者和消费者；旧的 `artifact_id`、`artifact-ids`、`ci_run_id`、quality handoff 相关值必须一起删干净，不能只删工作流一侧。`retentionDays` 是唯一需要拍板的“保留但降级”值。
