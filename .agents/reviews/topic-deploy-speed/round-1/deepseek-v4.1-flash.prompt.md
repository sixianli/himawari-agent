你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 3cbd77356f7f65db72d28ae15ee687fa4dd3e912。
问题、目标和约束：
# 问题：Himawari 上线到生产太慢、失败后重来太贵

## 背景（已核实的事实，来源都在仓库或 2026-11-15 的上线日志）
- 上线流程：Mac 上 `scripts/delivery-mode/make-packet.py prepare` 在 Hermes（家里的测试机）构建候选包，把材料取回 Mac，冻结成上线包；然后 Mac 上 `scripts/delivery-mode/deploy.sh <包>` 经 root SSH 操作唯一的生产机（x86 4 核 8GB）。步骤：release-cleanup（清理旧现场）→ deploy-preflight.py（预检）→ S1_TRANSPORT（`packet-template/steps/transport-packet.py`：一条 tar 流经 SSH 上传整个包，服务器端按 freeze-manifest 逐文件核对 SHA-256）→ S1_INSTALL（`packet-template/install/S1-publish-and-install.py` 和 `__PKT_LABEL__-artifact-install.mjs`、`extract-node-modules.py`：复制包、按 p5-materials 核对 7 个材料、解压 node_modules 并逐文件核对哈希、安装）→ S6_ACCEPTANCE（停服前在生产机上验收新版本）→ S2_STOP … S8_READBACK。
- 包 413 MB：node-modules.tar.gz 282 MB（未压缩 907 MB、33,853 个文件，scope 为 `whole-locked-node-modules`）、候选包 76 MB、python-3.12.10.tar.gz 34 MB（哈希写死在模板里，永远不变）、node-modules.json 8.5 MB、source-build-inputs.json 8 MB、源码 bundle 0.14 MB（源码已经是增量 bundle，生产机上有 `/opt/himawari/source-cache.git`，见 `install/source-cache.mjs`）。
- node_modules 里 406 MB（未压缩）在生产 linux-x64 glibc 上永远不会加载：onnxruntime-node 的 darwin/win32/linux-arm64 二进制 255 MB，musl 版本的原生包和 biome 151 MB。
- `package-lock.json` 从 10-29 到 11-15 只改过 1 次。
- 实测耗时（11-15 三次尝试）：上传 272–365 s（Mac 到生产 1.1–1.5 MB/s）；安装 142–176 s；S6 验收 337–380 s；停服窗口约 292 s；出包约 8.6 分钟。生产机从公网下载 13.8 MB/s，Mac 下载 3.8 MB/s（各测一次）。Hermes 到 Mac 9.4 MB/s（局域网）。
- 11-15 当天 4 次上线 0 次成功。最后一次在预检停下：`PREFLIGHT_CHECK TARGET_PATH_ABSENT /var/lib/himawari/qualification/twentyninth-20261115 failed`。部署前的 `release-cleanup-remote.py` 对这个路径只在为空时删除，非空时 `keep(target, 'qualification-not-empty')`。此前还有两次同类残留（`/opt/himawari/releases/2026-11-15-twentyninth`、`/opt/himawari/operations/twentyninth-20261115`），每次都要人手动移走、要 Andy 亲手打字授权。预检的目标路径清单在 `deploy-preflight.py` 的 `target_paths()`，清理规则在 `release-cleanup-remote.py` 的 `cleanup()`，两份是分开写的。
- 失败策略：实例 `andy-production` 设 `onDeployFailure: keep`，停服后失败不回滚、保留现场；同一个包不能直接重跑（预检要求目标路径不存在）。

## 目标
1. 每次上线少传数据：依赖没变时不重传 node_modules 和 python。
2. 评估“生产机去拉包而不是 Mac 推”是否值得做，以及瓶颈到底在哪。
3. 上一次失败留下的同名路径，下一次 deploy.sh 自己处理，不要每次人工和授权。
4. 其他你认为更好的做法。

## 约束
- 安全模型不能削弱：生产机上用到的每个文件都必须按冻结清单或材料清单的 SHA-256 核对，不能“信任生产机上已有的东西”。
- 不在 GitHub 上花钱；花钱先问；不得通过按 token 付费渠道用贵模型。
- Andy 说线上数据不重要、只有他一个用户，停服时长不是成本；他最在意上线总时长。
- 删除生产上的东西要谨慎：优先移到一边保留（`/var/lib/himawari/release-cleanup/`），不直接删。
- 不在生产机上构建；不新增常驻服务。
- 不写死数值，能动态取的就动态取。
