Diff 已全部读完。现在核对各处细节：先看测试辅助函数 `unitSettings`（决定 `not.toHaveProperty` 断言是否真的有效）、安装脚本如何使用这些单元文件，以及全仓库是否残留旧数值。
`unitSettings` 对整个渲染后的单元文本按 `^[A-Za-z]+=` 逐行建对象，`not.toHaveProperty` 的反向断言有效。接下来全仓库搜旧数值残留，并找 `contract_sha256` 的校验逻辑。
Runbook 第 107 行预检数值换算核对：13×2³⁰=13958643712 ✓、14×2³⁰=15032385536 ✓。接着查：Runbook 里还有没有旧数值残留、Runbook 契约清单是否包含这两个单元文件、以及这些测试是否进 CI。
Runbook 中旧数值已清干净，先前的 grep 显示全仓库仅剩历史文档（ADR 0170/0171 正文、evidence.jsonl 的历史记录）保留旧值。现在看测试全文、CI 是否运行这些测试、以及 check:docs 对 Runbook 封存的处理。
改用文件工具查 CI 配置。
CI 的 `tooling` project（含此测试文件）在 policy 和 coverage 两个检查里都在 Hermes runner 上运行，自动检查存在。再核对 ADR 交叉引用是否有校验脚本、以及 0171 被修订后约定上是否需要回链。
仓库确实有「amends / amended_by 双向」的既有约定（ADR 0031 line 139 明确写了）。查被修订方 0160 和 0171 的现状：
测试与 ADR 校验机制已明确。最后补两个消费点检查：`CPUQuotaPerSecUSec` 的其他引用处、以及确认没有其他脚本/配置解析这些单元里的数值。
最后一个核对点：提交信息里是否说明重封 Runbook（契约 `contract_sha256` 变了，但无法不经运行验证）；看两条提交的完整说明。
# 复核结论（PR 261：Hermes 只跑 CI，runner 放开资源）

已通读 `f6829fa14..df738a34` 的全部 diff（6 个文件），并核对消费端与 CI 配置。

## 发现的问题（严重度从高到低）

**1. 中 ｜ 提交信息（git log 8751f31d / df738a34）｜ 测试从未运行过，作者自述**
证据：提交信息原文「test/tooling/hermes-runner-scripts.test.mjs 已按新上限更新，还没有运行；Mac 上不跑测试」及合并提交「Layer-0-tests: 未运行；……GitHub Actions 工作流已按 Andy 要求暂停」。也就是说，本次改动的自动检查（测试文件、文档严格校验之外的部分）在合并前一次都没执行过；是否在 PR 的 CI 上补跑过，仓库内证据无法核实。**建议：合并前确认 PR CI 的 `policy` 检查（含 tooling project，见 ci/policy.json:5-21、242-246）真正通过。**

**2. 低 ｜ docs/adr/0173-hermes-runs-only-ci.md:7 ｜ `amends` 只有单向回链**
证据：0173 写 `amends: "docs/adr/0171-two-runners-on-hermes.md"`，而 docs/adr/0171-two-runners-on-hermes.md:2-8 没有 `amended_by` 字段。仓库里其他修订对（如 docs/adr/0031-isolated-tool-execution.md:139「采用双向 `amends` / `amended_by` 元数据」、0030/0071/0025 都有 `amended_by`）遵循双向约定。注意：runner 系列 ADR 一直是单向（0168、0169 amends 0160 也无回链），属既有偏差，本 PR 未首次造成。**建议：给 0171 补 `amended_by`，或延续现状但在文档约定处说明例外。**

**3. 低 ｜ docs/runbooks/hermes-self-hosted-runner-runbook.md:5、:107 ｜ 封存哈希与预检字节数是手工维护的，快速模式下不校验**
证据：预检写死 `MemoryMax=13958643712`（13×2³⁰ ✓）、`MemoryMax=15032385536`（14×2³⁰ ✓）、`MemoryHigh=13958643712`（13×2³⁰ ✓），换算全部正确；`contract_sha256` 已随单元文件改动更新为 `6bb084…`。但 (a) 本复核环境不能运行命令，封存值是否与当前内容匹配**未核实**；(b) 快速模式的 `check:docs` 明确放行 `contract_sha256 does not match`（docs/adr/0080:32、.agents/instructions/document-governance.md:30），所以哈希错了测试也不会抓住。**建议：切回完整模式时务必跑一次严格校验确认封存。**

**4. 信息 ｜ 无法从仓库核实的事项**
- 「已手动部署在 Hermes 上」：仓库没有任何状态可证明，未核实。
- Runbook 预检第 6 条不再提供 `MemoryHigh=…`（每 runner）的期望值，也不再要求确认 `Nice` 已移除——留白，不算错误。

## 「侧重检查」：我从入口走到结束的流程

**流程：推送 → PR → GitHub 触发 `.github/workflows` → 任务落到 `hermes-home` runner（ci/policy.json:13、68、108…）→ runner 进程跑在 `gh-runners.slice` 里（gh-runner.service.in:9 `Slice=gh-runners.slice`）→ 限额由改后的单元文件生效。**

- 有测试覆盖：单元模板渲染与差异（test/tooling/hermes-runner-scripts.test.mjs:674-703、705-714）、slice 解析（:662-672）、job-started 磁盘下限（:76 起）、暂停/恢复试算（:1036、:1167 处引用 slice 路径）。这条路转到这里是通的。
- 没有测试覆盖的代码路径：install-runner.sh:84、:96 实际安装（需要 Hermes root，只在上机时验证）；systemd 对新值的实际应用（Runbook 预检步骤 6，手工）；runbook.py 封存（快速模式放行）。
- 从本流程看，改动的传播链完整：单元文件 → 安装脚本按路径复制（无逻辑依赖数值）→ Runbook 正文与预检 → 测试断言，两端一致。

## 作者说法核对

1. **「单元/slice 数值与 ADR、Runbook 完全一致，旧值已清」——证实（读代码）**。gh-runners.slice 13G/14G、gh-runner.service.in 12G/13G 与 ADR 0173:60-61、Runbook:64 一致；Runbook:107 字节换算正确；Runbook:237 排错表「合计 14 GB」已改。全仓库 grep 旧值（CPUQuota 输出/CPUWeight/IOWeight/Nice=10/7G/9G 等），仅剩历史文档正文（ADR 0170:66、0171:60——历史记录，正确保留）和 evidence.jsonl 的历史证据。**证实。**
2. **「测试覆盖新值并断言旧设置不存在」——证实（读代码），但反向用例「真的会失败」未经运行证实**。断言见 test/tooling/hermes-runner-scripts.test.mjs:663-670（slice：新值 + `not.toHaveProperty(CPUQuota/CPUWeight/IOWeight)`）、:689-701（unit：12G/13G + `not.toHaveProperty(…, "Nice")`）。反向有效性可以从工具实现证明：`unitSettings`（:63-69）把每行 `Key=Value` 都收进对象，若恢复 `Nice=10`，该属性必然存在，断言必失败。但作者自述没跑过（见问题 1）。测试在 CI 的 tooling project 里（ci/policy.json:242-246）。
3. **「superseded_by / supersedes 双向一致」——证实**：ADR 0170:7 `superseded_by: "docs/adr/0173-…"`、0173:7 `supersedes: "docs/adr/0170-…"`。「和 amends 双向一致」——**不成立（若按 ADR 0031 的双向约定衡量）**，见问题 2；单向上 0173 &rarr; 0171 与 runner 系列既有做法一致。
4. **「安装脚本读取方式不受影响，没有写死旧数值」——证实（读代码）**：install-runner.sh:84 只是用 `render_runner_unit`（runners.sh:39-45，纯 sed 换 `@USER@/@ROOT@`）渲染模板，:96 按路径 `install -m 0644` 复制 slice，不解析数值；卸载脚本同理只按路径删。全仓库无其他写死的旧数值（ADR 0171 标题和决定里的旧数字属被修订的历史记录）。

## 必答问题

1. **不改变发给模型的内容，也不改变请求开头。** 本次 diff 只涉及 systemd 单元、slice、ADR、Runbook 和一个 offline 测试文件（`git diff --stat` 共 6 个文件）；没有任何 prompt、工具定义、历史消息或遮盖相关文件。「只追加」规则此处不适用——改动完全不触碰发给模型的字节流。
2. **不会。** 新产出的值都是静态配置字符串（`MemoryHigh=12G` 等）和时间无关；契约哈希 `contract_sha256` 是 Runbook 元数据里的一次性封存值，不从模型请求序列化，也不依赖前后文。没有带时间字段或无序集合进入请求路径。
3. **有对应自动检查，反向用例按实现必然失败；但作者没运行过它（本 PR 流程上的实际缺口，见问题 1）。** 检查在 `tooling` project（policy 与 coverage 两个 CI 检查都会在 hermes-home 上执行 tooling，ci/policy.json:19、148）。
4. **逐值核对通过（I-73 视角未发现缺口）。** 每个新增/移除的值：`MemoryHigh=12G/13G`、`MemoryMax=13G/14G`——产生处（两个单元文件）与全部使用处（安装脚本、渲染测试、Runbook:64 封存 :107 预检 :237 排错表、ADR 0173）核对一致；移除的 `CPUQuota/CPUWeight/IOWeight/Nice`——Runbook 预检同步改为 `CPUQuotaPerSecUSec=infinity`，grep 证实没有第三方解析点依赖旧键。逐个消费端都能接受。
