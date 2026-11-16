结论基于增量 `6abd0009..0e939f70` 与全量 `dfd125ca..0e939f70` 的对照。增量本身改的几行文字没有发现新错；但上一轮第 2 条意见只改掉了部分位置，活跃计划里仍有把已删除检查/脚本当成现行入口的残留。

### 1. 中 — 活跃计划仍把已删除的 v0.2 coverage 脚本列为“新建”文件、把已删除的检查列为“验证”入口

文件:行：`docs/execution/plans/2026-08-26-v0.2-spec-suite-integration-plan.md:58`、`:68`、`:199`（同一文件 `:92`）

问题：这份计划 `status: active`。增量把 `:92` 的说明改成“清单和检查已于 2026-11-16 退役并删除”，但同一文件的其他现行段落没有同步：文件边界里仍要求新建已删除的脚本，验证清单里仍把已删除的检查当成验证入口。读者按计划操作会创建/运行不存在的东西，文档自相矛盾。`check:docs-links` 只查 Markdown 链接，`check:instruction-links` 只查 `.agents/instructions`，这类纯文本列表项不会被任何自动检查拦下。

证据（我读到的原文）：
- `:58` `- scripts/check-v0.2-coverage.mjs`（位于“## 文件边界 / ### 新建”）
- `:68` `- package.json、vitest.workspace.ts 和 scripts/check-boundaries.mjs：增加可重复的 coverage、journey 与 qualification 测试入口。`
- `:199` `- 由 Task 1 新增的 v0.2 coverage check`（位于“## 验证”）
- `:92` `...（这份清单和读它的 check:v0.2-coverage 已于 2026-11-16 退役并删除）...`

建议：把 `:58` 删除或标注“已于 2026-11-16 删除”，把 `:68`、`:199` 改成“原……、已退役”；若这份计划已全部完成，标注为归档或历史记录，而不是现行验证清单。

### 2. 低 — CI 门禁计划的 N01 证据仍把“需求映射”算在负向验证里，与已更新的 CI-A06 不一致

文件:行：`docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md:408`、`:430`（对照 `:253` 与 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:82`）

问题：Spec 已明确 CI-A06 不再包含需求映射检查，但同目录的活跃 Plan 仍把 N01 的通过证据写成包含“需求映射”的 12 次正反执行，并把 CI-A06 映射到 N01。这更像一条历史运行记录，不是现行门禁要求；但它放在 `status: active` 的验收映射表里，容易被后续门禁复核当成 N01 仍然覆盖需求映射。

证据：
- Plan `:253` 对 N01 的定义是 `格式/类型错误、Pi 越界 import、SOURCE 断链`，本来就不含需求映射。
- Plan `:408` `真实静态负例 | 格式、类型、Pi 依赖方向、SOURCE 和需求映射的 12 次正反工具执行均得到预期退出码`
- Plan `:430` `| CI-A06 | ... | 现有 checks、固定治理 validator 和 N01 | ... N01 的 12 次真实正反工具执行有效 |`
- Spec `:82` `| CI-A06 | ...（需求映射检查已于 2026-11-16 退役，不再属于本条） | ... |`

建议：按“历史证据不改”的原则保留原记录，但在 N01 定义或 CI-A06 映射处加一句“需求映射部分已于 2026-11-16 退役，不再是 CI-A06/N01 的现行范围”，避免把历史结果读成现行能力。

---

**读代码证实的**

- 被删脚本确实只读文档：`scripts/check-v0.2-coverage.mjs`（基线提交）只导入 `createHash`、`readFile`、`readdir`，读 `coverage-manifest.json`、PRD、S0 覆盖来源和计划/规格，没有网络、写入或产品代码读取。
- 仓库代码里已没有该检查的引用：对 `scripts/`、`test/`、`ci/`、`.github/`、`packages/`、`apps/`、`clients/`、`evals/` 搜索 `check:v0.2-coverage|check-v0.2-coverage|coverage-manifest|v0.2-coverage`，除文档与归档外无命中；`.github/workflows/*.yml` 也没有显式执行它。
- `check:steps` 删除一项后仍符合解析规则：`scripts/run-all-checks.mjs:7-11` 以 `" && "` 切分并用 `^npm run (\S+)$` 校验，当前剩余每一项都符合。
- 反向结构检查存在：`test/tooling/run-all-checks.test.mjs:74` 对 `check:steps` 里每个名字断言 `package.json` 有同名脚本；若只删脚本不删步骤，这条会失败。
- `check:v0.2-invariants` 没有依赖被删清单：`scripts/check-v0.2-invariants.mjs:7` 读的是仍存在的 `test/fixtures/v0.2/security-invariants.json`。
- 没有产品代码加载 `.agents/instructions`：在 `packages/`、`apps/` 搜索该路径无命中，因此本次指令文档改动不进入产品模型请求。
- 删除的测试文件没有被 CI 注册或基线点名：`ci/policy.json`、`ci/test-hygiene-baseline.json` 中没有该文件；`ci/test-hygiene-baseline.json` 只列了不含它的具体条目。
- `document-governance.md` 删句后上下文通顺，`.agents/instructions/` 里已无 `v0.2`/`coverage-manifest`/`check:v0.2-coverage` 的命中。
- gitleaks 没有整目录排除 `.agents/reviews`，只按具体文件加白名单；新增复核记录仍在扫描范围内。

**推测或未核实**

- 无法运行 `npm run check`、`check:glossary`、`check:instruction-links`，上述“仍能通过”是读代码推断，未实际执行。
- 本轮新增的 `.agents/reviews/pr-605/*` 在当前工作区不可读（读取被 git 包装器以 `REVIEW_GIT_REFUSED records-path` 拒绝，`git diff --stat` 显示为 `Bin`），其 JSONL 字段是否能让 `scripts/model-review/review-speed-report.mjs` 正常解析未核实。
- 第 2 条意见中 Plan `:408` 记录的是过去一次执行的证据，是否允许原样保留为历史记录属于文档治理判断，我倾向“加注即可”，不要求改写历史结果。

**侧重检查**

- 错误路径：删除步骤后 `stepNames` 的抛错条件（出现非 `npm run <name>` 项）没有被触发；`runAllChecks` 仍是逐项执行并汇总失败，未新增吞错路径。
- 不合规范/不可信输入：本次没有新增解析外部输入的代码；被删脚本的参数解析随之消失。
- 安全：未引入密钥或新的外部输入；删除只读文档检查减少执行面；新增复核记录仍受 gitleaks 覆盖。
- 资源耗尽：删除检查和测试只会减少工作量和文件数，没有新增循环、下载或缓存。
- 不可撤销操作：只是 git 中删除文件/配置项，可回退；没有运行时数据删除或迁移。
- 规则文件、说明文档与代码一致性：发现上述两处现行/历史入口残留；作者说法 1、2、3 在被查范围内均成立。

**必答问题**

1. 不涉及。改动只删开发期文档检查、删测试/夹具、改指令文档和计划文字，没有动系统提示、工具定义、历史消息、遮盖或请求组装代码；被删脚本只读文档，`.agents/instructions` 也不被产品代码加载。因此“发给模型的内容仍然只在末尾追加、每轮变化值仍在最后一条消息”这一性质没有被本次改动改变。
2. 不涉及。没有改遮盖逻辑、时间字段、集合顺序或序列化；新增的 `usage.jsonl` 等复核记录是静态仓库数据，不会进入模型请求。
3. 有一项结构检查：`check:check-runner` 的反向用例（`run-all-checks.test.mjs:74`）会在“`check:steps` 还留着已删脚本”时失败。但没有自动检查会拦住活跃文档继续引用已删命令/清单，所以第 1 条的两处残留不会让 CI 失败；被删检查自身的负向测试也随文件删除，没有替代。未实际运行测试。
4. 逐个核对：`package.json` 的 `check:steps` 使用端是 `scripts/run-all-checks.mjs` 和 `test/tooling/run-all-checks.test.mjs`，两端都能接受剩余步骤；被删的 `check:v0.2-coverage` 脚本键和 `coverage-manifest.json` 在代码中已无使用端；删除的测试没有被 `ci/policy.json` 或测试卫生基线点名。唯一遗留的“使用端”是文档：`docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md:234` 仍写 `npm run check:v0.2-coverage`，但它在归档目录，按本次约束属于历史记录，可不改；活跃计划里的残留见第 1 条。
