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
仓库就是当前目录，已检出 ed3f8d0df0673935f6d6c92160b51e1d9449c943。
问题、目标和约束：
# 问题：把本仓库的全部 CI 从自托管 runner 迁到 GitHub 托管的标准 runner

列出的任何做法都只是参考，不要局限于此；请从问题本身出发，提出你认为最好的方案（含更好的替代做法）。

## 背景（已核对的事实）
- 仓库即将由私有改为公开。公开后，GitHub 官方：标准托管 runner 在公开仓库免费不限量（https://docs.github.com/en/billing/concepts/product-billing/github-actions ："Larger runners are billed for public repositories."；https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job ："Use of the standard GitHub-hosted runners is free and unlimited on public repositories."）。
- 公开仓库标准机器规格（https://docs.github.com/en/actions/reference/runners/github-hosted-runners）：ubuntu-24.04 4 核 16 GB 14 GB SSD；ubuntu-24.04-arm 同；macos-26（arm64）3 核 M1 7 GB。macos-26 镜像默认 Xcode 26.6。
- 免费套餐并发：总 20 个作业，macOS 最多 5 个；单作业最长 6 小时（https://docs.github.com/en/actions/reference/limits）。
- 安全：GitHub 官方“self-hosted runners should almost never be used for public repositories”（https://docs.github.com/en/actions/reference/security/secure-use）。所有自托管 runner 将被删除：OVH CI 服务器已退租；Oracle ARM 机器改做生产，不再跑 CI。
- Artifacts 存储：计费条文只写在“私有仓库”下，公开仓库是否免费文档没明说；缓存每仓库 10 GB，只有把上限调高才收费。
- 现有工作流：.github/workflows/ci.yml（policy、static、build、browser×3、tests×3、tooling、security、ci/required 汇总）、main.yml（main 确认）、merge-queue.yml、pr-closed.yml、quality.yml。runs-on 用的是自托管标签 ci-arm、ci-vps、ci-vps-gate。
- 作业之间传报告和构建产物靠 scripts/ci/run-share.mjs：把目录放进同一台机器的共享目录（环境变量 HIMAWARI_CI_SHARE），用目录摘要核对；汇总作业还用 scripts/ci/remote-share.mjs 通过 ssh 从 ARM 机器拉报告。
- 依赖安装 scripts/ci/install-dependencies.mjs 的 `--cache runner` 用 runner 主机上持久的 ~/.cache/himawari-ci/npm。
- 沙箱相关测试需要 bubblewrap、socat、ripgrep，以及在 Ubuntu 24.04 上放开无特权用户命名空间（自托管机器上由 scripts/operations/ci-runner/prepare-vps.sh 用 AppArmor 配置完成）。
- 已有的 CI 时间数据见 .agents/evidence/ci-speedup-lessons.md 和 .agents/evidence/ci-runs-2026-11-15.md（只作参考）：一次完整 main 运行 46–50 分钟；integration 两份 17/25 分钟；排队是主要耗时。
- 测试 test/tooling/ 下有锁定工作流形状的测试（如 ci-optimization.test.mjs、policy.test.mjs、run-share.test.mjs、remote-share.test.mjs、gate-lifecycle.test.mjs、ci-runner-scripts.test.mjs、merge-queue.test.mjs）。
- iOS/Apple 客户端在 clients/apple（Package.swift swift-tools-version 6.2，App/Himawari.xcodeproj，IPHONEOS_DEPLOYMENT_TARGET 26.0）。目前合并前由 Andy 的 Mac 手动编一次；事故 I-112（docs/incidents-and-gates.md）是 PR 没经 Mac 编译就合并导致 main 苹果端编译失败，尚无自动门槛。只做 iPhone，macOS/watchOS 暂停。

## 目标
1. 所有 CI 作业只用免费的标准托管 runner，绝不产生 GitHub 费用；需要一道自动检查防止以后写进收费 runner 标签或收费用法。
2. 保持现有检查的覆盖和“报告摘要核对、汇总作业 ci/required 判定”的语义，或者给出更简单但同样可靠的替代。
3. 尽量快：利用 20 个并发，目标是一次完整运行明显短于现在的 46–50 分钟。
4. 新增 iOS 编译（和能跑的单元测试）作业，作为 I-112 的自动门槛；不签名、不在 GitHub 存任何密钥。
5. 删除不再需要的自托管 runner 脚本和 ssh 拉报告的代码。

## 约束
- 不在 GitHub 上花钱（不用 larger runner、不调高缓存上限、不买存储）。
- 不能写死能动态获取的东西；不加代码注释（仓库规则）。
- 外部 PR（fork）不得拿到任何写权限或密钥。
- 改动要能分步合并，迁移期间不能让 main 长时间没有 CI。

请给出：整体方案、每个作业放在哪种 runner、作业间怎么传文件、缓存怎么做、iOS 作业怎么写、收费防护检查怎么做、要改和要删的文件清单、迁移步骤和风险。
