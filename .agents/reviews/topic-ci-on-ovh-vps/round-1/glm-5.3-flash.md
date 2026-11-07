我先读仓库里的关键文件，弄清现状。
我需要核实一个外部事实：Playwright 如何发现系统安装的品牌浏览器，以及 `--with-deps` 需要 root 的问题。
# 方案：CI 从 Hermes 迁到 OVH VPS（仓库 058293d）

## 一、方案前提（读代码或来源证实的）

1. **自托管 runner 不产生分钟费。** ADR 0160 已核对 GitHub 计费页：“GitHub Actions usage is free for self-hosted runners”（docs/adr/0160-self-hosted-runner-on-hermes.md:108，https://docs.github.com/en/billing/concepts/product-billing/github-actions）。
2. **改策略的 PR 按基准分支的 policy.json 校验。** `resolvePolicySource` 从基准提交取 bytes，再过 `validatePolicy`（scripts/ci/check-policy.mjs:989-998）；`validatePolicy` 硬性断言每个非 macOS 成员 `runner === "hermes-home"`（check-policy.mjs:209）。原话：“Incorrect platform”。所以**只改 policy.json 不加升级代码，改标签的 PR 自己会失败**。
3. **一次性升级函数是本仓库已有做法。** hosted→Hermes 用 `upgradeHostedRunnerPolicy`（check-policy.mjs:53-72，ADR 0160 决定第 6 条：“就把它升级成新写法；其他写法一律不动”）；30/7 天→1/1 天用 `upgradeArtifactRetention`（check-policy.mjs:74-83，ADR 0174 决定第 5 条：“做法和已有的 upgradeHostedRunnerPolicy 一样”）。两种升级都有正反用例（test/tooling/policy.test.mjs:675、697：“把已接受的 30 天和 7 天保存期升级成 1 天一次，别的值照样被拒”）。
4. **`hermes-home` 写死的位置**：ci.yml 13 处、main.yml:18,69、`.github/actionlint.yaml:3`、ci/policy.json 11 处、ci/policy.schema.json:64 `enum: ["hermes-home","macos-15"]`、check-policy.mjs:62,70,209、main-workflow.mjs:48、test/tooling/policy.test.mjs、test/tooling/ci-optimization.test.mjs:119-120、register-runner.sh:29（`--labels hermes-home`）、runners.sh:9,16。基准校验只对 ci.yml/main.yml 走“双份”，**quality.yml 没有基准校验**——main 流程只拿当前 policy 和当前文件互验（check-policy.mjs:1147-1151）。
5. **runner 隔离现状**：专用系统账号、无 sudo/docker 组、systemd 加固、nft 出站规则（scripts/operations/hermes-runner/gh-runner.service.in:27-36、runners.sh:47-61）；两个 runner 数量与共用 slice、16 GiB 磁盘底线、试跑判断标准来自 ADR 0171（docs/adr/0171-two-runners-on-hermes.md:60-70）；暂停机制存在原因是 Hermes 上跑着别的服务（ADR 0160 决定第 5 条）。**VPS 不跑 CI 之外的东西是本次约束**，所以暂停体系在 VPS 上没有存在理由。
6. **平台语义**：ADR 0160 决定第 2 条“由 Hermes 的 Ubuntu 22.04 结果判定 ci/required”；指令文件第 18 条：“一个平台的结果绝不能代替另一个平台：Hermes（Ubuntu 22.04，bwrap 0.6.1）……不能代表生产服务器（Ubuntu 24.04，带有 AppArmor 对用户命名空间的限制）”（.agents/instructions/test-and-production-hosts.md:18）。
7. **bwrap 与 24.04**：Ubuntu 24.04 默认限制普通用户使用用户命名空间；批准的做法是给具体程序路径加 AppArmor profile（flags=(unconfined)+userns），**不改全局 sysctl**（docs/runbooks/install-start-stop-runbook.md:488-597，https://documentation.ubuntu.com/release-notes/24.04/）。SRT 依赖说明 bwrap 是 Linux 沙箱前提（https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/README.md#platform-specific-dependencies）。I-57 记录：“云端缺 bubblewrap，用例被跳过”（docs/incidents-and-gates.md:94）——bwrap 缺失时沙箱用例会静默跳过。
8. **品牌浏览器**：`playwright install --with-deps` 会“attempt to become a root”装 apt 包，无 sudo 必失败；channel `chrome`/`msedge` 使用“the branded … browsers **available on the machine**”，且“PLAYWRIGHT_BROWSERS_PATH does not change installation path for Google Chrome and Microsoft Edge”——系统全局安装一次即可被 Playwright 找到（https://playwright.dev/docs/browsers，本会话抓取原文）。
9. **quality 现状**：`container` 任务需要 `/usr/bin/docker` + docker.sock（scripts/ci/quality-policy.mjs:22-25）；`brands` 用 `install --with-deps chrome msedge`（quality.yml:123）；`runs-on` 硬编码 `ubuntu-24.04`（quality-policy.mjs:119,170）。ADR 0160 决定第 7 条把它留在托管机上就是因为 docker 和 sudo；ADR 0174 后果第 4 条：“重新打开工作流之前，要另外决定它搬到自己的服务器还是继续停着”。
10. **文档要同步**：delivery-mode.md:27 与 test-trigger-timing.md:17 写“CI …在 Hermes 上的自托管 runner 里运行”。

**标记为推测的**（见第六节）与上述相对，均注明。

## 二、方案本身

### 1. runner 标签：改名，新标签如 `vps-x64`（具体字符串待拍板）

- **为什么改名**：`hermes-home` 承载了三层语义——机器、平台（22.04）、判定权归属（ADR 0160 d2）。搬到 VPS 后前两层都变了；沿用旧名等于让"ci/required 由 22.04 判定”这条被采信的决定静默变成 24.04 而无人知晓。换名字把平台切换显式化，也让新 ADR 有落点。改名期间两条规则同时成立：旧名只属于 Hermes 时代的 runner，新名只属于 VPS 的 runner（Linux 成员 `runs-on` 一致性仍是强校验）。
- **基线怎么过校验**：按第 2 个前提，加第三个一次性升级函数 `upgradeHermesRunnerPolicy`，识别“与 ADR 0160 迁移后形状完全一致”的基准策略（非 macOS 成员全是 `hermes-home`、macOS 全为 `macos-15` 且 `paused: true`、超时是 90/60/15 模式），把它升级成新标签；其他形状照旧拒绝。`resolvePolicySource` 的链条改为按 hosted→Hermes→VPS 顺序复合（check-policy.mjs:993）。同时把 check-policy.mjs:62,70,209、main-workflow.mjs:48、schema enum、actionlint.yaml 改为新标签；`upgradeHostedRunnerPolicy` 保持不动（它输出的正好是 `upgradeHermesRunnerPolicy` 认得的形状）。这是舍名而不舍检查的做法。
- **不改的东西**：`macos-15` 成员与 `paused` 机制不动；超时 90/60/15（ADR 0168）不动；缓存/retention（ADR 0174）不动。

### 2. quality.yml：和 ci.yml、main.yml 同一次迁移窗口，但作为独立的第二个 PR 启用

- `runs-on` 改为新质量标签（quality-policy.mjs:119,170 + quality.yml 同步；无基准校验问题）。
- **brands**：装机时由管理员（ubuntu 账号）一次性 apt 安装 Google Chrome 与 Microsoft Edge .deb、以及 Playwright 系统依赖（约 `libnss3` 等一组包，用官方 `playwright install-deps` 的等价清单）；workflow 删掉 `install --with-deps` 步骤，channel 方式直接用系统浏览器（前提 8）。quality-policy.mjs 的步骤模板同步删除该步。
- **container**：不改 `HIMAWARI_CONTAINER_DOCKER_CLI/HOST` 环境变量（quality-policy.mjs:22-25 原样），但给 VPS 上**第三个专用 runner 账号**（如 `gh-quality`）：加入 `docker` 组、无 sudo。**这是对“runner 不进 docker 组”约束的显式豁免，理由如下**：
  1. 豁免不落在跑 PR 未审代码的两个账号上——它们保持零加组零 sudo（ADR 0160 隔离的价值主要在拦 PR 时的不可信代码）；
  2. 该账号只跑已合并进 main、手动触发、专人按 dispatch 的质量任务（quality.yml 只在 `refs/heads/main` 跑）；
  3. 该账号自身仍套用同一份 systemd 加固模板（NoNewPrivileges、ProtectSystem=strict、InaccessiblePaths 隔开另两个 runner 根目录、PrivTmp），docker.sock 被访问面有限制（跑质量任务本来就是验证容器后端资格，绕不开对 docker 的访问）；
  4. systemd + 账号分离之外，VPS 上没有需要 nft 挡内网的目标（Hermes 的 nft 规则保护的是 Hermes 本机服务，VPS 是专职机），可在新机器上省掉 nft 层、保留账号与 systemd 两层。
- **是否同一次搬**：值得。理由：quality 每次手动触发都在烧托管分钟（违反“不能引入任何会在 GitHub 上计费的东西”），不搬就只能永远停用等于废弃这 7 项检查；机器准备工作（docker、浏览器）一次做好，边际成本低。拆成两个 PR 的原因：ci/main 迁移牵涉基准升级链，是唯一有回退风险的面；quality 改动没有基准校验，风险独立，第二个 PR 语义更清楚。

### 3. 24.04 AppArmor 与沙箱：先装 bwrap + 只给它的 profile，再全量跑

- VPS 现状没有 bwrap（已核对的事实清单里没有）。**如果不装，沙箱用例按 I-57 的先例会跳过**，结果和 Hermes “看起来绿”但内容不同——这正是必答问题 4 要防的“两端没核对”的形态。
- 装机步骤（管理员执行，沿用生产已批准路径）：安装发行版 `bubblewrap` 到 `/usr/bin`；加 `/etc/apparmor.d/bwrap`（profile 内容按 install-start-stop-runbook.md:537-541 照抄：`flags=(unconfined)` + `userns,`）；**不改全局 `kernel.apparmor_restrict_unprivileged_userns`**；以 `gh-runner` 账号跑 runbook 的冒烟命令 `bwrap --unshare-all --unshare-net --ro-bind / / --dev /dev --proc /proc /usr/bin/true`，退出 0 才算就绪；把 `bwrap --version` 记进首次全量运行的验收记录。
- 产品侧 `bubblewrap >= 0.11.2` 的 0.11.2 路径（program/stdio MCP 后端门槛）是否被本次全量触碰，按试跑结果记录；若出现 `BACKEND_VERSION_UNSUPPORTED`，按既有先例不自动放宽、留下现场请示（docs/execution/plans/2026-09-30-production-first-deployment-plan.md:175 有“系统 bwrap 与 0.11.2 各自为政”的先例可依）。

### 4. VPS 安装与切换顺序（每步有一个可观察的通过信号）

| # | 动作 | 通过信号 |
|---|---|---|
| 1 | 管理账号装机：`docker.io`、`bubblewrap`、Chrome/Edge .deb、Playwright 系统依赖、bwrap AppArmor profile；建 `gh-runner-1/2` 与 `gh-quality` 账号和 docker 组 | bwrap 冒烟命令以 runner 账号退出 0；`docker info` 以 gh-quality 账号退出 0 |
| 2 | 仓库 PR-1（在 Hermes 仍在线时开出）：标签全套改名 + `upgradeHermesRunnerPolicy` + 测试 + 新 `scripts/operations/vps-runner/`（自 hermes-runner 脚本改写：hostname 门改为 `vps-482b8c36`；**去掉 pause/resume 体系**；磁盘底线沿用 16 GiB；保留备份/回滚逻辑）+ 文档四处更新 + ADR 0175 | 在 Hermes 上以旧标签完成一次本地离线校验（`check-policy.mjs` 用 fixture 走升级链正反用例） |
| 3 | VPS：sudo 运行新 install 脚本，注册 2 个 runner（`--labels vps-x64`，两个独立名称与两份注册 token，遵守 ADR 0171 d7 的 `--replace` 教训）；注册 gh-quality runner | GitHub Runner 页三个 runner idle，各自标签正确 |
| 4 | 向 Andy 确认后打开 Actions 总开关（全局 Settings → Actions）；**只 enable ci.yml 与 main.yml**（接 ADR 0160 d7 的时点做法） | 开关打开且两个工作流 Active |
| 5 | 推 PR-1：9 个 job 全绿即基准升级链的第一次真实验证；记录每个 job 的排队/运行时长、磁盘峰值 | `ci/required` 绿 |
| 6 | PR-2：quality 标签与步骤改动；手动触发一次 brands 与 container 各试跑 | 两个 job 各绿一次，浏览器与 docker pull/build 步骤无 sudo 参与 |
| 7 | 试跑（建议沿用 ADR 0171 的观察条款 7 天：时长、排队、`memory.events` 的 oom 计数、超时次数）；由 Andy 决定 ruleset 是否改为要求 `ci/required`（ADR 0160 d8 模式） | Andy 的书面决定 |
| 8 | 确认稳定后注销 Hermes：Mac 侧先跑 pause（ADR 0169 流程）→ GitHub 上删除两个 Hermes runner（`gh api -X DELETE .../actions/runners/<id>`）→ Hermes 上 `sudo bash uninstall-runner.sh all` → 在清理 PR 里退役 hermes-runner 脚本、Mac 侧 pause/resume 与 delivery-mode 里的相应坏话 | 卸载脚本输出 `UNINSTALL_OK`；GitHub Runner 页无 Hermes 项 |

### 5. 回退：任何一步都能回到“Hermes 跑”

- 触发回退只做三件事：(a) GitHub 再次手动停用工作流（现状即已知态）；(b) 停 VPS runner 服务；(c) revert 对应 PR。**这正是 Hermes 侧在确认稳定前什么都不删的原因**： Hermes 的 install/register 脚本与旧标签在新代码合入前一直完好，Hermes runner 一注册即可接旧 `/hermes-home` 任务。
- PR-1 合入后回退的次序：先 revert PR-1（基准策略回到 `hermes-home` 形状，`upgradeHermesRunnerPolicy` 输入消失，串行无害），再重新注册 Hermes runner。
- 若仅 PR-2（quality）失败：revert PR-2 即回到 quality 停用态，ci/main 不受影响。
- 装机类回退：install 脚本自带备份/恢复机制（install-runner.sh:36-54 的 backup/restore 与 `RESTORE_INCOMPLETE` 报告），新目录脚本沿用同一骨架。

### 6. VPS systemd 数值（判据写在前面，先给初值后验证）

- 两个 PR runner 各自账号+服务沿用模板加固；slice 不设 CPU 上限与低优先级（照 ADR 0173“机器上没有别的服务”的结论），内存给初值 slice `MemoryHigh=17G/MemoryMax=19G`、每服务 `MemoryHigh=8G/MemoryMax=9G`、`MemorySwapMax=0`，给 ssh 留 ≥2 G。**初值是推测**，以试跑 `memory.events` 与实测峰值校准，判据提前写定（不新增超时修改；超时 90/60/15 不动）。

## 三、考虑过但不选的做法及原因

1. **沿用 `hermes-home` 标签**：表面上是零代码改动（ci.yml、schema、测试都不用动），但代价是把 22.04→24.04 的平台切换藏进旧名下，违反“一个平台的结果绝不能代替另一个平台”的可审计表达；而且将来 Hermes 彻底退役后，标签名指向一台没有 runner 的机器，注册时的`--labels`错配也不易被 review 发现。改名成本集中在升级函数，模式是仓库已胜任两次的。
2. **rootless Docker/Podman 替代 gh-quality 的 docker 组**：rootless 运行时本来就依赖非特权用户命名空间，恰是 24.04 要收紧的东西；仓库既有立场是“不得关闭全局开关、不得降低隔离要求”（install-start-stop-runbook.md:597），给 rootless 容器单独开 profile 又引入第二套 AppArmor 例外。不选。
3. **brands 改成 runner 内逐次 `playwright install chrome`**： branded 安装“will be installed at the default global location”，本质上每次都要 root 装系统包，把一次性权限塞进每次 CI。不选，改为装机时管理员一次安装（前提 8）。
4. **quality.yml 先别搬，继续停用**：不违背计费约束，但让 7 项检查无限期消失；与“等新机器装好、完整跑通一次再打开”的目标陈述冲突。只把它排在第二 PR。
5. **VPS 上也保留暂停机制（照搬 IPA 0169）**：VPS 按约束不跑 CI 以外的任何东西，没有要保护的服务；双 runner 之间的资源竞争用 slice 而不是全局暂停解决。删掉可减少 1/3 的脚本与测试面。
6. **在 PR-CI runner 上直接给 docker/sudo 豁免**：跑的是 PR 里未审代码，豁免会实质瓦解 ADR 0160 的隔离；即便只是 docker.sock，其效果也近似 root。坚持两个 PR runner 零加组零 sudo。

## 四、风险和反例（每个都能写出会红的检查）

1. **基准策略校验漏改** — 只改 `policy.json` 不加函数：改标签的 PR 在 `resolvePolicySource` 里触发 check-policy.mjs:209 的 `Incorrect platform` 失败。反向用例：`policy.test.mjs` 加“base 上的 runner 是 `something-else` 时必须照样 toThrow”。
2. **upgrade 的形识不严** — 形识函数若不检查超时/`paused` 全局形状，会把任意被打补丁的基准也升级掉。反向用例：基准上有一个成员超时改 45 → 必须被拒（对照 ci-optimization.test.mjs:119-120 已有 45 超时的形识惯例）。
3. **注册时把第二个 runner 的 `--replace` 打到第一个**（ADR 0171 d7 原教训“注册脚本必须写明注册第几个”）：脚本层照抄按序号分支，测试里已有同形 fixture（hermes-runner-scripts.test.mjs:676-677 的表格可推）。
4. **brands 在新机器上浏览器找不到或系统库缺失**：删除 `--with-deps` 后，只能靠 PR-2 的 brands 试跑暴露；装机时预跑一次 `playwright` 的 launch smoke（channel chrome/msedge 各起一次并退出 0）再进入切换。
5. **沙箱测试因缺 bwrap 静默跳过**（I-57 型）：装机第 1 步的 bwrap 冒烟就是防它。全量运行后核对“跳过数”，和 Hermes 基线的跳过数对比（这是新数据，首跑必录）。
6. **内存初值失准**：`memory.events` 的 oomkill>0 即回到调参而不是放宽超时（ADR 0170→0173 的路线）。
7. **GitHub 以后对 self-hosted 计费**（ADR 0160 既录风险）：触发点到来先报费用再动作，不内置在本方案里。

## 五、需要人拍板的取舍

1. **新标签具体叫什么**（候选 `vps-x64` / `ovh-vps-x64` / `vps-482b8c36`）：建议用角色+平台、不含供应商或 hostname，换机器/换供应商时不再改名。
2. **gh-quality 账号加 docker 组的豁免**是否按上面三条理由批准；不同意则 quality.yml 继续停用，代价是这 7 项检查无人跑。
3. **playwright 品牌浏览器由管理员一次性 apt 安装**（code 拉取来源是 Google/微软的 .deb 仓库）；不批则 brands 无法在无 sudo 前提下运行。
4. **第二个 PR 的合并时点**：quality 是否等 ci/main 试跑一周后才合并启用（本方案默认是这样）。
5. **试跑时长与 ruleset 是否改为要求 `ci/required`**（甲方 0160 d8 惯例：试跑结果出来后由 Andy 决定）。
6. **Hermes 最终注销的时机**：确认稳定前 Hermes 保持完整可回退，代价是多承担一段 Hermes 维持成本。

## 六、已证实 vs 推测

**读代码或来源证实的**：前提 1-10 及“不选用例 3”中 Playwright 的行为引用；各文件行号均可复核。
**推测（未核实，靠先例/文档推断，需实测确认）**：
- “沙箱测试在缺 bwrap 时跳过” 的完整清单与机制细节——只有 I-57 一条实锤记录，跳过面可能更大也可能更小（首跑必须核对跳过数）。
- 24.04 发行版 bubblewrap 的具体版本与 SRT 需求的匹配情况（需装机时抄 `bwrap --version` 进验收记录）。
- VPS 上各 job 的时长与内存初值（试跑数据）。
- Playwright 在 channel 模式下发现系统 Chrome/Edge 的具体路径细节（文档支持、未实测）。

## 七、逐条必答问题

1. **是否改变模型已见过的请求开头**：不。本次改动全在 `.github/`、`ci/`、`scripts/ci/`、`scripts/operations/` 和文档，这些文件不参与任何发给模型的内容（系统提示、工具定义、历史消息、遮盖结果都在 agent 包的运行时里，与本 PR 无交集）。“只追加”规则在这里没有追加点：改动值（新标签）是静态常量，每轮可变的值（run_id、artifact 名称、时间）本来就是每条请求/运行的内容且全落在后端运行时，不在开场序列。结论：不改变。
2. **同一段文字是否在不同请求里变成不同字节**：不。新标签是固定 ASCII 常量；升级函数是 `structuredClone` 加确定的形状判定（同输入同输出）；quality 的镜像按 digest 固定（quality.yml:240-241）；没有引入时间字段、状态相关遮盖或无序集合。唯一带上环境差异的是“哪个 runner 跑哪一任务”，它是调度结果而不是序列化内容。
3. **有对应的自动检查吗，反向用例会真失败吗**：有，分四层。(a) `upgradeHermesRunnerPolicy` 需要正反用例：正向 base 恰为 Hermes 形状→被升级；反向 runner 为他值、或仅超时/`paused` 漂移形状→照样抛错（模板即 policy.test.mjs:697-709 的“别的值照样被拒”）；(b) schema enum 与 actionlint 标签静态兜底（policy.schema.json:64、actionlint.yaml:3）；(c) 脚本测试把 hostname 门反向用例保留（“only runs on …”必须仍在错误主机上失败）；(d) quality 的 `validateQualityWorkflow` 深比较 keep 了步骤漂移拦截。检查在 PR-1 自己的 CI 上首次真实执行，等于一次线上反例验证。
4. **每个产生/使用值的两端核对**：
   - **新标签**：produced by policy.json 的全部 11 个成员、ci.yml 13 处、main.yml:18,69、register 脚本 `--labels`、quality-policy.mjs:119,170（quality 侧若同窗迁移）；consumed by GitHub 调度、actionlint、schema enum、check-policy.mjs:62/70/209、main-workflow.mjs:48、两个测试文件。改名的 PR 本身就是“每次接入点都要过”的核对——而 PR-1 由 VPS runner 执行即实证了调度端。
   - **升级链顺序**：produced at check-policy.mjs:993（函数复合点），consumed by validatePolicy/validateWorkflow 和 baseline policy 的 viligance（提案内 `validatePolicy(proposed)` 另行调用于 1140 行——注意 1140 行用的是当前 policy 而非升级产物，故升级链只需作用于基准侧）。
   - **docker 组（gh-quality）**：produced by 装机 groupmems + systemd 单元；consumed by `/var/run/docker.sock`（quality.yml:248）。校验端是 PR-2 的 container 试跑：pull 两个 digest 镜像 + build runner-image 各一次成功，就是“后端校验”通过的证据——这正是 I-73“清单里的 id 能否通过后端校验”式的两端核对。
   - **bwrap/profile**：produced by apt 与 `apparmor_parser`；consumed by SRT 的 launch 路径（job-host-main.ts:7,188）。校验端：runbook 冒烟命令 exit 0 + 首跑的跳过数比对。
   - **VPS runner 名/标签、rdisk 底线、内存初值**：produced by 新 install 脚本；consumed by GitHub UI 与试跑报告；init 数值全部先当推测，试跑比对后落 ADR。
