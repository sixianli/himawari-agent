## 结论

未发现会改变模型请求开头、或让新的升级函数放行本应被拒策略的高严重度代码缺陷。升级链和主要反向路径按代码阅读推理成立。发现 1 个中危资源风险（未测量）和几处低危文档/测试问题。受工具限制，未实际运行 vitest 或 `npm run check`。

## 推测/未核实

### [中] `ci/required` 改到 2 GB 的 gate runner 上跑，没有证明装工具和装依赖放得下

- 文件：`scripts/operations/ci-runner/runners.sh:42-45`、`scripts/operations/ci-runner/ghgate.slice:6-9`、`.github/workflows/ci.yml:357-362`
- 问题：gate runner 的 slice 是 `MemoryMin=2G`、`MemoryHigh=2G`、`MemoryMax=2G`、`MemorySwapMax=0`；而 `ci/required` 现在要在这个 slice 里运行安装工具、安装汇总器依赖和收集报告。若峰值超过 2 GB，进程会被 OOM 杀掉；因为只有 3 号 runner 带 `ci-vps-gate`，所有 PR 的汇总作业都会一起失败。
- 证据：
  ```
  RUNNER_MEMORY_MIN=2G
  RUNNER_MEMORY_HIGH=2G
  RUNNER_MEMORY_MAX=2G
  ```
  ```
  - name: 安装并核验固定工具
    run: node scripts/ci/install-tools.mjs --directory .ci-output/tools --node "$CI_NODE" --without-scanners
  - name: 安装汇总器最小依赖
    run: .ci-output/tools/bin/node scripts/ci/install-gate-dependencies.mjs
  - name: 从 CI 服务器取本次各任务的报告并核对摘要
    run: .ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports
  ```
  ADR 自己也写了“2 GB 够不够先在 VPS 上量一次汇总作业的峰值再定”（`docs/adr/0256-gate-job-gets-its-own-runner.md:84`）。
- 建议：合并前在 VPS 上用真实汇总作业量一次峰值；如果接近 2 GB，先提高上限或把步骤拆小。至少加一条上线后的资源监控，不要靠首次 PR 失败来发现。
- 未核实：3 号 runner 当前是否在线、是否只有一个 `ci-vps-gate` 标签、以及实际峰值内存；这些只能从服务器或 GitHub 读到，仓库代码里没有。

## 读代码证实的问题

### [低] ADR 0172 的决定正文仍让人“给每个 runner 加回 ci-vps”，和恢复脚本的按 runner 取标签冲突

- 文件：`docs/adr/0172-resume-runners-labels-first.md:60`、`scripts/operations/ci-runner/mac-runners.sh:77-79`、`scripts/operations/ci-runner/runners.sh:56-62`
- 问题：ADR 0172 仍写：
  ```
  给每个缺标签的 runner 加回 `ci-vps`
  ```
  但恢复脚本实际用 `runner_label_for_name` 给每个 runner 取自己的标签，3 号应得到 `ci-vps-gate`。照 ADR 正文操作会把 `ci-vps` 加到 gate runner 上，破坏“检查作业永远不落到 gate runner”的隔离。
- 证据：`mac-runners.sh:78` 是 `runner_label_for_name "$1"`，`runners.sh:60` 根据 runner 名字返回 `RUNNER_LABEL`；`runners.sh:39-47` 里 3 号返回 `RUNNER_GATE_LABEL`。
- 建议：在 ADR 0172 的恢复步骤里直接改成“按 runner 自己的标签恢复，检查 runner 加 `ci-vps`，汇总 runner 加 `ci-vps-gate`”，不要只靠 `amended_by` 跳转。

### [低] ADR 0176 仍说标签只在两处定义、且写的是旧的 `RUNNER_LABEL`

- 文件：`docs/adr/0176-ci-on-ovh-vps.md:72`、`scripts/ci/contracts.mjs:7-8`、`scripts/operations/ci-runner/runners.sh:3-5`
- 问题：ADR 0176 写“标签只在 `scripts/ci/contracts.mjs` 的 `linuxRunnerLabel` 和 `scripts/operations/ci-runner/runners.sh` 的 `RUNNER_LABEL` 两处定义”。现在 contracts 有 `linuxRunnerLabel` 和 `gateRunnerLabel` 两个值，runners.sh 也改成了 `RUNNER_CHECK_LABEL`、`RUNNER_GATE_LABEL`，没有全局 `RUNNER_LABEL`。
- 证据：`contracts.mjs` 第 7、8 行是两个常量；`runners.sh` 第 3、4 行是 `RUNNER_CHECK_LABEL=ci-vps`、`RUNNER_GATE_LABEL=ci-vps-gate`。
- 建议：这次既然在改 ADR 0256 和 ADR 0172，顺手把 ADR 0176 的这段说明改准确，避免以后按旧文档找单一标签定义。

### [低] “只有 required 用汇总标签”的跨文件测试没有检查矩阵里的 runner

- 文件：`test/tooling/ci-runner-scripts.test.mjs:1644-1651`
- 问题：测试标题说“only the required job runs on the gate label”，但它只检查了字面量 `runs-on`：
  ```
  .filter(([, job]) => !String(job["runs-on"]).startsWith("$"))
  ```
  使用 `runs-on: ${{ matrix.runner }}` 的 `build`、`browser` 作业被过滤掉了；如果有人把矩阵 `include` 里的 runner 写成 `ci-vps-gate`，这条测试不会报错。实际生产还有 `validateWorkflow` 会比较矩阵和 policy，所以不是运行时漏洞，但这条测试本身没有兑现标题。
- 建议：除固定 `runs-on` 外，再检查 `job.strategy.matrix.include[].runner` 的每一项；或者直接调用 / 复用 `validateWorkflow` 的矩阵比较逻辑。

### [低] 几条 ADR-0256 反向用例的断言不完整

- 文件：`test/tooling/policy.test.mjs:1184-1185`
- 问题：标题说“别的写法照样被拒”，但九作业这一条只断言：
  ```
  const nineJobs = retiredTestPolicy();
  expect(upgradeGateRunnerPolicy(nineJobs)).toBe(nineJobs);
  ```
  没有调用 `validatePolicy`，所以它没有证明“被拒”。实际上九作业旧写法经过完整链后应该被升级成现行七作业，本来就不该拒绝；这条断言放在“被拒”用例里有误导性。
- 建议：要么把九作业从“被拒”用例移到完整链升级用例（已有 `test/tooling/policy.test.mjs:1148-1154`），要么在这里补上完整的 `resolvePolicySource`/`validatePolicy` 断言。

## 侧重检查

- **错误路径**：`upgradeGateRunnerPolicy` 先取 `checks` 和 `required`，没有 `required` 时 `sameSet(...)` 为假会短路，不会访问 `required.members`；解析坏 JSON 会抛错；升级后紧接着 `validatePolicy`（`scripts/ci/check-policy.mjs:1208-1218`），不会把未校验结果继续使用。未发现新的静默失败路径。
- **不可信输入**：基准 SHA 有正则校验（`scripts/ci/check-policy.mjs:1183-1187`），workflow 用 `parseDocument(..., { uniqueKeys: true, maxAliasCount: 0 })`，shell 步骤禁止 `${{` 插值；`ci-vps-gate` 是字面量，不来自 PR 输入。未发现新的注入面。
- **安全/隔离**：`ci-vps-gate` 只加在 required 作业；gate runner 的用户、`InaccessiblePaths` 和共享目录组权限由上一 PR 的模板处理，本次没有放宽权限。required 作业本来就会执行 PR 里的脚本，信任范围没有改变。
- **资源耗尽**：见上面的 2 GB 风险，未测量。
- **不可撤销操作**：本次只改配置和测试，没有删除或迁移数据；gate 标签可由应急脚本临时转到 1 号 runner，回滚路径存在。
- **未核实**：3 号 runner 的真实在线状态、真实内存峰值、以及测试在 CI 上的实际执行结果。

## 必答问题

1. **是否会改变模型已经见过的请求开头？**
   不会。这次 diff 只涉及 CI 脚本、CI 配置、测试和 ADR，没有任何代码组装或修改系统提示、工具定义、历史消息、资料块或遮盖结果。按 [`prompt-prefix.md:35`](.claude/rules/prompt-prefix.md) 的“已经发出的内容只能追加”，本次没有追加任何模型消息，也没有新增每轮变化的值；因此仍然保持原来的追加语义，只是它完全不在这条路径上。没有发现需要把新值放到最后一条消息的情况。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会发现这种情况。新增的 `gateRunnerLabel` 是固定字符串；`upgradeGateRunnerPolicy` 只确定性地改一个字段；没有时间、随机数或无序集合输出。`policySha256` 仍然按升级前的原始 `bytes` 计算（`scripts/ci/check-policy.mjs:1205-1207,1246`），测试也断言原始字节摘要（`test/tooling/policy.test.mjs:1168-1174`）。`sameSet` 只用于比较，不用于生成输出顺序。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：`package.json:92` 的 `check:ci-policy` 会走 `resolvePolicySource` 和 `validateWorkflow`；`test/tooling/policy.test.mjs:1160-1203` 覆盖升级和拒绝；`test/tooling/ci-runner-scripts.test.mjs:1625-1652` 做跨文件一致性检查。按代码推理：
   - static 写成 `ci-vps-gate` 会命中 `member.runner === runnerLabelFor(check.id)` 的断言并抛 `Incorrect platform: static/default`（`scripts/ci/check-policy.mjs:337-344`）。
   - required 写回 `ci-vps` 会抛 `Incorrect platform: required/default`。
   - workflow 的 required 写回 `ci-vps`、或 static 写成 `ci-vps-gate`，会命中 `job["runs-on"] === check.members[0].runner` 并抛错（`scripts/ci/check-policy.mjs:492-494`）。
   但受工具限制我没有执行测试；而且上面的矩阵测试盲区和九作业断言不完整是真实的覆盖缺口。

4. **每个新值/修改值，生产端和使用端都能接受吗？**
   - `ci-vps-gate`：产生处是 `scripts/ci/contracts.mjs:8`；使用处包括 `check-policy.mjs:191,205`、`ci/policy.json:134`、`ci/policy.schema.json:64`、`.github/workflows/ci.yml:327`、`.github/actionlint.yaml:4`、`scripts/operations/ci-runner/runners.sh:4`。policy 端先过 schema enum，再过 `validatePolicy` 的平台校验；workflow 端用 policy 的 `members[0].runner` 比对；actionlint 只登记标签；runners.sh 的标签没有运行时从 contracts 导入，只靠跨文件测试绑定。`ci-vps-gate` 两边都能通过，未发现 I-73 那类“清单里的 id 过不了后端校验”的问题。
   - `upgradeGateRunnerPolicy` 的产物：立刻交给 `validatePolicy`，之后由 `aggregate`、`required` 等消费；这些消费者只按 job id/成员 key 使用，不依赖 required 的具体 runner，因此能接受升级后的 gate。
   - `policySha256`：仍由原始基准字节产生；`context.mjs:142`、`aggregate.mjs:284`、`export-evidence.mjs:115`、`main-evidence.mjs:217` 都按同一个基准/当前 policy 字节比较。特别是 `main-evidence.mjs:101-113` 禁止 `.github`、`ci`、`scripts/ci` 有改动的 PR 走轻量确认，所以改 policy 或 workflow 的 PR 不会拿旧摘要冒充新摘要，未发现摘要两端不一致的路径。
   - 作者说“只升级那一种写法”不完全精确：`upgradeGateRunnerPolicy` 实际只校验 job id 集合、required 只有一个成员、该成员 runner 是 `ci-vps`（`scripts/ci/check-policy.mjs:193-206`），其余字段交给后续 `validatePolicy` 接受或拒绝。因为基准则来自受信的目标分支，且后续校验完整，我没有构造出它放行本应拒绝策略的路径；但这句话和代码行为不完全一致，建议改说明或在升级函数里像 `upgradeRetiredTestChecks` 一样逐字段核对。
