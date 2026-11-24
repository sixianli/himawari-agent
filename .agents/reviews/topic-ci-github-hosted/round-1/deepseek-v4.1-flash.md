# 方案：全部 CI 迁到 GitHub 标准托管 runner

## 结论（先给答案）

推荐把 CI 改成：**标准 GitHub 托管 runner（`ubuntu-24.04` / `ubuntu-24.04-arm` / `macos-26`）+ 作业输出传结果摘要 + run-scoped Actions cache 传构建归档 + 不用 GitHub artifacts + 新增 macOS iOS 作业 + 静态收费防护检查**。

不保留 `run-share.mjs` 的共享目录，也不保留 `remote-share.mjs` 的 ssh 拉报告。这样既满足“公开仓库标准 runner 免费”，又避开 artifacts 存储是否免费的未核实问题；报告摘要核对和 `ci/required` 判定仍然保留，只是核对对象从“共享目录里的文件字节”变成“作业输出里的结果摘要 + 构建归档摘要的跨作业一致”。

---

# 一、方案依赖的前提（附来源与原话）

| # | 前提 | 来源 | 原话 / 事实 | 性质 |
|---|---|---|---|---|
| 1 | 公开仓库标准 runner 免费，larger runner 收费 | https://docs.github.com/en/billing/concepts/product-billing/github-actions | “The following usage remains free independently… Standard GitHub-hosted runners in public repositories.”；“Larger runners are billed for public repositories.” | 已核实 |
| 2 | 标准托管 runner 的标签和规格 | https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job | “Use of the standard GitHub-hosted runners is free and unlimited on public repositories.”；`ubuntu-24.04` 4C/16 GB、`ubuntu-24.04-arm` 4C/16 GB、`macos-26` 3C/7 GB | 已核实 |
| 3 | 免费并发 20、macOS 最多 5、单作业 6 小时 | https://docs.github.com/en/actions/reference/limits | “Total concurrent jobs 20”“Maximum concurrent macOS jobs 5”“Job execution time 6 hours” | 已核实 |
| 4 | 自托管 runner 不适合公开仓库 | https://docs.github.com/en/actions/reference/security/secure-use | “self-hosted runners should almost never be used for public repositories”；“GitHub-hosted runners execute code within ephemeral and clean isolated virtual machines” | 已核实 |
| 5 | artifacts 存储在公开仓库是否免费，文档没有明确说 | https://docs.github.com/en/billing/concepts/product-billing/github-actions | 存储计费写在“For private repositories…”下面；公开仓库只明确说标准 runner 免费；存储表仍列 GitHub Free 500 MB | **未核实**，所以本方案不依赖 artifacts |
| 6 | Actions cache 每仓库 10 GB 免费，超出收费；PR 的缓存只对本次 PR 的 merge ref 可见；缓存内容不签名 | https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching | “By default, the limit is 10 GB per repository… Any usage beyond 10 GB is billed”；“When a cache is created by a workflow run triggered on a pull request, the cache is created for the merge ref… can only be restored by re-runs of the pull request.”；“Cache contents are not signed or verified” | 已核实 |
| 7 | 作业输出每个作业最多 1 MB，整轮最多 50 MB | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax | “Outputs can be a maximum of 1 MB per job. The total of all outputs in a workflow run can be a maximum of 50 MB.” | 已核实 |
| 8 | `macos-26` 默认 Xcode 26.6，带 iPhone 16e 模拟器 | https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-26-arm64-Readme.md | “Xcode 26.6 (default)”；Installed Simulators 列有 iPhone 16e | 已核实 |
| 9 | 当前 CI 全部作业跑在自托管标签上 | `.github/workflows/ci.yml:33,72,124,314,357,400`；`ci/policy.json:13,30,47,54,71,79,87,104,113,122,139,156,173` | `runs-on: ci-arm`、`ci-vps`、`ci-vps-gate`；policy 成员 `"runner": "ci-arm"` 等 | 已核实 |
| 10 | 当前作业间传文件靠共享目录 + ssh | `scripts/ci/run-share.mjs:27-33`、`:125-144`；`scripts/ci/remote-share.mjs:15,35-48,158-189`；`.github/workflows/ci.yml:436` | `HIMAWARI_CI_SHARE`、`--remote-jobs policy,static,tooling,security`、`/etc/gh-runner/remote-share` | 已核实 |
| 11 | 当前依赖缓存是 runner 主机上的持久 `~/.cache/himawari-ci/npm` | `scripts/ci/install-dependencies.mjs:61-78,81` | `runnerNpmCache()`、`value === "runner"`、`join(home, ".cache", "himawari-ci", "npm")` | 已核实 |
| 12 | 沙箱测试需要 bubblewrap/socat/ripgrep 和 AppArmor 放开 bwrap 的 userns | `scripts/operations/ci-runner/prepare-vps.sh:25,45-58` | `apt-get install … bubblewrap socat ripgrep apparmor-utils`；写入并加载 `/etc/apparmor.d/bwrap` | 已核实 |
| 13 | 当前一次完整 main 运行约 46–50 分钟，tests 段约 36 分钟 | `.agents/evidence/ci-runs-2026-11-15.md:23-27`；`.agents/evidence/ci-speedup-lessons.md:62-70` | “共约 46 分钟”“tests 段…约 36 分钟”；拆分后 integration-1 17 分钟、integration-2 25 分钟、others 16 分钟 | 已核实（历史数据） |
| 14 | iOS 构建入口和缓存脚本已存在 | `clients/apple/scripts/xcode-build.sh:7-17`；`clients/apple/scripts/xcode-cache.sh:1-38`；`clients/apple/README.md:47,54-61,113`；`clients/apple/Package.swift:1,96` | `xcode-build.sh ios <xcodebuild 参数>`；`swift test`；`swift-tools-version: 6.2`；`platforms: [.iOS(.v26), …]` | 已核实 |
| 15 | I-112 目前没有通用自动门槛 | `docs/incidents-and-gates.md:147` | “通用门槛还没有：苹果端改动必须在 Mac 上编译通过才合并…”“缺门槛” | 已核实 |
| 16 | 模型请求只追加、字节确定性的规则 | `.agents/instructions/prompt-prefix.md:36,53-54,86-90` | “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”；“同样的内容，每次都要序列化成同样的字节。” | 已核实 |

---

# 二、方案

## 2.1 总体数据流

```
每个检查作业：
  checkout → 恢复 npm/tool cache → 安装工具/依赖 → run.mjs
  → publish.mjs（脱敏）→ result-output put（把结果摘要写进作业输出）
  → ci-summary（失败诊断写作业摘要）

build 作业额外：
  → actions/cache/save 把 .ci-output/build-output 存成 run-scoped 缓存

browser/tests 作业：
  → actions/cache/restore 取 .ci-output/build-output（fail-on-cache-miss）
  → run.mjs --input .ci-output/build-output/result.json

ci/required：
  entry 检查（草稿/取消）
  → result-output collect（从 CI_NEEDS 解码各作业输出，写成 result.json + evidence.json）
  → required.mjs / aggregate.mjs（原有判定逻辑）
  → 不再 remove 共享目录
```

关键点：

- **不再有共享目录、ssh、`HIMWARI_CI_SHARE`、`HIMWARI_CI_REMOTE_SHARE`。**
- **不再使用 `actions/upload-artifact` / `download-artifact`。**
- **报告摘要核对**：`result-output put` 计算报告清单的 SHA-256（`result.reports` 的 path/sha256/bytes 排序后序列化），写进作业输出；`result-output collect` 解码后核对摘要与 `result.reports` 一致，再交给 `required.mjs`。
- **构建归档核对**：build 作业输出 `produced` 的 sha256；browser/tests 从缓存取归档后重新计算 sha256，输出 `consumed`；`aggregate.mjs` 仍检查 `consumed === produced`（`aggregate.mjs:218-235` 的逻辑保留）。
- 报告字节的独立核对改为“作业输出信任边界”。理由：GitHub-hosted runner 是临时干净 VM（前提 4），作业之间没有可写的共享目录；作业输出由 GitHub 在本次运行内传递，外部 PR 不能改写。这与原来“共享目录可被同组 runner 改写，所以必须核对字节”的威胁模型不同。

## 2.2 每个作业放在哪种 runner

| 作业 | runner | 理由 |
|---|---|---|
| `policy` | `ubuntu-24.04-arm` | 不依赖 x64 产物；保留 ARM 工具链覆盖；当前就在 `ci-arm` |
| `static` | `ubuntu-24.04-arm` | 同上；Chromium 在 arm64 可用 |
| `tooling` | `ubuntu-24.04-arm` | 同上 |
| `security` | `ubuntu-24.04-arm` | gitleaks/semgrep 锁文件已有 darwin/linux arm64 wheel |
| `build` | `ubuntu-24.04` | `artifactPlatformKey()` 只支持 `linux-x64` / `macos-arm64`（`scripts/ci/platforms.mjs:15-22`），必须 x64 |
| `browser/chromium`、`browser/firefox`、`browser/webkit` | `ubuntu-24.04` | 消费 x64 构建 |
| `tests/*` | `ubuntu-24.04` | 消费 x64 构建；4C/16 GB 足够 |
| `apple`（新增） | `macos-26` | 唯一有 Xcode 26.6 和 iPhone 模拟器的标准 runner |
| `required` | `ubuntu-24.04` | 只做汇总，不再需要专用 gate 机器 |
| `main.yml` 的 `plan` / `confirm` | `ubuntu-24.04` | `main-confirm` 需要 Docker/沙箱，Ubuntu 标准 runner 具备 |
| `merge-queue.yml` | `ubuntu-24.04` | 只跑 Node 脚本和 git |
| `pr-closed.yml` | `ubuntu-24.04` | 作业本身因 `if` 恒假被跳过，只借并发组取消旧运行 |
| `quality.yml` | `ubuntu-24.04` | 现在已经是（`scripts/ci/quality-policy.mjs:111-152`），不改 |

## 2.3 作业拆分（分两步，先迁移再提速）

**第 1 步（迁移 PR）：保持现有 8 个检查作业的形状，只加 `apple`，共 9 个作业。**

- `tests` 仍是 `integration-1`、`integration-2`、`others` 三个成员。
- 托管 runner 上三个成员在 build 结束后同时开始，不再出现 integration-1 等 15 分钟的情况；按历史数据 tests 段从 36 分钟降到约 25 分钟，整轮约 35 分钟。

**第 2 步（提速 PR，可选）：把 `tests` 拆成 7 个成员。**

- `integration-1/2/3`（shard count 3）+ `unit` + `contracts` + `e2e` + `pi-compat`。
- 加上 `policy`、`static`、`build`、`browser×3`、`tooling`、`security`、`apple`、`required`，共 17 个作业，低于 20 并发。
- 预计 tests 段降到约 12–16 分钟，整轮约 25–30 分钟。`static`（约 18 分钟）会成为新的关键路径；如果还要更快，再单独出方案拆 `static`，不在这次迁移里做。

> 这一步会改动 `ci/policy.json` 的 `tests.members`、`check-policy.mjs` 的 `testsMembers`、`ci.yml` 的 matrix、以及 `policy.test.mjs` / `ci-optimization.test.mjs` 的大量断言。建议迁移 PR 先做第 1 步，合并并观察一次真实运行后再做第 2 步。

## 2.4 作业之间怎么传文件

### 结果摘要：作业输出（替换 `run-share.mjs put/get/collect/remove`）

新增 `scripts/ci/result-output.mjs`：

- `put --name <check>-<matrix> --from .ci-output/public/reports --output-key <matrix>`
  - 读 `.ci-output/public/reports/result.json`；
  - 用 `collectArtifactFiles()`（`artifact-files.mjs:20-72`）计算报告清单摘要；
  - 把 `{schemaVersion:1, result, reportDigest}` 用 base64 写进 `$GITHUB_OUTPUT` 的 `<output-key>`。
- `collect --to .ci-output/reports --base "$CI_BASE"`
  - 从 `CI_NEEDS`（`toJSON(needs)`）读每个作业成员的 `outputs.<member>`；
  - 解码、校验 `result` 符合 `CheckResult` schema、`reportDigest` 与 `result.reports` 一致；
  - 写 `.ci-output/reports/<job>-<member>/result.json` 和同目录 `evidence.json`（内容就是 `result.reports`）。
- `required.mjs` 保持读 `--reports` 目录；`aggregate.mjs` 的 `readReportEnvelopes()` 增加：如果目录里有 `evidence.json`，用它作为 `envelope.artifacts`，否则沿用原来的“读文件字节”路径。这样现有 `gate-lifecycle.test.mjs` 的文件路径用例不用全部重写。

### 构建归档：run-scoped Actions cache（替换 `run-share get`）

- build 作业：
  - `run.mjs --output .ci-output/build-output`（把 result.json 和归档放在同一个目录）；
  - `publish.mjs --input .ci-output/build-output --output .ci-output/public`；
  - `result-output put …`；
  - `actions/cache/save`：`path: .ci-output/build-output`，`key: ci-build-${{ github.run_id }}-${{ github.run_attempt }}-linux-x64`。
- browser/tests 作业：
  - `actions/cache/restore`：同一 `path`、同一 `key`，`fail-on-cache-miss: true`；
  - `run.mjs --input .ci-output/build-output/result.json`（`run.mjs:607-622` 会重新核对 producer 身份和归档 sha256）。

这样：
- 不需要 artifacts；
- 缓存 key 带 `run_id`/`attempt`，不会误用旧构建；
- 消费者重新计算 sha256，篡改缓存会失败；
- 缓存只在本 PR 的 merge ref 内可见（前提 6）。

### 报告和诊断

- 完整报告仍只在本作业的 `.ci-output/public` 里，`ci-summary.mjs` 在本作业内读它写作业摘要；作业结束即丢弃。
- 失败诊断仍按 `ci-summary.mjs` 的 64 KiB 上限、40/120 行、脱敏规则写作业摘要。
- 不再有“汇总作业结束后删除共享目录”的步骤；GitHub 自动清理作业输出。

## 2.5 缓存怎么做

| 缓存 | 路径 | key | 说明 |
|---|---|---|---|
| npm 依赖 | `.ci-output/npm-cache` | `npm-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}`，`restore-keys: npm-${{ runner.os }}-${{ runner.arch }}-` | `install-dependencies.mjs --cache .ci-output/npm-cache`；`npm ci` 仍按 lock 校验 integrity |
| 工具下载 | `.ci-output/tool-cache` | `tools-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('ci/toolchain-lock.json') }}` | 通过 `HIMAWARI_CI_CACHE_DIR` 指给 `install-tools.mjs`；下载物仍按 sha256 校验 |
| 构建归档 | `.ci-output/build-output` | `ci-build-${{ github.run_id }}-${{ github.run_attempt }}-linux-x64` | run-scoped；消费者 `fail-on-cache-miss: true` |
| Playwright 浏览器 | 暂不缓存 | — | 每作业只装一个引擎；先测，避免 10 GB 超限 |
| Xcode/SwiftPM | 暂不缓存 | — | 先测；如加，key 用 `Package.swift` + `project.pbxproj` + `Package.resolved`，只缓存 `.build`/`SourcePackages`，不缓存整个 DerivedData |

**预算**：10 GB 是硬上限（前提 6）。npm + 工具缓存约 1 GB 以内；构建归档按当前 runtime 归档大小估算远小于 9 GB。上线后要监控 cache 使用量；如果构建归档频繁触发 LRU 驱逐，再考虑把归档改成更小的压缩包或只保留 runtime 必需文件。**不调高缓存上限。**

`ci/toolchain-lock.json` 要新增 `actions/cache/restore` 和 `actions/cache/save`（完整 SHA，不用标签），并同步修改 `scripts/ci/install-tools.mjs:172-177` 的 `expectedActions`。这是必须两端一起改的值，见必答问题 4。

## 2.6 iOS 作业怎么写

新增 `apple` 作业，`ci/policy.json` 中：

```json
{
  "id": "apple",
  "needs": ["policy"],
  "timeoutMinutes": 60,
  "members": [
    { "key": "macos-arm64", "runner": "macos-26", "os": "darwin", "arch": "arm64", "node": "22.22.3" }
  ],
  "projects": [],
  "outputs": ["json"]
}
```

> 成员 key 必须用 `macos-arm64`，不能写 `ios`。原因：`validatePolicy()` 用 `member.key === "macos-arm64"` 判断 macOS 成员（`check-policy.mjs:442`），不是用 `os`。用 `ios` 会被当成 Linux 成员而拒绝。这是 I-73 那类“产生值的两端校验不一致”的典型点。

`ci.yml` 中的作业：

```yaml
apple:
  name: apple / ${{ matrix.key }}
  if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft != true }}
  runs-on: macos-26
  needs: [policy]
  timeout-minutes: 60
  strategy:
    fail-fast: false
    matrix:
      include:
        - key: macos-arm64
          runner: macos-26
          os: darwin
          arch: arm64
          node: 22.22.3
  env:
    CI_NODE: ${{ matrix.node }}
    CI_MATRIX: ${{ matrix.key }}
    CI_BASE: ${{ inputs.base_sha || '' }}
  steps:
    - uses: actions/checkout@<sha>
      with: { fetch-depth: 0, persist-credentials: false }
    - uses: actions/setup-node@<sha>
      with: { node-version: ${{ matrix.node }} }
    - run: node scripts/ci/install-tools.mjs --directory .ci-output/tools --node "$CI_NODE" --without-scanners
    - run: .ci-output/tools/bin/node scripts/ci/run.mjs --check apple --matrix "$CI_MATRIX" --base "$CI_BASE" --tools .ci-output/tools --output .ci-output/check
    - run: .ci-output/tools/bin/node scripts/ci/publish.mjs --input .ci-output/check --output .ci-output/public --tools .ci-output/tools
      if: always()
      id: publish
      env: { HIMAWARI_CI_GITHUB_TOKEN: ${{ github.token }} }
    - run: .ci-output/tools/bin/node scripts/ci/result-output.mjs put --name "apple-$CI_MATRIX" --from .ci-output/public/reports --output-key "$CI_MATRIX"
      id: share
      if: ${{ always() && steps.publish.outcome == 'success' }}
    - run: .ci-output/tools/bin/node scripts/ci/ci-summary.mjs --title "apple/$CI_MATRIX 失败诊断" --from .ci-output/public/diagnostics --failed-logs .ci-output/public/reports
      if: ${{ always() && steps.publish.outcome == 'success' }}
```

`run.mjs` 增加 `apple` 分支（或在 `runCheck` 里调用新的 `runApple`）：

```text
swift test --package-path clients/apple --scratch-path .ci-output/apple/.build
clients/apple/scripts/xcode-build.sh ios \
  -project App/Himawari.xcodeproj -scheme Himawari \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build
```

- 不签名：`CODE_SIGNING_ALLOWED=NO`；不存任何密钥。
- `swift test` 在 macOS 上编译 `HimawariCore` 及界面测试目标（`Package.swift:21-90`），能跑单元测试。
- `xcode-build.sh` 强制使用 `HIMAWARI_APPLE_CACHE`/`~/Library/Caches/himawari/DerivedData/ios`，不允许调用方传 `-derivedDataPath`（`xcode-build.sh:10-12`）。
- `result.counts` 记 2 个检查（`swift test`、`xcodebuild build`），`projects: []`，`reports` 含 `apple.json` + 两个日志；`publish.mjs` 脱敏后 `result-output put`。
- 这一作业同时满足 I-112：任何苹果端编译错误都会在合并前让 `apple/macos-arm64` 失败，`ci/required` 随之失败。

**未核实**：`swift test` 在 `macos-26` 上首次运行要下载 FluidAudio/swift-crypto，耗时未知；`xcodebuild` 在 3C/7GB 上编译整个 App + 扩展的耗时未知。需要在迁移分支上实测一次，必要时把 `swift test` 和 `xcodebuild` 拆成两个 `macos-26` 作业并行（macOS 并发上限 5，够用）。

## 2.7 收费防护检查怎么做

新增 `scripts/ci/check-hosted-costs.mjs`，在 `npm run check:ci-policy`（`policy` 作业）里运行：

1. 扫描 `.github/workflows/*.yml`（含 `quality.yml`、`main.yml`、`merge-queue.yml`、`pr-closed.yml`）。
2. 展开每个 `runs-on`：
   - 字符串：必须在白名单 `["ubuntu-24.04", "ubuntu-24.04-arm", "macos-26"]`；
   - 数组：每个元素都必须在白名单；
   - `{ group: ... }`：直接拒绝（larger/self-hosted 组）；
   - `{ labels: ... }`：labels 必须在白名单；
   - `${{ matrix.runner }}`：只允许这一种表达式，并检查对应 matrix `include` 的每个 `runner` 值；
   - 其他 `${{ ... }}`：拒绝（无法证明免费）。
3. 拒绝 `actions/upload-artifact@`、`actions/download-artifact@`（保留 I-95 门槛）。
4. 对 `actions/cache` / `actions/cache/restore` / `actions/cache/save`：
   - `path` 必须在 `.ci-output/` 下（构建缓存、npm、工具缓存、Apple 缓存都放这里）；
   - `key` 必须以 `ci-`、`npm-`、`tools-` 开头；
   - 构建缓存必须用 `actions/cache/restore` + `fail-on-cache-miss: true`，且不能带 `restore-keys`（防止误用旧构建）。
5. 拒绝任何 `pull_request` 触发的 workflow 出现 `permissions: write` 或 `secrets.`（外部 PR 不得拿写权限/密钥）。
6. 保留现有 `validateWorkflow()` / `validatePolicy()` / `validateQualityWorkflow()` 的 runner 校验；新检查是第二道闸。

反向用例（写在 `test/tooling/policy.test.mjs` 或新文件 `test/tooling/hosted-costs.test.mjs`）：

| 反向夹具 | 期望 |
|---|---|
| `runs-on: ubuntu-24.04-8core` | 失败 |
| `runs-on: [self-hosted, linux]` | 失败 |
| `runs-on: { group: larger-runners }` | 失败 |
| `runs-on: macos-15` | 失败（不在白名单；如果将来要允许，必须显式改白名单并走审查） |
| `runs-on: windows-2025` | 失败 |
| `runs-on: ${{ inputs.runner }}` | 失败 |
| `uses: actions/upload-artifact@...` | 失败 |
| `uses: actions/cache@...` + `path: node_modules` | 失败 |
| `uses: actions/cache/restore@...` 带 `restore-keys` 的构建缓存 | 失败 |
| 合法：`ubuntu-24.04` / `ubuntu-24.04-arm` / `macos-26` + `.ci-output` 缓存 | 通过 |

“反向用例是否真的会失败”：测试直接断言上面的夹具抛错；在未加检查的版本上，这些夹具会通过，所以测试是红的。**未执行验证**（本次只读），实施时必须先让反向用例在旧代码上红、加检查后绿。

## 2.8 要改和要删的文件清单

### 必改

| 文件 | 改什么 |
|---|---|
| `.github/workflows/ci.yml` | 9 个作业的 `runs-on`；`--cache .ci-output/npm-cache`；build 用 `.ci-output/build-output` + cache save；browser/tests 用 cache restore + `--input .ci-output/build-output/result.json`；`run-share` 步骤换成 `result-output`；去掉 `remove`；新增 `apple` 作业；`required` 的 `needs` 加 `apple`；沙箱准备步骤 |
| `.github/workflows/main.yml` | `runs-on: ubuntu-24.04`；`--cache .ci-output/npm-cache`；加 npm 缓存 restore；`confirm` 加沙箱准备 |
| `.github/workflows/merge-queue.yml` | `runs-on: ubuntu-24.04` |
| `.github/workflows/pr-closed.yml` | `runs-on: ubuntu-24.04` |
| `.github/workflows/quality.yml` | 无需改 runner；如加缓存，按新规则 |
| `ci/policy.json` | runner 标签；新增 `apple`；`required.needs` 加 `apple`；（第 2 步）tests 成员拆成 7 个 |
| `ci/policy.schema.json` | `runner` enum 改为 `["ubuntu-24.04", "ubuntu-24.04-arm", "macos-26"]` |
| `ci/toolchain-lock.json` | 新增 `actions/cache/restore`、`actions/cache/save` 的完整 SHA + license |
| `scripts/ci/contracts.mjs` | `linuxRunnerLabel = "ubuntu-24.04"`、`gateRunnerLabel = "ubuntu-24.04"`、`armRunnerLabel = "ubuntu-24.04-arm"` |
| `scripts/ci/check-policy.mjs` | `jobIds` 加 `apple`；`expectedNeeds` 加 `apple`；`validatePolicy` 加 apple 的 member key/项目/时限；新增 `upgradeSelfHostedToHosted` 升级函数（把旧 8 作业自托管策略升级成新 9 作业托管策略，含 apple 和第 2 步 tests 拆分）；`validateWorkflow` 的 share 步骤改为 `result-output`；build fetch 改为 cache restore；apple 的校验 |
| `scripts/ci/install-tools.mjs` | `validateToolchainLock` 的 `expectedActions` 加 cache 动作 |
| `scripts/ci/install-dependencies.mjs` | 删除 `runnerNpmCache` 和 `--cache runner` 分支；`--cache` 一律走 `.ci-output` 内的路径 |
| `scripts/ci/run.mjs` | 新增 `apple` 分支（`swift test` + `xcodebuild`）；`build` 输出目录由调用方决定，无需改逻辑 |
| `scripts/ci/aggregate.mjs` | `readReportEnvelopes` 支持 `evidence.json`（作业输出摘要路径）；保留原有字节路径 |
| `scripts/ci/main-workflow.mjs` | 自动跟随 `linuxRunnerLabel`；无需硬编码改动，但测试里的 `ci-vps` 字符串要改 |
| `docs/incidents-and-gates.md` | I-112 状态改为“已落门槛”，门槛写 `.github/workflows/ci.yml` 的 `apple` 作业 + `scripts/ci/run.mjs` + `test/tooling/...`；I-95 保持“无 artifacts”；I-73 作为本次两端核对的依据 |
| `docs/runbooks/ci-vps-runner-runbook.md` | 删除或改为“自托管 runner 已退役”的说明 |
| `docs/adr/0238`、`0243`、`0256`、`0266`、`0267`、`0275`、`0174` | 新 ADR 取代“共享目录/专用 gate/ARM/三份 tests/不用 GitHub cache”的旧决定；`0243` 的“不用 artifacts”保留 |
| `test/tooling/ci-optimization.test.mjs` | 作业数 8→9（第 2 步 17）；`usesGitHubCache` 改为“允许 cache、禁止 artifacts”；`run-share` 步骤改为 `result-output`；`runs-on` 字符串改 `ubuntu-24.04`；`[I-93]` 夹具不变 |
| `test/tooling/policy.test.mjs` | `validatePolicy` 的 8→9；`validateWorkflow` 的 jobs/members 计数；`sharePut`/`shareCollect`/`shareRemove` 改 `result-output`；新增 apple 升级/反向用例；保留 `[I-95]` artifacts 拒绝 |
| `test/tooling/gate-lifecycle.test.mjs` | `publishers` 7→8；`gateFixture` 自动跟随 policy；`required` 测试保持 |
| `test/tooling/pr-closed-cancel.test.mjs` | 只读 ci.yml 的并发组，runner 改动不影响；如需改 `evaluateCiGroup` 无 |
| `test/tooling/merge-queue.test.mjs` | 不检查 runner 标签，只检查 workflow 形状；无需改 |
| `test/tooling/run-share.test.mjs` | 改名为 `result-output.test.mjs`，删共享目录/umask/ssh 用例，加作业输出编码/解码/摘要核对用例 |
| `test/tooling/remote-share.test.mjs` | 删除 |
| `test/tooling/ci-runner-scripts.test.mjs` | 删除（脚本已删） |
| `test/tooling/runner-orchestration.test.mjs` | 如 `runCheck` 新增 apple，补 apple 分支用例；现有用例的 `hosted` 逻辑不变 |

### 新增

- `scripts/ci/result-output.mjs`（作业输出摘要）
- `scripts/ci/check-hosted-costs.mjs`（收费防护）
- `scripts/ci/prepare-sandbox.sh`（bubblewrap/socat/ripgrep + AppArmor，替代 `prepare-vps.sh` 的 CI 部分）
- `test/tooling/result-output.test.mjs`
- `test/tooling/hosted-costs.test.mjs`（或并入 `policy.test.mjs`）
- `test/tooling/prepare-sandbox.test.mjs`（用假 `sudo`/`apparmor_parser` 验证幂等和失败路径）
- `test/tooling/fixtures/ci-policy/self-hosted-eight-jobs.json`（升级函数夹具）
- 新 ADR：`docs/adr/02xx-ci-on-github-hosted-runners.md`

### 删除

- `scripts/ci/run-share.mjs`
- `scripts/ci/remote-share.mjs`
- `scripts/operations/ci-runner/` 整个目录（`prepare-vps.sh`、`runners.sh`、`install-*.sh`、`register-runner.sh`、`uninstall-runner.sh`、`pause-runners.sh`、`resume-runners.sh`、`gate-fallback.sh`、`arm-fallback.sh`、`send-reports.py`、systemd/slice 文件等）
- `test/tooling/ci-runner-scripts.test.mjs`
- `test/tooling/remote-share.test.mjs`
- `docs/runbooks/ci-vps-runner-runbook.md`（或归档）
- 所有对 `HIMAWARI_CI_SHARE`、`HIMAWARI_CI_REMOTE_SHARE`、`--remote-jobs`、`--cache runner` 的引用

## 2.9 迁移步骤（分步合并，避免 main 长时间无 CI）

1. **准备 PR（不改变现有 CI 行为）**
   - 加 `result-output.mjs`、`check-hosted-costs.mjs`、`prepare-sandbox.sh`、apple 的 `run.mjs` 分支、测试和 ADR。
   - 这一步不改 `ci.yml`/`policy.json`；旧 CI（如果 runner 还在）仍能跑。如果 runner 已经删了，这一步只作为代码准备，不依赖 CI。

2. **迁移 PR（关键切点）**
   - 一次性改 `ci.yml`、`main.yml`、`merge-queue.yml`、`pr-closed.yml`、`ci/policy.json`、`policy.schema.json`、`contracts.mjs`、`check-policy.mjs`、`install-dependencies.mjs`、`toolchain-lock.json`，并加 `apple` 作业。
   - 以 **ready for review 的同仓库 PR** 形式测试：GitHub 对同仓库 PR 使用 PR head 里的 workflow，所以这个 PR 本身就会跑新的托管 CI；草稿状态会走 `CI_DRAFT_UNVERIFIED`，标成 ready 后跑完整检查。
   - 如果 PR 通过，合并；main 立即得到新的托管 CI。
   - 这一步**不要**先删旧脚本；旧脚本可以在合并后删，避免 PR 里同时改行为和删文件导致回滚困难。

3. **清理 PR**
   - 删 `scripts/operations/ci-runner/`、`run-share.mjs`、`remote-share.mjs`、相关测试、runbook；更新 ADR/文档；更新 I-112 为“已落门槛”。

4. **提速 PR（可选）**
   - tests 拆成 7 个成员；按真实运行数据调整 integration 分片数；再决定是否拆 `static`。

5. **缓存优化 PR（可选）**
   - 加 npm/tool/Apple 缓存；监控 10 GB 使用量；不调高上限。

**如果旧 runner 已经全部删除、main 当前没有 CI**：第 2 步的 PR 本身就是 main 的 CI 来源；在它合并前，main 没有 CI 是不可避免的。为了缩短空窗，可以先合一个最小的 `ci-hosted.yml`（只跑 `policy` + `npm run check` + `tests`，不要求完整 policy），让 main 先有基本 CI，再合完整迁移 PR，最后删掉这个临时 workflow。这个取舍需要 Andy 拍板（见 2.10）。

## 2.10 风险、反例、需要人拍板的取舍

### 风险

1. **构建归档缓存被驱逐/写失败**：`actions/cache` 的 save 失败通常只是 warning；消费者 `fail-on-cache-miss: true` 会让 CI 失败并提示重跑。反例：build 成功但 cache 未保存，browser/tests 全部在 restore 步骤失败。缓解：build 后立即 save；消费者失败信息明确；必要时重跑。
2. **10 GB 缓存超限**：npm + 工具 + 构建归档 + Apple 缓存可能接近上限；超出会按 LRU 驱逐，可能驱逐活跃构建。缓解：先不缓存 Playwright/Xcode；监控使用量；构建归档只保留必要文件；不调高上限。
3. **macOS 队列**：macOS 最多 5 并发，且高需求时启动慢（前提 3/8）。apple 作业可能成为关键路径。缓解：让 apple 尽早开始（`needs: []` 或只等 policy）；实测后决定是否拆成两个 macOS 作业。
4. **沙箱环境在托管 runner 上未实测**：`bubblewrap`/AppArmor 在 `ubuntu-24.04` 托管镜像上的行为需要实测；如果 `apparmor_parser` 被限制，`tests` 会失败。缓解：`prepare-sandbox.sh` 先检查再配置；失败时打印明确错误；在迁移 PR 上实测。
5. **报告字节不再独立核对**：这是有意的语义变化。反例：某个作业伪造 `result.json` 和 `evidence.json` 声称通过。缓解：`needs.<job>.result` 仍由 GitHub 判定；作业输出由 GitHub 在本次运行内传递；外部 PR 无写权限；构建归档仍由消费者独立重算 sha256。这个取舍需要 Andy 明确同意。
6. **升级函数漏掉旧策略形状**：迁移 PR 的 base 是旧自托管 8 作业策略；如果 `upgradeSelfHostedToHosted` 只认一种形状，`resolvePolicySource` 会拒绝，PR 的 policy 检查失败。缓解：用当前 `ci/policy.json` 做夹具，测试旧策略升级；保留旧升级链；混合写法必须失败。

### 需要人拍板的取舍

1. **是否接受“作业输出摘要 + 构建归档摘要”替代“报告字节独立核对”**。如果不接受，只能回到 GitHub artifacts（成本未核实）或自托管共享目录（已退役），两者都不满足约束。
2. **是否允许使用 GitHub Actions cache**。`docs/adr/0174` 目前禁止 GitHub cache；本方案需要新 ADR 修订。缓存 10 GB 内免费，但超出会计费。
3. **迁移期间是否先加一个临时 hosted workflow 保 main 的 CI**。这会影响“迁移 PR 前 main 的空窗长度”。
4. **tests 是否在迁移 PR 里就拆成 7 份**，还是先保持 3 份、合并后再拆。前者更快但测试改动大；后者更稳。
5. **apple 作业是否 `needs: [policy]`**。`needs: [policy]` 更符合现有“policy 先过”的语义，但会晚 3–5 分钟；`needs: []` 更快，但 policy 失败时仍会浪费 macOS 时间（免费）。

---

# 三、考虑过但不选的做法

| 做法 | 为什么不选 |
|---|---|
| **用 `actions/upload-artifact` / `download-artifact` 传报告和构建** | 公开仓库 artifacts 存储是否免费文档没明说（前提 5）；I-95 已经因 artifacts 额度出过事故；约束是“绝不产生费用”。 |
| **保留共享目录，只把 runner 换成 GitHub 托管** | 托管 runner 是每作业一台新 VM，没有跨作业共享目录；`run-share.mjs` 会以 `CI_SHARE_ROOT_REQUIRED` 失败（`run-share.mjs:27-33`）。 |
| **每个 browser/tests 作业自己重新 build** | 避免传构建归档，但 build 不是可复现的（`build.mjs:115` 写入 `generatedAt`、归档名含 runId/attempt），而且 6–8 个作业重复 build 会浪费关键路径时间；也失去“消费者用的是 build 作业那份归档”的跨作业核对。 |
| **用 cache 传所有报告，保留逐字节核对** | 每个作业一个 cache key，gate 要逐个 restore；18 个作业需要 18 个 restore 步骤，或者写自定义 action 调 `@actions/cache`；复杂度和 10 GB 压力都高。作业输出 1 MB/作业足够放 result.json，报告本身又不需要跨作业保留。 |
| **只改 `runs-on`，保留 `run-share`/`remote-share`** | 托管 runner 没有共享目录和 ssh 目标；必然失败。 |
| **iOS 在 Linux 上交叉编译 / 用 Swift Linux 容器** | `Package.swift` 的界面目标只在苹果系统编译（`Package.swift:21-90`），`xcodebuild` 需要 Xcode；Linux 编不了 iOS App。 |
| **用 larger runner 或调高缓存上限** | 直接违反“不在 GitHub 上花钱”。 |
| **把汇总作业放在 `ubuntu-slim`** | 1C/5 GB，且 `ubuntu-slim` 是容器、无 sudo，`install-tools`/`install-gate-dependencies` 和 `node_modules` 可能吃紧；标准 `ubuntu-24.04` 免费且更稳。 |
| **继续用自托管 runner** | 公开仓库安全上不推荐（前提 4），且机器已退租/改生产。 |

---

# 四、读代码或来源证实的 vs 推测

## 已证实（读代码/官方文档）

- 公开仓库标准 runner 免费，larger runner 收费；标准标签和规格；并发 20/5；6 小时作业上限。
- 自托管 runner 不适合公开仓库；托管 runner 是临时干净 VM。
- cache 10 GB 免费、超出收费、PR 缓存只对 merge ref 可见、缓存内容不签名。
- 作业输出 1 MB/作业、50 MB/轮。
- `macos-26` 默认 Xcode 26.6，带 iPhone 16e 模拟器。
- 当前 CI 的作业、runner 标签、共享目录、ssh、`--cache runner`、沙箱准备脚本的位置和行为。
- `run.mjs` 的 build/browser/tests 数据流、`aggregate.mjs` 的构建归档一致性检查、`required.mjs` 的判定逻辑。
- `validatePolicy` 用 `member.key === "macos-arm64"` 识别 macOS 成员；`validateWorkflow` 要求非 required 作业有 share 步骤和 ci-summary；`validateToolchainLock` 硬编码三个 actions；`quality-policy.mjs` 已用 `ubuntu-24.04`。
- I-112 当前“缺门槛”；I-73 的教训是只检查改动本身、不核对值的两端。
- `prompt-prefix.md` 的只追加和字节确定性规则。

## 推测 / 未核实

- 托管 `ubuntu-24.04` 上 `bubblewrap`/`socat`/`ripgrep` 是否预装，以及 `apparmor_parser -r /etc/apparmor.d/bwrap` 是否被允许。**未实测**。
- `swift test` 和 `xcodebuild` 在 `macos-26` 3C/7GB 上的实际耗时，以及 FluidAudio/swift-crypto 首次拉取时间。**未实测**。
- 构建归档的实际大小，以及 npm/tool/构建/Apple 缓存合计是否稳定低于 10 GB。**未实测**。
- 把 tests 拆成 7 份后的实际耗时；按历史数据推测约 12–16 分钟。**未实测**。
- 作业输出里 `result.json` 的实际大小是否始终 <1 MB；当前结果只含计数、项目、报告清单，推测远小于 1 MB，但未逐项测量。
- 迁移 PR 在托管 runner 上第一次运行是否会因沙箱、macOS 或缓存问题失败；**未实测**。
- 公开仓库 artifacts 存储是否免费；**文档未明说，未核实**，所以方案不依赖它。

---

# 五、逐条回答必答问题

## 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会。** 这次改的是 `.github/workflows/*`、`scripts/ci/*`、`ci/policy*.json`、测试和文档，不碰模型请求组装、系统提示、工具定义、历史消息、遮盖结果，也不碰 `packages/runtime-pi`、`packages/prompt-catalog`、`apps/agent-service` 的请求路径。依据：`.agents/instructions/prompt-prefix.md:36` 的只追加规则和 `:27-30` 的排序规则；本改动没有修改这些代码路径。模型请求仍然只在末尾追加，每轮变化的值仍只在最后一条消息里。

## 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。** CI 文件、结果摘要、缓存 key、作业输出都不是模型输入。CI 里新增的 `reportDigest`、`result.json`、cache key 只用于 CI 内部；没有时间、随机数或无序集合进入模型请求。依据：`prompt-prefix.md:53-54` 的字节确定性规则；本改动没有修改任何模型请求序列化代码。CI 自己的摘要计算用排序后的 path 列表（`collectArtifactFiles` 已按 `path.localeCompare` 排序，`artifact-files.mjs:40-71`），即使被日志记录也是确定的。

## 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，分四类：**

1. **收费防护**：`check-hosted-costs.mjs` 在 `npm run check:ci-policy` 和 `policy` 作业里运行；反向夹具覆盖 larger/self-hosted/macOS 旧标签/windows/动态表达式/artifacts/越界 cache path/构建缓存 restore-keys。测试断言这些夹具抛错；在未加检查的版本上这些夹具会通过，所以测试是红的。**未执行验证**，实施时必须先红后绿。
2. **策略两端一致**：`policy.test.mjs` 的 `validatePolicy`/`validateWorkflow`/`validateToolchainLock` 用例覆盖新 runner enum、apple 成员 key、tests 拆分、`actions/cache` 锁；反向用例包括混合标签、apple 用 `ios` key、缓存动作未锁、旧策略未升级等。
3. **结果摘要和构建归档**：`result-output.test.mjs` 覆盖编码/解码、摘要不一致、缺成员、构建归档 consumed≠produced；`gate-lifecycle.test.mjs` 覆盖 `ci/required` 对缺报告、失败、取消、篡改摘要的判定。
4. **iOS 门槛**：`apple` 作业的 `swift test`/`xcodebuild` 失败会让 `apple/macos-arm64` 失败，`ci/required` 失败；`test/tooling/ios-settings-sheet-scope.test.ts` 仍保留 I-112 的具体回归；`docs/incidents-and-gates.md` 的 I-112 改为“已落门槛”。

## 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个列“产生处 → 使用处 → 两端校验”：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `ubuntu-24.04` / `ubuntu-24.04-arm` / `macos-26` | `ci/policy.json`、`ci.yml`、`main.yml`、`merge-queue.yml`、`pr-closed.yml` | `ci/policy.schema.json` enum；`scripts/ci/contracts.mjs` 常量；`check-policy.mjs` 的 `validatePolicy`/`validateWorkflow`/`upgrade*`；`run.mjs` 的 `memberRunsOnHost`；`aggregate.mjs` 的 `toolchain.os/arch`；`main-workflow.mjs` 的 `linuxRunnerLabel`；测试里的期望值 | 所有使用处必须同时改；`validatePolicy` 会拒绝 schema 外的 runner；`validateWorkflow` 会拒绝与 policy 不一致的 `runs-on`；`runCheck` 会拒绝平台不匹配 |
| `apple` 作业 id | `ci/policy.json` | `check-policy.mjs` 的 `jobIds`、`expectedNeeds`、`required.needs`、`validateWorkflow`；`ci.yml` 的 `required.needs`；`ci-optimization.test.mjs` 的作业数；`gate-lifecycle.test.mjs` 的 `expectedMembers` | 少一处就会 `Unexpected policy DAG` / `Workflow jobs differ from policy` / 测试计数失败 |
| `apple` 成员 key `macos-arm64` | `ci/policy.json` | `validatePolicy` 的 `mac` 判断（`check-policy.mjs:442`）；`run.mjs --matrix`；`result.matrixKey`；`aggregate.mjs` 的 `expectedMembers`；`ci.yml` matrix | 用 `ios` 会被 `validatePolicy` 当成 Linux 而拒绝；必须用 `macos-arm64` |
| `actions/cache/restore`、`actions/cache/save` 的 SHA | `ci/toolchain-lock.json` | `validateToolchainLock` 的 `expectedActions`（`install-tools.mjs:172-177`）；`validateWorkflow` 的 `actions` map；`check-hosted-costs` 的 cache 规则；`ci-optimization.test.mjs` 的 `usesGitHubCache` | 锁文件、`expectedActions`、工作流 `uses` 必须三处一致；少一处会 `Action is not toolchain-locked` 或 `Action 集合缺失、重复或未知` |
| `--cache .ci-output/npm-cache` | `ci.yml`/`main.yml` | `install-dependencies.mjs` 的 `cacheLocation`（要求路径在 `.ci-output` 内）；`actions/cache` 的 `path`；`check-hosted-costs` 的 path 白名单；`ci-optimization.test.mjs` | 路径必须同时满足 `cacheLocation` 的 `.ci-output` 约束和 `check-hosted-costs` 的 `.ci-output` 白名单；`--cache runner` 被删除后不能再出现 |
| 构建缓存 key `ci-build-${run_id}-${attempt}-linux-x64` | `ci.yml` build save | `ci.yml` browser/tests restore；`check-hosted-costs` 的 key 前缀；`result-output` 的构建摘要 | key 必须完全一致；restore 必须 `fail-on-cache-miss: true` 且无 `restore-keys`；消费者重新计算 sha256 与 build 输出比较 |
| `result-output` 的 `reportDigest` | `result-output put`（读 `.ci-output/public/reports`） | `result-output collect`；`required.mjs`/`aggregate.mjs` 的 `evidence.json` | `put` 用实际报告清单算摘要；`collect` 用 `result.reports` 重算并比较；不一致就失败 |
| `evidence.json` | `result-output collect` | `aggregate.mjs` 的 `readReportEnvelopes` | 必须与 `result.reports` 的 path/sha256/bytes 完全一致；`aggregate` 原有的“缺证据/多证据/重复证据”检查保留 |
| `I-112` 门槛状态 | `docs/incidents-and-gates.md` | `scripts/check-incident-gates.mjs`（`npm run check`） | “已落门槛”必须在门槛栏用反引号写出仓库里真实存在的文件；新增 `apple` 作业/`run.mjs`/测试文件必须真实存在 |
| 旧自托管标签 `ci-vps`/`ci-arm`/`ci-vps-gate` | 旧 `ci/policy.json`（base） | `resolvePolicySource` 的升级链（`check-policy.mjs:1355-1374`）；`upgradeSelfHostedToHosted`；`policy.test.mjs` 的升级夹具 | 新升级函数必须识别旧 8 作业形状并转成新 9 作业；混合写法必须失败；`policySha256` 仍按 base 原始字节算 |
| `gateRunnerLabel` 与 `linuxRunnerLabel` 相同 | `contracts.mjs` | `upgradeGateRunnerPolicy`、`runnerLabelFor("required")`、`validatePolicy` | 两者相同后 `upgradeGateRunnerPolicy` 变成恒等；旧策略升级必须由新的 `upgradeSelfHostedToHosted` 完成，不能依赖旧的 gate 升级函数 |
| `I-95` “不用 artifacts” | `docs/adr/0243`、`check-policy.mjs:638-641`、`policy.test.mjs` | 所有 workflow；`check-hosted-costs` | 新增 cache 不违反 I-95；`actions/upload-artifact`/`download-artifact` 仍必须被拒绝 |

**结论**：所有值都必须“产生处 + 使用处 + 两端校验”一起改。最容易漏的三处是：`actions/cache` 的锁文件/`expectedActions`、apple 的成员 key、旧策略升级函数。I-73 的教训正是只看 diff、不问“清单里的 id 能通过后端校验吗”，这次逐项列出来并加自动检查。
