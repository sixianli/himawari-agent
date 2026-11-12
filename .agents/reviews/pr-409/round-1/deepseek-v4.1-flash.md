## 侧重检查

- **错误路径**：草稿、上游 `cancelled`、两个 env 缺失或非 `false` 都在入口 bash 失败；入口失败后检出、装工具、`collect`、`required.mjs`、gate 上传和 `run-share remove` 都不执行（`.github/workflows/ci.yml:372-408`）。
- **不合规范/不可信输入**：入口只用 GitHub 布尔表达式注入 `CI_DRAFT`/`CI_CANCELLED`；`check-policy.mjs` 仍禁止 `run` 里出现 `${{`（`scripts/ci/check-policy.mjs:481-485`）。草稿上不再检出 PR 代码。
- **安全**：仍是只读权限、无 `actions/download-artifact`；草稿上唯一的 `required` 作业在检出前就失败，减少了不可信 PR 代码进入 self-hosted runner 的机会。
- **资源耗尽**：6 个检查作业草稿上全部跳过；入口失败不上传 gate，也不再消耗产物额度。未删除的共享目录有兜底：`RUNNER_SHARE_KEEP_MINUTES=360`（`scripts/operations/ci-runner/runners.sh:7`），`clean-old.sh` 删除共享目录里超过 360 分钟的运行目录（`scripts/operations/ci-runner/clean-old.sh:24-26`），每小时定时器触发（`gh-runner-clean.timer`）。
- **不可撤销操作**：没有新增删除类操作；入口失败时反而**不再**执行 `run-share remove`，残留由 6 小时后的清理处理。
- **规则/文档一致性**：发现 3 处文档与代码或生效决定不一致，见下面第 1–4 条；`tools/document-governance` 在当前稀疏检出中不存在，无法核实它是否会检查 `amends`/`status` 语义。
- **未核实**：没有运行测试，也没有真实 GitHub Actions；`contains(needs.*.result, 'cancelled')` 和 `github.event.pull_request.draft` 的线上取值是按 GitHub 表达式语义和仓库内既有代码推断的。

---

## 结论：读代码证实的

### 1. 严重度：中

**文件:行**：`docs/adr/0176-ci-on-ovh-vps.md:91`、`.agents/instructions/delivery-mode.md:27`、`AGENTS.md:7`、`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:5-7`

**问题**：新的、生效的合并规矩和仍在 `status: active` 的 ADR 0176 直接冲突；ADR 0241 也没有把 0176 列入 `amends`。

**证据**：

- ADR 0176 仍写着：
  > 在 Andy 决定规则集要求 `ci/required` 之前，合并不等 CI 结果。
- 新规则写的是：
  > 合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功……
- ADR 0241 的 frontmatter 是：
  > `supersedes: "docs/adr/0191-draft-pull-requests-run-fast-checks-only.md"`
  > `amends: "docs/adr/0073-fast-delivery-mode.md"`
- 但 ADR 0176 的 `status` 仍是 `active`，`superseded_by` 为空。

**建议**：把 0176 明确列入 ADR 0241 的 `amends`，并改写 0176 第 91 行；或把 0176 标成 `superseded`/`amended` 并指向 0241。否则线程读到 ADR 0176 会得到“合并不等 CI”的相反结论。

---

### 2. 严重度：中

**文件:行**：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:61`、`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:89`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:129`、`.github/workflows/ci.yml:407-409`

**问题**：ADR 0238 和设计说明仍说汇总作业“不论成败都删掉本次运行的目录”，但代码已经改成入口检查失败时不删除。

**证据**：

- ADR 0238：
  > `remove`：汇总作业最后一步，`if: always()`，不论成败都删掉本次运行的目录。
- ADR 0238 后果：
  > 汇总作业结束就删……
- 设计说明第 129 行：
  > ……结束时不论成败删掉本次运行的目录。
- 实际代码：
  ```yaml
  - name: 删除 CI 服务器上本次运行的目录
    if: ${{ always() && steps.entry.outcome == 'success' }}
    run: .ci-output/tools/bin/node scripts/ci/run-share.mjs remove
  ```
- ADR 0241 自己也说入口失败后不删除、靠 6 小时清理。

**建议**：把 ADR 0238 的决定第 1 条和后果、以及设计说明第 129 行改成“入口检查通过后，不论后续成败删除；入口失败则留给每小时清理”。ADR 0241 最好把 0238 标为被它补充/修改。

---

### 3. 严重度：低

**文件:行**：`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:7`、`docs/adr/0073-fast-delivery-mode.md:2-6`

**问题**：ADR 0241 的 `amends` 指向 ADR 0073，但 0073 早已被 ADR 0080 取代，0080 又被 ADR 0133 取代。修改一个已取代的 ADR 没有实际约束力。

**证据**：

- ADR 0241：
  > `amends: "docs/adr/0073-fast-delivery-mode.md"`
- ADR 0073：
  > `status: superseded`
  > `decision_status: superseded`
  > `superseded_by: docs/adr/0080-document-governance-in-fast-mode.md`
- ADR 0080 的 `superseded_by` 指向 `docs/adr/0133-docs-check-removed-from-npm-run-check.md`，而 0133 当前是 `status: active`。

**建议**：把 `amends` 指向当前的快速模式 ADR（0133），或者同时指向 0176 和 0133。`check:adr-numbers` 只检查 ADR 路径和标题编号是否存在（`scripts/check-adr-numbers.mjs:35-95`），不会发现这种语义错误。

---

### 4. 严重度：低

**文件:行**：`docs/adr/0202-keep-three-test-workers-and-no-cpu-pinning.md:70`

**问题**：仍然把“草稿 PR 只跑快检查”当作减少排队的现成办法，但本 PR 已改成草稿 PR 完全不跑检查。

**证据**：

> 加快要靠少跑（草稿 PR 只跑快检查）或缩短最慢的用例……

ADR 0202 的 `status: active`。

**建议**：改成“草稿 PR 不跑 CI（ADR 0241）”，或注明这是历史例子。

---

## 推测 / 未核实

- **“被取消的运行几秒内判失败”是尽力而为，不是保证。** 如果整个 workflow 被取消，`required` 作业本身也可能直接是 `cancelled`，入口 bash 根本不执行，`CI_UPSTREAM_CANCELLED` 不会出现。仓库自己的设计说明也承认这一点（`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:254`：“GitHub 取消整次工作流时该 job 也可能无法执行”），而历史记录里又确实观察到 `always()` 汇总作业在取消后执行并失败（`docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md:367`）。无论哪种情况，`ci/required` 都不是成功，不会误放行；只是错误标记不一定出现。
- **线上 GitHub 表达式值未实测。** `workflow_call` 调用时 `github.event_name` 是调用方的事件（这里是 `push`），这由仓库现有逻辑间接支持：`createContext` 只接受 `pull_request`/`push`/`workflow_dispatch`/`schedule`，若 `workflow_call` 保留成自己的事件名，main 调用完整 CI 早就会以 `CI_EVENT_UNSUPPORTED` 失败（`scripts/ci/context.mjs:90-92`）。但这是从代码推断，不是线上验证。
- **ADR 0241 背景里的运行次数/成功率**（1415 次运行、10 次成功）没有联网核实。
- **仓库文档校验器语义**：当前稀疏检出没有 `tools/document-governance`，无法确认它会不会检查 `amends` 指向已取代 ADR，或检查文档是否过时。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**产品模型请求：不会。** 这个 PR 只改了 `.github/workflows/ci.yml`、`scripts/ci/`、测试和文档，没有改任何产品侧组装系统提示、工具定义、历史或遮盖的代码。发给模型的内容仍然只在末尾追加，这个改动也没有把每轮会变的值放进请求开头。

**编码代理的指令文件：** `AGENTS.md` 和 `.agents/instructions/delivery-mode.md` 的文字变了，但按 [prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules)第 6 条，改提示词文字只对新对话生效，已有对话沿用冻结的请求头。若某个代理运行时每轮重新读取指令文件，会破坏这条规则；这不在本仓库可验证的范围内，**未核实**。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 没有改序列化、遮盖、列表排序或模型输入。CI 新值只有布尔表达式和固定字符串，不进入模型请求。草稿/取消判断也不参与任何“同一段历史文字”的字节生成。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，且反向用例确实会命中新断言：**

- `scripts/ci/check-policy.mjs:374-382` 把 `pull_request.types` 固定为四个事件（没有 `edited`）。
- `check-policy.mjs:393-408` 固定并发组。
- `check-policy.mjs:441-450` 要求除 `required` 外的每个作业都正好带草稿条件。
- `check-policy.mjs:514-544` 要求 `required` 第一步是入口检查、上传 gate 和删除目录都使用 `REQUIRED_AFTER_ENTRY`。
- `test/tooling/policy.test.mjs:518-553` 的负例分别删入口、把入口移到检出后、忽略 `cancelled`、让草稿通过、把删除改回 `always()`，都会触发对应断言失败。
- `test/tooling/ci-optimization.test.mjs:227-253` 实际执行入口 bash，覆盖草稿、取消、空值和非空值。

**缺口：** 没有自动测试能验证 GitHub 线上真的把 `needs.*.result` 求值成包含 `cancelled`，也没有测试覆盖“整个 workflow 被取消时入口是否还有机会执行”。文档语义（`amends`、过时说明）也没有自动检查；现有 `check-adr-numbers` 只查路径/编号，不查 `status` 语义。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

代码侧的产出/消费是一致的：

- `ci/required` 名字没变；分支保护脚本仍按这个 context 检查（`scripts/delivery-mode/github-ruleset.sh:31`），`main-evidence.mjs` 仍按成功的 PR 运行和 `gate-<run-id>-<attempt>` 取证据（`scripts/ci/main-evidence.mjs:96-121`）。
- 新 `entry` 步骤 id 只被 `steps.entry.outcome` 和策略校验使用，`CI_DRAFT`/`CI_CANCELLED` 只被入口 bash 使用；`REQUIRED_DRAFT`/`REQUIRED_CANCELLED`/`REQUIRED_ENTRY_SCRIPT`/`REQUIRED_AFTER_ENTRY` 由策略和测试共同引用，写法一致。
- 去掉的 `edited` 在 `scripts/ci/` 中没有消费者；`main-evidence.mjs` 按 `event=pull_request` 和 `head_sha` 查运行，不依赖 `action`；`aggregate` 也不依赖。
- **不一致的是文档值**：ADR 0241 的 `amends` 指向已取代的 0073；ADR 0176 仍写合并不等 CI；ADR 0238/设计说明仍写“不论成败删除”；ADR 0202 还写草稿跑快检查。这些元数据/说明的“使用方”是读文档的线程和运维，当前没有自动校验兜住。

### 5. 作者列出的核对点逐条回答

1. **`contains(needs.*.result, 'cancelled')` 和草稿表达式**
   - `workflow_call`（main.yml 调用）：`event_name` 是调用方的 `push`，草稿表达式为 false，不会误判；`needs` 正常时 `cancelled` 为 false。
   - `workflow_dispatch`：`event_name != 'pull_request'`，草稿表达式为 false；不会误判。
   - 非草稿 PR：`draft == false`，六个作业正常运行；不会误判。
   - 草稿 PR：`draft == true`，六个作业跳过，`required` 以 `always()` 运行并在入口失败，符合设计。
   - 唯一“漏判”风险是整轮取消时 `required` 本身不运行；但此时 `ci/required` 仍是非成功，不会放行合并。

2. **草稿条件对下游作业和 main 调用的影响**
   草稿上 `policy` 跳过，`static`/`build`/`browser`/`coverage`/`security` 因自身条件和 `needs` 跳过；`required` 仍运行并失败。非草稿全部运行。main.yml 调用 ci.yml 时事件是调用方的 `push`，六个作业都满足 `event_name != 'pull_request'`，仍全部运行。

3. **入口失败不删目录、不上传 gate 的影响**
   `main-evidence.mjs` 只接受 `conclusion === "success"` 的 PR 运行（`scripts/ci/main-evidence.mjs:96-109`），入口失败的运行不是成功，不会被采用；需要证据时 main 会退回完整 CI。gate 不上传反而避免草稿消耗产物额度。残留目录由 `clean-old.sh` 按 360 分钟清理，定时器每小时，最坏约 6–7 小时，且共享目录清理不受“runner 正在跑任务”的 `continue` 影响（`clean-old.sh:9-26`），足够兜底。真正需要改的是 ADR 0238/设计说明的文字。

4. **去掉 `edited` 后的依赖**
   代码和测试没有其他依赖：`scripts/ci` 中无 `edited`；`main-evidence` 不读 `action`；`aggregate` 也不读。剩余提到 `edited` 的是已标记取代的 ADR 0191、解释现状的 ADR 0241、更新过的设计说明，以及过时的 ADR 0202。没有发现功能依赖残留。

5. **合并规矩的文字是否清楚、是否冲突**
   `.agents/instructions/delivery-mode.md:27` 和 `AGENTS.md:7` 本身写得清楚：合并前 `ci/required` 必须成功、草稿不跑 CI、CI 坏了要 Andy 明确同意才可不等。但它和生效中的 ADR 0176 第 91 行冲突，ADR 0241 的 `amends` 又指错了已取代的 0073；这两点会让读 ADR 的线程得到相反或过时的结论，建议先修文档再合并。
