## 结论摘要

这次 PR 真正改的只有 `204ac20` 这一个提交：新增 `pr-closed.yml` 和 `test/tooling/pr-closed-cancel.test.mjs`。按给定基准 `9ad2138..204ac20` 得到的 diff 不是这个 PR 的 diff，而是把基准上较新的 main 改动全部反向显示出来。工作流本身在“非草稿 PR”上的并发组字符串与 `ci.yml` 一致；主要问题在验证链和文档一致性，以及草稿 PR 的遗漏。

### 1. 高：给定的比较基准不是本提交的祖先，这个 diff 不是 PR 528 的改动

- 文件:行：`.agents/instructions/delivery-mode.md:27`；git 元数据
- 问题：`9ad2138` 比 `204ac20` 新，`204ac20` 的父提交是旧的 `f6997c3b`。所以 `git diff 9ad2138..204ac20` 除了新增两个文件，还把基准分支后来合入的 #520、#522、#524 等改动全部显示成删除；分支本身也没有满足“已合进最新的 main”的合并条件。
- 证据（已读代码/命令）：
  - `git show --stat 204ac20`：只有 `.github/workflows/pr-closed.yml` 和 `test/tooling/pr-closed-cancel.test.mjs`，2 files changed, 78 insertions。
  - `git show --format=%P --no-patch 204ac20`：父提交是 `f6997c3b0bcb40946f6d69f7ad101b62263ae595`。
  - `git log --oneline 9ad2138..204ac20`：只输出 `204ac20`；`git log --oneline 204ac20..9ad2138` 列出 #520、#522、#524 等后续提交。
  - `git diff --stat 9ad2138..204ac20`：173 files changed, 234 insertions, 7339 deletions。
- 建议：先把最新 `main` 合进该分支；审查和 CI 比较都以 merge-base 或 `git show 204ac20` 为准，不要用 `9ad2138..204ac20` 当 PR diff，否则会误以为本 PR 删除了 Apple 推送、提议执行等生产代码。

### 2. 中：新增工作流没有接入 actionlint，CI 不会校验它的 GitHub Actions 语法

- 文件:行：`scripts/ci/run.mjs:268-276`
- 问题：`static` 检查只对四个工作流显式运行 actionlint，新增的 `pr-closed.yml` 不在列表里。新测试只用 `yaml` 解析并检查少数字段，无法发现非法表达式、非法事件字段、未知 job 键等 GitHub Actions 语法错误。
- 证据（已读代码）：
  ```js
  await command("actionlint", tools.actionlint, [
    "-shellcheck=",
    ".github/workflows/ci.yml",
    ".github/workflows/quality.yml",
    ".github/workflows/main.yml",
    ".github/workflows/merge-queue.yml",
  ]);
  ```
  `test/tooling/pr-closed-cancel.test.mjs:23` 只解析 `pr-closed.yml`，没有调用 actionlint。
- 建议：把 `.github/workflows/pr-closed.yml` 加进 actionlint 参数；必要时同步更新 `test/tooling/runner-orchestration.test.mjs` 对 actionlint 参数的断言。

### 3. 中：与 CI 设计规格“并发组包含 workflow、避免不同 workflow 相互取消”直接冲突，但没有更新文档或 ADR

- 文件:行：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:272`
- 问题：设计写的是“concurrency key 包含 workflow、event 和 PR/ref，避免不同 workflow 相互取消”。本改动恰恰依赖两个不同 workflow 共享同一个并发组来取消 CI，属于对这一设计不变量的有意例外，但 PR 没有改规格，也没有新增 ADR 或说明。
- 证据（已读代码）：
  ```text
  同一 PR 的更新可取消较旧 CI。concurrency key 包含 workflow、event 和 PR/ref，避免不同 workflow 相互取消。
  ```
  `pr-closed.yml:8` 硬编码 `CI-pull_request-${{ github.event.pull_request.number }}--ready`，故意与 `ci.yml` 同组。
- 建议：至少在设计规格或新 ADR 中记录“关闭 PR 的工作流可以跨 workflow 进入 CI 的并发组”这一例外及理由。更好的做法是不要维护第二份组名字符串：把 `closed` 加进 `ci.yml`，并在 `closed` 事件上跳过所有作业，让 `ci.yml:24` 成为唯一组名来源，顺带自动覆盖草稿和后缀变化。

### 4. 中：草稿 PR 关闭时不会取消它的排队 CI，测试标题和 PR 目标描述比实现更宽

- 文件:行：`.github/workflows/pr-closed.yml:8`；`.github/workflows/ci.yml:24`；`test/tooling/pr-closed-cancel.test.mjs:52-59`
- 问题：`pr-closed.yml` 固定使用 `--ready`，但 `ci.yml` 对草稿 PR 算出的组是 `CI-pull_request-<n>--draft`。因此草稿 PR 关闭时，组名不匹配，排队的 CI 不会被取消。测试还明确断言“不碰草稿运行”。而草稿运行仍会跑 `ci/required` 并占用 `ci-vps-gate`（见 ADR 0256 前提 1），所以“关闭 PR 取消排队 CI”的目标在草稿场景下没有实现。
- 证据（已读代码）：
  - `pr-closed.yml:8`：`group: CI-pull_request-${{ github.event.pull_request.number }}--ready`
  - `ci.yml:24` 的 `draft == true && 'draft' || 'ready'`
  - 测试 `52-59` 行只比较了 `draft516` 与 `closedGroup(516)` 不相等。
- 建议：如果只承诺非草稿，就把测试标题和 PR 描述改成“非草稿 PR”；如果要覆盖草稿，需要第二个组/工作流，或采用上面的方案把 `closed` 并入 `ci.yml`，让草稿/非草稿后缀自动沿用。

### 5. 低：测试对“不碰 main”的断言是空洞的，且没有真正的反向用例

- 文件:行：`test/tooling/pr-closed-cancel.test.mjs:45-60`；`.github/workflows/main.yml:10`
- 问题：`expect(closedGroup(516)).not.toMatch(/^Main confirmation|^main-confirmation/u)` 永远成立，因为 `closedGroup(516)` 以 `CI-` 开头；测试根本没有读取 `main.yml`。此外没有“故意写错组名/漏掉 PR 号/漏掉 draft 后缀时测试必须失败”的反向夹具，也不能验证 GitHub 是否真的会跨 workflow 取消、以及作业全被跳过时是否仍会取消。
- 证据（已读代码）：
  - 测试第 60 行的正则只能匹配以 `Main confirmation` 或 `main-confirmation` 开头的字符串。
  - `main.yml:10` 的实际组是常量 `group: main-confirmation`，不是测试所假定的写法。
  - ADR 0256:48 引用的是 `group: main-confirmation-${{ github.run_id }}`，与当前 `main.yml:10` 不一致，属于已有的文档漂移；核对 main 安全必须读实际文件。
- 建议：测试应读取 `main.yml` 并计算它的实际组名再比较；增加反向夹具，例如把 `pr-closed.yml` 的组改成包含 `github.workflow` 或漏掉 PR 号时必须失败；对 GitHub 实际取消行为另附授权后的真实运行链接作为证据。

### 6. 低：fast 模式提交说明缺少 `Fast-mode-checks:` 行

- 文件:行：`.agents/instructions/delivery-mode.md:32`；提交 `204ac20`
- 问题：`DELIVERY_MODE` 是 `fast`，规则要求在提交说明中写一行 `Fast-mode-checks:`，列出实际运行过的基本检查和主机/版本。`git show --format=%B 204ac20` 的正文只有 `Layer-0-tests:`，没有 `Fast-mode-checks:`。
- 证据（已读代码/命令）：`DELIVERY_MODE` 内容为 `fast`；提交正文没有该行；仓库钩子目录里未找到对 `Fast-mode-checks` 的强制检查。
- 建议：补上该行，或明确这一规则的执行方式，避免说明文档与实际提交习惯脱节。

## 侧重检查

- 错误路径：检查了 PR 关闭但不合并、草稿 PR 关闭、关闭后重新打开、`pull_request.number` 缺失等路径。草稿路径确实漏取消；关闭后重新打开会触发新的 CI，风险很低。
- 不合规范/不可信输入：工作流只使用事件里的 PR 编号，未拼接标题、分支名等不可信字符串；`run: "true"` 是静态命令，没有命令注入面。
- 安全：`permissions: {}` 是最小权限；不 checkout PR 代码；fork PR 的 `closed` 事件不会执行 PR 内容。跨 workflow 共享并发组会取消同组运行，但目前只有 `ci.yml` 使用同组名，main 使用独立的 `main-confirmation`。
- 资源耗尽：`if: false` 的作业不会占用 runner；但草稿 PR 的排队运行仍可能占 `ci-vps-gate`，见第 4 条。每个关闭的 PR 只多一个零作业运行，资源影响很小。
- 不可撤销操作：`cancel-in-progress` 会取消同 PR 正在跑的 CI，属于预期行为；PR 重开会重新触发 CI，main 确认不受影响。
- 规则/文档一致性：发现设计规格第 272 行与实现冲突、actionlint 文件清单没有新增工作流、ADR 0256 对 main 组名的引用已过期、fast 模式提交说明缺项。

## 推测与未核实

- GitHub 官方文档：本环境不能上网，无法核对“并发组跨工作流共享”和“所有作业被跳过时工作流级 concurrency 仍会取消同组运行”的原文。按已知 GitHub 语义，这两点理论上成立，但仓库里没有对应测试或真实运行证据，作者也未提供运行链接，标为未核实。
- 未运行任何测试；`test/tooling/pr-closed-cancel.test.mjs` 是否在当前分支完整通过、`npm run check` 是否通过，均未核实。
- 给定 diff 中那些被“删除”的生产文件是否会影响模型请求，未逐个分析；它们不属于 `204ac20`，不应作为本 PR 的改动来审查。

## 必答问题

1. **不会改变模型已经见过的请求开头。** `git show --stat 204ac20` 只改 CI YAML 和 tooling 测试，二者都不在系统提示、工具定义、历史消息或遮盖路径上；仍然只在末尾追加、每轮变化的值仍在最后一条消息里的规则不受影响。注意：只有按给定基准得到的 diff 才包含大量生产代码删除，但那是基准选择造成的，不是本提交的改动；我没有运行 `check:prompt-prefix`，该检查结果未核实。
2. **不会让同一段文字在不同请求里变成不同字节。** 本改动不序列化任何发给模型的内容。唯一新增的字符串是并发组，它按 PR 编号确定性地变化，且不进入模型请求。
3. **有自动检查，但不完整。** `test/tooling/pr-closed-cancel.test.mjs` 会被 `ci/policy.json:214` 的 `test/tooling/**/*.test.mjs` 收集，检查 YAML 字段和组名字符串相等；但没有真正的反向夹具，“不碰 main”的断言是空洞的，无法验证 GitHub 的实际取消行为，新增工作流也没有加入 actionlint 列表。因此现在的反向用例不能证明“写错就一定失败”。
4. **组名两端目前能对上，但“清单项”有一处没接上。** 产生组名的地方是 `pr-closed.yml:8`，使用方是 GitHub concurrency 调度器和测试；对非草稿 `pull_request`，它与 `ci.yml:24` 都算出 `CI-pull_request-<n>--ready`，测试也断言了这一点。main 的实际组是 `main-confirmation`（`main.yml:10`），其他 PR 编号不同，不会误取消；草稿组是 `--draft`，因此不会被取消（这是第 4 条的遗漏，不是误取消）。`runs-on: ci-vps-gate` 在 `.github/actionlint.yaml:4` 中已登记，作业被跳过不占 runner。真正没接上的是 actionlint 的文件清单：新工作流不在 `scripts/ci/run.mjs:270-276`，所以它不会经过 CI 的工作流后端校验。
