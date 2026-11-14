CLAIM|1|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:62|ADR 0253 现在写明 ARM 不进必过检查。来源：`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md` 第 62 行，原话“ARM 不进 GitHub 必过检查，也不切线上。”|把 linux-arm64 作为测试和资格验收用的平台支持起来，分四个 PR，x64 的托管 CI 和生产行为不变。ARM 不进 GitHub 必过检查，也不切线上。
CLAIM|2|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:83|第 83 行，原话“测试机可能被 Oracle 回收，不能让必过检查依赖它”。|测试机可能被 Oracle 回收，不能让必过检查依赖它
CLAIM|3|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:66|ADR 0253 同时写明 `ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流不改。来源：同一文件第 66 行，原话“`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。”|`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。
CLAIM|4|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:66|不是 ADR 0253 第 66 行写的独立锁文件|ARM 的工具链放在独立的锁文件里，有自己的校验和自己的摘要字段
CLAIM|5|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:84|第 84 行给出不直接加进主锁文件的理由|这个文件的摘要写进 x64 产物记录，改它会改变 x64 的记录
CLAIM|6|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:92|ADR 0238 写明只有 CI 服务器上的 runner 能跑这套 CI。来源：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md` 第 92 行，原话“只有 CI VPS 上的 runner 能跑这套 CI”。|只有 CI VPS 上的 runner 能跑这套 CI
CLAIM|7|一致|.github/workflows/ci.yml:33|三项检查的运行位置在 `.github/workflows/ci.yml`：policy 第 33 行，原话 `runs-on: ci-arm`。|    runs-on: ci-arm
CLAIM|8|一致|.github/workflows/ci.yml:72|static 第 72 行，原话 `runs-on: ci-arm`。|    runs-on: ci-arm
CLAIM|9|一致|.github/workflows/ci.yml:284|security 第 284 行，原话 `runs-on: ci-arm`。|    runs-on: ci-arm
CLAIM|10|一致|.github/workflows/ci.yml:362|汇总作业用 `--remote-jobs policy,static,security` 去 ARM 机器取报告。来源：`.github/workflows/ci.yml` 第 362 行，原话 `run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,security`。|        run: .ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,security
CLAIM|11|一致|ci/policy.json:15|策略里这三项允许的架构：`ci/policy.json`（policy 第 15、16 行，static 第 32、33 行，security 第 122、123 行），原话 `"arch": "x64"`、`"alternateArch": "arm64"`。|          "arch": "x64",
CLAIM|12|一致|ci/policy.json:16|策略里这三项允许的架构：`ci/policy.json`（policy 第 15、16 行，static 第 32、33 行，security 第 122、123 行），原话 `"arch": "x64"`、`"alternateArch": "arm64"`。|          "alternateArch": "arm64",
CLAIM|13|一致|ci/policy.json:32|策略里这三项允许的架构：`ci/policy.json`（policy 第 15、16 行，static 第 32、33 行，security 第 122、123 行），原话 `"arch": "x64"`、`"alternateArch": "arm64"`。|          "arch": "x64",
CLAIM|14|一致|ci/policy.json:33|策略里这三项允许的架构：`ci/policy.json`（policy 第 15、16 行，static 第 32、33 行，security 第 122、123 行），原话 `"arch": "x64"`、`"alternateArch": "arm64"`。|          "alternateArch": "arm64",
CLAIM|15|一致|ci/policy.json:122|策略里这三项允许的架构：`ci/policy.json`（policy 第 15、16 行，static 第 32、33 行，security 第 122、123 行），原话 `"arch": "x64"`、`"alternateArch": "arm64"`。|          "arch": "x64",
CLAIM|16|一致|ci/policy.json:123|策略里这三项允许的架构：`ci/policy.json`（policy 第 15、16 行，static 第 32、33 行，security 第 122、123 行），原话 `"arch": "x64"`、`"alternateArch": "arm64"`。|          "alternateArch": "arm64",
CLAIM|17|一致|.github/workflows/ci.yml:124|build、browser、coverage 和汇总作业仍在 CI 服务器上，因为后几项要用 x64 的构建产物。|            runner: ci-vps
CLAIM|18|一致|.github/workflows/ci.yml:178|build、browser、coverage 和汇总作业仍在 CI 服务器上，因为后几项要用 x64 的构建产物。|            runner: ci-vps
CLAIM|19|一致|.github/workflows/ci.yml:236|build、browser、coverage 和汇总作业仍在 CI 服务器上，因为后几项要用 x64 的构建产物。|    runs-on: ci-vps
CLAIM|20|一致|.github/workflows/ci.yml:327|build、browser、coverage 和汇总作业仍在 CI 服务器上，因为后几项要用 x64 的构建产物。|    runs-on: ci-vps-gate
CLAIM|21|一致|ci/toolchain-lock.json:23|里面已有 linux-arm64 的 Node|          "linux-arm64": {
CLAIM|22|一致|ci/toolchain-lock.json:75|里面已有 linux-arm64 的 Python|      "linux-arm64": {
CLAIM|23|一致|ci/toolchain-lock.json:133|里面已有 linux-arm64 的 actionlint|        "linux-arm64": {
CLAIM|24|一致|ci/toolchain-lock.json:158|里面已有 linux-arm64 的 gitleaks|        "linux-arm64": {
CLAIM|25|一致|ci/toolchain-lock.json:1102|里面已有 linux-arm64 的 Semgrep|        "linux-arm64": [
CLAIM|26|一致|scripts/ci/aggregate.mjs:291|汇总比对锁文件摘要，只有一份锁文件才对得上。|  if (sha256(lockBytes) !== context.toolchainSha256)
CLAIM|27|一致|test/tooling/policy.test.mjs:1305|试跑工作流已删除|    expect(existsSync(path.join(repositoryRoot, ".github/workflows/ci-arm-trial.yml"))).toBe(false);
CLAIM|28|一致|test/tooling/policy.test.mjs:1223|测试在 `test/tooling/policy.test.mjs`，名字带 `[ADR-0266]`。|  it("[ADR-0266] 基准上三项检查没有 alternateArch 的策略升级成在 ci-arm 上跑，摘要仍按原始字节算", () => {
CLAIM|29|一致|test/tooling/policy.test.mjs:1282|三项检查的 `runs-on` 写回 `ci-vps`……都必须失败|    ["static", "ci-vps"],
CLAIM|30|一致|test/tooling/policy.test.mjs:1285|coverage 写成 `ci-arm`……必须失败|    ["coverage", "ci-arm"],
CLAIM|31|一致|test/tooling/policy.test.mjs:1292|漏写或少写 `--remote-jobs` 的名单，都必须失败|  it("[ADR-0266] 汇总作业不带 --remote-jobs 或带的检查不对就被拒", () => {
CLAIM|32|一致|test/tooling/aggregate.test.mjs:405|汇总：三项检查的 arm64 报告通过|        expect(aggregate(input).status).toBe("passed");
CLAIM|33|一致|test/tooling/aggregate.test.mjs:409|任何检查的 ppc64 报告失败|        expect(failed.status).toBe("failed");
CLAIM|34|一致|test/tooling/aggregate.test.mjs:415|build 的 arm64 报告失败|    expect(failed.status).toBe("failed");
CLAIM|35|一致|test/tooling/aggregate.test.mjs:401|测试在 `test/tooling/aggregate.test.mjs`|  it("[ADR-0266] 三项检查的 arm64 报告被接受，其余检查和其他架构被拒", () => {
CLAIM|36|一致|docs/runbooks/ci-vps-runner-runbook.md:178|取报告的做法见运行手册“Oracle 的 ARM 机器上的两个 runner”一节|### Oracle 的 ARM 机器上的两个 runner
CLAIM|37|一致|docs/runbooks/ci-vps-runner-runbook.md:195|汇总作业用只读的 ssh 去 ARM 机器取这三项的报告，取回的内容照旧按摘要核对|取回的内容写进本机共享目录后照旧按摘要核对
CLAIM|38|一致|scripts/operations/ci-runner/gh-runner.service.in:33|runner 的服务单元设了 `ProtectHome=yes`（来源：`scripts/operations/ci-runner/gh-runner.service.in` 第 33 行）|ProtectHome=yes
CLAIM|39|一致|docs/runbooks/ci-vps-runner-runbook.md:38|能接检查作业的 runner 从 3 个（`ci-vps-1`、`ci-vps-2`、`ci-vps-3`）|`ci-vps-1`、`ci-vps-2` 和 `ci-vps-3`（脚本里的编号是 1、2、6）是检查 runner
CLAIM|40|一致|docs/runbooks/ci-vps-runner-runbook.md:180|再加 `ci-arm-1`、`ci-arm-2`|那里有两个 runner：`ci-arm-1` 和 `ci-arm-2`，标签都是 `ci-arm`，合计最多用 18 GB 内存。
CLAIM|41|一致|docs/runbooks/ci-vps-runner-runbook.md:180|Andy 租的 Oracle 东京 ARM 机器（4 核、24 GB）|4 核 24 GB
CLAIM|42|一致|docs/runbooks/ci-vps-runner-runbook.md:180|Oracle 机器同时是测试机|这台机器同时是测试机

Andy 的原话、Oracle 机器上的实际安装与在线状态、开发排队情况，以及 ADR 自己标注为“未核实”的 ARM 上三项检查真实时长和失败率，都无法从仓库内代码或文档证实。试跑工作流只核对了当前仓库中不存在该文件，未核对它过去是否存在及其历史。
