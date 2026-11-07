## 侧重检查

我按错误路径、不合规范/不可信输入、安全、资源耗尽、不可撤销操作、规则/文档与代码一致性逐项看过：

- **错误路径**：`prepare-vps.sh` 的失败码（64/68/69/70/71/72/73）都在动作前或动作后明确退出；AppArmor 已有不同内容时拒绝覆盖（fail closed）；`install-runner.sh` 的备份/回滚、`pause-runners.sh`/`resume-runners.sh` 的中断恢复路径都在测试里。问题见下方第 2、5 条。
- **不可信输入**：注册令牌只从 stdin 读、先检查 DLL 支持 `ACTIONS_RUNNER_INPUT_TOKEN` 再交给 `config.sh`，没有走命令行；GitHub 返回的 runner 名单先对账再改标签。`mac-runners.sh` 把 `CI_VPS_SSH`、`CI_RUNNER_DIR` 拼进远程命令，属于操作者可控输入，风险低。
- **安全**：runner 账号无 sudo、无 docker 组，`ProtectHome=yes`、`ProtectSystem=strict`、`PrivateTmp`、`ProtectProc=invisible` 都在；元数据 `169.254.0.0/16` 和私有网段被挡；防火墙从“只挡回环”扩大到“本机所有地址的监听端口”，方向正确。去掉 `ProtectKernelTunables` 的理由和复现写在 ADR 0176，属于有记录的取舍。VPS 上未发现 GitHub 令牌落盘路径。
- **资源耗尽**：每 runner `MemoryMax=15G`、slice `20G`、`TasksMax`、磁盘 16 GiB 下限都在，且与 ADR/Runbook/测试一致；没有新增无界循环。新加的 Chromium 安装会额外占磁盘和时间，但有任务超时兜底。
- **不可撤销操作**：`prepare-vps.sh` 改主机名、apt 配置、cloud-init、needrestart drop-in、AppArmor，均为就地覆盖、没有回滚；`uninstall-runner.sh` 必须显式传 `2`/`all`。见第 9 条。
- **规则/文档一致性**：0160/0171/0173 已标 superseded，旧 Hermes runner 手册已归档；但 0169 仍是 active 且内容过期，见第 1 条。作者若干说法与代码不符，见第 3、4 条。

我没有发现可确认的「高」严重度缺陷；以下按中、低排列。

---

## 读代码证实的

### 1. 中：ADR 0169 仍是 active，却引用本 PR 删除的脚本目录和旧标签

- 文件：`docs/adr/0169-pause-runners-by-removing-the-label.md:2`、`:37`、`:63`、`:64`
- 问题：ADR 0176 声明 `amends` 0169，但 0169 的 `status` 仍是 `active`，正文仍写 `hermes-home` 和 `scripts/operations/hermes-runner/...`。本 PR 把该目录整体改名为 `scripts/operations/ci-runner`，合并后 0169 指向的路径不存在。
- 证据：
  - `0169...:2` `status: active`
  - `:37` ``两个 runner 注册时只带一个自定义标签 `hermes-home`（`scripts/operations/hermes-runner/register-runner.sh`）``
  - `:63` ``暂停和恢复的入口在 Andy 的 Mac 上：`scripts/operations/hermes-runner/pause-runners.sh` 和 `resume-runners.sh``
  - `docs/adr/0176-ci-on-ovh-vps.md` 的 `amends` 只写进 0176，没有回写 0169 的 `superseded_by`/`amended_by`。
- 建议：给 0169 加 amended/superseded 标记，或把路径和标签改成指向 0176 的新写法；至少加一句“连接方式、标签、远端目录见 0176 决定第 9 条”。

### 2. 中：新增的 root 一次性脚本 `prepare-vps.sh` 没有任何自动检查，关键的反向验证只做了一次手工

- 文件：`scripts/operations/ci-runner/prepare-vps.sh:37-43`；提交 `510a445d` 说明 `Layer-0-tests: 无（运维脚本和文档）`
- 问题：本 PR 最关键的安全/可用性修复（needrestart 不再重启 runner）没有进入 CI 的自动测试。只靠提交说明里的“写入前返回 1、运行后返回 0”这一手工证据；同一脚本的主机名白名单、AppArmor 文件内容、Node 校验和、Playwright 安装都没有测试。回归时 CI 不会发现。
- 证据：
  - `prepare-vps.sh:37` ``printf '%s\n' '$nrconf{override_rc}{qr(^gh-runner)} = 0;' > "$NEEDRESTART_CFG"``
  - `:38-43` `perl -e '... do "/etc/needrestart/needrestart.conf" ... exit 1 if $restart;' || fail "..."`
  - `test/tooling/ci-runner-scripts.test.mjs` 中没有 `prepare-vps` 的任何用例（grep 只命中 `gh-runners.slice`、`fib daddr`）。
- 建议：至少加一个 tooling 测试，用假的 `perl`/`needrestart.conf` 验证 drop-in 内容与匹配逻辑；把“配置前返回 1、配置后返回 0”做成可在 CI 上复跑的反向用例。

### 3. 中：作者说集成测试改动“只为让 CI 在新机器上通过，不改产品行为”——产品行为确实没变，但“新机器”说法不对

- 文件：`test/integration/production-http-composition-process.test.ts:1974`、`:1998-1999`、`:2011`；`packages/prompt-catalog/src/runtime.ts:88`
- 问题：本 PR 没有改 `runtime.ts`（`git diff base..head -- packages/prompt-catalog/src/runtime.ts` 为空），也就是说**基准提交上的产品提示词已经是中文**，而基准上的测试仍断言英文。这个测试在 Hermes 上同样会失败，不是“搬到新机器才需要改”。产品行为没变这一点是对的。
- 证据：
  - `runtime.ts:88` `text: "工具反复调用没有进展，执行已经停止。…不要说整个任务已经成功。"`
  - 测试改动把 `"Do not claim overall task success"` 换成 `"不要说整个任务已经成功"`（四处）。
  - 基准 diff 显示这三处英文来自旧测试。
- 建议：提交说明改成“修正基准上已存在的失败测试（提示词已改中文）”，并按 I-73 的思路检查“断言里的文本是否仍由产品真实生成”；否则读者会误以为这是 VPS 特有问题。

### 4. 中：作者说“sudo 只给 runner 账号窄权限”，代码给的是控制账号 `ubuntu`，runner 账号完全没有 sudo

- 文件：`scripts/operations/ci-runner/runners.sh:4`、`:69-77`
- 问题：窄 sudo 规则授予的是 `RUNNER_CONTROLLER=ubuntu`，不是 `gh-runner`/`gh-runner-2`。说法与代码相反，容易让复核者误判 runner 账号获得 root 能力。
- 证据：
  - `runners.sh:4` `RUNNER_CONTROLLER=ubuntu`
  - `:77` `printf '%s ALL=(root) NOPASSWD: %s\n' "$RUNNER_CONTROLLER" "$line"`
  - 测试也期望 `ubuntu ALL=(root) NOPASSWD: ...`（`ci-runner-scripts.test.mjs:776-789`）。
- 建议：更正作者说法为“控制账号 ubuntu 有窄 sudo；runner 账号没有 sudo”；同时考虑这条规则在 ubuntu 已有免密 sudo 的机器上是否还有意义（Runbook 自己说“留着是为了脚本在别的机器上也成立”）。

### 5. 低：needrestart 核对只 `do` 主配置，未直接读它刚写的 drop-in；能否生效依赖主配置是否加载 conf.d（未核实）

- 文件：`scripts/operations/ci-runner/prepare-vps.sh:37-43`
- 问题：脚本把覆盖写进 `/etc/needrestart/conf.d/50ci-vps-gh-runner.conf`，但核对只执行 `do "/etc/needrestart/needrestart.conf"`。如果主配置没有加载 conf.d，核对会看不到这条覆盖，脚本会永远以 73 失败；反过来，如果主配置的 include 行为变化，核对结论也可能与 needrestart 实际行为脱节。另：匹配用 `keys ... last`，依赖 Perl hash 顺序；若有多个正则同时命中同一 unit，核对进程与 needrestart 进程的顺序可能不同。
- 证据：
  - `:37` 写入 `$NEEDRESTART_CFG`
  - `:38` `do "/etc/needrestart/needrestart.conf"`
  - `:41` `for my $re (keys %{$nrconf{override_rc}}) { ... last }`
- 说明：提交说明称在 VPS 上“配置后返回 0”，说明该机器的主配置确实加载了 conf.d；但我无法在本机读到 needrestart 源码，故标「未核实」。
- 建议：核对时显式读取 drop-in 文件，或直接运行 `needrestart -b`/`needrestart -r l` 的干跑；并把“多个正则命中”的处理写成与 needrestart 完全一致的确定性逻辑（例如按配置加载顺序而不是 hash 顺序）。

### 6. 低：主机名和标签存在多处独立的字面量定义，没有一致性测试

- 文件：`scripts/operations/ci-runner/runners.sh:2`、`scripts/operations/ci-runner/prepare-vps.sh:5`、`ci/policy.schema.json`（`runner.enum`）、`.github/actionlint.yaml:3`
- 问题：`RUNNER_HOST=ci-vps` 与 `CI_HOSTNAME=ci-vps` 是两个独立定义，测试只检查前者；`actionlint.yaml` 的 `ci-vps` 也只被“不得包含 hermes-home”覆盖，没有被断言等于 `linuxRunnerLabel`。任何一处漂移都会让远程主机检查或 actionlint/策略校验失败，而且不一定被单测抓到。
- 证据：
  - `runners.sh:2` `RUNNER_HOST=ci-vps`
  - `prepare-vps.sh:5` `CI_HOSTNAME=ci-vps`
  - `policy.test.mjs:785-796` 只断言四个文件 `.not.toContain("hermes-home")`。
- 建议：让 `prepare-vps.sh` 从 `runners.sh` 取主机名，或在测试里断言 `prepare-vps.sh`/`actionlint.yaml`/schema 与 `linuxRunnerLabel` 一致。

### 7. 低：ADR 说“用 package-lock.json 固定 Playwright 1.62.1 装系统库”，代码是临时目录 `npm install playwright@1.62.1`

- 文件：`docs/adr/0176-ci-on-ovh-vps.md:75`；`scripts/operations/ci-runner/prepare-vps.sh:67`
- 问题：代码没有读 `package-lock.json`，也没有用它的完整性校验；只是指定版本号从 registry 现装。文档与代码不一致。
- 证据：
  - `prepare-vps.sh:67` `npm install --no-save --ignore-scripts --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION"`
- 建议：把 ADR 改成“固定版本 1.62.1”，或让脚本从 `package-lock.json` 安装以保证供应链一致。

### 8. 低：测试名 “14 GB together” 与新的 19G/20G slice 不符

- 文件：`test/tooling/ci-runner-scripts.test.mjs:686`
- 问题：测试内容已改为 `MemoryHigh: "19G", MemoryMax: "20G"`，名字仍写 14 GB。只是可读性问题。
- 建议：改名。

### 9. 低：`prepare-vps.sh` 假设 needrestart 与 conf.d 目录已存在，并无条件覆盖 drop-in

- 文件：`scripts/operations/ci-runner/prepare-vps.sh:25`、`:37`
- 问题：apt 安装列表没有 `needrestart`，也没有 `install -d /etc/needrestart/conf.d`。在最小化 24.04 镜像上，重定向会在预期的 73 之前以 1 退出；同时每次重跑都会覆盖运维人员可能手改的 drop-in。
- 证据：
  - `:25` `apt-get install -y -q build-essential unzip xz-utils bubblewrap socat ripgrep apparmor-utils`
  - `:37` 直接 `> "$NEEDRESTART_CFG"`
- 说明：目标 VPS 已装 needrestart（否则提交里的实测过不了），所以是健壮性问题，不是当前机器的故障。
- 建议：`install -d` 建目录；把 `needrestart` 加进安装列表或先检查存在；覆盖前保留备份。

### 10. 低：`mac-runners.sh` 去掉了旧 `hermes-ssh.sh` 的 300 秒单次上限

- 文件：`scripts/operations/ci-runner/mac-runners.sh:9`、`:19-21`
- 问题：旧包装脚本把每次远程调用限制在 300 秒；新直连只有 keepalive，没有硬超时。当前远程命令都有界（暂停 90 秒、恢复很快），所以风险低，但 ADR 0169 决定第 3 条的“每次远程调用不超过 300 秒”不再由代码保证。
- 建议：在 `ssh` 调用外加 `timeout`，或明确在 0176 里写“新连接方式不再使用 300 秒上限”。

---

## 推测 / 未核实

- **needrestart 主配置是否包含 conf.d**：未核实；按提交说明在 VPS 上实测通过，推断包含。
- **`fib daddr type local` 在 `inet` 表里对 IPv6 本机地址的匹配行为**：未核实。安装时 `nft -c` 只校验语法；Runbook 预检要求人工看到规则，但没有自动用例证明 IPv6 公网地址会被拦。建议在 VPS 上补一次 `gh-runner` 身份连 IPv6 本机端口的负向验证。
- **`NODE_SHA256` 是否对应 Node 22.22.3**：无法离线核对，未核实。
- **bwrap 版测试在 macOS 开发机上会失败**：推测。旧版用 `unshare`，macOS 也没有；不是本 PR 引入的回归，但意味着这些用例事实上只能在 Linux CI 上跑。
- **`prepare-vps.sh` 在非 OVH 原名主机的行为**：硬编码 `ORIGINAL_HOSTNAME=vps-482b8c36`，换机器会以 68 拒绝；这是有意还是遗漏，未核实。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本 PR 没有改任何生产请求构造代码：`packages/prompt-catalog/src/runtime.ts` 在 base..head 的 diff 为空，系统提示、工具定义、历史消息、遮盖逻辑都没有变化。唯一与模型文本相关的改动是 `test/integration/production-http-composition-process.test.ts` 的断言，它只读取/检查请求，不改变发给模型的内容。也没有把会变的值挪进开头：测试本身仍断言“只在末尾追加、head 不变”（测试名就是 `stops a tool loop by appending one message, keeps the head unchanged`）。`.agents/reviews/...prompt.md` 是复核用提示词，不是产品请求，不适用该规则。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会（就产品请求而言）。** 本 PR 不构造模型请求。CI 侧新增的 `upgradeRunnerLabel` 用 `structuredClone` 后按固定顺序改写，`policySha256` 仍按基准原始字节计算（`check-policy.mjs:1046`），不存在时间字段或无序集合参与序列化。唯一带时间/环境相关数据的是 `.agents/reviews/.../usage.jsonl` 和 VPS 上的 needrestart/防火墙配置，它们不进入产品模型请求。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**部分有。**
- 标签升级：有正反用例（`policy.test.mjs:751-796`）。如果删掉 `upgradeRunnerLabel`，`[HR-11] 基准上恰好是 hermes-home…` 会失败；混写、未暂停 macOS、时限不对三个反向用例也会失败。工作流残留 `hermes-home` 的用例会失败。
- runner 脚本：`ci-runner-scripts.test.mjs` 覆盖注册标签、暂停/恢复、slice、service 模板、防火墙字符串。
- **缺口**：`prepare-vps.sh` 完全没有自动测试，needrestart 的反向验证只在提交说明里手工做；防火墙 `fib` 只有字符串断言，没有语义测试；集成测试的提示词改动由该测试自身兜底，没有额外门槛。
- 因此不能笼统回答“反向用例都会失败”：**标签相关会；prepare-vps 相关不会在 CI 里失败**。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下（生产端 → 消费端）：

- **`linuxRunnerLabel = "ci-vps"`**（`contracts.mjs:7`）：被 `check-policy.mjs`（校验/升级）、`main-workflow.mjs`（`runs-on` 校验）、`ci-runner-scripts.test.mjs` 使用。`ci/policy.json` 全部 Linux 成员已是 `ci-vps`，`policy.schema.json` 的 enum 已改，`ci.yml`/`main.yml` 的 `runs-on` 已是 `ci-vps`，`.github/actionlint.yaml` 已列 `ci-vps`。两端（策略矩阵与 workflow matrix 的 canonical JSON）在 `validateWorkflow` 里逐项比较，能互相接受。**结论：一致。**
- **`RUNNER_LABEL=ci-vps`**（`runners.sh:3`）：被 `register-runner.sh` 的 `--labels "$RUNNER_LABEL"`、`mac-runners.sh` 的 `LABEL=$RUNNER_LABEL`、`runner-pause.sh` 的提示使用；GitHub 标签约束接受连字符。**结论：一致。**
- **runner 名 `ci-vps-1`/`ci-vps-2`**（`runners.sh:12,19`）：由 `register-runner.sh --name` 注册，由 `runner-pause.sh --list` 输出、`mac-runners.sh reconcile_runners` 与 GitHub 名单对账。测试覆盖对账失败、少装、多装、标签不符。**结论：一致。**
- **`RUNNER_HOST=ci-vps`**：被 `require_runner_host`（install/register/uninstall）、`mac-runners.sh vps()` 的主机名检查、错误信息使用；但 `prepare-vps.sh` 另有独立的 `CI_HOSTNAME=ci-vps`。**两端能接受，但没有一致性测试**（见第 6 条）。
- **`RUNNER_CONTROLLER=ubuntu`**：被 `runner_sudoers_line` 写入 `/etc/sudoers.d/91-gh-runner-control`，被 `runner-pause.sh`/`runner-resume.sh` 的 `sudo -n systemctl ...` 使用；VPS 上 `ubuntu` 存在且有 sudo。**结论：一致；但作者说法错误**（见第 4 条）。
- **内存值 14G/15G、19G/20G**：`gh-runner.service.in`、`gh-runners.slice`、ADR 0176、Runbook 预检数字（15032385536/16106127360、20401094656/21474836480）和测试全部对得上。**建议：** 测试名“14 GB together”应改（第 8 条）。
- **防火墙 `fib daddr type local`**：`runner_firewall_rules` 生成，`install-runner.sh` 用 `nft -c` 校验后加载，`gh-runner-nft.service` 执行；Runbook 预检要求人工看到。**语法接受；语义（尤其 IPv6）未核实。**
- **`policySha256`**：`resolvePolicySource` 在升级前按原始字节计算（`check-policy.mjs:1046`）。消费端 `context.mjs`、`main-evidence.mjs:164`、`aggregate.mjs`、`export-evidence.mjs` 都只做“各作业之间是否相同”的比较。本 PR 会触发 `main-evidence` 的 `MAIN_VALIDATION_CHANGED`（因为它改了 `.github`/`ci`/`scripts/ci`），主分支确认会走 full 而不是 light，因此不会拿升级后的策略去和旧哈希做 `MAIN_POLICY_MISMATCH`。**结论：当前路径一致；升级后的有效策略与哈希不对应是有意为之，ADR 已写明。**
- **`prepare-vps.sh` 的 needrestart 值**：写入 `/etc/needrestart/conf.d/50ci-vps-gh-runner.conf`，由 needrestart 消费；脚本内的核对消费同一 `$nrconf{override_rc}`。**主配置是否加载 conf.d 未核实**（第 5 条）。

---

**总结**：没有确认的高严重度缺陷。最值得处理的是 ADR 0169 过期、`prepare-vps.sh` 缺少自动/可复跑的反向检查、以及作者关于 sudo 对象和“只为新机器改测试”的两处说法与代码不符。
