## 结论

高、中严重度问题：未发现。增量改动（把 `.agents/reviews/` 加入 `HISTORICAL`、补测试、改 ADR）与第 3 轮说明基本一致，没有发现会让运行时版本号漏检的当前路径。下面两条是低严重度问题。

### 1. 低：ADR 对 `.agents/reviews/` 的例外理由不准确

- 位置：`docs/adr/0156-srt-0-0-81-with-a-locked-seccomp-helper.md:38`
- 问题：例外理由写成“模型复核记录，逐字保存模型的原话和提示词，事后不能改”。但这个目录里同时有线程每轮写入、追加的文件：`briefs/`、`judgments.md`、`usage.jsonl`、`verdicts.jsonl`。它们不是“事后不能改”的模型原话；本 PR 自己的 `git diff 9bfffd19..8b1abc0e` 就新增了 `briefs/brief-round4.md`，并修改了 `usage.jsonl`。
- 证据：
  - ADR 原文：`docs/adr/0156-srt-0-0-81-with-a-locked-seccomp-helper.md:38`：“`.agents/reviews/`（模型复核记录，逐字保存模型的原话和提示词，事后不能改）”
  - `.agents/instructions/model-review.md:127`：“线程在合并前把记录目录随 PR 一起提交。”
  - `.agents/instructions/model-review.md:165`：“把材料写进 `.agents/reviews/<目录>/briefs/…`”
  - 本轮 diff 中 `.agents/reviews/pr-439/usage.jsonl` 被修改、`briefs/brief-round4.md` 新增。
- 建议：把理由改成“复核记录目录（含模型原话、提示词存档、逐条判断、账本和材料），其中的版本号是历史引用，不作为运行时版本来源”，不要声称整个目录不可改。

### 2. 低：例外清单仍靠脚本和 ADR 两处手工同步，没有自动一致性检查

- 位置：`scripts/check-srt-version.mjs:6-12`、`docs/adr/0156-srt-0-0-81-with-a-locked-seccomp-helper.md:38`
- 问题：这次脚本和 ADR 都加了 `.agents/reviews/`，两边一致；但没有任何测试比对“脚本的 `HISTORICAL`”和“ADR 列举的例外”。以后任一处漏改，现有测试不会发现。新增的反向用例只覆盖 `.agents/reviews/` 被排除、`.agents/instructions/` 仍被检查，不覆盖 `docs/`、`test/qualification/evidence/`、两个模板目录以及 ADR 清单的一致性。
- 证据：
  - `scripts/check-srt-version.mjs:6-12`：`const HISTORICAL = [".agents/reviews/", "docs/", "test/qualification/evidence/", …]`
  - `scripts/check-srt-version.mjs:117`：`.filter((file) => !HISTORICAL.some((prefix) => file.startsWith(prefix)))`
  - `test/tooling/srt-version.test.mjs:141-147` 只验证 `.agents/instructions/` 仍被查；`:168-180` 只验证列入的三个历史路径被跳过。
- 建议：让测试从单一清单生成断言，或至少加一条测试，把脚本的 `HISTORICAL` 与 ADR 中列举的例外逐项对照；这样 ADR 和代码不会悄悄漂移。

## 读代码证实的

- `HISTORICAL` 的匹配是 `file.startsWith(prefix)`，`.agents/reviews/` 带结尾斜杠，不会误排 `.agents/reviewsX/...`；也不会误排 `.agents/instructions/...`。已读 `scripts/check-srt-version.mjs:6-12,114-118`。
- 新增的反向用例在逻辑上确实会失败：fixture 里的 `the test wrote srt:0.0.75-other` 会命中 `\bsrt:(?<version>\d+\.\d+\.\d+)`，版本 `0.0.75` 不等于 fixture 的 `0.0.81`，从而产生 `SRT_VERSION_STALE`。已读脚本 `:56-70,133-139` 和测试 `:168-180`。
- 新增的 `.agents/instructions/sandbox.md` 用例，如果以后把排除项从 `.agents/reviews/` 放宽成 `.agents/`，会失败，能挡住这种过度排除。已读测试 `:141-147`。
- 脚本与 ADR 当前列举的例外集合一致：`.agents/reviews/`、`docs/`、`test/qualification/evidence/`、`basis-04/`、`probe-source/`；冻结脚本另由 `RELEASE_FROZEN` 单独校验。已读脚本 `:6-54,119-126` 与 ADR `:38`。
- `.agents/` 下除复核目录外的文件没有被这次豁免；grep `.agents` 的结果里，运行时路径只在 `scripts/check-glossary.mjs`、`check-instruction-links.mjs`、`scripts/model-review/*`、`.agents/opencode-models.*` 等开发/检查脚本中出现，没有生产运行时读取。
- 全量 diff 里的沙箱资格代码没有进入提示词组装路径：改动只在 `packages/application`、`packages/execution-contracts`、`packages/platform-node` 的资格校验和测试，没有改系统提示、工具定义或历史消息的组装代码。
- 新增的两个辅助函数 `sandboxEnforcementClaimsMatchEvidence`、`sandboxRequiredControlsEnforced` 由 `packages/execution-contracts/src/index.ts:17` 导出；两个使用方 `capability-deployment.ts:584-610` 和 `capability-lifecycle-service.ts:766-777` 传入的 enforcement 都是同样的六个布尔字段，形状一致。

## 推测（未完全证实）

- `parseQualification` 在 `capability-deployment.ts:589` 把未经 `text()` 校验的 `input["runtimeIdentity"]` 传给新函数，而真正的 `text()` 校验在 `:632`。结果是：`runtimeIdentity` 类型错误时，会先以“sandbox evidence conflicts with enforcement claims”报错，而不是报 `runtimeIdentity` 字段错误。旧代码同样用原始值做 `!==` 比较，所以这不是本次引入的行为退化，只是错误信息不够精确。
- 如果未来有人把真正可执行或被运行时读取的文件放进 `.agents/reviews/`，目录级豁免会让它避开版本检查。当前代码里没有这样的读取方，所以目前只是残余风险，不是已发生的问题。
- 我无法读到 `.agents/reviews/pr-439/round-3/` 里的实际记录来逐字核对旧字面量：当前是 sparse checkout，且 git 替身拒绝访问 records 路径；因此“第 3 轮记录确实包含 `srt:0.0.75…`”这一点属于未核实，只按作者说明和 fixture 的形状判断。

## 侧重检查

- **错误路径**：`sandboxEnforcementClaimsMatchEvidence` 对非法 evidence 捕获 `ContractValidationError` 并返回 `false`（`sandbox-qualification-v1.ts:110-116`）；非该类型的异常会继续抛出。输入来自 `structuredClone` 的普通对象或 JSON 解析结果，出现 getter/Proxy 一类异常的现实性低。
- **不合规范/不可信输入**：snapshot 里的 `sandbox` 先由 `sandboxRuntimeQualificationSchema.parse` 校验（`capability-deployment.ts:580-583`），生命周期路径再由新函数重新 parse（`sandbox-qualification-v1.ts:112`），因此不能靠伪造 `runtimeIdentity` 或旧 `srtVersion` 绕过。
- **安全**：目录豁免只影响静态版本检查，不影响运行时；grep 未发现生产代码读取 `.agents/reviews/`。
- **资源耗尽**：脚本仍然对 `git ls-files` 的每个已跟踪文件读全文，复杂度是既有的；新测试创建临时目录并在 `afterEach` 删除，没有新增无限循环或未清理资源。
- **不可撤销操作**：本增量没有删除、覆盖生产配置或回滚类操作；新增文件都是 git 记录和测试 fixture。
- **规则/文档一致性**：脚本与 ADR 的例外集合当前一致；发现上面第 1 条的措辞不准确，以及第 2 条缺少自动同步检查。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。增量只改 `scripts/check-srt-version.mjs`、`test/tooling/srt-version.test.mjs`、ADR 和复核记录；全量 diff 的其余代码也只涉及能力资格校验，不涉及系统提示、工具定义或历史消息组装。没有新增会插入请求开头的内容，发给模型的内容仍只在末尾追加，每轮变化的值仍在最后一条消息里。复核记录本身在复核副本中整个 `.agents/reviews/` 被 sparse checkout 去掉（`.agents/instructions/model-review.md:128`），也不会进入复核模型请求的开头。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。改动不涉及遮盖、时间字段、序列化或无序集合；`HISTORICAL` 是固定数组，新增的 `.agents/reviews/` 只是静态过滤条件，不参与任何请求内容生成。
3. **有没有对应的自动检查，反向用例会不会失败？** 有。`test/tooling/srt-version.test.mjs` 新增了 `.agents/instructions/` 仍被检查的用例，并在“历史证据不查”的 fixture 中加入 `.agents/reviews/` 路径。按代码逻辑，去掉 `HISTORICAL` 中的 `.agents/reviews/` 后，`srt:0.0.75-other` 会被识别为 stale，该用例会失败；把排除放宽成 `.agents/` 则新增的 instructions 用例会失败。我本人未运行测试；“已实际运行”来自作者说明，未核实。另需注意：在复核用的 sparse checkout 中 `.agents/reviews/` 文件不在磁盘上，仓库级用例会因脚本的 `existsSync` 跳过它们，真正覆盖豁免的是 fixture 用例。
4. **新增/修改的每个值，使用方都能接受吗？** 本次增量新增的值只有 `HISTORICAL` 里的字符串 `".agents/reviews/"`。产生它的地方是 `scripts/check-srt-version.mjs:6-12`，唯一使用方是同一文件的 `srtVersionProblems`，通过 `startsWith` 匹配（`:117`），语义是“路径前缀”，与 `.agents/reviews/pr-439/round-3/...` 这类实际路径兼容；测试 fixture 也按同样路径前缀验证。ADR `:38` 记录的例外项与脚本一致。全量 diff 新增的两个辅助函数由 `index.ts:17` 导出，两个调用点传入的字段与接口定义一致；未发现两端校验形状不一致。
