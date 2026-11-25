<a id="test-and-production-hosts"></a>
# 测试主机与生产主机

当 `DELIVERY_MODE` 写着 `fast` 时，[交付模式](delivery-mode.md#fast-mode) 替换下文中关于运维上线包、验收例外和每次上线授权的规则，它的生产访问规则解除对 root 和生产账号、`/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 以及生产服务的禁令，但仅限于上线、回滚和诊断，每次上线或回滚的授权方式见交付模式；测试运行仍然绝不使用它们，其他主机边界不变。

逐步操作流程（连接、目录布局、临时目录根、运行方式、监控、清理）见 [测试主机运维 Runbook（操作手册）](../../docs/runbooks/test-host-operations-runbook.md)。硬边界如下：

- 绝不在用户的 MacBook 上运行 Himawari 服务器端的测试：不做 Node 这一侧的构建，不跑 `npm run check`、`npm test`、任何 Vitest 项目或产品路径资格验证。发现那里有这类进程在运行时要停止它。
- 例外只有苹果客户端（`clients/apple/` 下的 iPhone、Apple Watch、Mac App 和它们的扩展）：它们的构建、单元测试和装到 Andy 的设备上，在 Andy 的 Mac 上用 Xcode（苹果的开发工具，只能在 Mac 上运行）做，因为没有别的机器能做。这个例外不包括任何服务器端的命令；客户端测试要连服务器时，连 Hermes 测试机，不在 Mac 上起 Himawari 服务。依据 [ADR 0229](../../docs/adr/0229-native-apple-clients-and-device-api.md#decision) 决定第 8 条（Andy 2026-11-11：“同意改写”）。
- 第 0-4 层在 Hermes 上运行，或在云服务器 `84.247.157.41` 上以普通账号 `himawari-ci`（uid 1001，无 sudo）在 `/srv/himawari-ci/` 下运行；在那里做例行测试工作不需要再请示。绝不使用 root 或生产账号，绝不读取生产机密，绝不触碰 `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari` 或生产服务（不停止、不重启、不发请求）。任何需要 sudo、或会改变 Hermes 系统设置或服务的事，都以可执行脚本的形式交给用户，并解释每一步。
- 在云服务器上，每次重负载运行之前、运行期间每 30 秒、以及运行之后，都用只读查询观察 `himawari-prod.service`；如果它不再是 `active`、它的重启次数增加，或测试账号记录到一次 `oom_kill`，立即停止运行，保留记录，并告诉用户；绝不提高限额。
- `himawari-ci` 的结果绝不能代替生产上线的受限主机验收或签名。第四次及以后的上线没有长期有效的验收例外：它冻结的运维上线包（安装、用户/权限、签名、验收、清理、服务启动）需要用户本人授权。
- 检出放在 NVMe 根盘上，测试输出放在检出的 `.ci-output/` 里，证据放在 `/data` 上，临时文件放在一个 10 字节长的 `mktemp -d /tmp/hXXXX` 根目录中，并把它作为 `HIMAWARI_TEST_TEMP_ROOT` 和 `TMPDIR` 传入；用 `umask 022` 运行；每次运行后归还根盘空间，并解释任何不足。细节和理由见该 Runbook。
- 每次对比测量都以 `.ci-output/handoff/scripts/require-quiet-host.sh hermes|cloud` 开始，只有在出现 `QUIET_HOST_OK` 之后才运行；证据中缺少这一行的对比结果，Claude 一律拒收。
- 不要放宽测试时限，也不要设置 `HIMAWARI_TEST_TIMEOUT_MS`；测试主机上的超时是一个需要诊断和修复的缺陷。
- Hermes 上还运行着无关的服务，包括 `/data/hermes/himawari/releases/` 下现有的 Himawari 服务；测试不得读写它们的目录或数据，也不得停止或重启它们。
- Mac 仍然是受支持的产品平台（指在 Mac 上安装和运行 Himawari 服务本身；苹果客户端里的 Mac App 属于上面第二条的例外，不受这一条限制），但用户已无限期推迟了所有 Mac 验证：在用户恢复之前，不要安排或提议在 Mac 上运行，并把 Mac 上的行为报告为未验证。恢复之后，Mac 专属的验证（macOS 沙箱、Mac 安装程序、Mac 自带的 Bash，以及其他只在 Mac 上出现的运行时行为）只有在改动影响 Mac 专属行为时或在发布之前，才在 MacBook 上运行，并且只有在用户批准了这一次具体运行、它的范围、预计时长和时间安排之后才运行。
- CI 不再用自己的服务器：全部跑在 GitHub 的免费标准托管机器上（[ADR 0292](../../docs/adr/0292-how-ci-runs-now.md)）。CI 的结果不能代替 Hermes 上合并前的本地检查，也不能代替生产机上的验证。
- 生产运行在云服务器 `84.247.157.41` 上；那里的每一次生产上线，以及每一次启动或变更生产服务，都需要用户对该次上线的明确授权。
- 在 Mac 上只读查看生产机（这是上面「绝不使用 root 或生产账号」那条的例外，只在 `DELIVERY_MODE` 写着 `fast` 时适用，范围就是下面这个固定入口；服务状态、日志、磁盘、数据库里的运行状态（含 `tables`、`columns`、`rows`），以及三个固定查询：`rule-memories`（规则类记忆的元数据，不含原话）、`system-instruction`（生产配置里的 `runPolicy.systemInstruction` 一个字段，不含配置其余部分）和 `gmail-decisions`（最近 100 条 Gmail 决策记录的元数据：结果、评价、规则数、记忆数、Muse 配对数，不含邮件和记忆正文）；Andy 2026-11-09 在项目线程里同意读前两个固定查询，并在 P1-5 里选了“读生产机上的真实记录”来挑演示用的那条决策，范围不扩大到配置文件的其他内容）时，用 `bash scripts/operations/prod-read.sh <查询>`，不要写 `ssh root@84.247.157.41 "<任意命令>"`：脚本只接受固定的几种查询，参数用严格的正则校验，数据库只以只读方式打开；用法见脚本的 `usage`，测试在 `test/tooling/prod-read.test.mjs`。要改生产数据或服务，仍按上面的授权规则。
- 一个平台的结果绝不能代替另一个平台：Mac 和 Linux 不能互相验证；Hermes（Ubuntu 22.04，bwrap 0.6.1）在时序、并发或沙箱方面的结论不能代表生产服务器（Ubuntu 24.04，带有 AppArmor 对用户命名空间的限制）；`himawari-ci` 的结果只说明测试账号自己在 Ubuntu 24.04 上的安装，而不是经过验证的生产安装；2026-10-14 之前的云服务器测试结果只作为历史记录。

<a id="hermes-test-server-connectivity"></a>
## 连接 Hermes 测试服务器

- 每条 Hermes 命令都通过 `.ci-output/handoff/scripts/hermes-ssh.sh '<command>'` 运行，每次上传都通过 `.ci-output/handoff/scripts/hermes-upload.sh <local file> <remote path>` 进行；绝不直接对 Hermes 调用 `ssh`、`scp`、`sftp` 或 `rsync`。这两个包装脚本经 Tailscale（一种组建私有网络的工具）连接（`ProxyCommand=none`，`HostName=100.64.53.104`），检查远端主机名是 `hermes-home`，把单次调用限制在 300 秒内，并且在受保护的第 3 层或第 4 层运行进行期间只允许只读命令，因为 Hermes 上的任何其他进程都会使那次运行作废。`hermes_direct_ssh_guard.py` 这个 PreToolUse 钩子（在工具调用前运行的检查）会拒绝直接调用（[教训](../../docs/lessons.md#measurement-not-isolated)）。Tailscale 不可用时，向用户报告，而不是手动改走 `hermes-ssh` 技能的 Cloudflare 线路。工具链的 `PATH`、环境变量、`umask 022` 以及用 `git bundle` 同步代码的方法，见[测试主机操作 Runbook](../../docs/runbooks/test-host-operations-runbook.md#live-state-preflight)。
- 新的下载，包括更新版本的工具链或 bubblewrap（一种沙箱工具），都需要先得到用户批准。不得在服务器上编辑代码。
- 不得为绕过故障而修改 SSH 配置、凭据、Cloudflare 设置、防火墙或主机密钥校验；要向用户报告。
