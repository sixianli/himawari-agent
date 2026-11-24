## 读代码证实的问题

### 1. 中：新增的 `prepare-hosted.sh` 和 `apple.yml` 没有对应的自动检查，反向用例也不存在

文件:行：`scripts/ci/prepare-hosted.sh:1-30`、`.github/workflows/ci.yml:105-106`、`.github/workflows/apple.yml:36-42`

问题：这次新增了一条以 root 改系统包和 AppArmor 的脚本，以及一个只靠真实 macOS 机器验证的编译流程，但仓库里没有任何自动检查覆盖它们。`test/tooling/ci-runner-scripts.test.mjs` 随自托管脚本一起删除了，没有替代。

证据：

```bash
# scripts/ci/prepare-hosted.sh:10
apt-get install -y -q --no-install-recommends bubblewrap socat ripgrep apparmor-utils
# scripts/ci/prepare-hosted.sh:17
profile bwrap /usr/bin/bwrap flags=(unconfined) {
# scripts/ci/prepare-hosted.sh:26
"$node_bin" node_modules/playwright/cli.js install-deps chromium firefox webkit
```

调用方式：

```yaml
# .github/workflows/ci.yml:105-106
- name: 准备 GitHub 托管机器上的沙箱和浏览器依赖
  run: sudo bash scripts/ci/prepare-hosted.sh "$PWD/.ci-output/tools/bin/node"
```

`apple.yml` 也只被 `run.mjs` 交给 actionlint；`validateWorkflow` 只逐字校验 `ci.yml`，`validateHostedRunners` 只检查 `runs-on`，没有任何检查验证 Xcode scheme、SDK、destination 或 Swift 包在 macos-26 上可用：

```yaml
# .github/workflows/apple.yml:36-42
- name: 不签名编译 iPhone App
  run: >-
    xcodebuild build
    -project clients/apple/App/Himawari.xcodeproj
    -scheme Himawari
    ...
    -destination 'generic/platform=iOS Simulator'
    CODE_SIGNING_ALLOWED=NO
```

建议：给 `prepare-hosted.sh` 加不依赖真实 CI 的合同测试（缺 node、非 root、包列表、AppArmor 片段），并在 CI 里保留一个 `bwrap --version` / 沙箱探针；至少要有“参数缺失或脚本写错时失败”的反向用例。`apple.yml` 加 `xcodebuild -list -json` 或 scheme 存在性检查，或明确记录为什么只能靠真实 macOS 作业验证。

### 2. 中：删掉 `run-share remove` 后，GitHub 缓存没有清理，按运行号无限累积

文件:行：`.github/workflows/ci.yml:513-575`、`scripts/ci/run-share.mjs:138-140`、`docs/adr/0287-ci-runs-on-github-hosted-runners.md:70-71`

问题：旧的 `required` 作业在核对完成后会删除本次共享目录；新实现只 `restore` 和 `collect`，没有任何删除动作。每个运行都会产生 11 份报告缓存，`build` 那份还包含构建归档（`publish.mjs:95-96` 把 artifact 复制进 `reports/`），而这些键都带 `run_id`/`run_attempt`，不会复用。

证据：

```yaml
# .github/workflows/ci.yml:568-575
- name: 从共享目录取本次各任务的报告并核对摘要
  run: .ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports
...
- name: 核对全部 job 与报告，把汇总结论写进本步骤日志和作业摘要
  run: .ci-output/tools/bin/node scripts/ci/required.mjs ...
# 之后没有 run-share remove
```

```js
// scripts/ci/run-share.mjs:138-140
export function remove({ root, run }) {
  rmSync(path.join(root, run), { recursive: true, force: true });
}
```

ADR 的依据是缓存 10 GB 内免费，并声称“本次运行刚存的那份最新，不会被先删”（`docs/adr/0287...:71`）。代码里没有任何清理或配额控制，仓库缓存会被每轮 build 归档持续占用。旧的 `remove` 只删 CI VPS 的目录，本来也删不到 GitHub 缓存；但这次既然把传输改成缓存，就应当同时处理缓存生命周期。

建议：增加一个在 `ci/required` 最后运行的缓存清理步骤（例如通过 GitHub REST API 删除本次 `ci-share-<run_id>-<run_attempt>-*`），或只把报告放缓存、构建目录用更小的传输方式；如果决定接受自动淘汰，则在 ADR 里把“最新不会被先删”改成未经验证的假设，并加监控。

### 3. 中：规则文件和多份 ADR/设计文档仍在描述旧 CI VPS 和删除共享目录的步骤

文件:行：`.agents/instructions/test-trigger-timing.md:17`、`docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55`、`docs/adr/0243-ci-uses-no-github-artifacts.md:58`、`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:127-129`

问题：代码已改成托管 runner + `actions/cache`，但规则文件仍告诉代理 CI 跑在 OVH CI VPS 的自托管 runner 上；ADR 0241/0243 仍写着“上传汇总结论和删除共享目录”，设计文档仍写着“CI 不用 GitHub 缓存”和 `/srv/gh-runner-share`。ADR 0287 的 `amends` 列表（`docs/adr/0287...:7`）没有包含 0241、0243，所以这些文件也没有被标记为已修订。

证据：

```text
# .agents/instructions/test-trigger-timing.md:17
这些规则只管开发测试。`ci/policy.json` 中要求的 GitHub CI ... 在 CI VPS（Andy 在 OVH 租的一台只跑 CI 的云服务器）上的自托管 runner 里运行（见 ADR 0176）。
```

```text
# docs/adr/0241...:55
这一步失败后，上传汇总结论和删除共享目录的步骤也不运行……
# docs/adr/0243...:58
`ci.yml` 的完整报告仍在 CI 服务器的共享目录里，汇总作业结束时删除……
# docs/execution/specs/2026-09-03...:127
2026-11-06 起 CI 不再使用 GitHub 缓存……
# docs/execution/specs/2026-09-03...:129
作业之间的文件……放在 CI VPS 的共享目录 /srv/gh-runner-share/...
```

建议：更新 `test-trigger-timing.md`，并把 ADR 0241、0243 和设计文档改成当前实现，或在 ADR 0287 的 `amends` 里加入它们并明确说明哪些条款被取代。`test-trigger-timing.md` 是代理会直接读取的规则文件，优先级应高于普通历史文档。

### 4. 低：工作流白名单允许 `macos-26`，策略和 schema 仍只认 `macos-15`，`macRunnerLabel` 没有进入策略校验

文件:行：`ci/policy.json:52-59`、`ci/policy.schema.json:64`、`scripts/ci/check-policy.mjs:487-501`、`scripts/ci/contracts.mjs:16-25`、`docs/adr/0287-ci-runs-on-github-hosted-runners.md:46`

问题：`hostedRunnerLabels` 新增了 `macos-26`，但 `validatePolicy` 仍要求非 Linux 的 macOS 成员必须是 `macos-15`，schema 也仍允许 `macos-15`，不允许 `macos-26`。当前唯一 macOS 成员是 paused 的 `build/macos-arm64`，所以现在不会触发；但一旦有人按旧办法取消 `paused`，工作流就必须写 `macos-15`，而 `validateHostedRunners` 会以 `HOSTED_RUNNER_REQUIRED` 拒绝——策略和 workflow 校验会互相打架。

证据：

```json
// ci/policy.json:52-59
{ "key": "macos-arm64", "runner": "macos-15", "os": "darwin", "arch": "arm64", "paused": true }
```

```json
// ci/policy.schema.json:64
"enum": ["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15"]
```

```js
// scripts/ci/check-policy.mjs:494
member.runner === (mac ? "macos-15" : runnerLabelFor(check.id)),
```

```js
// scripts/ci/contracts.mjs:19-20
export const macRunnerLabel = "macos-26";
export const hostedRunnerLabels = Object.freeze([linuxRunnerLabel, armRunnerLabel, macRunnerLabel]);
```

建议：二选一。要么把暂停的 macOS 成员和 schema 一起迁到 `macos-26`，并让 `validatePolicy` 使用 `hostedRunnerLabels`/`macRunnerLabel`；要么明确写出“策略里保留 macos-15 仅作为暂停占位，恢复前必须改标签”，并加一条测试覆盖恢复场景。现在的状态属于“新引入的值在一边能接受、在另一边不能接受”。

### 5. 低：`upgradeSelfHostedRunners` 对混合旧/新标签的基准也会逐成员升级，和既有“只升级完整旧写法”的约定不一致

文件:行：`scripts/ci/check-policy.mjs:352-365`

问题：其他升级函数都要求基准策略整份是某种旧形状，混合写法原样返回并交给校验拒绝；`upgradeSelfHostedRunners` 只判断“存在至少一个旧标签”，然后把所有成员逐个替换。这样一份同时包含 `ci-vps` 和 `ubuntu-24.04` 的、从未合法过的基准策略，也会被静默归一化成全部托管标签。

证据：

```js
// scripts/ci/check-policy.mjs:352-364
export function upgradeSelfHostedRunners(policy) {
  const hosted = { [legacyRunnerLabels.linux]: linuxRunnerLabel, ... };
  const members = (policy?.checks ?? []).flatMap((check) => check.members ?? []);
  if (!members.some((member) => Object.hasOwn(hosted, member.runner))) return policy;
  const upgraded = structuredClone(policy);
  for (const check of upgraded.checks)
    for (const member of check.members)
      if (Object.hasOwn(hosted, member.runner)) member.runner = hosted[member.runner];
  return upgraded;
}
```

现有测试只覆盖“现行策略原样返回”和“完整旧策略升级”（`test/tooling/policy.test.mjs:2161-2174`），没有覆盖混合基准。这里不一定会造成当前 PR 的运行时错误，但会削弱“基准策略升级只认完整旧形状”的既有防线。

建议：要么要求旧标签只在完整的旧 policy 形状下才升级，要么加一条明确的测试和 ADR 说明“混合旧/新标签允许被逐成员升级”；否则以后很难区分“合法旧基准”和“损坏基准”。

## 侧重检查

- **错误路径**：`browser`/`tests` 的缓存取回带 `fail-on-cache-miss: true`；`required` 的缓存取回不带该选项，但取不到时 `run-share collect` 会报告缺失，`aggregate` 会以缺少报告失败。入口检查失败、草稿和上游取消时，后续 restore/collect 默认被 `success()` 跳过，没有发现“入口失败仍继续收报告”的路径。
- **不合规范/不可信输入**：`validateHostedRunners` 会拒绝自托管标签、数组、对象、表达式、larger runner、浮动标签和矩阵里的非白名单成员；`shareRoot`/`runName` 校验绝对路径、运行号和目录符号链接；`run-share get` 仍按 64 位摘要逐字节核对。没有发现新的绕过校验路径。
- **安全**：`ci.yml` 作业权限仍为只读；`actions/cache` 使用完整 SHA 并进入 toolchain lock；没有引入 artifact 或自托管标签；`prepare-hosted.sh` 的 root 操作在一次性 GitHub 托管 VM 上执行，没有生产主机或持久数据，但该脚本本身没有测试（见意见 1）。
- **资源耗尽**：主要风险是缓存累积和 10 GB 配额（见意见 2）；每个作业开头执行 `apt-get`/Playwright 系统依赖安装也会增加时间和下载量，但不会产生托管机器费用。
- **不可撤销操作**：本 PR 删除的是仓库内的 runner 脚本和运行手册，均由 git 历史可恢复；没有触发生成环境、生产或数据库的不可撤销操作。
- **规则/说明与代码一致性**：发现 `test-trigger-timing.md`、ADR 0241/0243 和 CI 设计文档仍描述旧机制（见意见 3）；策略与工作流标签的 `macos-15`/`macos-26` 不一致（见意见 4）。

## 推测与未核实

- **ARM 缓存能否被 x64 的 `required` 取回**：代码里保存和恢复的路径、键完全一致（`ci.yml:68-73` 与 `:513-568`），同一 Linux 平台下 `actions/cache` 通常按 key + path 取回；但仓库没有跨架构端到端测试，GitHub 内部缓存版本的平台/镜像行为未在本仓库核实。
- **GitHub 10 GB 配额满后先淘汰哪一份**：ADR 0287 说“本次运行刚存的那份最新，不会被先删”，但 GitHub 文档只说明会淘汰缓存直到低于上限，没有在本仓库核实淘汰顺序。若实际按最近访问时间淘汰，刚保存但尚未被恢复的 build 缓存可能先被淘汰。
- **actionlint 1.7.11 是否认识 `ubuntu-24.04-arm` 和 `macos-26`**：`.github/actionlint.yaml` 已清空自定义标签，`run.mjs:270-278` 现在会把 `apple.yml` 交给 actionlint。如果该版本不认识这两个标签，static 作业会失败；本仓库没有测试锁定 actionlint 的标签表。
- **`macos-26`、Swift 6.2、Xcode scheme 在 GitHub 托管 macOS 镜像上的可用性**：未能离线核实；`apple.yml` 的真实编译结果只能由首次 PR 运行验证。
- **作者说法 2（跨架构）**：代码层面路径和键一致，但“能被 x64 取回”属于 GitHub 实现行为，未核实。

## 作者说法核对

1. **每个检查作业 put 后 save，键/路径包含 run/attempt；browser/tests 在 get 前 restore build 且 fail-on-cache-miss；required 在 collect 前 restore 11 个成员**：读代码成立。见 `ci.yml:64-73`、`:242-251`、`:338-347`、`:513-568`。
2. **ARM 存的缓存能被 x64 required 取回**：代码里的路径字符串和键一致；跨架构实际行为未核实，且没有自动测试。
3. **`validateHostedRunners` 拒绝白名单外的 runs-on，包括矩阵成员、表达式和对象写法**：读代码成立，见 `check-policy.mjs:858-876`；但它只检查 workflow，不检查 `ci/policy.json` 的 `runner`，所以策略里的 `macos-15` 仍能通过策略 schema/`validatePolicy`（见意见 4）。
4. **`upgradeSelfHostedRunners` 只在出现旧标签时才换，现行策略原样返回**：基本成立，`policy` 无旧标签时返回同一对象；但混合旧/新标签也会被逐成员升级（见意见 5）。
5. **`prepare-hosted.sh` 安装沙箱依赖和 Playwright 系统依赖**：脚本本身成立（`prepare-hosted.sh:10,26`）；但它不是每个作业都调用，也没有自动检查（见意见 1）。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会影响 Himawari 发给模型的请求。这个 diff 只改了 CI 工作流、CI 脚本、策略、ADR 和 `.agents/instructions` 文档，没有改 `packages/prompt-catalog`、运行时适配器、系统提示、工具定义或历史组装代码。因此不存在“改写了已发历史、把每轮变化值放进系统提示或工具定义”的路径；发给模型的内容仍沿用原来的只追加规则。`.agents/instructions/delivery-mode.md` 和 `test-and-production-hosts.md` 的文字改动只影响开发/复核代理新会话读到的说明，不会改写产品模型已发出的历史；已存在对话仍应沿用冻结的系统提示。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

对模型请求不会。没有新增按时间、随机数、前后文遮盖或无序集合生成模型文本的代码。CI 新增的 `github.run_id`/`github.run_attempt` 只用于缓存键和路径，属于每次运行的 CI 元数据，不是发给模型的文字；同一次运行内这些值是确定的。若把问题扩展到 CI 产物，缓存键/路径本来就会随运行号变化，这是有意设计，不属于模型前缀问题。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

核心改动有一部分：`test/tooling/policy.test.mjs:1765-1838` 覆盖 browser/tests restore、检查作业 save、required 逐个 restore 的反向用例；`:2106-2174` 覆盖 hosted runner 白名单、矩阵成员、表达式、对象和 full 策略升级；`test/tooling/ci-optimization.test.mjs` 检查 `ci.yml` 只使用运行范围的缓存键/路径，并检查 `required` 的 restore 在 collect 之前。`test/tooling/toolchain.test.mjs` 也把 `actions/cache` 加入锁文件期望。

缺口是：`prepare-hosted.sh` 没有自动检查，`apple.yml` 的功能正确性只靠首次真实 macOS 作业，跨架构缓存没有测试，actionlint 对新标签的支持也未在仓库内验证。因此不能回答“所有改动都有反向用例”。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**

逐个核对结果：

- `ubuntu-24.04` / `ubuntu-24.04-arm`：`contracts.mjs:16-18` 产生，`ci/policy.json`、`ci/policy.schema.json`、`.github/workflows/*.yml`、`main-workflow.mjs`、`validateHostedRunners` 都接受，当前一致。
- `macos-26`：`contracts.mjs:19-20` 和 `apple.yml` 使用，`validateHostedRunners` 接受；但 `ci/policy.schema.json:64` 和 `validatePolicy` 只认 `macos-15`，`macRunnerLabel` 没有进入策略校验，属于不一致（意见 4）。
- `actions/cache` 的仓库和 SHA：`ci/toolchain-lock.json:82-92` 产生，`install-tools.mjs:172-181` 的期望清单、`validateWorkflow` 的 `actionRepository`（`check-policy.mjs:51,697-703`）和 workflow 的 `uses` 都能对上；`validateToolchainLock` 和 tests 也已更新。
- 缓存路径/键：`check-policy.mjs:46-57` 定义格式，`ci.yml` 的 save 使用 `${check.id}-${{ env.CI_MATRIX }}`，`required` 按 `policy-default`、`static-default`、`build-linux-x64`、`browser-*`、`tests-*`、`tooling-default`、`security-default` 恢复，正好对应当前策略的 11 个 active member；`validateWorkflow` 会逐项核对。
- `HIMAWARI_CI_SHARE` / `SHARE_ROOT_COMMAND`：workflow 写入的路径与 `run-share.mjs` 的 `shareRoot`/`runName` 一致；`validateWorkflow:723-727` 要求每个作业恰好执行一次。
- `build-linux-x64`：`build` 作业的 output key 是 `linux-x64`，browser/tests 的 `CI_BUILD_DIGEST` 和 restore key 都用 `build-linux-x64`；两边一致。
- `prepare-hosted.sh` 路径：文件存在且被多个作业调用，但没有消费端校验，也没有测试（意见 1）。
- 旧标签升级：`upgradeSelfHostedRunners` 能把 `ci-vps`/`ci-arm`/`ci-vps-gate` 映射到新标签，`policySha256` 仍按原始字节计算；混合基准的过度升级见意见 5。
