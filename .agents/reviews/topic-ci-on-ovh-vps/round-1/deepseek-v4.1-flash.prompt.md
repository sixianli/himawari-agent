你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 058293d161876f45283f9e168d4bbe89da3fd8cb。
问题、目标和约束：
# 问题：把 CI 从 Hermes 搬到一台新的 OVH VPS

## 目标

Andy 2026-11-06 的决定：GitHub Actions 的 CI 全部改到新开的 OVH VPS 上跑，GitHub 不再扣钱；Hermes 上的两个 runner 注销，Hermes 只跑它自己的服务。`ci.yml`、`main.yml`、`quality.yml` 三个工作流现在都被手动停用，等新机器上的 runner 装好、完整跑通一次再打开。

请给出搬迁方案：仓库里要改什么、VPS 上怎么装、按什么顺序切换、怎么验收、怎么回退，以及每一步的风险。

## 约束

- 自托管 runner 不收分钟费；GitHub 缓存和 artifact 已按 ADR 0174 去掉（artifact 只留 1 天）。不能引入任何会在 GitHub 上计费的东西。
- 项目规则：改了 `ci/policy.json` 的 PR，CI 用目标分支（基准提交）上的策略校验，见 `scripts/ci/check-policy.mjs` 的 `resolvePolicySource`；ADR 0160 第 6 条、ADR 0174 第 5 条记了这个坑和已有的一次性升级函数做法。
- runner 账号不给 sudo、不进 docker 组（ADR 0160 定的隔离做法，`scripts/operations/hermes-runner/gh-runner.service.in` 里的 systemd 限制和 `runners.sh` 里的 nft 出站规则）。要改这一条必须说明理由。
- 合并前的本地检查（`npm run check`、测试）只在 Hermes 上跑，不在 Mac 上跑。VPS 是新机器，不能用来跑与 CI 无关的东西。
- 不写代码注释；改了的文件里已有的注释要删掉。

## 已核对的事实

- VPS：OVH，Ubuntu 24.04.4，内核 6.8，8 个 vCPU（Haswell），22 GB 内存，200 GB 磁盘（`/dev/sda1` ext4），主机名 `vps-482b8c36`，账号 `ubuntu` 有免密 sudo。已关掉 SSH 密码登录，ufw 只放行 22 端口。有 python3 3.12、git 2.43、nft、curl、jq；没有 gcc/make/unzip。
- 测速（同一脚本各跑一次）：VPS 单核比 Hermes 快约 40%，8 核总算力约为 Hermes 4 核的 3 倍；4 KB 同步随机写 8393 次/秒，Hermes 497 次/秒；4 KB 直读随机读 7094 次/秒，Hermes 12850 次/秒。
- 生产服务器是 Ubuntu 24.04，带 AppArmor 对非特权用户命名空间的限制（`.agents/instructions/test-and-production-hosts.md:18`）；Hermes 是 Ubuntu 22.04、bwrap 0.6.1。ADR 0160 第 2 条：CI 结果按 Hermes 的 22.04 判定，不代表生产。
- runner 标签 `hermes-home` 写死在：`.github/workflows/ci.yml`（13 处）、`main.yml:18,69`、`.github/actionlint.yaml:3`、`ci/policy.json`（11 个成员）、`ci/policy.schema.json:63-64`（`enum: ["hermes-home","macos-15"]`）、`scripts/ci/check-policy.mjs:62,70,209`、`scripts/ci/main-workflow.mjs:48`、`test/tooling/policy.test.mjs`、`test/tooling/ci-optimization.test.mjs:119-120`。`check-policy.mjs` 主流程还用基准策略去校验当前的 `ci.yml`（单成员任务比 `runs-on`，矩阵任务比 include 列表）。
- `quality.yml` 有 7 个任务，都在 GitHub 托管的 `ubuntu-24.04` 上，只能手动触发、只跑 main；`scripts/ci/quality-policy.mjs:119,170` 写死 `ubuntu-24.04`。其中 `brands` 任务用 `playwright install --with-deps chrome msedge`（要 sudo 和 apt 装 Google Chrome、Microsoft Edge），`container` 任务要 `/usr/bin/docker` 和 `unix:///var/run/docker.sock`（`quality-policy.mjs:23-24`），会 `docker pull` 两个按摘要固定的镜像再 `docker build packages/runtime-sandbox/runner-image`。ADR 0160 第 7 条就是因为 runner 账号不能用 docker 才把 `quality.yml` 留在托管机器上。
- `ci.yml` 的 `static`、`browser` 任务用 `playwright install`（不带 `--with-deps`），所以浏览器的系统库要事先装在机器上。CI 任务自己下载 Node、npm、Python、actionlint、gitleaks、semgrep（`scripts/ci/install-tools.mjs`、`ci/toolchain-lock.json`），不依赖系统 python3；`coverage` 用 `/usr/bin/git`，`security` 用 `/usr/bin/curl`，部分安全检查把 `PATH` 限成 `/usr/bin:/bin`。
- Hermes 上 runner 的安装、注册、暂停、卸载脚本在 `scripts/operations/hermes-runner/`，测试在 `test/tooling/hermes-runner-scripts.test.mjs`。这些脚本按主机名 `hermes-home` 拒绝在别处运行，写死 `/srv/gh-runner{,-2}`、sudoers 用户 `andy`；Mac 上的暂停和恢复脚本经仓库外的 `.ci-output/handoff/scripts/hermes-ssh.sh` 连 Hermes。相关 ADR：0160（runner 放 Hermes）、0168（任务时限放宽到 90/60/15 分钟）、0169（暂停先删标签）、0171（两个 runner）、0173（Hermes 只跑 CI，内存上限）。Runbook：`docs/runbooks/hermes-self-hosted-runner-runbook.md`。
- `.agents/instructions/delivery-mode.md:27` 和 `.agents/instructions/test-trigger-timing.md:17` 写着 CI 在 Hermes 的自托管 runner 上跑。

## 请重点回答

- runner 标签沿用 `hermes-home` 还是改名；改名的话，基准策略怎么过校验。
- `quality.yml` 怎么搬：Docker 和带品牌的浏览器在“runner 账号不给 sudo、不进 docker 组”的前提下怎么解决，是否值得和 `ci.yml`、`main.yml` 同一次搬。
- Ubuntu 24.04 的 AppArmor 用户命名空间限制会不会让沙箱相关测试在 VPS 上的结果和 Hermes 不同，第一次全量运行之前要准备什么。
- 切换顺序和回退办法；Hermes 上 runner 的注销。
