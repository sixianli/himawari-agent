## 复核结论

未发现高严重度的代码缺陷。发现的问题集中在“第 3 个检查 runner 加入后手册没改全”和 `arm-fallback.sh` 的两处边界/错误路径。以下结论均基于读代码；我未能运行测试或文档校验（工具限制），测试是否实际通过、`contract_sha256` 是否正确属于 **未核实**。

---

## 发现（按严重度从高到低）

### 中 1：手册多处仍按“两个检查 runner / 三个 runner”写，维护命令会漏掉 `gh-runner-3`

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:308,310,294,270,272`
- 问题：代码里 CI VPS 有四个 runner（1、2、6 为检查 runner，3 为汇总），但手册这些地方仍只列 1、2、gate。作者说“补全第 3 个检查 runner、统一叫法”，这一条没有完全做到。
- 证据（我亲自读到）：
  - `:308`：`只能清 /srv/gh-runner/runner/_work、/srv/gh-runner-2/runner/_work、/srv/gh-runner-gate/runner/_work 下没有任务在用的旧目录`（漏 `/srv/gh-runner-3/runner/_work`）
  - `:310`：`等三个 runner 都空闲再 sudo systemctl restart gh-runner gh-runner-2 gh-runner-gate`（漏 `gh-runner-3`，且应为四个）
  - `:294`：`gh-runner、gh-runner-2 或 gh-runner-gate 出现了自己以外的组`（漏 `gh-runner-3`）
  - `:270`：删掉汇总 runner 后写 `两个检查 runner 的内存上限仍是 18 GB`，实际还有三个检查 runner 共用 `gh-runners.slice`
- 建议：把上述行统一改成包含 `gh-runner-3` / `/srv/gh-runner-3`，并把“两个/三个”改成实际数量；这是 critical 手册，改完后应重新封存。

### 中 2：手册的位置清单和应急脚本清单漏第 3 个检查 runner 与 `arm-fallback.sh`

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:46,47,48,51,127,187`
- 问题：
  - `:46-48` 家目录、`disk.log`、hooks 三行只列 `/srv/gh-runner`、`/srv/gh-runner-2`、`/srv/gh-runner-gate`，漏 `/srv/gh-runner-3`。而 `install-runner.sh:85-86,99` 会为编号 6 建这些目录。
  - `:51` 的“暂停、恢复、应急脚本”入口只列 `pause-runners.sh`、`resume-runners.sh`、`gate-fallback.sh`，并说“前两个每次用 scp”；本次 `arm-fallback.sh` 也新增了 `scp`/`ssh`，但完全没出现在清单里。
  - `:127`：`按 needrestart 的规则核对三个 runner 服务都不会被重启`；`prepare-vps.sh:39` 实际核对四个 unit（含 `gh-runner-3.service`）。
  - `:187`：`两个检查 runner 读不到`；现在有三个检查 runner。
- 证据：
  - `install-runner.sh:39`：`for my $unit (qw(gh-runner.service gh-runner-2.service gh-runner-3.service gh-runner-gate.service))`
  - `install-runner.sh:85-86`：为每个 `RUNNER_ROOT` 建 `hooks/home/logs`
- 建议：位置表补 `/srv/gh-runner-3`；入口清单补 `arm-fallback.sh` 并注明它会 `scp`/`ssh` CI VPS；数量表述改为实际值。

### 低 3：Rollback “只卸第 2 个 runner”的描述与 `uninstall-runner.sh` 不符

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:257,260`
- 问题：手册说卸掉 2 之后“按剩下的第 1 个 runner 重新生成防火墙规则和窄 sudo 规则”，并验证“规则里只剩 `gh-runner` 的 uid”。但代码会按所有仍存在的账号重建。
- 证据：
  - `uninstall-runner.sh:59`：`apply_runner_controls || LEFT="$LEFT firewall-and-sudo-rules-not-rewritten"`
  - `runners.sh:144-151` 的 `installed_runner_ids` 遍历全部 `RUNNER_IDS`；`runners.sh:289-297` 按这些 id 收集所有 uid。
  - 所以只卸 2 时，若 3、6 仍在，防火墙和 sudo 规则仍包含 `gh-runner-gate`、`gh-runner-3`。
- 建议：改成“按仍装着的 runner 重建”，验证项改为列出所有剩余账号的 uid；同时 `:272` 的在线验证也应考虑 `ci-vps-3`。

### 低 4：`arm-fallback.sh on` 在发现“未安装 runner 仍带 ci-arm”之前已经写入标签，失败后处于部分生效状态

- 文件：`scripts/operations/ci-runner/arm-fallback.sh:59-67`
- 问题：`on` 先给 `FALLBACKS` 加标签，再用 `carrying` 遍历全部 `CHECKS` 做最终核对。若某个“未安装但 GitHub 上还留着”的检查 runner 带着 `ci-arm`，前面的加标签已经发生，然后才报错退出。
- 证据：
  ```bash
  59  for name in $FALLBACKS; do
  61    add_label "$(runner_field "$TABLE" "$name" 1)" "$RUNNER_ARM_LABEL" || ...
  63  TABLE=$(github_runners) || TABLE=""
  64  [ "$(carrying "$TABLE")" = "$(echo $FALLBACKS)" ] || {
  65    echo "ARM_FALLBACK_FAILED $RUNNER_ARM_LABEL is on:... but should be on:$FALLBACKS; run arm-fallback.sh on again, or off to undo"
  66    exit 1
  ```
- 影响：命令返回失败，但 `ci-vps-1/2` 可能已经被加上 `ci-arm`，ARM 作业实际会被 VPS 接走。该分支消息没有声称“labels untouched”，并提示用 `off` 撤销，所以可恢复；但与其他“先检查、失败不动标签”的路径不一致。
- 建议：在加标签前先预检 `carrying "$TABLE"` 是否为空或已等于 `FALLBACKS`；或在最终核对失败时把本次新加的标签回滚。

### 低 5：没有任何已装检查 runner 时，`off` 无法清掉“已卸但仍留在 GitHub”的 `ci-arm`

- 文件：`scripts/operations/ci-runner/arm-fallback.sh:36`；`docs/runbooks/ci-vps-runner-runbook.md:199`
- 问题：`off` 在 `FALLBACKS` 为空时直接退出，无法执行后面基于 `CHECKS` 的清理。而手册写“`off` 会去掉所有检查 runner 身上的 `ci-arm`，包括已经卸掉、但 GitHub 上还留着的”。
- 证据：
  ```bash
  36  [ -n "$FALLBACKS" ] || { echo "ARM_FALLBACK_FAILED $RUNNER_HOST has no check runner installed; labels untouched"; exit 1; }
  ```
  `CHECKS` 虽包含未安装的检查 runner，但第 36 行在进入 `off` 删除循环之前就退出了。
- 影响：只有“三个检查 runner 全部卸载”的极端场景才触发；此时残留 runner 是离线状态，通常接不到作业，故严重度低。但它与手册的“所有、包括已经卸掉”表述有边界冲突。
- 建议：手册补上“一个检查 runner 都没装时 `off` 也拒绝”；或让 `off` 在 `FALLBACKS` 为空时仍按 `CHECKS` 清理 GitHub 标签。

### 低 6：新增的 VPS 上传/读取失败路径没有自动检查，测试也没有真正跑 `runner-pause.sh --list`

- 文件：`test/tooling/ci-runner-scripts.test.mjs:304-320`；`scripts/operations/ci-runner/arm-fallback.sh:18-20`
- 问题：`upload_runner_scripts` 失败、`vps ... --list` 失败这两条新错误路径没有测试。测试里的假 `ssh` 用 `*--list) cat "${R}/vps-names"` 直接输出固定文件，不会执行真实的 `runner-pause.sh --list`，所以“生产者输出格式”和“消费者匹配格式”没有端到端校验。
- 证据：
  ```bash
  18  upload_runner_scripts || { echo "ARM_FALLBACK_FAILED labels untouched"; exit 1; }
  19  NAMES=$(vps "bash $REMOTE/runner-pause.sh --list") || { ...; exit 1; }
  ```
  测试侧：`*--list) cat "${R}/vps-names" ;;`
- 建议：增加 `scp` 失败、`--list` 失败两个用例，断言不调用任何 `/labels`；可再用假的 `systemctl`/`id` 在沙箱里真正执行一次 `runner-pause.sh --list` 并喂给 `arm-fallback.sh`。

---

## 读代码证实 / 推测 / 未核实

**读代码证实：**
- 上述 1、2、3、4、5、6 的代码路径和文字均来自我亲自读到的文件内容。
- `CHECKS` 只包含 `RUNNER_LABEL == RUNNER_CHECK_LABEL` 的编号（vps 下是 1、2、6）；`runner_select 3` 是 gate，4、5 属 arm site，因此 `on` 只动 `FALLBACKS`，`off` 的 `carrying` 只遍历检查 runner，不会动汇总 runner 或 ARM 机器上的 runner。
- `take_lock` 在 `upload_runner_scripts` 之前执行，`pause-runners.sh`、`resume-runners.sh`、`gate-fallback.sh`、`arm-fallback.sh` 共用同一把 vps 锁；本次上传的三个文件与暂停脚本上传的是同一组文件。
- `runner-pause.sh --list` 只输出“账号存在且 unit 已启用”的 runner（`runner-pause.sh:8-14`），`arm-fallback.sh` 用精确词匹配消费，未使用 `eval`。

**推测（未运行验证）：**
- 若 `ci-vps-3` 曾在应急时带上 `ci-arm`、之后被卸载但没运行 `off`，下一次 `on` 会先给 1、2 加标签，再因残留的 `ci-vps-3` 报错退出；这是从第 59-66 行路径推断的，未实测。
- 锁目录默认在当前工作目录的 `.ci-output/` 下，因此同一台机器上不同工作副本并发运行不被同一把锁拦住；这是既有设计，不是本次引入。

**未核实：**
- `contract_sha256: "sha256:6038..."` 是否与 `scripts/operations/ci-runner` 目录当前内容一致（仓库里没有 `runbook.py`/`validate_docs.py`，无法计算）。
- 测试是否通过；`npm run check`、`check:platform-assumptions` 是否无新增错误。

---

## 侧重检查

- **错误路径**：`upload_runner_scripts`、`vps --list`、`github_runners` 三个前置步骤失败都在改标签之前退出，并打印 `labels untouched`，这一点正确。唯一例外是 `on` 最终核对失败时已经加过标签（发现 4）。
- **不合规范/不可信输入**：远端 `--list` 的内容只用于 `case` 字符串匹配和打印；参与 `add_label`/`remove_label` 的名字和标签来自本地 `runners.sh` 常量，未发现命令注入。`$REMOTE` 来自本地环境变量，属既有信任边界。
- **安全**：`ssh`/`scp` 使用 `BatchMode=yes`、`ConnectTimeout=20`、`ServerAliveInterval=15`，远端 `--list` 不需要 sudo；未发现密钥或令牌进入命令行。`arm-fallback.sh` 明确拒绝 `RUNNER_SITE=arm`，不会误改 ARM 机器。
- **资源耗尽**：循环都基于固定 `RUNNER_IDS`/`CHECKS`，没有随远端输入增长的循环；SSH 命令本身没有整体超时，只有连接和 keepalive 超时，属既有行为。
- **不可撤销操作**：加/去标签可逆；`scp` 覆盖的是仓库里的三个脚本，重复执行幂等；没有删除操作。
- **锁和上传的相互影响**：`take_lock` 先于上传，暂停/恢复/应急共用同一把锁；同一工作副本内不会互相穿插。跨工作副本的并发不在锁的保护范围内（既有问题）。
- **规则/文档一致**：模型提示开头规则不受影响；手册与代码不一致处已列在上面的发现 1、2、3。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮增量只改 `scripts/operations/ci-runner/arm-fallback.sh`、`docs/runbooks/ci-vps-runner-runbook.md`、`test/tooling/ci-runner-scripts.test.mjs` 和 review 记录，均不参与系统提示、工具定义、历史消息或出口遮盖的构造。按 `prompt-prefix.md` 第 4 条，发给模型的内容仍是只追加；本改动没有在最后一条消息之前插入任何每轮会变的值。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。改动不涉及提示词、JSON 序列化、遮盖规则或时间字段。新出现的 `NAMES`/`CHECKS`/`FALLBACKS` 只用于 CI 运维脚本的字符串匹配和 GitHub API 调用，不会进入模型请求。即使看集合顺序，`CHECKS` 也是按固定 `RUNNER_IDS="1 2 3 6"` 生成，但这对模型字节没有影响。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有主要行为检查：
   - `not installed` 跳过：测试 2331-2361；
   - 已装但 GitHub 缺失时 `on`/`off` 都拒绝且无 `/labels` 调用：2364-2382；
   - `off` 清掉已卸但 GitHub 上仍有记录的 runner：2383-2398；
   - `on` 遇到未安装 runner 带 `ci-arm` 时失败：2399-2416；
   - 临时目录清理断言改查 `tmp.*`，与 `install-gate-remote.sh:46,52,68,83` 的 `mktemp -d` 一致：2625。
   按代码逻辑，这些反向用例对旧实现会失败（旧 `carrying` 只遍历 `FALLBACKS`，旧 `off` 不会碰未安装 runner；旧断言前缀 `gate-remote-check` 永远为空，属于空检查）。**但测试未实际运行**，且新增的 scp/`--list` 失败路径没有测试（发现 6）。

4. **每个新产生/修改的值，生产处和使用处两端都能接受吗？**
   - `NAMES`：生产处 `runner-pause.sh:8-14` 输出 `RUNNER_NAME` 行；使用处 `arm-fallback.sh:19,28-30` 做 `case` 精确词匹配，格式兼容。
   - 标签值 `ci-arm`：生产/使用都在 `runners.sh:15` 和 `arm-fallback.sh` 的 `has_label`/`add_label`/`remove_label` 中，`remove_label` 的 id 来自 GitHub `TABLE` 第 1 列，能通过 `gh api .../runners/<id>/labels/<label>` 的格式。
   - 注册编号 `6`：手册 `<1|2|3|6>` 被 `register-runner.sh:11-18` 和 `uninstall-runner.sh:11-15` 接受；`runner_select 6` 在 `runners.sh:76-82` 存在。
   - 错误文本 `not installed on ci-vps, left out:`：代码、测试、手册一致。
   - `contract_sha256`：值已改，但产生方（封存工具）和使用方（文档严格校验）不在仓库内，**未核实**是否匹配。
   - 唯一两端不一致的是手册中遗漏 `gh-runner-3` 的描述（发现 1、2、3），属于文档端没跟上代码。
