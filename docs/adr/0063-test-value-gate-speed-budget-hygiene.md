---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-21"
covers: "ci/coverage-policy.json, ci/policy.json, ci/test-hygiene-baseline.json, scripts/ci/check-policy.mjs, scripts/ci/run.mjs"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0063：新增测试先过价值门槛，测试有速度与隔离预算，测试卫生由门禁守住

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-21 用户让 Claude 通读 Cindy 项目作者整理的测试规则汇编，把亮点整合进本项目，通用部分抽进 `verification-discipline` skill（Claude 的测试与验证纪律 skill，所有项目共用）。对照后发现本项目已经有的：修 bug 先红后绿、分层按批运行（[ADR 0057](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0057-batch-layers-one-two-for-small-defects.md)）、不放宽时限、不许削弱测试、`registeredTests` 白名单限制 `skip`、`scripts/ci/run.mjs` 把被跳过的测试判为 `CI_TEST_INCOMPLETE`、[审核不采信代理自报](../lessons.md)。本项目缺的：写测试之前的价值门槛、速度与隔离的硬数字、“改了某类代码就必须有某类测试”的要求、测试卫生的自动门禁。2026-10-21 门禁第一次以只报告模式跑全仓库（Hermes，运行 `green-02`）得到的存量：逐用例模块重置 10 处（7 个文件）、100ms 以上真实等待 29 处（12 个文件，多在集成测试）、普通单测读生产源码文本 1 处、固定端口 0 处（本 ADR 第一版用 `git grep` 估的“5 个文件”“2 个文件固定端口”“13 处真实等待”不准：所谓固定端口是测试里 shell 字符串中的端口，语法树检查不把字符串算作监听；修订 2026-10-21）。“测试文件不属于任何项目就报错”本项目已经有：`scripts/ci/check-policy.mjs` 的 `planTestInventory` 要求每个测试文件恰好一个归属（测试项目或 `registeredTests` 登记），任何项目一个文件都没有也报错，`npm run check` 里的 `check:ci-policy` 每次提交前都跑；4 个 `test/fixtures/*-child.test.ts` 子进程夹具已登记为 `child-fixture`（修订 2026-10-21：本 ADR 第一版误写成它们不属于任何项目）。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **通用规则在 skill，本项目直接采用。** 测试价值六项问答、速度预算、隔离清单、平台差异、三态结果（未跑 / 失败 / 通过）、红绿记录、不改门禁基线放行自己、复核不信自述，全部按 `verification-discipline` skill 执行（本地副本在 `~/.claude/skills/verification-discipline/`，源码在公开仓库 agent-skills）。本项目不另抄一份。
2. **三类改动必带的测试。** 改 SQLite 结构或迁移：必有从旧版数据升级后照常可用的测试，只测全新安装不算，干净地拒绝旧数据不算通过（[BL-20261021-003](../backlog/BL-20261021-003-sqlite-升-级-回-放-要-用-真.md)）。改 Gateway、Worker、控制中心之间的重试、超时、重连：必有多个控制端共用同一资源、一个故障、其余不受影响的测试（[BL-20261021-004](../backlog/BL-20261021-004-gateway-worker-重-连-与-恢-复-多.md)）。改提示词、工具定义、模型映射、用量计量：假模型只证明配置传对，真实效果用手动评测脚本对真实模型实测并写明指标（[BL-20261021-005](../backlog/BL-20261021-005-模-型-行-为-改-动-的-评.md)）。
3. **测试卫生门禁，基线只降不升。** 门禁不另写脚本，而是扩展已有的 `scripts/ci/check-policy.mjs`（它已经用 TypeScript 语法树检查每个测试文件，`npm run check` 里的 `check:ci-policy` 每次提交前都跑）：在同一棵语法树上识别四类问题——逐用例模块重置（`vi.resetModules`，含命名空间导入和解构别名）、100ms 以上的真实等待（全局 `setTimeout`、`node:timers`、`node:timers/promises` 的延迟字面量）、固定端口（`listen` 的字面量端口）、普通单测（`*.unit.test.*`）用 `node:fs` 读 `src/` 下源码文本。存量记在 `ci/test-hygiene-baseline.json`（每个“文件×类别”一条计数），比较基准是基准提交里的那份基线（本地 `HEAD`，CI 里是目标分支），所以工作区手改基线无效：条目不能新增、计数不能调高、模式只能从 `report` 收紧到 `enforce`；现状少于基线也判失败并给出建议值，逼着顺手收紧。`report` 模式只把发现清单和偏差写到标准错误、退出 0；`enforce` 模式有偏差就失败，错误信息含文件、行号、类别和改法。先以 `report` 模式跑一轮核对误报，再把模式改成 `enforce`（[BL-20261021-001](../backlog/BL-20261021-001-测-试-卫-生-门-禁-拦-无.md)）。这是 [ADR 0060](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0060-hard-constraint-on-third-repeat.md) 所说的硬约束的一种。已知盲区：字符串里的命令、变量延迟、常量端口、`fs.promises` 以外的读法都不认。
4. **测试文件不能悄悄不跑。** 这一条已由 `check-policy.mjs` 的 `planTestInventory` 实现，不新增代码；[BL-20261021-002](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/backlog/BL-20261021-002-测-试-运-行-脚-本-自-检.md) 据此关闭。测试分层仍按 `ci/policy.json` 现有的 6 个项目（`unit`、`contracts`、`integration`、`e2e`、`pi-compat`、`tooling`），不改名。
5. **覆盖率门禁保留，但不为数字补测试。** `ci/coverage-policy.json` 的改动行覆盖阈值照旧；不得为了凑覆盖率新增说不出价值的测试，评审可以要求删除。
6. **界面改动看截图、报未覆盖。** 控制中心改动要在浅色和深色两种主题下实际渲染并看截图；没被任何检查加载的改动文件写“未验证”；不能用自己生成的截图批准自己的视觉改动，视觉改动仍按 AGENTS.md 的设计基线由用户确认（[BL-20261021-006](https://github.com/sixianli/himawari-agent/blob/7c8521fe5f55e7dd57c5bd52badd16eef647502e/docs/backlog/BL-20261021-006-控-制-中-心-界-面-截-图.md)）。
7. **速度预算在 CI 或测试主机上量。** 单测文件单独运行 5 秒内、超过 10 秒写原因，这个数不在 Mac 上测（Mac 不跑服务器测试）。
8. **不采纳的部分。** Cindy 把守则用 @docs/ai/AI_TESTING_RULES.md 挂进 CLAUDE.md，本项目不这样做，因为用户要求系统级指令精简、不重复；Cindy 的 8 层按文件名后缀分层，本项目保留现有 6 个项目；Cindy 的“完整结果以 CI 为准”在本项目对应第 3 层加 GitHub 必过检查，不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：把 Cindy 的守则整份抄进本项目文档并挂进 CLAUDE.md

- 好处：一次到位。
- 代价：与 skill 重复，每个会话多占上下文；和本项目已有的分层、主机、批次规则有重叠和冲突，要维护两份。

### 方案 B：通用规则进 skill，本项目只记采纳决定、项目专属的必带测试和门禁（采用）

- 好处：规则只有一处；本项目文档只多一份 ADR 和几条 Backlog；门禁是可执行的硬约束，不只是文字。
- 代价：门禁和自检要写脚本（交 opencode，Claude 审），先报告后阻断需要两轮。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 正面：新测试有价值门槛，慢测试和不隔离的测试被门禁拦住，三类高风险改动有固定的测试要求；测试文件不会悄悄不跑这一点已有现成检查守着。
- 负面：接入门禁前要清掉或登记存量问题（见背景里的数字）；每个新测试要多写六项说明。
- 后续：Backlog BL-20261021-001、003 到 006（002 已关闭）；`AGENTS.md` 的测试触发一节加一行指向本 ADR；`docs/lessons.md` 不改（没有新的重复错误）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 来源：用户 2026-10-21 提供的 Cindy 测试规则汇编（用户本机文件，不入库）；对照记录在 `.ci-output/handoff/2026-10-21-cindy-testing-rules-proposal.md`（本地，不入库）。
- 分层与批次：[ADR 0057](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0057-batch-layers-one-two-for-small-defects.md)；硬约束：[ADR 0060](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0060-hard-constraint-on-third-repeat.md)；分工：[ADR 0062](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0062-claude-writes-complex-code-opencode-routine.md)。
- 测试主机操作：[测试主机操作 Runbook](../runbooks/test-host-operations-runbook.md)。
