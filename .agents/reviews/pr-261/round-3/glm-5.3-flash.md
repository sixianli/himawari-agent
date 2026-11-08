## 侧重检查

我走的最普通流程：`install-runner.sh` 装服务 → 模板渲染 → Runbook 预检 → 测试断言 → 文档（ADR/Runbook）与单元文件对照。

- `install-runner.sh:84` 用 `render_runner_unit "$id" "$SRC/gh-runner.service.in"` 渲染，`runners.sh:39-45` 的 `render_runner_unit` 只做 4 个占位符替换（`@USER@/@ROOT@/@NAME@/@OTHER_ROOT@`），完全不解析资源类设置，删掉的 `CPUQuota` 等不会影响它。`install-runner.sh:96` 对 `gh-runners.slice` 是整文件 `install` 复制。已证实：安装脚本路径不受影响。
- 测试：`test/tooling/hermes-runner-scripts.test.mjs:63-69` 的 `unitSettings` 把每行 `键=值` 收进对象；`669-671`（slice）、`702-704`（unit）用 `not.toHaveProperty` 锁旧键。已推断为真反向用例：若重新写回 `CPUQuota=200%`，该行会被 `unitSettings` 收进对象，`not.toHaveProperty` 必失败。
- 覆盖出的无测试路径：Runbook 正文里的预检数字（`doc…runbook.md:107` 的 `13958643712`、`15032385536`）没有任何脚本把「正文散文里的数字」和单元文件交叉核对；contract_sha256 只能发现「依据文件（`runbook.md:13-15` 列的 `scripts/operations/hermes-runner`）变了而没重新封存」，发现不了「散文数字写错但依据文件没变」。本轮我手工换算核对过（见下）。
- 文档对照：ADR 0173 决定第 1、2 条（`0173:60-61`）与 `gh-runners.slice`、`gh-runner.service.in` 逐字一致；Runbook `64`、`107`、`237` 与单元文件一致。逐字换算：13×2³⁰=13,958,643,712、14×2³⁰=15,032,385,5536——更正：14×2³⁰=15,032,385,536，与 Runbook `107` 一致；旧值 7×2³⁰=7,516,192,768、9×2³⁰=9,663,676,416 与被删的旧预检行一致，说明 systemd 的 `G` 按二进制换算，写法自洽。

## 按严重度排列的问题

**中**
- `docs/runbooks/hermes-self-hosted-runner-runbook.md:8` — frontmatter `date: "2026-11-04"` 在三次改动、两次重新封存后都没有更新。证据：本 PR 对该文件的三处 diff（f6829fa→73219df）只动了 `contract_sha256` 和正文，date 未动。推测治理规则可能允许（未读到文档治理规则原文，`.agents/instructions/` 在本检出不存在，未核实），若规则要求封存时更新日期，这就是漏项。建议：确认规则，必要时随封存更新 date。

**低**
- `test/tooling/hermes-runner-scripts.test.mjs:662-706` — 断言值我没有执行，只读代码证实逐字正确（slice `13G/14G/0/4096`、unit `12G/13G/0/2048`，与单元文件一致）。两个提交信息（`git show 61da6cc7`、`git show 73219df1`）都写明 `Layer-0-tests: 未运行；Mac 上不跑测试`。结论「测试会失败的反向用例」是从 `unitSettings` 的解析逻辑推出的，不是跑出来的。推测风险极低（逐字对照过两遍），但严格说本 PR 的测试从未被执行过。建议：合并前在有 runner 或任一 Linux 环境跑一次 `test/tooling`。
- `docs/adr/0171-two-runners-on-hermes.md:11,60` — ADR 0171 仍是 `active`，标题「合计最多 3 核 6 GB」和决定第 2 条（`CPUQuota=300%` 等）与现行值矛盾。这是刻意保留（本 PR 材料声明按治理规则不改写旧 ADR 正文），现有语义是「0171 被 0173 修订，差额以 0173 为准」（`0173:73`）。证据：`0171:7` `amends: docs/adr/0160…`，其自身没有被 `superseded_by` 洗掉的先例。属设计选择，不是错误；但一个只读 0171 的人会拿到过期限额。建议：不改（守规则），依赖 Runbook 和 0173 为现行来源——现状正是如此。

**低的观察项（非缺陷）**
- Runbook 正文散文数字与单元文件之间没有自动交叉检查（见侧重检查），本轮只是手工一致。建议（可选）：在上述测试里加断言，把 Runbook `:107` 的两个十进制字节值与 `bytes()` 计算结果对上，锁住散文数字。这在本次改动范围内，加进 `hermes-runner-scripts.test.mjs` 很自然。

## 读代码证实的与推测的汇总

读代码证实：作者说法 1（单元/Runbook/ADR 数值一致，旧上限只在被对的 ADR 正文和一条 2026-11-04 的历史证据 `.agents/tasks/hermes-runner/evidence.jsonl:4` 里残留，脚本里无写死旧数值，grep 全仓只命中上述）、说法 2（断言覆盖新数值、负向断言存在）、说法 3（`0170:2-7` superseded_by → `0173:5` supersedes 双向成立；`0173:7` amends 指向 0171，与 0170→0171 的单向 amends 惯例一致）。「整机约 15.4 GiB」「1.4 GiB 余量」按作者给的 `MemTotal 16162996 kB` 换算自洽（15.41−14=1.41 GiB）——换算证实，实测数值本身未核实。

推测/未核实：contract_sha256 `6e08c94c…` 是否真等于当前依据文件的封存摘要（我无法运行 seal）；「Hermes 2026-11-06 实测到容器数 0、可用内存 14 GB」属于现场陈述；文档治理规则「不改写已定 ADR」未见原文。

## 必答问题

1. **不会改变模型已见过的请求开头。** 改动范围仅 `docs/adr/*`、`docs/runbooks/*`、`scripts/operations/hermes-runner/*`、`test/tooling/*`、`.agents/reviews/*`（diff stat 全列出），不触及系统提示、工具定义、历史消息或遮盖。发给模型的内容仍只在末尾追加（改动根本没有进入任何发送路径）；每轮变化的值也不在这批文件里，问题不适用，从 diff 即可下结论。
2. **不会。** 没有改任何遮盖或按前文变化的内容；新值（13G/14G 等）是静态字面量。唯一带时间的字段是 `.agents/reviews` 复核记录里的历史时间戳，是已封存的历史记录，不进入模型请求。contract_sha256 只是仓库内封存摘要，不发给模型。
3. **有自动检查，反向用例经读代码证实会失败。** `hermes-runner-scripts.test.mjs:669-671、702-704` 的 `not.toHaveProperty`：`unitSettings`（:63-69）会把重新写回的 `CPUQuota`/`CPUWeight`/`IOWeight`/`Nice` 行收成对象属性，负向断言即失败；`666-667、692-693` 锁住 `MemorySwapMax=0` 和两边 `TasksMax`。但注意：本 PR 中该测试从未被执行（提交信息自述 `Layer-0-tests: 未运行`），「会失败」是逻辑推断而非运行结果。
4. **每个新值的两端都核过，都能接受。** 生产者：`gh-runners.slice:6-9`（13G/14G/0/4096）、`gh-runner.service.in:23-26`（12G/13G/0/2048）。消费者逐个核对：① systemd（运行时读，无校验限制）；② `install-runner.sh:84,96`——整文件复制/纯占位符替换，不解析资源键，接受；③ `uninstall-runner.sh:17`——只按路径删除，接受；④ 测试 `:664-667、690-693`——逐字相同，接受；⑤ Runbook `:64、107、237`——数值一致，预检十进制字节值换算正确（13×2³⁰=13,958,643,712；14×2³⁰=15,032,385,536），接受；⑥ ADR 0173 `:60-61`——一致，接受。没有发现任何一端拒绝这些值；唯一没人消费校验的就是「Runbook 散文数字」，已作为观察项列出。
