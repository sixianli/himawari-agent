---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-01"
covers: "scripts/ci/verify-artifact.mjs, scripts/delivery-mode/test_make_packet.py"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0151：上线包里的源码包改成增量包，生产机上留一个源码缓存

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

每次上线都要把约 400MB 的上线包从 Andy 的 MacBook 传到生产机，实测上传 204 到 741 秒（最近四次平均 447 秒），第二十三版第一次因为 SSH 保活超时在约 8 分钟时失败，完整上传实测 554 秒（日志：`.ci-output/production/*/run-logs/deploy-*.log`，阶段耗时拆解见项目文件 upload-slimming/timing-breakdown.md）。

其中源码包 `source-<提交>.bundle` 约 118MB，由 `make-packet.py` 用 `git bundle create … HEAD` 生成，带全部历史。实测历史只占约 4MB，真正占地方的是 `test/qualification/evidence/` 下的 106MB 测试证据，整条部署链没有任何一步读它（`scripts/ci/verify-artifact.mjs` 的 `sourceTreeDigest` 排除 `test` 目录）。它被传是因为安装脚本要用 `git bundle` 核对提交号再检出（`install/__PKT_LABEL__-artifact-install.mjs`），而提交号是整棵文件树的哈希，不能只传一部分文件。

两次上线之间，这 106MB 几乎不变。每次重传是浪费。

<a id="decision"></a>

## 决定

1. 生产机上留一个只放 git 对象的仓库 `/opt/himawari/source-cache.git`（root 所有，不可被组或其他人写）。路径由安装助手从新版本目录推出：`/opt/himawari/releases/<版本>` 往上两级加 `source-cache.git`。
2. 出包时（`make-packet.py prepare`）只读地问生产机缓存里有哪些已安装的提交（`git for-each-ref refs/release`），在本地仓库里挑一个是目标提交祖先、且离目标提交最近的作为基点，生成增量包 `git bundle create … HEAD ^<基点>`。缓存是空的、或没有可用基点，就生成完整包。命令行加 `--full-source` 强制生成完整包。
3. 生成后检查包的前置提交只有基点或基点的祖先；基点写进 `packet-parameters.json` 的 `SOURCE_BASE_COMMIT`（空表示完整包）。
4. 安装时（新增 `install/source-cache.mjs`）：缓存不存在就 `git init --bare`；先 `git bundle verify`，再 `git fetch <包> HEAD:refs/release/<冻结的提交号>`；读回该引用必须等于冻结的提交号；然后从缓存把这个提交取到全新的检出目录，沿用原来的“`git status` 干净、源码树指纹等于冻结值”检查。缓存已存在时检查它是 root 所有的真目录、不可被组或其他人写。
5. 上线前检查（`deploy-preflight.py`）在上传之前检查生产机缓存里有没有基点，没有就拒绝，什么都不传，并提示用 `--full-source` 重新出包。
6. Hermes 构建机本来就有完整仓库；出包时先问它有没有基点，没有就单独给它传一份完整包，不影响上线包。
7. 缓存只增不减，`release-cleanup.py` 只清理 `releases`、`operations` 等指定目录，不碰缓存（`release-cleanup-remote.py` 里没有对 `/opt/himawari` 其他子目录的删除）。

“先核对指纹、再安装”不削弱：冻结清单里仍然记着源码包的大小和 SHA-256，冻结的提交号和源码树指纹的核对一字未改；git 自己在 fetch 时校验每个对象的哈希和前置提交，缓存里的内容被篡改或缺失会在 fetch 或检出时失败。

<a id="options"></a>

## 放弃的做法

- **浅包或只打一次提交**：实测历史只占约 4MB，一次提交的完整文件树打成包仍是 114MB，省不到 5%。
- **自己造缺文件的 git 包**（只带需要的文件和全部目录对象）：技术上可行，但等于改 git 的完整性保证，风险高。放弃。
- **把测试证据挪出 git 仓库**：一次性省 77MB，Hermes 和所有克隆都受益，但要改很多文档里的路径引用，是仓库结构的大改动，另行讨论。
- **信任生产机上已有的检出而不重新核对**：会绕过提交号核对。放弃；缓存只是对象仓库，每次仍从包里取到冻结的提交并核对。

<a id="consequences"></a>

## 后果

- 缓存已有的情况下，源码包从约 118MB 降到几 MB；缓存第一次是空的，所以第一次使用这一机制的上线仍然传完整包（约 118MB），之后才有收益。
- 生产机多占约 118MB 磁盘。
- 缓存损坏或被删后，上线前检查会拒绝（`SOURCE_CACHE_HAS_BASE`），用 `--full-source` 重出包即可；不会在上传之后才失败。
- 门槛：`scripts/delivery-mode/test_make_packet.py` 的 `SourceBundleTest`（基点选择、增量包前置提交、Hermes 缺基点时单独传完整包、`--full-source`），`test_deploy.py` 的 `SourceCachePreflightTest`（缺基点上传前被拒、用真实缓存读回），`install/verify-source-cache-fixtures.mjs`（用真实 git：完整包播种、增量包追加、缺基点被拒、提交号不符被拒、可写缓存被拒；已加入每次出包的检查）。
- 没做的事：第二十四版之前不会有收益。依赖缓存（node_modules 不变时不重传）和去掉 Python 包与多余二进制是同一方案的后两步，各自单独提交。
- 安装助手里的新代码只有在真实上线时才在生产机上完整跑一遍；出包检查在 Hermes 上用真实 git 跑了同一份 `source-cache.mjs`。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0074：Claude 自己执行生产上线](0074-claude-runs-production-deployments.md)
- [ADR 0086：按参数生成上线包](0086-generate-release-packets-from-parameters.md)
- 一手来源：Git 文档 [git-bundle](https://git-scm.com/docs/git-bundle)（增量包带前置提交，`git bundle verify` 检查接收方是否具备它们）
- 阶段耗时和估算：项目文件 upload-slimming/plan.md、upload-slimming/timing-breakdown.md

[返回目录](#contents)
