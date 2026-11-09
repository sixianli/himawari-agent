## 读代码证实的发现

**1. 高 — `.github/workflows/ci.yml:25`（另见 `docs/adr/0190-draft-pull-requests-run-fast-checks-only.md:51,76`）：`edited` 运行用 `run_id` 做组后缀，导致所有 edited 运行彼此不取消、也永远不被后续运行取消**

证据：并发组末尾是 `-${ github.event.action == 'edited' && github.run_id || '' }`，而 `cancel-in-progress` 仍是 `${{ github.event_name == 'pull_request' }}`。每个 edited 事件的 `run_id` 都不同，于是每个 edited 运行落在不同并发组，`cancel-in-progress` 对它们没有可取消的同组对象，等于失效。改一次标题或正文就新增一轮完整 CI（`browser` 90 分钟 + `coverage` 60 分钟），而 `ci.yml` 没有 `push` 触发器，也没有别的 PR 运行能打断它。ADR 只写“偶尔会多出一轮完整 CI”，没有覆盖连续编辑造成的无上限堆积；自托管只有两个 runner，旧 edited 运行会挤占 `ready_for_review` 的完整运行，这是一条现实的资源耗尽路径。

建议：把后缀改成固定标记，例如 `github.event.action == 'edited' && 'edited' || ''`。这样 edited 仍不与 synchronize/ready_for_review 互相取消，满足 ADR 的目标，但后一个 edited 会取消前一个 edited，最多保留一轮。

**2. 中 — `docs/adr/0190-draft-pull-requests-run-fast-checks-only.md:51,54` 与 `.github/workflows/ci.yml:194,273` 不一致：文档说 `edited` 一律完整运行，代码在草稿 PR 上会跳过 `browser`/`coverage`**

证据：ADR 第 54 行写“`edited` 事件一律完整运行”，第 51 行写“改标题仍会多跑一轮完整 CI”；但两个作业的条件只看 `github.event.pull_request.draft`。草稿 PR 的 `edited` 事件里 `draft` 仍为 true，因此实际只跑快检查。另外第 52 行“只有 `browser` 和 `coverage` 可以带 `if`”也不严谨：`required` 必须带 `if: always()`（`scripts/ci/check-policy.mjs:433-437`）。

建议：把 ADR 改成“非草稿 PR 的 edited 运行完整执行”，或明确草稿上的 edited 只跑快检查；把“只有这两个作业可以带 if”改成“只有这两个可跳过的作业可以带 draft 条件”。

**3. 中（既有缺口，非本次引入，但本次把 check-policy 当作硬保证依赖）— `scripts/ci/check-policy.mjs:438-443,469-489`：只校验作业级 `if`，不校验步骤级 `if`**

证据：作业级断言在 `438-443` 行；步骤循环只检查 `continue-on-error`、`run` 里的 `${{`、action SHA 和 checkout 凭据，没有检查 `step.if`。因此给 `security`、`static`、`policy` 或 `browser` 的执行步骤加 `if: false`，不会被策略检查直接拒绝。`browser` 也没有像 `coverage` 那样对 `run.mjs` 执行步骤做精确断言（`495-514` 行只覆盖 coverage）。补充：`required` 汇总要求每个 member 都有报告（`scripts/ci/aggregate.mjs:172-176`），删掉执行步骤通常会让汇总失败，所以能否用步骤级 `if` 精确绕开而保持报告齐全，我没有构造验证，标为未核实。

建议：对必须执行的步骤也断言 `if` 缺失或等于允许值，或复用 `quality-policy.mjs` 的结构化比较方式。

## 推测与未核实

- **推测**：草稿运行产生失败的 `ci/required`，`ready_for_review` 又对同一 head SHA 产生成功的 `ci/required`；GitHub 分支保护在多个同名 check run 之间如何选取（按完成时间还是启动时间）我没有核实，理论上旧的草稿失败运行若后完成，可能影响合并判定。实际完整运行通常更晚完成，风险较低。
- **未核实**：作者说的“Hermes 上 822 个测试通过”未运行验证；“真实 ci.yml 通过 policy 检查”只核对了字符串逐字一致，未实际执行 `check-policy.mjs`。

## 侧重检查

- **错误路径与不可信输入**：新的 `if` 与并发表达式都是常量字符串，不插入 shell；YAML 使用 `uniqueKeys`。但步骤级 `if` 未被约束（发现 3）。
- **资源耗尽**：发现 1 是主要问题；草稿跳过确实减少常规负载，但 `edited` 可无限触发且不可取消，会占满两个 runner 并拖慢转为正式后的完整运行。
- **不可撤销操作**：CI 只读权限、只上传 1 天期 artifact，没有部署或发布，没有新增不可逆动作。
- **安全**：权限仍是 `contents: read`、`pull-requests: read`，不引用 secrets；草稿跳过不涉及 `policy`/`security` 作业。步骤级 `if` 缺口会削弱策略闸门。
- **文档/规则一致**：设计文档第 264 行与代码的草稿跳过行为一致；ADR 的 edited 全量运行说法与代码不一致（发现 2）；本改动不涉及提示词规则。

## 必答问题

1. **不会改变模型请求开头。** 改动只涉及 CI 工作流、CI 脚本、测试和文档，没有任何系统提示、工具定义、历史消息或遮盖代码被修改；发给模型的内容仍然与追加规则无关。未运行验证，但 diff 足以确认没有触碰这些路径。

2. **不会。** 没有修改序列化、遮盖、键序或集合排序；并发表达式只影响 GitHub Actions，不会进入模型请求。

3. **有自动检查，但只覆盖文本契约。** `test/tooling/policy.test.mjs:454-475` 新增 3 个反向用例：`other condition on coverage`、`draft condition on policy`、`missing draft condition on browser`。对照 `check-policy.mjs:438-443`，三者都会触发断言失败；真实 `ci.yml` 的条件字符串和并发字符串与 `check-policy.mjs:26-28,384-392` 逐字一致。草稿 `ci/required` 必失败也有既有测试覆盖（`test/tooling/aggregate.test.mjs:131-146` 对 `skipped` 上游断言失败）。但 `ready_for_review` 是否真的取消草稿运行、`edited` 是否真的不取消，属于 GitHub 运行时行为，自动检查无法验证；也没有单元测试直接对真实 `ci.yml` 调用 `validateWorkflow`。

4. **逐个核对结果：**
   - `browser`、`coverage` 两个 ID 在 `ci/policy.json` 中存在，与 `DRAFT_SKIPPED_CHECKS` 一致；三处条件字符串同值。
   - 并发组表达式在 `ci.yml:25`、`check-policy.mjs:384-392`、测试夹具 `policy.test.mjs:95-103` 三处一致，GitHub 接受这些表达式。
   - `ci/required` 的消费方 `aggregate.mjs:48-55` 只接受 `success`，所以草稿的 skipped 结果必然失败，ADR 说法成立。
   - `main-evidence.mjs:96,103` 只接受 `conclusion === "success"` 的 PR 运行，草稿失败运行不会成为 main 证据，ADR 说法成立。
   - ADR 文件名符合 `check-adr-numbers.mjs` 的格式，编号 0190 未被占用，frontmatter 与其他 ADR 一致，链接目标都存在。
   - **不一致处**：ADR 对 `edited` 全量运行的描述与代码不符（发现 2）；“只有 `browser`/`coverage` 可以带 `if`”与 `required` 的 `always()` 不符。
