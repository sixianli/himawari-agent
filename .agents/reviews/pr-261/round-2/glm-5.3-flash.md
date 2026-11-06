# PR 261 复核报告（第 2 轮，61da6cc）

## 按严重度排列的问题

### 1. 中低 — docs/adr/0171-two-runners-on-hermes.md:1-9 — ADR 0171 被两份 ADR 修订，但 front matter 没有 `amended_by`，正文也仍是旧数值
- 证据（读代码证实）：0171 的 front matter 只有 `supersedes: ""`、`superseded_by: ""`、`amends: docs/adr/0160-...`，没有 `amended_by`；而仓库里被修订的 ADR 惯用这个字段（docs/adr/0031:8、0033:8、0054:8 都列了修订者）。0171 正文决定第 2 条（:60）仍写 `CPUQuota=300%`、`MemoryHigh=5632M`、`CPUWeight=20`。
- 属实是 0170 修订时就已存在的旧账（:75 写明“本 ADR 改动 ADR 0171 的两处”，当时也没给 0171 加 `amended_by`），本次 PR 又叠加一份 0173 的修订，读 0171 本身的人看不到已被 0170、0173 两次改掉。作者说法 3 只对 0170↔0173 的双向核对成立（0170 的 `superseded_by`、0173 的 `supersedes` 我已读到，一致），对“amends 0171”这一向，另一端（0171）没有任何记录。
- 建议：给 0171 的 front matter 加 `amended_by: "docs/adr/0170-..., docs/adr/0173-..."`（顺带 0160 对 0171 同缺）。

### 2. 低（推测）— docs/adr/0173-hermes-runs-only-ci.md:60 — “整机约 15.4 GiB”与其他 ADR 的 15 GiB 记录不一致
- 证据：0173:29 写“16 GB 内存”，:60 写“整机约 15.4 GiB，留约 1.4 GiB”（14G+1.4≈15.4）；但 docs/adr/0046:45、0047:72、0171:29 都记 Hermes 为“4 核、15 GiB 内存”。若整机只有约 15 GiB，slice `MemoryMax=14G` 只留约 1 GiB 给系统，“1.4 GiB”的余量偏大。这是实机测量值，代码里无从核实，属推测级疑点，建议在 ADR 里写明量测命令，与其他 ADR 统一口径。

### 3. 低（未核实）— docs/runbooks/hermes-self-hosted-runner-runbook.md:5 — `contract_sha256` 的值无法在此处验证
- 读代码证实：`scripts/operations/hermes-runner/` 三个文件确实改了（`gh-runner.service.in`、`gh-runners.slice`），Runbook 的 `contract_sha256` 也在同一提交里换新（diff 里 a8d5c679→6bb0840c），做法正确；但封存摘要是否真的等于当前脚本内容，需要 `runbook.py seal` 重算，我不能运行命令，标「未核实」。该检查也不是自动的：`.agents/instructions/delivery-mode.md:26` 写明严格文档校验“不再自动运行”，提交前须手动跑 `validate_docs.py`——本仓库没有针对这条的测试。

### 4. 信息级 — `.agents/reviews/pr-261/round-1/*.md` 等 4 个文件被 git 记为二进制
- 证据：diff stat 里这些 `.md` 显示 `Bin`。不影响功能，但会让后续 diff/搜索工具看不到内容。未核实原因（可能编码异常），建议确认 linter/编辑器输出格式。

## 「侧重检查」：走了一遍最普通的安装流程

Runbook 预检（:100-109）→ 安装（`install-runner.sh:84,96` 只做 `render_runner_unit` 的纯 sed 替换和整文件 `install -m 0644`，runners.sh:39-45 同样只替换占位符，不解析数值 → 取消限制不影响读取方式）→ systemd 加载 → 起服务接任务。
- 覆盖的路径：渲染结果的安全设置、限额、身份隔离各有测试（`hermes-runner-scripts.test.mjs:657-729`），反向用例见下。
- 没有测试覆盖的路径：① 预检第 6 项期望的 `systemctl show` 字节值（13958643712=13×1024³、15032385536=14×1024³，换算我核实无误）只是文档要求，仓库测试不比对实际 systemd 输出；② Runbook 封存摘要、ADR 链接一致性（见问题 1、3）；③ “Hermes 上已实际部署一致”只能靠作者自述，仓库无法验证。

## 必答问题逐条回答

1. **不涉及。** 改动只有 systemd 单元模板、slice、ADR/Runbook 文档和测试（`git diff --stat` 全部 11 个文件证实）；这些不进入发给模型的内容（不是系统提示、工具定义、历史消息或遮盖结果），无追加语义可violating。
2. **不会。** 两个单元文件里的新值（`MemoryHigh=13G/12G`、`MemoryMax=14G/13G`、`MemorySwapMax=0`、`TasksMax=4096/2048`）都是静态字面量，不依赖前后文、无时间字段、无集合顺序；渲染脚本只做无状态 sed 替换。同一输入永远产生同一字节。
3. **有自动检查，反向用例真实存在且会失败。** `test/tooling/hermes-runner-scripts.test.mjs:669-671`、`:702-704` 用 `not.toHaveProperty` 断言 `CPUQuota/CPUWeight/IOWeight/Nice` 不存在——`unitSettings`（:63-69）会把任何 `KEY=value` 行收为属性，所以任何一处加回旧键都会失败。第 2 轮新增断言（`TasksMax: "4096"`、`MemorySwapMax: "0"`、`TasksMax: "2048"`）与文件实际内容逐字一致（gh-runners.slice:6-9、gh-runner.service.in:23-26），键名也都能被 `unitSettings` 解析。测试本身我没有跑过（不能运行命令），逻辑已核实。
4. **每个值的两端都对得上。** 产生处：slice 文件与服务模板；消耗处逐一核对：安装脚本只整文件拷贝/渲染、不解析数值（install-runner.sh:84,96）；Runbook 预检期望的字节数换算正确且与文件一致；排障表“合计 14 GB”一致；测试断言一致；ADR 0173 描述一致；`Slice=gh-runners.slice` 名字未变，`Requires=gh-runner-nft.service` 等无关键名未动；全仓 grep 未见写死旧数值的代码（唯一命中是历史证据 `.agents/tasks/hermes-runner/evidence.jsonl:4` 里的旧记录，属历史档案，无需改）。
作者说法 1 中“Runbook 所有旧上限均已改掉”属实（:64、:107、:237 三处全改为新值，行内无 Nice/Weight/Quota 残留）；说法 2、3、4 除「双向一致只覆盖 0170↔0173」和「contract_sha256 未能本地验证」外均属实。
