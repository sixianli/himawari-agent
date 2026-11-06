## 发现（按严重度）

### [中] ADR 0168 仍把当前 CPU 限额写成每个 runner 2 核、合计 3 核

- 文件:行：`docs/adr/0168-longer-ci-job-limits-on-hermes.md:37`
- 问题：本 PR 之后 slice 和服务都没有 `CPUQuota`，runner 可以用满 4 核；但 0168 仍把这写成当前事实，并引用 ADR 0171。作者说法 4“其他地方没有写死旧数值”不成立。
- 证据（亲自读到）：
  - `docs/adr/0168-longer-ci-job-limits-on-hermes.md:37`：`每个 runner 最多用 2 核，两个合计最多 3 核（[ADR 0171](0171-two-runners-on-hermes.md)）；GitHub 托管的 ubuntu-24.04 是 4 核。`
  - `scripts/operations/hermes-runner/gh-runners.slice:5-9` 只有 `MemoryHigh=13G`、`MemoryMax=14G`、`MemorySwapMax=0`、`TasksMax=4096`，没有 `CPUQuota`。
  - `scripts/operations/hermes-runner/gh-runner.service.in:22-26` 同样没有 `CPUQuota`/`CPUWeight`/`IOWeight`/`Nice`。
- 建议：在同一 PR 把这句改成“按 ADR 0173，runner 不再限 CPU，可用满 4 核”，或在 0168 顶部加注说明该背景事实已被 ADR 0173 修正。

### [中] ADR 0171 没有记录被 ADR 0173 修订，`amends` 不是双向

- 文件:行：`docs/adr/0171-two-runners-on-hermes.md:1-9`、`:11`、`:60`
- 问题：ADR 0173 的 `amends` 指向 0171，但 0171 既没有 `amended_by`，正文也没有指向 0173 的说明；0171 仍是 `active / accepted`，标题和决定第 2 条继续写“合计最多 3 核 6 GB”“`CPUQuota=300%`、`MemoryHigh=5632M`、`MemoryMax=6G`、`CPUWeight=20`、`IOWeight=20`”。作者说法 3“`supersedes` 和 `amends` 双向一致”不成立。读者按 0171 行动会得到旧限额。仓库里 `docs/adr/0031-isolated-tool-execution.md:139` 明确写明采用双向 `amends`/`amended_by` 元数据。
- 证据（亲自读到）：
  - `docs/adr/0173-hermes-runs-only-ci.md:7`：`amends: "docs/adr/0171-two-runners-on-hermes.md"`
  - `docs/adr/0171-two-runners-on-hermes.md:1-9`：frontmatter 只有 `supersedes`、`superseded_by`、`amends`，没有 `amended_by`。
  - `docs/adr/0171-two-runners-on-hermes.md:11`：`# ADR 0171：Hermes 上跑两个常驻 runner，合计最多 3 核 6 GB`
  - `docs/adr/0171-two-runners-on-hermes.md:60`：仍写 `CPUQuota=300%`、`MemoryHigh=5632M`、`MemoryMax=6G`、`CPUWeight=20`、`IOWeight=20`。
- 建议：给 0171 增加 `amended_by: "docs/adr/0173-hermes-runs-only-ci.md"`，并在正文顶部加一行“决定第 2 条已由 ADR 0173 修正”；旧正文保持不变，符合“不改写旧 ADR 决定内容”的治理规则。

### [低] ADR 0160 的限额描述也过期（旧问题，但同样说明“其他地方没有写死旧数值”不成立）

- 文件:行：`docs/adr/0160-self-hosted-runner-on-hermes.md:67`
- 问题：仍写“CPU 最多两个核、内存最多 5 GB、不用交换分区，CPU 和磁盘读写的优先级低于 Hermes 上的其他服务”。这在本 PR 之前已被 ADR 0170/0171 部分改过，本 PR 又让 CPU 和优先级部分失效。
- 证据（亲自读到）：`docs/adr/0160-self-hosted-runner-on-hermes.md:67` 原文如上；当前 `gh-runners.slice` 已无 CPU/IO 权重，服务已无 `Nice`。
- 建议：加注“当前限额以 ADR 0173 为准”，或直接修正这句。

### [低] 自动检查存在，但本提交没有运行；文档关系没有被仓库内自动检查覆盖

- 文件:行：`test/tooling/hermes-runner-scripts.test.mjs:657-706`
- 问题：单元测试确实覆盖了新的 `MemoryHigh`/`MemoryMax`/`MemorySwapMax`/`TasksMax`，并断言旧的 CPU/优先级键不存在；但提交说明明确写 `Layer-0-tests: 未运行`，GitHub Actions 也已暂停，所以没有实际执行证据。文档侧仓库内只有 ADR 编号检查（`scripts/check-adr-numbers.mjs`），不检查 `supersedes`/`amends` 双向关系；Runbook 的 `contract_sha256` 校验器不在仓库内，无法核实。
- 证据（亲自读到）：
  - `test/tooling/hermes-runner-scripts.test.mjs:663-671` 断言 slice 的 `MemoryHigh=13G`、`MemoryMax=14G`、`MemorySwapMax=0`、`TasksMax=4096`，并循环断言 `CPUQuota`/`CPUWeight`/`IOWeight` 不存在。
  - `test/tooling/hermes-runner-scripts.test.mjs:685-704` 对每个 runner 断言 `MemoryHigh=12G`、`MemoryMax=13G`、`MemorySwapMax=0`、`TasksMax=2048`，并断言 `CPUQuota`/`CPUWeight`/`IOWeight`/`Nice` 不存在。
  - 提交 `61da6cc7` 的说明：`Layer-0-tests: 未运行；Mac 上不跑测试，GitHub Actions 工作流已按 Andy 要求暂停。`
- 建议：在环境允许时运行 `npx vitest run test/tooling/hermes-runner-scripts.test.mjs` 并记录结果；恢复 CI 后把该文件纳入必跑检查。文档关系建议在 `document-governance` 严格校验中复核。

### [低/推测] 1.4 GiB 余量不是“保留”，`MemoryMax` 不能“保证” ssh 能登录

- 文件:行：`docs/adr/0173-hermes-runs-only-ci.md:60`、`scripts/operations/hermes-runner/gh-runners.slice:7`
- 问题：`MemoryMax=14G` 只是给 runner 组设上限，不是给 ssh/tailscale 预留内存；组外进程（docker 守护进程、journald、cloudflared 等）用量上升时，1.4 GiB 余量可能不足，仍可能触发全局 OOM。当前没有 `MemoryMin`/`MemoryLow` 或对 system.slice 的保护。
- 证据（亲自读到）：`docs/adr/0173-hermes-runs-only-ci.md:60` 写“留约 1.4 GiB 给 ssh、tailscale、cloudflared、docker 守护进程和系统日志，保证内存用满时还能远程登录”；`gh-runners.slice:7` 是 `MemoryMax=14G`。
- 建议：把“保证”改成“留出余量”，并在 Hermes 上实测；若要更强保证，给系统关键服务设 `MemoryMin`/`MemoryLow`，或把 runner 的 `MemoryMax` 再降一点。这是设计风险，不是本 PR 必然的错误。

---

## 侧重检查

- **错误路径**：`install-runner.sh` 只通过 `render_runner_unit` 做占位符替换并复制 slice（`scripts/operations/hermes-runner/install-runner.sh:84`、`:96`），不解析 `MemoryHigh`/`MemoryMax`/`TasksMax` 等键，删除旧键不会破坏安装逻辑。systemd 会在 `daemon-reload`/启动时拒绝非法值；当前值都是合法单位。未发现新增错误路径。
- **不合规范或不可信的输入**：本 PR 不新增读取外部输入的地方；CI 任务的输入路径、加固项、防火墙规则都没变。`ProtectSystem`、`ProtectProc`、`InaccessiblePaths`、`MemorySwapMax=0`、`TasksMax` 都保留（`gh-runner.service.in:25-36`）。
- **安全**：去掉 `Nice=10`、`CPUWeight`、`IOWeight` 只影响调度优先级，不削弱账号隔离、文件系统保护、`/proc` 隐藏或防火墙。未发现安全回归。
- **资源耗尽**：这是本次唯一实质风险，见上面“1.4 GiB 余量”一条。runner 组内 OOM 仍被 `MemoryMax` 限制在组内，磁盘下限 16 GiB、`TasksMax` 未变；但“ssh 一定能登录”不是硬保证。
- **不可撤销操作**：本 diff 不含删除、迁移或不可逆写入；安装脚本的备份/恢复逻辑未改。ADR 里“停掉 38 个容器”是已发生的运维动作，不在本 PR 代码里。

---

## 已证实的与推测的

**读代码证实：**

- 新断言的值与单元文件逐字一致，`unitSettings` 能读出 `MemorySwapMax`、`TasksMax`（它按 `/^[A-Za-z]+=/` 取键，见 `test/tooling/hermes-runner-scripts.test.mjs:63-69`）。
- `gh-runner.service.in` 和 `gh-runners.slice` 的实际值与 ADR 0173、Runbook 第 64/107 行说明一致。
- Runbook 预检字节数正确：`13G = 13958643712`，`14G = 15032385536`。
- ADR 0170 的 `superseded_by` 与 ADR 0173 的 `supersedes` 双向一致；0173 的编号在仓库内唯一，没有 0172/0173 重号。
- 安装脚本不解析这些数值，删除 CPU/优先级键不会影响安装流程。
- 本 PR 的 diff 没有触及系统提示、工具定义、历史消息、遮盖结果或任何模型请求构造代码。

**推测或未核实：**

- Runbook 的新 `contract_sha256` 是否正确：`document-governance` 技能不在本仓库、当前环境也没有该技能，无法运行 `runbook.py seal` 或 `validate_docs.py --strict` 复算，标为未核实。
- 1.4 GiB 余量在真实压力下是否足够、`MemoryMax` 能否“保证”ssh 登录：属于运行时风险，未在 Hermes 上实测。
- ADR 0160/0168 的过期程度和读者影响：读代码确认文本过期，但实际使用频率未核实。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。本 PR 的改动只涉及 `docs/adr/`、`docs/runbooks/`、`scripts/operations/hermes-runner/` 和 `test/tooling/hermes-runner-scripts.test.mjs`，没有触及系统提示、工具定义、历史消息或遮盖结果。发给模型的内容是否仍然只在末尾追加、每轮变化值是否都在最后一条消息里，本 PR 未修改相关代码；该全局性质不在本次 diff 内，未核实。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**
不会。改动引入的是固定的 systemd 数值、固定的文档路径和固定的测试断言；没有依赖前后文的遮盖、时间字段或无序集合。ADR 的 `date` 和 Runbook 的 `contract_sha256` 都是固定字符串，不会在请求之间变化。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有。`test/tooling/hermes-runner-scripts.test.mjs:657-706` 覆盖了 slice 和两个 runner 的数值；如果删掉或改错 `TasksMax`/`MemorySwapMax`，`toMatchObject` 会失败；如果重新加入 `CPUQuota`、`CPUWeight`、`IOWeight`、`Nice`，`not.toHaveProperty` 会失败。反向用例在逻辑上确实会失败，但本次提交没有实际运行（提交说明写明未运行），所以没有执行证据。文档侧的 ADR 关系没有被仓库内自动检查覆盖。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
逐个核对如下：
- 服务 `MemoryHigh=12G`、`MemoryMax=13G`、`MemorySwapMax=0`、`TasksMax=2048`：systemd 接受；测试 `unitSettings` 能读出；Runbook 第 64 行说明一致。
- slice `MemoryHigh=13G`、`MemoryMax=14G`、`MemorySwapMax=0`、`TasksMax=4096`：systemd 接受；测试能读出；Runbook 第 64/107 行说明和字节数一致。
- 被删除的 `CPUQuota`、`CPUWeight`、`IOWeight`、`Nice`：测试断言不存在；安装脚本不依赖；systemd 回到默认值。
- ADR 0170 的 `status`/`decision_status`/`superseded_by`：`superseded_by` 指向存在的 `docs/adr/0173-hermes-runs-only-ci.md`。
- ADR 0173 的 `supersedes`/`amends`：两个路径都存在（0170、0171）。
- ADR 编号 0173：仓库内唯一，符合 `check-adr-numbers` 的四位编号要求。
- Runbook 的 `contract_sha256`：消费方是 `validate_docs.py`/`runbook.py`，不在仓库内，无法验证是否正确（未核实）。
- 测试新增的键名：`unitSettings` 用 `/^[A-Za-z]+=/` 解析，`MemorySwapMax`、`TasksMax` 都符合，能读出。

**结论：** 未发现会阻断部署的高严重度代码问题；新断言的数值和 `unitSettings` 读取能力与第二轮说法一致。主要问题是文档一致性：ADR 0168 仍在陈述旧的 CPU 限额，ADR 0171 没有被标记为被 0173 修订，作者关于“双向一致”和“其他地方没有写死旧数值”的说法不完全成立。
