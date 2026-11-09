# PR 318 第 3 轮复核

## 复核范围

- 本轮 PR 自己的增量只有两个提交：`c4596bf`（三处措辞）和 `1fba74d`（ADR 改号）。
- `git show --stat 1fba74d` 只有 `docs/adr/0191-...md` 改名和设计文档一行；`git show --stat c4596bf` 只有 ADR、设计文档和复核记录。因此“改号只动文档”“工作流、检查脚本和测试没有改动”属实。

## 侧重检查

- **错误路径 / 不可信输入**：本轮没有运行时代码。整体 PR 的草稿条件 `github.event.pull_request.draft != true` 在字段缺失时会得到 `null != true` 为真，即照常跑检查，属于失败时偏向多跑而不是少跑；`check-policy.mjs:438-443` 又强制 `browser`/`coverage` 的 `if` 必须逐字等于该表达式，其他必需作业不得带 `if`。
- **安全**：本轮不涉及密钥、权限、token；`ci.yml:21-23` 的只读权限未被改动。ADR 改号没有引入外部输入。
- **资源耗尽**：`edited` 与推送并发占用算力的问题已在 ADR `0191:76` 明确写成代价；`ci.yml:24-26` 与 `check-policy.mjs:384-401` 的并发组限制使每个 PR 最多同时存在一个 `edited` 组和一个其他 PR 事件组，后续同组事件会取消前一次，未发现无界增长。
- **不可逆操作**：本轮只有文档改名；没有删除、覆盖或强制推送。改名可通过 diff 审阅和回退。
- **规则 / 说明 / 代码一致**：三处措辞逐条对照了 `ci.yml` 和 `check-policy.mjs`；旧编号 `0190-draft` 在仓库文本文件中已无残留；链接目标存在。发现一处低危措辞范围问题（见下）。

## 发现（按严重度）

### 低 — `docs/adr/0191-draft-pull-requests-run-fast-checks-only.md:52`

**问题**：第 2 轮把“策略检查只看作业级 `if`，不检查步骤级 `if`”改成“策略检查除 `coverage` 的下载步骤和执行步骤（要求没有 `if`）外，不检查其他步骤级的 `if`”。如果“策略检查”指整个 `scripts/ci/check-policy.mjs` 命令，这个说法不准确：该命令还调用 `validateMainWorkflow`，而它会对 `main.yml` 的某些步骤检查 `if`。如果仅指对 `ci.yml` 的检查，则说法成立。当前句子没有限定 `ci.yml`，容易被读成整个策略检查都不管步骤级 `if`。

**证据**（亲自读到）：
- `scripts/ci/check-policy.mjs:495-515` 确实只对 `coverage` 的下载步骤和执行步骤要求 `if === undefined`：
  ```js
  if (check.id === "coverage") {
    const downloads = ...;
    assert(downloads.length === 1 && downloads[0].if === undefined && ...);
    const executions = ...;
    assert(executions.length === 1 && executions[0].if === undefined && ...);
  }
  ```
- 但 `scripts/ci/check-policy.mjs:1254` 还调用：
  ```js
  validateMainWorkflow(readFileSync(path.join(root, ".github/workflows/main.yml"), "utf8"), lock);
  ```
- `scripts/ci/main-workflow.mjs:73-79`、`89-94` 检查了 `main.yml` 的步骤级 `if`：
  ```js
  discover?.run === "node scripts/ci/main-evidence.mjs discover" && !discover.if
  verify?.run === "node scripts/ci/main-evidence.mjs verify" && verify.if === "always()"
  ...
  !s.if
  ```

**建议**：把句子限定为“对 `ci.yml` 的策略检查”或“`ci.yml` 中除 `coverage` 的下载步骤和执行步骤外，不检查其他步骤级的 `if`”。若本意就是描述 `ci.yml`，这是纯措辞修改，不改代码。

### 其余三处措辞的核对结论（读代码证实）

- **`edited` 触发范围**：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:264` 改为“所有 edited 事件（改标题、正文或目标分支）”；`ci.yml:4-9` 的 `pull_request.types` 直接列了 `edited`，没有额外过滤，所以“所有 `edited`”与工作流一致。GitHub 是否在改目标分支时也发 `edited` 属于平台外部行为，见“未核实”。
- **`edited` 的资源代价**：`docs/adr/0191-...md:76` 写明会与推送运行同时占用算力、不承诺更省；`ci.yml:24-26` 的并发组把 `edited` 单独分组，`cancel-in-progress` 只对 `pull_request` 为真，`check-policy.mjs:384-401` 强制该形状，因此“互不取消、可能并行”与代码一致。
- **步骤级 `if` 的具体范围**：除上面低危的范围表述外，“只有 `browser` 和 `coverage` 可带草稿条件”“这两个条件必须逐字匹配”“`coverage` 的下载/执行步骤要求没有 `if`”都与 `check-policy.mjs:435-443`、`495-515` 一致。

## 未核实

- `document-governance` 严格校验的实际结果（作者称只剩无关的 Runbook 摘要错误）无法在本环境运行验证。
- 编号 `0191` 是否已被另一个尚未合并的 PR 占用：仓库规则要求新建 ADR 前也看未合并 PR，但离线无法核实。
- GitHub 的 `edited` 事件是否包含目标分支改动：这是外部平台行为，仓库内无法证明；ADR `0191:54` 自己也注明 `github.event.changes.base` 的形状未在本机核实。
- 作者称的“825 通过 0 失败”未实际运行（工具限制只允许读文件和少数 git 命令）。
- `.claude/rules/prompt-prefix.md` 不在当前稀疏检出中，未直接读到该规则文件。

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。本轮只改 `docs/adr/`、`docs/execution/specs/` 和复核记录；这些文件不在模型提示词、工具定义或历史消息的组装代码里。我在 `packages/` 下检索 `docs/adr`、`docs/execution` 没有命中，改动也没有触碰任何 prompt 构造代码。因此“只在末尾追加、每轮变化值在最后一条消息”的前提未被本改动改变。规则文件本身未读到（见“未核实”）。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。本轮没有改遮盖逻辑；ADR 的 `date` 是固定字符串，`0191` 是固定编号。整体 PR 里唯一随请求变化的值是 CI 并发表达式中的 `github.run_id`，那是 CI 并发键，不是发给模型的文字。

3. **有没有对应的自动检查，反向用例会不会真的失败？**
   - 三处措辞：没有自动检查把文档文字和代码行为对比，只能人工核对；本轮的核对结果如上。
   - ADR 改号：`npm run check:adr-numbers` 会检查 `docs/adr/` 文件名的“四位编号-小写短名.md”格式和编号唯一性（`scripts/check-adr-numbers.mjs:8,23-27`），测试里有真实的失败用例：重复编号会报 `ADR_NUMBER_DUPLICATE` 并以 1 退出（`test/tooling/adr-numbers.test.mjs:29-41,55-66`），且“本仓库通过”也有用例（同文件 `80-82`）。但它**不检查 ADR 标题里的编号和跨文档链接**，这两项本轮靠人工核对。
   - 整体 PR 的 CI 行为：`test/tooling/policy.test.mjs:407-430,472-495` 已有反向变异用例（去掉 `edited` 并发段、把 `edited` 段改成 `run_id`、给 `policy` 加草稿条件、删除 `browser` 的草稿条件），从测试代码看会触发断言失败；未实际运行。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - 产生/修改的值：文件名前缀 `0191`、ADR 标题 `ADR 0191`、设计文档中的链接 `../../adr/0191-draft-pull-requests-run-fast-checks-only.md`。
   - 使用方核对：
     - `scripts/check-adr-numbers.mjs:8` 的正则 `^(\d{4})-[a-z0-9][a-z0-9-]*\.md$` 接受 `0191-draft-pull-requests-run-fast-checks-only.md`。
     - 设计文档链接解析到 `docs/adr/0191-draft-pull-requests-run-fast-checks-only.md`，文件存在；ADR 标题与文件名编号一致（`0191:11`）。
     - `amends: "docs/adr/0176-ci-on-ovh-vps.md"`、关联文档 `0176`、`0189` 和设计文档路径都存在。
     - 全仓库检索 `0190-draft` 已无结果；现存 `0190` 只属于 main 上 PR 322 的 `0190-mask-registered-test-values-in-review-records.md`，与本 PR 不再冲突。`0191-draft` 只出现在设计文档的链接和 ADR 标题。
   - 结论：两端都接受，没有遗漏的旧编号或坏链接。

## 总结

未发现中、高危问题。ADR 改号完整、无旧编号残留、链接可达；三处措辞中两处与代码一致，一处（`0191:52` 的“策略检查不检查其他步骤级 `if`”）存在低危的范围表述过宽，建议限定为 `ci.yml`。
