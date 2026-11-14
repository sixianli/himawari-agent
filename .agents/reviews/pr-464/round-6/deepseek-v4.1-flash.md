## 结论先行

核心安全属性成立：必过汇总（`ci/required`）只可能采用 x64 报告。本轮把 `aggregate.mjs` 恢复为“只认 `member.arch`”，而 `ci.yml` 的 `collect` 没有 `--remote-jobs`，试跑工作流也不往共享目录交报告，因此 ARM 结论进不了必过门。新增反向用例在旧逻辑下会失败，能防回归。

但发现一处需要在切换 PR 前处理的设计不一致（中），以及几处低风险问题。

---

## 问题（按严重度）

### 1. 中：`alternateArch` 在策略里声明，但必过门已不再接受；且“切到 ARM”用现有 schema/校验器写不出来

- 文件：`ci/policy.json:16,33,123`、`ci/policy.schema.json:75-77`、`scripts/ci/check-policy.mjs:370-371`、`scripts/ci/aggregate.mjs:99-101`、`scripts/ci/run.mjs:70-71`
- 问题：`policy.json` 给 policy/static/security 三项加了 `"alternateArch": "arm64"`，schema 允许它，`validatePolicy` 还强制这三项必须有、其他项必须没有；但 `aggregate` 现在只比较 `result.toolchain.arch !== member.arch`，这个字段对必过门已是死数据，只有 `run.mjs` 的入场上限还读它。更实际的是：切换 PR 想把这三种检查改成跑在 `ci-arm`，当前 schema 的 `runner` 枚举只有 `ci-vps/ci-vps-gate/macos-15`（`ci/policy.schema.json:64`），`check-policy.mjs:192` 的 `runnerLabelFor` 又把非 required 检查钉死在 `ci-vps`，`validatePolicy:371` 会直接拒绝 `runner: "ci-arm"`。也就是说“另开 PR 切到 ci-arm”不是改策略文件就能完成的，还要改 schema、`runnerLabelFor` 和 `validatePolicy`。
- 证据（亲自读到）：
  - `aggregate.mjs:99-101`：`for (const field of ["node", "os", "arch"]) if (result.toolchain[field] !== member[field]) ...`
  - `policy.schema.json:64`：`"runner": { "enum": ["ci-vps", "ci-vps-gate", "macos-15"] }`
  - `check-policy.mjs:192`：`const runnerLabelFor = (checkId) => (checkId === "required" ? gateRunnerLabel : linuxRunnerLabel);`
  - `check-policy.mjs:371`：`member.runner === (mac ? "macos-15" : runnerLabelFor(check.id))`
  - `run.mjs:70-71`：唯一仍在读 `member.alternateArch` 的地方。
- 建议：作者把 ADR 0260 单独开 PR、切换前合入是合理的，但应在 ADR 或迁移清单里明确列出切换 PR 需要同步改动 schema 枚举、`runnerLabelFor`、`validatePolicy`、`aggregate` 与 `aggregate.test.mjs`；否则下一轮很容易只改 `ci.yml` 就以为切完了。若短期不打算切，建议在 `policy.json`/schema 注释里写明 `alternateArch` 只影响“能不能在这台机器上跑”，不影响“必过门认不认”。

### 2. 低：应急 `arm-fallback.sh on` 期间，试跑在 x64 上产生的“ARM 试跑”结论可能被当成 ARM 证据

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:180`、`.github/workflows/ci-arm-trial.yml:21-22`、`scripts/ci/run.mjs:70-71`
- 问题：`arm-fallback.sh on` 会给 CI VPS 的 x64 检查 runner 加 `ci-arm` 标签；试跑工作流 `runs-on: ci-arm` 于是落到 x64 上。`memberRunsOnHost` 因 `member.arch === "x64"` 放行，结果 `result.json` 的 `toolchain.arch` 是 `x64`，但作业名仍是 `arm-trial / ...`。手册已写明“试跑任务也会落到 CI VPS 的检查 runner 上”，文档与代码一致；风险在于人把这次 x64 结论误读成 ARM 结论，污染“连续 20 次一致”的对比数据。
- 证据：`install-runner`/`arm-fallback` 的标签逻辑与手册第 180 行；`run.mjs:70-71` 的 `[member.arch, member.alternateArch].includes(arch)` 使 x64 被接受。
- 建议：试跑作业在摘要里显式记录实际 `process.platform`/`process.arch`（或当 `arm-fallback` 生效时直接跳过试跑），让对比数据能区分“ARM 实测”和“x64 应急”。严重度低，因为手册已提示。

### 3. 低：`install-arm-runners.sh` 第 5 步的跳过条件可能跳过“只装了一半”的安装

- 文件：`scripts/operations/ci-runner/install-arm-runners.sh:60-64,20`
- 问题：只要 `gh-runner-arm-1.service` **或** `gh-runner-arm-2.service` 有一个在跑，就跳过整个第 5 步（两个 runner + 报告账号都不再安装）。正常失败有回滚，但如果上一次被硬中断（SIGKILL/断电）导致一个服务已起来、另一个和 `gh-ci-send` 没建成，重跑会跳过第 5 步，然后在第 7 步 `register-runner.sh 5` 失败。脚本第 20 行的提示“finished steps are repeated safely”在这个边界不成立。
- 证据（亲自读到）：
  - `install-arm-runners.sh:60`：`if on_arm "systemctl is-active --quiet gh-runner-arm-1.service || systemctl is-active --quiet gh-runner-arm-2.service"; then`
  - `install-arm-runners.sh:61`：`echo "a runner service is already running ... so the install is not repeated ..."`
- 建议：跳过条件改成“两个服务都在跑且 `gh-ci-send` 存在”才跳过；否则重跑 `install-runner.sh`（它是可重复的，失败会回滚）。

### 4. 低：`run-share.mjs` 的 `pulled` 计数在摘要校验前就加一，失败时会同时算“已拉取”和“缺失”

- 文件：`scripts/ci/run-share.mjs:131-137,191`
- 问题：`pulled += 1` 在 `get`（摘要校验）之前执行。若 `get` 因 `CI_SHARE_DIGEST_MISMATCH` 抛错，该成员既被计入 `pulled`，又被塞进 `missing`，日志会打印 `CI_SHARE_COLLECT N pulled=X` 同时列出缺失；拉下来的字节也仍留在共享目录里。这是同一功能早前提交引入的，不在本轮增量，但属于本轮要核对的“错误路径”。
- 证据（亲自读到）：
  - `run-share.mjs:131-138`：`pulled += 1;` 后紧接 `await get(...)`，`get` 抛错被 `catch` 成 `missing.push(...)`。
  - `run-share.mjs:191`：`CI_SHARE_COLLECT ${result.collected}${result.pulled ? ` pulled=${result.pulled}` : ""}`。
- 建议：把 `pulled += 1` 移到 `get` 成功之后；`get` 失败时删除刚拉下的目录，避免“半成功”留在共享目录。另：`remote-share.mjs:111-116` 在解析前把整个响应缓冲到 `responseBytes`（96 MiB），恶意/异常 ARM 端可迫使每次报告最多占 96 MiB 内存；限额已文档化且只在切换后使用，风险低，但可考虑流式解析或更低上限。

### 5. 提示：runbook 的 `contract_sha256` 没有找到校验方

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:5`
- 问题：本轮把 `contract_sha256` 改成了 `sha256:965235...`，但我在 `*.mjs`/`*.json` 里没找到读取或校验 `contract_sha256` 的代码。这个哈希是否对应新正文，**未核实**；如果它本意是封存契约，目前没有自动检查支撑。
- 建议：要么加一个校验（计算正文摘要并比对），要么在 front matter 说明它是人工维护的说明性字段。

### 6. 提示：`ci-arm-trial.yml` 不在 `validateWorkflow` 的校验范围，只靠单元测试守着

- 文件：`scripts/ci/check-policy.mjs:1417-1425`、`test/tooling/policy.test.mjs:1290-1297`
- 问题：`check-policy.mjs` 校验的是 `ci.yml`（以及 `quality.yml`/`main.yml`），没有校验 `.github/workflows/ci-arm-trial.yml`。这次新增的草稿条件、权限、Action 固定 SHA、checkout 不留凭证的断言只在 `policy.test.mjs` 里。该测试属于必过的 `policy` 作业，所以当前有保护；但若以后有人搬走/删掉这段测试，试跑工作流就完全失去自动化约束。
- 建议：把试跑工作流也纳入 `validateWorkflow`（或抽一个共享校验函数），让“文件本身”而不是“某段测试”来保证这些属性。

---

## 读代码证实的 / 推测的

**读代码证实：**
- `aggregate.mjs:99-101` 现在严格比较 `arch === member.arch`；`ci/policy.json` 中 policy/static/security/build 的 `arch` 都是 `x64`。
- `ci.yml:362` 的 `collect` 没有 `--remote-jobs`；试跑工作流没有 `run-share put`，也不给 `ci/required` 供 `needs`。因此必过门的报告只来自 CI VPS 本地共享目录（x64）。
- `run.mjs:70-71` 与 `runner.test.mjs:360-372` 一致：三项检查在 arm64/x64 都允许入场，build/coverage/required 只允许 x64。
- `aggregate.test.mjs:401-409` 的 arm64 反向用例在旧 `[member.arch, member.alternateArch]` 逻辑下会失败（policy/static/security 会被判 passed），因此能防回归。
- `policy.test.mjs:1290-1297` 的四条新断言与 `ci-arm-trial.yml:21,30-33,63-66` 完全对应；改掉任一项会失败。
- 手册第 195 行“现在没有工作流传 `--remote-jobs`”与代码一致：全仓只有 `run-share.mjs` 和 `remote-share.test.mjs` 出现该参数。
- `install-arm-runners.sh:98` 的成功提示与 `ci-runner-scripts.test.mjs:2767` 的断言一致。
- `check-policy.mjs` 的 `runnerLabelFor`/schema 目前不允许 `ci-arm` 作为成员 runner（问题 1 的依据）。

**推测/未核实：**
- 测试实际是否通过：**未运行**（本轮只能用 read/grep/glob 和 git 命令），结论来自读代码。
- `contract_sha256` 的新值是否正确：**未核实**（找不到校验方）。
- 是否有外部日志解析器依赖 `CI_SHARE_COLLECT <n>` 的精确格式：我未穷尽搜索，`pulled=` 后缀可能影响未知的消费方。
- 切换 PR 是否会顺带改 schema/`runnerLabelFor`：属于计划推测；当前代码事实（写不出来）已核实。

---

## 侧重检查

- **错误路径**：`remote-share.mjs:124-155` 对响应做 JSON 形状、`run`/`name` 匹配、路径安全、大小/数量/总量、重复路径校验；`pullRemoteReport:158-189` 用暂存目录 + `rename`，失败清理。`run-share.mjs:126-138` 把单成员错误收进 `missing`，最终 gate 失败。发现的计数问题见问题 4。
- **不合规范/不可信输入**：试跑工作流在 `pull_request` 上跑自托管 ARM；`ci-arm-trial.yml` 工作流级权限只有 `contents: read`/`pull-requests: read`，checkout `persist-credentials: false`，Action 固定 SHA；但这些属性目前只由 `policy.test.mjs` 守，`validateWorkflow` 不覆盖该文件（问题 6）。`send-reports.py` 用 `O_NOFOLLOW`、`st_nlink == 1`、`SEGMENT` 白名单、`MAX_DEPTH=8` 拒绝符号链接/硬链接/异常文件名。
- **安全**：报告账号 `authorized_keys` 使用 `restrict,from="<IPv4>",command=".../send-reports"`（`install-runner.sh:130`）；`SEND_KEY`/`SEND_FROM` 正则拒绝 `",command=...` 之类的选项注入（`install-runner.sh:29-30`）；注册令牌走 stdin（`install-arm-runners.sh:82`），测试断言令牌不出现在命令行；CI VPS 私钥 `0440 root:gh-runner-gate`（`install-gate-remote.sh:49`）；ARM 机器上不放能连别处的私钥。未发现本轮新增的密钥外泄路径。
- **资源耗尽**：ARM 两个 runner 的 slice 上限 18 GB（`gh-arm-runners.slice`，测试断言）；远程拉取单次响应最多 96 MiB（问题 4 备注）；`install-arm-runners.sh:87-96` 有 3 分钟等待上限，不会无限循环。
- **不可撤销操作**：本轮增量没有新增删除/覆盖命令；`install-arm-runners.sh`/`arm-fallback.sh`/`uninstall-runner.sh` 的破坏性行为沿用之前版本。问题 3 的跳过条件不会造成数据丢失，但会造成“看似成功、实际缺 runner”的误导。
- **规则/文档与代码一致**：模型请求相关规则未被触发（见必答问题 1）。手册第 180、195 行与代码一致；`contract_sha256` 无校验（问题 5）；`ci-arm-trial.yml` 不在 `validateWorkflow`（问题 6）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮 diff 只涉及 CI 脚本、工作流、测试、runbook（`git diff --stat` 文件清单），没有改系统提示、工具定义、历史消息或遮盖代码。发给模型的内容仍然只在末尾追加，每轮变化的值仍应在最后一条用户消息里；本轮没有触碰这条路径。唯一与“输入”沾边的是 `run.mjs:254` 把 `ci-arm-trial.yml` 加进 actionlint 的检查文件列表，那是 CI 检查的输入，不是模型请求。依据：diff 文件清单 + `prompt-prefix.md` 的“只追加”规则；未发现任何提示词/遮盖相关文件被改。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会（就模型请求而言）。本轮没有改任何提示词、序列化或遮盖逻辑。CI 侧新增的 `process.pid` 只用于本地暂存目录名（`remote-share.mjs:173`），随后被 `rename`，不进报告字段；`CI_SHARE_COLLECT ... pulled=N` 只是日志；`send-reports.py` 的 `os.listdir` 排序后输出，报告文件顺序是确定的；`aggregate` 的 `expected`/`observed` 来自策略顺序，也不是无序集合。因此模型请求字节不受影响。若问题指 CI 产物，需注意上述日志/临时路径会随运行变化，但它们不进入模型上下文。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。`aggregate.test.mjs:401-409` 对 policy/static/security/build 逐个把 `toolchain.arch` 改成 `arm64` 并断言失败；如果 `aggregate` 退回旧的 `[member.arch, member.alternateArch]` 逻辑，policy/static/security 会被判通过，断言就会失败——**会失败**，能防回归。`policy.test.mjs:1290-1297` 对试跑工作流的草稿条件、job 级权限、Action 40 位 SHA、checkout 的 `fetch-depth: 0`/`persist-credentials: false` 逐条断言；改掉工作流任一项都会失败。`runner.test.mjs:360-372` 覆盖入场侧 x64/arm64 的允许矩阵。限制：我**没有运行测试**（工具限制），以上是读代码判断；另外没有单独的端到端用例把 arm64 报告真正送进 `ci/required`，但 `aggregate` 是 `required.mjs` 的唯一判定入口，单元覆盖足够。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `toolchain.arch`（`run.mjs:112` 产生）：使用方 `aggregate.mjs:99-101` 只接受 `member.arch`（x64），`run.mjs:70-71` 入场接受 x64/arm64（三项检查）。两端与意图一致：入场允许试跑，门只认 x64。
   - `alternateArch`（`policy.json`/schema 产生）：使用方只有 `run.mjs:71` 和 `check-policy.mjs:370`（校验），`aggregate` 不再使用；这是问题 1 的不一致。
   - `--remote-jobs`（`run-share.mjs:158,177` 产生）：`collect` 校验正则并交给 `remoteShareConfig`/`pullRemoteReport`；当前没有工作流传它，手册也标成切换后才用。两端一致。
   - `CI_SHARE_COLLECT ... pulled=N`（`run-share.mjs:191` 产生）：工作流不解析它，测试只断言行为；未发现强依赖精确格式的消费方（未穷尽）。
   - `ARM_INSTALL_OK` 文本（`install-arm-runners.sh:98` 产生）：消费方是测试的精确字符串断言和人工；无脚本解析，安全。
   - `runner` 枚举/schema：`ci-arm` 不在枚举，`validatePolicy` 也不接受（问题 1）；目前没有把成员 runner 写成 `ci-arm` 的地方，所以运行时无冲突，但未来切换会卡住。
   - `send-reports.py` 的 `MAX_FILES/MAX_FILE_BYTES/MAX_TOTAL_BYTES`：与 `remote-share.mjs` 的 `REMOTE_LIMITS` 由测试 `send-reports.py and remote-share.mjs use the same limits` 对齐（500/16 MiB/64 MiB），两端一致。
   - `contract_sha256`：找不到使用方，**未核实**。

整体判断：核心安全属性（必过结论只来自 x64）在本轮成立；主要遗留是 `alternateArch` 与切换路径的策略/校验不一致（问题 1）和几处错误路径细节（问题 3、4）。
