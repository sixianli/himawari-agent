# 复核结论：3995cb4b（PR 0，平台写死清点）

先说总体：这是一次纯加检查/文档的改动，四个提交（git log 见 9197711ad → 0d3becb1f → 567f5abcf → 3995cb4b），diff 只含新检查脚本、新清单、新测试、package.json 一行、新 ADR 和评审记录。作者关于检查脚本行为、清单规模、package.json、ADR 的说法我逐条核对，**全部与代码一致**（细节见文末）。发现的问题主要是覆盖缺口，没有发现行为回归。

## 侧重检查（走过的流程与结论）

普通使用流程：开发者/CI 跑 `npm run check` → `scripts/run-all-checks.mjs:32` 用 `stepNames(manifest.scripts["check:steps"])` 解析步骤 → 逐个 `npm run <name>`。GitHub CI 的 static job 跑 `npm run check`（scripts/ci/run.mjs:244，`await command("check", tools.node, [tools.npmCli, "run", "check"])`），所以新步骤会进 CI。新步骤 `check:platform-assumptions` = node 脚本 + vitest（package.json:63）。

- 脚本主路径（扫描→比对→报 added/stale/unknown→exit 1）：有 vitest 覆盖（test/tooling/platform-assumptions.test.mjs）。
- **未覆盖路径：`--write` 分支**（check-platform-assumptions.mjs:99-103）没有任何测试；它跳过比对直接覆盖清单，写坏了只能靠下次检查发现。
- `main()` 的退出码路径（problems.length > 0 → return 1）无直接测试，测试只断言 `comparePlatformAssumptions` 的返回值；读了 main() 代码后逻辑成立，属间接覆盖。
- 说明：本工作区是稀疏检出（git status 显示 67%），`.agents/reviews` 本地不存在，评审记录内容我读不到，标未核实。

## 问题（按严重度从高到低）

**1.（中）scripts/check-platform-assumptions.mjs:37-43 —— ADR 说 PR 0 要清点「固定主机名」，检查里没有这个类别，主机名写死不受挡。**
- 读代码证实：`PLATFORM_ASSUMPTIONS` 五类是 lib64、linux-x64、arch-x64、x86_64、python-3.12.10-archive（mjs:37-43），无主机名。而 docs/adr/0253-...md 第 63 行明确写「全仓找出写死 `/lib64`、`linux-x64`、`process.arch === "x64"`、**固定主机名**和固定 Python 包名的地方」。
- 证据：scripts/operations 下大量硬编码主机名未被任何类别捕获，例如 scripts/operations/hermes-harness-web-probe.mjs:15 `assert.equal(hostname(), "hermes-home")`、scripts/operations/hermes-temporary-sudo.py:44 `assert socket.gethostname() == 'hermes-home'`，这些文件也不在 platform-assumptions.json 里。这些恰好是 ADR 第 66 行（PR 3）要改成「提交进仓库的配置」的对象——改的时候不会触发 stale/added 提示，改完后检查也不会挡以后再写死。
- 建议：要么把「固定主机名」（如 `hermes-home`、`gethostname()==`）加为第六类并重新 `--write`，要么在 ADR 0253 里改口径说明主机名挪到 PR 3 处理，别让 ADR 与检查各说各话。

**2.（低）check-platform-assumptions.mjs:8 —— 扫描范围不含 `.github/` 和根目录 `evals/`，与同类检查不一致，且工作流里确有平台名写死。**
- 读代码证实：`SCANNED_DIRECTORIES = ["apps","packages","scripts","test","ci"]`；`.github/workflows/ci.yml:123,161,214,215,264,265` 共 6 处 `linux-x64`，完全不被扫描（作者说法与代码一致，是范围本身窄）。对比 ADR 0111 第 64 行，expensive-models 检查扫到 `evals`、`tools`、`config` 和根配置文件（我查了 `evals/`，当前无 lib64/linux-x64/x86_64 命中，暂无漏账）。PR 2/PR 3 要动工作流时，这个检查帮不上忙。
- 建议：把 `.github` 加进 SCANNED_DIRECTORIES（本 PR 用 `--write` 重生成清单即可，CI static 本来就 actionlint 这三个 workflow 文件）；evals 可选。

**3.（低）test/tooling/platform-assumptions.test.mjs —— 没有覆盖 `--write` 行为和逐字节稳定性。**
- 读代码证实：测试只覆盖 `scanPlatformAssumptions`、`comparePlatformAssumptions` 两个导出函数（mjs:62,78），`main()` 的 `--write` 路径（mjs:99-103）无测试。清单是会被人手工编辑、被 `--write` 覆盖的文件，值得一个「重写后字节不变」的用例（我读代码确认输出是确定性的：文件列表 `files.sort()`（mjs:67）、类别键序固定、`JSON.stringify(observed, null, 2)`，无时间字段）。
- 建议：加一个 tmp root 下先 scan 再模拟 `--write`、断言两次写出的 JSON 字节相等的用例。

**4.（信息，未核实）`.agents/reviews/topic-arm64-linux` 记录内容无法核对。**
- diff --stat 显示该目录 13 个文件在提交里（md/prompt.md 被 git 当作二进制列出，略异常但无法进一步查）；本地稀疏检出不包含该目录，`git show` 对 records 路径被工具拒绝（REVIEW_GIT_REFUSED）。作者说它是「方案讨论记录」，仅确认文件存在，内容未核实。

## 作者说法逐条核对（读代码证实，除非注明）

- 「扫描 apps、packages、scripts、test、ci」——✅ mjs:8，逐字一致。
- 「统计五类写法逐文件比较：多了 added、少了 stale、不认识类别 unknown」——✅ mjs:78-94 完全一致；测试用例（test:53-90）对应三类反向用例齐全。
- 「清单由 --write 生成，共 251 处」——✅ 我按 platform-assumptions.json 手工合计：lib64 49 + linux-x64 133 + arch-x64 6 + x86_64 49 + python 14 = **251**。另外抽查 7 个文件的计数与代码一致：toolchain-lock.json linux-x64=7（行 18,19,20,65,118,138,618）、quality-policy.json=3、build-candidate.sh linux-x64=2 / python=1、srt-runtime-identity.ts arch-x64=1（行 36）、product-path-harness.ts lib64=1、run-release-walkthrough.sh=1。「由 --write 生成」本身无法重放验证（不能运行命令），但抽查计数全部吻合，作证。
- 「package.json 把 check:platform-assumptions 加进 check:steps」——✅ diff 可见插入在 check:expensive-models 之后；且 `stepNames` 的正则 `^npm run (\S+)$`（run-all-checks.mjs:8）能解析它。
- 「docs/adr/0253 新增」——✅ 新文件 112 行；其引用的 0176-ci-on-ovv-hmm→ 0176-ci-on-ovh-vps.md、incidents-and-gates.md、install-start-stop-runbook.md 均存在。

## 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会。改动只触 scripts、test、docs、package.json 和评审记录，不碰系统提示、工具定义、历史消息或出口遮盖的任何构造路径；甚至不是「末尾追加」的问题——发给模型的内容一字未变。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。扫描结果按固定类别序 + 文件名排序（mjs:67 `files.sort()`）序列化，无时间戳、无 Set 直接入 JSON（Set 仅在 mjs:83 用于求键并集后排序）；同一输入下 `--write` 输出逐字节确定。

**3. 有没有自动检查、反向用例会不会真失败？** 有，且进了 CI 链：check:steps → static job → npm run check（run.mjs:244）。反向用例有三类（新文件 added、已列文件多一处 added、清单残留 stale、未知类别 unknown，test:53-90），断言 `comparePlatformAssumptions` 返回问题列表；`main()` 在 problems 非空时 return 1（mjs:117），反向用例在真实运行下会失败。缺口是 `--write` 分支无测试（见问题 3）。

**4. 每个新产生的值，使用端都接受吗？** 逐个核过：
- `scripts/platform-assumptions.json`：唯一读取方是检查脚本 main()（mjs:104），且被列入自己的 EXCLUDED_FILES（mjs:33）避免自举——两端一致。
- npm 脚本名 `check:platform-assumptions`：消费方是 check:steps（已加入）和 run-all-checks 的解析正则（接受）；GitHub CI static 跑 `npm run check` 透传；ci/policy.json 不枚举 npm 检查脚本（grep `check:` 在 ci/ 无命中），不受影响——两端一致。这正是 I-73 教训要问的那一端，这次没踩。
- ADR 0253 文档：引用的目标文件都存在；但 ADR 决定第 1 条承诺清点「固定主机名」，检查未兑现——文档与代码不一致（见问题 1）。
- 评审记录：内容未核实（稀疏检出 + git show 被拒）。
