## 复核范围

本轮按作者列出的 10 个提交（099726463..61211c3de，剔除合入 main 的提交）核对。实际改到的文件集中在 `scripts/ci/`、`scripts/operations/ci-runner/`、`test/tooling/`、`.github/workflows/ci-arm-trial.yml`、`docs/runbooks/ci-vps-runner-runbook.md`、`scripts/platform-assumptions.json`。以下结论均来自读代码，未运行测试。

---

## 发现（按严重度）

### 1. 中：ARM 试跑在自托管 runner 上执行所有 PR（含草稿）的代码，没有同仓库/分支守卫 【读代码证实 + 风险推测】

- 文件：`.github/workflows/ci-arm-trial.yml:2-8,19-21`；`test/tooling/policy.test.mjs:1290`
- 问题：工作流是 `pull_request` 触发、`runs-on: ci-arm`，三个作业都没有任何 `if` 限制。`3325a2947` 删掉了草稿条件后，草稿 PR 的 `opened/synchronize` 也会在自托管 ARM 机器上执行 PR 代码。策略测试还把“无 `if`”固定成要求：`expect(job.if).toBeUndefined()`。
- 证据：
  - `.github/workflows/ci-arm-trial.yml:2-8`：`on: pull_request: types: [opened, synchronize, reopened, ready_for_review]`
  - `.github/workflows/ci-arm-trial.yml:21`：`runs-on: ci-arm`
  - `test/tooling/policy.test.mjs:1290`：`expect(job.if).toBeUndefined();`
  - `docs/execution/plans/2026-09-03-github-ci-quality-gates-plan.md:28` 记录仓库已是公开仓库、fork 审批为 `first_time_contributors`。
- 说明：这不是本改动首次引入（非草稿 fork PR 原本就会跑），但删除草稿条件扩大了触发面，且测试现在不允许给作业加任何 `if`。公开仓库 + 自托管 runner + 执行 PR 代码是已知的高风险组合，实际可利用性取决于 GitHub 的 fork 审批/环境审批设置（未核实）。
- 建议：给三个作业加同仓库守卫（如 `github.event.pull_request.head.repo.full_name == github.repository`）或限定可信分支；同步修改 `policy.test.mjs` 允许这个守卫；或在 runbook 明确写清 fork PR 由管理员策略阻断，并把它列进安全前提。

### 2. 中/低：prepare-arm 以 root 运行未做独立完整性校验的 Playwright 包 【读代码证实；风险为推测】

- 文件：`scripts/operations/ci-runner/prepare-arm.sh:43-49`
- 问题：Node 下载有 sha256 校验（第 44 行），但 Playwright 只用版本号安装，随后以 root 执行包里的 `cli.js`：
  - `48: npm install --no-save --ignore-scripts ... "playwright@$PLAYWRIGHT_VERSION"`
  - `49: PATH="$node_bin:$PATH" node "$work/pw/node_modules/playwright/cli.js" install-deps chromium`
  - `--ignore-scripts` 并不能防止第 49 行主动执行包代码。仓库其他固定工具都靠锁文件/摘要校验，这里强度不一致；重复运行时 `npm install` 的传递依赖也可能随时间变化。
- 建议：像 Node 一样固定 Playwright tarball 的 sha256/integrity，或复用 `package-lock.json`/`npm ci` 的已校验依赖；至少记录并校验安装包的 integrity。prepare-vps 已有同样写法，但它是既有代码，本次新增到 ARM。

### 3. 中/低：semgrep 时限用例只守常量，守不住真正的调用点 【读代码证实】

- 文件：`test/tooling/security.test.mjs:999-1012`；`scripts/ci/check-security.mjs:534`
- 问题：测试只断言导出的 `semgrepTimeoutMs` 数值，没有验证 `scanSemgrep` 是否把它传给 `execute`。把第 534 行改回 `{ root: snapshot, env }`（不传 timeout）测试仍然通过，而这正是本次修复的核心。
- 证据：
  - `scripts/ci/check-security.mjs:534`：`{ root: snapshot, env, timeout: semgrepTimeoutMs },`
  - `test/tooling/security.test.mjs:1010-1011` 只比较 `semgrepTimeoutMs` 与常量/作业时限。
- 反向结论：把 `semgrepTimeoutMs` 改回 `120_000` 会失败；但删掉调用点的 `timeout` 不会失败。
- 建议：注入/替换 `execute` 或 `spawnSync`，断言 semgrep 调用收到的 `timeout === semgrepTimeoutMs`；或至少静态断言 `timeout: semgrepTimeoutMs` 出现在 `scanSemgrep` 里。

### 4. 低：准备脚本用例的平台名来自脚本自身，无法发现“平台写错”；退出码和重复运行也没测 【读代码证实】

- 文件：`test/tooling/ci-runner-scripts.test.mjs:2954-2959`；`scripts/operations/ci-runner/prepare-arm.sh:43-49`
- 问题：测试从脚本文本里的下载 URL 反推平台，再去锁文件查同名 artifact：
  - `2954: const platform = text.match(/node-v\$NODE_VERSION-(linux-[a-z0-9]+)\.tar\.gz/u)?.[1];`
  - `2955: const node = lock.node.releases[value(text, "NODE_VERSION")]?.artifacts[platform];`
  因此把 prepare-arm 的 URL 改成 `linux-x64`，测试仍会拿锁文件里的 x64 条目并通过。作者说的“sha256 不符退出 74”以及“可重复运行”也没有测试覆盖。
- 建议：按脚本名指定期望平台（`prepare-arm.sh → linux-arm64`，`prepare-vps.sh → linux-x64`），再与锁文件比对；用假 `curl`/`sha256sum`/`npm` 跑一次脚本分支断言退出码 74；补一个两次连续执行的用例验证幂等。
- 说明：代码里的 `printf ... | sha256sum -c --quiet - || fail "node checksum mismatch" 74` 在 `set -euo pipefail` 下确实会以 74 退出（第 2、44 行），但只有静态路径被测试。

### 5. 低：prepare-arm 的其他错误路径不统一，curl 可能在重跑时挂住 【读代码证实】

- 文件：`scripts/operations/ci-runner/prepare-arm.sh:41-49`；`docs/runbooks/ci-vps-runner-runbook.md:186`
- 问题：
  - `curl -fsSL --retry 3` 没有 `--connect-timeout`/`--max-time`，网络半挂时脚本可无限等待；`tar`、`npm install` 失败也只会以通用退出码退出，不打印 `CI_ARM_PREPARE_FAILED`。
  - runbook 第 186 行说“脚本可以重复运行，不动正在运行的 runner”，但重复运行会重新下载/安装，且第 36 行的 `apt-get install` 发生在写 needrestart 覆盖配置（第 39 行）之前；如果机器上此前没有那份配置，重跑可能触发 needrestart 重启 `gh-runner` 服务。按 runbook 的正常安装顺序该配置已存在，所以是边缘情况。
- 建议：给 curl 加连接/总超时；把下载、解压、npm 安装失败也映射成带原因的 `CI_ARM_PREPARE_FAILED`；在 runbook 写明新增的 74 等退出码；若真要保证“不动 runner”，可在脚本开头就写 needrestart 配置或显式 `needrestart -q -r l` 的排除检查。
- 结构上重复运行本身是安全的：每次 `mktemp -d`、`trap 'rm -rf "$work"' EXIT`，不写 runner 的持久状态（worker 目录、systemd 配置都没动）。

### 6. 低（推测）：`firstChangedMessage` 用 `JSON.stringify` 替代 `toEqual`，对键顺序敏感 【推测，依赖客户端序列化是否稳定】

- 文件：`test/tooling/opencode-review.fixtures.mjs:181-197`
- 问题：旧断言 `expect(later.messages.slice(0, n)).toEqual(earlier.messages)` 对对象键顺序不敏感；新断言逐条 `JSON.stringify` 比较，键顺序不同就会被判定为“改了”。如果请求体在两次调用中因对象构造顺序变化而键序不同，会引入新的偶发失败（虽然比旧断言更严格，更符合“逐字节只追加”的规则）。
- 建议：失败诊断用 `JSON.stringify`，判定仍用深比较（或先做键排序的规范化序列化）。另外它只比较 `earlier.messages` 长度范围，长度更短的场景靠后面的 `length >` 断言兜底，行为没问题。

---

## 作者说法与代码不一致 / 需修正的说法

1. **归属写错**：作者把“新增用例核对 process.arch 与子进程一致”算在 `ea2342799`，但该用例实际是在 `26898f47b` 中加入 `test/tooling/test-timeout-entry.test.mjs:61-66`；`ea2342799` 只加了 `details.json` 断言信息。
2. **“CI 脚本统一从 platforms.mjs 取主机平台”不完全准确**：`scripts/ci/install-dependencies.mjs:39` 仍读 `process.platform`（win32 路径分隔符），`scripts/ci/execute.mjs:15,20` 也仍读 `process.platform`（win32 的 detached/kill）。它们不参与平台标签，当前没有测试在模拟非真实 OS 下走到这些分支，但严格说没有“统一”。
3. **prepare-vps 不是只装 chromium**：`prepare-vps.sh:68` 是 `install-deps chromium firefox webkit`，prepare-arm 才是 `chromium`。测试的正则 `install-deps chromium\b` 两边都能匹配，因此不影响通过，但作者说法不精确。
4. **“sha256 不符退出 74”在代码里成立，在测试里不成立**：用例只静态核对 `NODE_SHA256` 与锁文件一致，没有执行该分支。
5. **runbook 的 `contract_sha256` 是否与当前 `scripts/operations/ci-runner` 目录内容一致，未核实**：封存工具不在仓库内，无法离线重算；本次确实改了该目录下的 `prepare-arm.sh` 并更新了哈希（`docs/runbooks/ci-vps-runner-runbook.md:5`）。
6. **“ARM 三项检查现已全部通过”未核实**：本次无法访问 CI/ARM 机器。

---

## 未核实

- ARM 试跑 run 的实际通过记录与 semgrep/x64 的 99 秒实测值。
- `ci/toolchain-lock.json` 里 Node linux-arm64 sha256 与 nodejs.org 官方值是否一致（只核对了脚本常量与锁文件一致）。
- runbook 封存哈希、`validate_docs.py --strict` 的实际结果。
- 公开仓库 fork PR 的 GitHub 审批设置当前是否仍禁止外部 PR 自动运行。

---

## 侧重检查

- **prepare-arm 的不可信输入/错误路径**：脚本先检查 root、`Linux-aarch64`、Ubuntu 24.04、磁盘、内存、`/home` 权限（第 13-32 行），再下载。Node tarball 有 sha256 校验；下载/解压/npm 失败没有统一错误码，curl 无超时（见发现 5）。重复运行结构安全，但没有测试。
- **安全/供应链**：Node 有摘要校验；Playwright 只按版本安装后以 root 执行（发现 2）。ARM 试跑在公开仓库的自托管 runner 上跑 PR 代码（发现 1）。
- **资源耗尽**：semgrep 从 120 秒改为 15 分钟，仍小于 security 作业 60 分钟，也比外层 `run.mjs` 的剩余预算小；有界，但单次 semgrep 最坏会占用 runner 15 分钟。security-published 的 60 秒是每个用例的上限，3.8 MB chunk 确属 `syntheticFixtureEntries`（`ci/security-exceptions.json:1091-1126`），60 秒足够。
- **prod-read 测试的落盘改动**：`migratedDatabase()` 用 `synchronous=OFF`、`journal_mode=MEMORY` 并把 501 次插入包在一个事务里；两次测试都在 `spawnSync` 前 `database.close()`，子进程读到的是已提交的主库文件，测试语义不变；代价是进程崩溃时测试库可能损坏，但测试进程不用于持久化。
- **review-gateway 的“装不起来”路径**：新代码直接给不存在的 binary，`startGateway` 未调用 `binaryProblem`，`spawn` 失败后抛 `GATEWAY_START_FAILED`，`runningGatewayCount()===0`，与旧行为一致；手工 install 对象缺 `binarySha256` 在这条路径上没人读。
- **withHost 组合**：在 linux-x64 主机上默认值就是真实 x64，`withHost` 可覆盖为 arm64；在 linux-arm64 上默认模拟 x64，`withHost` 可覆盖；darwin 主机默认真实值。被 mock 的 6 个测试文件都通过 `vi.mock(platforms.mjs)` 生效，`contracts.mjs` 的 re-export 也会拿到 mock；`local.mjs` 等读取平台的地方都在函数体内，不会在模块加载时固化。当前两处使用 `withHost` 的文件没有 `concurrent` 测试，串行下状态不会泄漏；若未来加并发用例，模块级 `simulatedHost` 会互相影响（潜在问题，非当前缺陷）。
- **仍是 process.arch/platform 绕过 mock 的地方**：`install-dependencies.mjs:39`、`execute.mjs:15,20`（仅 win32 分支）；测试里直接按 `process.platform` 算期望值的地方（`quality-local.test.mjs:628,637`、`runner-orchestration.test.mjs:556,573,747,773,779`、`gate-lifecycle.test.mjs:202`）在 linux-arm64 上都得到 `linux-x64`，与默认 mock 一致；但如果将来在这些地方套 `withHost`，就会对不上。
- **规则/文档与代码一致性**：runbook 的“每个 PR（包括草稿）”与工作流一致；prepare-arm 的“可重复运行、不动 runner”基本成立但有 needrestart 边缘情况；`npm run check:platform-assumptions` 的清单新增 `"test/tooling/artifact-host.mjs": 1` 与文件里唯一的 `arch: "x64"`（`test/tooling/artifact-host.mjs:3`）匹配，检查器的 `arch-x64` 正则确实只命中这一处；policy 用例已同步为“试跑作业无 `if`”。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本轮 10 个提交没有改生产提示词组装、系统提示、工具定义、历史消息或出口遮盖；改动集中在 CI 脚本、runner 准备脚本、工作流、runbook 和测试。`e15cbb095` 只改了 `test/tooling/opencode-review.fixtures.mjs` 的测试断言。就这些路径而言，发给模型的内容仍只在末尾追加，每轮变化的值仍在最后一条消息里，系统提示/工具定义/历史/遮盖结果都不变（相关生产代码本轮未改，未重新跑检查）。注意：如果把合入 main 的提交也算进来，那些 `packages/prompt-catalog`、`apps/agent-service` 的改动未在本次核对范围内，未核实。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

生产侧不会：没有新增时间字段、无序集合、依赖前后文的遮盖或序列化格式变化。测试侧唯一的可变状态是 `artifact-host.mjs` 的模块级 `simulatedHost`，当前只在串行用例里使用；若将来这些文件改用 `concurrent`，会出现测试间平台串扰，但这不影响模型请求字节。prepare-arm 重复运行可能因无锁的 `npm install` 得到不同的传递依赖，这是环境可复现性问题，不是模型请求字节问题。

### 3. 有没有对应的自动检查，反向用例会不会失败？

- semgrep：有数值检查。常量改回 120000 会失败；但把 `scanSemgrep` 的 `timeout` 参数删掉不会失败（发现 3）。
- prepare-arm：静态文本检查。删掉 `NODE_VERSION`/`PLAYWRIGHT_VERSION`/`install-deps chromium` 会失败；把平台改成 linux-x64 不会失败；sha 不符退出 74、重复运行没有用例（发现 4/5）。
- host 平台：`withHost` 生效由 quality-local 的 linux-arm64 标签用例和 runner-orchestration 的拒绝 build/browser/coverage 用例反向覆盖，x64 主机上也能验证；旧的全局改 `process.arch` 只有在真实 ARM 上才会被新增的 `process.arch === 子进程` 用例抓到（作者已说明）。
- 草稿 PR：`policy.test.mjs:1290` 会抓住重新加回 `if`；同样地，它也会阻止未来加 fork 守卫，需要一并调整。
- c7a52/ea234/e15cbb/61211c3de 属测试加速、诊断或时限调整，没有新增反向用例；原有断言仍在。
- 平台写死清单：新增清单项由 `scripts/check-platform-assumptions.mjs` 的“多一处/少一处都失败”覆盖。

### 4. 每个新值/改动的两端是否都能接受？

逐个核对如下：

- `semgrepTimeoutMs`：产生处 `scripts/ci/check-security.mjs:46`，使用处同文件 `:534`，测试 `test/tooling/security.test.mjs:26,1010-1011`。两端类型/单位一致（毫秒），但测试没有校验使用处（发现 3）。
- `hostOs`/`hostArch`/`hostPlatform`：产生处 `scripts/ci/platforms.mjs:7-11`，经 `scripts/ci/contracts.mjs:8-12` re-export；使用处 `build.mjs:110/134`、`install-dependencies.mjs:153/284`、`install-tools.mjs:383/519`、`quality.mjs:57/58/177`、`resources.mjs:48/49`、`run.mjs:70/90/111/112/295/489/573`、`verify-artifact.mjs:147`、`local.mjs:26/30/40`。它们都期望 `${os}-${arch}` 字符串，且 `buildPlatformKey` 会按白名单校验；mock 包装保留了相同签名和默认值，两端可接受。
- `artifactPlatformKey`/`buildPlatformKey` 的默认参数：由 `process.*` 改为 `hostOs()/hostArch()`，真实主机行为不变；测试 mock 的默认值取同一个 `currentHost()`，两端一致。
- `scripts/platform-assumptions.json:108` 的 `"test/tooling/artifact-host.mjs": 1`：产生处是检查器扫描的正则 `arch-x64`，消费处是同一文件的比较逻辑；文件里唯一命中点是 `artifact-host.mjs:3` 的 `arch: "x64"`，计数一致。
- prepare-arm 的 `NODE_VERSION=22.22.3`、`NODE_SHA256=cc8bc82...`、`PLAYWRIGHT_VERSION=1.62.1`：消费处是 `prepare-arm.sh:43-49` 和测试 `ci-runner-scripts.test.mjs:2954-2959`；与 `ci/toolchain-lock.json:11-27`、`package.json:110` 一致。
- runbook 的 `contract_sha256`：产生处是外部封存工具，消费处是文档严格校验；本次改动触及被清单的 `scripts/operations/ci-runner` 目录，哈希已更新（`docs/runbooks/ci-vps-runner-runbook.md:5`），但无法离线重算，未核实。
- `ci-arm-trial.yml` 删除 `job.if`：生产端是 GitHub Actions，消费端是 `policy.test.mjs:1290`（已同步为 undefined）；两端一致，但没有消费端校验“只允许同仓库 PR”。
- `installedFileScanTimeoutMs`：只在 `test/tooling/security-published.test.mjs:434,478` 使用，Vitest 的 `it.each(name, fn, timeout)` 形式可接受；作用于包含 3.8 MB pi-coding-agent chunk 的 synthetic fixture 用例。
