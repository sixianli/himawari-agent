我先看增量改动和关键文件。
# PR 464 第 2 轮复核结论

增量范围：`337a143d..f9a1ab39c`，只涉及 `arm-fallback.sh`、`install-gate-remote.sh`、运行手册和测试。下面先列问题，再按要求回答必答问题。

## 一、读代码证实的问题

### 1. 中：`arm-fallback.sh off` 会漏掉“列表里消失但曾带 ci-arm”的 runner，并仍报成功

**文件:行**：`scripts/operations/ci-runner/arm-fallback.sh:18-32, 68-77`

**问题**：`FALLBACKS` 只包含本次 `github_runners` 列出的检查 runner；`off` 的删除和最终校验都只遍历 `FALLBACKS`。如果某个 runner 在 `on` 之后从 GitHub 列表里消失（临时少返回、或注册记录被重建），它即使仍带着 `ci-arm` 也不会被扫到；脚本却以 0 退出并宣称“只接 ci-vps 作业”。

**证据**：

```bash
18: TABLE=$(github_runners) || { echo "ARM_FALLBACK_FAILED could not list runners ..."; exit 1; }
24:   COUNT=$(runner_field "$TABLE" "$RUNNER_NAME" 1 | grep -c .)
26:     0) UNREGISTERED="$UNREGISTERED $RUNNER_NAME" ;;
32: [ -z "$UNREGISTERED" ] || echo "not registered on GitHub, left out:$UNREGISTERED"
...
68: for name in $(carrying "$TABLE"); do
69:   remove_label "$(runner_field "$TABLE" "$name" 1)" "$RUNNER_ARM_LABEL" ...
...
75: LEFT=$(carrying "$TABLE")
76: [ -z "$LEFT" ] || { echo "ARM_FALLBACK_FAILED ..."; exit 1; }
77: echo "ARM_FALLBACK_OFF$FALLBACKS take only $RUNNER_CHECK_LABEL jobs"
```

`carrying()` 内部也是 `for name in $FALLBACKS`（第 35-38 行），所以不在 `FALLBACKS` 的 runner 永远不参与检查。第 32 行的提示虽然 `off` 也会打印，但退出码仍是 0，且第 77 行的总结语句对它不成立。

**建议**：`off` 不要只看 `FALLBACKS`。至少满足其一：
- `UNREGISTERED` 非空时 `off` 直接失败，并提示先人工确认/删除标签；或
- 重新拉全表后扫描所有仍带 `ci-arm` 的 runner，凡是不能确认属于本次 fallback 的都报告并失败；或
- 向 GitHub 全表求“带 ci-arm 的 runner 集合”，要求它等于 `FALLBACKS` 才算成功。

并为“`on` 之后某个 runner 从列表消失，再跑 `off`”补一条反向用例。

---

### 2. 中：`on` 只覆盖部分 runner 也会以 0 退出，接口临时少返回会被当成“还没注册”

**文件:行**：`scripts/operations/ci-runner/arm-fallback.sh:24-32, 42-63`

**问题**：`COUNT=0` 一律归为“未注册并跳过”，脚本没有任何本地安装清单或人工确认来区分“确实还没装的 ci-vps-3”和“GitHub 这次少返回了一个已注册 runner”。后者会造成应急只开在一部分 runner 上，`ARM_FALLBACK_ON` 仍以 0 退出；只有第 32 行一行提示，容易被当成正常输出忽略。

**证据**：

```bash
26:     0) UNREGISTERED="$UNREGISTERED $RUNNER_NAME" ;;
...
31: [ -n "$FALLBACKS" ] || { echo "... none of the CI VPS check runners is registered ..."; exit 1; }
32: [ -z "$UNREGISTERED" ] || echo "not registered on GitHub, left out:$UNREGISTERED"
...
59: [ "$(carrying "$TABLE")" = "$(echo $FALLBACKS)" ] || { ... exit 1; }
63: echo "ARM_FALLBACK_ON$FALLBACKS now also take $RUNNER_ARM_LABEL jobs (online:$ONLINE)"
```

运行手册也把它描述为正常路径（`docs/runbooks/ci-vps-runner-runbook.md:199`）。

**建议**：要么要求三个检查 runner 全部注册后才允许 `on`；要么加显式参数（例如 `--allow-missing ci-vps-3`）或交互确认，并在 `on` 成功信息里明确“只覆盖 N 个，未覆盖 X”。还可以在 Mac 侧调用一次 VPS 的 `runner-pause.sh --list`（脚本已有 `vps()`）核对“已安装但未注册”的集合，只允许跳过确实未安装的 runner。

---

### 3. 中：运行手册的 Preflight 和 Verification 仍有多处没有 ci-vps-3，与作者“已补上”的说法不符

**文件:行**：`docs/runbooks/ci-vps-runner-runbook.md:108, 111, 112, 235`（另有 45、61、65、66、134）

**问题**：作者说“Preflight、验证……补上 ci-vps-3”，但实际只改了 Preflight 第 4、7 项和 Verification 前三项。检查用户/进程/GitHub 状态时仍然看不到 ci-vps-3，检查作业的验证也仍只允许 `ci-vps-1`/`ci-vps-2`。

**证据**：

```text
108: 5. 用户没有多余的组：`id gh-runner`、`id gh-runner-2`、`id gh-runner-gate` ...
111: 8. ... 应看到 `ci-vps-1`、`ci-vps-2`、`ci-vps-gate` 都为 `online` ...
112: 9. ... `pgrep -u gh-runner ...; pgrep -u gh-runner-2 ...; pgrep -u gh-runner-gate ...`
235: PR 的检查作业在两个检查 runner 上运行并通过，... `Runner name` 是 `ci-vps-1` 或 `ci-vps-2` ...
```

同样，第 45 行的程序路径表、第 61 行的账号列表、第 65 行的“防火墙规则只对三个 runner 账号生效”、第 66 行、第 134 行“三个用户/三个 runner 的目录/三个服务文件”都仍是三个 runner 的旧描述。第 134 行与代码不符：`install-runner.sh` 循环 `RUNNER_IDS="1 2 3 6"`，会建四个账号/目录/服务。

**建议**：把这些条目统一改成四个 runner（或明确区分“三个检查 runner + 一个汇总 runner”），尤其 Preflight 第 5、8、9 项和 Verification 最后一条。

---

### 4. 中：手册第 67 行仍写“两个检查 runner / TasksMax 4096”，与代码的 6144 矛盾

**文件:行**：`docs/runbooks/ci-vps-runner-runbook.md:67`

**问题**：作者说“TasksMax 6144”，但只改了 Preflight 第 7 项（第 110 行）。第 67 行的资源说明仍是“两个检查 runner……最多 4096 个进程”。

**证据**：

```text
67: ... 两个检查 runner 的服务都放在 `gh-runners.slice` ... 最多 4096 个进程。
110: ... TasksMax=6144 ...
```

```ini
# scripts/operations/ci-runner/gh-runners.slice:9
TasksMax=6144
```

三个检查 runner × 每个 2048（`runners.sh:115`）= 6144，代码和 Preflight 是对的，第 67 行的叙述是错的。

**建议**：第 67 行改成“三个检查 runner……最多 6144 个进程”，并检查第 68、319 行“两个检查任务/改为只跑一个检查 runner”等旧描述。

---

### 5. 低：新增的“check 临时文件已清理”断言检查的是旧文件名，实际没有验证新 `mktemp -d` 目录被清掉

**文件:行**：`test/tooling/ci-runner-scripts.test.mjs:2573-2575`；`scripts/operations/ci-runner/install-gate-remote.sh:83-84`

**问题**：新实现把 ssh 报错写进 `mktemp -d` 生成的目录（测试里 `TMPDIR=box.root`，目录名是 `tmp.XXXX`），但测试仍只过滤旧前缀 `gate-remote-check`。这个断言恒为真，删掉 `trap 'rm -rf "$WORK"' EXIT` 也不会失败，无法覆盖作者声称的“退出时清理”。

**证据**：

```js
2573: expect(readdirSync(bad.root).filter((name) => name.startsWith("gate-remote-check"))).toEqual(
2574:   [],
2575: );
```

```bash
83: WORK=$(mktemp -d)
84: trap 'rm -rf "$WORK"' EXIT
```

**建议**：断言 `box.root` 下不再有 `tmp.*` 目录，或比较 `check` 前后目录列表；同时覆盖 `key` 的失败分支（`ssh-keygen -y` 失败后 `WORK` 被删）。

---

### 6. 低：帮助文字和手册里仍有旧的“两个/第 3 个 runner”叫法，与新的命名约定冲突

**文件:行**：`scripts/operations/ci-runner/arm-fallback.sh:11`；运行手册 `:143, :306, :320, :321`（另有 `:45, :136`）

**问题**：

- `arm-fallback.sh` 的 usage 仍写 “the two check runners”。
- 注册一节仍写 `register-runner.sh <1|2|3>`，而代码已接受 `1|2|3|6`（`register-runner.sh:11-17`）。
- Troubleshooting 第 320 行仍用“第 3 个 runner 停了”指汇总 runner；第 321 行“runners.sh 里第 3 个 runner 的三个内存值”也有歧义；第 306 行“第 3 个看 gh-runner-gate.service”同样容易和新命名的“第 3 个检查 runner（ci-vps-3）”混淆。

**证据**：

```text
11: usage: ... while the ARM machine is down; ...
143: ... `register-runner.sh <1|2|3>` ...
320: ... 第 3 个 runner 停了或掉线。...
321: ... 改 `runners.sh` 里第 3 个 runner 的三个内存值 ...
```

**建议**：统一称 `ci-vps-gate` 为“汇总 runner（编号 3）”、`ci-vps-3` 为“第 3 个检查 runner（编号 6）”；注册用法改为 `<1|2|3|6>`。

## 二、推测 / 未核实

- **推测（低）**：`install-gate-remote.sh:54` 的 `ssh-keygen -y -f "$KEY"` 假定私钥无口令。脚本自己创建的私钥是 `-N ""`，正常不会出问题；但如果运维替换成带口令的私钥，`ssh-keygen -y` 可能等待终端输入，而不是快速失败。建议加 `-P ""` 或在失败时明确提示。
- **推测（低）**：第 1 条的实际触发依赖 GitHub 返回“成功但不完整”的 runner 列表；`gh api --paginate` 多数失败会非 0，脚本第 18 行已处理。实际临时少返回无法在本环境复现。
- **未核实**：`contract_sha256` 已从旧值改为 `sha256:479a...`，但本环境不能运行 `validate_docs.py` 或 `runbook.py seal`，无法确认新摘要覆盖了本轮所有 `scripts/operations/ci-runner` 改动。
- **未核实**：`scripts/platform-assumptions.json` 的计数改动（`runners.sh` 1→2、新增 `remote-share.test.mjs` 等）未运行 `check:platform-assumptions` 验证。
- **未执行测试**：本环境只能读文件和使用指定 git 命令，没有运行 `npm run test:tooling`。下面的“反向用例会失败”是读代码推理，不是执行结果。
- **未核实第 1 轮记录**：尝试读取 `.agents/reviews/pr-464/round-1/judgments.md` 时 git 返回 `REVIEW_GIT_REFUSED records-path`，无法核对第 1 轮已提问题。

## 三、侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档/代码一致性”查了这些路径：

- **GitHub 列表读取失败**：`arm-fallback.sh:18` 在 `on`/`off` 最开始就失败退出，标签不动；`off` 中途重读失败（第 71 行）会在已删除部分标签后以 1 退出，属于“部分完成、可重跑”，可接受。
- **不可信输入**：`arm-fallback.sh` 只用固定常量标签和 GitHub 返回的 runner id/name，未拼接 shell 执行；`install-gate-remote.sh` 的 target/主机公钥有白名单正则（第 65-66 行），导出公钥后仍走第 58 行的 ed25519 校验。
- **临时文件/权限**：`check` 从旧的 `/tmp/gate-remote-check.$$`（可预测、可能被同机用户预置）改为 `mktemp -d` 私有目录，是安全改进；不过测试没有真正验证清理（见问题 5）。
- **trap 覆盖**：`install-gate-remote.sh` 的 `key` 两个分支和 `check` 各在独立进程里执行，`case` 只走一个分支，不存在同一个 shell 里 `trap` 互相覆盖；`trap` 用单引号保留到 EXIT 时再展开 `$WORK`，语义正确。
- **资源耗尽**：新增逻辑只按固定 `RUNNER_IDS` 循环，无无界循环；`head -c 400` 限制错误输出长度。
- **不可撤销操作**：`arm-fallback.sh off` 改 GitHub 标签，有本地锁；第 1 条的“漏删”会导致 ARM 恢复后标签残留，后续 `pause-runners.sh` 会在安装清单里发现并拒绝，算第二道防线，但不能替代 `off` 自身正确性。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 和模型请求代码未被本 PR 改动；运行手册却有多处与代码或作者说明不一致（问题 3、4、6）。

## 四、必答问题

### 1. 改动会不会改变模型已经见过的请求开头？

**不会（就本 PR 的改动范围而言）。** 增量只改了：
- `docs/runbooks/ci-vps-runner-runbook.md`
- `scripts/operations/ci-runner/arm-fallback.sh`
- `scripts/operations/ci-runner/install-gate-remote.sh`
- `test/tooling/ci-runner-scripts.test.mjs`
- 以及 `.agents/reviews/...` 复核记录

没有改系统提示、工具定义、历史消息组装、遮盖逻辑或 `packages/prompt-catalog`。因此不存在“改动请求开头”的问题；发给模型的内容仍应只在末尾追加，每轮变化值仍应只在最后一条用户消息里。依据：[prompt-prefix.md#rules](/tmp/opencode-review-ANNgA0/repo/.claude/rules/prompt-prefix.md) 第 27-29、35 行。整个系统的机制不在本 PR 范围内，未重新验证。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** 本 PR 的新输出都是运维 CLI 文本，不进入模型请求；而且新增/修改的值本身是确定的：
- `FALLBACKS`、`UNREGISTERED` 的顺序由固定的 `RUNNER_IDS="1 2 3 6"` 决定，不依赖 GitHub 返回顺序；
- `ARM_FALLBACK_ON/OFF`、`GATE_REMOTE_KEY`、`not registered...` 等消息没有时间戳；
- `mktemp -d` 的随机路径只用于本地临时目录，不写进任何输出或配置；
- JSON/配置键（`platform-assumptions.json`、`contract_sha256`）是静态值。

没有发现依赖前后文遮盖、无序集合或带时间字段的新逻辑。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**有对应检查，但覆盖不完整。**
- 新用例在 `test/tooling/ci-runner-scripts.test.mjs:2331`（未注册的 ci-vps-3 跳过、一个都没注册时拒绝）和 `:2500`（公钥丢失后用 `ssh-keygen -y` 导出）。
- 这些文件被 `ci/policy.json` 的 `test/tooling/**/*.test.mjs` 覆盖，并由 `test:tooling` 执行（`package.json:92`）。
- 反向推理：旧版 `arm-fallback.sh` 遇到 ci-vps-3 未注册会以 “GitHub has 0 runners” 退出 1，新用例期望 0，会失败；旧版没有派生分支，第二次 `key` 会在 `awk` 读不到 `.pub` 时失败，新用例期望两次 `rc=0`，会失败。**但本环境未实际运行测试。**
- **缺口**：问题 5 的清理断言检查旧前缀 `gate-remote-check`，删掉清理逻辑仍会通过；另外没有“`off` 时某个曾带 ci-arm 的 runner 不在列表里”的用例（问题 1）。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对结果：

| 值/格式 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| 编号 `6`、`ci-vps-3`、`gh-runner-3`、`/srv/gh-runner-3`、`gh-runner-3.service` | `runners.sh:1, 76-81` | `register-runner.sh:11-17`、`uninstall-runner.sh:12-15`、`install-runner.sh`、`pause/resume/clean` 的 `installed_runner_ids`、`gh-runner-nft.service:4`、`prepare-vps.sh:39`、runbook | 脚本侧一致；runbook 多处仍按三个 runner 写（问题 3） |
| `TasksMax=6144` | `gh-runners.slice:9` | systemd、runbook Preflight `:110`、测试 `:812` 左右 | 一致；runbook 第 67 行仍写 4096（问题 4） |
| `not registered on GitHub, left out:` | `arm-fallback.sh:32` | runbook `:199`、测试 `:2345` | 文案一致；但 `off` 的成功语义有缺口（问题 1） |
| `GATE_REMOTE_KEY ssh-ed25519 ...` | `install-gate-remote.sh:54-59` | `install-arm-runners.sh` 调用方、测试 `:2504` | 派生分支仍只输出一行、仍过第 58 行正则，格式一致 |
| `contract_sha256` | runbook `:5` | `validate_docs.py` / `runbook.py seal` | **未核实**，不能运行校验 |
| `platform-assumptions.json` 计数 | 该 JSON | `check-platform-assumptions.mjs` | **未运行核实** |

结论：脚本内部的值传递基本闭合；主要问题集中在运行手册的旧计数/旧命名，以及 `arm-fallback.sh off` 对“列表里消失的 runner”的处理。
