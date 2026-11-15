### 1、中：分片的一致性只在单台 runner 内自证，跨台没有核对，可能出现漏跑或重跑而检查仍通过

文件:行：`scripts/ci/test.mjs:48-57`、`scripts/ci/test.mjs:74-83`、`scripts/ci/test.mjs:134-139`、`scripts/ci/aggregate.mjs:123-131`

问题：每个 integration 分片都在自己那台 runner 上重新算一次候选文件，再用“本分片实际跑的文件 == 本分片算出的文件”自证；汇总只核对每个成员报上来的项目集合，不核对两份文件列表的并集和交集。

读代码证实的：

- 候选集合来自本地工作树，且包含未跟踪文件：`test.mjs:48-57` 用 `git ls-files --cached --others --exclude-standard`。
- 分片结果只跟本机候选列表比：`test.mjs:134-139` 的 `expectedFiles = shard ? selected : candidates`，随后只比较本分片 `actualFiles`。
- 汇总只看项目 id：`aggregate.mjs:123-127` 只比较 `result.projects` 的 id 集合，没有文件级证据。

推测：正常 CI 三台 runner 检出同一提交，未跟踪文件通常一致，所以大概率不会触发；但只要两台机器的工作树不同（例如安装步骤生成了匹配 include 的未跟踪文件），排序后所有文件的余数位置都会移动，可能一个文件两台都没跑、另一个文件两台都跑，而两台的 `CI_TEST_FILE_SET_MISMATCH` 都不会报，汇总也发现不了。这与“每个项目在成员之间恰好跑一次”的说法只到项目级，不到文件级。

建议：不要把分片候选集合建立在本地工作树上，改用被测提交的权威文件列表（例如 `git ls-tree -r --name-only <testedSha>`），或让每个分片把实际文件列表写进结果、由 aggregate 核对两份互不相交且并集等于权威列表。再加一个“两台候选列表不同也能被发现”的反向用例。

### 2、中：`--coverage measure` 报全部项目，和拆分后按成员校验项目集合冲突，且没有“只在一台上跑”的机制

文件:行：`scripts/ci/run.mjs:332-356`、`scripts/ci/run.mjs:436`、`scripts/ci/aggregate.mjs:100`、`scripts/ci/aggregate.mjs:123-127`、`.github/workflows/ci.yml:297`

问题：measure 路径故意忽略 `member.projects`，跑 `check.projects` 的全部项目；但 aggregate 现在按每个 tests 成员自己的 `member.projects` 核对 `result.projects`。初始化或手工 measure 时，任一 tests 成员都会报全部五个项目，被汇总判为“Project count set differs from policy”。

读代码证实的：

- `run.mjs:353-356`：measure 时 `plainProjects` 基于 `check.projects`，不是 `member.projects`；`run.mjs:436` 把 `shard` 置为 `undefined`。
- `run.mjs:380-394` 让 measure 结果包含 `coverageProjects`（unit、contracts、tooling、integration），再加上 e2e、pi-compat，最终就是五个项目。
- `aggregate.mjs:100` 取 `member.projects`，`aggregate.mjs:126-127` 要求 `result.projects` 的集合与它完全一致。
- `ci.yml:297` 的 tests 作业始终传 `--baseline-candidate initial-only`；`check-policy.mjs:1396` 在基准没有策略时 `initialization: true`，`run.mjs:328` 因而在三个成员上都触发 measure。

推测：普通 PR/main 运行 `initialization` 为 false，不会走 measure，所以现网日常路径不受影响；但“基准没有策略”的初始化路径和手工 `--coverage measure` 无法通过三道 tests 成员。ADR 第 57 行说“在一台上跑全部项目”，代码没有指定哪一个成员跑，workflow 也没有条件只让一个成员跑。

建议：显式指定唯一成员执行 measure（workflow 条件或策略标志），并让 aggregate 对 measure 结果只接受这一个成员的“全部项目”报告；或者反过来，measure 也按成员分片但另行合并覆盖率报告。补一个“三个 tests 成员 + measure”的汇总用例。

### 3、低：全量运行中空分片失败只在 `run.mjs` 兜底，`runTests` 自身对零文件分片返回成功，且没有直接测试

文件:行：`scripts/ci/test.mjs:81-87`、`scripts/ci/test.mjs:155-162`、`scripts/ci/run.mjs:536-546`

问题：`runTests` 只要分片算出的 `selected.length === 0`，就推零计数并 `continue`，最终 `exitCode` 仍可能是 0；ADR 说的“全量下分到零个文件按没跑测试失败”实际依赖 `runCheck` 后面通用的 `CI_INCOMPLETE_EXECUTION`。

读代码证实的：

- `test.mjs:84-87`：空 `selected` 直接推 `zeroCounts()`，没有区分“相关范围为空”和“全量分片为空”。
- `test.mjs:160-162`：`exitCode` 只由 outcomes、failed、skipped 决定，空分片没有 outcome，所以为 0。
- `run.mjs:536-546`：只有这里通过 `allRelatedEmpty` 和 `counts.files < 1` 把全量空分片判失败。

推测：当前生产入口都经过 `runCheck`，所以不是现网漏洞；但如果以后直接复用 `runTests`，或新增不经过 `runCheck` 的入口，就会悄悄通过。现有测试也只覆盖“分片写错时什么都不跑”，没有“全量空分片必须失败”的用例。

建议：把全量/相关范围的判断下沉到 `runTests`，或在 `runCheck` 上加一个显式的全量空分片反向测试，确保 ADR 第 80 行的承诺有自动检查守着。

### 4、低：ADR 的分片公式没说明下标从 0 开始，与代码的实际取法不一致

文件:行：`docs/adr/0275-tests-job-runs-on-three-runners.md:53`

问题：ADR 写“第 i 个文件归第 `i % count + 1` 份”；代码用的是 0 基下标（`test.mjs:82` 的 `index % shard.count === shard.index - 1`），所以第 1 个文件（1 基）实际归第 1 份，按 ADR 公式却会算成第 2 份。

读代码证实的：`test.mjs:81-83` 先用 `.sort()`，再按 `index % shard.count === shard.index - 1` 选文件；`pipeline.test.mjs` 的用例也写明五个文件分两份是第 1、3、5 个和第 2、4 个。

建议：把 ADR 改成“下标从 0 开始，第 i 个（i 从 0 起）归第 `i % count + 1` 份”，或“第 i 个（从 1 起）归第 `(i-1) % count + 1` 份”。

## 侧重检查

- 错误路径：`test.mjs:60-71` 会拒绝“不是单个项目”“份数不大于 1”“下标越界”的分片；`policy.schema.json:85-107` 与 `check-policy.mjs:462-493` 会拒绝缺项目、项目跑两次、分片成员带多个项目、非 tests 作业写拆分。未发现可绕过这些校验的入参。全量空分片由 `run.mjs:536-546` 兜底，见意见 3。
- 不合规范/不可信输入：`shard`、`projects`、member key 全部来自受信策略；文件路径以参数数组传给 vitest，不经 shell，未发现注入面。`run-share.mjs:18` 的 `NAME` 和 `run-share.mjs:163` 的 `--output-key` 正则都接受 `integration-1`、`others`；`result.schema.json` 的 `matrixKey` 只是非空字符串。仓库内消费者都接受新键，未发现 I-73 式“清单 id 过不了后端校验”。GitHub Actions 对带连字符 job output 的表达式语义未在本仓库内单独验证，但仓库已有 browser 的同类键且 `validateWorkflow` 要求同样写法。
- 安全：没有新增 secrets、权限或外部输入；工作流仍是只读，新增矩阵值不参与 shell 拼接。未发现问题。
- 资源耗尽：两个 integration 分片各最多 3 个 worker，加上 others 的 1 个，同一台 8 vCPU 机器最多 7 个 worker；ADR 已承认这一点，代码没有跨成员的总量限制。属于已接受风险。
- 不可撤销操作：改动只涉及测试选择、报告复制和临时目录清理，没有不可逆操作。
- 规则/文档一致性：`upgradeSplitTests` 在 `resolvePolicySource` 升级链最外层生效，基准上的单成员写法能升级；`testsMembers`、workflow 矩阵、`validateMemberProjects` 三者一致。文档与代码不一致处见意见 2 和意见 4。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动只涉及 `.github/workflows/ci.yml`、`ci/*`、`scripts/ci/*`、`test/tooling/*`、`vitest.workspace.ts` 和文档/证据文件；没有改系统提示、工具定义、历史消息、遮盖或提示词目录。`ci/policy.json` 只被 CI 脚本和 `vitest.workspace.ts` 使用，在 `apps/`、`packages/` 中没有引用。因此模型请求仍然只由原有代码组装，追加规则和“每轮变化值放最后一条消息”的现状不受影响；本次改动既不追加也不修改模型请求。

2. **不会让同一段模型文本在不同请求里变成不同字节。** 模型请求路径未被触碰。CI 内部的分片选择对文件做了显式排序，成员数组和策略键顺序固定；但两份分片的候选集合来自各 runner 本地工作树，存在跨机器不一致的风险（意见 1），measure 路径的项目顺序也可能因并发而不同，这些都不进入模型请求。

3. **有对应自动检查，但有两个缺口。** policy 侧有 `[ADR-0275]` 的升级、缺失成员、重复下标、份数不符、项目无人跑/跑两次、分片成员多项目、非 tests 作业写拆分、workflow 矩阵不一致等反向用例；pipeline 侧有分片轮流分配、多跑文件失败、分片参数错误不启动等反向用例；aggregate 侧有成员缺失、多报项目；tooling 超时有 `test-timeout.test.mjs`。按代码检查，这些用例会抛出各自预期的错误。缺口是：全量空分片的失败没有直接通过 `runCheck` 的测试（意见 3）；三个 tests 成员加 measure 的组合没有测试，且当前逻辑会失败（意见 2）。

4. **逐个核对了两端，除 measure 外未发现新值被一端接受、另一端拒绝。** `testsMembers` 的键（`integration-1`、`integration-2`、`others`）从策略产生，进入 workflow 矩阵/输出、`CI_MATRIX`、`run-share` 名称与 output-key、`CheckResult.matrixKey`、`memberId`、evidence schema；`run-share` 两个正则和 schema 都接受连字符。`projects` 由策略产生，`validateMemberProjects` 限定了只能是 tests 项目且每个项目恰好有归属，`run.mjs`/`aggregate.mjs` 都按 `member.projects ?? check.projects` 使用。`shard` 由策略产生，schema 限定 `count>=2`、`index>=1`，`validateMemberProjects` 限定份数等于 owner 数且下标正好 1..N，`test.mjs` 再校验运行时入参。`evidence.schema.json` 的 11/12 与“活跃成员 11、非 required 全部成员 12”一致，且 `evidence.test.mjs:164-171` 有断言。`testTimeout: 30_000` 只作用于 tooling，`test-timeout.test.mjs` 已覆盖。唯一两端不一致的是 measure 结果的“全部项目”集合与 aggregate 的成员项目集合，见意见 2。
