# 复核报告（51d1705a 对比 f0478c4d）

## 侧重检查

**走的最普通流程：出包→上生产。**
make-packet `assemble`（scripts/delivery-mode/make-packet.py:742-750）→ `adapter_drift`（make-packet.py:435-441，用出包提交核对清单里的 `sourceSha256`）→ `regenerate_hashes`（make-packet.py:467-481，重算 cloud-inputs.draft.json 的 files 清单和各 OWNED-SHA256SUMS，所以模板里这几份旧摘要不拦包）→ Hermes `check_packet`（make-packet.py:648，新增 `--pi-tools`，取 `builder.json` 的 `piToolBin`，已确认 hermes/builder.json:10 有该键）→ `run-packet-checks.py` plan/run_installed_probe → record.json → `generated-packet-gate.py:32-38`（deploy 前要求新检查项在 packet-checks.json 里 exit=0，**旧包会被这里拒掉**，与作者“需重新出包”的说法一致）→ 生产 S6 的 run-network-preparation.py:163-169 再跑一次探测并数 22 项。

**结论：** 新检查的判定逻辑（计数来源、JSON 判定、缺工具）全有单元测试且实现与断言吻合；真正没有测试覆盖的代码路径是三条：① `run_installed_probe` 的 subprocess 全链路（装包、复制二进制、传环境）只在 Hermes 上真实执行，本地单元测试只到“缺工具早退”为止；② `generated-packet-gate.py` 拒绝“记录里没有新检查项”的旧包这一反向情形没有测试；③ `make-packet.py:648` 若 builder.json 缺 `piToolBin` 会裸 KeyError（现在键存在，仅推测风险）。另外模板测试 `test_make_packet.py:322-327` 是**双向集合相等**：模板变了没登记、登记了没变都会失败——本次加进 `INTENDED_CHANGES` 的两条（`adapters/probe-foreground.mjs`、`probe-source/.../probe-foreground.mjs`）确属本次模板变化。

## 发现（按严重度）

**【中】全库无人消费行李清单新的 `adapterSha256` 值（I-73 式“两端核对”缺口）**
证据：全库 grep `adapterSha256`，现行消费只有 basis-04 的 `run-network-preparation.py:89` 和 `check-entry-paths-06.py:88`（旧基线历史记录，不再执行）；现行出包核对 `make-packet.py:439` 只比对 `sourceSha256`；生产钉住适配器字节走的是 cloud-inputs 的 `files` 清单（出包时重算）。含义：这次更新的两个哈希里，`sourceSha256` 写错会在出包时被拒，`adapterSha256` 写错**没有任何一道自动检查会拦**。建议：要么适应现流程给出包前核对同清单所有 `adapterSha256` 的检查，要么在 I-81 里写明该字段目前只是记录。

**【低】`installed_probe_problem` 对空 reports 和 passed≠len(reports) 不设防**
证据：scripts/delivery-mode/run-packet-checks.py:103-107：`all(row.get(...) == 'released' for row in report.get('reports', []))`——`reports` 为空或缺失时 `all(())` 为 True，只要 `passed=22` 就判通过，不要求报告里真有 22 行。真实探测每个 run 自行断言 released，包又是冻结签名的，风险很低。建议补一行 `len(reports)==expected`。

**【低】`pi_tools` 静默回退系统工具**
证据：run-packet-checks.py:90-92 `search = directory + ':/usr/bin:/bin'` 后用 `shutil.which`——所给目录缺 rg 时会静默用 `/usr/bin/rg`，与 I-81 描述“复制 bash/rg/fd”不符（比较的是 hmac：生产走 `finalize` 前有 toolDigests 对账，本检查连 toolDigests 都不比对）。建议目录里缺任一项即失败。

**【低】三条注释被删，作者说法未提，文档信息丢失**
证据：三份现行副本删了头部授权说明、“对齐生产 Worker 清理期限”注释、finally 注释（diff hunks @ packages/runtime-pi/scripts/probe-foreground.mjs 与模板两份）；只有 basis-04 保留。行为无影响，但注释承载的“该探测不签发资格、清理期限对齐生产”在现行文件里没了，I-81 也未补记录。

**【低】“按生产相同的环境变量”措辞与代码不完全一致**
证据：run-network-preparation.py:50 还设 `HIMAWARI_QUALIFY_INSTALLED_RUNTIME` 且 PATH 指向 `/opt/himawari/node`；run-packet-checks.py:126 的探测环境没有该变量、PATH 是检查用 node 的目录（读代码证实探测脚本不读该变量，无实际影响，属文档措辞偏宽）。

**读代码证实为作者说法正确的：** 三份脚本改成退出码 0/输出原样且基准-04 有意不改 ✓；`sk-` 字面量拆开确能躲开 `check:secrets` 的 `openai-api-key` 规则（scripts/scan-machine-secrets.mjs 规则要求 `sk-`+连续 16 位及以上，且旧命令字符串里本来就是拆开的）✓；I-81 条目与代码逐点吻合（检查名=包内路径、22 来自 run-network-preparation.py:164、qualification/namespace 判定、--pi-tools、InstalledProbeCheckTest 覆盖计划/判定/缺工具）✓；探测在“装好的运行时”模式下正好 22 次 run（probe 逐行数过），与 `!= 22` 对齐 ✓。**未核实：** 两个新哈希与文件字节一致（本环境不能算哈希；但出包时 `adapter_drift` 会核对 sourceSha256 一半）、Hermes 两次复现的退出码、A-作者称 149 项测试通过。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本改动只碰 scripts/delivery-mode、docs、探测脚本和清单，不碰提示词目录、工具定义、历史存储或出口遮盖（diff 统计可证）；发给模型的内容仍只在末尾追加，不受影响。
2. **不会。** 新代码没有时间字段、无序集合或前后文依赖的遮盖；探测报告里的 `nodeVersion/platform` 随环境变，但不进入模型请求；出包哈希由内容决定，逐字节确定。
3. **有，反向用例会失败。** `InstalledProbeCheckTest` 覆盖计划、判定、缺工具目录，且反向用例（空输出、非 JSON、计数差 1、签发资格、命名空间未释放、两处计数）与实现一一对应（读 run-packet-checks.py 逐条核过）；模板哈希登记另有 `TemplateTest` 双向兜底。真实 subprocess 路径只覆盖到“缺工具早退”，其余只在 Hermes（已知限制，I-81 写明）。
4. **逐值核对：** ① `--pi-tools`/`HIMAWARI_PACKET_PI_TOOLS`：生产在 make-packet.py:648、消费在 run-packet-checks.py:193/217-218，两端口径一致，单元测试覆盖查找与缺失；② 新检查名 `acceptance/cloud/adapters/probe-foreground.mjs`：被 `generated-packet-gate.py:32-36` 消费（旧包因此被拒，是本次意图）；③ 两个新哈希：`sourceSha256` 出包时被 adapter_drift 核对，`adapterSha256` 无现行消费方（上面【中】项）；④ `sk-`拆分：check:secrets 规则不会命中，成立；⑤ 新探测断言的值（退出码 0、输出原样）与 PR 274 后运行时行为对齐（代码证实 PR 274 移除了拦截，探测在真实环境跑通为作者验证、未核实）。
