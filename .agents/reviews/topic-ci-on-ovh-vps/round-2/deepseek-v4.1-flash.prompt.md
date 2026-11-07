你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 058293d161876f45283f9e168d4bbe89da3fd8cb。
待审核的方案：
# 线程的方案：CI 从 Hermes 搬到 OVH VPS

问题、约束和已核对的事实同上一轮材料。补充两条新核对的事实：

- VPS 上 `kernel.apparmor_restrict_unprivileged_userns = 1`，没有装 bubblewrap。生产机同样是 24.04 并带这个限制，项目的做法写在 `docs/runbooks/install-start-stop-runbook.md:488-600`：装系统 bwrap，新建 `/etc/apparmor.d/bwrap`（`profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, … }`）并用 `apparmor_parser -r` 加载，不关全局开关。
- VPS 的 cloud-init 配置是 `preserve_hostname: false`，并启用了 `set_hostname`、`update_hostname`，所以手动改的主机名重启后可能被改回去。

## 一、分两步搬

1. **第一个 PR：`ci.yml` 和 `main.yml` 搬到 VPS。** 这两个工作流决定合并闸门 `ci/required` 和 main 确认，先让它们恢复。
2. **第二个 PR：`quality.yml` 搬到 VPS。** 它只能手动触发、只跑 main，不影响合并；但它要 Docker 和带品牌的浏览器，和 runner 账号不能用 sudo、docker 的隔离做法冲突，需要单独设计（见第五节）。在它搬完之前 `quality.yml` 保持停用（Andy 2026-11-06 已同意继续停着）。

## 二、runner 标签改名

- 新标签 `ci-vps`，runner 名 `ci-vps-1`、`ci-vps-2`。不沿用 `hermes-home`：项目要求同一个东西只用一个名字，机器已经不是 Hermes。名字不带服务商，以后换机器不用再改标签。
- 改所有写死处：`ci.yml`、`main.yml`、`actionlint.yaml`、`ci/policy.json`、`ci/policy.schema.json` 的 enum（改成 `["ci-vps","macos-15"]`）、`check-policy.mjs:62,70,209`、`main-workflow.mjs:48`、对应测试。
- 基准策略过校验：仿照 `upgradeHostedRunnerPolicy` 和 `upgradeArtifactRetention`，新增 `upgradeRunnerLabel`，只在基准策略整份恰好是旧写法时升级：所有非 macOS 成员的 `runner` 都是 `hermes-home` 且没有 `paused`，macOS 成员是 `macos-15` 且 `paused: true`，各项时限等于 `timeoutMinutesFor` 的值；这时把非 macOS 成员改成 `ci-vps`，其他写法原样交给 schema 拒绝；在 `resolvePolicySource` 里接在已有两个升级函数之后、`validatePolicy` 之前。升级后的策略作为 `source.policy` 返回，所以主流程用基准策略校验当前 `ci.yml` 时也是新标签。`policySha256` 仍按基准原始字节算。补正反用例：恰好的旧写法升级；混写（一部分 `hermes-home`、一部分 `ci-vps`）被拒；macOS 成员没暂停或时限不对的不升级；当前 `ci.yml` 或 `main.yml` 里留一处 `hermes-home` 被拒；`policySha256` 等于原始字节的摘要。`upgradeHostedRunnerPolicy` 的目标标签同时改成 `ci-vps`。另加一条测试：三个工作流文件里出现 `hermes-home` 就失败。`actionlint.yaml` 只列 `ci-vps`。

## 三、runner 脚本

- `scripts/operations/hermes-runner/` 改名为 `scripts/operations/ci-runner/`，测试 `test/tooling/hermes-runner-scripts.test.mjs` 跟着改名。Hermes 上的 runner 注销后，旧脚本不再有用，不保留两份。
- 主机检查：VPS 主机名改为 `ci-vps`（`hostnamectl`），并在 `/etc/cloud/cloud.cfg.d/` 下加 `preserve_hostname: true`，脚本按 `ci-vps` 检查。
- sudoers 里的用户由 `andy` 改为 `ubuntu`；runner 根目录、账号名（`gh-runner`、`gh-runner-2`）、systemd 单元名不变。
- 内存：VPS 只跑 CI，22 GB。总资源组 `MemoryHigh=19G`、`MemoryMax=20G`，每个 runner `MemoryHigh=14G`、`MemoryMax=15G`，给系统留约 2 GB。
- nft 出站规则照旧：runner 账号不能连私有网段、`169.254.0.0/16`（云主机的元数据服务在这里）、本机正在监听的端口。
- Mac 端的暂停和恢复脚本改为直接 `ssh ubuntu@158.69.191.249`（地址可用环境变量覆盖），远端目录 `/home/ubuntu/ci-runner`，不再经仓库外的 `hermes-ssh.sh`。
- `job-started.sh` 的 16 GiB 磁盘底线不变。

## 四、VPS 一次性准备（root，写成仓库里的脚本，可重复运行）

- `apt install build-essential unzip xz-utils bubblewrap socat`（`scripts/ci/install-dependencies.mjs:357-366` 在没有预编译包时用 node-gyp 编译 better-sqlite3，要 gcc、g++、make），和 Playwright 浏览器（chromium、firefox、webkit）需要的系统库：用一次 `npx playwright install-deps chromium firefox webkit`（以 root 运行，版本取 `package-lock.json` 里固定的 Playwright），之后 CI 任务里不带 `--with-deps` 的安装就能用。
- 按安装 Runbook 新建并加载 `/etc/apparmor.d/bwrap`，不关全局开关；用 runner 账号跑一次 `bwrap --unshare-all --unshare-net … /usr/bin/true` 验证。
- 用 runner 账号跑一次 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs`（它不在 `npm run check` 里，CI 不一定跑到真实 bwrap），记录 bwrap 版本、AppArmor 开关和结果，作为验收的一项。
- 自动安全更新保持开启，但关掉自动重启，免得任务中途被重启。

## 五、`quality.yml`（第二个 PR，先定方向）

- `brands`：Chrome 和 Edge 由 root 事先装好（Google、Microsoft 的官方 apt 源），工作流去掉 `--with-deps chrome msedge` 的安装，改为检查两个浏览器在不在、打印版本；`quality-policy.mjs` 跟着改。
- `container`：两个模型独立出方案时都建议给第三个专用账号（标签 `ci-vps-quality`）加进 docker 组、不给 sudo，理由是 rootless 在 24.04 上还要配 userns、subuid 和 AppArmor，并要改写死的套接字；`quality.yml` 只能手动触发、只跑 main 上已合并的代码。这会改 ADR 0160 的隔离做法，交给 Andy 定。另一个选择：用 rootless Docker（Docker 官方的非 root 运行方式），只给第三个专用 runner 账号用，套接字在 `/run/user/<uid>/docker.sock`，`quality-policy.mjs` 里写死的 `unix:///var/run/docker.sock` 改成可配置。要先验证 runner 镜像在 rootless 下能构建、容器测试需要的资源限制在 cgroup v2 委派下可用。验证不过再考虑别的做法，并请 Andy 定。

## 六、切换顺序

1. VPS 准备（第四节），装 runner 软件，暂不注册。
2. 第一个 PR：标签改名、升级函数、脚本改名改值、新 ADR（取代 0160、0171、0173，修订 0168、0169）、新 Runbook 取代 Hermes 的 Runbook、改 `delivery-mode.md:27` 和 `test-trigger-timing.md:17`、`test-and-production-hosts.md` 加一条 VPS 的说明。合并前在 Hermes 上跑 `npm run check` 和受影响的测试。
3. 在 VPS 上注册 `ci-vps-1`、`ci-vps-2`（标签 `ci-vps`），打开 `ci.yml`，让第一个 PR 的 CI 在 VPS 上完整跑一次；全部通过才算验收。
4. 合并后打开 `main.yml`，看 main 确认在 VPS 上通过。
5. Hermes：从 GitHub 删除两个 runner 的注册（Mac 上 `gh api -X DELETE`），再由 Andy 在 Hermes 上用 sudo 跑一次卸载脚本（Andy 账号没有 root）。卸载要在仓库删掉旧脚本之前，用 main 上的旧版本跑。
6. 任务时限（ADR 0168 放宽到 90/60/15 分钟）先不改；在 VPS 上跑满一周后按实际时长再定。

- Hermes 注销 runner 后仍是合并前本地检查的测试主机（`.agents/instructions/test-and-production-hosts.md` 不变）；只是不再接 CI 任务。

## 七、回退

- 第一次全量运行出现只在 VPS 上失败的测试：先判断是 24.04 和 22.04 的差别（这也是生产机会遇到的问题，要修代码或测试），还是 VPS 环境缺东西（补准备脚本）。不把标签改回 Hermes。
- 要临时退回 Hermes：Hermes 的 runner 在第 5 步之前还在，只是标签是 `hermes-home`；退回就是还原这个 PR。第 5 步之后再退回要重新装。

## 八、风险

- 第一个 PR 自己的 CI：基准上是 `hermes-home`，靠升级函数过校验；Hermes 上的 runner 那时还挂着 `hermes-home` 标签，但新工作流只要 `ci-vps`，不会被派到 Hermes。
- VPS 是共享物理机，速度可能波动；云盘随机读比 Hermes 慢，靠 22 GB 内存的文件缓存弥补。
- runner 账号能连外网（下载依赖必需），但不能连本机服务和元数据服务。
