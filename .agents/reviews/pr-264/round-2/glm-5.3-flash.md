# 复核报告（dacfff49，对照基准 ba915c2，增量相对 6269e972）

## 按严重度排列的问题

**1. 低 ｜ test/tooling/policy.test.mjs:697-710 ｜ 新用例没有锁住“policySha256 按基准原始字节计算”这一不变量。**
证据：`scripts/ci/check-policy.mjs:1026` 返回 `policySha256: sha256(bytes)`，`bytes` 在 989-991 行取自基准提交的原始文本，升级（993 行 `upgradeArtifactRetention(upgradeHostedRunnerPolicy(JSON.parse(bytes)))`）只改内存对象，摘要不受影响。下游 `aggregate.mjs:287`、`check-coverage.mjs:526`、`export-evidence.mjs:115` 都靠 `source.policySha256 === context.policySha256` 两端一致；`context.mjs:142` 记录的是同一表达式的值，所以一致。但旧的托管 runner 升级测试有对应的摘要断言（policy.test.mjs:694 `expect(selected.policySha256).toBe(sha256(JSON.stringify(hosted)))`），本次新增的 30/7 升级用例只断言了 `policy` 深相等，没有断言 `policySha256`。将来有人改成“先升级再算摘要”也不会被这个新测试抓到。
建议：在该用例里补一条 `expect(resolvePolicySource({ root }).policySha256).toBe(sha256(rawBytes))` 类的断言。

**2. 低 ｜ scripts/ci/check-policy.mjs:74-83 ｜ “做法照搬已有的 `upgradeHostedRunnerPolicy`”与实现细节不完全一致，且该函数只有间接测试。**
证据：`upgradeHostedRunnerPolicy`（53-72 行）先 `structuredClone` 再深改；`upgradeArtifactRetention` 用浅 spread 并新建 `retentionDays` 对象。行为安全（后续 1000-1015 行的嵌套改动落在这份浅拷贝的对象图上，`bytes` 是字符串、1026 行才取摘要，无别名问题），但“照搬”的说法不准确，且全仓只有 `check-policy.mjs:993` 一处使用（grep 证实），没有直接针对该函数的单测（例如“多出一个键就不升级”的键数反例没有覆盖）。
建议：说法可以改成“仿照”；如想锁死键数行为，可加一个 `{reports:30, diagnostics:7, extra:1}` 被拒的反例。

**3. 低 ｜ scripts/ci/export-evidence.mjs:110,161 ｜ 过期边界从 30 天变成 1 天，但既有用例只验证“31 天后过期”的方向，没有专门断言 1 天这个新值。**
证据：`test/tooling/evidence.test.mjs:199` 用 `now + 31 * 86_400_000` 让 `CI_HANDOFF_EVIDENCE_EXPIRED` 触发——在旧值（30 天）和新值（1 天）下它都会通过，因此它对“改成 1 天”不敏感；正向用例（默认 `now`）也不区分保留天数。1 天这个值本身目前只靠 `quality-policy.mjs:44` 的 `constant({reports:1,diagnostics:1})` 间接约束。
建议：在 evidence 测试里加一条“created 后约半天可用、满 1 天过期”的边界用例。

**4. 信息 ｜ 作者说明/ADR 0174 决定 5 ｜ 两处外部断言未核实。**
（a）“本 PR 自己的 CI 和合并后第一次 main 推送时，基准上还是 30/7”——这是对 GitHub 上分支/基准状态的断言，本环境无法核实；与代码逻辑一致，且 6269e972 的提交说明记录了“提交前 check:ci-policy 从 HEAD 读到旧策略（30/7）被新 schema 拒绝”的实跑侧面印证。（b）作者说“不升级就会在每个 job 创建 Context 时失败”：措辞不精确——ci.yml 的每个 job 是在 `run.mjs:86` 解析策略，只有 quality.yml 的 brands job（quality.yml:119）经 `context.mjs` 真正生成 Context 文件；失败点一样，表述不同。
（c）作者与 ADR 称“做法照搬”见问题 2。

**5. 信息 ｜ ci.yml 各上传步骤 ｜ `retention-days: 1` 的唯一防线是 ci-optimization 测试，不是策略校验器。**
证据：`check-policy.mjs` 的 `validateWorkflow` 不比对 retention（scripts 目录 grep `retention-days` 只出现在 quality-policy.mjs 和 export-evidence.mjs）；三个工作流共 30 处 `retention-days: 1`（grep 证实）由 `ci-optimization.test.mjs:93-99` 断言 `toBe(1)`，quality.yml 那部分另受 `quality-policy.mjs:154/161/210` 期望构造的精确比对。与 ADR 决定 4 的分工一致，属设计选择，但值得知道 ci.yml 上传步骤的守卫只有测试一道。

**未核实（推测/无法在本环境验证）**：Hermes 实跑记录（红例“只加测试时失败”我按代码推理支持：旧代码下基准 30/7 会先在 `validatePolicy` 处被 schema `const:1`（ci/policy.schema.json:189）拒绝，`expect(...).policy` 那行直接抛错，红例成立）；801 个 artifact 删除；“正常 PR 13 job 通过”等历史 CI 数据。

## 侧重检查

普通使用流程走查（PR 校验）：推送 PR → 托管 CI 三个 job 安装固定工具，`install-tools.mjs:118-129` 校验锁文件 Action 清单（现为 5 个，`actions/cache` 已删，`toolchain.test.mjs` 期望长度 5 一致）→ policy job `run.mjs --check policy --base "$CI_BASE"`（ci.yml:53）→ `run.mjs:86` `resolvePolicySource`：基准 30/7 被升级到 1/1 后过当前 schema → 检查报告（内嵌同一 `context`）→ `required.mjs:20` 建 gate → `aggregate.mjs:287` 二次 `resolvePolicySource` 比较 `policySha256`（两端都按基准原始字节）→ 上传 artifact（retention 1 天）→ push 交接时 `export-evidence.mjs:110` 按 1 天判过期、161 行写入 `expiresAt`。

覆盖结论：该流程的核心改动点（`resolvePolicySource` 升级、schema、ci-optimization、toolchain 锁）都有自动测试；**没有测试覆盖**的路径是：export-evidence 的 1 天过期边界（问题 3）、`upgradeArtifactRetention` 的键数边界（问题 2），以及端到端 CI 本身（工作流停用、新 CI 服务器未装，ADR 自己已声明，属环境性未覆盖，非本次改动引入）。

## 文档与代码一致性（读代码证实）

- ADR 0174 后果引 CI 计划“冷缓存 120.6 秒、热缓存 77.9 秒”：计划文件 400 行实为 120.588/77.893 秒，四舍五入成立；“完整 CI 有 9 个任务”与 `check-policy.mjs:107`（nine required jobs）一致。
- architecture-v0.1.md:639、设计 spec 295/320 行的改动与代码（1 天、无缓存）一致；`get adr 0173` 等引用目标文件存在。
- 移除 comment（quality-policy.mjs 原注释行）与命令说明主要的 2 个提交相符，并已记录。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。diff 只触及 `ci/` 配置、schema、`scripts/ci/`、`test/tooling/`、`docs/` 和工具锁定——未触及任何提示词、工具定义、历史消息或遮盖代码（packages/、apps/ 一字未动）。本次改动不组装模型请求，“只追加”（[prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules)）不适用；也不存在“每轮会变的值”需要挪到最后。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增/修改值全是常量 1；`upgradeArtifactRetention` 的输出只依赖基准提交的原始字节（解析→判 30/7→生成 `{1,1}`），同样输入产生同样对象，无时间、无遍历顺序、无遮盖依赖；`policySha256` 仍按基准原始字节计算（check-policy.mjs:1026），Context 两端的摘要比对（aggregate/check-coverage/export-evidence/context 四处）读到的是同一份字节，一致。读代码证实，未发现反向用例。
3. **有没有对应的自动检查，反例会不会真的失败？** 有。policy.test.mjs:697-710 正例（30/7→等于当前策略，因为基准和当前在其他字段上同源）和反例（14/7 抛含 "retentionDays" 的 ajv 错误，`contracts.mjs:34-43` 的 `errorsText` 会带 `data/retentionDays/...` 路径）；ci-optimization.test.mjs:79-99 的 `usesGitHubCache` 正反用例覆盖 `actions/cache@`、`/restore`、`/save`，并有 "actions/cachet@x" 和 `undefined` 的负例，三个工作流的 filter 不得非空、所有 upload 必须 `retention-days === 1`。反例失败是代码推理成立；Hermes 实跑属作者记录，未核实（见问题 4a/4c 的未核实说明）。
4. **每个新值/改动的双端是否都接受？** 逐项核对如下，未发现 I-73 式“生产方给了、消费方校验拒绝”的问题：`retentionDays 1/1`（ci/policy.json）→ schema `const:1`（policy.schema.json:189,192）接受；`quality-policy retentionDays 1/1` → `quality-policy.mjs:44` constant 接受，且 154/161/210 行用它构造期望的 quality workflow 与实际 quality.yml（13 处 `retention-days: 1`，grep 证实）精确比对；workflows 的 `retention-days: 1` → ci-optimization 测试接受（问题 5 提及其唯一防线属性）；`toolchain-lock` 删 `actions/cache` → `install-tools.mjs:118-124` 期望集合 5 个、`toolchain.test.mjs` 长度 5，且工作流已无该 Action；`upgradeArtifactRetention` 只在 `resolvePolicySource` 内部使用，未进入任何序列化产物（Context、evidence、summary 均不含新字段）。全部读代码证实。
