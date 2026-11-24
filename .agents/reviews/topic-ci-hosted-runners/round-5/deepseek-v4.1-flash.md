CLAIM|1|一致|ci/policy.json:47@c912aa8cef849140e9fffdd9f028b9899ad852ee|CI 原先跑在自托管 runner 上|          "runner": "ci-vps",
CLAIM|2|一致|docs/adr/0176-ci-on-ovh-vps.md:32|OVH 的 CI VPS|Andy 租了一台 OVH（法国的云服务商）的 VPS（按月租用的云服务器）。2026-11-06 核对到的情况：
CLAIM|3|一致|docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:31|Oracle 东京的 ARM 机器|CI（每次推送后 GitHub Actions 自动跑的检查）的检查作业原来全部排在 CI 服务器的几个 runner（装在自己机器上、替 GitHub 执行作业的程序）上，开发线程一多就排长队。Andy 租的 Oracle 东京 ARM 机器（4 核、24 GB）上已经装好 `ci-arm-1`、`ci-arm-2` 两个 runner。这份 ADR 决定把三项检查正式放到它上面，并修订 [ADR 0253](0253-support-linux-arm64-for-test-and-qualification.md) 里“ARM 不进必过检查”的那一条。
CLAIM|4|一致|scripts/ci/run-share.mjs:27|`shareRoot` 要求 `HIMAWARI_CI_SHARE` 指向本机一个已有目录|  const root = env.HIMAWARI_CI_SHARE;
CLAIM|5|一致|scripts/ci/run-share.mjs:28|没设或不是绝对路径以 `CI_SHARE_ROOT_REQUIRED` 失败|  if (!root || !path.isAbsolute(root)) fail("ROOT_REQUIRED");
CLAIM|6|一致|scripts/ci/run-share.mjs:30|目录不存在以 `CI_SHARE_ROOT_INVALID` 失败|  if (!info?.isDirectory() || info.isSymbolicLink()) fail("ROOT_INVALID");
CLAIM|7|一致|.github/workflows/ci.yml:33|`policy` 跑在 `ubuntu-24.04-arm`|    runs-on: ubuntu-24.04-arm
CLAIM|8|一致|.github/workflows/ci.yml:372|`tooling` 跑在 `ubuntu-24.04-arm`|    runs-on: ubuntu-24.04-arm
CLAIM|9|一致|.github/workflows/ci.yml:425|`security` 跑在 `ubuntu-24.04-arm`|    runs-on: ubuntu-24.04-arm
CLAIM|10|一致|.github/workflows/ci.yml:80|`static` 跑在 `ubuntu-24.04`|    runs-on: ubuntu-24.04
CLAIM|11|一致|.github/workflows/ci.yml:142|`build` 跑在 `ubuntu-24.04`|            runner: ubuntu-24.04
CLAIM|12|一致|.github/workflows/ci.yml:204|`browser` 跑在 `ubuntu-24.04`|            runner: ubuntu-24.04
CLAIM|13|一致|.github/workflows/ci.yml:292|`tests` 跑在 `ubuntu-24.04`|            runner: ubuntu-24.04
CLAIM|14|一致|.github/workflows/ci.yml:476|`ci/required` 跑在 `ubuntu-24.04`|    runs-on: ubuntu-24.04
CLAIM|15|一致|.github/workflows/main.yml:52|main 确认跑在 `ubuntu-24.04`|    runs-on: ubuntu-24.04
CLAIM|16|一致|.github/workflows/merge-queue.yml:24|合并队列跑在 `ubuntu-24.04`|    runs-on: ubuntu-24.04
CLAIM|17|一致|.github/workflows/pr-closed.yml:14|“关闭 PR 时取消 CI”跑在 `ubuntu-24.04`|    runs-on: ubuntu-24.04
CLAIM|18|一致|.github/workflows/apple.yml:24|Apple 工作流跑在 `macos-26`|    runs-on: macos-26
CLAIM|19|一致|.github/workflows/apple.yml:34|Apple 工作流跑 `HimawariCore` 单元测试|        run: swift test
CLAIM|20|一致|.github/workflows/apple.yml:42|Apple 工作流不签名编译 iPhone App|          CODE_SIGNING_ALLOWED=NO
CLAIM|21|一致|.github/workflows/ci.yml:72@c912aa8cef849140e9fffdd9f028b9899ad852ee|`static` 原来在 Oracle ARM 机器上跑|    runs-on: ci-arm
CLAIM|22|一致|package.json:27|`npm run check` 里的 `check:delivery-dependencies`|    "check:steps": "npm run format:check && npm run lint && npm run typecheck && npm run check:boundaries && npm run check:security-invariants && npm run check:secrets && npm run check:gitleaks && npm run check:ci-policy && npm run check:release-walkthrough && npm run check:answer-weight && npm run check:layer0-hooks && npm run check:incident-gates && npm run check:conflict-markers && npm run check:glossary && npm run check:meaning-word-lists && npm run check:apple-design && npm run check:agent-rulebook-inventory && npm run check:operations && npm run check:markdown-tables && npm run check:adr-numbers && npm run check:instruction-links && npm run check:docs-links && npm run check:phone-layout && npm run check:layout && npm run check:brand && npm run check:locale && npm run check:expensive-models && npm run check:platform-assumptions && npm run check:egress-redaction && npm run check:prompt-prefix && npm run check:prompt-catalog && npm run check:rule-registry && npm run check:model-ref-contract && npm run check:product-path-configuration && npm run check:mcp-sync && npm run check:memory-relevance && npm run check:memory-capture-retry && npm run check:data-export && npm run check:chat-export && npm run check:real-admission && npm run check:audit-schema-range && npm run check:migration-conflicts && npm run check:proactive-sources && npm run check:srt-version && npm run check:probe-sources && npm run check:settings-scope && npm run check:source-mode-imports && npm run check:admin-schema-range && npm run check:delivery-packet && npm run check:delivery-deploy && npm run check:heartbeat && npm run check:delivery-rollback && npm run check:delivery-cleanup && npm run check:delivery-dependencies && npm run check:untested-claims && npm run check:security-review && npm run check:check-runner && npm run check:client-parity && npm run check:repo-hygiene && npm run check:disk-hygiene",
CLAIM|23|一致|scripts/delivery-mode/test_collect_dependencies.py:58|`check:delivery-dependencies` 会真的运行依赖收集脚本|        child = subprocess.run(['node', '--import', str(self.preload), str(self.collector), '--source-root', str(self.source), '--modules-root', str(self.source / 'node_modules'), '--output', str(output), '--npm-cli', str(self.npm)], capture_output=True, text=True)
CLAIM|24|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15|依赖收集脚本只认 linux-x64|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|25|一致|scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15|在 ARM 机器上以 `P5_ENVIRONMENT_INVALID` 失败|fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
CLAIM|26|一致|scripts/ci/check-policy.mjs:1711|`npm run check:ci-policy` 读 `.github/workflows/` 下全部工作流|        .filter((name) => /\.ya?ml$/u.test(name))
CLAIM|27|一致|scripts/ci/check-policy.mjs:911|`runs-on` 不是这三种之一就以 `HOSTED_RUNNER_REQUIRED` 失败|        `HOSTED_RUNNER_REQUIRED ${file}/${id}: only ${hostedRunnerLabels.join(", ")} are free on this public repository`,
CLAIM|28|一致|scripts/ci/run-share.mjs:108|`run-share.mjs` 的摘要核对不变|  if (copied !== digest) {
CLAIM|29|一致|.github/workflows/ci.yml:51|共享目录改成每台机器自己的 `$RUNNER_TEMP/ci-share`|        run: mkdir -p "$RUNNER_TEMP/ci-share" && echo "HIMAWARI_CI_SHARE=$RUNNER_TEMP/ci-share" >> "$GITHUB_ENV"
CLAIM|30|一致|scripts/ci/check-policy.mjs:832|每个检查作业把自己那份报告用 `actions/cache/save` 存进本次运行的缓存|        `Job must save its shared reports to this run's cache exactly once: ${check.id}`,
CLAIM|31|一致|.github/workflows/ci.yml:73|缓存键带 `run_id` 和 `run_attempt`|          key: ci-share-${{ github.run_id }}-${{ github.run_attempt }}-policy-${{ env.CI_MATRIX }}
CLAIM|32|一致|.github/workflows/ci.yml:246|`browser`、`tests` 取回本次的 Linux 构建|          key: ci-share-${{ github.run_id }}-${{ github.run_attempt }}-build-linux-x64
CLAIM|33|一致|.github/workflows/ci.yml:247|`browser`、`tests` 取不到缓存就失败|          fail-on-cache-miss: true
CLAIM|34|一致|scripts/ci/check-policy.mjs:798|汇总作业在收齐前逐个取回各成员的报告|          `Required must restore every member's reports from the run cache before collecting: ${name}`,
CLAIM|35|一致|.github/workflows/ci.yml:251|取回后按作业输出里的摘要核对|        run: .ci-output/tools/bin/node scripts/ci/run-share.mjs get --name build-linux-x64 --digest "$CI_BUILD_DIGEST" --to .ci-output/input
CLAIM|36|一致|docs/adr/0174-no-github-cache-and-one-day-artifacts.md:64|ADR 0174 规定三个工作流都不用 `actions/cache`|1. 三个工作流（`ci.yml`、`main.yml`、`quality.yml`）都不用 `actions/cache`。
CLAIM|37|一致|.github/workflows/ci.yml:55|依赖和工具仍不缓存|        run: node scripts/ci/install-dependencies.mjs --tools .ci-output/tools --evidence .ci-output/installation --cache runner
CLAIM|38|一致|scripts/ci/remote-share.mjs:50@c912aa8cef849140e9fffdd9f028b9899ad852ee|ssh 拉报告的 `scripts/ci/remote-share.mjs`|export function sshArguments(config, request, limits = REMOTE_LIMITS) {
CLAIM|39|一致|scripts/operations/ci-runner/install-runner.sh:1@c912aa8cef849140e9fffdd9f028b9899ad852ee|自托管 runner 的安装脚本|#!/bin/bash
CLAIM|40|一致|docs/runbooks/ci-vps-runner-runbook.md:11@88e17c2430041266de223e41c4163c45d1a02369|CI VPS 的运行手册已删除，最后一版在提交 `88e17c2430041266de223e41c4163c45d1a02369`|# CI VPS 上的自托管 runner Runbook
CLAIM|41|一致|scripts/ci/prepare-hosted.sh:11|`scripts/ci/prepare-hosted.sh` 装 bubblewrap、socat、ripgrep 和 AppArmor 放宽|apt-get install -y -q --no-install-recommends bubblewrap socat ripgrep apparmor-utils
CLAIM|42|一致|test/tooling/hosted-ci-setup.test.mjs:24|`prepare-hosted.sh` 在需要沙箱或浏览器的作业开头运行|    ["ci.yml", ["static", "browser", "tests", "tooling"]],
CLAIM|43|一致|ci/policy.json:47@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-vps`|          "runner": "ci-vps",
CLAIM|44|一致|ci/policy.json:13@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-arm`|          "runner": "ci-arm",
CLAIM|45|一致|ci/policy.json:173@c912aa8cef849140e9fffdd9f028b9899ad852ee|main 上已接受的策略文件仍写着 `ci-vps-gate`|          "runner": "ci-vps-gate",
CLAIM|46|一致|scripts/ci/check-policy.mjs:389|`resolvePolicySource` 在基准上把旧标签整体换成对应的托管标签|      member.runner = hosted[member.runner];
CLAIM|47|一致|scripts/ci/check-policy.mjs:1554|摘要仍按原始字节算|    policySha256: sha256(bytes),
CLAIM|48|一致|.github/workflows/ci.yml:21|`ci.yml` 规定所有作业只读|  contents: read
CLAIM|49|一致|.github/workflows/ci.yml:443@c912aa8cef849140e9fffdd9f028b9899ad852ee|汇总作业不再在结束时删共享目录|      - name: 删除 CI 服务器上本次运行的目录
CLAIM|50|一致|docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md:55|ADR 0241 里“结束时删除共享目录”的说法|现在是入口检查通过后不论成败都删
CLAIM|51|一致|docs/adr/0243-ci-uses-no-github-artifacts.md:59|ADR 0243 里“完整报告在 CI 服务器的共享目录里”的说法|`ci.yml` 的完整报告仍在 CI 服务器的共享目录里，汇总作业结束时删除
CLAIM|52|一致|scripts/ci/check-policy.mjs:724|ADR 0243 的 artifact 禁令保留|        `GitHub artifacts are not used; reports stay on the runner share and diagnostics go to the job summary: ${check.id}`,
CLAIM|53|一致|scripts/ci/build.mjs:137|构建不可复现（归档名带运行号）|      `${platform}-abi${process.versions.modules}-${context.testedSha}-${context.runId}-${context.attempt}.tar.gz`,

未核实部分：GitHub 官方计费与缓存文档的原文、larger runner 是否按分钟收费、缓存 10 GB/7 天淘汰规则、macOS 机器规格、Andy 账号的预算与超额拦截，以及 6 台 runner 已注销、OVH 退租、Oracle 改作生产等仓库外运行状态；这些都没有用仓库文件判定。
