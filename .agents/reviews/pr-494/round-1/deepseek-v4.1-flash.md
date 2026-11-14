结论：这次改动里有 3 个会直接让 CI 或 `ci/required` 失败的问题，另有一处目标覆盖不完整。以下都按“生产路径”核对过，不是只看 diff。

### 1. 致命（P0）— `--cache runner` 在 CLI 里被解析成绝对路径，所有作业装依赖都会失败
- **文件:行**：`scripts/ci/install-dependencies.mjs:455`、`scripts/ci/install-dependencies.mjs:81`、`scripts/ci/install-dependencies.mjs:84`、`.github/workflows/ci.yml:53`（以及 94、144、211、259、306、347）、`.github/workflows/main.yml:67`
- **问题**：工作流传的是字面量 `--cache runner`，但 CLI 对所有参数统一做了 `resolve()`。进入 `installDependencies` 时 `cacheDirectory` 已经变成 `/仓库/runner`，`cacheLocation` 的 `value === "runner"` 永远不成立，随后按旧规则要求缓存必须位于 `.ci-output` 下而抛错。也就是说，新增的 runner 缓存分支在真实 GitHub Actions 路径上根本走不到。
- **证据（读代码证实）**：
  - `scripts/ci/install-dependencies.mjs:455`：`options[name] = resolve(args[++index]);`
  - `scripts/ci/install-dependencies.mjs:81`：`if (value === "runner") return runnerNpmCache(env);`
  - `scripts/ci/install-dependencies.mjs:84`：`assert(target !== base && contained(base, target), "npm cache 必须位于仓库 .ci-output 子目录");`
  - `.github/workflows/ci.yml:53`：`... --cache runner`
  - 现有测试 `test/tooling/toolchain-lifecycle.test.mjs:433-438` 是直接调用 `installDependencies({ cacheDirectory: "runner", env })`，绕过了 CLI，所以测试通过也发现不了这个问题。
- **建议**：在 CLI 里对 `--cache` 单独处理，先保留字面量 `runner`，不要把 `runner` 送进 `resolve()`；或者让消费端接受“解析后等于约定缓存目录”的路径。补一条真正以子进程运行 `node scripts/ci/install-dependencies.mjs ... --cache runner` 的正向用例。

### 2. 致命（P0）— 默认不统计覆盖率时 `tests` 不产出 lcov，但策略仍然要求 lcov，汇总必判失败
- **文件:行**：`ci/policy.json:111`、`scripts/ci/run.mjs:315-323`、`scripts/ci/aggregate.mjs:154-156`
- **问题**：`tests` 的 outputs 固定写成 `["json","lcov","artifact"]`，但默认路径 `measure=false` 时，`run.mjs` 只把 lcov 加入报告的条件是 `measure` 为真。普通 PR 上 `baselineCandidate` 因仓库已有基线而拿不到 candidate，`coverage` 又没传，所以一定不 measure，结果报告里没有 `kind: "lcov"` 的条目；`aggregate` 逐个检查 `check.outputs`，直接报 `Missing lcov output`。这会让每个普通 PR 的 `ci/required` 变红。旧基线升级成新形状时 `upgradeCoverageToTests` 又保留了原 coverage 的 outputs，同样带着 lcov。
- **证据（读代码证实）**：
  - `ci/policy.json:111`：`"outputs": ["json", "lcov", "artifact"]`
  - `scripts/ci/run.mjs:315`：`const measure = coverage === "measure" || candidate !== undefined;`
  - `scripts/ci/run.mjs:316-323`：只有 `if (measure)` 时才把 `lcov.info` 加入 `files`
  - `scripts/ci/aggregate.mjs:154-156`：`for (const kind of check.outputs) if (!result.reports.some((report) => report.kind === kind)) fail(..., \`Missing ${kind} output\`)`
- **建议**：让“默认不 measure”时的声明输出与真实产物一致：例如 `tests` 的固定输出改为 `["json","artifact"]`，把 lcov 当作 measure 模式下额外产生、但不作为默认必交的证据；如果不想改策略形状，就在 `result` 里显式记录“本次是否 measure”，让 `aggregate` 只在该模式下要求 lcov。升级函数也要同步。再补一条“真实非 measure 的 tests 报告直接交给 aggregate”的用例，而不是只构造带 lcov 的假报告。

### 3. 高（P1）— 初始化/夜间 measure 时 `tests` 把 tooling 计入 projects，和策略声明的 5 个项目不一致，汇总会拒绝
- **文件:行**：`scripts/ci/run.mjs:336-337`、`scripts/ci/run.mjs:359-374`、`ci/policy.json:110`、`scripts/ci/coverage-model.mjs:33`、`scripts/ci/aggregate.mjs:108-112`
- **问题**：`tests` 策略只声明 `unit/contracts/integration/e2e/pi-compat` 五个项目；但初始化（或将来夜间 `--coverage measure`）时 `measuredProjects = coverageProjects`，而 `coverageProjects` 包含 `tooling`。`collectCoverage` 会把 `tooling` 也推进 `result.projects`，加上普通项目后总共 6 个；`aggregate` 要求报告里的项目集合与策略完全一致，于是报 `Project count set differs from policy`。这正是作者特别要保证的初始化路径，现有测试只断言了 tooling 会参与测量，没有把结果交给 `aggregate`。
- **证据（读代码证实）**：
  - `scripts/ci/coverage-model.mjs:33`：`export const coverageProjects = ["unit", "contracts", "tooling", "integration"];`
  - `scripts/ci/run.mjs:336`：`const measuredProjects = measure ? coverageProjects : [];`
  - `scripts/ci/run.mjs:359-374`：`for (const id of measuredProjects) ... result.projects.push({ id, counts: ... })`
  - `ci/policy.json:110`：`"projects": ["unit", "contracts", "integration", "e2e", "pi-compat"]`
  - `scripts/ci/aggregate.mjs:108-112`：比较 `projectIds` 与 `check.projects`
- **建议**：统一“测量项目集合”和“策略声明项目集合”。要么让 measure 模式下的 `tests` 也声明/统计 tooling，要么在 `tests` 报告里过滤掉不属于 `check.projects` 的 tooling 计数（同时保证 `result.counts` 与过滤后的 projects 一致），只把 tooling 的测试数据留在 `tests.json` 里供覆盖率判定使用。补一条“初始化结果直接走 aggregate”的端到端用例。

### 4. 低（P3）— 目标 3 没有覆盖 required 作业的最小依赖安装
- **文件:行**：`scripts/ci/install-gate-dependencies.mjs:85-86`、`.github/workflows/ci.yml:402`、`docs/runbooks/ci-vps-runner-runbook.md:208`
- **问题**：完整依赖安装改成了 runner HOME 缓存，但 `ci/required` 仍通过 `install-gate-dependencies.mjs` 使用工作区里的 `.ci-output/npm-cache`。如果目标 3 的“npm 下载缓存”包括所有 CI 作业，那么 required 作业仍然每次冷启动；运行手册却写成“CI 作业装依赖时……放在各 runner 账号自己的 `~/.cache/himawari-ci/npm`”。
- **证据（读代码证实）**：`scripts/ci/install-gate-dependencies.mjs:85-86` 仍是 `"--cache", path.join(root, ".ci-output/npm-cache")`；`docs/runbooks/ci-vps-runner-runbook.md:208` 写的是所有 CI 作业使用 HOME 缓存。
- **推测**：作者可能有意只把这条缓存用于完整依赖安装，gate 的最小依赖不值得复用；如果是这样，运行手册应明确写出这个例外。

**侧重检查**

- **错误路径**：重点查了 `--cache runner` 的 CLI 路径（确认必失败）、默认不 measure 的 tests 报告（确认缺 lcov）、初始化 measure 的 projects（确认多 tooling）、tooling 报告缺失（`aggregate` 的 `needs` 检查和 `expectedMembers` 缺失列表会判失败，不会误判通过）。
- **不可信/不合规输入**：策略升级的负向形状有对应校验；`policy.schema.json` 使用 `additionalProperties: false`，`validatePolicy` 还会逐项检查 needs/timeout/projects/members/platform，所以升级函数本身放过的非 coverage 字段最终仍会被拒。`runnerNpmCache` 对非 Actions、相对 HOME、路径中的符号链接都有拒绝分支。
- **安全**：缓存删除范围限定在 `HOME/.cache/himawari-ci/npm`，并拒绝符号链接；npm 仍按锁文件完整性校验。残留风险是缓存按 runner 账号跨分支共享，但具体包内容仍受 npm integrity 约束，未发现可直接注入未锁定包的问题。
- **资源耗尽/不可撤销操作**：唯一的大范围删除是 7 天后整体清空缓存，属于可重建数据；代码按创建时间清理，与文档“满 7 天清空重建”一致。没有对缓存大小设上限，只靠 runner 作业开始前的磁盘检查，这是残余风险，不是本次必然故障。ARM 新增 tooling 后，policy/static/security/tooling 四个 ARM 作业只有两个 `ci-arm` runner，可能排队变长，但符合“在 ARM 上并行”的目标。
- **文档与代码一致性**：`gh-runners.slice`、`ghgate.slice`、`runners.sh`、运行手册里的 16 GB/4 GB 数值一致；但 ADR 0267 和运行手册说默认不量覆盖率、tests 跑五个项目，与 policy 仍要求 lcov、measure 时报告多出 tooling 的代码不一致（对应上面第 2、3 条）。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。改动文件全部是 CI、文档、测试和 runner 配置，没有改 `packages/prompt-catalog`、`runtime-pi`、模型请求组装或遮盖逻辑；本次也没有新增任何发给模型的内容。发给模型的内容仍然只在末尾追加，每轮变化的值也没有被搬到请求开头。依据 `prompt-prefix.md` 第 4、6、10、11 条。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 不涉及模型请求文本。新增的 `Date.now()` 只用于判断本地 npm 缓存是否满 7 天，不进入请求；`policySha256` 仍按基准策略原始字节计算，升级只在内存里做，不改变已存的字节。没有发现新的遮盖、时间字段或无序集合进入模型内容。
3. **有没有对应的自动检查，反向用例真的会失败？** 部分有：策略升级有 `[ADR-0267]` 的形状正反向用例，`--coverage` 非法值有 `CI_COVERAGE_OPTION_INVALID` 用例，runner 缓存有非 Actions、相对 HOME、符号链接和 7 天清理用例，内存数值也有测试。但缺少三类关键覆盖：CLI 层 `--cache runner` 的正向执行、真实非 measure `tests` 报告交给 `aggregate`、初始化 measure 结果交给 `aggregate`。因此第 1、2、3 条这些回归现有测试发现不了。测试本身未实际运行，作者所称“1336 个用例通过”未核实；从代码看，已写的策略升级反向用例在篡改形状后 `upgradeCoverageToTests` 返回原对象、随后的 `validatePolicy` 会抛错，设计上是有效的。
4. **每个值产生处和使用处能对上吗？** 大部分能：`tests`/`tooling` 两个 job id 在 policy、工作流、run/test/aggregate/local/run-share 中基本一致；`tooling` 加入 `armChecks` 后与 ARM 平台校验、remote-jobs 收集一致；内存数值在 slice、`runners.sh`、运行手册和测试中一致。对不上的有三处：`--cache runner` 由工作流产生、被 CLI 的 `resolve()` 改成绝对路径后拒绝（第 1 条）；`tests.outputs` 里的 `lcov` 是策略产生、`aggregate` 消费，但默认运行不产生（第 2 条）；`coverageProjects` 产生 tooling 项目、`tests.projects` 不包含 tooling，`aggregate` 却要求两者集合相等（第 3 条）。`policy` 作业的 `counts: {files:2, executed:2, ...}` 与 `static` 作业按命令数计数的既有口径一致，汇总只检查计数自洽，未发现新的消费端冲突。
