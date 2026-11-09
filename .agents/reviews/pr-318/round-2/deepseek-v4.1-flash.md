## 复核结论

第 2 轮增量（`cc80979`，5 个文件）确实把 `edited` 的并发组后缀从 `github.run_id` 改成了固定字面量 `'edited'`，并与 `check-policy.mjs`、测试夹具三处同步；两条反向用例在逻辑上会真正失败。未发现高、中危代码缺陷。发现的是文档与代码/工作流之间的一致性问题，以及一条未被证实的资源结论。

注意：作者说“824 通过、biome/check-policy 通过”我无法运行测试，标为**未核实**；本机没有执行任何测试命令。

---

## 已读代码证实的问题

### 1. 低：ADR 说“不检查步骤级 if”，但代码明确检查了 coverage 的步骤级 if

- 文件:行：`docs/adr/0190-draft-pull-requests-run-fast-checks-only.md:52`
- 问题：文档断言“策略检查只看作业级的 `if`，不检查步骤级的 `if`，这是原有的缺口”，与代码不符。
- 证据：
  - `scripts/ci/check-policy.mjs:499-506`：
    ```js
    downloads.length === 1 &&
      downloads[0].if === undefined &&
      downloads[0].with?.["artifact-ids"] === ...
    ```
  - `scripts/ci/check-policy.mjs:508-513`：
    ```js
    executions.length === 1 &&
      executions[0].if === undefined &&
      executions[0].run === ...
    ```
  - `test/tooling/policy.test.mjs:574-582` 的“conditional runner”用例直接给 `coverage` 的执行步骤设 `if = "false"`，并要求 `validateWorkflow` 抛错。
- 建议：把措辞收窄为“除 coverage 的下载/执行步骤外，策略检查不检查其他步骤级 `if`”，或明确写出哪些步骤的 `if` 会被校验，避免后来者误以为可以随意在步骤级加跳过条件。

### 2. 低：设计文档仍写“影响目标分支的 edited”，与工作流和 ADR 不一致

- 文件:行：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:264`
- 问题：文档写“在 opened、synchronize、reopened、ready_for_review 及**影响目标分支的 edited 事件**重新验证”，但实际工作流对所有 `edited` 都触发；ADR 也明确说无法可靠判断 `changes.base`，非草稿 PR 的 `edited` 一律完整运行。
- 证据：
  - `.github/workflows/ci.yml:9` 的 `pull_request.types` 包含 `edited`，没有任何 `changes` 过滤。
  - `docs/adr/0190-draft-pull-requests-run-fast-checks-only.md:54`：“它的具体形状没有在本机核实，按‘拿不准就走完整运行’处理，非草稿 PR 的 `edited` 事件一律完整运行。”
- 建议：把“影响目标分支的 edited”改为“edited（改标题、正文或目标分支）”，或直接写“所有 edited”，与 ADR 和工作流一致。

### 3. 低：ADR“这比打断在跑的 CI 更省”的总资源结论未被证实

- 文件:行：`docs/adr/0190-draft-pull-requests-run-fast-checks-only.md:76`
- 问题：新的并发组让正在跑的同步/推送运行继续，同时再起一轮完整的 `edited` 运行；从总计算量看，是“旧的一轮完整跑完 + 新的一轮完整再跑”，并不比“打断旧的一轮、只跑新的一轮”更省。文档只强调了“不浪费在跑的进度”，但“更省”没有限定口径。
- 证据：`ci.yml:25` 中 `edited` 后缀为固定 `'edited'`，与普通 PR 运行不同组；`ci.yml:26` 的 `cancel-in-progress` 只在本组内生效，故 `edited` 不会取消普通组里的运行。
- 建议：把“这比打断在跑的 CI 更省”改成有口径的说法，例如“不浪费在跑的进度，但可能同时占用两轮完整 CI 的算力”；若关注两个 runner 的排队，应在落地后观察，而不是直接下“更省”的结论。
- 说明：这一条属于对设计判断的质疑，不是可执行代码的错误。

---

## 推测（未在本机核实）

- 我按 GitHub Actions 对 reusable workflow 的公开语义推断：`workflow_call` 被 `main.yml` 调用时，`github.event_name` 继承调用方（`push`），因此组名里的 push 段会带上 `github.run_id`，`cancel-in-progress` 为 false，浏览器/coverage 的草稿条件为真。该结论没有在真实 GitHub 上跑过，标为推测；但无论 `event_name` 是 `push` 还是 `workflow_call`，都不会命中 `edited` 段，仍符合 ADR 的“main 调用完整运行、不被 edited 取消”。

---

## 侧重检查（错误路径、不可信输入、安全、资源耗尽、不可逆操作、文档一致性）

- 错误路径 / 不可信输入：并发组由固定字符串、PR 编号、ref、run_id 组成，没有把用户可编辑的标题/正文拼进组名，不存在注入或超长可控串；`edited` 段是固定字面量。未发现新问题。
- 安全：改动不涉及权限、token、写操作；`permissions` 仍为只读。`edited` 组固定后缀不会让不同 PR 共用组（组里含 PR 编号）。未发现新问题。
- 资源耗尽：连续 `edited` 现在互相取消，第 1 轮的“叠多轮”已修复；但 `edited` 与普通运行可短暂并行，最多多一轮完整 CI，ADR 已承认。总资源口径见上文第 3 条。
- 不可逆操作：本改动只影响 CI 调度，不写业务数据、不改历史，不存在不可逆操作。
- 文档一致性：发现第 1、2 条不一致；其余 ADR 关于 `edited` 互不取消、连续编辑互相取消、草稿跳过、`ci/required` 失败的说法与代码一致。
- `edited` 组取值核对：`synchronize` / `ready_for_review` 同为 `CI-pull_request-<num>--`（会互相取消，符合 ADR 第 3 条）；`edited` 为 `CI-pull_request-<num>--edited`（与前者不同组，连续 `edited` 同组互相取消，符合 ADR 第 4 条）。

---

## 逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。第 2 轮增量只改 `.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs`、`test/tooling/policy.test.mjs`、ADR 0190 和设计文档；这些文件不在模型请求组装路径上，不读写系统提示、工具定义、历史或遮盖结果。因此“只在末尾追加、每轮会变的值放在最后一条消息”这一行为不受影响（该规则要求本身见 `.claude/rules/prompt-prefix.md` 第二节）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**

不会。改动完全不参与模型请求序列化，也不引入时间、随机数或依赖遍历顺序的集合。`ci.yml` 里的并发组只由固定字符串和 GitHub 上下文拼接，属于 CI 调度值，不是发给模型的内容。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，且反向用例有效：
- `scripts/ci/check-policy.mjs:384-395` 用精确字符串比较强制 `ci.yml` 的并发组与期望一致；`ci.yml:25` 必须含固定 `'edited'`。
- `test/tooling/policy.test.mjs:410-427` 新增两条反向用例：
  - 删除 `-${{ github.event.action == 'edited' && 'edited' || '' }}` 后，期望串仍含该段，`validateWorkflow` 抛错；
  - 把 `&& 'edited' ||` 改成 `&& github.run_id ||` 后，与期望串不等，抛错。
  两条如果被改回旧实现（`run_id` 或删段），对应变异后的组名会与期望一致，测试不再抛错，用例就会失败，因此能反向锁住本轮修复。
- 真实 `ci.yml` 也被测试间接覆盖：`test/tooling/policy.test.mjs:58-83` 会把仓库真实的 `ci.yml`、`main.yml` 复制到临时目录并运行 `policyMain`，若真实并发组写错，会在到达“quality workflow mismatch”之前先报并发错误，测试失败。
- 我未运行测试，“824 通过”未核实。

**4. 改动产生/修改的每个值，两端的生产者和使用者是否都能接受？**

逐个核对如下：

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| 并发组后缀字面量 `'edited'` | `.github/workflows/ci.yml:25` | GitHub 调度（接受任意非空字符串）；`scripts/ci/check-policy.mjs:389` 精确比对；`test/tooling/policy.test.mjs:100、414、423` 夹具/反向用例 | 三处一致 |
| 草稿跳过条件字符串 | `scripts/ci/check-policy.mjs:27-28`；实际写在 `ci.yml:194`（browser）和 `ci.yml:273`（coverage） | `check-policy.mjs:438-442` 要求 `job.if === githubExpression(DRAFT_SKIP_CONDITION)`；测试夹具 `policy.test.mjs:120-126` | 解析后的 YAML 字符串与期望完全一致，接受 |
| 可带草稿条件的作业清单 `["browser","coverage"]` | `check-policy.mjs:26` | `ci/policy.json:63、96` 确有这两个 check id；`ci.yml:192、271` 确有这两个 job；`check-policy.mjs:443` 对其它作业要求 `if === undefined` | 两端一致 |
| `ci/required` 的 `always()` | `ci.yml:381` | `check-policy.mjs:433-437` 接受裸 `always()` 或 `${{ always() }}` | 一致 |

未发现像 I-73 那种“生产端生成了校验端不接受的值”的错配。
