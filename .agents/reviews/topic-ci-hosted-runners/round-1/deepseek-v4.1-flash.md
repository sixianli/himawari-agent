CLAIM|1|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:31|CI（持续集成，每次提交自动跑的检查和测试）原先跑在自托管 runner（自己租的服务器上装的 GitHub 执行程序）上|CI（每次推送后 GitHub Actions 自动跑的检查）的检查作业原来全部排在 CI 服务器的几个 runner（装在自己机器上、替 GitHub 执行作业的程序）上，开发线程一多就排长队。
CLAIM|2|一致|docs/adr/0176-ci-on-ovh-vps.md:32|原先 CI 跑在 OVH 的 CI VPS 上|Andy 租了一台 OVH（法国的云服务商）的 VPS（按月租用的云服务器）。2026-11-06 核对到的情况：
CLAIM|3|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:31|原先 CI 跑在 Oracle 东京的 ARM 机器上|Andy 租的 Oracle 东京 ARM 机器（4 核、24 GB）上已经装好 `ci-arm-1`、`ci-arm-2` 两个 runner。
CLAIM|4|不一致|scripts/ci/run-share.mjs:30|原先 scripts/ci/run-share.mjs 的 shareRoot 要求 HIMAWARI_CI_SHARE 指向本机一个已有目录，否则以 CI_SHARE_ROOT_REQUIRED 失败|  if (!info?.isDirectory() || info.isSymbolicLink()) fail("ROOT_INVALID");
CLAIM|5|一致|ci/policy.json:30@c912aa8cef849140e9fffdd9f028b9899ad852ee|static 原来在 Oracle ARM 机器上跑|          "runner": "ci-arm",
CLAIM|6|找不到|-|npm run check 里的 check:delivery-deploy 会真的运行只认 linux-x64 的上线脚本|-|
CLAIM|7|一致|scripts/delivery-mode/test_collect_dependencies.py:58|check:delivery-dependencies 会真的运行上线包脚本|        child = subprocess.run(['node', '--import', str(self.preload), str(self.collector), '--source-root', str(self.source), '--modules-root', str(self.source / 'node_modules'), '--output', str(output), '--npm-cli', str(self.npm)], capture_output=True, text=True)
CLAIM|8|一致|scripts/delivery-mode/packet-template/acceptance/helpers/collect-installer-dependencies.mjs:15|check:delivery-dependencies 运行的上线脚本只认 linux-x64，在 ARM 机器上以 P5_ENVIRONMENT_INVALID 失败|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|9|一致|scripts/ci/run-share.mjs:84|run-share.mjs 的摘要核对不变|  if ((await treeDigest(staging)) !== digest) {
CLAIM|10|一致|scripts/ci/run-share.mjs:108|取回后仍按作业输出里的摘要逐字节核对|  if (copied !== digest) {
CLAIM|11|一致|docs/adr/0174-no-github-cache-and-one-day-artifacts.md:12|ADR 0174 的说法是“不用 GitHub 缓存”|# ADR 0174：CI 不用 GitHub 缓存，artifact 只保存 1 天
CLAIM|12|一致|ci/policy.json:47@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 ci-vps|          "runner": "ci-vps",
CLAIM|13|一致|ci/policy.json:13@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 ci-arm|          "runner": "ci-arm",
CLAIM|14|一致|ci/policy.json:173@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 ci-vps-gate|          "runner": "ci-vps-gate",
CLAIM|15|一致|scripts/ci/build.mjs:137|构建不可复现（归档名带运行号）|      `${platform}-abi${process.versions.modules}-${context.testedSha}-${context.runId}-${context.attempt}.tar.gz`,
CLAIM|16|一致|.github/workflows/ci.yml:251|消费者用的就是 build 作业那份归档|        run: .ci-output/tools/bin/node scripts/ci/run-share.mjs get --name build-linux-x64 --digest "$CI_BUILD_DIGEST" --to .ci-output/input
CLAIM|17|一致|.github/workflows/ci.yml:21|ci.yml 规定所有作业只读|  contents: read
CLAIM|18|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:59|ADR 0241 里有“结束时删除共享目录”的说法|6. `scripts/ci/check-policy.mjs` 把第 1 到 3 条写成硬规则：6 个检查作业必须正好带草稿条件；汇总作业的第一步必须正好是那段入口检查；上传汇总结论和删除共享目录只能在入口检查通过后运行；事件类型和并发组必须正好是上面的写法。`test/tooling/policy.test.mjs` 有对应的反向用例，`test/tooling/ci-optimization.test.mjs` 实际执行入口检查那段 bash。
CLAIM|19|一致|docs/adr/0243-ci-uses-no-github-artifacts.md:41|ADR 0243 里有“完整报告在 CI 服务器的共享目录里”的说法|5. [ADR 0238](0238-ci-job-files-stay-on-the-ci-vps.md) 已经把作业之间的报告和构建放在 CI 服务器的共享目录 `/srv/gh-runner-share`，汇总作业结束时整目录删除，每小时的清理删掉 6 小时前的残留；所以共享目录不适合放要在合并后才读的东西。
CLAIM|20|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c2430041266de223e41c4163c45d1a02369|自托管时代的 ADR 里提到的 CI VPS 运行手册已删除，最后一版在提交 88e17c24|# CI VPS 上的自托管 runner Runbook

未核实：仓库改为公开、OVH 退租、Oracle 改作生产、6 台 runner 注销、GitHub 计费与 macOS 规格、Andy 的预算与 PR 623 试跑记录等外部或运行态事实。方案中纯属计划的部分（决定里的机器标签、缓存传递、删除脚本、prepare-hosted、策略升级等）未作为现状核对。
