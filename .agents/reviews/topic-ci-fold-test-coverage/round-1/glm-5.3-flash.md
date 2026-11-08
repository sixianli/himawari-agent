# 复核结论（按严重度排列）

## 证实的

**1.【高】删除两个作业会让出包证据导出静默撞上 schema 上限，方案没改这个文件**
- `ci/evidence.schema.json:136-139`：`"checks": { ..., "minItems": 10, "maxItems": 12 }`。当前活跃成员恰好 10 个（policy、static、build/linux、test/linux、node-floor、browser×3、coverage、security）。去掉 test、node-floor 后 push 运行的 report 信封只有 8 个，`exportEvidence` 的 Ajv 校验（`scripts/ci/export-evidence.mjs:172-176` 收集、`:185-188` 校验）会以 `CI_HANDOFF_SCHEMA` 失败，直接卡住交付链的 CI 证据导出。这是 `I-73` 那类问题：改了清单，没问“每个使用端吃不吃得下新值”。
- 建议：把 minItems/maxItems 和“非 required 且非 paused 成员数”挂上一致性断言并加反向用例；或者这次一并把两个界改成 8/10。

**2.【高】`ci/policy.schema.json:104` 的 `"minItems": 9` 也要改成 7，方案遗漏**
- `scripts/ci/contracts.mjs:26` 把这份 schema 编译成 `CheckPolicy` 校验器；`check-policy.mjs:119` 先过 schema 再过 validatePolicy。删了两个作业但不改 schema，会在 policy 作业早期红掉。好在是 fail closed，不会悄悄放过，但方案 checklist 应补上。

**3.【高】“coverage 缺 e2e/pi-compat 被拒”这条验证依赖方案没列的一批 validatePolicy 改动**
- `check-policy.mjs` 里至少还有：`expectedNeeds` 的 `"test"`、`"node-floor"` 条目（`:185-192`）、`requiredProjects` 的 `["test","node-floor"].includes(...)` 分支（`:204-213`，coverage 的期望值现在来自 `coverage-"model".mjs:33` 的四项 `coverageProjects`，必须改成六个）、`requiredKeys` 的 `["build","test"]`（`:214`）、以及 `verifyToolchain`（`:1060,1070`）。方案 step 1/2 只点名了 jobIds、chromium、超时。漏掉任何一个，提议 policy 都过不了自己的校验——同样 fail closed，但说明方案清单不完整。

**4.【中】JUnit 证据会消失，且没有门拦**
- test 作业每项目产出 `*.json + junit + log`（`test.mjs:57-77,122-125`），policy 里 test 的 outputs 含 junit（`ci/policy.json:84`）。合并后 coverage 分支只产一张 `tests.json`（`run.mjs:290,306-336`），unit/contracts/integration/tooling 的 junit 从此无人产出。汇总门只有当 outputs 里声明 junit 时才检查（`aggregate.mjs:154-156`），所以不声明就不报错——这是“静默降级”。
- 建议：给 coverage 那次 vitest 调用加 `--reporter=junit`（一张覆盖四项目的 junit 文件即可），或者明确接受丢弃并在新 ADR 里记一笔。

**5.【中】`engines >=22.22.3` 有四个方案没接住的值**
- `scripts/package-node-runtime.mjs:278`：随运行时包发布的 `runtime-manifest.json` 写死 `nodeMinimum: "22.19.0"`，和 engines 直接矛盾；`verify-artifact.mjs:170-176` 只比对 entrypoints/依赖闭包，不校验 nodeMinimum，没有任何门会拦这个不一致。建议同步改成 22.22.3，并顺手加一条“manifest.nodeMinimum 必须等于 engines 声明”的检查。
- `scripts/ci/install-dependencies.mjs:292` 引用 `lock.node.floor`；删 floor 后此处变 undefined 比较（不炸但不干净），应清理。
- `package-lock.json:29` 根节点的 `"node": ">=22.19.0"` 需要重新 `npm install` 再生成。
- `scripts/ci/local.mjs:107` pending 清单里还写着 "Linux Node floor"。
- 引擎语义：npm 官方文档（https://docs.npmjs.com/cli/v11/configuring-npm/package-json#engines ）写明 engines 默认只警告，配 `engine-strict: true` 才硬失败；仓库没有 `.npmrc`（grep engine-strict 无结果），开发机不会因此装不上依赖，媒体上影响最小的是“声明变化”。注意这是把产品支持下限从 Pi 最低版 22.19.0 升到 22.22.3 的**支持面决策**（`docs/archive/plans/2026-08-25-agent-foundation-plan.md:90` 的初衷），应在 ADR 里明说，不能只在 CI 方案里顺带；生产不受影响（`prepare-runtime-tools.py:66` 只收 v22.22.3）。

**6.【中】方案前提 5 有错：coverage 作业其实已经核对文件集合**
- `scripts/ci/check-coverage.mjs:405-409`：`collectTestSources`（从 `apps/packages/test` 盘上枚举，`:98`）与报告文件集合相等，不等报 "coverage test file inventory is incomplete"；`:380-383` 还认多余文件。所以“覆盖率调用补上 test 作业的文件集合核对”大部分是冗余的（保留作双保险可以）；这台作业四项目的文件集合同等性**已经存在**。真正需要反向用例的是 `test.mjs:101-112`（`CI_TEST_FILE_SET_MISMATCH`）在 e2e/pi-compat 上仍然生效。
- 同时注意 `run.mjs:327` 和 `:340-349` 的子集循环用 `check.projects`；`check-coverage.mjs:361-362` 硬编码四项目。改动必须让覆盖调用只筛四个、让 e2e/pi-compat 结果绕过这两处进 `result.projects`——方案 step 2 已经朝这个方向，但没点名这两处硬编码，落实时容易踩。

**7.【低】方案细节勘误**
- macOS 暂停的决定来自 ADR 0160 第 3 条（`docs/adr/0160-self-hosted-runner-on-hermes.md:66`），ADR 0176 只是继承（`:91`）。
- 文档同步清单漏了 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:320`（历史叙述里还列着 node-floor 时限）和 `docs/execution/specs/2026-09-07-srt-unified-execution-design.md:520`（`>=22.19.0` 表述；历史文档可标注修订）。
- `aggregate.mjs:105-107` ABI 127 注释里提到 floor，属应清理的旁支。

**8.【作者之一部分的问】再现确认**：coverage 调用 `--maxWorkers 2`（`run.mjs:329`）不会压低 integration：`vitest.workspace.ts` 里 integration 的项目级 maxWorkers 被强制等于 `testWorkerCount`（`check-policy.mjs:1142-1147` 断言），项目配置优先于根级。不会出现 3→2。

**9.【方案作者问】基准升级函数会不会放走削弱检查的 PR**：单看 fold 本身不会——它只对“和 main 恰好同形的 9 作业策略”生效，输出固定为现提议的等价物，其余形状原样拒。但注意有限信任模型：`check-policy.mjs` 是 PR 自带代码，PR 本可改 validateWorker 逻辑，这条通路自古就有，fold 未新增。可以更强：`resolvePolicySource` 已有 `policySha256`（`check-policy.mjs:1054`），fold 改为“基准 policy 字节摘要 == 现 main 的摘要才折叠”，一行 digest lesser 误差即拒，比逐字段比对更简单且更强。

## 推测（未验证但风险值得记）

**10.【推测】** coverage 作业预算：现在是 60 分钟×32.6 分钟，加 e2e（3 文件）+pi-compat（130 文件）估计 5 分钟级；但如果 pi-compat 在某些 PR 上显著慢（兼容测试常拉真实 Pi 包），不设是风险敞口。保留 60 分钟可以接受，但从 test 作业的 90 分钟继承而来的是“整作业含最慢项目”的旧预算，六项目在 coverage 的结算里 e2e/pi-compat 之前 (覆盖调用 32.6) 已占三分之二；建议第一次真实运行后把实测写回 ADR。

## 侧重检查

**一条普通流程的走查**：PR → `ci.yml` 7 作业 → `run.mjs` coverage 作业（下载安装包 → 覆盖调用 4 项目+check-coverage 门 → runTests 式 e2e/pi-compat → 报告/上传）→ `required`/`aggregate` 按策略核对 → push → `verifyMainEvidence`+`main-confirm` → `exportEvidence` → 出包验收（`prepare-runtime-tools.py`）。走查发现没有测试覆盖的路径就是上面 #1（exportEvidence 的 schema 上限）和 #4（junit 输出消失无门拦）；其余被 fail-closed 的门（policy.schema、chromium 名单、timeoutMinutesFor、toolchain-lock 契约断言 `install-tools.mjs:86`）都能在 policy 作业里把遗漏红出来。测试层面：`test/tooling/policy.test.mjs:514,698,750`、`runner-orchestration.test.mjs:697`、`aggregate.test.mjs:16` 都引用旧作业串名，须按“现有用例改”处理——方案已列，但注意加上“coverage 六项 vs 覆盖策略四项”过时联测的反向用例（删 e2e 必须被失联拒）。

## 必答问题

1. **请求开头**：不适用也不违反。方案不改任何组装模型请求的代码（系统提示/工具/历史/遮盖都在 packages/、apps/，未被触碰），只改 CI 编排；I-82 的字节比对用例（PR-A/PR-B）仍随 integration 项目在 coverage 作业里跑。不是追加性问题域。
2. **字节确定性**：与模型请求无关；CI 侧的确定性锚点（coverage 基线 digest、policySha256、集合排序断言 aggregate.mjs:111）不受影响，未引入新的时变值或依赖遍历顺序的序列化。
3. **自动检查**：主要错误模式是 fail-closed（schema、validatePolicy、lock 契约会把上面的遗漏红出来），但 junit 丢失（#4）和 evidence 上限（#1）一个无门拦、一个会在很晚的交付阶段才拦；方案的反向用例清单需补：fold 换成 digest 锁定后的非本基准拒绝、evidence/policy schema 界限与作业数联动的一致性用例。
4. **每个值的两侧**：见 #1-#5——`policy.schema.json`（译过 schema 的 `CheckPolicy`）、`evidence.schema.json minItems`、`engines↔`nodeMinimum`↔lock`↔`install-dependencies`、junit 产出端与 aggregate 消费端，方案各漏了一到两处；核对两个 echo 都不被漏掉才能动手。

## 如果由我来定

采纳骨架（删 node-floor、test 并入 coverage、coverage-policy 保持四项、fold 过闸门），但补六件事：(a) policy.schema/evidence.schema 两处界限与作业数联动并带反向用例；(b) fold 直接用基准 policy 字节摘要判定旧形状；(c) coverage 调用补 junit，或在 ADR 里明写接受丢失；(d) engines 联动 nodeMinimum、package-lock、install-dependencies:292，并加“manifest.nodeMinimum = engines”门；(e) 在新 ADR 里把“放弃 Node 22.19.0–22.21 兼容”记为独立的产品支持决策，而不只是 CI 优化；(f) 改完在真实 PR 上跑完整 CI 后把 coverage 实测耗时写回 ADR 再收口 60 分钟时限。
