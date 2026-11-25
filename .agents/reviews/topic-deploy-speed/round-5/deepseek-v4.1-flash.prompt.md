你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 55336734cb7aaf4362f9b8f0796a09dd9e0afac5。
本 PR 的基线提交是 5834935d102709955c38e76220c6ed8a6df5cc51（main 与 55336734cb7aaf4362f9b8f0796a09dd9e0afac5 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0281-deploy-clears-its-own-leftovers-and-reuses-unchanged-materials.md（在提交 55336734cb7aaf4362f9b8f0796a09dd9e0afac5 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-15"
---

# ADR 0281：上线自己清掉上次失败的残留，没变的大材料不再上传

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

2026-11-15 第二十九版上线尝试了 4 次，前 3 次失败后，第 4 次停在上线前检查（预检，`deploy-preflight.py`），原因是上一次失败留下的资格目录还在。每次重试都要人去生产机手动移走目录。另外每次上线都要从 Mac 往生产机传约 413 MB 的上线包，耗时 272–365 秒，其中依赖包 `node-modules.tar.gz` 约 282 MB、python 约 34 MB，而它们 17 天里只因锁文件（`package-lock.json`，锁定依赖版本的文件）变化而真正变过 1 次。完整测量见 `/mnt/project-files/deploy-speed/analysis-2026-11-15.md`，方案和两轮模型审核记录见 `.agents/plans/deploy-speed.md` 与 `.agents/reviews/topic-deploy-speed/`。Andy 2026-11-15 同意了方案的三项决定（线程 cmsg_01EE1hey9cboYNfwFnBv5dgrLk6irbA4zCp1S1kodtooxW，原话：“上面三条都按照你的建议,合并前我也愿意说合并”）。

<a id="premises"></a>

## 前提

1. 预检要求一组目标路径都不存在，清单现在由预检和清理共用：`scripts/delivery-mode/deploy-target-paths.py` 第 4 行 `def target_paths(binding):`。
2. 改动前，清理遇到有内容的资格目录只保留，所以同名路径下次必然过不了预检：改动前的 `release-cleanup-remote.py` 原文是 `keep(target, 'qualification-not-empty')`（I-56，`docs/incidents-and-gates.md`）。
3. 项目规则不许只给失败产物改名了事：`.agents/instructions/disk-space-hygiene.md` 第 8 行原文“也绝不能只是给它们改名了事”。
4. 上线包里的文件不许是硬链接：`scripts/delivery-mode/packet-template/steps/packet-common.py` 第 42 行要求 `before.st_nlink == 1`。所以缓存复用只能核对后复制。
5. 依赖包每次出包字节都不同：11-15 四个包的 `NODE_MODULES_TAR_SHA256` 各不相同而锁文件没变；第 3、4 个包的 `node-modules.json` 37,581 个文件只差 `node_modules/.vite/vitest/…/results.json`，是 vitest（测试运行器）写进 node_modules 的测试结果缓存。这一条来自 Mac 上的包文件比对，仓库里没有原件。
6. Mac 上传到生产机只有 1.1–1.5 MB/s，生产机外网下载 13.8 MB/s（11-15 各测一次，见分析文档第 7 节）。

<a id="decision"></a>

## 决定

1. **残留由清理自己处理。** `release-cleanup-remote.py` 的 `clear_target_paths` 在其他清理之后，逐个看预检要求不存在的路径：属于正在服务的版本（含它的资格目录）、回滚目标、被进程或数据库引用、或者是符号链接的，保留并报 `CLEANUP_TARGET_PATH_LEFT`；其余先把报告和日志等小文件复制到 `release-cleanup/failed-attempts/<时间>/<原绝对路径>/`，再删除。越出允许父目录的路径以 `CLEANUP_TARGET_PATH_INVALID` 拒绝。失败现场保留最近 2 份，总量超过 200 MB 时只留最新一份（`release-cleanup.py` 的 `KEEP_FAILED_ATTEMPTS`、`FAILED_ATTEMPT_BYTES`）。部署前那次清理后仍有路径被占用时，`deploy.sh` 在预检前以 `target-paths-left` 停下。这改掉了 I-56 当时“有内容就保留、等人处理”的做法，Andy 同意作为长期规则，以后不再逐次授权。
2. **依赖包可复现。** 依赖收集脚本（`acceptance/helpers/collect-installer-dependencies.mjs`，`install/` 下是同一份）在每个依赖根下只收锁文件列出的包、`.bin` 和 `.package-lock.json`；`.vite`、`.vite-temp`、`.cache` 这几个工具缓存跳过；其他不认识的条目以 `P5_MODULE_UNEXPECTED_ENTRY` 报错，让新冒出来的缓存目录被人看见，而不是悄悄进包。
3. **没变的大材料不再上传。** 实例文件的 `materialCache`（`minBytes` 16 MiB、`maxBytes` 1 GiB，可改）冻结进包参数 `MATERIAL_CACHE_JSON`。传输前 Mac 经 SSH 只读查生产机 `/opt/himawari/material-cache/sha256/<SHA>` 里有哪些大成员，tar 流里不放它们，并把名单交给接收端。接收端只允许名单里的成员缺席，从缓存核对大小和 SHA-256 后复制进上传目录，再照旧整体核对冻结清单；核对不符就删掉那条缓存并失败，下次自动整包传。传完把大成员存进缓存（root:0700 目录、0600 文件、先写临时文件再改名），超过上限先删本次没用到的最旧条目。缓存目录不安全或查询失败时，整包传输照常进行。

依据的原则：边界与可逆性（失败现场留报告和日志、删的只有能重新生成的内容）优先于主动性与效率（省下的上传时间）。

<a id="industry"></a>

## 业界怎么做

- OCI 镜像仓库推送前先问这一层在不在，在就不传：规范原文 “the registry indicates that its not necessary because the layer is already known”（https://github.com/opencontainers/distribution-spec/blob/main/spec.md）。
- Nix 的 `nix-copy-closure` 只发目标机缺的路径（https://nix.dev/manual/nix/2.26/command-ref/nix-copy-closure）。
- 两者都要求同样输入打出同样字节，即可复现构建（https://reproducible-builds.org/docs/definition/）。本决定的第 2 条就是为此。

<a id="options"></a>

## 放弃的做法

- **生产机自己去拉包**：缓存之后每次只剩约 97 MB；出包机 Hermes 也在家里宽带后面，从它拉同样受家里上行限制。要真正提速得把出包挪到机房的机器，改动大，最多再省约 1 分钟。
- **整条路径改名保留**：违反前提 3，失败版本整份留下会重演 I-33 的磁盘耗尽。
- **硬链接复用缓存**：违反前提 4。
- **按旧包对比来查可复现**：工具升级也会改字节，误报多；改为同一环境打两次比较（`scripts/delivery-mode/test_collect_dependencies.py`）。
- **从 node_modules 剔除生产上不加载的二进制**：只在锁文件变化的那次省上传，要改 `whole-locked-node-modules` 校验口径，另做。

<a id="consequences"></a>

## 后果

- 正面：失败重试不再要人手动移目录；锁文件不变时预计每次上传从 413 MB 降到约 97 MB，省 3.5–4.5 分钟（按 11-15 上传速度推算，尚未实测）。
- 负面：生产机多占最多 1 GiB 缓存；失败现场里除报告和日志外的内容会被删掉。
- 门槛：`scripts/delivery-mode/test_release_cleanup.py` 的 `TargetPathClearingTest`、`scripts/delivery-mode/test_deploy.py` 的清理流程测试、`scripts/delivery-mode/test_collect_dependencies.py`、`scripts/delivery-mode/packet-template/steps/verify-steps.py` 的缓存用例（出包时在 Hermes 上运行）。
- 后续：第一次带缓存的上线后，记下实测上传时间和 `cacheFilled`，回填分析文档。
