CLAIM|1|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:62|ADR 0253 现在写明 ARM 不进必过检查。来源：`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md` 第 62 行，原话“ARM 不进 GitHub 必过检查，也不切线上。”|把 linux-arm64 作为测试和资格验收用的平台支持起来，分四个 PR，x64 的托管 CI 和生产行为不变。ARM 不进 GitHub 必过检查，也不切线上。
CLAIM|2|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:83|第 83 行，原话“测试机可能被 Oracle 回收，不能让必过检查依赖它”|｜ 把 linux-arm64 加进 `ci/policy.json` 的必过检查 ｜ 不采用 ｜ 测试机可能被 Oracle 回收，不能让必过检查依赖它 ｜
CLAIM|3|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:66|ADR 0253 同时写明 `ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流不改。来源：同一文件第 66 行，原话“`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。”|`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。
CLAIM|4|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:92|ADR 0238 写明只有 CI 服务器上的 runner 能跑这套 CI。来源：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md` 第 92 行，原话“只有 CI VPS 上的 runner 能跑这套 CI”。|- 只有 CI VPS 上的 runner 能跑这套 CI：作业要靠 `HIMAWARI_CI_SHARE` 和共享目录，换到 GitHub 托管的 runner 上会以 `CI_SHARE_ROOT_REQUIRED` 失败。这是有意的：Andy 不在 GitHub 上花钱。
CLAIM|5|一致|.github/workflows/ci.yml:33|三项检查的运行位置在 `.github/workflows/ci.yml`：policy 第 33 行，原话 `runs-on: ci-arm`。|    runs-on: ci-arm
CLAIM|6|一致|.github/workflows/ci.yml:72|三项检查的运行位置在 `.github/workflows/ci.yml`：static 第 72 行，原话 `runs-on: ci-arm`。|    runs-on: ci-arm
CLAIM|7|一致|.github/workflows/ci.yml:284|三项检查的运行位置在 `.github/workflows/ci.yml`：security 第 284 行，原话 `runs-on: ci-arm`。|    runs-on: ci-arm
CLAIM|8|一致|.github/workflows/ci.yml:362|汇总作业用 `--remote-jobs policy,static,security` 去 ARM 机器取报告。来源：`.github/workflows/ci.yml` 第 362 行，原话 `run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,security`。|        run: .ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,security
CLAIM|9|一致|ci/policy.json:15|策略里这三项允许的架构：`ci/policy.json` 的 policy 第 15 行，原话 `"arch": "x64"`。|          "arch": "x64",
CLAIM|10|一致|ci/policy.json:16|策略里这三项允许的架构：`ci/policy.json` 的 policy 第 16 行，原话 `"alternateArch": "arm64"`。|          "alternateArch": "arm64",
CLAIM|11|一致|ci/policy.json:32|策略里这三项允许的架构：`ci/policy.json` 的 static 第 32 行，原话 `"arch": "x64"`。|          "arch": "x64",
CLAIM|12|一致|ci/policy.json:33|策略里这三项允许的架构：`ci/policy.json` 的 static 第 33 行，原话 `"alternateArch": "arm64"`。|          "alternateArch": "arm64",
CLAIM|13|一致|ci/policy.json:122|策略里这三项允许的架构：`ci/policy.json` 的 security 第 122 行，原话 `"arch": "x64"`。|          "arch": "x64",
CLAIM|14|一致|ci/policy.json:123|策略里这三项允许的架构：`ci/policy.json` 的 security 第 123 行，原话 `"alternateArch": "arm64"`。|          "alternateArch": "arm64",
CLAIM|15|一致|scripts/ci/host-load.mjs:28|日志里的 `CI_HOST_LOAD` 行|      "CI_HOST_LOAD",
CLAIM|16|一致|docs/runbooks/ci-vps-runner-runbook.md:180|Andy 租的 Oracle 东京 ARM 机器（4 核、24 GB）上已经装好 `ci-arm-1`、`ci-arm-2` 两个 runner|第二处 runner 装在 Andy 的 Oracle 东京 ARM 机器上（Ubuntu 24.04，处理器是 64 位 ARM，系统里显示为 `aarch64`；4 核 24 GB，公网地址 `138.2.31.252`，这台机器同时是测试机）。那里有两个 runner：`ci-arm-1` 和 `ci-arm-2`，标签都是 `ci-arm`，合计最多用 18 GB 内存。
CLAIM|17|一致|docs/runbooks/ci-vps-runner-runbook.md:180|build、browser、coverage 和汇总作业仍在 CI 服务器上|build、browser、coverage 和汇总作业仍在 CI 服务器上。
CLAIM|18|一致|scripts/ci/aggregate.mjs:102|汇总时报告里的架构必须是这两个值之一|    if (![member.arch, member.alternateArch].includes(result.toolchain.arch))
CLAIM|19|一致|scripts/ci/check-policy.mjs:377|build 等其他检查不接受 arm64，也不接受其他架构|          member.alternateArch === (arm ? "arm64" : undefined) &&
CLAIM|20|一致|docs/runbooks/ci-vps-runner-runbook.md:199|应急用 `arm-fallback.sh on` 把 `ci-arm` 标签加到 CI 服务器的检查 runner 上|在 Mac 上运行 `scripts/operations/ci-runner/arm-fallback.sh on`，先从 CI VPS 读出装了哪些 runner，把 `ci-arm` 标签加到已装的检查 runner（`ci-vps-1`、`ci-vps-2`、`ci-vps-3`；还没装的跳过，并打印 `not installed on ci-vps, left out:`）上，这些任务改由 CI VPS 接（`ARM_FALLBACK_ON`）
CLAIM|21|一致|docs/runbooks/ci-vps-runner-runbook.md:195|汇总作业用只读的 ssh 去 ARM 机器取这三项的报告，取回的内容照旧按摘要核对|汇总作业在 CI VPS 上发现本机共享目录里没有某份报告、而命令行的 `--remote-jobs` 名单里有这个作业时，用上面那把钥匙连 ARM 机器，请求名只能是“运行号-重试号/报告名”，对方把那个目录里的普通文件打成一段 JSON 交回来（符号链接、硬链接、超过 500 个文件、单个文件超过 16 MiB、合计超过 64 MiB 都拒绝）。取回的内容写进本机共享目录后照旧按摘要核对
CLAIM|22|一致|docs/runbooks/ci-vps-runner-runbook.md:178|取报告的做法见运行手册“Oracle 的 ARM 机器上的两个 runner”一节|### Oracle 的 ARM 机器上的两个 runner
CLAIM|23|一致|ci/toolchain-lock.json:23|ARM 的工具链条目放在主锁文件 `ci/toolchain-lock.json` 里|          "linux-arm64": {
CLAIM|24|一致|ci/toolchain-lock.json:23-24|里面已有 linux-arm64 的 Node|            "filename": "node-v22.22.3-linux-arm64.tar.gz",
CLAIM|25|一致|ci/toolchain-lock.json:75-76|里面已有 linux-arm64 的 Python|            "filename": "cpython-3.12.10+20250529-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
CLAIM|26|一致|ci/toolchain-lock.json:133-134|里面已有 linux-arm64 的 actionlint|            "filename": "actionlint_1.7.11_linux_arm64.tar.gz",
CLAIM|27|一致|ci/toolchain-lock.json:158-159|里面已有 linux-arm64 的 gitleaks|            "filename": "gitleaks_8.30.0_linux_arm64.tar.gz",
CLAIM|28|一致|ci/toolchain-lock.json:1491|里面已有 linux-arm64 的 Semgrep|            "filename": "semgrep-1.152.0-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-musllinux_1_0_aarch64.manylinux2014_aarch64.whl",
CLAIM|29|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:66|不是 ADR 0253 第 66 行写的独立锁文件|ARM 的工具链放在独立的锁文件里，有自己的校验和自己的摘要字段；
CLAIM|30|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:84|第 84 行给出不直接加进主锁文件的理由|｜ 把 ARM 条目直接加进 `ci/toolchain-lock.json` ｜ 不采用 ｜ 这个文件的摘要写进 x64 产物记录，改它会改变 x64 的记录 ｜
CLAIM|31|一致|scripts/ci/aggregate.mjs:290-291|汇总比对锁文件摘要，只有一份锁文件才对得上|  if (sha256(lockBytes) !== context.toolchainSha256)
CLAIM|32|一致|test/tooling/policy.test.mjs:1305|试跑工作流已删除|    expect(existsSync(path.join(repositoryRoot, ".github/workflows/ci-arm-trial.yml"))).toBe(false);
CLAIM|33|一致|docs/runbooks/ci-vps-runner-runbook.md:180|Oracle 机器同时是测试机|这台机器同时是测试机
CLAIM|34|找不到|-|runner 账号被限制成读不到测试数据|-
CLAIM|35|一致|docs/runbooks/ci-vps-runner-runbook.md:66|仓库私有、只有 Andy 和他的代理提交|仓库是私有的，只有 Andy 和他自己的代理线程会推送，所以接受这一点。
CLAIM|36|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:91|这和 CI 服务器接受的前提相同|仓库私有、只有 Andy 和他的代理线程推送，这和 [ADR 0176](0176-ci-on-ovh-vps.md) 接受“同一个 runner 上的任务互相能改”是同一个理由
CLAIM|37|一致|test/tooling/policy.test.mjs:1223|测试在 `test/tooling/policy.test.mjs`，名字带 `[ADR-0266]`|  it("[ADR-0266] 基准上三项检查没有 alternateArch 的策略升级成在 ci-arm 上跑，摘要仍按原始字节算", () => {
CLAIM|38|一致|test/tooling/policy.test.mjs:1281-1287|三项检查的 `runs-on` 写回 `ci-vps`、coverage 写成 `ci-arm`，都必须失败|  ])("[ADR-0266] ci.yml 里 %s 的 runs-on 写成 %s 就被拒", (id, label) => {
CLAIM|39|一致|test/tooling/policy.test.mjs:1292|漏写或少写 `--remote-jobs` 的名单，都必须失败|  it("[ADR-0266] 汇总作业不带 --remote-jobs 或带的检查不对就被拒", () => {
CLAIM|40|一致|test/tooling/aggregate.test.mjs:401|三项检查的 arm64 报告通过，build 的 arm64 报告和任何检查的 ppc64 报告失败；测试在 `test/tooling/aggregate.test.mjs`。|  it("[ADR-0266] 三项检查的 arm64 报告被接受，其余检查和其他架构被拒", () => {

未核对的部分：ARM 机器上三项检查的真实时长和失败率（方案自己标为未核实）；runner 账号读不到测试数据这一条（仓库里只看到 `ProtectHome=yes`，没有说明测试数据放在哪里）。
