I'll start by reading the key files and the referenced rules/ADRs.
## 结论先说

把 Oracle ARM 机器作为 **`security` / `static` 的“共同标签池”**（与 x64 共用 `ci-linux` 标签），而不是让必过作业依赖 Oracle。报告仍由生产作业自己 `put`，再用受限 SSH/rsync 推到 CI VPS 的暂存区，由接收器原子移入 `/srv/gh-runner-share`；汇总作业仍用原来的 `get/collect` 按摘要核对。工具链只保留 **一份** `ci/toolchain-lock.json`，把 `linux-arm64` 加进去；不采用“独立 ARM 锁文件”。`build`、`browser`、`coverage` 不搬，`policy` 先不搬。

---

## 一、方案依赖的前提（读代码/来源证实）

1. **检查作业和依赖关系**
   - `policy` 无依赖；`static`、`build`、`security` 依赖 `policy`；`browser` 依赖 `build`；`coverage` 依赖 `policy`、`build`；`required` 依赖六个检查。
   - 来源：`.github/workflows/ci.yml:30-33,69-76,112-121,162-167,233-239,281-286,324-335`；`ci/policy.json:5-143`。
   - 原话：`runs-on: ci-vps`、`needs:`、`- policy`。

2. **按作业数算，一次完整运行是 8 个检查作业 + 1 个汇总，不是 6 + 1**
   - `build` 矩阵只有 `linux-x64` 是 active，`macos-arm64` 是 `paused`；`browser` 有 chromium/firefox/webkit 三个；加上 policy/static/coverage/security，共 8 个 active 检查作业。
   - 来源：`ci/policy.json:38-94`；`scripts/ci/contracts.mjs:52-63`（`activeMembers` 过滤 `paused`）；`.github/workflows/ci.yml:162-194`。

3. **作业间文件只走 CI VPS 本机共享目录**
   - `shareRoot` 要求 `HIMAWARI_CI_SHARE` 是绝对路径且是目录：
     `scripts/ci/run-share.mjs:26-32`，原话 `if (!root || !path.isAbsolute(root)) fail("ROOT_REQUIRED");`。
   - `put` 先复制到临时名、核对摘要、再 `rename`：
     `scripts/ci/run-share.mjs:72-90`。
   - `get` 复制后重算摘要，不一致就删副本并失败：
     `scripts/ci/run-share.mjs:92-112`。
   - `collect` 按 `needs` 里的输出逐个 `get`：
     `scripts/ci/run-share.mjs:114-136`。
   - 依据：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md`。

4. **CI 不用 GitHub 产物**
   - `check-policy.mjs` 拒绝 `actions/upload-artifact` / `actions/download-artifact`：
     `scripts/ci/check-policy.mjs:478-482`，原话 `GitHub artifacts are not used; reports stay on the runner share ...`。
   - 依据：`docs/adr/0243-ci-uses-no-github-artifacts.md`。

5. **固定工具目前只认两个平台**
   - `scripts/ci/install-tools.mjs:25`，原话 `const platforms = ["darwin-arm64", "linux-x64"];`。
   - `ci/toolchain-lock.json` 里没有 `linux-arm64` 条目（本仓库检索确认）。

6. **报告上下文只认一份工具链锁摘要**
   - `scripts/ci/context.mjs:143`，原话 `toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json"))`。
   - `scripts/ci/aggregate.mjs:288-290` 拿同一份文件比对，不一致就失败。
   - 因此如果 ARM 用独立锁文件，汇总端不会核对那份锁；这是 I-73 类的“只在一端认”风险。

7. **汇总端现在按 policy 成员的 `os/arch` 精确比对**
   - `scripts/ci/aggregate.mjs:98-105`：
     `for (const field of ["node", "os", "arch"]) if (result.toolchain[field] !== member[field]) fail(...)`。
   - `run.mjs` 也有 runner 平台检查：
     `scripts/ci/run.mjs:131-133`，原话 `if (hosted && (member.os !== process.platform || member.arch !== process.arch)) throw new Error("CI_RUNNER_PLATFORM_MISMATCH");`。

8. **工作流有逐字硬规则**
   - 每个检查作业恰好一个 `put`，命令逐字比对：
     `scripts/ci/check-policy.mjs:549-589`。
   - 汇总作业必须 `collect` 再 `remove`：
     `scripts/ci/check-policy.mjs:519-533`。
   - 因此新增的 ARM 推送步骤必须进入硬规则和反向用例。

9. **CI VPS 的 runner 是加固过的 systemd 服务**
   - `scripts/operations/ci-runner/gh-runner.service.in:9-37`：专用用户、`ProtectSystem=strict`、`ReadWritePaths` 只含 runner 目录和共享目录、`InaccessiblePaths` 藏另一个 runner 目录。
   - `scripts/operations/ci-runner/gh-runners.slice:5-9`：两个 runner 合计内存上限 20 GB。
   - `scripts/operations/ci-runner/runners.sh:1-30`：两个 runner、标签 `ci-vps`、只接受 1 或 2。

10. **Playwright 1.62 已支持 Linux arm64 Chromium**
    - 官方 Release notes：<https://playwright.dev/docs/release-notes>，原话 “On Linux arm64, Playwright now downloads the Chrome for Testing build of Chromium, the same build used on all other platforms.”
    - 官方 System requirements：<https://playwright.dev/docs/intro>，原话 “Debian 12 / 13, Ubuntu 22.04 / 24.04 / 26.04 (x86-64 or arm64).”
    - 这使 `static` 里的 Chromium/layout 检查在 ARM 上有官方支持；但本仓库尚未在 ARM 实跑。

11. **ARM 侧工具链有官方发布物**
    - Node 22.22.3：<https://nodejs.org/download/release/v22.22.3/>，有 `node-v22.22.3-linux-arm64.tar.xz`。
    - Python：<https://github.com/astral-sh/python-build-standalone/releases/tag/20250529>，有 `cpython-3.12.10+20250529-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz`。
    - Semgrep 1.152.0：<https://pypi.org/project/semgrep/1.152.0/>；其 `cli/setup.py` 把 `linux_aarch64` 映射为 `musllinux_1_0_aarch64.manylinux2014_aarch64`：<https://github.com/semgrep/semgrep/blob/93b8e2c6/cli/setup.py>。
    - actionlint：<https://github.com/rhysd/actionlint/releases/tag/v1.7.12>，有 `actionlint_1.7.12_linux_arm64.tar.gz`。
    - gitleaks：<https://github.com/gitleaks/gitleaks/releases>，有 `gitleaks_8.30.1_linux_arm64.tar.gz`。

12. **GitHub 的标签池和排队语义支持“共享标签 + 自动回退”**
    - <https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job>，原话 “If you specify an array of strings or variables, your workflow will execute on any runner that matches all of the specified `runs-on` values.”
    - <https://docs.github.com/en/actions/reference/runners/self-hosted-runners>，原话 “If GitHub doesn't find an online and idle runner that matches the job's `runs-on` labels and groups, then the job will remain queued until a runner comes online.”
    - <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow>，原话 “These labels operate cumulatively, so a self-hosted runner must have all four labels to be eligible to process the job.”
    - 结论：只要 x64 runner 和 ARM runner 都带 `ci-linux`，ARM 掉线时作业会自动落到 x64；不需要改工作流。

13. **自托管 runner 的安全边界很硬**
    - <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions>，原话 “Self-hosted runners ... can be persistently compromised by untrusted code in a workflow.” 以及 “any user capable of invoking workflows has access to this environment.”
    - 这是把 runner 装到“测试机”上的最大风险，不能用普通 CI VPS 的假设直接套。

14. **受限 rsync 登录是成熟做法**
    - <https://man7.org/linux/man-pages/man1/rrsync.1.html>，原话 “A user's ssh login can be restricted to only allow the running of an rsync transfer in one of two easy ways”，示例 `command="rrsync DIR"`。
    - 成熟开源项目 `ci-storage` 也用 rsync 在自托管 runner 与中央存储间传文件：<https://github.com/dimikot/ci-storage>，原话 “Under the hood, the tool uses rsync.”

15. **Oracle 免费额度已经不是 4 OCPU / 24 GB**
    - Oracle 官方社区公告：<https://community.oracle.com/customerconnect/discussion/970310/oci-always-free-updated-ampere-a1-compute-allocation>，原话 “For Always Free tenancies, the Ampere A1 allocation is now: Compute 2 OCPUs total; Memory 12 GB total; Monthly equivalent 1,500 OCPU hours and 9,000 GB hours.”
    - Oracle 文档：<https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm>，原话 “ensure that you have no more than 2 OCPUs and 12 GB of memory in total across all the OCI Ampere A1 Compute instances in your tenancy.”

---

## 二、核对后我认为不对或需要修正的事实

1. **事实 1 的“6 个检查作业”不准确。**
   - 按作业数是 8 个 active 检查作业 + 1 个汇总；按检查种类才是 6 类。依据见前提 2。
   - 这会影响容量估算：不是“6 个作业抢两个 runner”，而是“8 个作业抢两个 runner”。

2. **事实 3 的“每个检查作业步骤相同”不准确。**
   - `static`、`coverage` 多一步安装 Chromium：`.github/workflows/ci.yml:95-96,260-261`。
   - `build`/`browser`/`coverage` 的执行分支也不同：`scripts/ci/run.mjs:444-491`。
   - 所以不能假设“搬一个作业就等于搬同一段步骤”；`static` 和 `security` 的可搬性要分别验证。

3. **事实 4 的“要求是本机绝对路径”只对了一半。**
   - 代码只检查 `path.isAbsolute`、`lstat` 是目录且不是符号链接：`run-share.mjs:26-32`。
   - 它没有检查文件系统类型；网络挂载也可能通过。`put` 的 `chmod`、`uid`、`rename` 语义在 NFS/sshfs 上未必成立，所以不能把“能用本机目录”直接推广到“能挂网络盘”。

4. **事实 8 的分支和 ADR 0253 在当前检出里无法核对。**
   - `git show claude/project-thread-q668e8:...` 报 `invalid object name`，该分支不在当前仓库对象里；相关内容只能按材料转述，标「未核实」。
   - “独立 ARM 锁文件”只是那个线程的方案，不是既成事实；本方案明确不采用（理由见后）。

5. **事实 12 的“Always Free 额度”与机器规格矛盾。**
   - 现在 Always Free 的 Ampere A1 是 2 OCPU / 12 GB；4 核 / 24 GB 的机器要么是 PAYG、要么是旧额度/超配额。来源见前提 15。
   - Andy 说不用担心费用，所以这不是预算阻塞；但它意味着“Oracle 随时可能回收/缩容”的风险比“Always Free 稳定额度”更高，必须按可掉线设计。

6. **事实 2 的实测时长和峰值内存、事实 9 的“产品必须 x64”我无法在本仓库内独立复现。**
   - 时长/峰值来自外部 GitHub 接口和日志，标「未核实但采信材料」。
   - x64 产品这一点与代码里的硬编码一致（`aggregate.mjs:200-216` 把 consumer 平台固定为 `linux-x64`），但未实际跑构建验证。

---

## 三、方案

### 3.1 哪些作业搬过去

| 作业 | 搬不搬 | 原因 |
| --- | --- | --- |
| `security` | **先搬** | 纯文本/规则扫描，semgrep/gitleaks/actionlint 都有官方 linux-arm64 发布物；风险最低。 |
| `static` | **验证后搬** | 13–14 分钟，收益最大；但包含 Chromium/layout，需要先在 ARM 实跑确认结果与 x64 一致。Playwright 1.62 官方支持 linux-arm64。 |
| `policy` | **先不搬** | 它是所有检查的前置；落到 ARM 会让 x64 在 13 分钟里空转。等 `static`/`security` 稳定、且 queue 仍长时再评估。 |
| `build` | **不搬** | 产出 x64 上线包；`aggregate` 也把 build 平台固定为 `linux-x64`。 |
| `browser` | **不搬** | 消费 x64 build 产物。 |
| `coverage` | **不搬** | 消费 x64 build 产物，测试可能执行产品二进制。 |
| `required` | **不搬** | 按 ADR 0256 放 `ci-vps-gate`，需要共享目录和汇总工具。 |

**关键做法：共享标签池。**
- 新增标签 `ci-linux`：
  - CI VPS 的 1、2 号 runner 同时带 `ci-vps` 和 `ci-linux`；
  - Oracle ARM runner 带 `ci-linux`，但**不带** `ci-vps`；
  - `static`/`security` 的 `runs-on: ci-linux`；
  - `build`/`browser`/`coverage`/`policy` 继续 `ci-vps`，`required` 用 `ci-vps-gate`。
- 效果：
  - 两台机器都空闲时，GitHub 可以把 `static`/`security` 派到任一台；
  - Oracle 掉线/被回收/标签被移除时，作业自动落到 x64，不需要改工作流、不需要紧急 PR；
  - ARM 不会被 `build`/`browser`/`coverage` 误用。

### 3.2 工具链：一份锁，加 `linux-arm64`

- `scripts/ci/install-tools.mjs:25` 改成：
  `const platforms = ["darwin-arm64", "linux-x64", "linux-arm64"];`
- `ci/toolchain-lock.json` 的每个平台映射补 `linux-arm64`：
  - Node 22.22.3 linux-arm64 + headers（headers 一份即可）；
  - npm 同一份（架构无关）；
  - Python 3.12.10 astral aarch64 install_only_stripped；
  - actionlint / gitleaks linux_arm64；
  - semgrep 的完整 ARM wheel 闭包（`manylinux2014_aarch64` 或纯 Python `py3-none-any`）。
- **不采用独立 `ci/toolchain-lock.linux-arm64.json`。**
  - 原因：`context.toolchainSha256` 和 `aggregate.mjs:288-290` 只核对 `ci/toolchain-lock.json`。独立锁会让 ARM 实际安装的工具链没有进入汇总端的摘要核对，正是 I-73 那类“生产端产生的值，消费端不认”的缺口。
  - 代价：加 ARM 条目会改变主锁摘要，所有作业的 `context.toolchainSha256` 一起变一次；这是一次性成本，合并后新一轮 CI 全部使用新锁。
- **在 `validateToolchainLock` 里增加平台文件名检查**：
  - ARM 的 Node/Python/actionlint/gitleaks 文件名必须含 `arm64`/`aarch64`；
  - ARM 的 wheel 必须是 `aarch64` 或 `py3-none-any`；
  - 反向用例：把 x64 wheel 放进 ARM 闭包必须失败，缺一个 ARM wheel 也必须失败。
- `install-dependencies.mjs` 在 ARM 上会：
  - 用 ARM Node/headers 构建 `better-sqlite3`；
  - 通过 `package-lock.json` 里的 linux-arm64 可选包安装 biome/canvas/rolldown/lightningcss/sqlite-vec 等（仓库里已有这些条目，例如 `package-lock.json:650,1931,2574,6278,8075`）；
  - `auditInstalledDependencies` 按 `process.platform/process.arch` 校验，不需要改。

### 3.3 报告怎样从 Oracle 交到汇总作业

**保持现有的“生产端摘要 + 汇总端重算”模型，只增加一段跨机搬运。**

1. Oracle 上的作业仍然执行原来的 `run-share.mjs put`：
   - `HIMAWARI_CI_SHARE` 指向 Oracle 本机的暂存根，例如 `/srv/ci-share-local`；
   - `put` 在本地完成“复制到临时目录 → 重算摘要 → rename”，把 64 位摘要写进作业输出；
   - 报告名仍是 `security-default` / `static-default`，摘要仍在 `needs.<job>.outputs.default`。
2. 新增一步 `run-share.mjs push`（只对 `static`/`security`）：
   - 如果 `process.arch !== "arm64"`，直接打印 `CI_SHARE_PUSH_LOCAL` 并成功（x64 作业不需要跨机）；
   - 如果是 ARM，要求 `HIMAWARI_CI_SHARE_REMOTE`（例如 `gh-share@ci-vps:/srv/gh-runner-share/.incoming`）；
   - 用 `rsync` 通过 SSH 把本地 `<run>/<name>` 推到 CI VPS 的**唯一暂存目录**；
   - 再通过受限 SSH 命令让接收器原子 `mv` 到 `/srv/gh-runner-share/<run>/<name>`；
   - 传输失败就退出非零，作业失败，汇总端会看到缺失。
3. CI VPS 上的接收器：
   - 专用 `gh-share` 用户，只属于 `gh-ci-share` 组，无登录 shell；
   - SSH `authorized_keys` 用 `command="..."` 强制只跑接收脚本；rsync 一侧用 `rrsync` 限定只能写暂存目录（参考 `rrsync(1)`）；
   - 接收器校验：
     - `run` 必须匹配 `^[1-9][0-9]*-[1-9][0-9]*$`；
     - `name` 必须匹配 `run-share.mjs:17` 的 `^[a-z][a-z0-9-]{0,63}$`；
     - 目标必须位于 `/srv/gh-runner-share` 下，拒绝 `..`、绝对路径、符号链接；
     - 目标已存在就失败，不覆盖；
     - 设置目录 `2770`、文件 `660`、组 `gh-ci-share`，与现有 `put` 一致；
     - 最后 `rename`，失败则清理暂存。
   - 暂存目录和超过 6 小时的残留由现有 `clean-old.sh` 的扩展清理。
4. 汇总作业完全不用改传输逻辑：
   - `run-share.mjs collect` 仍在 CI VPS 上读 `needs` 里的摘要；
   - `get` 仍会把报告复制到本地并重算摘要，不一致就 `CI_SHARE_DIGEST_MISMATCH`；
   - 因此**权威的跨机一致性检查仍然在 `get`**：就算传输坏了、被截断、被篡改，汇总端也不会接受。
5. 如果不想引入接收器守护进程，也可以用“rsync 到暂存 + `.ready` 标记 + systemd path/timer 移入”的实现；本质相同，推荐前者（一次 SSH 完成搬运，路径更短）。

### 3.4 策略、schema、汇总端怎么改

- 在 `ci/policy.schema.json` 的 member 上加可选 `platforms` 数组：
  - `runner` 枚举增加 `ci-linux`、`ci-vps-gate`；
  - `platforms` 只允许 `x64`、`arm64`；
  - 现有 `arch` 保留，作为基线/兼容字段。
- `ci/policy.json`：
  - `security`/`static` 的 member 改为 `runner: "ci-linux"`，`arch: "x64"`，`platforms: ["x64", "arm64"]`；
  - 其他 member 的 `platforms` 省略，等价于 `[arch]`。
- 新增 `memberPlatforms(member)`（放 `contracts.mjs`）：
  - 返回 `member.platforms ?? [member.arch]`；
  - `run.mjs` 的平台检查改成 `memberPlatforms(member).includes(process.arch)`；
  - `aggregate.mjs` 的 `os/arch` 检查改成 `result.toolchain.arch` 必须在允许集合里。
- `check-policy.mjs` 增加硬规则：
  - `platforms` 含 `arm64` 的 member 只能是 `static`/`security`，且 `runner` 必须是 `ci-linux`；
  - `build`/`browser`/`coverage`/`policy` 不能含 `arm64`，且必须用 `ci-vps`（`required` 用 `ci-vps-gate`）；
  - `runs-on` 必须等于 member 的 `runner`（现有单 member 检查已覆盖）；
  - `ci-linux` 必须同时存在于 x64 runner 和 ARM runner 的注册标签里（跨文件测试，读 runner 脚本/策略/工作流）。
- **升级函数**：
  - 加 `upgradeMovableRunnerPolicy`，只匹配“旧的 `static`/`security` = `ci-vps` + linux + x64 + node 22.22.3、没有 `platforms`”这一种形状，把它升级为 `ci-linux` + `platforms: ["x64","arm64"]`；
  - 放在现有升级链里，和 ADR 0256 的 `upgradeGateRunnerPolicy` 一起测试组合；
  - 原因：`runCheck` 用的是 **base commit 的 policy**（`scripts/ci/run.mjs:87-89`），`check-policy.main` 还会用 `source.policy` 再校验一次工作流（`scripts/ci/check-policy.mjs:1358-1368`）。没有升级函数，PR 自己第一次把 `runs-on` 改成 `ci-linux` 时，base 旧 policy 仍写 `ci-vps`，会直接失败。
  - 反向用例：旧形状升级后通过；新形状不被改；半新半旧、把 `build` 升级成 ARM、把 `required` 改成 `ci-linux` 都必须失败。
- `result.schema.json`：
  - `CheckResult.toolchain.arch` 已经允许 `arm64`，无需改；
  - `artifacts.platform` 仍只有 `linux-x64`/`macos-arm64`，这是对的：`static`/`security` 不产 artifact，ARM 不应出现在 artifact 平台里。如果未来有 ARM 作业产 artifact，schema 会拒绝，必须先显式加，这正是两端校验。

### 3.5 两台机器各要装什么

**CI VPS（现有 x64 机器）**
- 1、2 号 runner 增加 `ci-linux` 标签，保留 `ci-vps`；不要给 gate runner 加 `ci-linux`。
- 按 ADR 0256 安装 `ci-vps-gate`（如果尚未实施，本方案暂用 `ci-vps` 跑汇总，其余不变）。
- 新增 `gh-share` 接收用户、SSH 公钥、强制命令/`rrsync`、`rsync` 包、暂存目录 `/srv/gh-runner-share/.incoming`。
- 扩展 `clean-old.sh`：清理 `.incoming` 和超过 6 小时的本地暂存。
- 保持现有 nft 防火墙和 `gh-runners.slice` 限制。

**Oracle ARM（测试机）**
- 安装 GitHub Actions runner 的 linux-arm64 版本（与 CI VPS 同版本，例如 2.338.2），专用用户 `gh-runner`，systemd 服务。
- 标签：`self-hosted,Linux,ARM64,ci-linux,oracle-arm64`；**不能有 `ci-vps`**。
- systemd 沙箱：
  - `ProtectSystem=strict`、`ProtectHome=yes`、`NoNewPrivileges=yes`、`PrivateTmp=yes`；
  - `ReadWritePaths` 只放开 runner 自己的目录和 `/srv/ci-share-local`；
  - `InaccessiblePaths` 藏测试数据、家目录、其他敏感目录；
  - 不加入 docker 组，不挂 docker socket；
  - `TasksMax`、`MemoryMax` 限制。
- 资源分配（建议初值，需实测后由 Andy 定）：
  - `CPUQuota=300%`，留 1 核给测试；
  - `MemoryHigh=18G`、`MemoryMax=20G`，留约 4 GB 给测试；
  - runner slice `CPUWeight=1000`，测试用 `tests.slice` 时设 `CPUWeight=100`，实现 CI 优先；
  - `MemorySwapMax=0`。
- 预装系统依赖：`build-essential`、`python3`、`unzip`、`xz-utils`、`bubblewrap`、`rsync`、`openssh-client`、`nftables`，以及 Playwright 1.62.1 的 Ubuntu 24.04 arm64 浏览器系统库（在 prepare 脚本里以 root 跑 `playwright install-deps chromium firefox webkit` 或只装需要的）。
- 本地暂存目录 `/srv/ci-share-local`（权限 2770，组 `gh-ci-share`）+ 清理定时器 + 磁盘下限检查（例如 20 GiB）。
- SSH 客户端密钥、固定 `known_hosts`、`BatchMode=yes`、`ConnectTimeout`；该密钥只能触发 CI VPS 上的接收命令。
- nft 防火墙：对 runner UID 拒绝访问 `169.254.169.254`、私有网段、本机监听端口；允许访问 GitHub 和 CI VPS 的 SSH。
- **强烈建议**：如果测试机上存在测试凭据、SSH key、真实数据，优先把 runner 放进专用 VM/容器，而不是直接跑在测试机宿主用户上。GitHub 官方明确说自托管 runner 可能被工作流代码持久化攻陷；systemd 沙箱只是降低风险，不是隔离边界。

### 3.6 机器不在时怎么办

- **Oracle 掉线、被回收、runner 停掉、标签被移除**：因为 `static`/`security` 用共享标签 `ci-linux`，GitHub 会把它们派到仍带该标签的 x64 runner；CI 不会停摆，也不会把缺失的报告当成通过。
- **作业跑到一半 Oracle 掉了**：该作业失败，汇总作业看到 `needs.static` 或 `needs.security` 不是 success，判失败；重跑整轮（Re-run all jobs）即可。不会静默通过。
- **Oracle 在线但磁盘满/工具坏**：runner 在作业开始前做磁盘下限和工具自检，失败就红；Andy 在另一个线程里移除 ARM 的 `ci-linux` 标签即可让后续作业全走 x64，不需要改代码。
- **CI VPS 的 SSH 接收器坏了**：ARM 作业的 `push` 步骤失败，报告缺失，汇总判失败；不会把本地报告误当已交付。修复接收器后重跑整轮。
- **传输损坏/被截断**：汇总端 `get` 重算摘要失败，`CI_SHARE_DIGEST_MISMATCH`，不会接受。
- **锁文件变更**：所有作业用同一份锁，一起切换；不会出现 x64 和 ARM 各自认一份锁摘要的情况。

### 3.7 上线顺序

1. **Andy 手动**：给 CI VPS 的 1、2 号 runner 加 `ci-linux` 标签；安装 Oracle ARM runner 并加 `ci-linux`，确认 x64 仍有 `ci-vps`、ARM 没有 `ci-vps`。
2. **PR A（工具链）**：加 `linux-arm64` 到 `install-tools` 和主锁、补 ARM 供应商条目、加锁结构测试和 runner 安装脚本/运行手册；不改工作流派发。这个 PR 可以在 x64 上正常合并；合并后主锁摘要变化一次。
3. **在 Oracle 上手工验证**：`install-tools`、`install-dependencies`、`static`、`security` 各跑一次；对比 x64 的 `result.json` 计数和 security findings。
4. **PR B（策略/工作流/传输）**：加 `platforms`、`memberPlatforms`、aggregate/run 校验、`upgradeMovableRunnerPolicy`、`ci-linux` 工作流、`push` 步骤、硬规则和反向用例。先只让 `security` 用 `ci-linux`；`static` 等第 3 步确认后再加。
5. **观察一周**：按 arch 统计作业时长、排队时间、失败率；再决定是否把 `static`、之后的 `policy` 加进池。

---

## 四、考虑过但不选的做法

1. **独立 ARM 锁文件 `ci/toolchain-lock.linux-arm64.json`**
   - 不选。汇总端只核对主锁；独立锁会让 ARM 报告的工具链身份缺少端到端绑定，是 I-73 类缺口。
   - 除非同时给 `Context`/`CheckResult` 加“平台锁摘要”并在 aggregate 里核对；那比一份锁复杂。

2. **把报告直接写到挂载的 `/srv/gh-runner-share`（NFS/sshfs）**
   - 不选。`run-share.mjs` 的 `chmod`、`uid` 检查、`rename` 原子性依赖本机文件系统语义；网络挂载可能悄悄改变这些语义。`shareRoot` 也没有检查文件系统类型。
   - 用 SSH 推送到暂存区再由本机接收器 `rename`，语义和现有 `put` 一致。

3. **用 GitHub 产物或缓存传报告**
   - 不选。违反 ADR 0243 和 Andy 的“不在 GitHub 上花钱”。

4. **把报告编码进 job outputs**
   - 不选。作业输出是几十字节的摘要可以，整份报告是几百 MB；GitHub 作业输出有大小上限，且不是文件传输通道。

5. **让 `build`/`browser`/`coverage` 也跑 ARM**
   - 不选。x64 上线包和依赖它的浏览器/覆盖率测试必须 x64；`aggregate.mjs:200-216` 也把 consumer 平台固定为 `linux-x64`。

6. **把 `required` 放 ARM**
   - 不选。汇总作业要读 CI VPS 共享目录，且是短作业；按 ADR 0256 放专用 x64 gate runner 更稳。

7. **把 Oracle 加进 `ci/policy.json` 的必过检查，让必过检查依赖它**
   - 不选。Oracle 可能被回收/停机；共享标签池让 x64 自动接管，才是“可用但不依赖”。

8. **用 QEMU 在 ARM 上跑 x64 作业**
   - 不选。速度和正确性都不可接受，也不是真正的多架构验证。

---

## 五、风险和反例

1. **测试机安全边界**
   - 风险：CI 作业是任意代码；Oracle 上可能有测试凭据、SSH key、真实数据。GitHub 官方明确说自托管 runner 可被工作流代码持久化攻陷。
   - 反例：一个 PR 在 `security` 里执行 `cat ~/.ssh/...` 或访问 `169.254.169.254`。如果 runner 用户能读这些，就泄露。
   - 缓解：专用用户、systemd 沙箱、`ProtectHome`、`InaccessiblePaths`、nft 阻断元数据/私网/本机端口、不放 docker 组；更强的是专用 VM/容器。这个取舍必须 Andy 拍板。

2. **ARM 上的 `static` 结果与 x64 不一致**
   - 风险：Chromium/字体/布局检查在 ARM 上可能给出不同结果，造成假失败或假通过。
   - 反例：`check:layout` 在 ARM 上因字体缺失失败，但 x64 通过；或反过来漏掉 x64 的问题。
   - 缓解：先在 Oracle 实跑同一 commit，比较 `result.json` 的 counts 和失败集合；`static` 放到第二阶段。Playwright 官方支持 linux-arm64 是必要条件，不是充分条件。

3. **ARM 工具链闭包不完整**
   - 风险：某个 semgrep 依赖或 npm 可选包没有 linux-arm64 版本，`pip install --no-index`/`npm ci` 失败。
   - 反例：ARM wheel 闭包里混入 x64 wheel，或缺少 `pydantic_core` 的 aarch64 wheel。
   - 缓解：在锁校验里按平台检查文件名标签；在 Oracle 上真正跑 `install-tools` + `install-dependencies`；反向用例覆盖缺 wheel/x64 wheel。

4. **跨机传输的新失败点**
   - 风险：SSH key 被 PR 代码读取、接收器路径校验有漏洞、暂存目录遗留、CI VPS 磁盘被填满。
   - 反例：PR 代码用 runner 用户的 key 向接收器发送 `../../etc/...`；或反复上传大文件占满磁盘。
   - 缓解：强制命令 + `rrsync` 限定目录；接收器用与 `run-share` 相同的 `run/name` 正则；拒绝覆盖；暂存清理；磁盘下限；摘要由 `get` 复核。key 的权限仍受“同用户任务可读”限制，这是仓库已接受的信任模型，但测试机上的影响更大，必须在文档里写明。

5. **共享标签导致 x64 被“抢走”作业或 ARM 过载**
   - 风险：GitHub 不按性能/负载调度，只按标签和空闲；ARM 可能接到 `static` 而 x64 空闲，或反之。
   - 反例：Oracle 正在跑测试，CPU 被占，CI 作业变慢。
   - 缓解：systemd `CPUQuota`/`CPUWeight`；观察按 arch 的时长；必要时临时移除 ARM 的 `ci-linux` 标签。

6. **Oracle 免费额度/回收**
   - 风险：4 核/24 GB 不在当前 Always Free 2/12 额度内；Oracle 可能缩容或回收。
   - 缓解：共享标签自动回退；不把 Oracle 放进必过依赖；监控 runner 在线状态；保留 x64 容量。

7. **策略升级函数的 bootstrap 漏洞**
   - 风险：PR 自己第一次改 `runs-on: ci-linux` 时，`runCheck` 用 base 旧 policy，平台/标签对不上。
   - 反例：base 旧 policy 的 `security` 是 `ci-vps/x64`，新 workflow 是 `ci-linux`，`validateWorkflow(source.policy, workflow)` 失败。
   - 缓解：`upgradeMovableRunnerPolicy` 只匹配旧形状；测试“旧 base + 新工作流”通过、半新半旧失败；和 ADR 0256 的 gate 升级函数组合测试。

8. **摘要核对没有覆盖“ARM 锁”**
   - 如果用独立锁，风险是 ARM 实际安装的工具链没有进入 `toolchainSha256`。
   - 缓解：本方案用一份锁；这是选择一份锁的主要理由。

---

## 六、需要人拍板的取舍

1. **是否允许 runner 直接跑在测试机宿主上**，还是放进专用 VM/容器。
   - 推荐：如果测试机上有任何真实凭据/数据，用 VM/容器；否则至少用专用用户 + systemd 沙箱，并接受 GitHub 官方指出的残余风险。

2. **CI 与测试的资源比例**。
   - 推荐初值：`CPUQuota=300%`、`MemoryHigh=18G/MemoryMax=20G`，留 1 核/4 GB；观察一周再调。Andy 决定“CI 优先”是否要更激进（例如不设 CPUQuota、只设 CPUWeight）。

3. **先搬 `security` 还是同时搬 `static`**。
   - 推荐先 `security`；`static` 在 ARM 上做 parity 后再搬。若 queue 压力大，可同时搬但接受 `static` 假失败的风险。

4. **一份锁还是两份锁**。
   - 推荐一份锁；代价是主锁摘要变更一次。若 Andy 更在意“不触碰 x64 锁”，就必须额外设计平台锁摘要的端到端校验，工作量更大。

5. **报告传输用“rsync + 接收器”还是“rsync + timer 移入”**。
   - 推荐“rsync + 强制命令接收器”，一次 SSH 完成，路径最短；timer 方案更容易实现但多一个后台组件。

6. **是否永久增加 ARM parity 门槛**。
   - 可以在上线前做一次/几次手工 parity；是否把它变成常驻检查，取决于 Andy 对额外成本和覆盖的取舍。

7. **Oracle 费用/回收风险**。
   - Andy 已说不用担心费用；但“4 核/24 GB 不是当前 Always Free 额度”是事实，建议把机器标记为“可能被 Oracle 缩容/回收”，并保留 x64 回退。

---

## 七、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本改动只涉及 `.github/workflows/ci.yml`、`ci/policy.json`、`scripts/ci/*`、`scripts/operations/ci-runner*` 和运行手册；不涉及系统提示、工具定义、历史消息、遮盖逻辑或模型请求组装。

- 发给模型的内容仍然只在末尾追加，每轮会变的值仍然只放在最后一条消息里；这条规则没有被本改动触碰。依据：`.claude/rules/prompt-prefix.md:27-32`（“固定的在前，会变的在后”“每轮都会变的内容只放在最后一条用户消息里”）和 `:84`（“这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案”）。
- 新增的 `arch`、`runId`、`runDir`、摘要等值只出现在 CI 作业输出、日志和共享目录，不会自动进入模型上下文。即使未来某个代理把 CI 报告作为工具结果读取，它也是追加在末尾的新消息，不是请求开头。
- 遮盖结果：本改动不碰出口遮盖的代码或密钥；`security` 作业的 `redactText` 仍按同一规则、同一版本执行，ARM/x64 不改变遮盖后的字节。

**依据：** 代码改动面 + `.claude/rules/prompt-prefix.md:27-32,84`。
**未核实：** 我没有在模型请求组装路径里做全仓库引用检索；结论基于改动文件范围。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：不会。** 模型请求的序列化、键顺序、列表顺序、遮盖都不变。

**对 CI 报告：会有“每轮不同”的字段，但它们不是跨请求比较的文本。**
- `CheckResult` 里本来就有 `durationMs`、`retryCount`、`toolchain.runnerImage` 等每轮不同的值；本改动只新增/改变 `toolchain.arch`（x64 或 arm64），这是有意区分平台的字段。
- 汇总端不比较两份报告的整体字节；它比较的是 `repository/event/runId/attempt/testedSha/headSha/baseSha/policySha256/toolchainSha256/initialization` 这些身份字段（`scripts/ci/aggregate.mjs:85-92`），以及 `get` 对**同一份报告树**重算的摘要。
- 共享摘要 `treeDigest` 是按 `[路径, sha256, bytes]` 排序后算的（`scripts/ci/run-share.mjs:59-65`、`scripts/ci/artifact-files.mjs:20-72`），不依赖目录遍历顺序；文件模式不进入摘要，所以 rsync 改变模式不会造成摘要不一致。
- `policySha256` / `toolchainSha256` 对同一轮是固定的；一份锁保证 x64 和 ARM 用同一个 `toolchainSha256`。
- 没有新增时间字段、没有依赖前后文的遮盖、没有无序集合进入身份字段。

**结论：** 不会出现“同一段文字在不同请求里变成不同字节”的问题；ARM/x64 报告的差异是预期的平台字段，且只被 `platforms` 允许集合消费。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**现状：还没有 ARM 专属检查；本方案要求新增，并且要在合并前证明反向用例在旧代码上失败。**

已有的相关检查：
- `test/tooling/policy.test.mjs`：`validatePolicy` / `validateWorkflow` 的正反用例，包括平台、矩阵、`runs-on`、升级函数。
- `test/tooling/ci-optimization.test.mjs`：工作流权限、步骤、`collect/remove` 等。
- `test/tooling/run-share.test.mjs`：`put/get/collect/remove` 的摘要、名称、路径、反向用例。
- `test/tooling/toolchain.test.mjs`、`test/tooling/toolchain-lifecycle.test.mjs`：锁结构、安装、验证。
- `test/tooling/ci-runner-scripts.test.mjs`：runner 标签、暂停/恢复、服务模板。
- 这些由 `npm run check:ci-policy` / `policy` 作业里的 tooling 测试执行；`npm run check` 也会跑。

本方案必须新增的反向用例：
1. **policy/aggregate**
   - `static`/`security` 的 `platforms` 含 `arm64` 时通过；`build`/`browser`/`coverage` 含 `arm64` 必须失败。
   - ARM 报告给 x64-only member 必须失败；ARM 报告给 `static`/`security` 必须通过。
   - `static` 写成 `runs-on: ci-vps` 必须失败；`build` 写成 `runs-on: ci-linux` 必须失败。
   - `required` 写到 `ci-linux` 必须失败（应走 `ci-vps-gate`）。
2. **升级函数**
   - 旧 base + 新工作流通过；新 base + 新工作流通过；半新半旧失败；把 `build` 升级成 ARM 失败；把 `required` 升级成 `ci-linux` 失败。
3. **锁/工具链**
   - ARM 锁条目缺失失败；ARM wheel 用 x64 文件名失败；ARM Node/Python/actionlint/gitleaks 文件名不含 `aarch64`/`arm64` 失败；x64 锁仍能通过。
4. **runner 脚本**
   - ARM runner 标签含 `ci-vps` 失败；x64 runner 缺 `ci-linux` 失败；暂停时只移除 x64 的 `ci-linux`、ARM 仍能被派到作业，必须失败；ARM 服务 `ReadWritePaths` 包含测试数据路径，必须失败。
5. **传输**
   - 摘要不一致：`get` 失败 `CI_SHARE_DIGEST_MISMATCH`。
   - 接收器收到 `../`、绝对路径、非法 `name`、已存在目标：失败。
   - 传输截断/改文件：`get` 失败。
   - x64 作业执行 `push`：no-op 成功；ARM 作业缺 `HIMAWARI_CI_SHARE_REMOTE`：失败。

**反向用例是否真的会失败：** 目前这些用例还不存在，所以答案是“**尚未证明**”。实施时必须按仓库的既有做法，在加守卫前后各跑一次：把守卫改回旧写法，确认至少一条测试变红；再加回守卫，确认全绿。历史教训 I-73 就是“只看了改动，没问清单里的 id 能不能过后端校验”，所以这次要把“产生值的一端”和“消费值的一端”都写进测试。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对如下：

| 值 | 谁产生 | 谁使用 | 两端核对 |
| --- | --- | --- | --- |
| `linux-arm64`（平台） | `install-tools.mjs:25` 的 `platforms`、`ci/toolchain-lock.json`、`installation.json` | `install-tools` 选择下载物、`verifyInstalledTools` 比对 `installation.platform`、`run.mjs` 写 `result.toolchain.arch`、`aggregate` 的允许平台、`ci/policy.json` 的 `platforms` | 锁校验按平台检查文件名；`result.schema.json` 的 `toolchain.arch` 已允许 `arm64`；`artifacts.platform` 仍不允许 `linux-arm64`，而 `static`/`security` 不产 artifact，正好不会误用。**已核对。** |
| `ci-linux`（runner 标签） | runner 注册脚本/`runners.sh`；`ci/policy.json` 的 `runner` | `ci.yml` 的 `runs-on`、`check-policy` 的 `validateWorkflow`、暂停/恢复脚本、运行手册 | 硬规则要求 `static`/`security` 的 `runs-on` 等于 member `runner`；跨文件测试要求 x64 和 ARM 都带 `ci-linux`，且 ARM 不带 `ci-vps`。**需要新增测试，当前没有。** |
| `platforms`（policy 字段） | `ci/policy.json` | `validatePolicy`、`run.mjs`、`aggregate.mjs`、`ci/policy.schema.json` | 两个消费端都用 `memberPlatforms`，schema 限制取值；反向用例覆盖 x64-only/ARM 混写。**需要新增。** |
| `ci-vps-gate`（gate 标签） | ADR 0256 的 runner 脚本/`ci/policy.json` | `ci.yml` 的 `required.runs-on`、`check-policy`、`main-workflow` | 假定 ADR 0256 实施；如果未实施，本方案退回 `ci-vps`，不能混用。**需要与 ADR 0256 的测试一起核对。** |
| `toolchainSha256`（主锁摘要） | `context.mjs:143`、`installation.toolchainSha256` | `aggregate.mjs:288-290`、`result` 身份字段 | 一份锁，x64/ARM 相同；不引入第二份锁。**已核对。** |
| 报告摘要（64 hex） | Oracle/ x64 的 `run-share put` 写 `GITHUB_OUTPUT` | 汇总 `needs.<job>.outputs.<key>`、`run-share get` 重算 | `publishedMembers` 用 `^[0-9a-f]{64}$` 校验；`get` 复制后重算；接收器不改变内容。**已核对，需补传输测试。** |
| `run` / `name`（共享目录名） | `run-share runName` / `checkedName` | 接收器、`get`、`remove`、清理脚本 | 接收器必须复用同一正则；拒绝 `..`/绝对路径/已存在目标。**需要新增测试。** |
| `HIMAWARI_CI_SHARE_REMOTE` | Oracle runner 服务环境 | `push` 脚本 | ARM 上缺失必须失败；x64 上不使用。**需要新增测试。** |
| `CheckResult.toolchain.arch` | `run.mjs:103-110` | `aggregate.mjs:98-105` | 已允许 `arm64`；改为允许集合后，x64-only member 仍拒绝 ARM。**已核对。** |
| `CheckResult.artifacts.platform` | `run.mjs:281-286,475-480` | `aggregate.mjs:182-216` | 仍只允许 `linux-x64`/`macos-arm64`；ARM 作业不产 artifact，因此不会产生该值。**已核对。** |

**结论：** 大部分值的生产端和消费端已经能在代码里对上；`ci-linux`、`platforms`、传输路径和 `HIMAWARI_CI_SHARE_REMOTE` 是新增值，必须补跨文件测试和反向用例，否则就是 I-73 的同类问题。

---

## 八、读代码/来源证实 vs 推测

**已证实：**
- 作业依赖、共享目录、摘要机制、无 GitHub 产物、工具链平台限制、context/aggregate 的锁摘要和平台检查、工作流硬规则、runner 服务加固、Playwright/Node/Python/semgrep/actionlint/gitleaks 的 ARM 发布物、GitHub 标签路由语义、Oracle 当前免费额度。

**推测/未核实：**
- `static` 在 Oracle ARM 上能完整通过（包括 layout/字体）；需要实跑。
- Semgrep ARM wheel 闭包完整、所有 npm 可选原生包都有 linux-arm64；需要 `npm ci`/`pip install` 实跑。
- Oracle 4 核/24 GB 的实际计费/回收状态；只能按“可能被回收”设计。
- 事实 2 的时长/峰值内存、事实 9 的产品 x64 约束，来自材料或代码推断，未在本次独立复现。
- 事实 8 的分支 `claude/project-thread-q668e8` 不在当前对象库，ADR 0253 内容未核实。
