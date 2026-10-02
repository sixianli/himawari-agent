# 计划：round2-tool-execution

<!-- 只写打算，不写进度；做没做完用 longtask.py status 算。
     当前批次最多 3 项，写清做法和需要的证据；之后的条目每项一行；
     最后三段只追加，不改旧内容。 -->

## 当前批次

- R2-D21：thread-run-lifecycle 的“期限后恢复原答复”用例依赖 1 秒真实时间。先确认用例在什么条件下先到期走错分支（可用受控时钟或人为延迟复现），再改成不依赖真实时间快慢；判断它是测试设计问题还是产品问题，产品问题停下报告。带 [R2-D21] 的测试在 Hermes 通过；Claude 审核。
- R2-D18：生产 privateRoot 超过 27 字节时沙箱工具必然失败，启动时不检查（BL-20261002-002）。在启动时按同一套套接字长度算法检查并给出明确错误；带 [R2-D18] 的测试在 Hermes 通过；Claude 审核。
- R2-D16：正式 npm test 下三个 integration 测试仍读本地 dist/node-runtime（BL-20261002-001），改为使用校验过的产物；涉及测试运行方式，提前跑第 3 层。带 [R2-D16] 的测试在 Hermes 通过；Claude 审核。
- 这一批的第 3 层随同记录 R2-A1，以及 R2-D1、D11、D14、D17、D20、E3 在新版本上的证据。

## 之后

- R2-D19：另开 Codex 会话，分阶段复现（原因未明）
- R2-D15：安装解压目录权限，涉及打包需提前跑第 3 层
- R2-D13：心跳过期，原因未定
- R2-D12：先限时复现；只在测试加载源码线程文件时出现过，6 次未复现
- R2-D2：prepared 超时，随 R2-D19 的结论处理
- R2-D3
- R2-D4
- R2-D5
- R2-D6
- R2-D7：需先设计
- R2-D8
- R2-D9
- R2-D10：补安装 Runbook 的 bwrap 前提一节
- R2-S1：给已有回归测试加标签
- R2-S4：给已有回归测试加标签
- R2-S5
- R2-E1：已在云服务器验证；Hermes 上同样用 umask 022，规则已写入 AGENTS.md
- R2-A4：每个提交前运行
- R2-A2、R2-S2、R2-S3：Linux 产品路径资格（product-path-browser 不在普通 npm test 里），单独一批在 Hermes 上跑
- R2-A1、R2-A5：一轮结束时
- BL-20261002-004（升级 Pi）：计划外待办，不在本轮条目里，时间由用户定
- R2-L1、R2-L2、R2-L3、R2-L4：上线准备，部署要用户授权；R2-L2 是生产机上的环境检查，仍在云服务器

## 计划改动记录

- 2026-10-02 09:48 建立任务。
- 2026-10-02 10:05 从 .ci-output/handoff/round2-goal-checklist.md 迁入 33 项（场景 S1–S5、缺陷 D1–D19 中除 D12 外的 18 项、E1、验收 A1–A5、上线 L1–L4）。R2-A3 按 G5 撤回。D12 未列入，待用户决定是否在本轮范围内。原因：用户要求从现在起用 long-task-planning 管理（G12）。

- 2026-10-02 10:20 新增 R2-D12。原因：用户 G13 决定 D12 算进第二轮；status 未完成 27、等你决定 2、无法判断 0。
- 2026-10-02 10:30 R2-D9 的依据补上 G14、G15：第二轮内实现，只在 Linux 上验证，Mac 部分报告未验证；不撤回。完成条件不变。
- 2026-10-02 12:10 新增 R2-D20，当前批次改为 R2-D20 加新版本上的完整第 3 层。原因：stop-45 的第 3 层 unit 出现 1 项测试缺陷，Codex 按 reply-48 停在 unit 之后，其余 4 个项目没跑；AGENTS.md 补 umask 022 后指纹改变。status：当前版本已验证 2、旧版本验证过 5、未完成 24、等你决定 2、不做 1。
- 2026-10-02 13:50 新增 R2-E2；R2-A1 的 npm test 检查改成云端实际要跑的 `npm test -- --tools /srv/himawari-test/round2/tools`（检查按命令原文精确匹配，云端必须带 --tools）；当前批次改为 R2-D20 返工、R2-E2 和完整第 3 层。原因：stop-46 的正式第 3 层被 30 分钟总时限和 account-cli 写死的 15 秒时限卡住，用户 G16、G17 选择只在云端放宽。status：当前版本已验证 5、旧版本验证过 2、未完成 26、等你决定 2、不做 1。
- 2026-10-02 16:10 R2-E2 范围按 G18 扩大到 4 倍规则，标题和 goal_ref 随之更新，完成条件不变；新增 R2-D21。原因：r50 测量里 5 项超出已批准的 30 秒，另有 2 项依赖真实时间。status：当前版本已验证 5、旧版本验证过 2、未完成 26、等你决定 2、不做 1（新增 D21 前）。
- 2026-10-02 21:30 测试主机从云服务器改为 Hermes（G19）：R2-S1、R2-S2、R2-S3、R2-S4、R2-S5、R2-D1、R2-D2、R2-D3、R2-D4、R2-D5、R2-D6、R2-D7、R2-D8、R2-D9、R2-D11、R2-D12、R2-D13、R2-D14、R2-D15、R2-D16、R2-D17、R2-D18、R2-D19、R2-D20、R2-D21、R2-A2 的测试或命令检查 host 改为 hermes；R2-A1 的 npm test 命令改为 Hermes 工具链路径；R2-E2 按 G20 撤回；R2-D11 删去 test-timeout-entry 那项检查（它验证的变量透传随 R2-E3 撤掉）；新增 R2-E3；R2-L2 是生产机检查，不变。当前批次改为 R2-E3 和 Hermes 上的完整第 3 层。原因：用户 G19、G20。status（改动前）：当前版本已验证 2、旧版本验证过 6、未完成 26、等你决定 2、不做 1。
- 2026-10-02 21:55 Hermes 批次（stop-01）收尾：当前批次改为 R2-D21、R2-D18、R2-D16；R2-S2、R2-S3 与 R2-A2 合为产品路径资格批次；items.json 加 fingerprint.test_exclude ["docs/"]（核对过没有测试读取仓库 docs/，npm run check 的文档校验是命令检查，不受影响）；R2-D11、R2-A1、R2-A2 标题去掉过时内容，完成条件不变。原因：r51 第 3 层 5133/5133 通过，只改文档就让测试证据作废已发生多次。status（改动前）：当前版本已验证 2、旧版本验证过 8、未完成 24、等你决定 2、不做 2。

## 意外和发现

- 2026-10-02 D17：ADR 0044 的测试临时根太长，产品路径 SRT 套接字达 130 字节；ADR 0045 改为 /tmp/hXXXX（9117c78）。
- 2026-10-02 D18：同一算法得出 Linux 生产 privateRoot 不能超过 27 字节，启动时不检查（BL-20261002-002）。
- 2026-10-02 D19：Pi 准备线程从创建到 started 冷 6057ms、热 3580ms，全部计入 10000ms 预算（BL-20261002-003）。
- 2026-10-02 stop-45：第 3 层 unit 2152/1，失败为 preserves deadline after the parent exits 收到 49 字节。49 = 13（parent-start）+ 3×12（more-output），说明期限分类正确、父进程退出后的输出也收到了；只是 1 秒期限里两次 Node 启动在满负荷下占去大部分时间，只来得及写 3 行。同文件 tail 用例整段只用 422ms，说明负荷波动大。
- 2026-10-02 只改了 AGENTS.md（文档）也让全部测试证据变成旧版本，因为 AGENTS.md 在指纹范围内。
- 2026-10-02 stop-46：正式第 3 层（c5b5968）unit 2153/1，失败是 account-cli 写死的 15000ms 超时（上一轮 5.6 秒）；contracts 406/0；integration 在 ci/policy.json 的 30 分钟总时限耗尽时被 SIGKILL（unit 8.4 分钟、contracts 1.3 分钟，留给它约 18 分钟），e2e、pi-compat 没开始。云服务器上从未完整跑完过 integration。
- 2026-10-02 r50 测量（3069053）：integration 单独 58.8 分钟，2412 通过、9 失败、15 未执行；e2e 15.6 秒；pi-compat 96.5 秒。sqlite-durable-repositories 连续写 1000 条事件的 4 例超过 30 秒：产品 SQLite 为 WAL 加 synchronous=FULL（migration-engine.ts:730-731），每次提交都等落盘，这块盘每次 11–19ms。生产也在同一块盘，这一点并入 R2-L3 的响应时间测量。
- 2026-10-02 r50 里 sandbox-preparation-control 的 JOB_HOST_NOT_READY、installable-node-services 的 beforeAll 120 秒超时、prepared-file-runner 的 PREPARED_RUNNER_INSTALL_FAILED（stderr 为空），都发生在没有重新构建、沿用 c5b5968 安装包的直接运行中；先看下一次正式第 3 层（先构建）是否复现，复现再登记条目。
- 2026-10-02 r51（Hermes，1cae2c5，默认时限）：npm test 五项目 5133/5133，测试阶段 25.2 分钟（integration 20.4）；云端 r50 的 sandbox-preparation-control、installable-node-services、prepared-file-runner 三处失败和 D21 两例均未复现。Hermes 只有 bwrap 0.6.1：普通测试无用例需要真实 0.11.2，隔离后端的 0.11.2 门槛只由脚本夹具覆盖，真实 0.11.2 未验证。
- 2026-10-02 审核 7ce0b57：D18 的 Mac 23 字节依据不成立，SRT 0.0.75 只在 Linux 建 claude-socks 网络桥（sandbox-manager.js:716）；reply-03 要求按平台列出实际套接字后重算。
- 2026-10-02 stop-02：D16 改用产物运行时后，sandbox-preparation-control 的 import failure 用例 4402ms 失败（Job Host 约 3.75 秒无输出，消息过期 JOB_HOST_WORKER_LEASE_INVALID）；r51 开发构建同一用例 376ms 通过。reply-04 判为 D16 范围，先两种模式各 10 次取证，再定是否属于 D13。

## 决定

- 2026-10-02 D18、D19 不在当前批次修；当前批次只完成 20 文件运行和第 3 层。
- 2026-10-02 当前批次的 Codex 会话 01a0f5e3 继续用 resume 答复（reply-48），本批结束后的新批次一律用 codex-launch.sh 新开会话。
- 2026-10-02 Mac 相关的问题不再问用户：Mac 测试无限期推迟（G5、G15），涉及 Mac 的条目只做并验证 Linux 部分，Mac 部分在报告里写“未在 Mac 上验证”。
- 2026-10-02 R2-D20 判为测试缺陷（49 字节的组成说明产品行为正确，新断言会直接核对每一行都收到），只改测试断言，不改产品期限；第 3 层遇到失败时先跑完全部 5 个项目再停，避免再次只拿到 unit 的结果。
- 2026-10-02 R2-E2 的放宽只在云端生效，回到同步写入快的机器时随 BL-20261001-002 一起撤掉；总时限的分钟数由 Claude 按实测加余量决定（G16 已授权）。
- 2026-10-02 用户要求之后交给 Codex 的工作一律用 gpt-6.1-sol、max、fast（原话见记忆 codex-reasoning-effort-high）。当前会话 01a0fb4c 这一轮仍是 xhigh，到下一个停止点 resume 时改成 max。
- 2026-10-02 hook 时限属于“测试自己的时限”，按 G18 一并放宽 4 倍；断言里“多久之内应当发生”的等待（expect.poll、vi.waitFor 等）和产品期限不放宽。
- 2026-10-02 stop-02 的等待分类规则：反复检查条件直到成立、超时由断言判失败的（含手写轮询）算断言等待，保持原值；等动作或进程做完、超时直接报错或强制处理的算辅助等待，按 G18 放宽；两种用途共用时按辅助等待放宽。之后 Codex 按此规则自己判断并列清单。
- 2026-10-02 20:10 用户决定测试回到 Hermes（G19）。Claude 停下正在实现 R2-E2 的 Codex 会话 01a0fb4c（当时只在本机写代码，没有远端测试在跑），按 G20 把未提交改动另存为 .ci-output/handoff/discarded/2026-10-02-r2-e2-uncommitted.patch 后从工作区清除。Hermes 核对：Ubuntu 22.04.5、bwrap 0.6.1、根盘可用 14 GiB、/data 机械盘 197 GiB、umask 0002；9-28 的 r32 完整测试在 Hermes 上五项目合计约 26 分钟。产品 Linux 隔离后端要求 bwrap 0.11.2，Hermes 上真实 0.11.2 的路径能否覆盖待第一次运行核对。
