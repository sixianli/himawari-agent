---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0157-gitleaks-allowlist-for-evidence-digests.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0177-gitleaks-exact-value-allowlist.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0189-drop-node-floor-and-fold-test-into-coverage.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0243-ci-uses-no-github-artifacts.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0267-ci-tests-without-coverage-on-prs.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0268-merge-queue-and-related-tests-on-prs.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0275-tests-job-runs-on-three-runners.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0287-ci-runs-on-github-hosted-runners.md"
superseded_by: ""
date: "2026-11-26"
covers: ".github/workflows/ci.yml, .github/workflows/main.yml, .github/workflows/merge-queue.yml, .github/workflows/apple.yml, .github/workflows/real-sites.yml, ci/policy.json, scripts/ci/check-policy.mjs, scripts/ci/run.mjs, scripts/ci/test-scope.mjs, scripts/ci/aggregate.mjs, scripts/ci/required.mjs, scripts/ci/gate-log.mjs, scripts/ci/ci-summary.mjs, scripts/ci/main-evidence.mjs, scripts/ci/merge-queue.mjs, scripts/ci/prepare-hosted.sh, scripts/ci/apple-scope.mjs, scripts/ci/main-claim.mjs"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0292：CI 的现行做法

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [跑在哪些机器上](#runners)
  - [有哪些作业](#jobs)
  - [草稿 PR 和触发](#drafts)
  - [PR 上跑哪些测试](#scope)
  - [作业之间传文件、结果放哪里](#results)
  - [合并和 main 上的确认](#merging)
  - [合并队列（暂停）](#merge-queue)
  - [密钥扫描的误报怎样放行](#gitleaks)
- [还没做到的](#not-yet)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

CI（持续集成，每次推送和开 PR 时自动跑检查和测试的那套流程）的规矩原来分散在七份 ADR 里，后面的又一条条改前面的：ADR 0189 去掉最低版本 Node 的检查，ADR 0241 定草稿 PR 不跑 CI、合并等 CI 变绿，ADR 0243 定不用 GitHub 产物，ADR 0267 定 PR 上不统计覆盖率，ADR 0268 定 PR 上只跑相关测试和合并队列，ADR 0275 把测试拆到三台机器，ADR 0287 把 CI 从自托管机器搬到 GitHub 免费的托管机器。要知道现在怎么跑，得把七份叠在一起读。这份 ADR 把它们合成一份，只写现在为真的做法；七份旧文的全文在 `supersedes` 列的固定提交链接里。

<a id="decision"></a>

## 决定

<a id="runners"></a>

### 跑在哪些机器上

- 只用 GitHub 免费的三种托管机器：`ubuntu-24.04`（x64）、`ubuntu-24.04-arm`（ARM）、`macos-26`。`npm run check:ci-policy` 读 `.github/workflows/` 下全部工作流，`runs-on` 不是这三种之一（包括更大的付费机器、`self-hosted`、浮动标签和算出来的表达式）就以 `HOSTED_RUNNER_REQUIRED` 失败。仓库是公开的，这三种机器不花钱。
- `policy`、`tooling`、`security` 跑在 ARM；`static`、`build`、`tests`、汇总作业 `ci/required`、main 确认、合并队列和“关闭 PR 时取消 CI”跑在 x64。`static` 必须在 x64：`npm run check` 里的 `check:delivery-dependencies` 会真的运行只认 linux-x64 的依赖收集脚本，在 ARM 上会失败。
- `Apple` 工作流在 `macos-26` 上跑。PR 上只开一台 Mac：`apple/iphone` 一个作业里跑 `HimawariCore` 单元测试，再不签名编译 iPhone App 和原生 Mac App（`HimawariMac`）。推送到 `main` 和手动触发（`workflow_dispatch`，在 GitHub 的 Actions 页面点 “Run workflow”）时另外跑 `apple/iphone-accessibility` 三份并行，在模拟器里对每个示例场景跑苹果的无障碍审计（`clients/apple/App/UITests/AccessibilityAuditTests.swift`，见[界面设计规范的自动检查](../ui-ux-design-guide.md#gates)），以及长对话滚动测速 `apple/scroll`。这几个 Mac 作业之前先在 `ubuntu-24.04` 上跑一个几秒钟的 `apple/changes`：用 `scripts/ci/apple-scope.mjs` 看这次 PR 或推送有没有改 `clients/apple/`、`apple.yml` 或这个脚本，没改就跳过 Mac 作业，说不清改了什么时照跑。免费账号同时只给 5 台 Mac 机器，2026-11-25 到 11-26 的 Apple 运行里约一半来自没碰 iPhone 客户端的 PR，把 Mac 机器排满了。只有 `ci/required` 是合并必需的检查，所以被跳过的 Mac 作业不会卡住合并。
- 审计、测速和 Release 归档移出 PR（2026-11-27，Andy 在“缩短 CI 合并门槛和排队”任务说明里的原话：“苹果客户端的无障碍审计移出 PR，只在 main 上跑”“这两项不需要再找 Andy 确认，按决定执行”）。起因：2026-11-24 10:30 到 11-27 10:30（UTC）PR 上的 Mac 机器时间共 138.8 小时，其中审计 70.2、`TestFlight` 工作流的 Release 归档 17.4、测速 11.6，`apple/iphone` 只占 39.4；审计在 PR 上 412 次被取消、92 次失败、87 次成功，大多没跑完就被下一次推送取消，却把 5 台 Mac 占满（数字来自 `node scripts/ci/actions-stats.mjs`）。`TestFlight` 工作流因此不再在 PR 上跑，只在 `main` 上跑 `testflight/upload`：有上传密钥时照旧归档、核对权限再上传；没有密钥时也打 Release 归档并核对权限（`clients/apple/scripts/testflight.sh archive`），只是不上传。
- `main` 上苹果检查失败要有人认领：`Apple` 工作流的 `apple/iphone`、审计或测速失败，或 `TestFlight` 工作流的 `testflight/upload` 失败时，同一次运行里的 `apple/claim`、`testflight/claim`（`ubuntu-24.04`，只有这一步能在 PR 上写留言）运行 `scripts/ci/main-claim.mjs`：往回找这些作业上一次在 `main` 上全部通过的提交，列出从那以后合进 `main`、改了苹果客户端的 PR，在每个 PR 上留言（带失败的作业名、运行链接和上次通过的提交），请做这个 PR 的线程认领并修；找不到上一次通过时，只留在这次提交所属的 PR 上。同一次运行不在同一个 PR 上留两次言。审计因页面改动多出问题时修页面，不调高登记表的数（[I-121](../incidents-and-gates.md#incidents)）。
- 沙箱测试要的 bubblewrap、socat、ripgrep 和 Ubuntu 24.04 的 AppArmor 放宽，由 `scripts/ci/prepare-hosted.sh` 在每个作业开头装好；它也装 restic，供集成测试跑真实的机外备份和恢复演练。
- main 上较早的策略文件还写着自托管机器的旧标签，`check-policy.mjs` 的 `resolvePolicySource` 在比较时把它们整体换成对应的托管标签，摘要仍按原始字节算。

<a id="jobs"></a>

### 有哪些作业

- `ci.yml` 有 `policy`、`static`、`build`、`tests`、`tooling`、`security` 六个检查作业，加汇总作业 `ci/required`。合并只看 `ci/required`。
- 网页专用的浏览器检查已去掉。Andy 2026-11-27 定，出处是他给 CI 提速线程的任务说明，原话：“网页端已决定全部删除，CI 不再需要跑网页相关的浏览器检查。”原来的 `browser` 作业在 Chromium、Firefox、WebKit 三个浏览器里各打开一遍网页，现在没有了，`ci/required` 也不再等它；`npm run check` 去掉了只查网页的三步：`check:layout`（用真浏览器检查网页排版）、`check:phone-layout`（手机网页的输入框字号和弹窗安全区）、`check:locale`（网页里日期和数字的格式化带不带界面语言）。这三个脚本和 `package.json` 里的命令名暂时留着，等[ADR 0309](0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md#order)最后一步删网页代码时一起删，需要时仍可手动跑。基准提交上的策略文件还写着 `browser` 作业时，`check-policy.mjs` 的 `upgradeRetiredBrowserCheck` 在比较前把它去掉，只认原来那一种写法，别的写法照样被拒。
- 仍要装浏览器的地方：`tests` 装 Chromium，integration 里 Himawari 自己的浏览器工具（`test/integration/browser-tool.test.ts`）要用它，另有一批打开网页的浏览器测试随网页代码一起删；`tooling` 装 Chromium，`test/tooling/safari-panel.test.ts` 要用它打开 Safari 扩展的面板页，这和网页无关；`prepare-hosted.sh` 只装 Chromium 需要的系统库；手动触发的 `quality.yml` 的 `brands` 检查用 Chrome 和 Edge 打开网页，也随网页代码一起删。
- `tests` 跑 unit、contracts、integration、e2e、pi-compat 五个测试项目，拆成三个成员：`integration-1`、`integration-2` 各跑 integration 的一半，`others` 跑其余四个。分份办法：把该跑的、已提交的测试文件按路径排序，第 i 个（从 0 数）归第 `i % 2 + 1` 份，每份把文件名明确交给 vitest；多跑或少跑一个文件都以 `CI_TEST_FILE_SET_MISMATCH` 失败。`validatePolicy` 要求每个项目在成员之间恰好跑一次，分片成员只跑一个项目。
- `tooling` 在 ARM 上和 `tests` 并行，只等 `policy`；`policy` 自己不跑测试。tooling 测试超时和 integration 一样是 30 秒（`vitest.workspace.ts`），因为这些测试会起子进程、建临时 git 仓库，在 4 核机器上会超过 5 秒。
- PR 上不统计覆盖率。`scripts/ci/run.mjs` 只有传 `--coverage measure` 或仓库还没有覆盖率基线时才统计，统计时不分片，在一台机器上跑全部项目。
- 支持的 Node 版本是 `package.json` 里 `engines.node` 写的 `>=22.22.3`，等于生产实际用的版本，不再有检查最低版本 Node 的作业。
- 本地入口：`npm test` 运行 `scripts/ci/local.mjs --check tests`（在本机依次跑三个成员），`npm run test:tooling` 运行 `--check tooling`。
- npm 的下载缓存放在机器账号目录 `~/.cache/himawari-ci/npm`（`install-dependencies.mjs --cache runner`），只缓存下载的包，不缓存 `node_modules`；npm 照旧按锁文件里的摘要核对每个包，缓存被改坏只会让安装失败。托管机器每次都是新的，所以这份缓存实际上只在同一个作业里有用。

<a id="drafts"></a>

### 草稿 PR 和触发

- 草稿 PR 不跑任何检查：六个检查作业都带 `github.event_name != 'pull_request' || github.event.pull_request.draft != true`。
- 汇总作业仍带 `always()`，第一步是一段不依赖任何安装的 bash：草稿 PR 打印 `CI_DRAFT_UNVERIFIED` 并失败，任何上游作业被取消时打印 `CI_UPSTREAM_CANCELLED` 并失败。草稿保持“失败”而不是“跳过”，因为跳过会显示成功，还可能被 main 的轻量确认当成证据。
- `pull_request` 只在 `opened`、`synchronize`、`reopened`、`ready_for_review` 时触发；只改 PR 标题或正文不跑 CI。改了 PR 的目标分支后，要推一个新提交才会重跑。
- `check-policy.mjs` 把上面三条写成硬规则，`test/tooling/policy.test.mjs` 有反向用例，`test/tooling/ci-optimization.test.mjs` 实际执行入口那段 bash。

<a id="scope"></a>

### PR 上跑哪些测试

- 只在 `pull_request` 事件上缩小范围；手动触发、推送和 main 上的运行一律全量。
- unit 和 contracts 照跑全量。integration、e2e、pi-compat、tooling 只跑 `vitest list --changed <PR 基线>` 选出的测试，可以是零个（`scripts/ci/test-scope.mjs`）。
- 改动里只要有一个文件不是 `apps/`、`packages/`、`test/` 下的源码（配置文件 `*.config.*`、`vitest.*` 不算源码），也不是 `.md` 或 `.agents/` 下的记录，就全部全量。所以改依赖、SQL、JSON、`scripts/`、`ci/`、`.github/` 都跑全量。某个项目的 `vitest list` 出错时，那个项目退回全量。
- 汇总结果标 `scope: related`，只在 PR 上接受这种范围。完整测试在合进 `main` 后由 `Main confirmation` 补上。
- 访问真实外网的测试不进合并门槛（2026-11-27 协调者在本线程定“真联网的移到 main 上跑”，依据见 Andy 的 CI 优化任务说明第 8 项“找出重跑才通过的测试并按项目测试规则修”）：外网慢或改版时它们会让和本 PR 无关的合并失败，而测试本身没有错。这类文件从 `integration` 排除、在 `ci/policy.json` 登记成单独的 `qualification-*` 项目，由 `.github/workflows/real-sites.yml` 在 main 每次推送后跑（也可手动触发），不重试；失败时同一次运行里的 `real-sites/claim` 用 `scripts/ci/main-claim.mjs` 在上次通过以来合进 `main` 的每个 PR 上留言请它的线程认领（苹果检查用同一个脚本，只找改了苹果客户端的 PR）；轻量确认复用的是 PR 的结果，所以必须单独跑。现在只有 `test/integration/browser-tool-real-sites.test.ts`（打开 `en.wikipedia.org` 搜索、在 `example.com` 点到没放行的网站）；不碰外网的浏览器工具测试留在 `test/integration/browser-tool.test.ts`，照常进门槛。

<a id="results"></a>

### 作业之间传文件、结果放哪里

- 不用 GitHub 产物：`check-policy.mjs` 拒绝任何作业用 `actions/upload-artifact` 或 `actions/download-artifact`。
- 作业之间传文件用本次运行内部的缓存：每个检查作业把自己的报告用 `actions/cache/save` 存进去，键带 `run_id` 和 `run_attempt`；`tests` 先取回本次的 Linux 构建（取不到就失败），汇总作业逐个取回各成员的报告。取回后按作业输出里的摘要逐字节核对（`run-share.mjs`），共享目录是每台机器自己的 `$RUNNER_TEMP/ci-share`。依赖和工具不放进 GitHub 缓存。
- 汇总结论写进 `ci/required` 的步骤日志：`required.mjs` 把 `{context, summary}` 先遮盖像密钥的内容，再按 base64 打印在 `HIMAWARI_GATE_BEGIN v1 <SHA-256>` 和 `HIMAWARI_GATE_END` 两行之间（`gate-log.mjs`），上限 256 KiB；每个检查的结果和失败原因另写成一张表放进作业摘要。
- 每个检查作业用 `scripts/ci/ci-summary.mjs` 把诊断写进作业摘要，并同样打印到作业日志（云端线程只读得到日志）：截图、trace 只列名字和大小；检查失败时再加失败的用例（文件、名字、报错前 20 行，最多 30 条）和命令日志末尾。全部先遮盖，每段总量不超过 64 KiB，日志里每行前加 `| `，免得被当成工作流命令或冒充汇总结论标记。
- 日志和运行记录在仓库设置里保留 3 天。

<a id="merging"></a>

### 合并和 main 上的确认

- 合并前 PR 最新提交上的 `ci/required` 必须是成功。CI 本身坏了（GitHub 故障，并已确认失败和这个 PR 无关）时，只有 Andy 明确说这次不等 CI，才能在没变绿时合并，线程把他的原话和失败原因写进 PR 描述。什么时候由线程自己合并，见[交付模式](../../.agents/instructions/delivery-mode.md#fast-mode)。
- 合进 `main` 后，`main.yml` 先找合并 PR 最新的成功运行，从它 `ci/required` 的日志里取回汇总结论（`main-evidence.mjs discover`）：只对 `api.github.com` 带令牌，要求标记恰好一段、base64 合法、SHA-256 相符。取到并核对通过时走轻量确认；拿不到、PR 运行超过 24 小时、结果标着 `related`（`MAIN_GATE_RELATED_SCOPE`），或改了 `.github`、`ci`、`scripts/ci`（`MAIN_VALIDATION_CHANGED`）时跑全量。确认作业自己再取一次证据，核对不过时以 `MAIN_EVIDENCE_NO_LONGER_VALID` 失败。

<a id="merge-queue"></a>

### 合并队列（暂停）

- `.github/workflows/merge-queue.yml` 和 `scripts/ci/merge-queue.mjs` 还在仓库里，但工作流现在只能手动触发（`workflow_dispatch`），不再跟着 CI 跑完或定时触发；线程不给 PR 加 `merge-queue` 标签，CI 变绿后直接合并（[交付模式](../../.agents/instructions/delivery-mode.md#fast-mode)）。
- 手动触发时它的做法：从带 `merge-queue` 标签、PR 头上 `ci/required` 成功的 PR 里取最多 5 个，以当前 main 为底逐个 `git merge --no-ff`，推到 `mq/<运行号>-<尝试次数>` 分支跑完整 CI；过了就逐个合并并核对 main 的树和候选一致，失败就对半拆开重测，最终把出错的那个 PR 移出队列。队列状态存在 `merge-queue-state` 分支的 `state.json`。它只检出 main、只运行 main 上的脚本，不执行 PR 的代码；改了 `.github`、`ci`、`scripts/ci` 的 PR 不进队列；只在 `DELIVERY_MODE` 为 `fast` 时工作。

<a id="gitleaks"></a>

### 密钥扫描的误报怎样放行

Gitleaks 是 CI 里扫描仓库有没有误提交密钥的工具。它把不是密钥的东西认成密钥时：

- 先按逐条例外登记进 `ci/security-exceptions.json`。
- 例外清单收不下（命中在测试目录之外，或那一行不能登记）时，才在 `ci/rules/gitleaks.toml` 加白名单。每块白名单只对一条规则生效（`targetRules`）、`condition = "AND"`、路径锚定到具体文件或那一个目录，并且只认一种固定形状：资格证据里“路径加 64 位十六进制摘要”的整行，或用 `^…$` 锚定的那一个精确值。不得按整个目录或整条规则放行，不得写成字符类。
- 每块白名单都要有测试（`test/tooling/gitleaks-config.test.mjs`、`test/tooling/gitleaks-allowlist.test.mjs`），用锁定版本的真实 Gitleaks 核对误报不报、真格式的密钥照报、改一个字符就不放行。
- 只放行已经核实不是密钥的值；真密钥误入仓库时轮换，不加白名单。

<a id="not-yet"></a>

## 还没做到的

- 每天夜里在 main 上统计一次覆盖率（ADR 0267 定的第 2 步）没有排上：没有任何工作流按时间触发，`quality.yml` 的定时触发也还没开。
- 合并队列的脚本在选 PR 时仍会跑 `opencode-review.mjs --assert-reviewed` 检查复核记录。OpenCode 复核已暂停（[AGENTS.md](../../AGENTS.md#working-with-opencode)），恢复手动触发前要先把这一步摘掉，否则没有复核记录的 PR 都会被移出队列。

<a id="rejected"></a>

## 放弃的做法

- 自托管机器（先是 Hermes，后来是 CI VPS 和 Oracle ARM）：要人维护，还要一台机器常开；仓库公开后托管机器免费，就全删了。
- 用 GitHub 产物在作业之间传报告：产物要占存储、要管保留期，作业之间用本次运行的缓存就够了。
- PR 上统计覆盖率：拖慢每个 PR，覆盖率变化也不该挡合并。
- 只改 `edited` 事件里目标分支时才跑：只改标题的那一轮会把 `ci/required` 跳过，GitHub 在同一个提交上记一个“成功”，盖掉真实结果。
- 合并不等 CI：快速模式早期为了快这样做过，2026-11-14 起作废，合并一律等 `ci/required` 变绿。

<a id="consequences"></a>

## 后果

- CI 不花钱，也没有要维护的机器；代价是每个作业都从新机器开始，依赖每次都要重新下载。
- PR 上只跑相关测试，PR 绿了不等于全量绿；全量在 main 上补，main 变红时要优先修。
- 改 CI 自身的 PR 一律全量跑，main 上也跑全量。
