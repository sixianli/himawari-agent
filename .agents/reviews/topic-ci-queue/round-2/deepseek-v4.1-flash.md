## 结论

方案的主方向（给 `ci/required` 一个专用小 runner）是对的，能解掉“草稿/被取消的运行仍占一个 runner”这个主因；但按现在这份方案实施，有几个会直接卡住上线或卡住回滚的问题：**PR B 合并后旧的开着的 PR 会全部过不了 `policy` 检查**、**方案声称的回滚（把 required 改回 ci-vps）会被自己新加的硬规则拒绝**、**升级函数的顺序/历史 shape 很容易写错**、**对暂停/恢复/卸载/清理脚本现状的描述有事实错误**。另外，新增的 `ci-vps-gate` 这个值没有按 I-73 的教训做“产生端 ↔ 使用端”的统一校验。建议先改方案，再动手。

以下只做了只读核对，没有执行测试；GitHub 的实时排队数据（方案前提 7、11）无法在这个环境核实。

---

## 一、证实的发现（按严重度）

### 1. 高：PR B 合并后，所有基于旧 main 的开着的 PR 会过不了 `policy` 检查

**问题**
`check-policy` 会同时用“目标分支上的策略”校验“PR 检出里的工作流”：

- `scripts/ci/check-policy.mjs:1358-1368`：
  - `source = resolvePolicySource({ root, base: args["--base"] ?? "HEAD" })`
  - `validateWorkflow(source.policy, readFileSync(workflow, "utf8"), lock)`
- 对 `pull_request`，`scripts/ci/context.mjs:97-108` 把 `baseSha` 设为合并提交的第一个父提交，也就是该 PR 上次同步时的目标分支。
- 如果新加一个 `upgradeGateRunnerPolicy` 把旧策略里的 `required.runner` 从 `ci-vps` 升级成 `ci-vps-gate`，那么一个**基于旧 main、工作流还是旧 `ci.yml`（required 在 `ci-vps`）的 PR**，会在 `check-policy.mjs:474` 的
  `job["runs-on"] === check.members[0].runner`
  上失败：升级后的策略要求 `ci-vps-gate`，旧工作流写的是 `ci-vps`。
- `main.yml` 同理：`check-policy.mjs:1366` 调 `validateMainWorkflow(mainWorkflow, lock)`，而 `scripts/ci/main-workflow.mjs:77` 会要求 plan 的 runner；PR B 把 plan 改到 `ci-vps-gate` 后，旧 PR 的 `main.yml` 仍是 `ci-vps`，同样失败。

方案只写了“让目标分支还是旧策略的这一个 PR 自己能过”（前提 9），没有处理“新策略已经进 main、旧 PR 还没 rebase”的过渡期。ADR 0241 又要求合并前等 `ci/required` 变绿，所以这会把所有旧 PR 一起卡住。

**建议**
三选一，并在方案里写清楚：
1. 在 `check-policy` 加**一次性过渡例外**：当基准策略和当前工作流都恰好是旧 shape 时，用原始（未升级）策略校验旧工作流；新策略/新工作流仍走新规则。过渡期结束后再发一个 PR 删掉例外。
2. PR B 合并前/后强制所有开着的 PR 合并 main 或 rebase，并把这条写进上线步骤和验证。
3. 不要动 `main.yml` 的 plan（见第 7 条），至少把 `main.yml` 这一半的破坏面去掉。

必须补测试：旧策略 + 旧工作流、旧策略 + 新工作流、新策略 + 新工作流三种组合都要有明确期望。

---

### 2. 高：方案声称的回滚路径会被新加的硬规则拒绝，gate 停机时可能无法回滚

**问题**
方案风险一节写“回滚是把 `required` 改回 `ci-vps`”。但同一份方案又要加硬规则“汇总作业只能在 `ci-vps-gate` 上跑，检查作业只能在 `ci-vps` 上跑”。这条规则会同时出现在：

- `scripts/ci/check-policy.mjs:323` 的 `validatePolicy`；
- `check-policy.mjs:443-476` 的 `validateWorkflow`（`required` 的 `runs-on` 必须等于策略成员）；
- `scripts/ci/main-workflow.mjs:77`（如果 plan 也改了）。

那么一个“把 required 改回 ci-vps”的回滚 PR，会被 `policy` 检查判失败；而它的 `ci/required` 如果还在等已经停掉的 `ci-vps-gate`，按 ADR 0241 决定第 4 条又不能合并。结果就是：**gate 一停，回滚 PR 既过不了 policy，也等不到 required，只能靠 Andy 用 `scripts/delivery-mode/github-ruleset.sh` 临时放宽规则集，或明确说“这次不等 CI”**。

**建议**
- 把“回滚”写成完整步骤：Andy 用 `github-ruleset.sh` 临时恢复快速模式（或明确授权本次不等 CI）→ 合并回滚 PR → 再恢复规则集。
- 或者让校验器在过渡期允许 required 使用 `ci-vps` 或 `ci-vps-gate` 两者之一；等新 runner 稳定后再收紧。
- 或者保留一条明确的 `ci-vps` 回退作业/检查，不要让 gate 成为唯一能产生 `ci/required` 的 runner。

---

### 3. 高：升级函数的顺序和历史 shape 陷阱，可能让 PR B 自己或更老的基准过不了

**问题**
`scripts/ci/check-policy.mjs:1190-1192` 当前的升级链是：

```js
upgradeRetiredTestChecks(
  upgradeArtifactRetention(upgradeRunnerLabel(upgradeHostedRunnerPolicy(JSON.parse(bytes)))),
)
```

而 `check-policy.mjs:140-166` 的 `ciVpsDefaultMember` 和 `retiredShapeChecks.required` 都写死 `runner: linuxRunnerLabel`（即 `ci-vps`）。

如果实现时为了“新策略 required 是 gate”而顺手改 `ciVpsDefaultMember`，或者把 `upgradeRunnerLabel`/`upgradeHostedRunnerPolicy` 的映射目标改成 gate，那么：

- 旧的 9 作业策略（`test`、`node-floor`）不再匹配 `retiredShapeChecks`，`upgradeRetiredTestChecks` 不会升级；
- 旧的 hermes-home 策略、旧的 hosted 策略也会被升级成 `ci-vps`，然后 `validatePolicy` 因 required 必须是 gate 而拒绝；
- 结果可能连 PR B 自己的基准都过不了。

方案只说“加一个升级函数”，没有规定顺序，也没有说要保留 `ciVpsDefaultMember` 的旧值。

**建议**
- 新增独立的 `gateRunnerLabel`；
- 新增 `upgradeGateRunnerPolicy`，**放在整条升级链的最外层（最后执行）**；
- `ciVpsDefaultMember`、`retiredShapeChecks`、`upgradeRunnerLabel`、`upgradeHostedRunnerPolicy` 保持只产生 `ci-vps`；
- 对 hosted、hermes-home、九作业、当前七作业四种基准各写一条升级测试；混写、macOS 未暂停、时限不对各写一条拒绝测试。

---

### 4. 高：方案对暂停/恢复/卸载/清理脚本的现状描述有事实错误，按它改会漏改或改错

**问题**
方案说“暂停、恢复、卸载、清理脚本从‘一个全局标签’改成‘每个 runner 自己的标签’”。实际代码是：

- `scripts/operations/ci-runner/register-runner.sh:11-14` 只接受 `1|2`；不改成 3，`register-runner.sh 3` 直接退出码 64。
- `scripts/operations/ci-runner/uninstall-runner.sh:10-14` 只接受 `2|all`；不改成 3，`uninstall-runner.sh 3` 退出码 64。
- `scripts/operations/ci-runner/clean-old.sh:9-23` **根本不用标签**，只用 `installed_runner_ids`；它需要的是 `RUNNER_IDS` 加 3，不是“每个 runner 自己的标签”。
- `uninstall-runner.sh` 也不用标签，只用 runner id/unit；它需要的是 case 加 3 和 `RUNNER_IDS`。
- 真正用全局标签的是 `scripts/operations/ci-runner/mac-runners.sh:4` 的 `LABEL=$RUNNER_LABEL`，以及 `:37-91` 的 `has_label`/`reconcile_runners`/`label_states`/`add_label`/`remove_label`。Mac 侧没有 runner id 的概念，只有 runner 名字；要按 runner 区分标签，必须新增 name→label 映射，不能简单把 `RUNNER_LABEL` 改成“每个 runner 自己的”。

方案还漏了：

- `scripts/operations/ci-runner/runners.sh:1-30` 的 `RUNNER_IDS`、`runner_select 3`、`RUNNER_USER`/`RUNNER_ROOT`/`RUNNER_UNIT`/`RUNNER_OTHER_ROOT`；
- `scripts/operations/ci-runner/install-runner.sh:22-34` 会自动遍历 `RUNNER_IDS`，所以加 3 会重新渲染 1、2 的服务单元——这会动到现有 runner，不是“现有 CI 不受影响”；
- `scripts/operations/ci-runner/runner-pause.sh:25` 的提示语仍写 `$RUNNER_LABEL`；
- `scripts/operations/ci-runner/prepare-vps.sh` 的 needrestart 正则虽能匹配 `gh-runner-gate`，但运行手册的预检只列 1/2。

**建议**
把 PR A 的改动清单写成逐文件、逐函数：
- `runners.sh`：`RUNNER_IDS="1 2 3"`，`runner_select 3` 设置 name/user/root/unit/other-roots/label；`RUNNER_LABEL` 改成每个 case 里设置；
- `register-runner.sh`：`case 1|2|3`，仍用 `--labels "$RUNNER_LABEL"`；
- `install-runner.sh`：遍历 3，模板多路径/内存占位符；
- `uninstall-runner.sh`：`case 2|3|all`，usage 更新；
- `clean-old.sh`：无需标签改动，只靠 `RUNNER_IDS`；
- `mac-runners.sh`：新增 `runner_label_for_name`（或从 name 推导），`has_label` 接受标签参数，`reconcile_runners`/`label_states`/`add_label`/`remove_label` 都按 runner 的标签工作；
- `runner-pause.sh`/`runner-resume.sh`：消息和逻辑按每个 runner 的标签；
- 运行手册：安装/注册/预检/验证/回滚全部加 3。

---

### 5. 高/中：新增的 `ci-vps-gate` 值没有按 I-73 做“产生端 ↔ 使用端”的统一门

**问题**
I-73 的教训是：清单里产生的 id 必须能通过后端校验；双模型复核只看了改动，没问“这个值两端都认吗”（`docs/incidents-and-gates.md:112`）。这次的新值是 `ci-vps-gate`，产生端/使用端至少有：

- 产生：`scripts/operations/ci-runner/runners.sh:2-3` 的标签定义、`register-runner.sh:29` 的 `--labels`；
- 使用：`ci.yml:327` 的 `runs-on`、`main.yml:18` 的 plan、`.github/actionlint.yaml:3`、`ci/policy.schema.json:64`、`ci/policy.json` 的 required 成员、`mac-runners.sh` 的暂停/恢复。

现有测试 `test/tooling/ci-runner-scripts.test.mjs:319-332` 只检查一个全局 `RUNNER_LABEL=${linuxRunnerLabel}` 和 `register-runner.sh` 的 `--labels "$RUNNER_LABEL"`；它没有检查：

- `runner_select 3` 产生的标签到底是 `ci-vps-gate` 而不是 `ci-vps`；
- 暂停时 3 号被去掉的是 `ci-vps-gate`，而 1/2 被去掉的是 `ci-vps`；
- 恢复时 3 号只加回 `ci-vps-gate`，不会被加回 `ci-vps`（否则检查作业会落到 gate 上）；
- `mac-runners.sh` 的 name→label 映射和 `runners.sh`/`contracts.mjs` 一致。

如果任何一端写错，最坏结果是 gate 带上了 `ci-vps`，检查作业落到 gate 上，方案的目标直接失效；或者暂停后 gate 标签还在，GitHub 仍把 `ci/required` 派给已停的服务。

**建议**
加一条专门的跨端契约测试（可以放在 `ci-runner-scripts.test.mjs` 或新文件）：
- 读 `runners.sh`、`contracts.mjs`、`ci/policy.json`、`ci.yml`、`main.yml`、`.github/actionlint.yaml`、`ci/policy.schema.json`；
- 断言 3 号标签是 `ci-vps-gate`、1/2 是 `ci-vps`、gate 不含 `ci-vps`；
- 断言暂停/恢复对每个 runner 只操作自己的标签；
- 反向用例：把 3 号标签写成 `ci-vps`、把恢复写成加 `ci-vps`、把 actionlint/schema 漏掉，都必须失败，并且断言具体错误信息，不要只 `toThrow()`。

---

### 6. 中：gate 没有资源隔离，2 GB 不是“保留”，可能被检查作业的 OOM 杀掉

**问题**
- `scripts/operations/ci-runner/gh-runner.service.in:25-27`：每个 runner `MemoryHigh=14G`、`MemoryMax=15G`；
- `scripts/operations/ci-runner/gh-runners.slice:6-9`：整个 slice `MemoryHigh=19G`、`MemoryMax=20G`、`TasksMax=4096`；
- 方案给 gate 2 GB，但 gate 仍在同一个 slice 里，2 GB 只是它自己的上限，不是预留。两个检查作业各吃到 15 GB 时，slice 到 20 GB，OOM killer 可能选中 gate；gate 是合并闸门，被杀一次就卡住所有合并。
- `TasksMax=4096` 与三个 runner 各 `2048` 相加是 6144；三个作业同时跑时，slice 可能先卡住 gate 的 fork。
- `scripts/operations/ci-runner/job-started.sh:9` 的 16 GiB 底线是按“两个任务可能同时占盘”定的；现在可能三个作业同时占盘。
- 方案前提 12 只量了 policy 的 2.68 GB，没有量 gate 的峰值；`ci/required` 要 checkout、setup-node、install-tools、install-gate-dependencies、collect、required.mjs，2 GB 是否够**未核实**。

**建议**
- 给 gate 单独 slice（例如 `gh-gate.slice`，`MemoryMin=2G`、`MemoryHigh=2G`、`MemoryMax=2G`、`TasksMax=512`），检查 runner 的 slice 降到 18 GB；
- 或者至少给 gate 设 `MemoryMin`/`OOMScoreAdjust`，并监控 `memory.events` 的 `oom_kill`；
- 加 `TasksMax` 预算：要么提高 slice，要么给 gate 更小的 TasksMax；
- 量 gate 的峰值内存、磁盘、进程数，再定 2 GB 和 16 GiB 底线；不要凭 policy 的 2.68 GB 推断。

---

### 7. 中：把 `main.yml` 的 plan 移到 gate 是单点故障，而且它不是瓶颈；第 2 步的效果被说大了

**问题**
- `main.yml:16-18` 的 plan 只跑 `main-evidence.mjs` 和 `ci-summary`，方案自己说约 15 秒；它不是 13 分钟队列的来源。
- 移到 gate 后，gate 停/维护时 main 的 plan 也排不上；第 2 步又把 main 并发组改成固定组并取消 pending，连续 push 时可能出现“没有一次 main 确认跑完”的情况。方案只说了 PR 合并被卡，没有说 main 确认也被 gate 单点卡住。
- 第 2 步说“main 确认不再和 PR 抢 runner”不准确。GitHub 的并发组只在**同一组**内生效；固定 `main-confirmation` 只是把 main 自己的多次运行去重，main 的 `full`/`confirm` 仍然和 PR 作业抢那两台 `ci-vps`。GitHub 文档原话：“there can be at most one running job or workflow in a concurrency group at any time”“By default, any existing `pending` job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place”；`cancel-in-progress: false` 不会取消正在跑的那个（https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency）。
- 连续合并时，`cancel-in-progress: false` 会保留正在跑的一次，但最新 pending 会被后来的 push 不断顶掉；如果合并频率高于一次 `full` 的时长，最新提交可能一直轮不到。方案只写了“正在跑的跑完，还在等的只留最新一次”，没有写这个后果。

**建议**
- **不要移动 `main.yml` 的 plan**，保持在 `ci-vps`；它便宜且不是瓶颈，移走只会增加单点。
- 如果第 2 步要做，优先只对 `full`/`confirm` 加作业级固定并发组，让 `plan` 对每个提交都留下记录；或者至少用 `${{ github.workflow }}-main-confirmation` 做组名，避免和其他 workflow 冲突。
- 把效果描述改成“减少 main 的重复运行”，不要写“不再和 PR 抢 runner”。
- 验证第 2 步时不要只断言“第一次还在等的确认被顶掉”；如果第一次已经在跑（`cancel-in-progress: false`），它不会被取消。要构造 runner 忙、run 处于 pending 的状态，或直接测试 YAML/validator。

---

### 8. 中：安全边界没有改善，gate 仍然执行 PR 代码，且和检查作业共享共享目录

**问题**
`ci/required` 会 `actions/checkout` PR 的合并提交，然后执行该提交里的 `scripts/ci/required.mjs` 和 `install-gate-dependencies.mjs`（`ci.yml:350-366`）。也就是说，**gate 上跑的是 PR 代码**，不是“可信的汇总器”。一个恶意 PR 可以改 `required.mjs`，伪造 gate 日志，或直接读取 gate runner 的注册凭证。`gh-runner.service.in:12` 又让所有 runner 都属于 `gh-ci-share`，能读写 `/srv/gh-runner-share`（运行手册第 61、66 行也承认这一点：仓库私有、只接受 Andy 和代理线程推送，所以接受这个风险）。

这不是本方案引入的，但方案把 `ci-vps-gate` 说成“只跑汇总作业的小 runner”，容易让人以为它更可信；实际上它和检查 runner 在同一个信任域，且更小（2 GB）更容易被 PR 代码 OOM。**建议**：
- 在方案里明确“这个 gate 不提升信任边界，原有风险不变”；
- 如果要提升：gate 从 base SHA 取 `required.mjs`/依赖脚本，而不是从 PR 合并提交取；或把 gate 放到独立主机/独立共享组；
- 至少给 gate 独立资源上限，避免一个 PR 用 2 GB 内存把 gate 打挂。

---

### 9. 中：缺少 ADR 和运行手册的系统性更新，runbook 封存会过期

**问题**
- `docs/adr/0176` 第 54 行说“先装 2 个，跑一次完整 CI 再决定要不要加到 3 个”；第 72-75、81-83 行也按两个 runner 写。新增一个 gate runner 和改 main 并发组是架构决定，方案没有新 ADR / amend。
- `docs/adr/0241` 第 53-58 行是 `ci/required` 的入口检查和并发规则；新增 gate 应同步。
- `docs/runbooks/ci-vps-runner-runbook.md:5` 有 `contract_sha256`，第 13 行 `runbook-contract: scripts/operations/ci-runner`；PR A 改这个目录会立刻让封存过期。运行手册第 38、45-52、59-68、107-112、214-228 行大量写“两个”“gh-runner-2”，需要逐处改成三个，并补 gate 的预检、验证、回滚。方案只说“同步并重新封存”，没说 ADR。
- `.agents/instructions/document-governance.md:29-30,56` 要求改 Runbook 契约源文件时同提交重新封存；快速模式可 `Docs: deferred (fast mode)`，但方案没写。

**建议**
- 新增 ADR（或 amend 0176/0241），写清 gate 的资源隔离、回滚、main 并发组取舍；
- 运行手册补：3 号安装/注册、预检（`systemctl is-active ... gh-runner-gate.service`、`id gh-runner-gate`）、验证（gate 不能读 1/2 的目录、不能连本机端口、能连 api.github.com）、回滚（只卸 3 号 / 全部卸载）；
- 重新封存并在 PR 描述里写 `Docs: sealed` 或快速模式 `Docs: deferred (fast mode)`。

---

### 10. 低/中：验证第 2 步的做法不可靠，且 main 确认的结果变成依赖时序

**问题**
`cancel-in-progress: false` 只取消 **pending** 的运行；如果第一次确认已经开始跑，它不会被顶掉。方案写的“连续合并两次，第一次还在等的确认被顶掉，显示为取消”只有在第一次确实处于 pending 时才成立。另外，新的固定组让“哪些 main 提交有确认”取决于合并到达顺序，同一个提交在不同时序下可能得到不同结果；这不是模型请求字节的问题，但如果是“同一提交应得到同样确认”的可复现性要求，方案没有讨论。

**建议**
- 测试直接断言 `main.yml` 的 `concurrency.group` 和 `cancel-in-progress`，并加一个“正在跑的不被取消”的说明/测试；
- 如果要保留每个提交的确认记录，把便宜的 `plan` 留在每个提交上跑，只对昂贵的 `full`/`confirm` 去重；
- 在 ADR 里明确接受“中间提交没有单独确认”的取舍。

---

### 11. 低：计数、测试更新和占位符细节

- 方案前提 1 说“6 个检查作业”，前提 8 说“8 个检查作业”；实际是 6 个 check 定义 + browser 三成员 = 8 个作业。写清楚，避免实施时漏 job。
- 第 3 步说“加第三个检查 runner”，但第 1 步已经加了 gate，实际是第 4 个 runner；资源和命名要统一。
- `test/tooling/ci-runner-scripts.test.mjs:825-827` 现在断言 `render(3)` 失败；加 3 号后要改成 `render(4)`。
- `test/tooling/ci-runner-scripts.test.mjs:319-332` 的 `[HR-11]` 仍按全局 `RUNNER_LABEL` 写；改成按 runner 后必须重写，否则会红或给假信心。
- `test/tooling/ci-optimization.test.mjs:105-129` 调 `validateMainWorkflow`；如果动 plan 的 runner，必须同步并补“plan 回 ci-vps 应失败”的反向用例。
- `gh-runner.service.in:37` 只有一个 `@OTHER_ROOT@`；`runners.sh:49-57` 也只替换一个值。三个 runner 需要“同时藏两个目录”，且第二个路径也要带 `-` 前缀（或明确 systemd 的 `-` 语义），否则可能 unit 起不来或隔离不完整。内存占位符同理，需加测试断言没有残留 `@`。
- `uninstall-runner.sh:10-14` 的 usage 字符串、`register-runner.sh:11-14` 的 usage 都要加 3；现有 `uninstall-runner.sh` 测试（`:1370-1459`）硬编码 1/2，也要补 3。

---

## 二、推测 / 未核实

以下我无法在这个只读环境里验证，按“推测”列出：

1. **前提 7、11 的 GitHub 实时排队数据**（28 次排队、只剩 required、main 等了近 4 小时）未核实；只能确认代码里 `required` 确实带 `always()` 且 `runs-on: ci-vps`（`ci.yml:324-327`）。
2. **gate 2 GB 是否够**：`ci/required` 的实际峰值未测；方案只给了 policy 的 2.68 GB。需要实测 checkout + setup-node + install-tools + gate deps + collect + required.mjs。
3. **gate 作业时长是否“几秒钟”**：草稿/被取消的入口检查确实是秒级；但非草稿 PR 的 required 仍要跑完整汇总，可能几分钟。单 gate runner 在多个 ready PR 同时完成检查时是否成为新瓶颈，需要实测。
4. **三个作业同时占盘是否仍满足 16 GiB 底线**：`job-started.sh:9` 的 16 GiB 是按两个任务定的；未测第三个作业的实际占用。
5. **OOM killer 在 20 GB slice 内会选中谁**：取决于 `oom_score_adj`/内存使用；未在目标机验证。建议用 `MemoryMin` + 独立 slice，而不是赌。
6. **旧 PR 的 merge commit 是否会被 GitHub 自动刷新**：即使刷新，PR 分支里仍是旧 `ci.yml`/`main.yml`，第 1 条的失败仍然成立；但具体哪些 PR 会失败、失败比例未核实。
7. **`main-evidence` 对 PR B 合并后的 main 会退回 full CI**：代码 `main-evidence.mjs:101-113` 的 `MAIN_VALIDATION_CHANGED` 会拒绝 `.github`/`ci`/`scripts/ci` 的变更，所以 PR B 合并本身应走 full；这是代码推断，未实际跑。
8. **actionlint 是否自动读取 `.github/actionlint.yaml`**：`scripts/ci/run.mjs:245-250` 调 actionlint 时没显式传配置；actionlint 默认会读仓库根的配置，但未在本环境执行确认。
9. **`MemoryMin` 在目标 systemd/cgroup v2 上的行为**：作为建议，未在目标机验证；需要确认 cgroup v2 已启用。
10. **`ci-vps-gate` 作为 runner label 的大小写/长度**：GitHub 标签不区分大小写（官方文档），`ci-vps-gate` 合法；但实际注册后的标签列表未核实。

---

## 三、侧重检查

我按你要求的侧重，逐类查了这些路径：

**错误路径**
- 草稿/被取消：`ci.yml:342-349` 的入口检查确实在 checkout/装工具前；`CI_CANCELLED` 用 `contains(needs.*.result, 'cancelled')`；如果整轮被 GitHub 直接标取消，required 可能根本不跑——ADR 0241 已承认，结果不是成功，合并不会放行。**结论：设计成立。**
- gate 停机：所有 PR 的 required 排队，不会被当成通过；但回滚 PR 也过不了 policy/required（见发现 2）。**结论：需要补应急路径。**
- 3 号未安装/注册：`register-runner.sh 3`、`uninstall-runner.sh 3` 目前直接拒绝（`register:11-14`、`uninstall:10-14`）；方案漏改。**结论：会失败，必须改。**
- 暂停/恢复：`mac-runners.sh` 的全局 `LABEL` 会导致 gate 标签处理错误（见发现 4/5）。**结论：不完整。**
- 安装失败回滚：`install-runner.sh:30-55` 的 backup/restore 覆盖 `RUNNER_IDS`；加 3 后要确认 `INSTALL_PATHS` 包含 gate 的 unit/hooks/root；现有测试的 `reported` 列表也要加 3。**结论：机制在，但测试/路径要补。**
- 磁盘不足/`job-started.sh`：16 GiB 底线按两个任务写；三个任务未测。**结论：未核实。**
- share 目录缺失/权限：`runner-pause.sh`/`runbook` 已有排错；gate 加入同一 `gh-ci-share` 组。**结论：现有机制适用，但 gate 的 `ReadWritePaths`/`SupplementaryGroups` 要确认。**

**不合规范或不可信的输入**
- PR 代码在 gate 上执行：`ci.yml:350-366`；这是现有设计，不是本方案引入。**结论：风险不变，但方案不应暗示 gate 更可信。**
- 旧 PR 的旧工作流 + 新基准策略：见发现 1。**结论：会失败。**
- `CI_NEEDS` / reports：`required.mjs` 用 `toJSON(needs)` 和 digest 校验；gate runner 只是换了宿主，逻辑不变。**结论：无新增问题。**
- 注册标签来自 `config.sh --labels`：官方文档原话 “You can pass label names to the `config` script using the `labels` parameter”“If you replace an existing runner, then you must reassign any custom labels”（https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels）。`register-runner.sh` 用 `--replace`，所以每次重注册都要确认标签正确；现有测试只查全局标签，不够。**结论：需补跨端测试。**

**安全**
- runner 隔离：`InaccessiblePaths` 只有单个 `@OTHER_ROOT@`（`gh-runner.service.in:37`）；三个 runner 需要藏两个目录，且 gate 要藏 1/2，1/2 要藏 gate。**结论：模板/测试要改，否则隔离不完整。**
- 共享目录：`SupplementaryGroups=@SHARE_GROUP@`（`gh-runner.service.in:12`），所有 runner 可读写彼此的报告；运行手册第 61、66 行接受。**结论：现有风险不变；gate 加入不增加新的信任，但也不减少。**
- 防火墙/窄 sudo：`runners.sh:59-91`、`apply_runner_controls` 按 `installed_runner_ids` 生成，加 3 后会自动包含；但要确认 `RUNNER_IDS` 和 `runner_select 3`。**结论：机制在，测试要补。**
- 注册令牌：`register-runner.sh:15-22` 只从 stdin 读，仍安全；加 3 不改变。**结论：无新增问题。**
- gate 单点/DoS：2 GB + 同 slice，PR 代码可 OOM；见发现 6/8。**结论：需要隔离或明确接受。**

**资源耗尽**
- 内存：slice 20 GB，gate 2 GB 不是预留；三个作业同时跑可能 OOM。**结论：需要独立 slice/MemoryMin 或实测后调整。**
- TasksMax：slice 4096 vs 3×2048；gate 可能 fork 不出来。**结论：需要调预算。**
- 磁盘：16 GiB 底线按两个任务；第三个作业未测。**结论：需要实测/提高底线或给 gate 更小的 checkout。**
- 队列：单 gate runner 在多个 ready PR 同时完成检查时可能排队；需要测 gate 的 required 时长。**结论：未核实，方案把“几秒钟”说得太满。**

**不可撤销的操作**
- `uninstall-runner.sh all`：删共享目录、组、account、unit；加 3 后 `RUNNER_IDS` 要包含 gate，否则会留下 gate 的账号/目录；现有 `all` 的 `SHARED_UNITS` 不含新 slice（如果独立 slice）也要加。**结论：要补。**
- `install-runner.sh` 的 `config.sh --replace`：重注册会重置标签；官方文档也提醒替换后要重新分配自定义标签。**结论：运行手册要写“注册 gate 时确认标签是 `ci-vps-gate`，不是 `ci-vps`”。**
- 暂停时去标签：如果 gate 标签没去掉，GitHub 仍派任务给停掉的服务；方案的反向测试已意识到。**结论：实现要覆盖。**
- 回滚：见发现 2；不是自包含的。**结论：需要 Andy 放宽规则集或保留 `ci-vps` 回退。**

**规则文件、说明文档和代码一致性**
- `docs/adr/0176` 写两个 runner、第三个要再决定；方案没 amend。
- `docs/adr/0241` 写 required 的入口/并发；方案没同步。
- `docs/runbooks/ci-vps-runner-runbook.md` 的 `contract_sha256`/`runbook-contract` 会因 `scripts/operations/ci-runner` 变化而过期；方案说要重新封存，但没写 ADR 和快速模式 deferral。
- `.claude/rules/prompt-prefix.md` 不涉及本方案（见必答 1/2）。
- `docs/incidents-and-gates.md` I-73 的教训适用：新值 `ci-vps-gate` 缺少跨端门（见发现 5）。
- `docs/incidents-and-gates.md` I-06（文档/代码不一致）和 `document-governance` 的要求：改 Runbook 契约源文件要同提交 reseal 或写 `Docs: deferred (fast mode)`。

**结论**：错误路径里最容易出问题的是“3 号没注册/卸载/暂停标签”和“旧 PR 过渡”；不可信输入里最危险的是 gate 仍执行 PR 代码；资源上最危险的是 gate 没有独立内存预留；不可撤销操作里最危险的是回滚路径被自己的硬规则挡住。

---

## 四、如果由我来定，我会怎样改这份方案

我会把它改成“先加 runner、再改策略、最后改 main”的三段，并把过渡和回滚写死。

### PR A（只加 gate runner，不动工作流）

1. `runners.sh`：
   - `RUNNER_IDS="1 2 3"`；
   - `runner_select 3`：`RUNNER_USER=gh-runner-gate`、`RUNNER_ROOT=/srv/gh-runner-gate`、`RUNNER_UNIT=gh-runner-gate.service`、`RUNNER_NAME=ci-vps-gate`、`RUNNER_LABEL=ci-vps-gate`、`RUNNER_OTHER_ROOT` 同时包含 `/srv/gh-runner` 和 `/srv/gh-runner-2`；
   - 1/2 的 `RUNNER_OTHER_ROOT` 包含 gate 的 root；
   - `RUNNER_LABEL` 改为每个 case 设置，不再留全局值。
2. `register-runner.sh`：`case 1|2|3`，`--labels "$RUNNER_LABEL"`；在运行手册里明确“注册 3 号后核对 GitHub 标签只有 `ci-vps-gate`，没有 `ci-vps`”。
3. `install-runner.sh`：模板支持多路径（如 `@OTHER_ROOTS@` 渲染成 `-/a -/b`）和每 runner 的 `@MEMORY_HIGH@`/`@MEMORY_MAX@`；安装后 gate 用独立 slice（`gh-gate.slice`，`MemoryMin=2G`、`MemoryHigh=2G`、`MemoryMax=2G`、`TasksMax=512`），检查 runner 的 slice 降到 18 GB。
4. `uninstall-runner.sh`：`case 2|3|all`，usage 更新；`all` 包含 gate 的 unit/root/account 和新 slice。
5. `clean-old.sh`：不需要标签改动；靠 `RUNNER_IDS` 加 3。
6. `mac-runners.sh`：新增 `runner_label_for_name`（`ci-vps-1`/`ci-vps-2` → `ci-vps`，`ci-vps-gate` → `ci-vps-gate`）；`has_label` 接收标签参数；`reconcile_runners`/`label_states`/`add_label`/`remove_label` 都按名字取标签；确保恢复时不会给 gate 加 `ci-vps`。
7. 测试：
   - 1/2 的 unit 藏 gate root，gate 的 unit 藏 1/2 root；
   - `runner_select 3` 的标签/user/root/unit；
   - `register-runner.sh 3` 的标签；
   - pause 后 gate 的 `ci-vps-gate` 被去掉、恢复后只加回 `ci-vps-gate`；
   - uninstall 3/all 不留 gate 账号/目录/unit；
   - 反向：3 号标签写成 `ci-vps`、恢复给 gate 加 `ci-vps`、uninstall 漏 3，都必须失败；
   - 跨端一致性：`runners.sh`/`contracts.mjs`/`ci/policy.json`/`ci.yml`/`main.yml`/`actionlint.yaml`/schema 的 gate 标签一致。
8. 运行手册：按 3 个 runner 全面改写并 reseal；PR 描述写 `Docs: sealed` 或快速模式 `Docs: deferred (fast mode)`。
9. 不在 PR A 里改 `ci.yml`/`main.yml`/`ci/policy.json`，现有 CI 不受影响；但要在方案里承认：安装时 `install-runner.sh` 会重渲染 1/2 的 unit，必须 pause 所有 runner，约 10 分钟没有 CI。

### PR B（工作流 + 策略 + 过渡）

1. **不改 `main.yml` 的 plan**，继续 `runs-on: ci-vps`；这样少一个单点、少一半过渡破坏。
2. 只改 `ci.yml` 的 `required` 到 `ci-vps-gate`；`ci/policy.json` required 成员、schema enum、actionlint 加 gate；`contracts.mjs` 加 `gateRunnerLabel`。
3. `check-policy`：
   - `validatePolicy` 只允许 required 用 gate，检查作业仍必须 `ci-vps`；
   - 新增 `upgradeGateRunnerPolicy`，**最后执行**；
   - `ciVpsDefaultMember`/`retiredShapeChecks`/`upgradeRunnerLabel`/`upgradeHostedRunnerPolicy` 保持产 `ci-vps`；
   - 加过渡例外（旧策略+旧工作流允许）或明确要求所有开着的 PR rebase；两者都写进方案。
4. 测试：
   - hosted / hermes-home / 九作业 / 当前七作业四种基准升级；
   - 混写、macOS 未暂停、时限不对拒绝；
   - required 改回 `ci-vps` 必须失败（断言具体信息）；
   - 某个检查作业改到 gate 必须失败（断言具体信息）；
   - 旧策略+旧 `ci.yml` + 旧 `main.yml` 能过；新策略+新工作流能过；混搭失败；
   - `main-workflow.mjs` 仍要求 plan/confirm 在 `ci-vps`（如果保持不动）。
5. 回滚：写清楚 gate 停机时的应急步骤（Andy 用 `github-ruleset.sh` 放宽，或明确不等 CI），并让校验器接受一次“required 回 ci-vps”的回滚 PR，或保留过渡例外直到回滚验证完。

### 第 2 步（main 去重）

- 不把 plan 移到 gate。
- 如果要做，只对 `full`/`confirm` 加固定作业级并发组（`main-confirmation`，`cancel-in-progress: false`）；`plan` 仍每个提交跑，保留每个提交的路径选择记录。
- 组名用 `${{ github.workflow }}-main-confirmation`，避免跨 workflow 冲突。
- 在 ADR 里写清“只减少 main 重复运行，不改变 main 和 PR 抢 runner 的事实”和“连续合并时中间提交没有确认”的取舍。
- 验证：断言 YAML/validator；另做一次 runner 忙、run pending 的实测，而不是假设第一次一定 pending。

### 第 3 步

- 先量 npm 安装在 13 分钟里的占比，再按 ADR 0181 实现持久 npm 缓存；
- 再量 CPU/内存/磁盘；只有三个检查作业同时跑不超 20 GB、CPU 未吃满，才加第三个**检查** runner（注意此时总共有 4 个 runner：gate + 3 检查）；
- 加检查 runner 时同步改 `RUNNER_IDS`、slice、`TasksMax`、磁盘底线、运行手册和所有测试。

### 安全

- 在方案里明确 gate 仍执行 PR 代码，信任边界不变；如果在意，改用 base SHA 的 `required.mjs`/依赖脚本，或把 gate 放到独立主机/独立共享组。
- gate 用独立 slice + `MemoryMin`/`OOMScoreAdjust`，避免被检查作业 OOM。
- 给 gate 的 `InaccessiblePaths` 同时藏两个检查 root，检查 root 藏 gate；测试双向。

---

## 五、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会；本方案不涉及模型请求。**

方案改的是 `.github/workflows/ci.yml`、`main.yml`、`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/operations/ci-runner/*` 和测试文档；这些都不在 Himawari 组装模型请求的路径上（系统提示、工具定义、历史、遮盖在 `packages/runtime-pi`、`apps/agent-service`、`packages/prompt-catalog` 等）。因此：

- 发给模型的内容仍然只在末尾追加，不会因本方案改动；
- 每轮会变的值仍然只能放在最后一条用户消息里，本方案没有新增时间、路径、哈希、额度等会变的值；
- 新增的 `ci-vps-gate` 只是 CI 配置里的固定字符串，不是提示词内容。

依据：`.claude/rules/prompt-prefix.md:27-35`（固定的在前、会变的在后；每轮变化的内容只放最后一条用户消息；已发内容只追加）。现有的 `npm run check:prompt-prefix` 仍按原规则守着（同文件第 74 行），本方案不需要改它。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会；本方案不序列化模型请求。**

新增的值都是固定常量（`ci-vps-gate`、`main-confirmation`、`RUNNER_IDS=1 2 3`），不涉及遮盖、时间字段、对象遍历顺序或数据库返回顺序。CI 日志/JSON 里的 `runId`、`attempt`、`testedSha` 本来就按每次运行变化，不是模型请求内容。

需要单独说明的是：第 2 步把 main 并发组固定后，**哪些 main 提交会得到确认**会依赖合并到达时序；这不是“模型请求的同一段文字变成不同字节”，而是“同一提交的确认结果可能不同”。如果团队要求“同一提交得到同样确认”，应把便宜的 `plan` 保留在每个提交上，只对昂贵的 `full`/`confirm` 去重（见发现 7/10）。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有覆盖，但不完整；方案列出的反向用例不足以覆盖真正的失败模式。**

已有的、会拦住的检查：

- `check-policy.mjs:474`：`required` 的 `runs-on` 必须等于 `ci/policy.json` 里 required 成员的 runner；两边不一致会失败。
- `check-policy.mjs:323`：所有非 macOS 成员的 runner 规则；改对后 required 用 gate、检查作业用 `ci-vps` 会被强制。
- `actionlint`（`scripts/ci/run.mjs:245-250`）会读 `.github/actionlint.yaml`；gate 标签漏配会失败。
- `validateMainWorkflow`（`main-workflow.mjs:77`）会校验 main 的 plan/confirm runner；改 plan 不更新会失败。
- `policy.test.mjs`、`ci-runner-scripts.test.mjs`、`ci-optimization.test.mjs` 会覆盖一部分策略/runner/工作流结构。

但方案漏了这些关键反向用例：

1. **3 号注册标签**：`runner_select 3` 必须产生 `ci-vps-gate`，不能是 `ci-vps`；现有 `[HR-11]`（`ci-runner-scripts.test.mjs:319-332`）只查全局标签。
2. **暂停/恢复**：暂停必须去掉 3 号的 `ci-vps-gate`；恢复只能给 3 号加 `ci-vps-gate`，不能加 `ci-vps`；现有 `macBox`/`labelState`（`:223-317`）全按 `ci-vps` 写。
3. **register/uninstall 的参数**：`register-runner.sh 3` 和 `uninstall-runner.sh 3` 目前会直接退出 64（`:11-14`、`:10-14`）；方案的测试没有覆盖“3 号能装上/卸掉”。
4. **`render(3)` 的旧测试**：`ci-runner-scripts.test.mjs:825-827` 现在断言 3 号失败；加 3 后要改成 4 号失败。
5. **旧 PR 过渡**：旧策略 + 旧工作流 + 旧 main.yml 必须能过；旧策略 + 新工作流 / 新策略 + 旧工作流要有明确期望。
6. **升级链**：hosted / hermes-home / 九作业 / 当前七作业四种基准都要有“升级后等于当前策略、policySha256 仍按原始字节”的测试；混写要失败。
7. **回滚**：把 required 改回 `ci-vps` 的回滚 PR 必须能过（或明确说明只能靠 Andy 放宽规则集）。
8. **`main.yml` 并发组**：固定组的 validator 反向用例（改回 `run_id`、改 `cancel-in-progress: true` 都应失败）。
9. **资源**：gate 的 `MemoryHigh`/`MemoryMax`/`TasksMax` 渲染测试；`InaccessiblePaths` 同时藏两个 root。
10. **跨端一致性**：`runners.sh`/`contracts.mjs`/`ci/policy.json`/`ci.yml`/`main.yml`/actionlint/schema 的 `ci-vps-gate` 一致（I-73）。

另外，现有测试大量用 `toThrow()` 而不匹配具体错误（例如 `policy.test.mjs:940`、`:988`）；反向用例可能因为无关错误而“碰巧通过”。建议对每条反向用例断言具体的错误码/信息，确保它是因目标规则失败。

### 4. 每个新值/修改值，使用它的地方都能接受吗？

下面逐个核对“产生端/使用端/两端校验”：

| 值 | 产生 | 使用 | 两端校验 | 结论 |
| --- | --- | --- | --- | --- |
| `ci-vps-gate` runner 标签 | `runners.sh` 的 `runner_select 3`；`register-runner.sh:29` `--labels` | GitHub 调度（`ci.yml:327`）；`main.yml` 如果改 plan；`.github/actionlint.yaml`；`ci/policy.schema.json`；`mac-runners.sh` | GitHub 按标签匹配；actionlint 读配置；schema/Ajv 读 enum；`validateWorkflow:474` 校验 policy/workflow 一致；但 `mac-runners.sh` 是第二个产生/消费端，当前无测试 | **不完整**：需要按 runner 区分标签的映射和跨端测试；否则 gate 可能带 `ci-vps` 或暂停/恢复加错标签 |
| `ci/policy.json` required 成员 `runner: ci-vps-gate` | `ci/policy.json:127-142` | `validatePolicy:323`；`validateWorkflow:474`；`ci.yml:327` | schema enum + `validatePolicy` 规则 + `validateWorkflow` 相等校验 | **可接受**，但必须加“required 只能是 gate、检查作业不能是 gate”的规则和反向测试 |
| `gateRunnerLabel` 常量 | `scripts/ci/contracts.mjs` | `check-policy.mjs`、`main-workflow.mjs`、测试 | JS 常量一致；bash 端无法 import，只能靠测试 | **需要**：保留 `linuxRunnerLabel`，新增 gate 常量；测试 `runners.sh` 与 JS 常量一致 |
| 升级函数 `upgradeGateRunnerPolicy` | `check-policy.mjs` | `resolvePolicySource:1190-1192` | 只在基准策略恰好是旧 shape 时映射；否则 `validatePolicy` 拒绝 | **容易写错**：必须最后执行；不要改 `ciVpsDefaultMember`/`retiredShapeChecks`；四种基准都要测 |
| `main.yml plan` 的 `runs-on` | `main.yml:18` | `main-workflow.mjs:77`；`ci-optimization.test.mjs:105-129` | validator 精确字符串；actionlint | **建议不改**；如果改，validator、测试、旧 PR 过渡、gate 单点都要处理 |
| `main-confirmation` 并发组 | `main.yml:9-11` | GitHub concurrency；`main-workflow.mjs:47-49` | validator 精确字符串；GitHub 文档语义 | **可接受**，但建议 `${{ github.workflow }}-main-confirmation`；要补 validator 反向用例和“正在跑的不取消”的说明 |
| `RUNNER_IDS="1 2 3"` | `runners.sh:1` | `install-runner.sh:22-34`、`uninstall-runner.sh`、`pause`/`resume`/`clean`、`apply_runner_controls` | 循环 `installed_runner_ids`；但 `register-runner.sh`/`uninstall-runner.sh` 的 case 仍只 1/2 | **不完整**：必须改 case/usage，否则 3 号装不上/卸不掉 |
| `RUNNER_USER`/`RUNNER_ROOT`/`RUNNER_UNIT`/`RUNNER_OTHER_ROOT` for 3 | `runners.sh:runner_select` | `install-runner.sh`、`register-runner.sh`、`runner-pause.sh`、`runner-resume.sh`、`clean-old.sh`、`uninstall-runner.sh`、systemd 模板 | 变量一致；模板 `@USER@`/`@ROOT@`/`@NAME@`/`@OTHER_ROOT@` 替换；测试 `unitSettings` 无 `@` | **可接受**，但多 root 需要新占位符/测试；3 号未安装时 `installed_runner_ids` 会跳过 |
| `MemoryHigh`/`MemoryMax` for gate | `runners.sh`/`gh-runner.service.in` 占位符 | systemd；slice | `unitSettings` 解析；无 `@` 残留；slice 上限 | **需要**：2 GB 是否够未测；建议独立 slice + `MemoryMin`；`TasksMax` 预算 |
| `InaccessiblePaths` 两个 root | `runners.sh`/`gh-runner.service.in:37` | systemd | 测试断言两个 root 都被藏；反向：gate 能看到 1/2 失败 | **需要**：模板现在只有一个 `@OTHER_ROOT@`；第二个路径的 `-` 前缀要写对 |
| `register-runner.sh` case 3 | `register-runner.sh:11-14` | Andy 在 Mac 上执行 `register-runner.sh 3` | 只接受 1/2 会退出 64 | **不完整**：必须加 3 |
| `uninstall-runner.sh` case 3 | `uninstall-runner.sh:10-14` | 卸载 3/all | 只接受 2/all 会退出 64 | **不完整**：必须加 3；`all` 的 `SHARED_UNITS` 按需加新 slice |
| `ci-vps-gate` 在 actionlint/schema | `.github/actionlint.yaml:3`、`ci/policy.schema.json:64` | actionlint、Ajv | actionlint 不认标签会失败；schema 不认 enum 会失败 | **可接受**，但 enum 必须是“加”不是“替换”，否则检查作业的 `ci-vps` 被拒 |
| runbook `contract_sha256` | `docs/runbooks/ci-vps-runner-runbook.md:5` | `validate_docs.py --strict` | 契约源文件 `scripts/operations/ci-runner` 变化后必须 reseal | **不完整**：方案只说“同步并重新封存”，没写 ADR/快速模式 deferral |

---

## 最后一句

这份方案的“专用 gate runner”方向保留，但**不要按现在的 PR A/PR B 直接写代码**。先把“旧 PR 过渡”“回滚路径”“升级函数顺序”“3 号注册/卸载/暂停/恢复”“gate 资源隔离”这五件事在方案里补成可执行、可测试的步骤，再动手。否则最可能的结果是：PR B 合进去的当天，旧 PR 全部红，gate 一停就既合不了回滚也修不了。
