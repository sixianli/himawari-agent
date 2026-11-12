## 结论（按严重度从高到低）

### 中：ADR 0241 声称修改了 ADR 0238，但 0238 的元数据和正文没有对应改动

- **文件:行**：`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:7`、`:54`；`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:61`
- **问题**：0241 的 `amends` 只列了 0176，但正文明确说修改了 0238 决定第 1 条的 `remove` 语义；0238 仍写 `if: always()`，也没有 `amended_by` 指向 0241。按本仓库 ADR 0031 的双向 `amends`/`amended_by` 惯例，读者从 0238 读不到这次修改，会把旧规则当成现行规则。
- **证据**：
  - `0241:7`：`amends: "docs/adr/0176-ci-on-ovh-vps.md"`
  - `0241:54`：`这修改了 [ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md) 决定第 1 条里 remove 的“if: always()，不论成败都删”`
  - `0238:61`：``- `remove`：汇总作业最后一步，`if: always()`，不论成败都删掉本次运行的目录。``
  - `docs/adr/0031-isolated-tool-execution.md:139` 写明部分修正采用双向 `amends` / `amended_by` 元数据。
- **建议**：在 0241 的 `amends` 里补 0238（如认为快速模式规则也改了，再加 0133），并在 0238 frontmatter 加 `amended_by: "docs/adr/0241-..."`。0238 旧正文可以保留历史，但应加一行指向 0241 的修订说明。

### 低：check-policy 不再要求汇总 gate 上传步骤保留入口条件，反向用例有缺口

- **文件:行**：`scripts/ci/check-policy.mjs:540-545`；`.github/workflows/ci.yml:399-400`；`test/tooling/policy.test.mjs:668-677`
- **问题**：旧断言要求 `required` 里所有 `upload-artifact` 的 `if === REQUIRED_AFTER_ENTRY`。本轮删掉它，换成“`undefined` 或 `REQUIRED_AFTER_ENTRY` 都行”。因此把 `ci.yml:400` 的 `if` 删掉，policy 仍会通过；`required.mjs` 失败时 gate 就不再上传，与 ADR 0241 说的“上传汇总结论……条件是 `always() && steps.entry.outcome == 'success'`”不一致。现有反向用例只测“改成 `always()`”，不测“删掉 `if`”。
- **证据**：
  - `check-policy.mjs:540-545`：
    ```js
    assert(
      job.steps
        .slice(1)
        .every((step) => step.if === undefined || step.if === REQUIRED_AFTER_ENTRY),
      "Required runs nothing after a failed entry check",
    );
    ```
  - `ci.yml:399-400`：
    ```yaml
    - name: 保留汇总结论
      if: ${{ always() && steps.entry.outcome == 'success' }}
    ```
  - 本轮 diff 删掉了原来的 `Required uploads its gate only after the entry check passed` 断言。
  - `policy.test.mjs:668-677` 只把上传步骤的 `if` 改成 `always()` 后断言抛错，没有覆盖 `undefined`。
- **建议**：保留新的一般规则，另加一条针对 `required` 的 upload-artifact 断言：`every((step) => step.if === REQUIRED_AFTER_ENTRY)`；并新增“删掉 gate 上传的 `if` 必须失败”的反向用例。

### 低/待确认：`amends` 没有列 0133

- **文件:行**：`docs/adr/0241-...md:7`、`:56`；`docs/adr/0133-docs-check-removed-from-npm-run-check.md:49`；`docs/adr/0080-document-governance-in-fast-mode.md:46`
- **问题**：0241 正文说“快速模式现行的 ADR 是 ADR 0133”，但 `amends` 只列 0176。快速模式的“合并前等 CI”暂停规则确实经 ADR 0080:46 由 0133 继承。如果 0241 的目的是改这条规则，元数据不完整；如果只想修订 0176 的表述，正文应写清楚，避免歧义。
- **证据**：
  - `0241:56`：`（快速模式现行的 ADR 是 [ADR 0133](0133-docs-check-removed-from-npm-run-check.md)）`
  - `0080:46`：`ADR 0073 决定 3 里其余被暂停的规则（……合并前等 CI……）照旧暂停。`
  - `0133:49`：`ADR 0080 其余内容……照旧，由本 ADR 继承。`
- **建议**：把 0133 加进 `amends`，或改写正文明确“只修订 0176，快速模式规则由 0133 继承”。

---

## 读代码证实的

- **新规则不会误拦现有 `ci.yml`**：`required` 的步骤依次是入口检查、checkout、setup-node、装工具、装汇总依赖、collect、required.mjs、gate 上传、remove。除入口外，前 6 个都没有 `if`，最后两个都是 `REQUIRED_AFTER_ENTRY`，所以 `.slice(1).every(...)` 通过。
- **新反向用例确实依赖新规则**：`policy.test.mjs:549-553` 往 `required` 末尾加 `{ if: "always()", run: "echo late" }`；旧的 upload 专用断言不管 run 步骤，若没有新规则，`validateWorkflow` 不会因这步抛错。因此该反向用例是真的。
- **入口 bash 测试参数与真实环境一致**：`ci.yml` 有 `defaults.run.shell: bash`，GitHub 的 bash 默认是 `bash --noprofile --norc -eo pipefail`；`ci-optimization.test.mjs:230` 改成 `["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", entry.run]`，是更接近真实执行的修正，没有引入退化。
- **常量与工作流逐字一致**：`REQUIRED_AFTER_ENTRY` 由 `githubExpression("always() && steps.entry.outcome == 'success'")` 产生；`ci.yml:400`、`:408` 正是 `${{ always() && steps.entry.outcome == 'success' }}`。`REQUIRED_ENTRY_SCRIPT` 末尾的换行与 YAML `run: |` 的 block scalar 一致。
- **入口检查的输入不可注入**：脚本只读 `CI_DRAFT`、`CI_CANCELLED` 两个由 GitHub 上下文算出的布尔值；`check-policy.mjs` 还统一禁止 `run` 字符串里出现 `${{`。
- **取消后的清理兜底存在**：`scripts/operations/ci-runner/runners.sh:7` 是 `RUNNER_SHARE_KEEP_MINUTES=360`，`clean-old.sh:25` 按分钟删除，`gh-runner-clean.timer:5` 是 `OnCalendar=hourly`，与 ADR 0241 的“每小时清理、6 小时”一致。
- **main 证据只认成功运行**：`scripts/ci/main-evidence.mjs` 的 `discoverEvidence` 要求 `r.status === "completed" && r.conclusion === "success"`，与 ADR 说法一致。
- **`0191` 与 `0241` 的取代关系互逆**：`0191` 的 `superseded_by` 指向 0241，0241 的 `supersedes` 指向 0191。

## 推测 / 未核实

- 我**没有实际运行测试**，上述“反向用例会失败/通过”是静态阅读代码得出的结论。
- “整轮被取消时 GitHub 可能直接把汇总作业标成取消、入口检查根本不运行”依赖 GitHub 运行时行为，**未实测**；ADR 用了“可能”，属于合理保留。
- 改基分支后不触发 CI、可能沿用同一 head SHA 上的旧绿灯，是 ADR 已写明的取舍；是否构成实际风险取决于规则集和合并方式，**未核实**。
- 本轮要求的 `.agents/reviews/pr-409/round-1/judgments.md` 属于受保护的 review 记录路径，工具拒绝读取，**未核实**其原文。
- 如果未来有合法步骤需要显式 `if: success()`，新规则会拒绝；这是比错误信息更严格的白名单取舍，不是当前 bug。

---

## 侧重检查

- **错误路径**：入口检查失败后，后续默认步骤会被 GitHub 的 `success()` 跳过；`remove` 也需要 `steps.entry.outcome == 'success'`，不会误删被取消运行的目录。确认。
- **不合规范/不可信输入**：入口脚本不直接插值 PR 标题、正文等不可信字段；`check-policy` 禁止 `run` 中写 `${{ ... }}`。确认。
- **安全**：本轮没有新增权限、密钥或写 token；`ci.yml` 仍只有只读权限。确认。
- **资源耗尽**：草稿 PR 的 6 个检查作业全部跳过，只剩汇总作业入口检查；被取消/入口失败的运行不立即删除共享目录，最多留到 6 小时后的清理（清理在 runner 有作业时会跳过，可能再延后）。确认脚本存在；实际调度延迟未核实。
- **不可撤销操作**：`run-share.mjs remove` 仍受入口条件保护；本轮没有新增破坏性操作。确认。
- **规则、说明、代码一致性**：发现 0238 正文/元数据与 0241 不一致；check-policy 对 gate 上传条件的硬规则覆盖弱于 ADR 描述；0133 的 `amends` 关联不明确。其余 `delivery-mode`、设计说明第 129 行与代码一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只涉及 `.github/workflows/ci.yml`、`docs/`、`.agents/instructions/delivery-mode.md`、`scripts/ci/`、`test/tooling/`，没有改 `packages/` 或任何运行时 prompt 组装代码。产品发给模型的内容仍然只在末尾追加，每轮会变的值没有进入系统提示、工具定义或历史。`.agents/instructions/delivery-mode.md` 即使被开发代理读取，也只在新建会话时生效，不会改写已发出的请求；产品运行时不受影响。依据：改动范围内没有 prompt 组装路径，符合[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。本改动没有新增遮盖、时间字段、无序集合或序列化格式；CI 里的 `run_id`、`attempt` 等只用于 CI，不进入模型请求。ADR 中的日期是静态文本。没有发现会让同一内容产生不同字节的路径。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：新规则的反向用例 `policy.test.mjs:549-553`（入口后追加 `always()` 步骤）会失败，`policy.test.mjs:556-559`（remove 改成 `always()`）也会失败；入口 bash 由 `ci-optimization.test.mjs:230-249` 实际执行。
   - 缺口：没有“删掉 gate 上传步骤的 `if` 必须失败”的反向用例；当前删掉 `ci.yml:400` 的 `if` 会被新规则放过。
   - ADR 关联没有自动检查：`scripts/check-adr-numbers.mjs` 只检查 ADR 链接/路径是否存在，不检查 `amends`/`amended_by` 是否成对、是否漏列或旧正文是否过期，所以 0238 的 stale 文本不会被 CI 发现。
   - 我没有实际运行这些测试，以上是静态核对结论。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `REQUIRED_AFTER_ENTRY`：产生于 `check-policy.mjs:36-38`；使用于 `ci.yml:400,408`、`check-policy.mjs:536,543`、`policy.test.mjs:121,669`、`ci-optimization.test.mjs:219`。两端都是带 `${{ }}` 的同一字符串，匹配。**但** `check-policy.mjs:543` 允许 `undefined`，导致 gate 上传步骤可以丢掉该值，见上面的低严重度问题。
   - `DRAFT_SKIP_CONDITION`：产生于 `check-policy.mjs:26-27`；使用于 6 个作业、`check-policy.mjs:448` 和测试，匹配。
   - `REQUIRED_ENTRY_SCRIPT`、`REQUIRED_DRAFT`、`REQUIRED_CANCELLED`：产生于 `check-policy.mjs:28-35`；使用于 `ci.yml:375-379`、`check-policy.mjs:520-522` 和测试，逐字匹配（含末尾换行）。
   - `amends`：0241 指向的 0176 存在，链接检查能过；但 0241 实际修改的 0238 没有列进去，0238 也没有 `amended_by`；0133 只在正文提到、未列入 `amends`。这是元数据两端的校验缺口。
   - `0191` 的 `superseded_by` 与 0241 的 `supersedes` 互逆，正确。
   - 设计说明第 129 行、`delivery-mode.md:27`、`AGENTS.md` 与 0241 的行为描述一致，链接也存在。
