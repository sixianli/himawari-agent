CLAIM|1|一致|scripts/ci/run-share.mjs:28@c912aa8cef849140e9fffdd9f028b9899ad852ee|原先 `scripts/ci/run-share.mjs` 的 `shareRoot` 要求 `HIMAWARI_CI_SHARE`|  const root = env.HIMAWARI_CI_SHARE;
CLAIM|2|一致|scripts/ci/run-share.mjs:31@c912aa8cef849140e9fffdd9f028b9899ad852ee|指向本机一个已有目录|  if (!info?.isDirectory() || info.isSymbolicLink()) fail("ROOT_INVALID");
CLAIM|3|一致|scripts/ci/run-share.mjs:29@c912aa8cef849140e9fffdd9f028b9899ad852ee|没设或不是绝对路径以 `CI_SHARE_ROOT_REQUIRED` 失败|  if (!root || !path.isAbsolute(root)) fail("ROOT_REQUIRED");
CLAIM|4|一致|scripts/ci/run-share.mjs:31@c912aa8cef849140e9fffdd9f028b9899ad852ee|目录不存在以 `CI_SHARE_ROOT_INVALID` 失败|  if (!info?.isDirectory() || info.isSymbolicLink()) fail("ROOT_INVALID");
CLAIM|5|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c2430041266de223e41c4163c45d1a02369|原先跑在自托管 runner（自己租的服务器上装的 GitHub 执行程序）上|# CI VPS 上的自托管 runner Runbook
CLAIM|6|一致|docs/adr/0176-ci-on-ovh-vps.md:12|OVH 的 CI VPS|# ADR 0176：CI 全部搬到 OVH 的 VPS 上，注销 Hermes 上的 runner
CLAIM|7|一致|docs/runbooks/ci-vps-runner-runbook.md:180@88e17c2430041266de223e41c4163c45d1a02369|Oracle 东京的 ARM 机器|第二处 runner 装在 Andy 的 Oracle 东京 ARM 机器上
CLAIM|8|一致|docs/runbooks/ci-vps-runner-runbook.md:180@88e17c2430041266de223e41c4163c45d1a02369|`static` 原来在 Oracle ARM 机器上跑|必过的 `ci.yml` 里 policy、static、tooling、security 四项检查写 `runs-on: ci-arm`，由这两个 runner 接
CLAIM|9|一致|package.json:27|`npm run check` 里的 `check:delivery-dependencies`|npm run check:delivery-dependencies
CLAIM|10|一致|scripts/delivery-mode/test_collect_dependencies.py:58|`check:delivery-dependencies` 会真的运行只认 linux-x64 的依赖收集脚本（`scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs`）|        child = subprocess.run(['node', '--import', str(self.preload), str(self.collector), '--source-root', str(self.source), '--modules-root', str(self.source / 'node_modules'), '--output', str(output), '--npm-cli', str(self.npm)], capture_output=True, text=True)
CLAIM|11|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15|只认 linux-x64 的依赖收集脚本|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|12|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15|在 ARM 机器上以 `P5_ENVIRONMENT_INVALID` 失败|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|13|找不到|-|`check:delivery-deploy` 也在同一次 ARM 试跑里失败|-
CLAIM|14|找不到|-|同一组测试在 x64 上通过|-
CLAIM|15|一致|docs/adr/0174-no-github-cache-and-one-day-artifacts.md:64|对 [ADR 0174](0174-no-github-cache-and-one-day-artifacts.md)“不用 GitHub 缓存”的修订|三个工作流（`ci.yml`、`main.yml`、`quality.yml`）都不用 `actions/cache`
CLAIM|16|一致|docs/adr/0243-ci-uses-no-github-artifacts.md:62|[ADR 0243](0243-ci-uses-no-github-artifacts.md) 的禁令保留|`scripts/ci/check-policy.mjs` 拒绝 `ci.yml` 任何作业用 `actions/upload-artifact` 或 `actions/download-artifact`
CLAIM|17|一致|ci/policy.json:30@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-arm`|          "runner": "ci-arm",
CLAIM|18|一致|ci/policy.json:104@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-vps`|          "runner": "ci-vps",
CLAIM|19|一致|ci/policy.json:173@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-vps-gate`|          "runner": "ci-vps-gate",
CLAIM|20|一致|scripts/ci/check-policy.mjs:1554|摘要仍按原始字节算|    policySha256: sha256(bytes),
CLAIM|21|一致|scripts/ci/run-share.mjs:108|`run-share.mjs` 的摘要核对不变|  if (copied !== digest) {
CLAIM|22|一致|scripts/ci/remote-share.mjs:158@c912aa8cef849140e9fffdd9f028b9899ad852ee|ssh 拉报告的 `scripts/ci/remote-share.mjs`|export async function pullRemoteReport({ config, root, run, name, limits, command, spawnProcess }) {
CLAIM|23|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55|“结束时删除共享目录”|上传汇总结论和删除共享目录的步骤也不运行
CLAIM|24|一致|docs/adr/0243-ci-uses-no-github-artifacts.md:59|“完整报告在 CI 服务器的共享目录里”|`ci.yml` 的完整报告仍在 CI 服务器的共享目录里
CLAIM|25|一致|.github/workflows/ci.yml:21|`ci.yml` 规定所有作业只读|  contents: read
CLAIM|26|一致|scripts/ci/build.mjs:137|构建不可复现（归档名带运行号）|      `${platform}-abi${process.versions.modules}-${context.testedSha}-${context.runId}-${context.attempt}.tar.gz`,
CLAIM|27|一致|.github/workflows/ci.yml:251|消费者用的就是 build 作业那份归档|        run: .ci-output/tools/bin/node scripts/ci/run-share.mjs get --name build-linux-x64 --digest "$CI_BUILD_DIGEST" --to .ci-output/input
CLAIM|28|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c2430041266de223e41c4163c45d1a02369|里提到的 CI VPS 运行手册已删除|# CI VPS 上的自托管 runner Runbook
CLAIM|29|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c2430041266de223e41c4163c45d1a02369|最后一版在提交 `88e17c24`|# CI VPS 上的自托管 runner Runbook

未核实：GitHub 上的 runner 注销状态、OVH/Oracle 机器的去向、macOS 机型规格与账号预算拦截、PR 623 的 ARM 试跑及 x64 通过记录，以及外部 GitHub 文档原话，仓库内没有可读证据；`.agents/reviews` 下的评审记录也无法读取。
