---
status: active
document_type: adr
decision_status: accepted
supersedes: "docs/adr/0201-delete-run-reports-after-gate-passes.md"
superseded_by: ""
amends: "docs/adr/0176-ci-on-ovh-vps.md"
date: "2026-11-11"
amended_by: "docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md, docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md, docs/adr/0287-ci-runs-on-github-hosted-runners.md"
---

# ADR 0238：CI 作业之间的文件放在 CI VPS 上，不再用 GitHub 产物存储

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（持续集成，每次推送后自动跑的检查）的七个作业之间要传文件：`build` 作业产出的 Linux 构建归档要交给 `browser`（三个浏览器引擎）和 `coverage`，每个作业的完整报告要交给汇总作业 `ci/required`。以前这些文件都通过 GitHub 的产物存储（artifact，GitHub 替工作流保管的文件）上传、下载。

2026-11-11，PR 392 的 `ci/required`（运行 42998308018）日志里出现 “Artifact storage quota has been hit”，上传全部失败，汇总收不到 8 份报告中的任何一份，`ci/required` 一直是红的。原因：

- 私有仓库的产物存储额度很小（GitHub Free 0.5 GB，Pro 1 GB），按“当前保留的产物总量”算，账户没有付款方式时，用完就拦下（[GitHub 文档](https://docs.github.com/en/billing/concepts/product-billing/github-actions)）。
- 一轮 CI 的报告约 300 MB：`build` 报告 55 MB，`coverage` 59 MB，三份 `browser` 各 53 MB，都是因为把同一份构建归档原样复制进了自己的报告。
- [ADR 0201](0201-delete-run-reports-after-gate-passes.md) 只在汇总通过后删除报告。草稿 PR 不跑 `browser`、`coverage`，汇总永远不通过，报告就一直留到 1 天过期；24 小时内有约 100 轮 CI，存量涨到约 5.6 GB。
- 即使用的是自托管 runner（装在 Andy 自己的 CI VPS 上、替 GitHub 执行任务的程序），产物和缓存仍然存在 GitHub 上、占 GitHub 的额度。

别的开发者为了不付 GitHub 的钱，通常这样做：

- 把作业之间的大文件放在 runner 所在机器或自己的存储上，GitHub 上只传很小的值。例如 [ci-storage](https://github.com/dimikot/ci-storage) 在自托管机器上按运行号建目录、用 rsync 存取，定时删旧目录。
- 作业之间的小值（几十字节的字符串）走作业输出（job outputs），它们不占产物存储（[GitHub 文档：在作业之间传递信息](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs)）。矩阵作业的各个成员可以各写一个不同名字的输出，GitHub 把它们合在一起；空值不会覆盖别的成员写的值（[GitHub 文档：workflow 语法，Using Job Outputs in a Matrix Job](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)，原话 “An output with an empty value is not set, so it does not override a value set by another matrix job.”）。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

- 2026-11-11，问：GitHub 的产物存储要花钱吗？“如果花钱的话，这是我不能接受的。就是可不可以用两个 Runner 所在的那台云服务器去存？”
- 2026-11-11，答复“可以用那台 CI 服务器存，我也建议这么做”之后：“那就这么做，就是我绝不在 GitHub 上花钱，懂我意思吧？”

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **作业之间的文件放在 CI VPS 的共享目录 `/srv/gh-runner-share`。**每轮运行一个子目录，名字是“运行号-尝试号”（例如 `43003101968-1`）；每个作业成员一个子目录，名字是“作业-成员”（例如 `build-linux-x64`、`browser-chromium`）。存取都用 `scripts/ci/run-share.mjs`：
   - `put`：先复制到同目录下的临时名字，核对内容摘要（SHA-256，按每个文件的路径、摘要、大小算出的一个总摘要）不变后再改名成正式名字；同名已存在就失败，不覆盖。
   - `get`：复制到本作业的工作目录后重算摘要，和上游作业交出的摘要不一致就删掉副本并失败。
   - `collect`：汇总作业按 `needs`（GitHub 给汇总作业的上游作业结果）里每个上游成员交出的摘要逐个 `get`，缺的逐个列出，不因为一个缺失就中断；缺失由 `required.mjs` 按原来的规则判为失败。
   - `remove`：汇总作业最后一步，`if: always()`，不论成败都删掉本次运行的目录。
2. **摘要走作业输出，不走 GitHub 产物。**每个作业成员把自己报告的摘要写进作业输出（键是成员名，例如 `linux-x64`、`chromium`、`default`）；`browser`、`coverage` 用 `needs.build.outputs.linux-x64` 取构建，汇总作业用整个 `needs` 收报告。摘要是 64 个十六进制字符，GitHub 只存这几十字节。
3. **GitHub 上只留很小的东西：**汇总结论 `gate-`（几 KB，`main.yml` 的 `main-evidence.mjs` 要读）和失败时的诊断 `diagnostic-`（几 MB，保存 1 天）。不用 `actions/cache`、不用付费 runner、不开 GitHub 付费存储或预算。
4. **任何作业都不再有写权限，`ci.yml` 的作业只往 GitHub 传诊断和汇总结论。**[ADR 0201](0201-delete-run-reports-after-gate-passes.md) 给汇总作业的 `actions: write` 收回；`scripts/ci/delete-run-reports.mjs`、`scripts/ci/artifact-output.mjs` 删除；`main.yml` 调用完整 CI 的 `full` 作业不再单独授予权限，沿用工作流级的只读权限。`scripts/ci/check-policy.mjs` 把这些写成只对 `ci.yml` 生效的硬规则（`main.yml`、`quality.yml` 另有 `validateMainWorkflow`、`validateQualityWorkflow` 的检查，不受这些规则约束）：`ci.yml` 的任何作业带写权限、用 `actions/download-artifact`、上传诊断目录（汇总作业是 `.ci-output/gate/`）以外的东西或保存超过 1 天、少了或多了存取步骤、作业输出和成员对不上，都失败；`scripts/ci/main-workflow.mjs` 拒绝 `full` 带权限。`main.yml` 仍用 `actions/download-artifact` 取 PR 的汇总结论 `gate-` 和合并证据（几 KB），这是本决定保留的例外；它的确认作业上传的 `main-confirmation-` 报告不带构建归档：`scripts/ci/main-confirm.mjs` 发布构建和安全检查时传 `--artifacts omit`，`scripts/ci/publish.mjs` 跳过归档，只留日志和 JSON，归档的摘要记在 `summary.json` 的 `artifactSha256` 里；发布出的 `result.json` 的 `artifacts` 仍列出构建时产生的归档，但文件不随报告上传。
5. **两个 runner 共用这个目录，用一个专门的组隔开其他账号。**这修改了 [ADR 0176](0176-ci-on-ovh-vps.md) 里“每个 runner 只能写自己的三个目录”的隔离：
   - 安装脚本建系统组 `gh-ci-share`，建目录 `/srv/gh-runner-share`（属主 root、组 `gh-ci-share`、权限 `2770`，即组内可读写、新建的子目录自动继承组）。
   - 两个 runner 的服务用 `SupplementaryGroups=gh-ci-share` 拿到这个组（账号本身仍然只属于自己的组，安装脚本对“账号有多余的组”的检查不变），`ReadWritePaths` 加上这个目录，`HIMAWARI_CI_SHARE` 环境变量告诉脚本目录在哪。
   - `run-share.mjs` 运行时把 umask（新建文件时默认去掉的权限）设成 `007`，新目录是 `2770`、新文件是 `660`，另一个 runner 能读能删。
6. **兜底清理每小时一次。**`clean-old.sh` 由 root 运行，删掉共享目录里超过 6 小时没变的运行目录（汇总作业被取消或 runner 崩溃时留下的）；清理定时器从每天改成每小时。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **继续用 GitHub 产物，只删旧的或缩短保存期**：放弃。保存期已经是最短的 1 天，额度仍然被撑爆；而且 Andy 要求绝不在 GitHub 上花钱，GitHub 额度一满就拦，这条路一直有风险。
- **只让消费者报告记构建摘要、不复制归档**：放弃作为主要做法。能把一轮从约 300 MB 降到约 70 MB，但仍然占 GitHub 额度，额度满了照样拦。文件放 VPS 后，归档拷贝只占 VPS 的磁盘，几小时内就删，不再需要这一步。
- **在 VPS 上起一个对象存储服务（例如 MinIO）或用 rsync 服务**：放弃。两个 runner 在同一台机器上，直接用一个目录最简单，不用多跑一个服务、多开一个端口。
- **付费存储或付费 runner**：放弃。Andy 明确不接受。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 一轮 CI 在 GitHub 上只占几 KB 的汇总结论，加上失败时几 MB 的诊断；GitHub 产物额度不再随 CI 轮数增长。
- CI VPS 磁盘每轮多占约 300 MB，汇总作业结束就删；最坏情况（汇总一直没跑完）每小时清理删掉 6 小时前的目录。任务开始前已有的 16 GiB 可用空间下限照样挡住磁盘不够的情况。
- 两个 runner 的任务都能读写整个共享目录，所以一个任务能读、改、删共享目录里任何一轮运行的文件，不只是本轮的。仓库私有、只有 Andy 和他的代理线程推送，这和 [ADR 0176](0176-ci-on-ovh-vps.md) 接受“同一个 runner 上的任务互相能改”是同一个理由；摘要核对能发现文件在存和取之间被改，但挡不住有意改摘要的任务。
- 只有 CI VPS 上的 runner 能跑这套 CI：作业要靠 `HIMAWARI_CI_SHARE` 和共享目录，换到 GitHub 托管的 runner 上会以 `CI_SHARE_ROOT_REQUIRED` 失败。这是有意的：Andy 不在 GitHub 上花钱。
- 重跑一律重跑整轮（GitHub 的 “Re-run all jobs”）。“只重跑失败的作业”会换新的尝试号，但已成功的上游作业不重跑，新尝试号的目录里没有它们的文件：取构建的作业以 `CI_SHARE_MISSING` 失败（GitHub 没把上一次尝试的构建摘要交给新尝试时，摘要是空的，报 `CI_SHARE_DIGEST_INVALID`，同样是重跑整轮），汇总作业收报告时列出缺失、由 `required.mjs` 判为失败；这和以前一样：汇总脚本 `scripts/ci/aggregate.mjs` 本来就要求每份报告的尝试号等于本次尝试号，不符时报 “rerun the complete workflow”。
- 合并后要在 CI VPS 上运行一次安装脚本，才会有组和目录（运维手册写了原样命令）；装好之前，CI 会在第一个存文件的步骤以 `CI_SHARE_ROOT_REQUIRED` 失败。
- `quality.yml` 仍然下载 `report-` 产物，但它按 [ADR 0176](0176-ci-on-ovh-vps.md) 停用；重新启用时要改成从共享目录取。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0174：CI 不用 GitHub 缓存，artifact 只保存 1 天](0174-no-github-cache-and-one-day-artifacts.md)
- [ADR 0176：CI 迁到 OVH VPS](0176-ci-on-ovh-vps.md)
- [ADR 0201：汇总通过后删除本次运行的报告产物](0201-delete-run-reports-after-gate-passes.md)（被本决定取代）
- CI VPS 上的自托管 runner Runbook（运行手册已随 [ADR 0287](0287-ci-runs-on-github-hosted-runners.md) 删除，最后一版在提交 `88e17c24`）

[↑ 返回阅读导航](#references)
