## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可逆操作、规则/文档/代码一致性”先查了这些地方：

- **错误路径**：`upgradeRunnerLabel` 的严格匹配、`resolvePolicySource` 的 base 缺失/损坏、`runner-pause.sh` 的忙碌与 `pgrep` 失败、`install-runner.sh` 的回滚、`uninstall-runner.sh` 的强杀、三个 root 脚本的主机名检查。结论：策略升级的错误路径设计方向正确；**卸载与直连 SSH 的错误路径不足**。
- **不可信输入**：`nft` 端口名单来自 `ss`、`visudo -cf`、`gh api` 标签、SSH 目标环境变量、`npx` 下载。结论：`nft -c`/`visudo` 有校验；**SSH 目标环境变量和 `npx` 需要收紧**。
- **安全**：Docker 组等价 root、`nft` 只挡回环监听端口、元数据服务、公网 SSH 入站、自动安全更新、AppArmor、bwrap 版本。结论：**quality 的 Docker 方案有高危回归；VPS 的入站与 nft 规则不完整**。
- **资源耗尽**：`gh-runners.slice` 只包住两个 runner；Docker/quality 不在 slice 内；磁盘底线、Playwright 缓存、第三个 runner。结论：**quality 上机后没有总量约束**。
- **不可逆操作**：删除 GitHub runner 注册、Hermes 卸载、`apparmor_parser -r`、`hostnamectl`、`apt`、删除旧脚本。结论：**当前顺序会在没有暂停的情况下强杀任务，且合并后旧卸载脚本不再存在于 main**。
- **规则/文档/代码一致性**：`AGENTS.md`、`.agents/instructions/*`、ADR 0160/0168/0169/0171/0173/0174、旧 Runbook、`actionlint.yaml`、测试。结论：**方案只列了其中三处，遗漏较多**。

---

## 一、证实的发现（按严重度）

### 1. 高：runner 注册标签/名字的生产端漏改，VPS 可能永远不被派单

方案第二节说“改所有写死处”，但清单只列了 workflow、policy、校验脚本和测试，没有列 runner 脚本本身：

- `scripts/operations/hermes-runner/register-runner.sh:29` 仍然写死 `--labels hermes-home`。
- `scripts/operations/hermes-runner/mac-runners.sh:2` 仍然写死 `LABEL=hermes-home`。
- `scripts/operations/hermes-runner/runners.sh:9,16` 的 `RUNNER_NAME` 仍是 `hermes-home` / `hermes-home-2`。

后果：VPS 的 runner 会用 `hermes-home` 注册；新 `ci.yml` 只要求 `ci-vps`，任务永远不会派到 VPS。更糟的是，即使注册标签改了，`mac-runners.sh` 的暂停仍会去删/加 `hermes-home`，`ci-vps` 标签不动，暂停实际失效。

**建议**：把这三处明确写进第一个 PR 的清单；增加一个契约测试，读 `ci/policy.json`、`ci.yml`、`main.yml`、`.github/actionlint.yaml`、`register-runner.sh`、`mac-runners.sh`、`runners.sh`，断言标签和 runner 名一致。I-73 的教训正是“不要只看改动，要问清单里的 id 能不能通过后端校验”。

### 2. 高：quality 的 Docker 组方案是同机 root 等价，且现有 unit 会把 Docker 套接字藏起来

方案第五节把“第三个专用账号加入 docker 组、不给 sudo”列为候选。Docker 官方明确写着：

> “The docker group grants root-level privileges to the user.”
> https://docs.docker.com/engine/install/linux-postinstall/

同一台 VPS 上还跑着合并闸门用的两个 runner。quality runner 一旦能访问 Docker 套接字，就能挂载宿主根文件系统、读取另外两个 runner 的凭证，ADR 0171 的独立账号隔离就失效了。

而且现有服务模板本身与 Docker 冲突：

- `scripts/operations/hermes-runner/gh-runner.service.in:30` `ProtectHome=yes`
- `scripts/operations/hermes-runner/gh-runner.service.in:36` `InaccessiblePaths=... -/run/docker.sock -/var/run/docker.sock`

如果第三个账号复用模板，Docker 套接字是隐藏的；如果去掉这两行，又会削弱所有 runner 的加固。第三 runner 也没有现成支持：`runners.sh:1-24` 只支持 1/2，`install-runner.sh:22` 的 `RUNNER_IDS="1 2"`、`uninstall-runner.sh:10-13` 也只处理 1/2/all。

**建议**：不要在合并闸门同一台机器上给 Docker 组。首选把 `quality.yml` 继续留在 GitHub 托管的 `ubuntu-24.04`（它本来就不影响合并，且当前是停用状态）。如果一定要自托管，用独立的一次性 VM/主机，或用 rootless Docker，但必须单独做 unit（放开 `/run/user`、Docker 数据目录、`ReadWritePaths`），并单独做资源上限和测试；不要复用现有模板。

### 3. 高：Hermes 的注销/卸载顺序与现有 Runbook、ADR 0169 冲突，且会强杀任务

方案第六节第 5 步写的是“从 GitHub 删除两个 runner 的注册，再由 Andy 在 Hermes 上用 sudo 跑一次卸载脚本”。但现有流程要求先暂停：

- `docs/runbooks/hermes-self-hosted-runner-runbook.md:194`：先运行 `pause-runners.sh`，再运行 `uninstall-runner.sh`。
- `docs/adr/0169-pause-runners-by-removing-the-label.md:64,67`：先对账、去标签、等空闲、再停服务。
- `scripts/operations/hermes-runner/uninstall-runner.sh:23-24`：直接 `systemctl disable --now` 然后 `pkill -u "$RUNNER_USER"`，没有 busy 检查。

此外，方案说“卸载要在仓库删掉旧脚本之前，用 main 上的旧版本跑”，但第一个 PR 已经改名为 `ci-runner` 并删除旧目录；合并后 main 上不存在旧版本。按现有步骤顺序执行不到“旧版本”。

**建议**：顺序改为：先在 Mac 上运行 `pause-runners.sh` 等空闲；再从 GitHub 删除注册；再用 Hermes 上已有的旧脚本副本（或合并前的 commit）运行 `uninstall-runner.sh`；确认卸载成功后才删除/改名仓库里的旧脚本。不要把“删除 GitHub 注册”放在暂停之前。

### 4. 高：Mac 端直连 SSH 会丢掉现有的超时、主机名校验和上传路径；测试 mock 也不适用

现有 Mac 端通过 `hermes-ssh.sh` / `hermes-upload.sh`，它们提供 300 秒超时、远端主机名校验和只读保护（`mac-runners.sh:16-28`）。方案改成 `ssh ubuntu@158.69.191.249`、不再经包装脚本，但没有定义：

- `BatchMode=yes`、`ConnectTimeout`、`ServerAliveInterval`；
- `StrictHostKeyChecking=yes`、固定的 `UserKnownHostsFile`；
- 300 秒 `timeout`；
- 远端 `hostname` 必须等于 `ci-vps`；
- 上传脚本用什么（`scp`/`rsync`/`ssh cat`）替代 `hermes-upload.sh`。

现有测试 `test/tooling/hermes-runner-scripts.test.mjs:252-273` 正是通过 fake `hermes-ssh.sh` / `hermes-upload.sh` 驱动的；直连后这套 mock 全部失效。`test-and-production-hosts.md:23` 也要求 Hermes 命令必须走包装脚本，VPS 是新的主机，规则和 guard 都没更新。

**建议**：新增仓库内的 `ci-vps-ssh.sh` / `ci-vps-upload.sh`，保留现有保护并检查远端主机名 `ci-vps`；地址用受控环境变量覆盖，但不要允许任意命令拼接。测试改为 fake 这两个包装脚本，而不是 fake `ssh` 本身。

### 5. 中：`ci-optimization.test.mjs` 的精确字符串不更新会直接失败

`test/tooling/ci-optimization.test.mjs:118-124` 用：

```js
"runs-on: hermes-home\n    timeout-minutes: 90"
```

去替换 `main.yml` 里的两行。把 runner 改成 `ci-vps` 后，`.replace` 不匹配，超时仍是 90，`validateMainWorkflow` 不会抛错，但测试期望它抛 `"runtime"`，于是测试失败。方案没有列出这个文件。

**建议**：把字符串改成 `runs-on: ci-vps\n    timeout-minutes: 90`，并保留反向用例。

### 6. 中：runner 脚本测试仍写死旧内存、旧名字、旧用户、旧标签和旧 SSH mock

`test/tooling/hermes-runner-scripts.test.mjs` 至少这些地方需要改，而方案只写了“跟着改名”：

- `:160,163` 期望 `runner-pause.sh --list` 输出 `hermes-home` / `hermes-home-2`；
- `:206-209` 的 `macBox` 默认 runner 名；
- `:216` 的标签 `hermes-home`；
- `:662-747` 断言 slice `13G/14G`、per-runner `12G/13G`、sudoers 用户 `andy`；
- `:759` 断言错误信息 `only runs on hermes-home`；
- `:768,788,814,1056,1190,1209` fake `hostname` 为 `hermes-home`；
- `:252-273` fake `hermes-ssh.sh` / `hermes-upload.sh`。

新方案要改成 `ci-vps`、`ci-vps-1/2`、`14G/15G`、`19G/20G`、`ubuntu`，并重写 SSH/上传 mock。否则 `npm run check` 或 tooling 项目会失败。

**建议**：在方案里逐项列出这些断言，并新增 VPS 专项断言（内存、sudo 用户、标签、名字、主机名）。

### 7. 中：`grant-temp-sudo.sh` 仍然写死 `andy`，且目录改名会删除 Hermes 仍需要的临时 sudo 入口

`scripts/operations/hermes-runner/grant-temp-sudo.sh:5,47` 写死：

```sh
GRANTEE=andy
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$GRANTEE" > "$CANDIDATE"
```

方案只说了“sudoers 里的用户由 andy 改为 ubuntu”，没有覆盖这个脚本。更关键的是，这个脚本不是 runner 专用：`docs/runbooks/hermes-self-hosted-runner-runbook.md:86` 把它作为 Hermes 上取得临时 sudo 的正式入口。把整个 `hermes-runner/` 改名为 `ci-runner/` 并改 `GRANTEE=ubuntu` 后，Hermes 测试主机就失去了这个仍需要的工具。

**建议**：不要把 `grant-temp-sudo.sh` 绑在 CI runner 改名里。要么保留在 host-neutral 的位置并让 `GRANTEE` 可配置，要么为 Hermes 保留一份；同时更新新的 Runbook，明确 Hermes 仍用 `andy`，VPS 用 `ubuntu`。

### 8. 中：quality 的 `runs-on`、validator、actionlint 没有定义新标签

`scripts/ci/quality-policy.mjs:119,170` 写死 `runs-on: ubuntu-24.04`；`.github/workflows/quality.yml` 的 7 个 job 也全是 `ubuntu-24.04`（`:27,65,103,147,185,223,271`）。方案第五节只说“quality-policy.mjs 跟着改”，但没有说 quality 的 runner 标签到底叫什么、哪些 job 用 `ci-vps`、哪些用 `ci-vps-quality`。而 `.github/actionlint.yaml` 按方案只列 `ci-vps`，如果引入 `ci-vps-quality`，actionlint 会报未知标签。

**建议**：先在方案里定一个标签，或明确 quality 继续用 `ubuntu-24.04`；如果引入新标签，同时改 `quality-policy.mjs` 的两处、`quality.yml` 的全部 `runs-on`、`actionlint.yaml`，并加 validator 反向测试。

### 9. 中：VPS 只装系统 bwrap 是 0.9.0，生产 Runbook 要求 0.11.2 的路径

`docs/runbooks/install-start-stop-runbook.md:492` 明确：

> “Linux 的 `program/stdio MCP` 隔离后端……仍要求 bubblewrap `>=0.11.2`，并拒绝 setuid 程序。”

并且 `:497` 指定了 `/usr/local/libexec/bubblewrap-0.11.2/bwrap` 和 `/etc/apparmor.d/bwrap-0.11.2`。Ubuntu 24.04 仓库的 `bubblewrap` 是 `0.9.0-1ubuntu0.3`（https://packages.ubuntu.com/noble/bubblewrap），方案第四节只 `apt install bubblewrap` 并只建 `/etc/apparmor.d/bwrap`，没有装 0.11.2。产品代码也确实要求 0.11.2：`packages/platform-node/src/workspaces/linux-bubblewrap-command-provider.ts:78,121`。

这是否会让当前 CI 失败还不确定（现有相关测试多用 fake bwrap，`check-srt-boundary.mjs` 用 SRT 的系统 bwrap）；但方案宣称要让 VPS 与生产 24.04 对齐，这里没有对齐。

**建议**：要么按 Runbook 同时安装并验证 `/usr/local/libexec/bubblewrap-0.11.2/bwrap` 与对应 AppArmor 规则；要么在方案里明确“当前 CI 不跑 program/stdio 后端，故只装 0.9.0”，并加一条验收说明，避免以后误以为已具备生产等价性。

### 10. 中：nft 只挡 `127.0.0.0/8` 的监听端口；公网 IP 监听端口和 Docker 容器不受约束

`scripts/operations/hermes-runner/runners.sh:52-58` 的本机端口规则是：

```nft
meta skuid { ... } ip daddr 127.0.0.0/8 tcp dport { ... } reject
meta skuid { ... } ip6 daddr ::1 tcp dport { ... } reject
```

VPS 上如果 `sshd` 监听 `0.0.0.0:22`（常见），runner 通过 VPS 公网 IP 访问 22 端口不会被这条规则挡住；任何监听 `0.0.0.0` 的本机服务同理。另外，规则按 `skuid` 匹配，Docker 容器（rootful 或 rootless 的 subuid）不一定是 runner 的 UID，容器网络流量可以绕过整个 nft 规则，尤其与第五节 Docker 方案叠加时。

**建议**：把 VPS 的公网/私网地址也纳入本机监听端口的拒绝范围；如果 quality 必须用容器，使用 network namespace/cgroup 级限制，或在独立主机上跑。加一个验收探测：以 runner 身份 `curl` 元数据地址、本机 `0.0.0.0` 服务、`127.0.0.1` 服务，全部应失败。

### 11. 中：文档一致性只列了三处，实际有多处仍指向 Hermes

方案只说改 `delivery-mode.md:27`、`test-trigger-timing.md:17`、`test-and-production-hosts.md` 加一条 VPS 说明，但至少还有：

- `AGENTS.md:7`：“CI……按 ADR 0160 在 Hermes 上的自托管 runner 里运行”；
- `.agents/instructions/test-and-production-hosts.md:18`：“Hermes（Ubuntu 22.04，bwrap 0.6.1）……不能代表生产服务器（Ubuntu 24.04）”——CI 改到 VPS 24.04 后这句话需要区分“CI 主机”和“手工测试主机”；
- `docs/adr/0174-no-github-cache-and-one-day-artifacts.md:89`：`quality.yml` 仍在 `ubuntu-24.04` 上跑；如果第二节 PR 移动 quality，要修订；
- `docs/adr/0169...:64,67` 和 `docs/runbooks/hermes-self-hosted-runner-runbook.md:194` 的路径/标签/卸载流程；
- 旧的 `scripts/operations/hermes-runner/` 路径、`hermes-home` 出现在旧 ADR/Runbook/测试中。

**建议**：合并前用一次全仓搜索列出 `hermes-home`、`hermes-runner`、`ADR 0160`、`quality.yml` + `ubuntu-24.04` 的所有命中，逐项决定“更新/标为历史/加说明”；然后跑 `npm run check:instruction-links` 和文档校验。不要只改点名的三处。

### 12. 中/低：hostname、cloud-init、入站 SSH、自动更新这几个运维前提没有验收

- 方案加 `/etc/cloud/cloud.cfg.d/` `preserve_hostname: true` 是对的；cloud-init 文档说明它可阻止更新 `/etc/hostname`：https://docs.cloud-init.io/en/latest/reference/yaml_examples/update_hostname.html 。但没有说 `hostnamectl set-hostname` 后同步 `/etc/hosts`，也没有重启后验证 `hostname` 仍为 `ci-vps`。`install-runner.sh:16`、`register-runner.sh:8`、`uninstall-runner.sh:8` 都会因主机名不符以 68 拒绝。
- 方案说“自动安全更新保持开启，但关掉自动重启”。内核安全更新需要重启才生效；CI runner 执行不可信 PR 代码，长期不重启会扩大攻击面。应定义维护窗口：先暂停 runner、等空闲、重启、恢复。
- VPS 是公网 IP，方案只写了 runner 账号的出站 nft 规则，没有写 `ubuntu`/root 的入站 SSH 加固（仅密钥、禁用密码、限制来源、fail2ban 或 Tailscale/Cloudflare）。

**建议**：把“重启后 hostname 仍为 ci-vps”“入站 SSH 仅密钥”“安全更新后的重启/暂停流程”写成可执行的验收项，而不是只写配置。

### 13. 低：`npx playwright install-deps` 没有锁定版本；第一次 main 会走 full CI，应写进预期

- 方案第四节用 `npx playwright install-deps ...`，但 `npx` 在没有本地 `node_modules` 时会取最新版本；现有 workflow 用的是 `node_modules/playwright/cli.js`（`ci.yml:356`、`quality.yml:123`）。应统一改成 `node node_modules/playwright/cli.js install-deps ...`，确保取 `package-lock.json` 固定的版本。
- 第一个 PR 修改了 `.github`、`ci`、`scripts/ci`，`scripts/ci/main-evidence.mjs:60-70` 的 `pushIdentity` 会因 `MAIN_VALIDATION_CHANGED` 拒绝 light 模式；即使不拒，`:164` 的 `MAIN_POLICY_MISMATCH` 也会因为 PR 的 policy 字节与合并后 main 的 policy 字节不同而拒绝。结果是合并后 main 必然跑 full CI。这不是 bug，但验收标准应写明“第一次 main 是 full CI”，否则会被误判为异常。

**建议**：改 `npx` 为本地 cli；在验收步骤里明确第一次合并后 main 走 full CI，并把 full CI 的 VPS 通过作为验收项。

---

## 二、推测或未核实

1. **VPS 的实际内存/磁盘**：方案说 22 GB、云盘随机读慢，但没有 VPS 的 `free`、`df`、根盘/数据盘容量和 16 GiB 底线是否足够两个 runner + Playwright 的实测。**未核实**。
2. **CI 是否真的需要 bwrap 0.11.2**：现有相关测试大多用 fake bwrap；`check-srt-boundary.mjs` 用系统 bwrap。VPS 上 0.9.0 是否足够要看实际 `npm run check`/test 的覆盖范围，**未核实**。
3. **rootless Docker 能否在现有 systemd 加固下工作**：`ProtectHome=yes` 会遮住 `/run/user` 和 home 下的 Docker 数据；rootless 还需要 `uidmap`、`slirp4netns`、`fuse-overlayfs`、user lingering，方案没有列。**未核实**。
4. **OVH 元数据地址**：方案说 `169.254.0.0/16`，通用 OpenStack/EC2 兼容元数据确实是 `169.254.169.254`（https://docs.openstack.org/nova/latest/user/metadata.html）；OVH 该 VPS 的实际地址和是否还有别的内网地址**未核实**。
5. **cloud-init 重启后是否真的不改主机名**：`preserve_hostname: true` 是官方推荐机制，但需要在该 VPS 上实际重启验证；**未核实**。
6. **quality 是否真的会引入 `ci-vps-quality`**：方案没有定标签；如果不用新标签，actionlint/quality-policy 的改动范围不同；**未核实**。
7. **VPS 上是否有 `0.0.0.0` 监听的服务、是否有公网 IPv6**：nft 的缺口是否可被利用取决于实际监听；**未核实**。
8. **`npx` 在 VPS 准备阶段是否已有本地 Playwright**：取决于执行顺序和 `npm ci` 是否已跑；**未核实**。
9. **VPS 是“共享物理机”还是独立 VM**：影响 CPU steal 和资源判断；**未核实**。

---

## 三、如果由我来定，我会怎样改这份方案

1. **只做第一个 PR，quality 第二个 PR 无限期后置。** `quality.yml` 现在就在 GitHub 托管的 `ubuntu-24.04` 上，且只手动触发、只跑 main，不影响合并；保持停用即可。这样可以完全避开 Docker 组、第三个 runner、rootless、品牌浏览器和资源上限的全部风险。
2. **先建立“runner 标识的单一事实来源”。** 至少加一个契约测试，从 `ci/policy.json` 读出标签，和 `ci.yml`、`main.yml`、`actionlint.yaml`、`register-runner.sh`、`mac-runners.sh`、`runners.sh` 逐个比对；任何一处出现旧标签/旧名字就失败。这比“在工作流里 grep `hermes-home`”更接近 I-73 的教训。
3. **把 VPS 准备写成可重复、可验收的脚本**，但脚本只做加法；已有 `/etc/apparmor.d/bwrap` 要先备份、比对、经 Andy 确认再覆盖。验收包括：重启后 `hostname=ci-vps`、`/etc/hosts` 正确、bwrap 版本和 AppArmor 开关、以 runner 身份访问元数据/本机端口失败、`nft` 规则加载、SSH 仅密钥、安全更新后的暂停/重启流程。
4. **切换顺序改为**：VPS 准备好 → 注册 `ci-vps` → 第一个 PR 的 CI 在 VPS 全绿 → 合并 → main full CI 在 VPS 通过 → Hermes 先 `pause-runners.sh` 等空闲 → 删除 GitHub 注册 → 用 Hermes 上已有的旧脚本卸载 → 最后才从仓库删除旧脚本。VPS 稳定一周后再删 Hermes 注册，给自己留回退窗口。
5. **测试补齐**：在 Hermes 和 VPS 上各跑一次 `npm run check`；在两边各跑 `npm run check:prompt-prefix` 并比对原始请求体；更新 `ci-optimization.test.mjs`、`hermes-runner-scripts.test.mjs`、`policy.test.mjs`；加注册/暂停/恢复的 fake `gh`/`ssh` 用例；加“标签不一致必须失败”的反向用例；给 `main-evidence` 加“策略变更的 PR 必须回退 full CI”的断言。
6. **文档全量收敛**：更新 `AGENTS.md`、`.agents/instructions/test-and-production-hosts.md`、ADR 0160/0168/0169/0171/0173/0174、旧 Runbook 和所有路径引用；旧 ADR/Runbook 可以保留为历史，但必须加 `superseded_by` 或明确说明“CI 已迁到 VPS”。

---

## 四、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会直接改变。** 这个方案改动的是 CI workflow、`ci/policy.json`、runner shell 脚本和文档，没有触碰模型请求组装代码（`packages/runtime-pi/`、`packages/application/` 的请求组装路径）。依据：

- `.claude/rules/prompt-prefix.md:27-36`：固定的在前，会变的在后；每轮会变的内容只放最后一条用户消息；已发内容不改、不重排、不删，只追加。
- 现有的运行环境说明仍然通过 `runtimeEnvironmentMessage` / `runtimeEnvironmentAfterCompaction` 追加（`packages/runtime-pi/src/runtime-environment-block.ts:114-132`），方案没有修改它。
- `ci-vps` 只出现在 CI 配置和 runner 标签，不会进入系统提示、工具定义或历史消息。

**但有一个验证缺口**：VPS 是 Ubuntu 24.04，Hermes 是 22.04。如果运行环境说明包含与平台相关的“可用命令”等内容，CI 的 prompt-prefix 测试在两边生成的字节可能不同。方案目前没有“在 VPS 上跑 `check:prompt-prefix` 并与 Hermes 比对原始请求体”的步骤。建议加上这一步；如果只在 CI 环境有差异、生产请求不受影响，也要在方案里写明这个差异。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？

**不会直接改变。** 方案没有新增任何进入模型请求的字段、时间、路径、标识或集合；没有改遮盖算法，也没有改 JSON/列表顺序。`ci-vps`、`ci-vps-1/2`、`ubuntu` 都是 CI/运维标识，不进入提示词。

**需要留意**：VPS 的主机名、时区、locale、OS 版本可能影响测试中生成的临时路径或环境块内容，但这不是“同一段文字在不同请求里变成不同字节”的生产问题。只要 `check:prompt-prefix` 在 VPS 24.04 上通过，并且原始请求体与 Hermes 的同 fixture 比对一致，就可以确认没有回归。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**部分有，但不完整。** 方案里策略升级的正反用例设计得不错：

- 恰好的旧写法升级；
- 混写、macOS 未暂停、时限不对不升级；
- workflow 留一处 `hermes-home` 被拒；
- `policySha256` 等于原始 base 字节。

这些反向用例如果按现有 `validatePolicy`/`validateWorkflow` 的严格校验实现，确实会失败，能起到门槛作用。

**缺的检查**：

- 没有“注册脚本、mac 脚本、policy、workflow、actionlint 标签一致”的契约测试——这是最容易漏的 I-73 类问题；
- 没有 VPS 准备脚本的测试（重启后主机名、bwrap、nft、AppArmor、SSH）；
- 没有直连 SSH 的 fake 测试（现有测试只 mock `hermes-ssh.sh`）；
- 没有更新 `ci-optimization.test.mjs` 的精确字符串，它现在会失败；
- 没有 quality 的 validator/actionlint/runs-on 反向用例（如果第二个 PR 要做）；
- 没有“策略变更的 PR 在 main 必须回退 full CI”的断言。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**不能，至少有两处是断的。** 逐个核对：

| 值 | 产生处 | 使用处/校验 | 结论 |
|---|---|---|---|
| `ci-vps` 标签 | `ci/policy.json`、`ci.yml`、`main.yml` | `ci/policy.schema.json` enum、`check-policy.mjs:209`、`main-workflow.mjs:48`、`actionlint.yaml` | 计划内一致；**但 `register-runner.sh:29` 仍产出 `hermes-home`，`mac-runners.sh:2` 仍消费 `hermes-home`，断** |
| `ci-vps-1/2` 名字 | 方案要求 | `runners.sh:9,16`、`register-runner.sh --name`、`runner-pause.sh --list`、`mac-runners.sh` 对账、测试 | **`runners.sh` 仍是 `hermes-home`/`hermes-home-2`；方案没列** |
| `ubuntu` sudo 用户 | 方案要求 | `runners.sh:71` 生成的窄 sudo 规则、`runner-pause.sh`/`runner-resume.sh` 的 `sudo -n systemctl` | 若只改 `runners.sh` 可以；**`grant-temp-sudo.sh:5` 仍产出 `andy`，且 Hermes 仍需要它** |
| `ci-vps` 主机名 | `hostnamectl`、cloud-init drop-in | `install-runner.sh:16`、`register-runner.sh:8`、`uninstall-runner.sh:8` | 计划一致；**缺重启验收和 `/etc/hosts`** |
| `ci-vps-quality`（如果采用） | 方案第五节 | `quality-policy.mjs:119,170`、`quality.yml` 全部 `runs-on`、`actionlint.yaml`、`runners.sh` 1/2 限制 | **没有定标签，也没有对应 validator/脚本支持** |
| `14G/15G`、`19G/20G` 内存 | `gh-runner.service.in`、`gh-runners.slice` | `test/tooling/hermes-runner-scripts.test.mjs:662-747` 的旧断言 | **测试仍断言 12G/13G、13G/14G，方案没列** |
| `policySha256`（base 原始字节） | `resolvePolicySource` | `createContext`、`main-evidence.mjs:164` | 语义一致；但第一个 PR 改 policy 后 `main-evidence` 会拒绝 light，走 full CI，方案应写明 |

结论：**标签、runner 名、sudo 用户、quality 标签、内存测试这五类值都至少有一个使用处没被方案覆盖。** 这正是 I-73 要求的“逐个找到产生它的地方和使用它的地方，核对两端校验”。
