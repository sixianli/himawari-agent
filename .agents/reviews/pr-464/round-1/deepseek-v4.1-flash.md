## 读代码证实的发现（按严重度）

### 1. 中：`arm-fallback.sh on` 现在依赖 `ci-vps-3` 存在；runner 6 未安装或已单独卸载时，应急路径直接失效

- 文件:行：`scripts/operations/ci-runner/arm-fallback.sh:19-27`
- 问题：`FALLBACKS` 从 `RUNNER_IDS` 中所有检查 runner 生成，而 `RUNNER_IDS` 已变成 `1 2 3 6`。随后脚本要求每一个 `FALLBACKS` 名字在 GitHub 上都恰好有 1 个。runner 6 尚未安装，或按本 PR 文档执行过 `uninstall-runner.sh 6` 之后，`ci-vps-3` 为 0 个，脚本以退出码 1 拒绝，ARM 机器宕机时的应急 fallback 无法开启。
- 证据：
  ```bash
  for id in $RUNNER_IDS; do
    runner_select "$id"
    [ "$RUNNER_LABEL" = "$RUNNER_CHECK_LABEL" ] && FALLBACKS="$FALLBACKS $RUNNER_NAME"
  done
  ...
  COUNT=$(runner_field "$TABLE" "$name" 1 | grep -c .)
  [ "$COUNT" = 1 ] || { echo "ARM_FALLBACK_FAILED GitHub has $COUNT runners named $name; labels untouched"; exit 1; }
  ```
  `runners.sh:1` 是 `RUNNER_IDS="1 2 3 6"`。
- 建议：用机器上实际已安装/已注册的检查 runner 生成 `FALLBACKS`（例如基于 `installed_runner_ids`），至少允许“只把标签加到存在的检查 runner”；若必须要求全部存在，则文档要明确“先安装 runner 6 才能用 ARM 应急”，并加 `ci-vps-3` 缺失时的反向测试。

### 2. 中：Runbook 的“全部卸载”和验证仍只覆盖三个 runner，漏掉 `ci-vps-3`

- 文件:行：`docs/runbooks/ci-vps-runner-runbook.md:277-279`（另见 `:52`、`:107`、`:210`、`:212`、`:231-233`）
- 问题：代码已经让 `uninstall-runner.sh all` 删除 4 个 runner（`RUNNER_IDS="1 2 3 6"`），但 Runbook 仍写“三个 runner / 三个账号 / 删除 `/srv/gh-runner/`、`/srv/gh-runner-2/` 和 `/srv/gh-runner-gate/`”，验证步骤也只要求 GitHub 上删掉 `ci-vps-1`、`ci-vps-2`、`ci-vps-gate`。这会让操作者漏删 GitHub 上的 `ci-vps-3`、漏核对 `/srv/gh-runner-3`。服务列表、重启命令、journal 和隔离验证也都只列 1/2/gate。
- 证据：
  ```text
  :277 ... 再删除三个用户和组。
  :278 3. 在 Mac 上按“只卸第 2 个 runner”的第 3 步从 GitHub 删除 `ci-vps-1`、`ci-vps-2` 和 `ci-vps-gate`。
  ```
  代码对应为 `runners.sh:1` 的 `RUNNER_IDS="1 2 3 6"`，以及 `uninstall-runner.sh:13` 的 `*:all) REMOVE=$RUNNER_IDS`。
- 建议：在全部卸载、验证、Preflight 的服务列表、重启命令和 journal 检查中统一补上 `ci-vps-3`/`gh-runner-3.service`/`/srv/gh-runner-3`，并更新 GitHub 删除清单。

### 3. 中：CI 策略校验仍写死 `collect` 命令，新的 `--remote-jobs` 无法通过校验

- 文件:行：`scripts/ci/check-policy.mjs:538-545`
- 问题：`run-share.mjs` 新增了 `--remote-jobs`，但 `check-policy.mjs` 对 `ci/required` 的收集步骤做的是字符串全等比较，不允许多出这个参数。后续工作流一旦按设计写成 `collect --to ... --remote-jobs ...`，`npm run check:ci-policy` 会失败，ARM 报告拉取功能无法真正启用。
- 证据：
  ```js
  (step) =>
    step.run ===
      ".ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports" &&
    step.env?.CI_NEEDS === githubExpression("toJSON(needs)") &&
    step.if === undefined,
  ```
  而 `scripts/ci/run-share.mjs:152-159` 已将 `--remote-jobs` 加入允许参数。
- 建议：把策略校验改为“命令以固定前缀开头、可选地带一个经过格式校验的 `--remote-jobs` 参数”，并在 `test/tooling/policy.test.mjs` 加对应正反用例。本 PR 未改工作流，所以当前 CI 不会因此立刻失败，但这是下一个 PR 会踩到的接口不一致。

### 4. 低：ARM fallback 的 Runbook 文案与代码不一致

- 文件:行：`docs/runbooks/ci-vps-runner-runbook.md:199`
- 问题：文档写“把 `ci-arm` 标签加到 `ci-vps-1` 和 `ci-vps-2` 上”，代码还会加到 `ci-vps-3`。
- 证据：
  ```text
  :199 ... 把 `ci-arm` 标签加到 `ci-vps-1` 和 `ci-vps-2` 上 ...
  ```
  `arm-fallback.sh:19-21` 的 `FALLBACKS` 在 vps 下包含 1、2、6（`runner_select 3` 的 gate 标签不等于 `ci-vps`，被排除）。
- 建议：文档改成三个检查 runner，或明确说明只加 1、2 而代码不要包含 6；二选一，保持代码和文档一致。

### 5. 低：Runbook 的升级说明仍说改 `install-runner.sh` 里的 `SHA256`，该变量已移走

- 文件:行：`docs/runbooks/ci-vps-runner-runbook.md:208`
- 问题：文档写“改 `install-runner.sh` 里的 `VERSION` 和 `SHA256`”。现在 `install-runner.sh` 只有 `SHA256=$RUNNER_PACKAGE_SHA256`，真正的值在 `runners.sh`，而且按 x64/arm64 分成两个变量。照文档改会改错文件或只改一个架构。
- 证据：
  ```text
  :208 ... 要换安装脚本里固定的版本时，改 `install-runner.sh` 里的 `VERSION` 和 `SHA256` ...
  ```
  代码：
  ```bash
  # install-runner.sh:13-14
  SHA256=$RUNNER_PACKAGE_SHA256
  URL=https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-$RUNNER_PACKAGE_ARCH-$VERSION.tar.gz
  ```
  ```bash
  # runners.sh:13-14,30-31
  RUNNER_PACKAGE_ARCH=x64
  RUNNER_PACKAGE_SHA256=baebf...
  ...
  RUNNER_PACKAGE_ARCH=arm64
  RUNNER_PACKAGE_SHA256=670adb...
  ```
- 建议：文档改成同时更新 `runners.sh` 中两个架构的 `RUNNER_PACKAGE_ARCH`/`RUNNER_PACKAGE_SHA256`，`VERSION` 仍在 `install-runner.sh`。

### 6. 低：Runbook 的 slice 限额和两个“只卸第 3 个 runner”标题已过时/歧义

- 文件:行：`docs/runbooks/ci-vps-runner-runbook.md:110`、`:262`、`:267`、`:30`
- 问题：
  - `:110` 仍写 `gh-runners.slice` 的 `TasksMax=4096`，代码已改成 `6144`。
  - `:262` 新增“只卸第 3 个检查 runner”，`:267` 旧的“只卸第 3 个 runner”实际指 gate runner；阅读导航 `:30` 也只写“第 2 个或第 3 个”，现在两个“第 3 个”指代不同对象，容易按错命令。
- 证据：
  ```text
  :110 ... TasksMax=4096 ...
  :262 **只卸第 3 个检查 runner**：
  :267 **只卸第 3 个 runner**：
  ```
  ```ini
  # gh-runners.slice:9
  TasksMax=6144
  ```
- 建议：把 `:110` 改成 6144；把旧章节改名为“只卸 gate runner（原第 3 个 runner）”，导航同步。

### 7. 低：`install-gate-remote.sh check` 用可预测的 `/tmp` 文件名以 root 重定向

- 文件:行：`scripts/operations/ci-runner/install-gate-remote.sh:79`、`:85-86`
- 问题：root 在启动 `sudo -u` 前用 `2> "${TMPDIR:-/tmp}/gate-remote-check.$$"` 打开固定文件名。若主机 `/tmp` 上存在同名符号链接，root 的 shell 重定向会跟随链接并截断目标文件。CI runner 服务有 `PrivateTmp=yes`、runner 账号是 nologin，所以实际可利用面有限；但这是 root 写可预测路径的坏模式。
- 证据：
  ```bash
  ANSWER=$(sudo -u "$GATE_USER" ssh "${OPTIONS[@]}" "$TARGET" 1-1/connection-check 2> "${TMPDIR:-/tmp}/gate-remote-check.$$") || STATUS=$?
  ...
  rm -f "${TMPDIR:-/tmp}/gate-remote-check.$$"
  ```
- 建议：改用 `mktemp`（`umask 077`）并在 EXIT trap 清理；或改用固定目录如 `/run/gh-runner/`。

### 8. 低：`install-gate-remote.sh key` 在私钥存在但 `.pub` 丢失时不能自愈

- 文件:行：`scripts/operations/ci-runner/install-gate-remote.sh:45-53`
- 问题：只有私钥不存在时才生成一对钥匙。如果私钥在、`$KEY.pub` 被删，脚本不会重建公钥，随后 `awk ... "$KEY.pub"` 得到空值并以 `GATE_REMOTE_FAILED` 失败。重跑本应安全的安装步骤需要人工删除私钥。
- 证据：
  ```bash
  if [ ! -e "$KEY" ]; then
    ...
    ssh-keygen ... -f "$WORK/id_ed25519"
    install ... "$WORK/id_ed25519" "$KEY"
    install ... "$WORK/id_ed25519.pub" "$KEY.pub"
  fi
  PUBLIC=$(awk '{print $1 " " $2; exit}' "$KEY.pub")
  ```
- 建议：分别检查私钥和公钥；公钥缺失时从私钥重新导出（`ssh-keygen -y`），并验证导出结果符合 `KEY_PATTERN`。

## 推测 / 未核实

- `/tmp` 符号链接的实际可利用性取决于 CI VPS 上是否有不受信任的本机进程能写宿主 `/tmp`；代码模式已确认，攻击路径未实测。
- ARM64 runner 包 `670adb2f...` 是否对应 GitHub 上 2.338.2 的 arm64 包，当前环境不能联网，未核实。
- Runbook 的 `contract_sha256` 是否确实按新的 `scripts/operations/ci-runner` 目录重新封存，未运行文档校验器，未核实。
- `runName()` 允许任意位数的 attempt，而 `send-reports.py`/`remote-share.mjs` 的 run 正则只允许 attempt 最多 6 位；只有 retry 号达到 7 位才会不匹配，实际 GitHub 不会出现，暂按推测。
- 测试未实际运行（权限只允许读和 git 命令），以下对“测试会失败/通过”的判断来自读断言和代码。

## 侧重检查

- 错误路径与重跑：读了 `install-runner.sh` 的 ERR/INT trap 和 `restore_install_paths`，`install-arm-runners.sh` 的 8 步失败分支，以及 `uninstall-runner.sh` 的残留检查。安装失败回滚覆盖用户、组、新建目录、unit、防火墙和 sudo 规则，基本完整；`install-arm-runners.sh` 第 5 步“任一 runner 已运行就跳过安装”在仅一个 runner 被别人弄坏时不会自愈，属于边界情况。
- 不合规范/不可信输入：`send-reports.py` 的请求正则、`O_NOFOLLOW`、符号链接/硬链接/管道拒绝、路径段长度、文件数/单文件/合计/深度限制均读了；`remote-share.mjs` 的 target、run、name、base64、路径、大小、重复路径、超时和响应上限均读了；`install-gate-remote.sh` 的 target/host key/public key/IP 校验均读了。未发现路径穿越或明显绕过。
- 安全：`authorized_keys` 使用 `restrict,from="<VPS IPv4>",command="/usr/local/lib/gh-runner/send-reports"`，没有 pty/转发/agent；`known_hosts` 固定、`StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`、`GlobalKnownHostsFile=/dev/null`、`ClearAllForwardings=yes` 都在。钥匙文件 root 拥有、gate 组可读，非 root 使用不会触发 OpenSSH 的 owner 权限检查。发现上面第 7 条的 root 可预测临时文件问题。
- 资源耗尽：发送端 `MAX_FILES=500`、单文件 16 MiB、合计 64 MiB、深度 8；接收端响应上限 96 MiB、总时限 120 秒、连接 15 秒，且测试交叉核对了这些常量。`install-gate-remote.sh check` 本身没有输出上限，但远端强制命令只处理固定不存在的报告名，正常只返回几字节。
- 不可撤销操作：`uninstall-runner.sh all` 会删用户、组、目录和共享目录；ARM 分支确实包含 runner 4/5、`gh-ci-send`、`/srv/gh-runner` 和 `/usr/local/lib/gh-runner`。脚本行为完整，问题主要在 Runbook 未同步（第 2 条）。
- 规则/文档/代码一致：除上面列出的 Runbook 问题外，还发现 `check-policy.mjs` 与新 `--remote-jobs` 参数的接口不一致（第 3 条）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本 PR 改的是 CI runner 安装/卸载脚本、ARM 报告传输脚本、CI 测试和 Runbook，没有改系统提示、工具定义、历史消息或出口遮盖。`run-share.mjs`/`remote-share.mjs` 只处理 CI 作业之间的报告文件，不参与模型请求组装，也没有出现在 `packages/prompt-catalog` 或模型请求路径中。发给模型的内容仍然只在末尾追加；每轮会变的值（运行环境、时间等）不在此 PR 的改动范围内。依据 `.claude/rules/prompt-prefix.md` 第 4 条。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会影响模型请求。本次新增的序列化是 ARM 报告 JSON 和 CI 日志：`send-reports.py` 用 `sorted(os.listdir(...))` 排序，`json.dumps` 的键顺序固定；`remote-share.mjs` 按接收顺序写文件，不进入模型请求。runner 列表、标签、路径都是固定字符串或由固定脚本生成；安装时生成的 SSH 钥匙是随机值，但它只用于报告传输，不属于模型内容。没有发现依赖前后文的遮盖或带时间的模型字段。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：
   - `test/tooling/ci-runner-scripts.test.mjs` 覆盖 ARM/vps 的 site、runner 选择、unit 渲染、隔离目录、安装回滚、卸载 all、gate remote、arm fallback、bwrap 私有挂载和安装脚本重跑；
   - `test/tooling/remote-share.test.mjs` 覆盖请求格式、路径穿越、符号链接/硬链接/管道、文件数/大小/深度、非 JSON、路径/大小写重复、超时、超响应、已有目标不覆盖；
   - `test/tooling/run-share.test.mjs` 覆盖 `pulled` 返回值和缺失报告。
   读断言看，这些反向用例在实现被改坏时确实会失败。但存在缺口：没有“`ci-vps-3` 不存在时 `arm-fallback.sh on`”的用例；没有“VPS 上单独卸载 runner 6”的用例；没有“`check-policy` 接受 `--remote-jobs`”的用例；Runbook 的具体文字没有被自动检查，只检查封存摘要/链接。测试本身我未运行，只按代码和断言判断。
4. **每个新值的使用端都能接受吗？**
   - `RUNNER_IDS="1 2 3 6"`：`install-runner.sh`/`register-runner.sh`/`uninstall-runner.sh`/`runner-pause.sh`/`runner-resume.sh`/`clean-old.sh`/`installed_runner_ids` 都按它遍历，能接受；唯一不接受“6 缺失”的是 `arm-fallback.sh`（第 1 条）。
   - runner 6 的 `gh-runner-3`/`/srv/gh-runner-3`/`gh-runner-3.service`/`ci-vps-3`：`runners.sh` 产生，安装、注册、卸载、unit 模板、`prepare-vps.sh` 的 needrestart 名单、`gh-runner-nft.service` 的 `Before=` 都已加上，测试也覆盖，彼此一致。
   - ARM 的 `4 5`/`ci-arm`/`gh-arm-runners.slice`/arm64 包：`runners.sh` 产生，`register-runner.sh`、`uninstall-runner.sh`、pause/resume、clean 服务、install 脚本都通过 `RUNNER_SITE=arm` 使用，site 守卫能挡住跨站编号。arm64 校验值是否对应真实包未核实。
   - `RUNNER_SEND_PUBLIC_KEY`/`RUNNER_SEND_FROM`：`install-gate-remote.sh` 产生，`install-runner.sh` 用同一组正则再校验；`RUNNER_SEND_SCRIPT` 同时用于安装路径、`authorized_keys` 的 `command=` 和卸载路径，两端一致。
   - `RUNNER_REMOTE_SHARE` 与 `remote-share.mjs` 的 `REMOTE_SHARE_DIRECTORY`：两处都是 `/etc/gh-runner/remote-share`，测试交叉核对。
   - 远端请求的 `run`/`name`：`runName()`/`publishedMembers()` 产生，`send-reports.py` 和 `remote-share.mjs` 用相同形状的正则接收，正常值一致；仅 attempt 超过 6 位时理论不一致。
   - 远端文件路径：发送端只产生 `[A-Za-z0-9._-]` 的短路径，接收端 `safeRelativePath` 接受且拒绝绝对路径/`..`，两端兼容。
   - 大小限制：发送端和接收端各自定义但测试互相核对，一致。
   - `--remote-jobs` 参数：`run-share.mjs` 自己能接受，但 `scripts/ci/check-policy.mjs` 的精确命令校验不接受（第 3 条），这是目前唯一明确的“产生端能产生、消费端不接受”的接口问题。
   - `CI_SHARE_COLLECT ... pulled=N`：只加了可选后缀，未找到机器解析该行的消费者；Runbook 文字仍写 `CI_SHARE_COLLECT 8`，属于文档旧描述，不影响通过/失败判断。
