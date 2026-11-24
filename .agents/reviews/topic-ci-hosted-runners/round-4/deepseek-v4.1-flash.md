CLAIM|1|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:36|CI（持续集成，每次提交自动跑的检查和测试）原先跑在自托管 runner（自己租的服务器上装的 GitHub 执行程序）上|- 即使用的是自托管 runner（装在 Andy 自己的 CI VPS 上、替 GitHub 执行任务的程序），产物和缓存仍然存在 GitHub 上、占 GitHub 的额度。
CLAIM|2|一致|docs/adr/0176-ci-on-ovh-vps.md:12|OVH 的 CI VPS|# ADR 0176：CI 全部搬到 OVH 的 VPS 上，注销 Hermes 上的 runner
CLAIM|3|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:31|Oracle 东京的 ARM 机器|Andy 租的 Oracle 东京 ARM 机器（4 核、24 GB）上已经装好 `ci-arm-1`、`ci-arm-2` 两个 runner。
CLAIM|4|一致|scripts/ci/run-share.mjs:29|`scripts/ci/run-share.mjs` 的 `shareRoot` 要求 `HIMAWARI_CI_SHARE` 指向本机一个已有目录|const info = lstatSync(root, { throwIfNoEntry: false });；if (!info?.isDirectory() || info.isSymbolicLink()) fail("ROOT_INVALID");
CLAIM|5|一致|scripts/ci/run-share.mjs:28|没设或不是绝对路径以 `CI_SHARE_ROOT_REQUIRED` 失败|throw new Error(`CI_SHARE_${code}`);；if (!root || !path.isAbsolute(root)) fail("ROOT_REQUIRED");
CLAIM|6|一致|scripts/ci/run-share.mjs:30|目录不存在以 `CI_SHARE_ROOT_INVALID` 失败|throw new Error(`CI_SHARE_${code}`);；if (!info?.isDirectory() || info.isSymbolicLink()) fail("ROOT_INVALID");
CLAIM|7|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:12|`static` 原来在 Oracle ARM 机器上跑|# ADR 0266：policy、static、security 三项检查改在 Oracle 的 ARM 机器上跑
CLAIM|8|一致|package.json:27|`npm run check` 里的 `check:delivery-dependencies`|npm run check:delivery-dependencies
CLAIM|9|一致|package.json:59|`check:delivery-dependencies` 会真的运行只认 linux-x64 的依赖收集脚本|"check:delivery-dependencies": "python3 -I scripts/delivery-mode/test_collect_dependencies.py",
CLAIM|10|一致|scripts/delivery-mode/test_collect_dependencies.py:58|（`scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs`）|child = subprocess.run(['node', '--import', str(self.preload), str(self.collector), '--source-root', str(self.source), '--modules-root', str(self.source / 'node_modules'), '--output', str(output), '--npm-cli', str(self.npm)], capture_output=True, text=True)；self.assertEqual((TEMPLATE / 'install/collect-installer-dependencies.mjs').read_bytes(), COLLECTOR.read_bytes())
CLAIM|11|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15|只认 linux-x64|process.platform === "linux" && process.arch === "x64"
CLAIM|12|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15|在 ARM 机器上以 `P5_ENVIRONMENT_INVALID` 失败|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|13|一致|scripts/ci/check-policy.mjs:1710|`npm run check:ci-policy` 读 `.github/workflows/` 下全部工作流|readdirSync(workflowDirectory)；.filter((name) => /\.ya?ml$/u.test(name))
CLAIM|14|一致|scripts/ci/check-policy.mjs:910|`runs-on` 不是这三种之一（包括 larger runner、`self-hosted`、浮动标签和算出来的表达式）就以 `HOSTED_RUNNER_REQUIRED` 失败|labels.length > 0 && labels.every((entry) => hostedRunnerLabels.includes(entry)),；`HOSTED_RUNNER_REQUIRED ${file}/${id}: only ${hostedRunnerLabels.join(", ")} are free on this public repository`,
CLAIM|15|一致|scripts/ci/run-share.mjs:108|`run-share.mjs` 的摘要核对不变|if (copied !== digest) {；fail(`DIGEST_MISMATCH:${name}`);
CLAIM|16|一致|docs/adr/0174-no-github-cache-and-one-day-artifacts.md:12|这是对 ADR 0174“不用 GitHub 缓存”的修订|# ADR 0174：CI 不用 GitHub 缓存，artifact 只保存 1 天
CLAIM|17|一致|scripts/operations/ci-runner/install-runner.sh:33@c912aa8cef849140e9fffdd9f028b9899ad852ee|删除自托管 runner 的安装脚本|for id in $RUNNER_IDS; do
CLAIM|18|一致|scripts/ci/remote-share.mjs:94@c912aa8cef849140e9fffdd9f028b9899ad852ee|ssh 拉报告的 `scripts/ci/remote-share.mjs`|const child = spawnProcess(command, sshArguments(config, request, limits), {
CLAIM|19|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c243|CI VPS 的运行手册|# CI VPS 上的自托管 runner Runbook
CLAIM|20|一致|ci/policy.json:47@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-vps`|"runner": "ci-vps",
CLAIM|21|一致|ci/policy.json:30@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-arm`|"runner": "ci-arm",
CLAIM|22|一致|ci/policy.json:173@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-vps-gate`|"runner": "ci-vps-gate",
CLAIM|23|一致|scripts/ci/check-policy.mjs:389|`resolvePolicySource` 在基准上把它们整体换成对应的托管标签|[legacyRunnerLabels.linux]: linuxRunnerLabel,；[legacyRunnerLabels.gate]: gateRunnerLabel,；[legacyRunnerLabels.arm]: armRunnerLabel,；member.runner = hosted[member.runner];；git(["show", `${baseSha}:${policyPath}`])
CLAIM|24|一致|scripts/ci/check-policy.mjs:1554|摘要仍按原始字节算|policySha256: sha256(bytes),
CLAIM|25|一致|.github/workflows/ci.yml:20|`ci.yml` 规定所有作业只读|permissions:；contents: read；pull-requests: read
CLAIM|26|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55|这修订了 ADR 0241 里“结束时删除共享目录”|上传汇总结论和删除共享目录的步骤也不运行
CLAIM|27|一致|docs/adr/0243-ci-uses-no-github-artifacts.md:59|和 ADR 0243 里“完整报告在 CI 服务器的共享目录里”的说法|`ci.yml` 的完整报告仍在 CI 服务器的共享目录里
CLAIM|28|一致|docs/adr/0176-ci-on-ovh-vps.md:128|自托管时代的 ADR（0176、0238、0256、0266、0275）里提到的 CI VPS 运行手册已删除|CI VPS 上的自托管 runner Runbook（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）
CLAIM|29|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:106|自托管时代的 ADR（0176、0238、0256、0266、0275）里提到的 CI VPS 运行手册已删除|CI VPS 上的自托管 runner Runbook（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）
CLAIM|30|一致|docs/adr/0256-gate-job-gets-its-own-runner.md:171|自托管时代的 ADR（0176、0238、0256、0266、0275）里提到的 CI VPS 运行手册已删除|CI 服务器 runner 运行手册（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）
CLAIM|31|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:99|自托管时代的 ADR（0176、0238、0256、0266、0275）里提到的 CI VPS 运行手册已删除|CI 服务器 runner 运行手册（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）
CLAIM|32|一致|docs/adr/0275-tests-job-runs-on-three-runners.md:39|自托管时代的 ADR（0176、0238、0256、0266、0275）里提到的 CI VPS 运行手册已删除|CI VPS runner 运行手册（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）
CLAIM|33|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c243|CI VPS 运行手册已删除|# CI VPS 上的自托管 runner Runbook
CLAIM|34|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c243|最后一版在提交 `88e17c24`|# CI VPS 上的自托管 runner Runbook
CLAIM|35|一致|docs/incidents-and-gates.md:129|I-95 就是 artifact 额度撑爆导致 CI 全红|2026-11-11 起所有 PR 和 main 的 CI 都在上传步骤失败（`ci/required` 全红）
CLAIM|36|一致|scripts/ci/build.mjs:137|构建不可复现（归档名带运行号）|`${platform}-abi${process.versions.modules}-${context.testedSha}-${context.runId}-${context.attempt}.tar.gz`,
CLAIM|37|一致|.github/workflows/ci.yml:250|也失去“消费者用的就是 build 作业那份归档”的核对|CI_BUILD_DIGEST: ${{ needs.build.outputs.linux-x64 }}；run: .ci-output/tools/bin/node scripts/ci/run-share.mjs get --name build-linux-x64 --digest "$CI_BUILD_DIGEST" --to .ci-output/input

未能核对的部分包括仓库公开状态、OVH 退租、Oracle 改生产、6 台 runner 注销，以及 GitHub 的计费、缓存额度、macOS 机器规格等外部或账户层面的事实；方案里新增或修改的托管标签、运行内缓存传递、`prepare-hosted.sh`、Apple 工作流等计划项，也未按“现状”核对。
