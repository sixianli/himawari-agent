## 读代码证实的问题（按严重度）

### 1. [中] 恢复失败时“排队任务继续等待”的提示在部分成功/撤销暂停场景下不成立

- 文件:行：`scripts/operations/hermes-runner/resume-runners.sh:36`、`scripts/operations/hermes-runner/resume-runners.sh:28`、`scripts/operations/hermes-runner/runner-resume.sh:15`
- 问题：`runner-resume.sh` 逐个启动服务，前一个启动成功后如果后一个失败就直接退出；此时已启动的 runner 处于 active，可能已经能领取排队任务。但 `resume-runners.sh` 固定打印 `queued jobs keep waiting`，Runbook 也写“这几种情况下排队的任务都继续排队，不会失败”。
- 证据：
  - `resume-runners.sh:36`：`[ "$STATUS" = 0 ] || { echo "RUNNER_RESUME_FAILED services=$(service_states) labels=restored; queued jobs keep waiting"; exit 1; }`
  - `runner-resume.sh:15-17`：`for unit in $UNITS; do ... systemctl start "$unit" || { ...; exit 1; }; done`
  - 测试本身就构造了“一个 active、一个 failed”的两服务状态（`test/tooling/hermes-runner-scripts.test.mjs:556`），所以这不是理论情况。
  - 另外，`pause-runners.sh:76,81` 和 Runbook 都允许在“暂停未完成、服务还在跑”时运行 `resume-runners.sh` 撤销；这种情况下第 28 行的 `services not started` 也不是事实：服务本来就在运行。
- 建议：消息不要写死，按 `service_states` 的实际结果区分“全部未启动/部分 active”；部分 active 时应说明“active 的 runner 可能领取排队任务”。同时补一条“已经有一个服务 active 时撤销暂停”的测试。

### 2. [中] 15 秒例外与 `.agents` 硬规则、架构文档、执行规格冲突

- 文件:行：`.agents/instructions/test-and-production-hosts.md:14`、`vitest.workspace.ts:46`、`docs/architecture-v0.1.md:621`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:151`
- 问题：代码已把 `tooling` 的单条测试时限设为 15 秒，但给代理的硬规则仍说“不放宽测试时限”，架构文档和执行规格仍说只有 integration 是 30 秒、其他项目都是 Vitest 默认 5 秒。这些是同一个配置值的其他消费者，没有同步。
- 证据：
  - `.agents/instructions/test-and-production-hosts.md:14`：`不要放宽测试时限，也不要设置 HIMAWARI_TEST_TIMEOUT_MS；...`
  - `vitest.workspace.ts:46`：`...(project.id === "tooling" ? { env: toolingEnvironment, testTimeout: 15_000 } : {})`
  - `docs/architecture-v0.1.md:621`：`integration 仍为 30000ms，未自设时限的项目使用 Vitest 默认 5000ms`
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:151`：`没有自设时限的项目仍使用 Vitest 默认 5000ms，integration 保留原 30000ms`
  - 与本次已更新的 `docs/runbooks/test-host-operations-runbook.md:61`、ADR 0168 决定第 3 条不一致。
- 建议：同步修改 `.agents/instructions/test-and-production-hosts.md`，明确写 `tooling = 15s` 是 ADR 0168 授权的唯一例外；架构文档和执行规格要么更新，要么标注为历史记录并指向 ADR 0168。

### 3. [低] ADR 0169 的测试说明仍描述旧恢复顺序

- 文件:行：`docs/adr/0169-pause-runners-by-removing-the-label.md:105`
- 问题：ADR 的决定和后果已改成“先加标签、再启服务”，但测试清单仍写“恢复时先上线再加标签”，与当前测试和代码相反。
- 证据：
  - `docs/adr/0169-pause-runners-by-removing-the-label.md:105`：`...恢复时先上线再加标签、锁。`
  - `docs/adr/0169-pause-runners-by-removing-the-label.md:67`：`恢复先对账，再加标签，最后启服务。`
  - `test/tooling/hermes-runner-scripts.test.mjs:499`：`puts the label back before starting the services so queued jobs match when the runners connect`
- 建议：把第 105 行改成“恢复时先加标签再启服务”。

### 4. [低] 新加标签后的 GitHub 确认读失败分支没有专门测试

- 文件:行：`scripts/operations/hermes-runner/resume-runners.sh:24-31`、`test/tooling/hermes-runner-scripts.test.mjs:599`
- 问题：新增了一次 GitHub 读取来确认标签（第 24 行），失败时把 `TABLE` 置空并走 `unread` 分支不启动服务。现有测试 `fail-list-from 3` 只覆盖启动后的在线等待读取失败；没有测试 `fail-list-from 2` 这种“标签刚加完、确认读取失败”的路径。
- 证据：
  - `resume-runners.sh:24-28`：`TABLE=$(github_runners) || TABLE=""`、`STATES=$(label_states ...)`、`*=off\ * | *=unread\ *` 时打印并退出。
  - 测试里只有 `box.set("fail-list-from", 3)`（`test/tooling/hermes-runner-scripts.test.mjs:599`）。
- 建议：增加一条确认读取失败的用例，断言退出码 1、没有调用 `runner-resume.sh`、消息为 `unread`；再增加一条“服务原本已经 active”的撤销暂停用例。

## 推测与未核实风险

### [中] 核心前提在仓库材料里是“推断”，不是作者所说的 GitHub 文档结论

- 作者材料写“GitHub 文档：只派给 online 且 idle 的匹配 runner”“runner 离线时带着标签也不会被派任务”；但同一 PR 的 ADR 自己写的是推断，而且没有官方文档。
- 证据：
  - `docs/adr/0169-pause-runners-by-removing-the-label.md:104`：`推断：GitHub 在 runner 连上时按当时的标签匹配排队任务，之后补加标签不会重新匹配（没有找到官方文档）... 新顺序还没在 Hermes 上实测。`
  - 测试只用假的 `gh` 和 `hermes-ssh.sh`（`test/tooling/hermes-runner-scripts.test.mjs:224` 起），只能验证调用顺序，不能验证 GitHub 的真实匹配行为。
- 结论：这条改动本身不破坏安全边界（runner 离线时带标签通常不会执行任务），但“根据 GitHub 文档”这一说法与仓库材料不一致，核心行为仍未在真实 Hermes 上验证。建议合并前在 Hermes 上做一次“离线带标签 → 启动 → 看排队任务是否派发”的实测，或明确标记为实验性改动并保留回退办法。

## 侧重检查

- 错误路径：
  - 对账失败、上传失败、`gh` 初次读取失败：都在加标签/启动前退出，行为安全，未改变。
  - 加标签失败：代码会在确认后阻止启动服务，测试覆盖了“第二个标签加不上”的情况，结论正确。
  - 加标签后的确认读取失败：安全地不启动服务，但没有专门测试（见问题 4）。
  - 部分服务启动失败：保留已启动的服务和已恢复标签，可能领取排队任务，但提示语说“继续等待”（见问题 1）。
  - Ctrl-C/TERM/HUP：正常暂停状态下服务已停，部分标签被恢复也不会执行任务；若是在“撤销未完成暂停”时中断，服务可能本来就在运行，报告里的“services not started”同样可能不准确。
- 不合规范或不可信的输入：`NAMES` 来自 Hermes，`TABLE` 来自 GitHub API；后续通过 `awk`、`case`、`echo` 使用，没有 `eval` 或把名称拼进 shell 命令，未发现注入路径。未用畸形 runner 名做模糊测试，标“未核实”。
- 安全：没有新增密钥、令牌或提权操作；`INSTALL_STEP_FAILED` 打印的是脚本内的静态命令，未见敏感值。新增标签操作可逆。
- 资源耗尽：新增一次 `gh api --paginate`，相对原有调用可忽略；恢复等待仍有 300 秒上限，没有新增无界循环。
- 不可撤销操作：加标签可撤销；`install-runner.sh` 的备份/恢复逻辑未被改坏。新顺序依赖“离线 runner 不接任务”，这一前提未在真实环境验证。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 没有改 `packages/runtime-pi/`、系统提示、工具定义、历史消息存储或出口遮盖逻辑；改动集中在运维脚本、Vitest 配置、测试和文档。脚本中新出现的标签状态、服务状态、`$LINENO`/`$BASH_COMMAND` 只写到 stdout/stderr，不进入模型输入。因此发给模型的内容仍只在末尾追加，每轮变化的值没有进入系统提示或历史。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。未运行 `npm run check:prompt-prefix`，这一点属于静态核对。
2. **不会让同一段文字在不同请求里变成不同字节。** 没有改遮盖、序列化、数组/集合排序或时间字段进入模型请求的代码。新增的 `INSTALL_STEP_FAILED line $LINENO ... $BASH_COMMAND` 是安装脚本 stderr，不是模型输入；它本身会随行号和失败命令变化，但没有进入请求内容。
3. **有自动检查，反向用例在旧代码上按静态核对应当失败，但没有实际执行。** `test/tooling/hermes-runner-scripts.test.mjs` 覆盖了新顺序、标签加不上时不启动、服务失败/未上线时的标签报告；`install-runner.sh` 的测试要求 `INSTALL_STEP_FAILED`；`test-timeout.test.mjs` 要求 `tooling = 15_000`。按旧脚本和旧配置静态比对，作者说的“旧 resume 新测试 6 条失败、旧 install 断言失败、旧 vitest 配置断言失败”是成立的。但“确认标签读取失败”和“撤销时服务已 active”没有反向用例；而且这些测试只验证调用顺序，不验证 GitHub 真实行为。测试未在本环境实际运行。
4. **逐个核对改动值：**
   - `labels=restored` / `RUNNER_RESUME_*`：测试和 Runbook 已更新；未发现自动解析这些字符串的脚本。但 Runbook 的“排队任务都继续排队”和脚本的 `queued jobs keep waiting` 在部分服务 active 时是错的（问题 1）；ADR 0169 第 105 行仍是旧顺序（问题 3）。
   - `INSTALL_STEP_FAILED line/exit/command`：Runbook 第 124 行已补充，测试断言存在，未发现其他下游解析器。测试只覆盖了命令显示为 `return 1` 的情况，未覆盖顶层外部命令失败。
   - `testTimeout: 15_000`：`vitest.workspace.ts` 和 `test-timeout.test.mjs` 能接受；ADR 0168、测试主机 Runbook 已更新。但 `.agents/instructions/test-and-production-hosts.md:14`、`docs/architecture-v0.1.md:621`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:151` 仍写“不放宽/默认 5000”，属于未同步的消费者（问题 2）。
   - `G18/G19/G20` 清单项：`goal.md` 有对应标题，`items.json` 的 `decisions` 已加入；现有 `items` 没有引用它们，我在仓库内没有找到校验 `items.json` 的脚本，标“未核实”。
   - Runbook 的 `contract_sha256`：已随 `scripts/operations/hermes-runner` 变更更新；严格文档校验未运行，哈希是否正确标“未核实”。
   - 新增的 `.agents/reviews/topic-policy-migration/*`：属于复核记录，不参与生产请求构造；其具体内容因复核环境的记录保护未能读取，标“未核实”。
