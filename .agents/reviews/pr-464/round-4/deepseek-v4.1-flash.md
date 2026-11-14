## 结论

本轮增量（`f216aa98..efd2f3d8`）的 `arm-fallback.sh` 逻辑与测试，我逐行核对后没有发现中、高严重度的“会出错”问题。`off` 在 `FALLBACKS` 为空时不会误报成功，`STRAY` 与最终核对也是一致的。发现的问题集中在手册与代码不一致、以及两条空的输出文案上。

---

## 读代码证实的问题

### 1. 低：手册说加汇总 runner 后“三个 uid”，实际会装四个并顺带建好第 3 个检查 runner

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:136`
- 问题：第 5 条“在已经有两个检查 runner 的机器上加汇总 runner … `runner_uids` 里有三个 uid”与代码不符。`install-runner.sh` 是无条件遍历 `RUNNER_IDS`，而当前 `RUNNER_IDS="1 2 3 6"`。
- 证据：

```text
scripts/operations/ci-runner/runners.sh:1
RUNNER_IDS="1 2 3 6"

scripts/operations/ci-runner/install-runner.sh:139-142
for id in $RUNNER_IDS; do
  runner_select "$id"
  install_runner_account
done
```

在“已有第 1、2 个检查 runner”的机器上执行第 5 条，会同时建出 `gh-runner-3` 的账号、目录和服务文件（尚未注册/启用），`INSTALL_OK` 里的 `runner_uids` 会是四个。操作者按手册看到四个可能误以为安装异常；第 6 条“做法同第 5 条”也隐含了第 5 条其实已经装好了第 3 个检查 runner。
- 建议：把“三个 uid”改成“四个 uid”，并说明该步骤会顺带创建第 3 个检查 runner 的账号和服务（第 6 条只需注册）；或者让安装脚本支持只安装指定 runner。

### 2. 低：只卸第 2 个 runner 后，恢复脚本恢复的是所有仍安装的 runner，不只是第 1 个

- 文件：`docs/runbooks/ci-vps-runner-runbook.md:258`
- 问题：手册写“在 Mac 上运行 `resume-runners.sh` 加回第 1 个 runner 的标签并启动它”，但脚本对 `--list` 返回的全部 runner 操作。
- 证据：

```text
scripts/operations/ci-runner/resume-runners.sh:10
NAMES=$(vps "bash $REMOTE/runner-pause.sh --list") || ...

scripts/operations/ci-runner/resume-runners.sh:20-24
for name in $NAMES; do
  ...
  add_label ...
done

scripts/operations/ci-runner/resume-runners.sh:38
OUTPUT=$(vps "bash $REMOTE/runner-resume.sh")
```

卸载第 2 个后，`--list` 会包含第 1 个检查 runner、汇总 runner，以及装了的话第 3 个检查 runner，恢复时这些都会被加标签并启动。
- 建议：改成“恢复其余仍安装的 runner”。

### 3. 低：`FALLBACKS` 为空时两条输出文案缺主语

- 文件：`scripts/operations/ci-runner/arm-fallback.sh:84`、`scripts/operations/ci-runner/arm-fallback.sh:90`
- 问题：`FALLBACKS` 为空（一个检查 runner 都没装）时：
  - 第 84 行会打印 `... check the labels of`（后面没有名字）；
  - 第 90 行会打印 `ARM_FALLBACK_OFF take only ci-vps jobs`（没有 runner 名字）。
  这不是误报成功：第 88-89 行仍会重新读取并检查 `LEFT`，为空才走到第 90 行。只是文案不完整，容易被读成“所有检查 runner 都已恢复”。
- 证据：

```text
arm-fallback.sh:81-90
for name in $(carrying "$TABLE"); do
  remove_label ...
done
TABLE=$(github_runners) || { echo "ARM_FALLBACK_FAILED could not read GitHub back; check the labels of$FALLBACKS"; exit 1; }
...
LEFT=$(carrying "$TABLE")
[ -z "$LEFT" ] || { echo "ARM_FALLBACK_FAILED $RUNNER_ARM_LABEL is still on: $LEFT"; exit 1; }
echo "ARM_FALLBACK_OFF$FALLBACKS take only $RUNNER_CHECK_LABEL jobs"
```

- 建议：`FALLBACKS` 为空时单独输出“没有安装检查 runner，CI VPS 上没有检查 runner 带 ci-arm”之类，或至少在 `check the labels of` 后补“（无）”。

### 4. 低：手册说“有残留 ci-arm 就先提示运行 off”，但一个检查 runner 都没装时先命中另一条拒绝

- 文件：`scripts/operations/ci-runner/arm-fallback.sh:47-55`，对应手册 `docs/runbooks/ci-vps-runner-runbook.md:199`
- 问题：`FALLBACKS` 为空的分支在 `STRAY` 检查之前。若既没有任何检查 runner 安装、又有一个未安装的检查 runner 带 `ci-arm`，`on` 报的是“has no check runner installed”，不会提示先运行 `off`。手册那句“`on` 时如果有没装的检查 runner 还带着 `ci-arm`…先拒绝并提示运行 `off`”在这种情况下不成立。两种结果都会“标签不动”，所以不是安全问题。
- 证据：

```text
arm-fallback.sh:47
[ -n "$FALLBACKS" ] || { echo "ARM_FALLBACK_FAILED $RUNNER_HOST has no check runner installed; labels untouched"; exit 1; }
arm-fallback.sh:48-55
STRAY=""
...
[ -z "$STRAY" ] || { echo "ARM_FALLBACK_FAILED$STRAY carries $RUNNER_ARM_LABEL but is not installed on $RUNNER_HOST; run arm-fallback.sh off first; labels untouched"; exit 1; }
```

- 建议：把 `STRAY` 检查移到 `FALLBACKS` 为空判断之前，或把手册措辞限定为“还有已安装的检查 runner 时”。

---

## 推测（未证实为实际故障）

### 低：以“服务已启用”当作“已安装”，可能漏掉正在运行但被 disable 的检查 runner

- 文件：`scripts/operations/ci-runner/arm-fallback.sh:28-31`，`scripts/operations/ci-runner/runner-pause.sh:8-13`
- 问题：`NAMES=$(vps "...runner-pause.sh --list")` 只列出“账号存在且 `systemctl is-enabled` 为真”的服务。若有人手动 `systemctl disable` 但服务仍在运行、GitHub 上仍显示 online 且带 `ci-vps`，`on` 会把它当作“没装”，只给其余检查 runner 加 `ci-arm`，最终核对也只比较 `FALLBACKS`，因此会在不报错的情况下“只开一半”。不过 `on` 会先打印 `not installed on ci-vps, left out: <名字>`，操作者能看到提示；这需要机器处于非正常状态才会出现，故标为推测/低。
- 建议：如果需要覆盖这种状态，判定“已安装”时同时考虑 `systemctl is-active`，或像 `reconcile_runners` 那样核对 GitHub 上所有带 `ci-vps` 的 runner 都必须出现在 `NAMES` 里。

---

## 侧重检查

- **错误路径**：上传失败（`arm-fallback.sh:18`）、远程列 runner 失败（`:19`）、GitHub 列 runner 失败（`:20`）、已装 runner 在 GitHub 缺失/重名（`:32-33`）、`STRAY`（`:47-55`）、暂停/离线（`:56-66`）都在写标签前退出并打印 `labels untouched`。读代码确认成立。
- **删除后的失败路径**：`remove_label` 失败只打印继续（`:82`）；随后重新读取 GitHub（`:84`），读取失败退出 1；`LEFT` 非空退出 1（`:88-89`）；每个 `FALLBACKS` 读回数量必须为 1（`:85-87`）。没有发现“删失败却报成功”的路径。
- **不可逆操作**：改动只增删 GitHub 标签，`off` 可逆；没有删除 VPS 文件或账号。锁 `take_lock` 仍在写标签前获取（`:17`）。
- **不可信输入/注入**：`STRAY`、`FALLBACKS` 的名字来自 `runners.sh` 的常量 `RUNNER_IDS`，不是直接拼接 GitHub 返回的任意字符串；传给 `gh api` 的 runner id 仍来自原有的 `runner_field ... 1`，没有新增未校验输入。未发现命令注入面。
- **资源耗尽**：检查 runner 固定三个，循环次数有界；新增 `STRAY` 循环仍是 `CHECKS` 固定集合，没有无界遍历。
- **规则/文档一致性**：路径表、`prepare-vps.sh` 核对四个 needrestart 服务、`install-gate-remote.sh` 的钥匙权限（`0750 root:gh-runner-gate`、私钥 `0440`，检查 runner 不在该组）、只卸第 2/3/汇总/全部的说明，均与代码一致。发现的不一致是上文第 1、2 条，以及第 4 条的边界措辞。
- **未核实**：本环境只能用 `read/grep/glob` 和指定的 git 命令，无法运行 `npm test`、`validate_docs.py` 或 `runbook.py`，所以测试是否实际通过、`contract_sha256` 是否算对、`platform-assumptions.json` 计数是否被检查器接受，均未核实。`git show` 读取 `.agents/reviews/pr-464/round-3/*` 被拒绝，故未参考第 3 轮原文。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。`git diff --name-only 040da0f6..efd2f3d8` 的 35 个文件全是 CI runner 脚本、测试、runbook、`.agents` 复核记录和 `scripts/platform-assumptions.json`，没有系统提示、工具定义、历史消息或遮盖相关文件。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条消息里——这项性质没有被本改动触碰。依据文件 `.claude/rules/prompt-prefix.md` 在本检出中不存在（`glob` 未找到），我是按“改动是否触及模型输入构造路径”核对的。**未核实**：没有运行整体测试或前缀检查。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会。改动没有触及模型输入的序列化。新增的 CI 输出按固定的 `CHECKS` 顺序生成，没有新增时间字段、无序集合或依赖前后文的遮盖。手册里的日期（如 2026-11-13）只出现在文档，不进入模型输入。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且从读代码看能反向失败：
- `test/tooling/ci-runner-scripts.test.mjs:2402-2435`：残留 `ci-vps-3` 带 `ci-arm` 时，断言 `on` 退出 1、精确匹配新的 `STRAY` 文案、且没有任何 `/labels` 调用。去掉 `STRAY` 检查会同时失败这三项。
- `:2420-2434`：所有检查 runner 都卸掉后 `off` 仍清掉 `ci-vps-1` 的 `ci-arm` 并退出 0。重新把“`FALLBACKS` 为空就拒绝”放回分支前，这个用例会失败。
- `:2437-2453`：`scp-fail`、`list-fail` 两种故障下 `on`/`off` 都退出 1、匹配错误文案、且不调用 `/labels`。故障被忽略继续写标签时，这项会失败。
- `:2334-2364`：部分未安装时 `left out` 与成功文案；一个都没装时 `on` 拒绝且不碰标签。
**未核实**：无法在本环境实际运行测试，以上是读断言和脚本路径得出的结论。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

- `STRAY`：只进入错误文案，消费方是新测试的精确 `toContain` 和文档描述，没有后端/格式校验；两端一致。
- `not installed on ... left out:`：消费方是测试和手册，顺序固定，一致。
- 新增的标签写操作：runner id 仍来自原有的 `runner_field ... 1`，未改变产生方式和消费方式（`gh api .../runners/<id>/labels/...`），没有新增清单项、配置键或序列化格式。
- `contract_sha256`：消费方是 `validate_docs.py`；提交里已从 `6038253...` 改为 `e5f51cc...`，但**未核实**该值是否等于 `scripts/operations/ci-runner/` 当前内容的封存结果（无法运行封存/校验工具）。
- `scripts/platform-assumptions.json` 的计数：消费方是平台假设检查；本 PR 调整了两处测试文件计数和 `runners.sh` 计数，**未核实**检查器是否接受。

整体上，本轮改动没有把一个新的 id/字段交给比产生处更严格的消费者，I-73 那类“清单值过不了后端校验”的问题在这里不适用。
