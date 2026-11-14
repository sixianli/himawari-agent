# 方案讨论材料：把 Oracle 的 ARM 机器接进 CI

## 问题

CI（每次推送后 GitHub Actions 自动跑的检查）现在只在一台 x64 的 CI 服务器上跑，两个自托管 runner（装在自己机器上、替 GitHub 执行 CI 任务的程序）一次各跑一个作业。多个线程同时开发时，检查作业排长队。Andy 另有一台 Oracle 东京的 ARM 云服务器（4 核、24 GB 内存，Ubuntu，现在当测试机用），他 2026-11-12 说：“你以后不用担心我那台 Oracle 云服务器费用的问题。现在你就直接告诉我，为了加快 CI，可不可以把那台机器完全利用起来？”协调者定：CI 优先，测试机还要能用。

## 已核对的事实

1. `ci.yml` 一次完整运行有 6 个检查作业和 1 个汇总作业 `ci/required`，全部 `runs-on: ci-vps`（`.github/workflows/ci.yml` 第 33、72、236、284、327 行；build、browser 用 `runs-on: ${{ matrix.runner }}`，第 115、165 行）。static、build、security 写了 `needs: policy`。
2. 实测作业时长（GitHub 接口，2026-11-12）：policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟。policy 峰值内存 2.68 GB。
3. 每个检查作业的步骤相同：`install-tools.mjs` 装固定工具，`install-dependencies.mjs` 装依赖，`run.mjs --check <名>` 跑检查，`publish.mjs` 核验公开输出，`run-share.mjs put` 把报告放进 CI 服务器本机目录（`.github/workflows/ci.yml` 第 50 到 65 行）。
4. 作业之间靠 CI 服务器本机的共享目录交接：`scripts/ci/run-share.mjs` 的 `shareRoot` 读环境变量 `HIMAWARI_CI_SHARE`，要求是本机绝对路径的目录；`put` 算出目录内容的摘要写进作业输出，`get` 和 `collect` 按摘要核对后复制。browser、coverage 用 `get --name build-linux-x64` 取 build 的产物（第 215、265 行）；汇总作业用 `collect` 收齐 6 个检查的报告（第 362 行），最后 `remove` 删掉本次运行的目录（第 371 行）。依据是 `docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md`。
5. 项目决定完全不用 GitHub 产物（artifact）：`docs/adr/0243-ci-uses-no-github-artifacts.md`，`check-policy.mjs` 拒绝 `actions/upload-artifact` 和 `actions/download-artifact`。Andy 的规则：绝不在 GitHub 上花钱。
6. CI 的固定工具只支持两个平台：`scripts/ci/install-tools.mjs` 第 25 行 `const platforms = ["darwin-arm64", "linux-x64"];`。工具链锁文件 `ci/toolchain-lock.json` 里有 node、npm、python、actionlint、gitleaks、semgrep 和 6 个原生依赖的下载地址和校验值。
7. 每份报告的上下文里记着工具链锁文件的摘要：`scripts/ci/context.mjs` 第 143 行 `toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json"))`；汇总时 `scripts/ci/aggregate.mjs` 第 288、289 行拿同一个文件的摘要比对，不一致就判失败。
8. ARM 测试机线程的方案（分支 `claude/project-thread-q668e8` 上的 `docs/adr/0253-support-linux-arm64-for-test-and-qualification.md`）：本地检查认 linux-arm64，ARM 的工具链放在独立的锁文件 `ci/toolchain-lock.linux-arm64.json`；原话“`ci/toolchain-lock.json`、`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改”“把 linux-arm64 加进 `ci/policy.json` 的必过检查｜不采用｜测试机可能被 Oracle 回收，不能让必过检查依赖它”。这部分代码还没写。那个线程同意先拆一个小 PR：`install-tools.mjs` 认 linux-arm64、新增 ARM 锁文件、导出一个“平台到锁文件路径”的函数。
9. 线上产品跑在 x64 机器上；出 x64 上线包的 build、依赖它产物的 browser 和 coverage 必须在 x64 上跑。
10. CI 服务器上的 runner 由 `scripts/operations/ci-runner/` 下的脚本安装成 systemd 服务（`gh-runner.service.in`：专用用户、`ReadWritePaths` 只放开 runner 目录和共享目录、内存上限由 `gh-runners.slice` 管）。云端线程没有两台机器的登录凭证，机器上的操作由 Andy 在 Mac 上执行。
11. 另一个已交给 Andy 的方案（`docs/adr/0256-gate-job-gets-its-own-runner.md`，提议中）：在 CI 服务器上加第三个 runner `ci-vps-gate`，只跑汇总作业。本方案假定它会实施。
12. Oracle 官方文档写 Always Free 的 ARM 额度是有上限（“first 1,500 OCPU hours and 9,000 GB hours per month… equivalent to 2 OCPUs and 12 GB of memory”）；Andy 知道并说不用担心费用。

## 约束

- 不降低检查质量：不删减、不合并、不弱化检查；汇总作业照样要收齐 6 份报告并核对摘要。
- 不在 GitHub 上花钱：不用 GitHub 托管 runner，不用 GitHub 产物和缓存。
- Oracle 机器同时是测试机，CI 优先，但测试还要能跑。
- Oracle 机器可能被回收或停机；那时 CI 不能整个停摆。
- 仓库是私有的，只有 Andy 一个人和他的代理提交代码。
- 代码不写注释；工作流改动要有硬规则和反向用例。

## 请你给出

一套把这台 ARM 机器用于 CI 提速的方案：哪些作业可以搬过去、报告怎样从 Oracle 机器交到汇总作业手里、工具链和摘要核对怎么改、两台机器上各要装什么、机器不在时怎么办、每项的风险和怎样验证。参考 GitHub 官方文档和成熟开源项目在多台自托管 runner、多架构上的做法，附一手来源。指出上面哪条事实你核对后认为不对。
