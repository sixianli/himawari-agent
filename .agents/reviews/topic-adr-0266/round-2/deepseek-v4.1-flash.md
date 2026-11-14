CLAIM|1|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:62|ADR 0253 第 62 行，原话“ARM 不进 GitHub 必过检查，也不切线上。”|ARM 不进 GitHub 必过检查，也不切线上。
CLAIM|2|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:83|第 83 行，原话“测试机可能被 Oracle 回收，不能让必过检查依赖它”|测试机可能被 Oracle 回收，不能让必过检查依赖它
CLAIM|3|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:66|ADR 0253 同时写明 `ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改；来源同一文件第 66 行，原话“`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。”|`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。
CLAIM|4|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:66|不是 ADR 0253 第 66 行写的独立锁文件|ARM 的工具链放在独立的锁文件里，有自己的校验和自己的摘要字段
CLAIM|5|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:84|第 84 行给出不直接加进主锁文件的理由|这个文件的摘要写进 x64 产物记录，改它会改变 x64 的记录
CLAIM|6|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:92|ADR 0238 第 92 行，原话“只有 CI VPS 上的 runner 能跑这套 CI”|只有 CI VPS 上的 runner 能跑这套 CI
CLAIM|7|一致|.github/workflows/ci.yml:33|policy 第 33 行，原话 `runs-on: ci-arm`|    runs-on: ci-arm
CLAIM|8|一致|.github/workflows/ci.yml:72|static 第 72 行，原话 `runs-on: ci-arm`|    runs-on: ci-arm
CLAIM|9|一致|.github/workflows/ci.yml:284|security 第 284 行，原话 `runs-on: ci-arm`|    runs-on: ci-arm
CLAIM|10|一致|.github/workflows/ci.yml:362|`.github/workflows/ci.yml` 第 362 行，原话 `run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,security`|        run: .ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports --remote-jobs policy,static,security
CLAIM|11|一致|ci/policy.json:15|policy 第 15、16 行，原话 `"arch": "x64"`、`"alternateArch": "arm64"`（arch 部分）|          "arch": "x64",
CLAIM|12|一致|ci/policy.json:16|policy 第 15、16 行，原话 `"arch": "x64"`、`"alternateArch": "arm64"`（alternateArch 部分）|          "alternateArch": "arm64",
CLAIM|13|一致|ci/policy.json:32|static 第 32、33 行，原话 `"arch": "x64"`、`"alternateArch": "arm64"`（arch 部分）|          "arch": "x64",
CLAIM|14|一致|ci/policy.json:33|static 第 32、33 行，原话 `"arch": "x64"`、`"alternateArch": "arm64"`（alternateArch 部分）|          "alternateArch": "arm64",
CLAIM|15|一致|ci/policy.json:122|security 第 122、123 行，原话 `"arch": "x64"`、`"alternateArch": "arm64"`（arch 部分）|          "arch": "x64",
CLAIM|16|一致|ci/policy.json:123|security 第 122、123 行，原话 `"arch": "x64"`、`"alternateArch": "arm64"`（alternateArch 部分）|          "alternateArch": "arm64",
CLAIM|17|一致|docs/runbooks/ci-vps-runner-runbook.md:17|CI 的检查作业原来全部排在 CI 服务器的几个 runner 上|原来两个跑检查、一个只跑汇总作业
CLAIM|18|找不到|-|Oracle 东京 ARM 机器（4 核、24 GB）上已经装好 `ci-arm-1`、`ci-arm-2` 两个 runner|-
CLAIM|19|找不到|-|此前只跑不计入必过结论的试跑工作流|-
CLAIM|20|一致|docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:62|试跑不计入必过结论|ARM 不进 GitHub 必过检查，也不切线上。
CLAIM|21|一致|docs/runbooks/ci-vps-runner-runbook.md:180|build、browser、coverage 和汇总作业仍在 CI 服务器上|build、browser、coverage 和汇总作业仍在 CI 服务器上
CLAIM|22|一致|scripts/ci/aggregate.mjs:102|汇总时报告里的架构必须是这两个值之一|    if (![member.arch, member.alternateArch].includes(result.toolchain.arch))
CLAIM|23|一致|scripts/ci/aggregate.mjs:102|build 等其他检查不接受 arm64，也不接受其他架构|    if (![member.arch, member.alternateArch].includes(result.toolchain.arch))
CLAIM|24|一致|scripts/operations/ci-runner/arm-fallback.sh:69|应急用 `arm-fallback.sh on` 把 `ci-arm` 标签加到 CI 服务器的检查 runner 上|    add_label "$(runner_field "$TABLE" "$name" 1)" "$RUNNER_ARM_LABEL" || echo "could not add $RUNNER_ARM_LABEL to $name"
CLAIM|25|一致|docs/runbooks/ci-vps-runner-runbook.md:231|这时三项检查在 x64 上跑|三个检查 runner 的标签有 `self-hosted`、`Linux`、`X64`、`ci-vps`
CLAIM|26|一致|scripts/ci/aggregate.mjs:102|汇总照样认可|    if (![member.arch, member.alternateArch].includes(result.toolchain.arch))
CLAIM|27|一致|scripts/ci/host-load.mjs:28|“在哪种机器上跑”靠运行时的 runner 标签和日志里的 `CI_HOST_LOAD` 行核对，不靠汇总拦|      "CI_HOST_LOAD",
CLAIM|28|一致|docs/runbooks/ci-vps-runner-runbook.md:195|汇总作业用只读的 ssh 去 ARM 机器取这三项的报告|用上面那把钥匙连 ARM 机器，请求名只能是“运行号-重试号/报告名”
CLAIM|29|一致|scripts/ci/run-share.mjs:137|取回的内容照旧按摘要核对|      await get({ root, run, name, digest, to: path.join(to, name) });
CLAIM|30|一致|docs/runbooks/ci-vps-runner-runbook.md:178|取报告的做法见运行手册“Oracle 的 ARM 机器上的两个 runner”一节|### Oracle 的 ARM 机器上的两个 runner
CLAIM|31|一致|ci/toolchain-lock.json:23|ARM 的工具链条目放在主锁文件 `ci/toolchain-lock.json` 里|          "linux-arm64": {
CLAIM|32|一致|ci/toolchain-lock.json:24|里面已有 linux-arm64 的 Node|            "filename": "node-v22.22.3-linux-arm64.tar.gz",
CLAIM|33|一致|ci/toolchain-lock.json:76|里面已有 linux-arm64 的 Python|            "filename": "cpython-3.12.10+20250529-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
CLAIM|34|一致|ci/toolchain-lock.json:134|里面已有 linux-arm64 的 actionlint|            "filename": "actionlint_1.7.11_linux_arm64.tar.gz",
CLAIM|35|一致|ci/toolchain-lock.json:159|里面已有 linux-arm64 的 gitleaks|            "filename": "gitleaks_8.30.0_linux_arm64.tar.gz",
CLAIM|36|一致|ci/toolchain-lock.json:1491|里面已有 linux-arm64 的 Semgrep|            "filename": "semgrep-1.152.0-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-musllinux_1_0_aarch64.manylinux2014_aarch64.whl",
CLAIM|37|一致|scripts/ci/aggregate.mjs:291|汇总比对锁文件摘要，只有一份锁文件才对得上|  if (sha256(lockBytes) !== context.toolchainSha256)
CLAIM|38|一致|test/tooling/policy.test.mjs:1305|试跑工作流已删除|    expect(existsSync(path.join(repositoryRoot, ".github/workflows/ci-arm-trial.yml"))).toBe(false);
CLAIM|39|一致|docs/runbooks/ci-vps-runner-runbook.md:180|Oracle 机器同时是测试机|这台机器同时是测试机
CLAIM|40|一致|scripts/operations/ci-runner/gh-runner.service.in:33|runner 的服务单元设了 `ProtectHome=yes`（来源 `scripts/operations/ci-runner/gh-runner.service.in` 第 33 行），看不到 `/home`|ProtectHome=yes
CLAIM|41|找不到|-|仓库私有、只有 Andy 和他的代理提交|-
CLAIM|42|一致|scripts/ci/aggregate.mjs:102|汇总不区分 ARM 和应急时的 x64|    if (![member.arch, member.alternateArch].includes(result.toolchain.arch))
CLAIM|43|不一致|docs/runbooks/ci-vps-runner-runbook.md:38|同时能跑的检查作业从 2 个变成 4 个|`ci-vps-1`、`ci-vps-2` 和 `ci-vps-3`（脚本里的编号是 1、2、6）是检查 runner
CLAIM|44|一致|test/tooling/policy.test.mjs:1282|三项检查的 `runs-on` 写回 `ci-vps`...都必须失败|    ["static", "ci-vps"],
CLAIM|45|一致|test/tooling/policy.test.mjs:1285|coverage 写成 `ci-arm`...必须失败|    ["coverage", "ci-arm"],
CLAIM|46|一致|test/tooling/policy.test.mjs:1299|漏写或少写 `--remote-jobs` 的名单...都必须失败|    find(partial).run = find(partial).run.replace(/--remote-jobs \S+/u, "--remote-jobs policy");
CLAIM|47|一致|test/tooling/policy.test.mjs:1273|测试在 `test/tooling/policy.test.mjs`，名字带 `[ADR-0266]`|  ])("[ADR-0266] 策略里%s就被拒", (_label, id, change) => {
CLAIM|48|一致|test/tooling/aggregate.test.mjs:405|三项检查的 arm64 报告通过|      expect(aggregate(input).status).toBe("passed");
CLAIM|49|一致|test/tooling/aggregate.test.mjs:413|build 的 arm64 报告...失败|    selected(build, "build", "linux-x64").result.toolchain.arch = "arm64";
CLAIM|50|一致|test/tooling/aggregate.test.mjs:407|任何检查的 ppc64 报告失败|      selected(other, id).result.toolchain.arch = "ppc64";
CLAIM|51|一致|test/tooling/aggregate.test.mjs:401|测试在 `test/tooling/aggregate.test.mjs`|  it("[ADR-0266] 三项检查的 arm64 报告被接受，其余检查和其他架构被拒", () => {

ARM 机器的实际安装状态、两个 runner 是否在线、三项检查的真实时长和失败率、仓库的私有设置无法从当前检出核实；试跑工作流在此前是否只跑过 ARM 检查也没有读到直接证据。
