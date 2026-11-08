## 复核结论（第 7 轮：achen 合并 origin/main 的 CI 工作流改动）

### 结论先行（读代码证实）

**合并一致性本身成立**：`git diff ce1bcbee..a22e487e -- .github/workflows/` 输出为空，即三个工作流文件（ci.yml、main.yml、quality.yml）在本分支上与 origin/main 的 ce1bcbee **逐字相同**；`git diff ddf64aaa..a22e487e` 的全部内容只有 `.github/workflows/*` 三个文件加 `.agents/reviews/pr-258/*` 复核记录，**没有混入任何 PR 相关文件**。作者对“main 只改了三个工作流、与本 PR 无交集”这一段的陈述证实。

但作者说“已知：check:ci-policy 在 origin/main 本身就失败”——这句话**证据属实但只说了一部分**，同一批工作流改动至少还让另一个测试也红了（见下第 2 条）。

---

### 按严重度排列

**1. 中｜`.github/workflows/quality.yml:55,63`（全部 upload-artifact 步骤）**
问题：retention-days 从 30/7 改成 1，与 ci/quality-policy.json 矛盾，check:ci-policy 必然失败。作者陈述属实、已自我披露；此处仅为证据核实。
证据：`ci/quality-policy.json:15` 仍是 `"retentionDays": { "reports": 30, "diagnostics": 7 }`；`scripts/ci/quality-policy.mjs:44` 把它做成 schema 常量 `{ reports: 30, diagnostics: 7 }`，并在 `:151-164` 期望 job 里逐字比对 retention；`:229-230` 的 `same(workflow?.jobs, expectedJobs, "jobs")` 抛出的正是作者引用的 `CI_QUALITY_WORKFLOW_MISMATCH:jobs`。反向用例 `test/tooling/quality-policy.test.mjs:259-264`（"long-lived diagnostics"：把 retention 改成 30 期望被拒）证明校验确实被强制执行。该检查由 CI 的 policy job 驱动（`.github/workflows/ci.yml:53` → `scripts/ci/run.mjs`，`run.mjs:237` 调起 `scripts/ci/check-policy.mjs`）。
建议：既然说“另一个线程处理”，那个线程若走“把 policy 改成 1”的方向，必须同时改 `ci/quality-policy.json:15`、`ci/policy.schema.json:183` 区域的 retentionDays 定义，并反转 `quality-policy.test.mjs:259-264` 这个用例；只改 workflow 字节改不平，check:ci-policy 会继续红。

**2. 中（新发现，作者未披露）｜`.github/workflows/ci.yml`（删除全部 actions/cache 步骤）**
问题：除 check:ci-policy 外，tooling 测试套件里还有一个测试**直接读取真实 ci.yml** 并断言每个 job 都有 `actions/cache@` 步骤，合并后必然失败（在 origin/main 上同样失败，非本 merge 新引入）。
证据：`test/tooling/ci-optimization.test.mjs:68-81`：`"完整 CI 使用缓存与最小汇总依赖，并保留全部检查"` 读取真实的 `readFileSync(".github/workflows/ci.yml")`，`for (const job of Object.values(workflow.jobs)) expect(job.steps.some((s) => s.uses?.startsWith("actions/cache@"))).toBe(true);` —— 而合并后的 ci.yml 已无任何 cache 步骤。该测试属于 tooling 项目，是 ci.yml policy job 的必跑项目（`scripts/ci/check-policy.mjs:177`：policy check 的 projects 必含 tooling）。
建议：另一线程在修 quality.yml/policy 时，必须同步改或删掉 `ci-optimization.test.mjs:80` 这个断言，否则 tooling 也长期红。

**3. 低｜`ci/toolchain-lock.json:144` 与 `scripts/ci/install-tools.mjs:117-129`**
问题：工作流已不再使用 actions/cache，但约束链仍然反方向强制它存在：`install-tools.mjs:126-129` 断言 lock 里的 Action 集合必须精确等于一个包含 `"actions/cache"` 的六元列表（`:118-125`）。这不会让本次红（lock 仍含该条目），但“另一线程移除 cache”若将来想清理 lock，必须同时改 `install-tools.mjs` 的 expectedActions、toolchain-lock.json 及其证据 URL； otherwise 会互锁。
推测部分：目前没有检查强制“lock 内 action 必须被工作流使用”，所以这是个遗留不一致，不报“会出错”。

**4. 低（推测，非本 merge 引入）｜`.github/workflows/ci.yml:534`（gate artifact retention 1）**
问题：`required` job 的 gate/report artifact 现在只留 1 天。`quality.yml` 的 handoff job 和 `main.yml` 的 confirm job 需要通过 `workflow_dispatch` 的 `ci_run_id` 去**别的 run** 下载 `gate/report-*` artifact。若 dispatch 发生在被引 run 完成 1 天之后，下载会失败（GitHub 官方最低保留 1 天）。仓库内没有任何校验捕捉“跨工作流引用 artifact 保留期不足”。是否实际构成风险取决于“handoff 永远当天发生”这个未写进代码的假设，属于推测，未核实另一个线程的处理思路是否覆盖此点。

---

### 侧重检查（我的侧重：测试覆盖、文档/规则一致性、普通流程走查）

我走的流程（普通使用流程：一次 PR 推送 → CI）：

1. PR push → `ci.yml:31-53` policy job：checkout（`:41`，锁 SHA）→ setup-node → `install-tools.mjs`（`:49`；其 `:117-130` 校验 Action 锁，含仍锁着的 cache，通过）→ `install-dependencies.mjs ... --cache .ci-output/npm-cache`（`:51`——cache 步骤删了但这个目录参数仍在，`scripts/ci/install-dependencies.mjs:303` 与 `README.md:61` 证实在未传/冷缓存下照常工作，不会因删 cache 步骤而坏）→ `run.mjs --check policy`。
2. `run.mjs:237` 调 `check-policy.mjs` main → `check-policy.mjs:1133-1137` 跑 `validateQualityWorkflow` → **在 quality.yml retention 上抛 mismatch，fail**。
3. run.mjs 同时执行 tooling 项目 vitest → **`ci-optimization.test.mjs:79-81` 在真实 ci.yml 上 fail**。
4. 对照项：`main.yml` 不受 validateMainWorkflow（`scripts/ci/main-workflow.mjs:1-99`）约束 retention/cache，其自身 test（`ci-optimization.test.mjs:84-109`）对当前 main.yml 文本仍通过——main.yml 的改动（retention+删 cache）恰好不触发任何校验，一致性靠人肉维持。
5. 测试覆盖结论：这次的改动有反向用例（quality-policy.test.mjs、policy.test.mjs:54-78）覆盖校验机制本身，但**真实文件漂移没人把它挡住**——恰恰因为两处校验/测试都红了，才说明“另一线程处理”的承诺成立；风险在于没人列出过 ci-optimization 这第二个红点。
6. 文档一致性：README.md:61 关于 `--cache .ci-output/npm-cache` 的描述与合并后的代码仍一致；未发现描述 cache 步骤本身的文档教条（未核实 docs 全量）。

### 必答问题

1. **模型请求前缀**：本轮增量（merge 带进的工作流文件 + `.agents` 复核记录）不涉及任何发模型的内容（无 prompt、遮盖、消息构造文件），前缀不变；对 round 6 之前已复核的改动我没有重查，不推翻前几轮结论。
2. **同一段文字不同字节**：三个工作流文件全部是静态 YAML（数值 retention-days、锁 SHA、固定命令），无时间字段、无依赖前后文的遮盖、无无序集合；本轮不引入确定性变化。
3. **自动检查与反向用例**：有——`check:ci-policy`（quality-policy.mjs:44/230）、`quality-policy.test.mjs:259-264`（改 30 期望被拒）、`ci-optimization.test.mjs:79-81`（要求 cache 存在）。核实结果是**反向用例为真且真实文件确实正中失败条件**：retention 1≠30 让 check:ci-policy 失败（证实作者说法），且 ci-optimization 测试也失败（作者未列出）。
4. **每个值的两端校验**：款逐项——retention-days:1（生产端=workflow，消费端=GitHub runtime；策略端在 quality.yml 不接受，已红）；删除 cache 步骤（消费端 `--cache` 参数仍在且冷缓存可行，README 一致）；actions/cache 锁条目（install-tools.mjs 恒等校验仍要求它，两端目前兼容）。未发现新校验缺口在工作流文件本身之外。
5. **未核实项**：另一个线程“怎么处理”（作者转述，仓库内无对应提交可证）；`main.yml` 的 plan/confirm 与 quality.yml 的 handoff 跨 run 下载在运行时受限的实际影响（需运行时观察，代码内无断言）。
