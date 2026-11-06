复核结论：未发现会改变发给模型内容的问题；确认 1 个 ADR 元数据不双向、1 个测试覆盖缺口、1 个 Runbook 与 ADR 叙事不一致，以及移除 CPU/IO 限制后的资源耗尽残余风险。作者第 3 条说法不成立。

## 一、读代码证实的问题（按严重度）

### 中：ADR 0173 对 ADR 0171 的 `amends` 不是双向的
- 文件：`docs/adr/0171-two-runners-on-hermes.md:5-7`、`docs/adr/0173-hermes-runs-only-ci.md:5-7`、`docs/adr/0170-more-memory-for-hermes-runners.md:6-7`
- 问题：0173 写 `amends: "docs/adr/0171-..."`，但 0171 的 frontmatter 只有 `supersedes`、`superseded_by`、`amends`，没有 `amended_by`。项目里已有明确约定要双向记录：
  - `docs/adr/0031-isolated-tool-execution.md:139`：`采用双向 amends / amended_by 元数据及正文范围链接`
- 证据：
  - 0171 第 5-7 行：`supersedes: ""`、`superseded_by: ""`、`amends: "docs/adr/0160-self-hosted-runner-on-hermes.md"`，没有 `amended_by`。
  - 0173 第 7 行：`amends: "docs/adr/0171-two-runners-on-hermes.md"`。
  - 0170 第 7 行同样是 `amends: "docs/adr/0171-two-runners-on-hermes.md"`，但 0171 也没有 `amended_by`；这是既有问题，本 PR 新增第二次 amend 时仍未补齐。
- 影响：从 0171 看不到 0170 和 0173 对它做过修订；若文档校验器检查 `amends`/`amended_by` 配对，会报错（该校验器不在仓库内，是否强制检查未核实）。
- 建议：在 0171 增加 `amended_by: "docs/adr/0170-more-memory-for-hermes-runners.md, docs/adr/0173-hermes-runs-only-ci.md"`，并跑一次严格文档校验。

### 低：测试没有覆盖“保留项”TasksMax 和服务的 MemorySwapMax
- 文件：`test/tooling/hermes-runner-scripts.test.mjs:662-671`、`test/tooling/hermes-runner-scripts.test.mjs:684-701`
- 问题：测试覆盖了新内存值和“旧 CPU/优先级键不存在”，但没有断言服务保留 `MemorySwapMax=0`、`TasksMax=2048`，也没有断言 slice 保留 `TasksMax=4096`。PR 目标明确说“保留不用交换分区和进程数上限”，这部分没有回归保护。
- 证据：
  - slice 断言只有：
    ```js
    expect(slice()).toMatchObject({
      MemoryHigh: "13G",
      MemoryMax: "14G",
      MemorySwapMax: "0",
    });
    ```
    没有 `TasksMax`。
  - 服务断言包含 `MemoryHigh: "12G"`、`MemoryMax: "13G"`，但没有 `MemorySwapMax`、`TasksMax`。
  - 当前文件确实保留了这些项：`gh-runner.service.in:25-26`、`gh-runners.slice:8-9`。
- 影响：以后有人误删 `TasksMax` 或服务的 `MemorySwapMax`，现有测试不会失败；作者第 2 条说法只对“新数值 + 旧 CPU/优先级键”成立，对“保留项”不成立。
- 建议：在 slice 断言加 `TasksMax: "4096"`，在服务断言加 `MemorySwapMax: "0"`、`TasksMax: "2048"`。

### 低：Runbook 仍按“共享主机”叙述，与 ADR 0173 的“只跑 CI”不一致
- 文件：`docs/runbooks/hermes-self-hosted-runner-runbook.md:17`、`:39`、`:89`、`:219`
- 问题：ADR 0173 说 Hermes 上其他服务全部停掉，只跑 CI（`docs/adr/0173-hermes-runs-only-ci.md` 决定第 4 条、后果一节）；Runbook 仍写“Hermes 上其他服务、容器和数据一律不碰”“共享主机：不清理、修改或重启任何不属于 runner 的容器、镜像、服务或数据”，Stop Conditions 还以“其他服务状态变化”为停机条件。作为安全守则本身仍然保守正确，但会让操作者误以为其他服务还在运行，且 Runbook 开头的“为什么这样做”只链接 0160/0171，没有 0173。
- 证据：
  - 第 39 行：`**不管的范围**：... Hermes 上其他服务、容器和数据一律不碰。`
  - 第 89 行：`**共享主机**：不清理、修改或重启任何不属于 runner 的容器、镜像、服务或数据...`
  - 第 219 行：`Hermes 上其他服务的状态、端口或容器重启次数在操作后发生变化。`
  - 第 17 行只写：`为什么这样做见 [ADR 0160]... 和 [ADR 0171]...`
- 建议：在第 39/89 行说明“其他服务已按 ADR 0173 停止；本手册仍不负责管理它们”，第 219 行改为针对 runner/ssh/tailscale 的回归检查，第 17 行补上 ADR 0173。

### 低（残余风险）：移除 CPU/IO 限制后，CI 任务可占满 CPU 和磁盘，内存上限是唯一硬边界
- 文件：`scripts/operations/hermes-runner/gh-runner.service.in:22-26`、`scripts/operations/hermes-runner/gh-runners.slice:5-9`、`.github/workflows/ci.yml:2-3,33`
- 问题：新配置保留了 `MemoryHigh/MemoryMax`、`MemorySwapMax=0`、`TasksMax`，但完全去掉了 `CPUQuota`、`CPUWeight`、`IOWeight`、`Nice`。一个失控或恶意的 CI 任务可以把 4 核和磁盘占满，`TasksMax=2048/4096` 仍允许大量进程，可能让 ssh/tailscale 登录变慢。内存仍有 14G 硬上限，因此“内存用满时还能登录”主要靠 1.4G 余量，而不是 CPU/IO 保护。
- 证据：
  - 服务模板只剩 `MemoryHigh=12G`、`MemoryMax=13G`、`MemorySwapMax=0`、`TasksMax=2048`，没有 CPU/优先级项。
  - slice 只剩 `MemoryHigh=13G`、`MemoryMax=14G`、`MemorySwapMax=0`、`TasksMax=4096`。
  - `ci.yml` 在 `pull_request` 上触发，并 `runs-on: hermes-home`；这是既有配置，不是本 PR 引入。
- 影响：这是 ADR 0173 明确选择的取舍（机器只跑 CI），不是代码错误；但属于本 PR 放大的资源耗尽风险，且没有自动检查。
- 建议：至少在 Runbook 增加 CPU/IO 饱和时的诊断和恢复步骤；若担心登录，考虑保留一个较低的 CPU/IO 保护项或降低 `TasksMax`，由 Andy 决定。

## 二、作者说法逐条核对

1. **“单元文件和 slice 的数值与 ADR 0173、Runbook 完全一致，Runbook 旧上限都已改掉或仍正确”**：基本成立。
   - `gh-runner.service.in:23-24` 是 `MemoryHigh=12G`、`MemoryMax=13G`；`gh-runners.slice:6-7` 是 `MemoryHigh=13G`、`MemoryMax=14G`；`docs/adr/0173-hermes-runs-only-ci.md:60-61` 相同；`docs/runbooks/hermes-self-hosted-runner-runbook.md:64` 相同。
   - Runbook 第 107 行的 `13958643712`、`15032385536` 分别是 13G、14G 的字节数，算术正确。
   - Runbook 里未再发现 `3 核`、`9 GB`、`7 GB`、`CPUWeight`、`IOWeight`、`Nice` 等旧值；旧值只保留在历史 ADR 0170/0171 和旧证据文件里，属于历史记录。
2. **“测试覆盖新数值，并断言旧 CPU 和优先级设置不存在”**：部分成立。新内存值和旧 CPU/优先级键的断言存在，但“保留项”测试缺口见上文。
3. **“ADR 0170 的 superseded_by、ADR 0173 的 supersedes 和 amends 双向一致”**：**不成立**。0170↔0173 的 `superseded_by`/`supersedes` 双向一致；但 0173→0171 的 `amends` 没有 0171 的 `amended_by` 反向记录。
4. **“安装脚本读单元文件的方式不受影响，其他地方没有写死旧数值”**：基本成立。
   - 安装脚本只是 `render_runner_unit`（`runners.sh:39-45` 的固定 sed 替换）和 `install` 原样复制（`install-runner.sh:84,96`），不解析内存值。
   - 活动脚本/单元文件里没有旧数值；旧数值只出现在 ADR 0170/0171 和 `.agents/tasks/hermes-runner/evidence.jsonl` 的历史记录中。

## 三、侧重检查

- **错误路径**：本次 diff 没有改安装、暂停、恢复脚本逻辑；`install-runner.sh` 的备份/回滚路径未变。新单元值由 systemd 解析，安装脚本没有 `systemd-analyze verify`，但 Runbook 预检第 6 项会读有效值，能在部署后发现配置错误。未发现本 PR 新增的错误处理缺口。
- **不合规范或不可信的输入**：单元文件是静态配置；`render_runner_unit` 只替换固定的账号、目录、名字，新增数值不来自用户输入，没有新的注入面。测试的 `bytes()` 支持 `G` 后缀，新值可解析。
- **安全**：加固项 `NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`ProtectProc=invisible`、`InaccessiblePaths`、防火墙均未改动。变化只是资源限制放宽；主要安全影响是恶意/失控 CI 任务的资源耗尽能力增强，属于 ADR 0173 已接受的取舍。
- **资源耗尽**：内存有 `MemoryMax=13G/14G` 和 `MemorySwapMax=0`，进程数有上限；但 CPU/IO 没有限制或权重。若 CI 任务持续占满 CPU/磁盘，ssh/tailscale 仍可能变慢。ADR 所说“留约 1.4 GiB”依赖整机 15.4 GiB，见“未核实”。
- **不可撤销的操作**：diff 只改配置、文档和测试，不删除数据；安装脚本保留备份与回滚。停掉其他服务是已完成的现场操作，不在本 diff 中。未发现新的不可撤销路径。

## 四、推测与未核实

- **未核实**：`contract_sha256` 新值 `sha256:6bb084...` 是否等于当前 `scripts/operations/hermes-runner` 目录重新封存后的摘要。仓库内没有 `runbook.py`/`validate_docs.py`，无法在本次只读复核中计算；若该值不是在干净检出上用封存工具生成，严格文档校验会报 `contract_sha256 does not match`。
- **未核实**：Hermes 上实际部署的值是否已是新值、是否存在旧 drop-in 覆盖主单元、两个服务是否都未在运行。作者的“已手动部署”无法从仓库验证。
- **未核实**：文档治理技能是否强制检查 `amends`/`amended_by` 双向配对。仓库里只有 ADR 0031 的约定说明，没有校验器源码。
- **未核实**：整机内存到底是 ADR 0173 写的约 15.4 GiB，还是 ADR 0046/0047 写的 15 GiB。若是 15 GiB，`MemoryMax=14G` 后只剩约 1 GiB，而不是 1.4 GiB；不影响配置合法性，但影响“留 1.4 GB 给 ssh/tailscale”的说法。
- **推测**：systemd 在未设置 `CPUQuota` 时，`systemctl show -p CPUQuotaPerSecUSec` 应输出 `infinity`，Runbook 第 107 行的预期大概率正确；未在 Hermes 上实际执行。

## 五、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 只涉及 systemd 单元、slice、Runbook、ADR 和 tooling 测试，没有任何文件位于模型请求组装、系统提示、工具定义、历史消息或遮盖逻辑中。发给模型的内容仍然沿用现有的“只追加”机制；本次没有新增任何每轮变化的值，也没有把变化值移出最后一条用户消息。依据规则见 `.claude/rules/prompt-prefix.md:27-29,35`。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。改动中的日期、内存值、ADR 字段和 `contract_sha256` 都是仓库内静态值，不会进入模型请求；没有改遮盖、序列化、集合排序或时间字段。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   单元/slice 部分有自动检查：`test/tooling/hermes-runner-scripts.test.mjs:662-703`，并且 `ci/policy.json:243` 的 tooling 组包含 `test/tooling/**/*.test.mjs`。把 `MemoryHigh`/`MemoryMax` 改回旧值，或重新加入 `CPUQuota`、`CPUWeight`、`IOWeight`、`Nice`，这些断言会失败，反向用例有效。
   但有三处缺口：
   - 没有断言服务保留 `MemorySwapMax=0`、`TasksMax=2048`，也没有断言 slice 保留 `TasksMax=4096`；
   - 没有自动检查 Runbook 第 107 行的字节数与单元文件一致；
   - 没有仓库内测试检查 ADR 的 `amends`/`amended_by` 双向关系。`contract_sha256` 只能靠外部文档校验器，未核实。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `MemoryHigh=12G`、`MemoryMax=13G`：产生于 `gh-runner.service.in:23-24`；安装脚本原样渲染/复制（`install-runner.sh:84,96`），测试解析（`hermes-runner-scripts.test.mjs:63-74,684-701`），Runbook 预检读有效字节值（第 107 行），两端都能接受。
   - `MemoryHigh=13G`、`MemoryMax=14G`：产生于 `gh-runners.slice:6-7`；同样被安装脚本复制、测试解析、Runbook 预检使用，两端都能接受。
   - 被删除的 `CPUQuota`、`CPUWeight`、`IOWeight`、`Nice`：没有产生者；测试断言不存在；systemd 接受“未设置”。这一端一致。
   - ADR 路径值：`0173.supersedes`→`0170` 与 `0170.superseded_by`→`0173` 双向有效；`0173.amends`→`0171` 目标文件存在，但 `0171` 没有 `amended_by`，这一端**不接受**，即上文的中等级问题。
   - `contract_sha256`：产生者在仓库外，使用方是文档校验器；未核实。
   - 未改动的 `MemorySwapMax`、`TasksMax`：systemd 接受，但测试没有覆盖，属于覆盖缺口。
