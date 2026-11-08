---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0176-ci-on-ovh-vps.md"
date: "2026-11-08"
---

# ADR 0181：runner 上保留已校验的下载缓存，下载失败时多等一会儿再重试

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

CI（持续集成，每次推送后自动跑的检查）的每个任务都从 github.com 重新下载固定版本的工具（CPython、actionlint、gitleaks），测试 `test/tooling/review-gateway.test.mjs` 还会下载真的 Magpie 程序（一个本机模型网关）。下载物放在任务的工作区里，任务结束整个工作区被删（`scripts/operations/ci-runner/job-completed.sh`）。下载只重试 3 次、间隔十几秒，Magpie 只等约 3 秒。

2026-11-08 约 18:00 到 19:15（JST，日本标准时间），github.com 的发布文件地址返回 HTTP 504（网关超时）持续几十分钟，PR 296、291、290 的任务都因此失败，`ci/required` 变红，合并被卡住，重跑时 504 仍在。失败与代码无关。事故记为 [I-89](../incidents-and-gates.md#incidents)。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-08 对方案的逐项回复：

> 1. 同意
> 2. 按照你的推荐来
> 3. 按照你的推荐来
> 4. 按照你的推荐来

这里的 2、3、4 分别是：缓存没命中时重试预算约 15 分钟；缓存保留 30 天、每个 runner 约 1 GB 以内；先不做预热脚本。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **缓存目录**：环境变量 `HIMAWARI_CI_CACHE_DIR`（必须是绝对路径）明确指定时用它；否则 `scripts/ci/install-tools.mjs` 的命令行入口在 `GITHUB_ACTIONS=true` 且 `HOME` 是绝对路径时用 `$HOME/.cache/himawari-ci/downloads`。runner 服务的 `HOME` 是各自的 `/srv/gh-runner*/home`，在服务的可写路径内，也不被每日清理。库函数默认只认明确指定的环境变量，不自动启用。`run.mjs` 会把它传给检查子进程，所以 CI 里 tooling 测试里没显式传 `cacheDirectory: null` 的下载（例如 gitleaks-config 测试）也会读写真实缓存：这是有意的，使用前照样复验摘要；断言网络行为的测试都显式传 `cacheDirectory: null`。
2. **`scripts/ci/run.mjs` 在父进程里算出缓存目录，作为 `HIMAWARI_CI_CACHE_DIR` 传给检查子进程。** 子进程的 `HOME` 在工作区内，不传的话测试里的 Magpie 下载还是每个任务丢一次。
3. **内容寻址，每次使用前重新校验**：缓存文件的名字就是它的 SHA-256；命中时重新算摘要，对得上才复制到工作区，对不上就删掉当作没命中；符号链接和名字不是 64 位十六进制的文件不读取。只缓存下载回来的压缩包、wheel 和 Magpie 程序，不缓存解压后的目录，所以现有的“可执行文件字节与压缩包一致”检查照旧。复制而不是硬链接，免得某个任务改了缓存里的同一份文件。
4. **缓存文件超过 512 MB 一律不读并删除**（防止被塞进巨大文件拖垮任务）。**写入原子**：先写同目录的 `.tmp-*`，校验摘要，再改名；摘要不符或写入失败不留下 64 位十六进制名字的文件。缓存写失败只打印一行，不让 CI 额外失败。
5. **重试**：只有缓存没命中才联网。408、429、5xx 和网络错误重试，404、403 和摘要不符不重试。等待从 10 秒起每次翻倍，封顶 5 分钟，乘 0.5 到 1.5 的随机数；服务器给了 `Retry-After` 就按它等（最少 1 秒，封顶 5 分钟）；累计等待超过 15 分钟就失败。`install-tools.mjs` 和 `gateway.mjs` 共用 `scripts/ci/verified-download.mjs` 里同一组函数。这是下载等待，不是测试超时，任务整体时限不变。
6. **清理**：每次 `install-tools.mjs` 命令行成功后，进程内删除超过 1 天的 `.tmp-*`、超过 30 天没用过的条目；清理只删 64 位摘要名的文件和 `.tmp-*` 文件，不删别的名字、不删目录；总量超过 1 GB 时从最久没用的删起。命中时更新文件时间，所以“最近使用”是真的。锁文件换版本后，旧摘要没人再用，30 天后被清掉，不需要手动失效。不改 `clean-old.sh`，不需要在 VPS 上重装任何东西。
7. **Magpie 的 curl 重试**改成 Node 里的循环（每次一个 curl 进程，读 HTTP 状态码和 `Retry-After`），不再用 `--retry 2`；有 4xx 状态码按状态码判断，没有状态码时只有 curl 退出码属于网络问题（5、6、7、18、28、35、52、55、56）才重试，curl 不存在立刻失败。重试预算整个进程共用一份，不是每个文件各 15 分钟。插件包来自 npm（registry.npmjs.org），不受 github.com 故障影响，不缓存。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **只加重试**：504 持续几十分钟时仍然失败，还会拖长每个任务；也没解决“每个任务都重新下载”。
- **`actions/cache`**：[ADR 0174](0174-no-github-cache-and-one-day-artifacts.md) 为省钱已经去掉。
- **测试里换成假的 Magpie**：6 处用例要启动真的网关，换假的等于不测。
- **预热脚本或定时器**（两个独立出方案的模型之一提出）：Andy 选择先不做；缓存没命中时靠 15 分钟的重试兜底。
- **只读种子目录或镜像**（另一个模型提出）：要人工维护或多一个服务，等重试和缓存跑一阵再看。
- **缓存放进 `RUNNER_TOOL_CACHE`（`runner/_work/_tool`）**：它的默认值和是否被设置没有一手来源核实，而且每日清理会误删；放在 runner 的 home 里不用改任何东西。
- **runner 之间共享缓存**：两个 runner 互相看不到对方的目录，共享要放宽隔离。每个 runner 一份，锁文件换版本后各下载一次。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 缓存命中时 504 不再影响任务；缓存没命中又碰上故障时，任务最多多等约 15 分钟再失败。锁文件换版本后，两个 runner 各要成功下载一次。
- 磁盘：每个 runner 上限 1 GB，两个合计约 2 GB，占 200 GB 的 1%。实际大小没有实测（github.com 正在 504，只量到了 nodejs.org 的两个版本约 130 MB）。
- 缓存放在 runner 账号可写的目录里，一个任务可以往里写东西；每次使用前重新校验摘要，被改过的文件会被拒绝并删除，不降低“摘要不符就不使用”的保证。
- `actions/checkout`、`actions/upload-artifact` 以及 runner 取 Action 本体仍要连 GitHub，本决定不覆盖。
- 本次没有改动任何发给模型的内容。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0176：CI 全部搬到 OVH 的 VPS 上](0176-ci-on-ovh-vps.md)
- [ADR 0174：CI 不用 GitHub 缓存，artifact 只保存 1 天](0174-no-github-cache-and-one-day-artifacts.md)
- [事故与门槛清单](../incidents-and-gates.md)
- curl 官方文档 [`--retry`](https://curl.se/docs/manpage.html#--retry)
- GitHub 官方文档 [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)（自托管 runner 可能被工作流里不可信的代码持久弄坏，所以缓存内容每次使用前重新校验）

[↑ 返回阅读导航](#contents)
