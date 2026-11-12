## 发现（按严重度从高到低）

### 1. 中｜自动检查缺口：新规则只约束“已存在的 gate 上传”，不保证它存在
- 文件:行：`scripts/ci/check-policy.mjs:546-551`；`test/tooling/policy.test.mjs:174-186, 661-682`；`test/tooling/ci-optimization.test.mjs:100-102`
- 问题：新断言用 `.filter(...).every(...)`，当 required 作业里一个 `actions/upload-artifact` 都没有时是空集，`every` 直接为真。它并不能兑现错误信息里的“Required uploads its gate”。更关键的是，删掉 `ci.yml` 里真正的“保留汇总结论”步骤后，`policy.test.mjs` 的合成工作流本来就没有 gate 上传，仍会通过；`ci-optimization.test.mjs` 只要求三个工作流里存在任意上传，其他作业的 diagnostics 上传仍满足它。则 `gate-` 产物会悄悄消失，直到 `main-evidence.mjs` 在 main 确认时才发现。
- 证据（读代码证实）：
  - `scripts/ci/check-policy.mjs:546-551`：
    ```js
    assert(
      job.steps
        .filter((step) => /^actions\/upload-artifact@/u.test(step.uses ?? ""))
        .every((step) => step.if === REQUIRED_AFTER_ENTRY),
      "Required uploads its gate even when the gate fails, but only after the entry check passed",
    );
    ```
  - `test/tooling/policy.test.mjs:174-186` 的 `workflow()` 里 required 的步骤是 `requiredEntry`、checkout、run、`shareCollect()`、`shareRemove()`，没有 gate 上传。
  - `test/tooling/ci-optimization.test.mjs:100-102`：
    ```js
    const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads.length).toBeGreaterThan(0);
    ```
    这统计的是所有工作流、所有作业的上传，不定位 required 的 gate。
  - `scripts/ci/main-evidence.mjs:116-121` 要求存在 `gate-${run.id}-${run.run_attempt}`，说明这个上传不是可选的。
- 建议：把断言从“所有存在的上传都满足条件”改为“required 里必须恰好有一个 `path: .ci-output/gate/` 的上传，且它的 `if` 是 `REQUIRED_AFTER_ENTRY`”。同时在合成 fixture 里加入 gate 上传，并增加一条反向用例：删除 gate 上传必须失败。这样反向用例才能覆盖“恢复 gate 上传条件”真正要保护的东西。

### 2. 低｜ADR 元数据字段顺序与仓库既有写法不一致，外部严格校验是否报错未核实
- 文件:行：`docs/adr/0133-docs-check-removed-from-npm-run-check.md:7-8`、`docs/adr/0176-ci-on-ovh-vps.md:8-9`、`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:8-9`
- 问题：作者说“元数据写法是否和仓库已有 ADR 一致”。逗号分隔多个 `amends` / `amended_by` 确实有先例；但仓库既有 `amended_by` 都放在 `date` **之前**，本轮三处新增都放在 `date` **之后**。`.agents/instructions/document-governance.md:11` 还要求照抄同类型最新文档的 frontmatter 结构。若外部 `validate_docs.py . --strict` 检查字段顺序，这三处会新增错误；该脚本不在仓库，无法确认。
- 证据（读代码证实）：
  - 既有写法，`docs/adr/0031-isolated-tool-execution.md:7-9`、`docs/adr/0169-pause-runners-by-removing-the-label.md:7-9` 都是 `amends`、`amended_by`、`date`。
  - 本轮新增，`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:8-9` 是 `date: "2026-11-11"` 后接 `amended_by: ...`；0133、0176 相同。
  - 另外 `check-adr-numbers.mjs` 只检查路径是否存在（`scripts/check-adr-numbers.mjs:93-95`），不检查字段顺序或双向关系，所以仓库内自动检查不会发现这一点。
  - 附带观察（不是本增量引入）：`0176` 的 `amended_by` 只补了 0241，但 0181、0189、0191、0202、0238 也都写了 `amends: 0176`，反向关联仍不完整。
- 建议：把三处 `amended_by` 移到 `date` 之前，与既有模板一致；再手动跑一次 `document-governance` 的严格校验。若目标是“完整双向关联”，另开一次提交补齐 0176 的反向列表，或明确说明只维护最新一条。

### 3. 低｜ADR 0241 的“最多多留 6 小时”与清理实现不一致
- 文件:行：`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:83`；`scripts/operations/ci-runner/clean-old.sh:24-26`；`scripts/operations/ci-runner/gh-runner-clean.timer:4-7`
- 问题：ADR 说被取消运行留下的共享目录“最多多留 6 小时”。实现是 `-mmin +360` 加每小时清理，且带最多 5 分钟随机延迟；一个目录可能在 6 小时门槛后等到下一次清理才被删，实际最长约 7 小时。决策第 2 条“6 小时后删掉”描述门槛是准确的，但后果里的“最多”不准确。
- 证据（读代码证实）：
  - `clean-old.sh:25`：`find "$RUNNER_SHARE_ROOT" -mindepth 1 -maxdepth 1 -mmin +"$RUNNER_SHARE_KEEP_MINUTES" -exec rm -rf -- {} +`
  - `runners.sh:7`：`RUNNER_SHARE_KEEP_MINUTES=360`
  - `gh-runner-clean.timer:5-7`：`OnCalendar=hourly`、`RandomizedDelaySec=5m`
- 建议：把后果改成“最多约 7 小时”或“6 小时后、下一次每小时清理时删掉”。这是文档口径问题；若确实要求最长 6 小时，应改清理频率或门槛。

## 侧重检查

- **错误路径**：入口脚本对 `CI_DRAFT`、`CI_CANCELLED` 缺失或非 `false` 都失败（`ci.yml:377-379`），属于保守失败；上游取消、草稿两条路径都覆盖。未发现失败后继续执行上传/删除的路径：入口失败后，后续无条件步骤默认被 GitHub 跳过，带 `if` 的两步是 `always() && steps.entry.outcome == 'success'`。
- **不合规范或不可信输入**：`CI_DRAFT` / `CI_CANCELLED` 由 GitHub 布尔表达式生成，不是 PR 可控的自由文本；入口脚本是固定字符串，`run` 里没有 `${{ }}`，不存在把不可信输入插进 shell 的路径。`check-policy.mjs:481-485` 也禁止 `run` 中出现 `${{`。
- **安全**：required 仍然只读、无 secrets；gate 上传路径仍限定为 `.ci-output/gate/`，新条件没有引入新的数据外泄面。未发现新增安全边界问题。
- **资源耗尽**：入口检查只执行两行 bash，成本很低；被取消运行不再立即删除共享目录，改为依赖每小时清理（见发现 3）；单轮约 300 MB、有 16 GiB 预检和清理兜底。未发现新的无界循环或不可控增长，但最长保留时间应写成约 7 小时。
- **不可撤销操作**：本改动没有新增删除或覆盖操作；入口失败时反而少删共享目录，之后由清理删除，方向是更保守的。未发现不可逆风险。
- **规则、说明文档与代码一致性**：`delivery-mode.md`、`AGENTS.md`、ADR 0241、设计 spec 与 `ci.yml` 在“草稿跳过六作业、入口失败、去掉 edited、合并等 CI”上一致；`main-evidence.mjs` 的 gate 名称与 `ci.yml` 一致。不一致点集中在元数据字段顺序（发现 2）和清理时长口径（发现 3）。

## 读代码证实的

- 当前 `ci.yml` 的 required 入口步骤就是 `entry`，且是第一个步骤，`env` 与 `run` 精确匹配 `REQUIRED_DRAFT`、`REQUIRED_CANCELLED`、`REQUIRED_ENTRY_SCRIPT`（`ci.yml:372-379`）。
- required 里唯一的 `actions/upload-artifact` 是 gate 上传，`if` 精确是 `${{ always() && steps.entry.outcome == 'success' }}`，路径 `.ci-output/gate/`、保留 1 天（`ci.yml:399-406`）。
- 入口之后的步骤要么没有 `if`，要么是 `REQUIRED_AFTER_ENTRY`；因此新规则不会误拦现有 `ci.yml`（`ci.yml:380-408`，规则 `check-policy.mjs:540-551`）。
- 所有非 required 作业都带草稿条件；`pull_request.types` 已无 `edited`（`ci.yml:30-308`）。
- 新增的 `amends` / `amended_by` 路径都真实存在；`check-adr-numbers.mjs` 会扫描 frontmatter 里的 `docs/adr/...md` 路径并要求文件存在，这三条都能通过（`scripts/check-adr-numbers.mjs:93-95`）。
- `policy.test.mjs:674-681` 的两个反向用例按断言顺序会分别命中“Required runs nothing after a failed entry check”和“Required uploads its gate even when the gate fails”。
- `ci-optimization.test.mjs:242-253` 会实际执行入口脚本，覆盖草稿、上游取消、空值和全部 `false` 五种输入。

## 推测 / 未核实

- 未实际运行 `npm test` / `check:ci-policy`（本环境只允许 git 命令）；反向用例会失败是按断言顺序推断的。
- 仓库里没有 `document-governance` 技能的 `validate_docs.py`，无法核实它是否检查 frontmatter 字段顺序、是否接受逗号分隔的多个 `amends`。仓库内现有大量同样的逗号分隔写法，说明大概率支持。
- GitHub Actions 对布尔表达式写入 `env` 的字符串形式、以及 `contains(needs.*.result, 'cancelled')` 在矩阵取消时的具体行为，属于外部平台行为；代码测试已按 `"true"`/`"false"` 假设覆盖。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个 PR 只改 CI 工作流、ADR/说明文档、复核记录；没有改 `packages/prompt-catalog`、系统提示、工具定义、历史或遮盖代码。发给模型的内容仍只在末尾追加，每轮会变的值仍在最后一条消息里。变更的 `AGENTS.md` / `delivery-mode.md` 是开发代理读取的项目说明，不是产品模型每轮组装的请求头；它们会改变未来会话读到的文字，但不会让同一会话中已经发出的前缀被重写。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的 `amends` / `amended_by` 是固定字符串，顺序由文件字面量决定；CI 的布尔表达式和入口脚本也不参与模型请求序列化，没有依赖时间、无序集合或前后文遮盖的新字段。
3. **有没有对应的自动检查，反向用例真的会失败？** 有部分：入口脚本有真实执行用例，gate 上传的“缺 `if` / 错 `if`”反向用例从代码看会失败；当前 `ci.yml` 也匹配新规则，不会误拦。但缺少“gate 上传整个被删除”的反向用例，而新规则的空集 `.every()` 会放过这种情况（发现 1）。ADR 元数据没有仓库内自动语义校验，只有路径存在性检查。
4. **每个值的使用端都能接受吗？** 已逐个核对：`REQUIRED_AFTER_ENTRY` 在 `ci.yml`、`check-policy.mjs`、两个测试文件里是同一字节串；`REQUIRED_DRAFT` / `REQUIRED_CANCELLED` / `REQUIRED_ENTRY_SCRIPT` 在 `ci.yml`、策略校验和测试里一致；`DRAFT_SKIP_CONDITION` 与六个作业、策略校验一致；`gate-${run.id}-${run.run_attempt}` 与 `main-evidence.mjs` 的读取名称一致；`amends` / `amended_by` 的三个路径都能通过 `check-adr-numbers` 的存在性检查。未核实的只剩外部 `validate_docs.py` 对字段顺序和双向关系的具体规则。

## 总评

没有发现高严重度的运行时或安全缺陷；现有 `ci.yml` 不会被两条新规则误拦，ADR 关联方向和关键路径也正确。建议至少补上“required 必须存在 gate 上传”的正向断言和删除反向用例，并把三处 `amended_by` 移到 `date` 之前；其余为文档口径和完整性小问题。
