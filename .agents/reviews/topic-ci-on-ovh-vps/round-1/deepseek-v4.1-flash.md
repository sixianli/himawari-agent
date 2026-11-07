以下行号以 `058293d` 为准。先给结论：**建议把 runner 标签改成新的 `ovh-ci`，先搬 `ci.yml` 和 `main.yml`，`quality.yml` 不在同一次搬；VPS 先装 1 个 runner，验收通过后再加第 2 个；Hermes 的 runner 保留到观察期结束再注销。**

## 一、方案依赖的前提

### 已核实（读代码或一手来源）

**P1. 自托管 runner 不计 GitHub Actions 分钟费，但 artifact 存储仍可能计费。**
来源：GitHub Actions billing 文档，https://docs.github.com/en/billing/concepts/product-billing/github-actions
原话：
> The following usage remains free independently and does not reduce the included compute usage: ... **Self-hosted runners.**

同文还写明 artifact 存储按 GB-Hours 计费：
> Storage charges accumulate throughout the month based on hourly usage.

项目侧 ADR 0174 已把 artifact 保存期改成 1 天，见 `docs/adr/0174-no-github-cache-and-one-day-artifacts.md:63-67`。

**P2. GitHub 只把任务派给 `runs-on` 标签和 runner group 都匹配的在线空闲 runner；60 秒不接收会重排，排队超过 24 小时失败。**
来源：GitHub Self-hosted runners reference，https://docs.github.com/en/actions/reference/runners/self-hosted-runners
原话：
> GitHub looks for a runner that matches the job's `runs-on` labels and groups.
> If the runner doesn't pick up the assigned job within 60 seconds, the job is re-queued so that a new runner can accept it.
> If the job remains queued for more than 24 hours, the job will fail.

**P3. 当前标签 `hermes-home` 被写死在多个产生处和校验处。**
- `ci/policy.json:13,29,45,68,92,108,118,125,141,157,183`：各 Linux 成员 `"runner": "hermes-home"`；文件共 13 个成员，其中 11 个未暂停。
- `ci/policy.schema.json:63-64`：`"runner": { "enum": ["hermes-home", "macos-15"] }`
- `scripts/ci/check-policy.mjs:209`：`member.runner === (mac ? "macos-15" : "hermes-home")`
- `scripts/ci/main-workflow.mjs:48`：`job["runs-on"] === "hermes-home" && ...`
- `.github/actionlint.yaml:3`：`- hermes-home`
- `.github/workflows/ci.yml`：各 `runs-on` 和矩阵 `runner`；`main.yml:18,69` 两处。
- `scripts/operations/hermes-runner/register-runner.sh:29`：`--labels hermes-home`
- `scripts/operations/hermes-runner/mac-runners.sh:2`：`LABEL=hermes-home`

**P4. `ci/required` 用目标分支上的策略校验，策略迁移必须提供一次性升级。**
`scripts/ci/check-policy.mjs:965-998` 的 `resolvePolicySource` 从基准提交读策略，再交给 `validatePolicy`；`check-policy.mjs:1140-1151` 先用基准策略校验当前 `ci.yml`，再用当前策略校验。
ADR 0160 原话（`docs/adr/0160-self-hosted-runner-on-hermes.md:69`）：
> `ci/required` 用的是目标分支上那份 `ci/policy.json`，不是 PR 里的，所以改策略的 PR 会被旧策略判失败。

ADR 0174 原话（`docs/adr/0174-no-github-cache-and-one-day-artifacts.md:67`）：
> `upgradeArtifactRetention` 只把恰好是“报告 30 天、诊断 7 天”的旧写法升级成 1 天，别的值照样拒绝；做法和已有的 `upgradeHostedRunnerPolicy` 一样。

**P5. 主 runner 账号按 ADR 0160 不给 sudo、不进 docker 组，并有 systemd/nft 隔离。**
ADR 0160 原话（`docs/adr/0160-self-hosted-runner-on-hermes.md:67`）：
> runner 以专用系统用户 `gh-runner` 运行，不在 sudo 组或 docker 组里，看不到 `/data` 和 `/home`，防火墙规则禁止它访问局域网、Tailscale 地址和本机已有服务的端口。

Runbook 原话（`docs/runbooks/hermes-self-hosted-runner-runbook.md:59`）：
> 每个 runner 一个系统用户（`gh-runner`、`gh-runner-2`），不能登录，只属于自己的组，不在 sudo 组或 docker 组里。

同 Runbook `:90`：
> **Docker**：runner 用户不得加入 docker 组。哪个 workflow 真要 Docker，先向 Andy 说明风险和替代方案，由 Andy 决定。

systemd 加固见 `scripts/operations/hermes-runner/gh-runner.service.in:27-36`；防火墙见 `scripts/operations/hermes-runner/runners.sh:47-60`。

**P6. `quality.yml` 现在需要 Docker、sudo/apt 和品牌浏览器，所以一直留在 GitHub 托管机。**
`quality.yml:123`：
> `.ci-output/tools/bin/node node_modules/playwright/cli.js install --with-deps chrome msedge`

`quality.yml:239-249` 会 `docker pull` 两个固定摘要镜像、`docker build packages/runtime-sandbox/runner-image`，并显式使用 `/usr/bin/docker` 和 `unix:///var/run/docker.sock`。
`scripts/ci/quality-policy.mjs:22-25` 写死：
> `HIMAWARI_CONTAINER_DOCKER_CLI: "/usr/bin/docker"`
> `HIMAWARI_CONTAINER_DOCKER_HOST: "unix:///var/run/docker.sock"`

ADR 0160 原话（`:70`）：
> `quality.yml` 只能手动触发，其中的 `container` 任务要用 Docker，而 runner 用户按要求不能用 Docker，所以 `quality.yml` 继续用 GitHub 托管的 `ubuntu-24.04`；手动触发它会花托管分钟数。

**P7. Playwright 的系统依赖和品牌浏览器是主机级安装，`--with-deps` 会走 apt/root。**
来源：Playwright Browsers 文档，https://playwright.dev/docs/browsers
原话：
> System dependencies can get installed automatically. This is useful in CI environments.
> `npx playwright install --with-deps chromium`
> If Google Chrome or Microsoft Edge is not available on your machine, you can install them using the Playwright command line tool: `npx playwright install msedge`
> Google Chrome or Microsoft Edge installations will be installed at the default global location of your operating system overriding your current browser installation.

**P8. Ubuntu 24.04 默认限制非特权用户命名空间；bwrap 需要按程序配置 AppArmor；VPS 的 bwrap 版本也与 Hermes 不同。**
Ubuntu 24.04 release notes 原话（https://documentation.ubuntu.com/release-notes/24.04/）：
> In combination with the `apparmor` package, the Ubuntu kernel now restricts the use of unprivileged user namespaces.

同文给出的 profile 写法包含：
> `userns,`

项目 Runbook 原话（`docs/runbooks/install-start-stop-runbook.md:597`）：
> 不得关闭全局 `kernel.apparmor_restrict_unprivileged_userns` 开关，不得使用 `--privileged`，也不得以 root 运行产品来绕过失败。

`docs/runbooks/install-start-stop-runbook.md:488-597` 给出了 `/etc/apparmor.d/bwrap` 的完整内容和验证命令。
`.agents/instructions/test-and-production-hosts.md:18` 写明 Hermes 是 Ubuntu 22.04、bwrap 0.6.1，生产是 Ubuntu 24.04 且带 AppArmor 限制。ADR 0156 也写明 Hermes 的 bwrap 是 0.6.1（`docs/adr/0156-srt-0-0-81-with-a-locked-seccomp-helper.md:28`）。

**P9. CI 安装依赖时会用 node-gyp 编译 better-sqlite3，所以 VPS 必须有 gcc/make/g++。**
`scripts/ci/install-dependencies.mjs:357-366`：
> `[nodeGyp, "rebuild", "--release", ...]`

`ci/toolchain-lock.json:1166`：
> `"install": "prebuild-install || node-gyp rebuild --release"`

本次材料给出的 VPS 现状是“没有 gcc/make/unzip”。这不是可选优化，而是 `build`、`test`、`static` 等任务能否通过 `install-dependencies.mjs` 的硬前提。

**P10. `check:srt-boundary` 不在 `npm run check` 里，所以第一次全量 CI 不一定会跑到真实 bwrap。**
ADR 0156 原话（`docs/adr/0156-srt-0-0-81-with-a-locked-seccomp-helper.md:43`）：
> 不放进 `npm run check`，因为云端容器默认没有 bubblewrap 和 socat。

`package.json:27` 的 `check:steps` 没有 `check:srt-boundary`；只有 `package.json:37` 单独定义了它。

**P11. 合并前的本地检查目前只允许 Hermes 或云服务器，不在 Mac 上跑。**
`.agents/instructions/delivery-mode.md:21` 原话：
> 按 [测试主机与生产主机](test-and-production-hosts.md) 的规定，在云服务器上以 `himawari-ci` 身份或在 Hermes 上运行它们；绝不在 MacBook 上运行。

`.agents/instructions/test-and-production-hosts.md:8-9` 也写明第 0-4 层在 Hermes 或云服务器 `84.247.157.41` 上跑。材料又要求“VPS 不能用来跑与 CI 无关的东西”。所以 Hermes 注销后，本地预合并检查在哪里跑是一个需要拍板的流程缺口，不能假装它自动消失。

### 推测/待实测

- VPS 上 `kernel.apparmor_restrict_unprivileged_userns` 的实际值、`/usr/bin/bwrap` 是否存在及版本，材料没有给出；必须在机器上只读核对。
- Playwright 是否能在“管理员预装 Chrome/Edge 和系统依赖”后，由无 sudo 账号直接使用品牌浏览器；官方文档只说会装到系统全局位置，没有明确保证预装后的免 root 行为。需要在 VPS 上实测。
- 根因是否会让某些“假沙箱”测试在 24.04 上表现不同；很多集成测试使用模拟后端，不真正启动 bwrap。第一次全量运行前应把 `check:srt-boundary` 作为单独验收项，而不是假设 CI 已覆盖。
- 两个 runner 同时跑时，`test-concurrency.mjs` 用的是 `totalmem()` 而不是 cgroup 上限（`scripts/ci/test-concurrency.mjs:9-28`），可能按整机 22 GB 计算 worker，存在内存过订阅风险。

## 二、方案本身

### 1. 标签：改名为 `ovh-ci`，不要沿用 `hermes-home`

建议：
- 标签：`ovh-ci`
- runner 名：`ovh-ci-1`、`ovh-ci-2`
- 主 CI runner 路径仍用 `/srv/gh-runner`、`/srv/gh-runner-2`
- 专用 quality runner（如果以后搬）用标签 `ovh-quality`

理由：
- 新旧 runner 可以同时在线但互不抢任务。旧 Hermes 带 `hermes-home`，新 VPS 带 `ovh-ci`，切换期间不会出现“任务随机落到旧机器”的混合池。
- 标签表达的是“这台新的 CI 机器”，不是历史主机名。继续叫 `hermes-home` 会让暂停脚本、Runbook、排错日志和后来的人都误以为任务还在 Hermes。
- 回退时只需保留旧 Hermes 和旧标签，不需要重新注册。

代价是策略、workflow、schema、actionlint、测试、安装脚本都要同步改，且必须处理基准策略升级。下面的升级函数就是为此设计的。

#### 基准策略怎么过校验

在 `scripts/ci/check-policy.mjs` 增加与 `upgradeHostedRunnerPolicy` 同风格的一次性升级函数：

```js
export function upgradeHermesRunnerPolicy(policy) {
  const checks = policy?.checks ?? [];
  const members = checks.flatMap((check) => check.members ?? []);
  const exact =
    members.length > 0 &&
    checks.every((check) => check.timeoutMinutes === timeoutMinutesFor(check.id)) &&
    members.every((member) =>
      member.key === "macos-arm64"
        ? member.runner === "macos-15" && member.paused === true
        : member.runner === "hermes-home" && member.paused === undefined,
    );
  if (!exact) return policy;
  const upgraded = structuredClone(policy);
  for (const check of upgraded.checks)
    for (const member of check.members)
      if (member.key !== "macos-arm64") member.runner = "ovh-ci";
  return upgraded;
}
```

然后把 `resolvePolicySource` 的升级链改成：

```js
upgradeArtifactRetention(
  upgradeHermesRunnerPolicy(
    upgradeHostedRunnerPolicy(JSON.parse(bytes))
  )
)
```

同时把 `upgradeHostedRunnerPolicy` 的目标标签从 `hermes-home` 改成 `ovh-ci`，这样“托管机器 → 新 VPS”的历史迁移也直接落到最终标签。

关键点：
- 只有**完整、精确的旧 `hermes-home` 写法**才升级：超时值正确、所有非 mac 成员都是 `hermes-home` 且未暂停、mac 成员是 `macos-15` 且已暂停。混合写法一律不升级，继续被 `validatePolicy` 拒绝。
- `validatePolicy` 的 `:209` 改成只接受 `ovh-ci`（mac 仍 `macos-15`）。
- `ci/policy.schema.json` 的 enum 改成 `["ovh-ci", "macos-15"]`。这样任何漏改的 `hermes-home` 会在 schema 层直接失败。
- 这个 PR 自己的 CI 会跑在已经注册为 `ovh-ci` 的新 runner 上；基准策略是旧的 `hermes-home`，经升级后与新 workflow 一致。

#### 仓库改动清单

| 文件 | 改什么 |
| --- | --- |
| `ci/policy.json` | 11 个未暂停 Linux 成员的 `runner` 改为 `ovh-ci`；两个 macOS 成员保持 `macos-15` + `paused: true` |
| `ci/policy.schema.json:63-64` | enum 改为 `["ovh-ci", "macos-15"]` |
| `scripts/ci/check-policy.mjs` | `:62,:70` 目标标签；新增 `upgradeHermesRunnerPolicy`；`:209` 校验新标签；`:993` 串联升级 |
| `scripts/ci/main-workflow.mjs:48` | 期望 `runs-on` 改为 `ovh-ci` |
| `.github/workflows/ci.yml` | 所有 `runs-on` 和矩阵 `runner` 改为 `ovh-ci`（包括 build/test/browser 的 include） |
| `.github/workflows/main.yml:18,69` | 改为 `ovh-ci` |
| `.github/actionlint.yaml:3` | 改为 `ovh-ci`；不要同时保留 `hermes-home`，否则 actionlint 不会帮你抓漏改 |
| `scripts/operations/vps-runner/` | 新增 VPS 安装、注册、卸载、暂停、清理脚本；建议基于 Hermes 脚本复制后改常量，避免迁移期间改坏旧脚本 |
| `test/tooling/policy.test.mjs` | 更新旧标签 fixture；新增 `upgradeHermesRunnerPolicy` 正反用例；`validateMainWorkflow` 旧标签必须失败 |
| `test/tooling/ci-optimization.test.mjs:119-120` | 字符串替换改为新标签；增加“三个 workflow 不得再出现 `hermes-home`”的反向断言 |
| `test/tooling/hermes-runner-scripts.test.mjs` | 保留到 Hermes 注销；新增 `test/tooling/vps-runner-scripts.test.mjs` 覆盖新脚本 |
| `docs/adr/` | 新增 ADR（例如 0176）“CI 改到 OVH VPS”，修订 0160 决定 1/2/4/5/7、0168、0169、0171、0173、0174 中受影响的表述 |
| `docs/runbooks/` | 新增 VPS runner Runbook；旧 Hermes Runbook 标记 superseded；更新 `delivery-mode.md:27`、`test-trigger-timing.md:17`、`test-and-production-hosts.md:9` |
| `scripts/operations/hermes-runner/` | 迁移期间保留，用于回退和注销；观察期后再删或归档 |

注意项目约束“不写代码注释；改了的文件里已有的注释要删掉”。`scripts/ci/check-policy.mjs` 现有注释在 `:196,:317,:481` 附近，`quality.yml:1` 也有注释；如果改到这些文件，要一并清掉。

### 2. VPS 上怎么装

#### 2.1 系统依赖（root/管理员一次装好）

必须安装：
- `build-essential`（gcc、g++、make）：`install-dependencies.mjs` 会编译 `better-sqlite3`。
- `tar`、`gzip`、`xz-utils`、`unzip`：工具和浏览器归档解压。
- Playwright 系统依赖：在 VPS 上以 root 运行 `npx playwright install-deps`，或按 Playwright 文档安装对应发行版的库。
- `bubblewrap`、`socat`、`ripgrep`、`bash`：与 Hermes 的沙箱/检查环境对齐。Ubuntu 24.04 的 `/usr/bin/bwrap` 是 0.9.x，和 Hermes 的 0.6.1 不同，这是**预期差异**，要记录。
- Docker：**只给未来的 quality runner 装，不给主 runner 装**。

验收：
```sh
gcc --version
make --version
/usr/bin/bwrap --version
sysctl kernel.apparmor_restrict_unprivileged_userns
```

#### 2.2 AppArmor（Ubuntu 24.04 必做）

按 `docs/runbooks/install-start-stop-runbook.md:488-597`：

1. 只读确认开关值，不要关闭全局开关。
2. 为实际使用的 `/usr/bin/bwrap` 创建 `/etc/apparmor.d/bwrap`，内容用 Runbook 里的原文，核心是：
   ```
   abi <abi/4.0>,
   include <tunables/global>

   profile bwrap /usr/bin/bwrap flags=(unconfined) {
     userns,
     include if exists <local/bwrap>
   }
   ```
3. `apparmor_parser -r /etc/apparmor.d/bwrap`
4. 以最终的 `gh-runner` 账号验证：
   ```sh
   sudo -u gh-runner -- /usr/bin/bwrap --unshare-all --unshare-net --ro-bind / / --dev /dev --proc /proc /usr/bin/true
   ```
   必须退出 0。
5. 不要用 `echo 0 > /proc/sys/kernel/apparmor_restrict_unprivileged_userns` 绕过；这违反 Runbook，也降低整机安全性。

如果以后使用 0.11.2 的 program/stdio 后端，再按 Runbook 为 `/usr/local/libexec/bubblewrap-0.11.2/bwrap` 建独立 profile。主 CI 先不需要。

#### 2.3 主 runner

建议第一阶段只装 1 个：
- 系统用户 `gh-runner`，不能登录，只属于自己组，不在 sudo/docker 组。
- `/srv/gh-runner/{runner,home,logs,hooks}`。
- 服务 `gh-runner.service`，模板沿用 `gh-runner.service.in` 的加固项，但把 `InaccessiblePaths` 改为 VPS 上的 `/home`、`/root`、`/var/run/docker.sock`、`/run/docker.sock`。
- 资源：第一阶段一个 runner 可给 `MemoryHigh=15G`、`MemoryMax=18G`、`MemorySwapMax=0`，留约 4 GB 给系统和 SSH。第二阶段加第二个 runner 时，改成每个 `MemoryHigh=7G`、`MemoryMax=8G`，共用 slice `MemoryHigh=15G`、`MemoryMax=17G`，两个一起不超过 17 GB。
- nft 规则沿用 `runners.sh:47-60`：只对 runner uid 生效，拒绝私有地址、链路本地、本机监听端口（DNS 53 除外）。VPS 的 ufw 只管入站，runner 出站隔离仍由 nft 负责。
- 窄 sudo：把 `runner_sudoers_line` 里的 `andy` 改成 VPS 管理员 `ubuntu`，只允许 `systemctl start|stop|restart gh-runner.service`。
- 磁盘地板：保留 16 GiB；200 GB 盘空间充足，但任务结束仍要删 `_work`，每日清理旧目录。

runner 版本先固定 2.338.2（与现有脚本一致），下载后校验 SHA-256。GitHub runner 会自动更新；升级窗口和 GitHub 要求要监控。

注册：
```sh
gh api -X POST repos/sixianli/himawari-agent/actions/runners/registration-token --jq .token \
  | ssh vps 'sudo -n bash register-runner.sh 1'
```
令牌只走 stdin，不进命令行、不进文件、不进日志。注册名 `ovh-ci-1`，标签 `ovh-ci`。成功后用 `gh api repos/.../actions/runners` 确认 `online`、`busy=false`、标签包含 `self-hosted,Linux,X64,ovh-ci`。

#### 2.4 quality 怎么搬

**不建议和 `ci.yml`、`main.yml` 同一次搬。** 原因是权限边界不同，不是代码量问题。

推荐分两步：

**第一步（现在）**：只搬 `ci.yml` 和 `main.yml`；`quality.yml` 保持停用。停用状态下不产生托管分钟费，符合“GitHub 不再扣钱”。但必须明确记录：质量检查暂时不跑。

**第二步（quality 专项）**：在 VPS 上增加一个**独立的** quality runner：
- 账号 `gh-quality`，标签 `ovh-quality`，单独 systemd 服务。
- 只给 `docker` 组，不给 sudo。
- 系统级预装 Chrome、Edge 和 Playwright 依赖（root 在装机时做），然后把 `quality.yml:123` 和 `quality-policy.mjs:132` 的 `--with-deps` 去掉；workflow 不再需要 apt/root。
- `container` 任务继续用系统 `/usr/bin/docker` 和 `/var/run/docker.sock`，所以 `quality-policy.mjs:22-25` 的硬编码可以保留。
- 给 `ci/quality-policy.json` 增加 `"runner": "ovh-quality"`，`quality-policy.mjs` 的 AJV schema 和 `expectedJobs` 改用这个字段；`quality.yml` 的 7 个 job 的 `runs-on` 同步改。这样 `policy` 检查会同时核对策略值和 workflow 值。
- 这需要 Andy 明确同意：`gh-quality` 进 docker 组，等于把 Docker 控制权交给这个账号；但它只跑手动触发的 quality，不与主 CI runner 共用账号。主 runner 仍然无 sudo、无 docker。

不选的替代：
- 让主 runner 进 docker 组并给 sudo：直接违反 ADR 0160，且把合并闸门和 root 等价权限绑在一起，不能做。
- 根less Docker：理论上可以不给 docker 组，但需要 `newuidmap/newgidmap`、subuid/subgid、用户命名空间和 AppArmor 配合，还要把 `quality-policy.mjs` 和 `quality.yml` 里写死的 `/var/run/docker.sock` 改掉；对一个手动任务来说复杂度和不确定性都偏高，不作为首选。
- 继续留在 `ubuntu-24.04`：会继续花托管分钟费，违背目标。

### 3. 切换顺序

**0. 记录与备份**
- 记录当前 Hermes runner 的 `gh api` 列表、标签、服务状态、`ci/policy.json` 的 blob SHA。
- 确认三个 workflow 仍是停用状态。
- 把 Hermes 的 `/var/backups/gh-runner/` 和现有 Runbook 作为回退依据。

**1. VPS 装机（root）**
- 装系统依赖、bwrap、AppArmor profile、Playwright 依赖、Chrome/Edge（quality 以后用）。
- 创建 `gh-runner`，安装 runner，但先不注册。
- 风险：装错系统包或改全局 AppArmor 开关。所有 root 操作按脚本执行并保存证据。

**2. 注册 1 个新 runner 并做烟测**
- 注册 `ovh-ci-1`，标签 `ovh-ci`。
- 用临时 `workflow_dispatch`（不合并）或一个只跑 `runs-on: ovh-ci` 的临时 job 验证：`id`、`uname -a`、`node --version`、`df -h /`、`sudo -n true` 必须失败、`ls /home/ubuntu` 必须失败、`docker` 必须不可用或不可访问 socket、访问 GitHub 必须成功。
- 风险：未注册成功或标签写错，任务会一直排队；用 `gh api` 看 `online` 和 `busy` 再往下。

**3. 开迁移 PR（此时 Actions 仍停用，PR 的 CI 需要手动/规则集允许？）**
这里有一个现实约束：`ci.yml` 是手动停用的。验收 PR 要跑 CI，必须先重新启用 Actions。建议在 VPS runner 已在线、烟测通过后，再打开 Actions 总开关，然后推验收 PR。打开前向 Andy 确认一次，沿用 ADR 0160 决定 7 的做法。
- PR 内容：标签改名、策略升级函数、workflow、actionlint、测试、ADR/Runbook。
- 期望：`policy`、`static`、`build`、`test`、`node-floor`、`browser`、`coverage`、`security`、`required` 全部在 `ovh-ci` 上通过。
- 风险：基准策略仍是 `hermes-home`，如果升级函数条件写错，`policy` 会失败；这是有意的 fail-closed。

**4. 合并并在 main 上确认**
- 合并后第一次 `main.yml` 会用 `ovh-ci` 跑 `plan`，必要时回退到完整 `ci.yml`。
- 观察 `main/confirmation`、`ci/required`、artifact 上传、磁盘清理。
- 风险：`main.yml` 只在 push 时触发，第一次真实运行就是验收；不要在这之前注销 Hermes。

**5. 观察期与扩容**
- 连续观察 1-2 周：任务时长、排队时间、内存 OOM、磁盘、超时、runner 自动更新。
- 稳定后再注册 `ovh-ci-2`，把资源模板改成两个 8 GB 的配置。
- 风险：两个 runner 同时跑时测试 worker 数按整机内存算，可能过订阅；看 `memory.events` 和 OOM。

**6. quality 决策**
- 如果 Andy 同意专用 quality runner：按上面的 `ovh-quality` 方案搬，先手动跑 `scale`、`thread-scale`、`dependencies`、`node-observation`，再跑 `brands`、`container`。
- 如果不同意：`quality.yml` 保持停用，并在 ADR 里写明原因和未覆盖范围。不要偷偷把它留在 `ubuntu-24.04` 再打开。

**7. 注销 Hermes**
- 在新 runner 通过验收且观察期结束后。
- 先在 Mac 上用旧 `pause-runners.sh` 去掉 `hermes-home` 标签，等 `busy=false`，再在 Hermes 上 `uninstall-runner.sh all`。
- 用 `gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/<id>` 删除 `hermes-home`、`hermes-home-2`。GitHub REST 文档写明该接口用于“Forces the removal of a self-hosted runner ... when the machine you were using no longer exists.”（https://docs.github.com/en/rest/actions/self-hosted-runners）
- 验证：`id gh-runner`/`id gh-runner-2` 不存在，`/srv/gh-runner*` 不存在，`nft list tables` 没有 `gh_runner`，GitHub runner 列表为空。
- 最后再做清理 PR：删除 `scripts/operations/hermes-runner/` 和对应测试，或标记归档；更新所有文档。

### 4. 验收清单

必须逐项记录：

1. `gh api repos/sixianli/himawari-agent/actions/runners`：`ovh-ci-1` 为 `online`、`busy=false`，标签有 `ovh-ci`。
2. 烟测 job：`id` 显示普通用户；`sudo -n true` 失败；`/home/ubuntu` 不可读；`/var/run/docker.sock` 不可访问；`nft` 规则生效；访问 `https://api.github.com` 成功。
3. 完整 `ci.yml`：9 个 job、11 个未暂停成员全部通过；`ci/required` 通过；没有 job 落到 `hermes-home`。
4. `main.yml`：`plan` 选择正确；`full` 或 `confirm` 在 `ovh-ci` 上通过。
5. 磁盘：每个任务开始/结束的 `disk.log`；结束后 `_work` 被清理；根盘剩余空间正常。
6. 内存：`systemctl show gh-runner.service -p MemoryCurrent`、`memory.events` 的 `oom_kill` 为 0。
7. 真实沙箱：以 `gh-runner` 身份运行 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs`；记录 bwrap 版本、AppArmor 开关值、结果。与 Hermes 的结果分开记录，不直接说“相同”。
8. `quality.yml`：如果搬了，7 个 job 全部手动跑通；如果没搬，明确记录“未运行”。
9. GitHub 计费：确认没有 `ubuntu-24.04`/`macos-15` 的 job 被触发；artifact 仍为 1 天；缓存仍为 0。

### 5. 回退

**合并前**
- 删除 `ovh-ci-1` 的 GitHub runner，停掉 VPS 服务即可。
- 旧 Hermes runner 仍在线，旧 workflow 仍可恢复；仓库没有不可逆变化。

**合并后、Hermes 注销前**
- `git revert` 迁移提交，恢复 `hermes-home` 标签和旧策略；重新启用旧 workflow；暂停/删除 VPS runner。
- 因为 Hermes runner 没有注销，这是分钟级回退，不需要重装。
- 注意：回退提交本身也要过策略校验；如果 schema 已移除 `hermes-home`，revert 必须把 schema/validator 一起恢复，不能只改 workflow。

**Hermes 注销后**
- 只能重新安装 Hermes runner 或把 VPS 临时改成旧标签；成本高。因此观察期结束前不要注销 Hermes。

**quality 回退**
- 如果 quality 专用 runner 出问题，停用 `quality.yml`；不要回退到托管 `ubuntu-24.04`，否则重新产生费用。

### 6. 考虑过但不选的做法

| 做法 | 不选原因 |
| --- | --- |
| 沿用 `hermes-home` | 新旧 runner 会进同一个池，无法安全并行验收；标签和实际主机不符，排错和文档长期误导。仍需改安装脚本，省下的只有策略改动。 |
| 改名但只改 workflow，不改基准策略升级 | PR 自己的 `policy` 会用旧 `hermes-home` 基准校验新 `ovh-ci` workflow，直接失败。 |
| 改名后保留 `hermes-home` 在 schema/actionlint 里 | 漏改的 workflow 仍会被接受，可能把任务派给旧 Hermes；失去机械门槛。 |
| 把 quality 和 ci/main 同一次搬，主 runner 进 docker 组 + sudo | 违反 ADR 0160；Docker 组等价 root，合并闸门和特权操作绑在一起，攻击面过大。 |
| 主 runner 用 rootless Docker 跑 container | 需要 userns/subuid/newuidmap 和 AppArmor 配合，还要改死写的 socket/CLI；手动 quality 不值得承担这个复杂度。 |
| 继续把 quality 留在 `ubuntu-24.04` | 会继续花托管分钟费，违背“不再扣钱”。只能保持停用，等专用 runner。 |
| 一次性 runner | 要在 runner 机器上长期放仓库管理权限的 token，ADR 0171 已因此放弃；当前也没有 autoscaling 基础设施。 |
| 一开始就装 4 个 runner 吃满 8 核 | 测试并发按整机内存算，容易过订阅；先用 1 个验收，再按实测扩到 2 个更稳。 |
| 关闭全局 AppArmor 开关或 root 跑沙箱 | 违反 Runbook 和项目安全规则，不能为了 CI 通过降低隔离。 |

### 7. 风险与反例

- **漏改一处标签**：`ci.yml` 某个 job 仍是 `hermes-home`，该 job 会一直排队直到 24 小时失败；`main.yml` 漏改则 main 确认永远不跑。对策：schema enum、`validatePolicy:209`、`main-workflow.mjs:48`、actionlint、测试五道一起改，并加“全仓库不得再出现 `hermes-home`”的反向测试。
- **升级函数条件过宽**：把混合策略也升级，导致本该失败的 PR 通过。反例：一个成员已经是 `ovh-ci`、其余仍是 `hermes-home`，必须不升级并让 `validatePolicy` 抛错。
- **升级函数条件过窄**：基准策略恰好多了一个 `paused` 或时间不同，导致新 PR 无法通过。反例：macOS 成员未暂停、或 `required` timeout 不是 15，必须不升级。
- **VPS 缺 gcc/make**：`install-dependencies.mjs` 在 `better-sqlite3` 的 `node-gyp rebuild` 处失败，`build`、`test`、`static` 全部红。必须在装机时验证，不要等第一次 CI。
- **VPS 缺 Playwright 系统库**：`static` 的 `playwright install --only-shell chromium` 或 `browser` 的引擎启动失败。`ci.yml` 明确不带 `--with-deps`，所以系统库必须预装。
- **AppArmor 未配置**：真实 bwrap 启动报 `setting up uid map: Permission denied`。第一次全量 CI 可能不跑 `check:srt-boundary`，所以不能只靠 CI 发现；验收必须单独跑。
- **bwrap 版本不同**：VPS 是 0.9.x，Hermes 是 0.6.1。即使 AppArmor 配好，沙箱边界测试的观察值也可能不同；不要把 Hermes 的历史结果当成 VPS 的通过标准。
- **单台 VPS 故障**：OVH 重启、网络中断、磁盘故障都会让 CI 停摆。Hermes 保留到观察期结束是最低成本的缓解；之后要接受单点，或保留一台冷备。
- **artifact 仍可能计费**：自托管 runner 免费不等于 artifact 免费。保留 1 天并监控私有仓库 500 MB 额度；如果报告太大，考虑只上传必要文件或把完整报告放 VPS。
- **本地预合并检查断档**：Hermes 注销后，`npm run check` 不能再在 Hermes 上跑，Mac 又被禁止，VPS 又不该跑无关任务。这是一个流程缺口，必须在注销 Hermes 前拍板。

### 8. 需要人拍板的取舍

1. **标签名**：`ovh-ci` 还是更中性的 `ci-linux` / `ci-vps`。我建议 `ovh-ci`，迁移期间最不容易看错。
2. **quality**：保持停用，还是批准一个只进 docker 组、不给 sudo 的专用 `gh-quality` runner。后者需要修改 ADR 0160 的隔离边界。
3. **本地预合并检查**：Hermes 注销后在哪跑。可选：保留 Hermes 作为非 runner 测试机、用云服务器 `84.247.157.41` 的 `himawari-ci`、或批准 VPS 上一个独立检查账号。不能默认“在 VPS 上随手跑”。
4. **CI 判定平台从 22.04 变成 24.04**：ADR 0160 决定 2 写的是“由 Hermes 的 Ubuntu 22.04 结果判定”。VPS 是 24.04，更接近生产但仍不等于生产；新 ADR 必须明确改写这条，并接受历史结果不可直接比较。
5. **runner 数量和内存**：先 1 个还是直接 2 个；每个给多少内存；是否保留 Hermes 作为多久的冷备。
6. **时限**：ADR 0168 的 90/60/15 分钟是否在 VPS 上继续沿用。建议第一次先沿用，测量后再决定是否收回，不要在同一次迁移里同时改时限。
7. **artifact 预算**：1 天保留是否足够让私有仓库 artifact 存储不超过 500 MB；如果超过，是否接受少量存储费，或进一步裁剪上传内容。

## 三、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会，而且不涉及。** 这次改动只动 CI 的 workflow、策略、runner 安装脚本、测试和文档，没有改任何“组装发给模型的内容”的代码：系统提示、工具定义、历史消息、资料块、遮盖逻辑都没有变化。因此“固定的在前、会变的在后”“已经发出的内容只追加”这些不变量仍然成立；这次没有新增任何每轮会变的值到系统提示或工具定义里。

如果把问题字面理解成“GitHub Actions 的请求开头”，那么 workflow 文件本身会变，但模型看不到，也不参与模型 KV 缓存。依据仍是 `.claude/rules/prompt-prefix.md:27-35` 的适用范围：它约束的是模型请求。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会涉及模型请求。** 本方案没有新增时间戳、随机数、哈希、无序集合或依赖前后文的遮盖；新标签 `ovh-ci` 是常量，策略升级函数是确定性的，JSON 字段顺序保持原样。
需要区分的是：`scripts/ci/quality.mjs` 本来就会在质量报告里写 `startedAt`/`completedAt` 和硬件信息（`quality.mjs:45-66`），这些不是模型请求，也不会进入模型上下文；本方案不新增这类字段。若担心 CI 证据的可复现性，应在 VPS 环境固定 `TZ=UTC` 和 `LANG=C.UTF-8`；目前 `run.mjs` 只固定了 `LANG`（`install-tools.mjs:312-329`），没有固定 `TZ`，这是一个可单独处理的 CI 可复现性问题，不是本方案的模型字节问题。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，但需要补几处；我没有运行测试，以下是按代码和现有测试结构设计的检查，标记为“未运行”。

现有门槛：
- `npm run check:ci-policy`（`package.json:76`）会跑 `check-policy.mjs`，校验 `ci/policy.json`、`ci.yml`、`main.yml`、`quality.yml`、Vitest 项目、测试清单等。
- `ci.yml` 的 `static` job 会跑 `npm run check` 和 `actionlint`（`ci.yml:243-251`）。
- `test/tooling/policy.test.mjs:663-741` 已有托管 runner 升级正反用例；`test/tooling/ci-optimization.test.mjs:100-125` 校验 `main.yml` 和 artifact 保留期。

必须新增/修改的反向用例：
1. `test/tooling/policy.test.mjs`
   - 正例：基准策略是精确的旧 `hermes-home` 写法，`resolvePolicySource` 升级成 `ovh-ci`，且 `policySha256` 仍指向基准字节。
   - 反例 A：混合标签（一个成员 `ovh-ci`、其余 `hermes-home`）不得升级，`validatePolicy` 必须抛错。
   - 反例 B：macOS 成员未暂停、或 `timeoutMinutes` 不匹配的旧写法不得升级。
   - 反例 C：当前 `ci.yml` 里任意一个 `runs-on` 仍是 `hermes-home`，`validateWorkflow` 必须抛错。
   - 反例 D：`main.yml` 的 `runs-on` 仍是 `hermes-home`，`validateMainWorkflow` 必须抛错。
2. `test/tooling/ci-optimization.test.mjs`
   - 扫描 `ci.yml`、`main.yml`、`quality.yml`，出现 `hermes-home` 就失败；把新标签改回旧标签时测试必须失败。
3. 新 `test/tooling/vps-runner-scripts.test.mjs`
   - 在错误主机名运行安装/注册/卸载必须退出 68。
   - runner 服务活跃时安装必须退出 70。
   - runner 账号有额外组（尤其 docker）时必须拒绝。
   - 防火墙规则包含 runner uid、拒绝私有地址和本机端口。
   - sudoers 只允许 `ubuntu` 启停指定服务。
   - 删除上述任一保护时测试必须失败。
4. 如果搬 quality：
   - `policyMain` 必须拒绝 `quality.yml` 的 `runs-on` 与 `ci/quality-policy.json` 的 `runner` 不一致。
   - 把 `quality-policy.mjs` 的 `expectedJobs` 写回 `ubuntu-24.04` 时测试必须失败。
   - `brands` 的 `--with-deps` 去掉后，策略期望步骤必须同步；保留 `--with-deps` 时测试必须失败。
5. `actionlint` 本身：
   - `.github/actionlint.yaml` 改成只列 `ovh-ci` 后，任何旧标签都会被 actionlint 当未知 self-hosted label 报错；这是第二道机械门槛。

未覆盖的缺口：
- 没有自动检查“GitHub 上确实有一个在线 `ovh-ci` runner”。这只能在验收脚本/人工 `gh api` 里做。
- `check:srt-boundary` 不在 CI 里（P10），所以 AppArmor/bwrap 的真实启动没有每轮自动门槛；建议把它加入首次验收清单，是否纳入每轮 CI 需要另开 ADR，因为会增加耗时和平台依赖。

### 4. 每个产生或修改的值，每个使用它的地方都能接受吗？

下面逐个核对。结论：**必须在同一个提交里成组修改，漏一处就会在“策略校验失败”或“任务永远排队”之间二选一。**

| 值 | 产生处 | 使用/校验处 | 两端是否能接受 |
| --- | --- | --- | --- |
| 新标签 `ovh-ci` | `ci/policy.json` 11 个未暂停 Linux 成员；`ci.yml` 所有 `runs-on`/矩阵；`main.yml:18,69`；新 `vps-runner` 注册脚本 | `policy.schema.json:63-64` enum；`check-policy.mjs:209`；`validateWorkflow` 的单成员/矩阵比较；`main-workflow.mjs:48`；`actionlint.yaml:3`；`policy.test.mjs`/`ci-optimization.test.mjs` | 全部改则接受；漏 schema 会报 schema 错；漏 `check-policy.mjs:209` 会报 `Incorrect platform`；漏 `main-workflow.mjs:48` 会报 `runtime`；漏 actionlint 会报未知标签；漏 workflow 会排队 |
| 旧标签 `hermes-home` | 基准提交的 `ci/policy.json` | `upgradeHermesRunnerPolicy`；`resolvePolicySource`；`validatePolicy`（升级后不再看到它） | 只在基准策略中接受，且只接受精确旧写法；工作区里再出现就应失败 |
| runner 名 `ovh-ci-1` / `ovh-ci-2` | 新注册脚本；GitHub runner 注册 | `pause/resume` 的 `runner_select`、`runner_field` 按名字对账；`gh api` 列表；新测试；Runbook | 名字只影响对账和排错，不影响策略；必须与 GitHub 上的名字完全一致，否则暂停/恢复会拒绝 |
| 管理员账号 `ubuntu` | 新 `runner_sudoers_line` | `visudo` 校验；`/etc/sudoers.d/91-gh-runner-control`；Runbook；测试 | 必须替换旧 `andy`；否则 VPS 上暂停/恢复没有权限。只给 `start|stop|restart` 三个动作 |
| 主机名 `vps-482b8c36` | 新安装/注册/卸载脚本的 host guard | 脚本自身；Runbook 预检；测试 | 必须精确匹配；否则脚本退出 68。若 OVH 重建会变，建议脚本用参数/环境变量并记录，不要写死到不可替换 |
| 路径 `/srv/gh-runner*`、unit 名 `gh-runner*`、nft 表 `gh_runner` | 新 `runners.sh` | systemd 单元、nft 服务、clean 服务、卸载脚本、备份清单、测试 | 全部同步则接受；旧 Hermes 脚本继续用自己的常量，两边不要混用 |
| runner 版本 `2.338.2` + SHA-256 | 新 `install-runner.sh` | 下载校验；GitHub 自动更新；Runbook；测试 | 固定版本可接受；GitHub 要求 30 天内更新，过期不再派任务，需监控 |
| quality 的 `runner` 字段（如果搬） | `ci/quality-policy.json` | `quality-policy.mjs` AJV schema；`expectedJobs` 的 `runs-on`；`quality.yml` 7 个 job；`policyMain` 测试 | 必须同时改；否则 `CI_QUALITY_WORKFLOW_MISMATCH` |
| `/usr/bin/docker` + `unix:///var/run/docker.sock`（如果搬 container） | `quality-policy.mjs:22-25`、`quality.yml:247-248` | `quality.mjs` 的 `qualificationEnvironment`；`test/integration/container-qualification-support.ts:22-23`；container 测试 | 用专用 quality runner 时保持原值即可；若改 rootless，所有使用处都要改，风险高 |
| `--with-deps`（如果搬 brands） | `quality.yml:123`、`quality-policy.mjs:132` | `expectedJobs` 的精确步骤；`brands` 测试 | 去掉后必须由管理员预装系统依赖和 Chrome/Edge；保留则无 sudo 账号跑不了 |
| timeout `90/60/15` | `ci/policy.json`、`ci.yml`、`main.yml` | `check-policy.mjs:43-46`；`policy.test.mjs`；ADR 0168 | 本方案不改；若要改，必须 policy/workflow/ADR/测试一起改 |
| retention `1` | `ci/policy.json`、`ci/quality-policy.json`、workflow | `policy.schema.json`；`upgradeArtifactRetention`；`ci-optimization.test.mjs` | 本方案不改；继续遵守 ADR 0174 |
| `macos-15` + `paused: true` | `ci/policy.json` | `validatePolicy` 的 mac 分支；`activeMembers`；`ci.yml` 矩阵不包含它 | 保持不变；不要因为迁移 Linux runner 而误改 macOS 成员 |

特别提醒 I-73 那类事故：**不要只改 `ci.yml` 和 `policy.json` 就认为完成。** 这个标签同时被 schema、`check-policy.mjs`、`main-workflow.mjs`、actionlint、安装脚本和测试消费；任何一处两端规则不一致，都会在“PR 自己过不了”或“新 runner 收不到任务”之间出问题。

---

**未核实的事项**：VPS 上 AppArmor 开关实际值、bwrap 实际版本、Playwright 预装品牌浏览器后的免 root 行为、根less Docker 是否满足 container 任务、两个 runner 的实际内存峰值、OVH 网络对 GitHub/Playwright/Docker Hub 的出口质量。这些都需要在 VPS 上按验收清单实测，不能从现有代码或文档直接下结论。
