复核结论（基准 ba915c21 → 6269e972，单提交 `6269e972`）

## 更正作者说法的地方

作者说明基本与代码相符，两处需要更正/补注：作者说「另一个代理直接在 main 上改了三个工作流」——git log 显示这些工作流改动是通过 PR #261（`327fd104`…`ce1bcbee`，合并于 `ba915c21`）进 main 的，不是任意直推；另外「现在 GitHub Actions 已停用」（ADR 0174 的后果段）与同日的 ADR 0173（active，决定 Hermes 跑 CI）字面矛盾，哪边符合现实无法从代码核实（见发现 3）。

## 发现（按严重度从高到低）

**1. 中 — scripts/ci/check-policy.mjs:981、scripts/ci/contracts.mjs:25-28、ci/policy.schema.json:189-192（读代码证实）**
作者自己点出的「用新 schema 校验基准提交的旧策略会被拒一次」属实，而且不止「拒一次」：PR 运行和合并后第一次 main push 都会失败。
证据链：`resolvePolicySource` 读基准提交的 `ci/policy.json` 并调 `validatePolicy`（check-policy.mjs:978-981）→ `validatePolicy` 第一步 `validateRecord("CheckPolicy", policy)`（check-policy.mjs:85）→ `CheckPolicy` 校验器来自「当前」`ci/policy.schema.json`（contracts.mjs:25-28），其中 `reports: {const: 1}`、`diagnostics: {const: 1}`。基准路径只有三种：PR 事件时 `baseSha = merge 提交的第一个父提交`即旧 main（context.mjs:97-108）；push/main-fallback 时 `baseSha = payload.before`（context.mjs:110-111）；main.yml 在策略变化时走 `full` 回退，传入的仍是旧 main（main.yml:63 `uses: ./.github/workflows/ci.yml`）。基准分支上 `ci/policy.json` 仍是 30/7（本提交才改），所以这几种运行都会抛错，`ci/required` 红叉挡合并。
建议：要么接受一次失败并在 ADR 里写明失败信息怎么读；要么更贴合仓库先例的做法——在 `resolvePolicySource` 里像 integration `workerLimits` 那样做一次显式固定迁移（check-policy.mjs:986-996 的旧值→新值模式），把 30/7→1/1 作为唯一接受的迁移，schema 对候选策略保持 const 1 不变。作者问「是否需要在本 PR 里处理」，我的判断：如果要这个 PR 合并后 CI 能复现一条绿色必经路径，用迁移方案处理比等它自愈更合适；只是它需要额外的测试用例。

**2. 中 — docs/architecture-v0.1.md:639（读代码证实）**
文档与代码不一致：仍写着「公开报告与诊断分别按 30/7 天保留」。同一仓库、同一主题的 CI 设计文档（spec）改了三段（design.md 127/297/320 行）并指向 ADR 0174，但引用 CI Plan 的这行汇总没有改，还引用计划文档作为 SOURCE。
建议：把该句改成「报告和诊断都只在 GitHub 保留 1 天（ADR 0174）」。

**3. 中（哪边为真未核实）— docs/adr/0174-...md:86,96 vs docs/adr/0173-...md:25-31（读代码证实文字矛盾）**
ADR 0174 讲「现在 GitHub Actions 停着/重开 Actions 之前 quality.yml 还在 GitHub 自己的机器上跑」；同日 active 的 ADR 0173 讲 Hermes 两个自托管 runner 正作为 CI 主力被接纳并扩配。两份文档的前提互相矛盾，而作者关于「不会运行」的推断完全依赖 0174 的前提。建议：由 Owner 确认现状并在 0174 里显式 link/引用 0173 的最新决定（或补一条 amend），否则读者无法判断「一次失败」是否会发生。

**4. 低 — scripts/ci/main-evidence.mjs:107-117（读代码证实）**
main 确认的 light 模式要求「成功的 PR run updated_at 距今 < 24h」且 gate artifact `!a.expired`。artifact 保存期改成 1 天后，artifact 过期点≈上传时间+24h，与 24h 窗口基本重合、方向 fail-closed（先超窗后消失），不会坏，但现有测试（gate-lifecycle、main-evidence.test.mjs）没有覆盖「retention=1、时间贴 24h 边界」的情形；main 确认产物 `retention-days: 1`（main.yml:60,102）也意味着 main-confirmation 报告一天后就没有。建议：在 ADR 0174 后果里补一句「main 确认沿用的 PR gate artifact 也必须当天取回」，可选地加一条边界测试。

**5. 低 — 已核对但未见问题（正评）**：`retentionDays` 的全部读取点只有 quality-policy.mjs:44/154/161/210（生成并比对 quality.yml，实际 yml 13 处都是 1）与 export-evidence.mjs:110/161（`>=` 语义先报过期后消失）；`ci.yml` 的 17 处上传全部为 1（ci.yml:68…534），由 ci-optimization.test.mjs:91 逐个断言；`actions/cache` 引用只剩文档叙述（ADR 0174）和测试反面断言（ci-optimization:80,88），锁文件（toolchain-lock.json 5 个 Action）与 install-tools.mjs:118-128、toolchain.test.mjs（5）三处一致。「编辑过的文件里删注释」的约束也执行了（quality-policy.mjs:221 旧注释删除）。

## 侧重检查

普通流程走查：开发者提 PR → `pull_request` 事件（ci.yml:3）→ policy job `run.mjs --check policy --base "$CI_BASE"`（ci.yml:53，CI_BASE 为空 → context.mjs 用 merge 提交父项定基准）→ `resolvePolicySource`（本次会按旧策略失败，即发现 1，无对应测试；policy.test.mjs:647-662 只在 fixture 里用新值模拟，测试不了这条真实路径）→ 其余检查读取同一基准策略。另外：quality.yml 的 schedule/手动交接、export-evidence 的 `CI_HANDOFF_EVIDENCE_EXPIRED` 路径有单测（evidence.test.mjs:199 反向用 31 天推到超期，改 1 天后仍会失败，成立），但没有 1 天整边界用例。测试覆盖总体充足，缺口仅发现 1、4 两处。

## 必答问题

1. 不涉及。本提交只改 CI 配置、工具锁定、CI 测试和文档，没有触碰任何发给模型的请求内容（无 prompt、工具定义、历史消息、遮盖逻辑改动），「只追加」规则无适用面。
2. 无。改动产物是 CI 策略 JSON/schema/YAML 和 ADR 文本，不含时间戳或随请求生成的字段；export-evidence 的 `Date.now()`/`expiresAt` 在原代码中本来就有，只随保存天数数值缩放，不进模型请求。
3. 有，部分未实跑。核对对照（读代码证实）：`npm run check:ci-policy` 由 `check-policy.mjs` 实现（package.json:76），策略一致；`ci-optimization.test.mjs:84-93` 用三个工作流逐个断言无 cache、每处 upload `retention-days === 1`，反向（加回 cache 步骤、改成非 1）按断言逻辑必然失败；quality-policy 反向用例存在且仍成立于新值（quality-policy.test.mjs:259-264「long-lived diagnostics → retention 30」抛错、runner.test.mjs:360、quality-local.test.mjs:289、policy.test.mjs:653-658）。我没有运行过任何测试或检查（工具受限），「PR 后检查全绿」是静态推断，未核实。
4. 逐对核对过（读代码证实）：值 1/1 的产生处（policy.json、schema const 1、quality-policy.mjs constant、quality-policy.json）与使用处（quality.yml 实际 yml、export-evidence 过期判定、evidence/runner/quality-local 反向测试）全部匹配接受；`actions/cache` 删除的产生/使用两端（toolchain-lock.json:94-134 五个 Action、install-tools.mjs:118-128、toolchain.test.mjs length 5、workflows 无引用）一致；无遗漏读取点。唯一在使用端未「接受」的是发现 1：schema 的 1/1 用在基准提交旧策略上仍报错，这正是需要决定的点。
