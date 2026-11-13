CLAIM|1|不一致|.github/workflows/quality.yml:23|CI（持续集成，每次推送后 GitHub Actions 自动跑的检查）现在全部在 Andy 租的一台 CI 服务器上跑。|    runs-on: ubuntu-24.04
CLAIM|2|一致|.github/workflows/ci.yml:327|汇总作业 `ci/required`（把各项检查的结果汇成一个结论的作业）有了专用的 runner（装在自己机器上、替 GitHub 执行 CI 作业的程序）|    runs-on: ci-vps-gate
CLAIM|3|一致|scripts/operations/ci-runner/runners.sh:40|不再和检查抢位置|    RUNNER_LABEL=$RUNNER_GATE_LABEL
CLAIM|4|一致|.agents/evidence/ci-queue-2026-11-12.md:13|检查作业本身仍然只有两个 runner 能接|- 2026-11-12 19:52 JST 再量一次：28 次排队里 20 次只剩 `ci/required` 在等；两个 runner 都在干活（作业记录里 `ci-vps-1`、`ci-vps-2` 各有一个 `in_progress` 的作业），一个作业约 13 分钟。
CLAIM|5|一致|ci/policy.json:129|一次完整运行有 6 种检查|      "needs": ["policy", "static", "build", "browser", "coverage", "security"],
CLAIM|6|一致|.agents/evidence/ci-queue-2026-11-12.md:14|同一时间只能跑 2 个作业|- 每个 runner 一次只跑一个作业：历次读到的作业记录里，同一个 runner 名下同一时刻最多一个 `in_progress` 的作业。
CLAIM|7|一致|.github/workflows/ci.yml:33|一次完整运行有 6 种检查作业，全部在 CI 服务器的两个检查 runner 上跑。|    runs-on: ci-vps
CLAIM|8|一致|.agents/evidence/ci-queue-2026-11-12.md:10|policy 和 static 各要 13 到 14 分钟|- 作业时长（作业记录里的开始和结束时间）：policy 13 到 14 分钟，static 13 到 14 分钟，build 约 6 分钟，security 约 6 分钟。
CLAIM|9|找不到|-|policy 和 static 是最长的两个作业|-
CLAIM|10|一致|ci/policy.json:13|每项检查跑在哪种 runner 上写在策略文件里|          "runner": "ci-vps",
CLAIM|11|一致|scripts/ci/check-policy.mjs:493|工作流必须和它一致|        !job.strategy && job["runs-on"] === check.members[0].runner,
CLAIM|12|一致|scripts/ci/check-policy.mjs:341|策略校验现在要求非 macOS 的成员只能是 x64|          member.arch === (mac ? "arm64" : "x64") &&
CLAIM|13|一致|ci/policy.schema.json:64|`ci/policy.schema.json` 第 64 行，原话 `"enum": ["ci-vps", "ci-vps-gate", "macos-15"]`|                  "enum": ["ci-vps", "ci-vps-gate", "macos-15"]
CLAIM|14|一致|scripts/ci/run-share.mjs:27|各作业的报告靠 CI 服务器本机的目录交接|  const root = env.HIMAWARI_CI_SHARE;
CLAIM|15|一致|.github/workflows/ci.yml:215|browser 和 coverage 要取 build 的 x64 产物|        run: .ci-output/tools/bin/node scripts/ci/run-share.mjs get --name build-linux-x64 --digest "$CI_BUILD_DIGEST" --to .ci-output/input
CLAIM|16|一致|scripts/ci/install-tools.mjs:25|固定工具现在不支持 linux-arm64|const platforms = ["darwin-arm64", "linux-x64"];
CLAIM|17|一致|scripts/ci/aggregate.mjs:289|汇总时拿工具链锁文件的摘要和每份报告里的摘要比对|  if (sha256(lockBytes) !== context.toolchainSha256)
CLAIM|18|一致|scripts/ci/context.mjs:143|所以只能有一份锁文件|    toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json")),
CLAIM|19|一致|scripts/ci/aggregate.mjs:100|汇总时报告里的架构必须等于策略里成员写的架构|      if (result.toolchain[field] !== member[field])
CLAIM|20|一致|scripts/ci/run.mjs:131|它上一行比较的是成员的系统、架构和本机的系统、架构|    if (hosted && (member.os !== process.platform || member.arch !== process.arch))
CLAIM|21|一致|scripts/ci/run.mjs:132|原话 `throw new Error("CI_RUNNER_PLATFORM_MISMATCH");`|      throw new Error("CI_RUNNER_PLATFORM_MISMATCH");
CLAIM|22|一致|scripts/ci/run.mjs:283|报告里的产物平台，非 macOS 一律写成 x64|        platform: process.platform === "darwin" ? "macos-arm64" : "linux-x64",
CLAIM|23|一致|scripts/ci/local.mjs:23|本机跑检查的入口不认 linux-arm64|      (process.platform === "linux" && process.arch === "x64")
CLAIM|24|一致|scripts/ci/local.mjs:26|原话 `throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");`|    throw new Error("CI_LOCAL_PLATFORM_UNSUPPORTED");
CLAIM|25|一致|docs/adr/0243-ci-uses-no-github-artifacts.md:61|不用 GitHub 产物传文件|6. **硬规则。**`scripts/ci/check-policy.mjs` 拒绝 `ci.yml` 任何作业用 `actions/upload-artifact` 或 `actions/download-artifact`
CLAIM|26|一致|docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:92|现有决定写明只有 CI 服务器上的 runner 能跑这套 CI|- 只有 CI VPS 上的 runner 能跑这套 CI：作业要靠 `HIMAWARI_CI_SHARE` 和共享目录，换到 GitHub 托管的 runner 上会以 `CI_SHARE_ROOT_REQUIRED` 失败。这是有意的：Andy 不在 GitHub 上花钱。
CLAIM|27|一致|scripts/operations/ci-runner/gh-runner-clean.timer:5|共享目录里的旧文件每小时扫一次|OnCalendar=hourly
CLAIM|28|一致|scripts/operations/ci-runner/clean-old.sh:25|删掉 6 小时以前的|  find "$RUNNER_SHARE_ROOT" -mindepth 1 -maxdepth 1 -mmin +"$RUNNER_SHARE_KEEP_MINUTES" -exec rm -rf -- {} + || STATUS=1
CLAIM|29|找不到|-|方案经过两轮模型讨论（独立方案一轮，审核一轮），记录在 `.agents/reviews/topic-ci-oracle/`。|-
CLAIM|30|一致|.github/workflows/ci.yml:327|汇总作业仍在 `ci-vps-gate` 上|    runs-on: ci-vps-gate
CLAIM|31|一致|docs/adr/0256-gate-job-gets-its-own-runner.md:86|这和 ADR 0256 给汇总 runner 准备的应急做法相同：要人跑一条命令，不自动回退。|- 新增一个应急脚本：3 号坏了时，在 Mac 上跑一条命令，把 `ci-vps-gate` 标签临时加到 1 号上，汇总作业就改由 1 号接，不用改代码、不用回滚 PR；3 号修好后再跑一次去掉。
CLAIM|32|找不到|-|生产是 x64|-
CLAIM|33|找不到|-|ARM 测试机线程原先打算让 ARM 用独立的锁文件、不进必过检查|-

未核对的部分：`.agents/reviews/topic-ci-oracle/` 在仓库里不存在，两轮讨论记录找不到；生产是否为 x64、ARM 测试机线程此前是否计划用独立锁文件，仓库里也没有可读材料。外部网站的三条说法（OpenSSH、GitHub 调度、自托管 runner 安全）以及方案自己标为未核实的两条未纳入核对。
