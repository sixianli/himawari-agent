Merge 增量与作者描述的文件集合完全一致，且相对 main 的 diff 只含本 PR 自己的文件（main 的文件未被改动）。接下来核对 CI 文件内容一致性与可能冲突的假设。
# PR #258 第 8 轮复核报告（合并增量核对）

先说结论：**没有发现「会出错」的问题**。两个合并都没有改动一行 main 的文件，合并结果与 origin/main 逐字相同；#261（Hermes runner）和 #264（CI 策略）带入的内容本身自洽，且与本 PR 的文件（尤其迁移 0078、ADR 编号）没有冲突。以下为逐项证据。

## 发现的问题（按严重度）

**没有「会出错」级别的问题。** 两条低级别备忘（非缺陷）：

1. **低**、`.agents/reviews/pr-258/round-8/deepseek-v4.1-flash.attempt-1.md`（1 字节空文件）、deepseek 本轮首次尝试留了空文件占位，与 round-3、round-6 的 `attempt-1` 模式一致，不影响任何功能。
2. **低**（描述不完整，非错误）、「#264 改 CI 配置和 check-policy」的说法漏了 `docs/architecture-v0.1.md`、`docs/adr/0174-no-github-cache-and-one-day-artifacts.md`（新增）、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md`，这些也在合并增量里（`git diff 4f08cbba 02cf6f0c --name-only`）。不影响结论。

## 读代码证实的

**一、合并没有弄坏任何 main 文件（作者核心诉求，证实）**
- `git diff --name-only ba915c21 53d3d16e`：两个提交之间的差异**只含本 PR 自己的文件**（apps/packages/test/.agents 复核记录），#261 的全部文件（0170、0173、runbook、gh-runner.service.in、gh-runners.slice、hermes-runner-scripts.test.mjs、pr-261 复核记录）都不在列表里——即合并结果与 main 逐字相同。
- `git diff --name-only 72acf380 02cf6f0c` 同理：ci/*、scripts/ci/*、ADR 0174 等均不在列表，与 main 逐字相同。
- 反向核对第一父系：`git diff d863fc6c 53d3d16e --name-only` 恰好是作者列出的 21 个文件；`git diff 4f08cbba 02cf6f0c --name-only` 恰好是 31 个 CI 文件，没有多余的「evil merge」改动。
- 合并对象（merge header）与作者说法一致：53d3d16e 的第二父是 ba915c21，02cf6f0c 的第二父是 72acf380。

**二、与 #261/#264 没有冲突的假设（证实）**
- ADR 编号：#261 新增 0173、#264 新增 0174，目录里 0170–0174 各一份、无重复（glob 全列）。本 PR 没有新增任何 ADR（对比基线 72acf380..02cf6f0c 的文件清单中无 docs/adr）。`scripts/check-adr-numbers.mjs:10-29` 只查文件名格式和编号重复，不要求连续，所以 0172 编号被跳过（0171 之后直接 0173）不会报错。
- 迁移 0078：两个 main 合并都没碰 `packages/persistence-sqlite/src/migrations/`；目录里最新仍是 0077，本 PR 新增的 0078 直接接上，SUPPORTED_SCHEMA_MAX 77→78（scripts/operations/workspace-lifecycle-audit.mjs:5）对应迁移集合 0001–0078，且受 check-audit-schema-range 门槛比对（scripts/check-audit-schema-range.mjs:16-27），رقم一致。
- Hermes runner 与本 PR 无假设交集：合并只改 systemd 资源上限（MemoryHigh 12G/Max 13G、slice 13G/14G，删 CPUQuota/CPUWeight/IOWeight/Nice），对应测试同步更新且断言方向正确（test/tooling/hermes-runner-scripts.test.mjs:662-704，反向断言 `not.toHaveProperty` 仍在则失败）。

**三、#264 带入内容两端核对（证实自洽）**
- retentionDays 1 天：生产端 `ci/policy.json:362`（reports/diagnostics 各 1）、`ci/policy.schema.json:190-193`（const 1）、`ci/quality-policy.json:15`；消费端 `scripts/ci/quality-policy.mjs:44`（constant({1,1})）、`scripts/ci/export-evidence.mjs:110,161`（按 1 天算过期）、`.github/workflows/ci.yml/main.yml/quality.yml` 全部 25 处 `retention-days: 1`（grep 证实，无残留旧值）。全部匹配。
- 删 actions/cache：`ci/toolchain-lock.json` 删了条目，`scripts/ci/install-tools.mjs:118-129` 的 expectedActions 同步删「actions/cache」，assert 是**集合相等**比对（第 125-128 行），两端删一致；grep 全仓只剩 docs/adr/0174 和测试里的引用，无工作流残留。
- 兼容旧值的升级开关 `upgradeArtifactRetention`（scripts/ci/check-policy.mjs:74-83）只接受精确 30/7，挂在 `resolvePolicySource`（989-996 行），且有反向用例：test/tooling/policy.test.mjs:697-711——30/7 升级为 1/1，14/7 直接 `toThrow("retentionDays")`。

**四、本轮（a22e487e → 02cf6f0c）的全部增量清单（证实与作者说法一致）**
- d863fc6c：仅 round-7 复核记录；ac3b2db0/4f08cbba：仅 round-8 文件占位和记录（`git diff --name-only a22e487e 4f08cbba` 证实只有 .agents/reviews/pr-258、pr-261 + 合并带入的 6 个 Hermes 文件）。
- 无任何业务/运行时代码被合并触碰。

## 推测 / 未核实

- 「check:ci-policy 通过」「check:adr-numbers 通过」的**运行时结果未核实**——我不能执行 npm 命令；但静态核对（schema const、quality-policy、工作流、脚本、测试）全部一致，出问题需要三方不同时成立，推断可通过。
- 「#261 已在自己的 PR 里复核过」：未读 `.agents/reviews/pr-261/` 的复核结论，未核实该说法，但本轮合并未改其内容，与本 PR 无交集，风险不变。
- Hermes runbook（10 行改动）和 ADR 0173 的正文我未逐字读（未核实），只核对了 systemd 文件与其测试。

## 侧重检查（测试覆盖、文档与代码一致性）

本轮合并增量全部来自 main（已在各自 PR 复核），无一行业务代码，因此本 PR 的用户流程（例如「owner 在设置 → 数据 → 敏感信息拦截记录查看」）不受影响：入口 `apps/control-center/src/app.tsx`、`components/sensitive-interceptions.tsx`、后端 `production-sensitive-interceptions-control.ts` 等在本轮合并中零改动。增量的可执行文件只有 CI/运维脚本，覆盖情况：

- **有覆盖**：`check-policy.mjs` 的 retention 升级（policy.test.mjs:697-711，含 14/7 反例）;缓存/保存期检测（ci-optimization.test.mjs:85-98，反例含 `actions/cachet@x` 拼写错会被判为非缓存使用）；toolchain 集合比对（install-tools.mjs:125-129 + toolchain.test.mjs）；Hermes 资源上限（hermes-runner-scripts.test.mjs:662-704，反例：任何旧键残留即失败）；迁移上限门（audit-schema-range）。
- **没有覆盖**：三个 workflow 文件本身的运行行为（只有工具箱按 AST 断言步骤）；systemd 单元在真实 Hermes 机器上的加载效果仍未机器验证——不过这属于 #261 原文范围，不是本合并引入的新风险。

## 必答问题

1. **会不会改变模型已见过的请求开头：不会。** 两个合并的文件清单（d863fc6c..53d3d16e、4f08cbba..02cf6f0c）不含任何 runtime-pi、agent-service、prompt 组装或遮盖代码；本轮除合并外只有 .agents 复核记录。发给模型的全部内容与上一轮复核点 a22e487e 相比零变化，自然满足「只在末尾追加、每轮变化的值都在最后一条消息」。
2. **同段文字不同字节：不会。** 增量不含遮盖、时间字段、集合排序或序列化代码；retentionDays 等新值只进 CI 策略文件，不进任何模型请求。
3. **自动检查与反例：有。** retention/缓存/Hermes/ADR 四块都有对应测试，且我逐条核对过反向用例的断言方向（14/7 会 throw、非缓存步骤会被筛掉、Hermes 旧键残留会 not.toHaveProperty 失败）。测试本身的运行结果未核实（不能执行）。
4. **每个值的产生端与使用端：核对通过。** retentionDays 1/1（生产：policy.json/schema/quality-policy.json；消费：quality-policy.mjs、export-evidence.mjs、25 处 workflow `retention-days: 1`，全部一致）、actions/cache 移除（锁、install-tools expectedActions、三工作流、测试，四方同步）、SUPPORTED_SCHEMA_MAX=78（与迁移目录 latest=78 经门比较一致）、upgradeArtifactRetention（被 resolvePolicySource 唯一调用，升级值与其余消费端一致）。本 PR 侧的 0078 迁移 id 只被自己这轮新序列使用，与 main 带入的值无交叉。
