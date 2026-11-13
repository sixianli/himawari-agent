# 方案：把门禁从主队列拆出来，取消过期运行，再降低每个作业的固定成本

## 一、方案依赖的前提

| # | 前提 | 来源与原话 | 等级 |
|---|---|---|---|
| P1 | CI 跑在现有 VPS 的两个自托管 runner 上，每个 runner 一次只跑一个作业，标签都是 `ci-vps` | `docs/adr/0176-ci-on-ovh-vps.md:72`：“两个 runner 叫 `ci-vps-1`、`ci-vps-2`，标签都是 `ci-vps`”；`:75`：“两个 runner 合计 `MemoryHigh=19G`、`MemoryMax=20G`”；GitHub 官方文档：“Each runner can run a single job at a time.” <https://docs.github.com/en/actions/get-started/understand-github-actions> | 证实 |
| P2 | `ci.yml` 有 6 个检查作业定义，全部落在 `ci-vps` | `.github/workflows/ci.yml:30-334`；`ci/policy.json:5-142` | 证实 |
| P3 | `ci/required` 带 `always()`，第一步判草稿和被取消的运行失败，本身也占一个 `ci-vps` runner | `.github/workflows/ci.yml:324-349`；ADR 0241 决定第 2 条 | 证实 |
| P4 | PR 运行会取消同 PR 的旧运行；main 的并发组带 `run_id` 且不取消 | `.github/workflows/ci.yml:23-25`；`.github/workflows/main.yml:9-11` | 证实 |
| P5 | 汇总结论必须打印在 `ci/required` 作业日志里，main 的轻量确认从那里读 | `docs/adr/0243-ci-uses-no-github-artifacts.md:55-56`；`scripts/ci/required.mjs:77`；`scripts/ci/main-evidence.mjs` 按作业名 `ci/required` 查找 | 证实 |
| P6 | 工作流和策略改动必须同步改硬规则和反向用例 | `scripts/ci/check-policy.mjs:395-411`、`:508-548`；`scripts/ci/main-workflow.mjs:46-50`；`test/tooling/ci-optimization.test.mjs:245-289`；`test/tooling/policy.test.mjs:379-382` | 证实 |
| P7 | VPS 的 runner 安装、暂停、恢复、卸载都由仓库脚本驱动；云端线程没有 VPS 凭证 | `scripts/operations/ci-runner/install-runner.sh:22-34`；`scripts/operations/ci-runner/runners.sh:1-30`；`docs/runbooks/ci-vps-runner-runbook.md:132-142` | 证实 |
| P8 | 工具下载已有 runner 级缓存，但 npm 缓存仍在每次检出都会删掉的 `.ci-output/npm-cache`；ADR 0241 决定第 5 条尚未实现 | `scripts/ci/verified-download.mjs:39-44`；`scripts/ci/install-dependencies.mjs:297-300`；`.github/workflows/ci.yml:53`；`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:57` | 证实 |
| P9 | 当前交付模式是 `fast`，仓库规则只证明“线程自己要求 `ci/required` 成功”，没有证明 GitHub 线上规则集强制它 | `AGENTS.md:7`；`.agents/instructions/delivery-mode.md:27`；`DELIVERY_MODE` 内容为 `fast` | 仓库内证实；线上规则集未核实 |
| P10 | 模型请求的约束是固定内容在前、每轮变化的值在最后一条消息，历史只追加、序列化字节确定 | `.claude/rules/prompt-prefix.md:27-29`、`:51-54` | 证实 |

## 二、核对后认为材料里不准确或不完整的地方

1. **事实 2 的“6 个检查作业”是作业定义数，不是实际占用的 runner 作业数。** `browser` 是 3 个矩阵成员（chromium/firefox/webkit），所以一次完整运行实际有 8 个检查作业实例，再加 `ci/required` 共 9 个 runner 作业。见 `.github/workflows/ci.yml:162-232`、`ci/policy.json:62-94`。这会影响排队计算，不能按 6 个算。
2. **事实 6 的观察可能是真的，但“新运行要等旧运行的 `ci/required` 跑完”与 GitHub 官方对 `cancel-in-progress` 的描述并不完全一致。** 官方说同组新运行会取消正在运行的旧运行（<https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>）。如果实际观察到旧的 `ci/required` 仍排队，说明带 `always()` 的作业可能没有被工作流级取消清掉。**这一点需要真机实验确认；无论原因是什么，方案都不能继续依赖工作流级取消来清理门禁作业。**
3. **事实 9 的“分支保护没有要求 `ci/required`”只能证明仓库里的流程要求，不能证明 GitHub 线上规则集。** `DELIVERY_MODE=fast` 和 `delivery-mode.md:27` 说明规则由用户切换，仓库里读不到当前 ruleset。标记为「未核实」。
4. 其余事实 1、3、4、5、7、8、10、11 与代码一致。

## 三、方案

### 核心判断

排队的主因不是“CPU 总量不够”，而是两个结构性浪费：

- **门禁作业和重检查抢同一批 runner。** `ci/required` 只需要几十秒，却和 13 到 14 分钟的 policy/static 排在同一个队列里；草稿和过期运行产生的 `ci/required` 会把新 PR 的运行卡在并发组后面。
- **main 的每次合并都单独占一个并发组。** `main-confirmation-${run_id}` 且不取消，连续合并 6 次就排 6 次确认。见 `main.yml:9-11`。
- 另外，policy 作业 13 到 14 分钟，却是 static/build/security/coverage 的前置依赖；在没有别的运行时，两个 runner 里有一个在开头是空闲的。这是第二阶段要解决的吞吐问题。

### 阶段 1：在现有 VPS 上增加一个只跑门禁的 runner（不增加服务器、不降低检查）

在 `ci-vps` 同一台机器上增加第三个自托管 runner：

- runner 编号 3，名字 `ci-vps-gate`，账号 `gh-runner-gate`，目录 `/srv/gh-runner-gate`，服务 `gh-runner-gate.service`。
- **只给标签 `ci-vps-gate`，不给 `ci-vps`。** 这样重检查永远不会落到它上面，`ci/required` 也不会再排在 13 分钟作业后面。
- 仍然加入 `gh-ci-share` 组，能读写 `/srv/gh-runner-share`；防火墙、窄 sudo、磁盘底线、每小时清理沿用现有机制。
- 内存先沿用现有服务模板的 `MemoryHigh=14G`、`MemoryMax=15G`。它只跑 `required`，实际峰值远低于此；先不调低，跑一周看数据再决定。
- **必须同时修改 `InaccessiblePaths`：** 现有模板只藏一个“另一个 runner”目录（`gh-runner.service.in:37`）。加第三个 runner 后，runner 1 仍能看到 `/srv/gh-runner-gate`，这是隔离回退。模板要改成列出另外两个目录，测试要逐个 runner 检查它看不到另外两个。

工作流侧：

- `ci.yml` 的 `required` 改为 `runs-on: ci-vps-gate`。
- `main.yml` 的 `plan` 也改到 `ci-vps-gate`，因为它只做证据发现和日志读取，属于轻作业。若实测 `plan` 超过约 2 分钟，就把它留在 `ci-vps`，避免 main 的 plan 拖住 PR 的 `required`。
- `ci/required` 的**作业名不变**，所以 `main-evidence.mjs` 仍能按名字找到它，汇总结论格式也不变。

### 阶段 2：取消过期门禁和过期 main 确认

1. **给 `required` 加作业级并发：**

   ```yaml
   concurrency:
     group: ci-required-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
     cancel-in-progress: true
   ```

   这样同一个 PR 连续推送时，只保留最新的 `ci/required`，旧的被取消。被取消不是成功，不会误当通过。main 推送时按 `github.ref` 分组，新 main 推送取消旧门禁，和 main 的“只确认最新提交”一致。

2. **main 并发组改为“最新 main 有效”：**

   ```yaml
   concurrency:
     group: main-confirmation
     cancel-in-progress: true
   ```

   连续合并时，旧的 main 确认被取消，只确认最新的 main 提交。最新 main 包含之前所有合并；每个 PR 在合并前已经由自己的 `ci/required` 验证。**这是一个需要 Andy 拍板的取舍：** 如果不接受“旧 main 提交不逐个确认”，就不要改这一条，只做阶段 1 和阶段 2 的第 1 条。

3. **加一次性策略迁移。** 这个 PR 把 `required` 的 runner 从 `ci-vps` 改成 `ci-vps-gate`，但 `ci/required` 是用目标分支上的 `ci/policy.json` 校验工作流的（ADR 0176 决定第 2 条）。不加迁移，这个 PR 自己的 `ci/required` 会因为基准策略还写着 `ci-vps` 而失败。需要新增 `upgradeGateRunnerPolicy`：只认“恰好是现行 7 作业、required 仍是 `ci-vps`、其他 Linux 成员也是 `ci-vps`”的旧写法，改成 required 用 `ci-vps-gate`；混写、required 已经是 gate、或其它成员用 gate 的一律不动，照常被拒。`policySha256` 仍按基准原始字节算。

### 阶段 3：降低每个作业的固定成本（按测量决定）

1. **实现 ADR 0241 决定第 5 条：npm 下载缓存放到 runner 账号目录。**
   - 默认路径例如 `$HOME/.cache/himawari-ci/npm`，可用 `HIMAWARI_CI_NPM_CACHE` 覆盖。
   - `install-dependencies.mjs` 和 `install-gate-dependencies.mjs` 共用这个缓存；工作流去掉 `--cache .ci-output/npm-cache`。
   - 只缓存下载的包，不缓存 `node_modules`；better-sqlite3 仍每次现编译并跑探针。
   - 增加上限和清理（例如 30 天、每 runner 2 GB），并保留“路径不得含符号链接、不得越出允许根目录”的检查。
   - 风险是 runner 账号可写缓存，但 npm 会按锁文件 integrity 校验，且安装使用 `--ignore-scripts`；被改过的条目必须被拒绝并删除。

2. **拆开 policy 的前置依赖（可选）。** policy 作业实际跑的是 tooling 测试（`ci/policy.json` 的 `projects: ["tooling"]`），却阻塞 static/build/security/coverage。可以把它拆成“快速结构校验”和“tooling 测试”两个作业，或去掉 static/build/security 对 policy 的 `needs`，让它们并行启动；`ci/required` 仍等全部作业。这样不跳过、不合并任何检查，只是改变调度。代价是 policy 不合法的 PR 会先浪费一些重检查；如果队列仍然长，再上这一条。

### 改哪些文件

**阶段 1（先合并、先装 VPS）：**
- `scripts/operations/ci-runner/runners.sh`：`RUNNER_IDS="1 2 3"`；`runner_select` 为每个编号设置自己的 `RUNNER_LABEL`、`RUNNER_NAME`、`RUNNER_USER`、`RUNNER_ROOT`、`RUNNER_UNIT`、`RUNNER_OTHER_ROOTS`。
- `scripts/operations/ci-runner/install-runner.sh`
- `scripts/operations/ci-runner/register-runner.sh`：接受 `1|2|3`。
- `scripts/operations/ci-runner/uninstall-runner.sh`：接受 `1|2|3|all`。
- `scripts/operations/ci-runner/pause-runners.sh`、`resume-runners.sh`、`mac-runners.sh`、`runner-pause.sh`、`runner-resume.sh`：从“一个全局 `LABEL`”改成“每个 runner 自己的标签”。
- `scripts/operations/ci-runner/gh-runner.service.in`：支持隐藏多个其他 runner 目录。
- `scripts/operations/ci-runner/clean-old.sh`：沿用 `installed_runner_ids`，确认 3 号也被清理。
- `docs/runbooks/ci-vps-runner-runbook.md`：三个 runner、标签、预检、安装、注册、暂停、卸载、回滚；改完要重新封存 runbook 合约。
- `test/tooling/ci-runner-scripts.test.mjs`：三 runner、标签、隔离、暂停/恢复、卸载的反向用例。

**阶段 2（工作流和策略）：**
- `.github/workflows/ci.yml`：`required` 的 `runs-on`；`required` 的作业级并发。
- `.github/workflows/main.yml`：`plan` 的 `runs-on`；main 并发组和 `cancel-in-progress`。
- `ci/policy.json`：`required` 成员的 `runner`。
- `ci/policy.schema.json`：`runner` 枚举加 `ci-vps-gate`。
- `.github/actionlint.yaml`：自定义标签加 `ci-vps-gate`。
- `scripts/ci/contracts.mjs`：新增 `gateRunnerLabel`。
- `scripts/ci/check-policy.mjs`：required 只允许 gate 标签、其它作业只允许 `ci-vps`；required 作业并发逐字校验；新增 `upgradeGateRunnerPolicy` 并接进 `resolvePolicySource` 的升级链。
- `scripts/ci/main-workflow.mjs`：main 并发组、plan 的 runner 标签。
- `test/tooling/policy.test.mjs`、`test/tooling/ci-optimization.test.mjs`：新增反向用例。
- 新 ADR：记录“门禁独立 runner、过期门禁取消、main 只确认最新、npm 缓存”，并声明修订 ADR 0176/0241/0243。

**阶段 3：**
- `scripts/ci/install-dependencies.mjs`、`install-gate-dependencies.mjs`、`verified-download.mjs`（或新模块）、`.github/workflows/ci.yml`、`.github/workflows/main.yml`、`README.md`。
- `test/tooling/toolchain-lifecycle.test.mjs`、`test/tooling/gate-installation.test.mjs`、`test/tooling/verified-download.test.mjs`。

### VPS 上要做什么（Andy 在 Mac 上执行）

1. **先合并阶段 1 的脚本改动**（只加第三个 runner 的能力，不把 `required` 指过去），这样它自己的 CI 仍能在现有两个 runner 上通过。
2. 预检：`hostname` 是 `ci-vps`；`gh api .../actions/runners` 显示 `ci-vps-1`、`ci-vps-2` 在线；根盘可用空间大于 16 GiB；`systemctl is-active gh-runner gh-runner-2 gh-runner-nft gh-runner-clean.timer`。
3. 暂停：在 Mac 上运行 `scripts/operations/ci-runner/pause-runners.sh`。阶段 1 的脚本必须已经能按 runner 自己的标签暂停；否则不能继续。
4. 上传 `scripts/operations/ci-runner/` 到 VPS 的 `/home/ubuntu/ci-runner/`。
5. `sudo bash /home/ubuntu/ci-runner/install-runner.sh`，它会建 `gh-runner-gate` 账号、目录、服务、防火墙和 sudo 规则。
6. 注册第三个 runner：
   `gh api -X POST repos/sixianli/himawari-agent/actions/runners/registration-token --jq .token | ssh ... 'sudo bash /home/ubuntu/ci-runner/register-runner.sh 3'`
7. 恢复：运行 `resume-runners.sh`。验证 GitHub 上三个 runner 在线；`ci-vps-1`/`ci-vps-2` 标签是 `ci-vps`，`ci-vps-gate` 只有 `ci-vps-gate`；`systemctl show` 三个服务；`nft list table inet gh_runner` 包含三个 uid；`stat -c '%a %U %G' /srv/gh-runner-share` 仍是 `2770 root gh-ci-share`。
8. 再合并阶段 2 的工作流改动。这个 PR 的 `ci/required` 会第一次跑在 `ci-vps-gate` 上；确认作业日志开头的 `Runner name` 是 `ci-vps-gate`，并且 `CI_SHARE_COLLECT 8`。
9. 回滚：`sudo bash /home/ubuntu/ci-runner/uninstall-runner.sh 3`，再从 GitHub 删除 `ci-vps-gate`，并把工作流改回 `ci-vps`。

## 四、考虑过但不选的做法

- **用 GitHub 托管 runner 跑 `ci/required`**：私有仓库按分钟计费，违反“绝不在 GitHub 上花钱”。
- **再加一台服务器或换更大 VPS**：违反“不在服务器上多花钱”。
- **只加作业级并发，不加门禁 runner**：能取消过期门禁，但最新的 `ci/required` 仍要排在 13 分钟重检查后面，解决不了队头阻塞。
- **给第三个 runner 也加 `ci-vps` 标签**：空闲时会被重检查占用，门禁仍可能等重作业；失去“专用通道”的意义。
- **草稿 PR 上让 `ci/required` 跳过**：GitHub 把跳过的作业记为成功（ADR 0241 背景），会制造假通过。
- **去掉 `always()` 或改成 `!cancelled()`**：上游失败或被取消时 `required` 会跳过并显示成功，同样危险。
- **用 `actions/cache` 或 GitHub 产物**：ADR 0174/0243 已为省钱和额度问题放弃。
- **路径过滤、跳过、合并检查**：违反“不降低检查质量”。
- **Merge queue**：能减少重复运行，但要改分支保护和合并流程，且不解决现有自托管 runner 的队头阻塞；本阶段不引入。
- **缓存 `node_modules`**：ADR 0241 明确只缓存下载包，better-sqlite3 必须每次现编译；不采用。
- **ARC / Runner Scale Set 自动扩容**：这是 GitHub 官方推荐的自托管扩容方式（<https://docs.github.com/en/actions/concepts/runners/actions-runner-controller>、<https://github.com/actions/scaleset>），但需要 Kubernetes 或额外控制面，不符合“只用现有 VPS”的约束；本方案只在现有机器上增加一个固定 runner，是同一思路的最小实现。

## 五、风险和反例

1. **加第三个 runner 却漏改隔离。** 反例：`gh-runner.service.in` 仍只有一个 `@OTHER_ROOT@`，runner 1 能看到 `/srv/gh-runner-gate`。必须让模板列出另外两个目录，并在 `ci-runner-scripts.test.mjs` 里逐个 runner 断言看不到另外两个。
2. **加第三个 runner 却漏改暂停/恢复的标签逻辑。** 反例：`pause-runners.sh` 只移除全局 `ci-vps`，`ci-vps-gate` 仍在，维护期间门禁仍会接任务。必须按 runner 自己的标签移除/恢复，并测试“暂停后三个标签都不在”。
3. **改了 `required` 的 runner 却没有迁移函数。** 反例：PR 自己的 `ci/required` 用基准策略校验，基准策略还要求 `ci-vps`，于是永远红。必须加 `upgradeGateRunnerPolicy`，并测试混写和错误写法仍被拒。
4. **main 取消旧确认后，旧 main 提交没有单独确认。** 这是有意取舍；最新 main 包含旧提交，且每个 PR 合并前已过 CI。若 Andy 不接受，保留 `cancel-in-progress: false`，只做门禁独立和门禁并发。
5. **门禁 runner 成为单点。** 它离线时 `ci/required` 会排队，不会假通过；需要在 runbook 里加监控和回滚步骤。若长期不可用，可临时把 `required` 改回 `ci-vps` 并重跑整轮。
6. **npm 缓存被写坏或撑满磁盘。** 用锁文件 integrity 校验、符号链接检查、大小上限和定期清理；被改过的缓存条目必须删除并当作未命中。
7. **policy 拆依赖后，策略不合法的 PR 先跑了重检查。** 这是吞吐换浪费；只在阶段 1/2 后队列仍长时再做，并用实际数据决定。

## 六、需要 Andy 拍板的取舍

1. **是否同意在现有 VPS 上增加第三个只跑门禁的 runner。** 不增加服务器费用，但多一个进程、目录和监控点。
2. **是否同意 main 只确认最新提交。** 这会取消旧的 main 确认；最新 main 包含之前所有合并。
3. **是否同意把 npm 下载缓存放到 runner 账号目录。** 这是 ADR 0241 已同意但尚未实现的事项；需要接受缓存目录可被 runner 任务写入，靠 integrity 校验兜底。
4. **是否现在就把 `ci/required` 加进 GitHub 规则集。** 如果加，门禁 runner 必须先稳定在线；否则所有合并都会等一个不存在的检查。当前仓库只能证明流程要求，线上规则集状态未核实。
5. **是否做阶段 3 的 policy 拆依赖。** 它会减少完整运行的墙钟时间，但会让策略不合法的 PR 先浪费一些重检查。

## 七、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本方案只改 GitHub Actions 工作流、CI 策略、runner 安装脚本和 CI 缓存路径，不触碰系统提示、工具定义、历史消息、资料块或出口遮盖。因此发给模型的内容仍然只在末尾追加；本方案也没有新增任何“每轮会变的值”，不存在把它放进最后一条消息的问题。依据：`.claude/rules/prompt-prefix.md:27-29`（固定在前、变化在后）、`:51-54`（历史只追加、遮盖确定）。如果以后有人把 CI 日志、运行号或时间传给模型，那必须放在最后一条用户消息，不能进系统提示或工具定义；本次没有这样做。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 本方案没有改模型输入的序列化、JSON 键顺序、工具顺序或列表顺序。新增的 `ci-vps-gate` 标签、并发组字符串、缓存路径都是 CI 配置里的固定字符串；`ci/policy.json` 仍是固定顺序的 JSON。汇总结论里的运行号、日志时间戳只存在于 GitHub 作业日志和 `main-evidence` 的 GitHub API 调用中，不是模型请求内容。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，而且必须按“先让反向用例失败，再修”的方式落地：

- **策略/工作流：** `npm run check:ci-policy`（`scripts/ci/check-policy.mjs`、`main-workflow.mjs`）逐字校验。新增反向用例：
  - 去掉 `required` 的作业级并发 → 失败；
  - `cancel-in-progress: false` 或并发组不含 PR 编号/ref → 失败；
  - `static` 用 `ci-vps-gate`、`required` 用 `ci-vps` → 失败；
  - main 的 `cancel-in-progress` 改回 `false`、并发组改回 `run_id` → 失败；
  - plan 的 runner 改回 `ci-vps` → 失败；
  - 基准策略迁移的混写、错误写法 → 失败。
- **main 工作流：** `test/tooling/ci-optimization.test.mjs` 的 `validateMainWorkflow` 反向用例；新增 main 并发和 plan 标签的反向用例。
- **runner 脚本：** `test/tooling/ci-runner-scripts.test.mjs` 新增三 runner、每个 runner 自己的标签、看不到另外两个目录、暂停/恢复三个标签、卸载 3/all 的反向用例。
- **缓存：** `test/tooling/toolchain-lifecycle.test.mjs`、`gate-installation.test.mjs`、`verified-download.test.mjs` 新增热缓存、冷缓存、被改过的缓存条目被拒绝、路径越界/符号链接被拒、清理上限的反向用例。
- **端到端验证：** 草稿 PR 的 `ci/required` 应在几秒内失败；完整 PR 的 `ci/required` 应在检查结束后立即在 `ci-vps-gate` 上开始；同一 PR 连续推送只保留最新 `ci/required`；连续 3 次 main 合并只保留最新 main 确认；同一 runner 连续跑两次完整 CI，第二次 npm 缓存应为 `warm`。

本次只读复核没有执行这些测试（工具限制），所以“反向用例真的会失败”目前是**实施要求**，不是已执行结果。实施 PR 必须实际运行并记录。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处和两端校验 |
|---|---|---|
| `ci-vps-gate` 标签 | `scripts/ci/contracts.mjs` 新增 `gateRunnerLabel`；`runners.sh` 的 3 号 runner；`ci/policy.json` 的 required 成员；`ci.yml` 的 required；`main.yml` 的 plan；`ci/policy.schema.json`；`.github/actionlint.yaml` | GitHub 按标签路由；`check-policy.mjs` 校验 required 只能 gate、其它只能 `ci-vps`；`main-workflow.mjs` 校验 plan 标签；schema 的 `enum` 必须先接受；actionlint 必须认识；runner 注册脚本必须真的给 3 号 runner 打这个标签。任一处漏改，PR 自己的策略检查或路由就会失败。 |
| `gh-runner-gate` / `/srv/gh-runner-gate` / `gh-runner-gate.service` / `ci-vps-gate` 名字 | `runners.sh` 的 `runner_select 3` | `install-runner.sh`、`register-runner.sh`、`uninstall-runner.sh`、`pause-runners.sh`、`resume-runners.sh`、`mac-runners.sh`、`runner-pause.sh`、`clean-old.sh`、runbook、测试。反向用例：3 号缺失、标签错、卸载 3 不生效、暂停后 gate 标签仍在，都必须失败。 |
| `RUNNER_IDS="1 2 3"` | `runners.sh` | `install-runner.sh` 的循环、`installed_runner_ids`、`clean-old.sh`、`uninstall-runner.sh all`、pause/resume、测试。反向用例：`uninstall-runner.sh 3` 和 `all` 必须覆盖 3 号；clean-old 必须遍历 3 号。 |
| 多个 `InaccessiblePaths` | `runners.sh` 的 `RUNNER_OTHER_ROOTS`；`gh-runner.service.in` | systemd 服务渲染；`ci-runner-scripts.test.mjs` 逐个 runner 检查看不到另外两个目录。反向用例：runner 1 仍能看到 gate 目录 → 测试失败。 |
| `ci-required-${event}-${PR/ref}` 并发组 | `ci.yml` 的 required 作业 | GitHub 作业级并发；`check-policy.mjs` 逐字校验；`policy.test.mjs` 反向用例。反向用例：缺失、`cancel-in-progress: false`、组里没有 PR 编号/ref → 失败。 |
| `main-confirmation` 并发组和 `cancel-in-progress: true` | `main.yml` | GitHub 工作流并发；`main-workflow.mjs` 逐字校验；`ci-optimization.test.mjs` 反向用例。反向用例：改回 `run_id` 或 `false` → 失败。 |
| npm 缓存路径 / `HIMAWARI_CI_NPM_CACHE` | 新的缓存路径函数；工作流不再传 `.ci-output/npm-cache` | `install-dependencies.mjs` 的 `cacheLocation` 和 `npm_config_cache`；`install-gate-dependencies.mjs` 的 `--cache`；`toolchain-lifecycle.test.mjs`、`gate-installation.test.mjs`、`verified-download.test.mjs`。反向用例：路径越界、符号链接、被篡改的缓存条目 → 拒绝。 |
| `ci/policy.json` 的 required runner / DAG | `ci/policy.json` | `validatePolicy`、`validateWorkflow`、`resolvePolicySource` 的升级链、`required.mjs` 的 expected members、测试。反向用例：旧基准策略没有迁移 → 本 PR 的 `ci/required` 失败；混写 → 被拒。 |
| `ci/required` 作业名 | `ci.yml` 不变 | `main-evidence.mjs` 按名字精确查找；汇总结论日志格式不变。反向用例：改名或改日志格式 → main 轻量确认失败。 |
| 门禁日志格式 | `required.mjs` / `gate-log.mjs` 不变 | `main-evidence.mjs` 的 base64、SHA-256、开始/结束标记校验。本方案不改变它。 |

## 八、推测和未核实

- **推测：** 把 `required` 移到专用 runner 后，28 个排队运行会明显下降。依据是事实 6 说多数排队运行只剩 `ci/required`；但没有在真机上验证“门禁 runner + 作业级并发”能把队列降到多少。
- **推测：** `main-confirmation` 取消旧运行后，连续合并的确认延迟会从“每次合并一个完整确认”降到“只等最新 main”。依据是 GitHub 官方并发语义；未在真机连续合并 6 次验证。
- **未核实：** GitHub 线上 ruleset 当前是否要求 `ci/required`。仓库只能证明流程要求，见 P9。
- **未核实：** 带 `always()` 的 `ci/required` 在 `cancel-in-progress` 下是否真的不会被取消。材料观察与官方文档不完全一致，需做一次真机实验；方案不依赖这个行为。
- **未核实：** `main.yml` 的 `plan` 实际耗时，以及第三个 runner 的实际内存峰值。若 `plan` 超过约 2 分钟，应留在 `ci-vps`；门禁 runner 的内存上限跑一周后再调。
- **未核实：** npm 热缓存能把 policy/static 的 13 到 14 分钟缩短多少。需要先做两次连续运行的对比测量，再决定是否值得保留缓存清理逻辑的复杂度。
