## 结论

未发现会阻断本次改动的代码缺陷。单元模板、slice、Runbook 预检和测试里的核心数值彼此一致；`install-runner.sh` 是用整份文件覆盖并 `daemon-reload`，删除 `CPUQuota`/`CPUWeight`/`IOWeight`/`Nice` 不会残留。主要问题是几处验证与文档一致性缺口，均为低严重度。

## 读代码证实的问题（按严重度）

### 1. 低 — ADR 0173“比较过的方案”仍保留了“不受影响”的强说法，和这次刚改的“不是硬保证”矛盾

- 文件:行：`docs/adr/0173-hermes-runs-only-ci.md:81`
- 问题：决定第 1 条已经改成“这不是硬保证……整机仍可能内存不足”，但同一 ADR 的方案说明仍写 ssh/tailscale 不受影响。
- 证据：

  `docs/adr/0173-hermes-runs-only-ci.md:60`
  > 让 runner 把自己的内存用满时还能远程登录。这不是硬保证：上限只管住 runner，组外的进程用量变大时，整机仍可能内存不足。

  `docs/adr/0173-hermes-runs-only-ci.md:81`
  > 内存硬上限保留，是为了 CI 任务占满内存时系统只在资源组里杀进程，ssh 和 tailscale 不受影响，Andy 和代理还能登录。

- 建议：把第 81 行改成同口径，例如“通常只会杀资源组里的进程；但组外进程用量变大时整机仍可能内存不足，不能保证 ssh/tailscale 一定可用”。

### 2. 低 — Runbook 的限额预检没有覆盖本次同样改动的若干配置

- 文件:行：`docs/runbooks/hermes-self-hosted-runner-runbook.md:107`
- 问题：预检只检查服务的 `MemoryMax` 和 `CPUQuotaPerSecUSec`，以及 slice 的 `MemoryHigh`/`MemoryMax`/`CPUQuotaPerSecUSec`；没有检查服务的 `MemoryHigh`、`MemorySwapMax`、`TasksMax`，也没有检查 `CPUWeight`、`IOWeight`、`Nice`。若安装部分失败，或宿主机存在旧的 drop-in，预检可能放过。
- 证据：

  `docs/runbooks/hermes-self-hosted-runner-runbook.md:107`
  > `systemctl show gh-runner.service gh-runner-2.service -p Slice -p MemoryMax -p CPUQuotaPerSecUSec -p ExecStart`……`systemctl show gh-runners.slice -p MemoryHigh -p MemoryMax -p CPUQuotaPerSecUSec`

- 建议：至少给服务加上 `-p MemoryHigh -p MemorySwapMax -p TasksMax`，并考虑检查 `CPUWeight`/`IOWeight`/`Nice` 是否回到默认值；这样才和本次改动范围对齐。

### 3. 低 — 测试的反向断言依赖行首正则，带前导空白的旧指令可能逃过检查

- 文件:行：`test/tooling/hermes-runner-scripts.test.mjs:63-69`
- 问题：`unitSettings` 只解析匹配 `^[A-Za-z]+=` 的行。systemd 允许指令前有空白，因此若以后有人写回 ` CPUQuota=200%`（行首带空格），systemd 会应用它，但 `not.toHaveProperty` 反向断言不会发现。
- 证据：

  ```js
  const unitSettings = (text) =>
    Object.fromEntries(
      text
        .split("\n")
        .filter((line) => /^[A-Za-z]+=/.test(line))
  ```

  反向断言在 `test/tooling/hermes-runner-scripts.test.mjs:669-671` 和 `:702-704`。

- 建议：解析前先 `trim()`，或用更接近 systemd 语法的解析器；也可用 `systemd-analyze verify` 一类检查作为补充。按当前写法，重新加入完全相同的旧指令时断言确实会失败，但带前导空白的变体会漏掉。

### 4. 低 — 单元文件数值没有和 ADR/Runbook 数值做自动交叉校验

- 文件:行：`test/tooling/hermes-runner-scripts.test.mjs:658-660`、`:662-704`
- 问题：测试只读取 `scripts/operations/hermes-runner/gh-runner.service.in` 和 `gh-runners.slice`，并断言其中的值；没有读取 ADR 0173 或 Runbook。未来若只改文档不改单元，或只改单元不改文档，测试不会失败。
- 证据：

  ```js
  const template = path.join(scripts, "gh-runner.service.in");
  const render = (id) => shell(`render_runner_unit ${id} "${template}"`);
  const slice = () => unitSettings(readFileSync(path.join(scripts, "gh-runners.slice"), "utf8"));
  ```

- 建议：如果希望“文档与配置一致”成为门槛，可增加一个读取 ADR/Runbook 关键数值并和单元文件比对的测试；或把限额数值收敛到单一来源，再由文档引用。

### 5. 低 — 1.4 GB 与 1.4 GiB 的单位写法不一致

- 文件:行：`docs/adr/0173-hermes-runs-only-ci.md:60`、`docs/runbooks/hermes-self-hosted-runner-runbook.md:64`
- 问题：ADR 写 `1.4 GiB`，Runbook 写 `1.4 GB`。实际计算是 `15.41 GiB - 14 GiB ≈ 1.41 GiB`，不是十进制 GB。
- 证据：

  ADR 0173:60
  > 整机约 15.4 GiB，留约 1.4 GiB……

  Runbook:64
  > 留出的约 1.4 GB……

- 建议：统一写成 GiB，避免读者按十进制 GB 理解。

## 推测 / 未核实

- **`contract_sha256` 未核实**：Runbook 第 5 行已更新为 `sha256:6e08c94...`，但本次复核不能运行 `runbook.py`，也不能重算摘要；无法确认它是否和干净检出的 `scripts/operations/hermes-runner` 一致。历史上确有“在工作目录封存，把未提交内容算进去”的教训（`docs/lessons.md:159`、`:161`），建议在干净检出上跑一次 `validate_docs.py --strict`。
- **Hermes 实际部署状态未核实**：ADR 说已手动部署、容器数为 0、可登录余量等；本次只能读仓库，不能读 Hermes。
- **宿主机 drop-in 未核实**：若 `/etc/systemd/system/gh-runner.service.d/` 或 `gh-runners.slice.d/` 里有旧的 `CPUQuota`/`MemoryHigh`，`install-runner.sh` 不会清理；预检能否发现取决于是否检查对应属性。
- **CPU/IO 饱和风险（推测）**：这次只保证内存边界，没有为 ssh/tailscale 保留 CPU 配额或 CPU/IO 权重。若 CI 任务打满 4 核或磁盘，远程登录仍可能很慢甚至无响应；ADR 已承认内存不是硬保证，但没有同等承认 CPU/IO。
- **`.agents/reviews/pr-261/round-*` 和 `usage.jsonl` 未审阅**：它们在 diff 中，但当前复核副本没有检出这些路径；不影响运行时，但属于本次范围外的提交内容。

## 侧重检查

- **错误路径 / 安装回滚**：读了 `install-runner.sh:84-85`（渲染服务单元并覆盖）、`:96`（安装 slice）、`:100`（`daemon-reload`），以及 `runners.sh:39-45`（`render_runner_unit`）。删除配置项是整文件覆盖，不是部分编辑，因此不会留下旧的 `CPUQuota`/`Nice`。安装失败回滚测试在 `test/tooling/hermes-runner-scripts.test.mjs:1149-1184`。结论：没有新增错误路径问题；drop-in 残留是仓库外的未核实风险。
- **不合规范 / 不可信输入**：本次改动的值都是仓库内静态 systemd 配置，没有把用户输入拼进单元；`render_runner_unit` 只替换固定占位符。测试的 `unitSettings` 是解析器风险（见问题 3），不是运行时输入风险。
- **安全**：模板第 27-36 行的安全加固（`NoNewPrivileges`、`ProtectSystem`、`ProtectHome`、`ProtectProc`、`InaccessiblePaths`）未变；删除 CPU/IO 优先级只影响资源争用，不扩大文件、网络或权限边界。`TasksMax`、`MemoryMax` 仍保留。
- **资源耗尽**：内存有 `MemoryHigh=12G`/`MemoryMax=13G` 和组级 13G/14G，任务数有 2048/4096，磁盘下限检查未变。主要残余风险是 CPU/IO 无预留，以及 1.4 GiB 余量是否足够 ssh/tailscale、docker 守护进程和内核开销；ADR 已把内存保证降级为“非硬保证”，但没有实测支撑。
- **不可撤销操作**：本 PR 只改模板、slice、文档和测试；安装脚本有备份/回滚；ADR 0173 决定第 4 条写的是停止并取消开机自启、不删除数据，恢复清单在 Hermes 上。未发现新增的不可撤销代码操作。

## 作者说法逐条核对

1. **“单元文件和 slice 数值与 ADR 0173、Runbook 一致”**：属实。`gh-runner.service.in:23-24` 是 `12G/13G`，`gh-runners.slice:6-7` 是 `13G/14G`；Runbook 第 64 行和 ADR 第 60-61 行一致。Runbook 里旧的 3 核、9 GB、7 GB、`CPUWeight`、`IOWeight`、`Nice` 已不出现；旧数值只保留在历史 ADR（0160/0168/0171/0170）和证据日志里，符合“不改写旧 ADR”的说明。唯一残留口径问题是 ADR 第 81 行。
2. **“测试覆盖新数值，并断言旧 CPU 和优先级设置不存在”**：属实。`test/tooling/hermes-runner-scripts.test.mjs:662-673` 和 `:684-704` 断言了新的 `MemoryHigh`/`MemoryMax`/`TasksMax`，并反向断言 `CPUQuota`、`CPUWeight`、`IOWeight`、`Nice` 不存在。
3. **“ADR 0170 的 superseded_by、ADR 0173 的 supersedes 和 amends 双向一致”**：`superseded_by`/`supersedes` 一致：`0170:6` 指向 0173，`0173:5` 指向 0170。`amends` 指向 0171，0171 的决定第 2 条确实是被修订的旧资源组/限额内容；但 0171 没有反向的 `amended_by` 字段，所以“双向”只能对 supersede 说，不能对 amends 说。
4. **“安装脚本读单元文件的方式不受影响，其他地方没有写死旧数值”**：对活动的安装脚本、单元文件和测试属实：`install-runner.sh:84-85,96,100` 只用 `render_runner_unit` 和 `install`/`daemon-reload`，不解析具体键；`scripts/operations/hermes-runner` 和测试里没有旧数值。若把“其他地方”理解为整个仓库，则不完全准确：历史 ADR 和 `.agents/tasks/hermes-runner/evidence.jsonl` 仍保留旧数值，但这是作者已说明的历史记录，不是现行配置。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。`git diff --name-only` 显示本次只改了 `docs/`、`scripts/operations/hermes-runner/`、`test/tooling/` 和复核记录；没有系统提示、工具定义、历史消息或遮盖代码。按 `.claude/rules/prompt-prefix.md:27-29`，固定内容在前、每轮变化的值只放最后一条消息；按同文件 `:35`，已发内容只能在末尾追加。本次改动不涉及这些路径，发给模型的内容仍然只在末尾追加，每轮会变的值没有新增到请求开头。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会涉及模型请求。改动的是静态文档和 systemd 配置，没有引入依赖前后文的遮盖、带时间的字段或无序集合。唯一字节敏感的是 Runbook 的 `contract_sha256`，但它是文档封存值，不是发给模型的内容；其正确性本次无法重算，见“未核实”。
3. **有没有对应自动检查，反向用例真的会失败吗？** 单元/slice 数值有测试：`test/tooling/hermes-runner-scripts.test.mjs:662-704` 会检查新值，并在旧 `CPUQuota`/`CPUWeight`/`IOWeight`/`Nice` 重新出现时失败。反向断言对“完全相同的旧行”确实会失败，但 `unitSettings` 的正则 `^[A-Za-z]+=` 对带前导空白的旧行有盲点。ADR/Runbook 数值、ADR 元数据和 `contract_sha256` 没有自动交叉校验；按 `.agents/instructions/document-governance.md:28`，`check:docs` 已删除，Runbook 封存过期需要手动校验。
4. **每个改动值的生产者和消费者是否都能接受？**
   - 服务单元 `MemoryHigh=12G`/`MemoryMax=13G`：产生于 `gh-runner.service.in:23-24`；消费者是 `runners.sh:39-45` 的渲染、`install-runner.sh:84-85` 的写入、systemd 解析、测试 `:684-704`、Runbook 预检 `:107`、ADR 0173。两端的数值一致（13G = 13958643712）。
   - slice `MemoryHigh=13G`/`MemoryMax=14G`：产生于 `gh-runners.slice:6-7`；消费者是 `install-runner.sh:96`、`runners.sh`/systemd、测试 `:662-673`、Runbook 预检 `:107`、ADR 0173。数值一致（13G = 13958643712，14G = 15032385536）。
   - 删除的 `CPUQuota`/`CPUWeight`/`IOWeight`/`Nice`：安装脚本整文件覆盖，systemd 接受缺省；测试反向断言；没有其他活动配置依赖这些键。旧值只存在于历史 ADR/证据。
   - ADR 0170 的 `status`/`decision_status`/`superseded_by` 与 ADR 0173 的 `supersedes`/`amends`：字段形状和仓库其他 superseded ADR 一致；`superseded_by` 与 `supersedes` 对应；`amends` 指向仍为 active 的 0171，且 0171 决定第 2 条确实是旧限额内容。文档校验器不在本仓库，未能实际运行。
   - Runbook `contract_sha256`：唯一消费者是文档治理工具（不在本仓库），本次无法验证；建议在干净检出上手动执行严格校验并确认 0 错误。
   - 测试期望值：只被测试自身消费，和两个单元文件一致。
   - 结论：没有发现某个消费者会拒绝新值的硬性不匹配；发现的是一处文档口径残留和验证覆盖缺口。
