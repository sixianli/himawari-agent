已对比 `17561841..b44a31528`：改动只有 `prepare-arm.sh`、`test/tooling/ci-runner-scripts.test.mjs`、`docs/runbooks/ci-vps-runner-runbook.md` 三个文件。作者关于 profile 文本、安装包、退出码 75、工具核对和重跑方式的说法，大部分与代码一致；下面只列我发现的偏差和不足。

## 侧重检查

- **错误路径**：profile 已存在且内容不同 → `fail ... 75`（`prepare-arm.sh:49-50`），行为正确；但新加的 `apparmor_parser -r` 没有 `|| fail`，失败时不会打印 `CI_ARM_PREPARE_FAILED`，见意见 1。
- **不合规范/不可信输入**：`APPARMOR_PROFILE` 是常量，profile 内容是固定字面量，没有把外部输入拼进去；`cat` 只读 root 文件，未发现注入点。
- **安全**：新增内容只是在 `/usr/bin/bwrap` 上加载 `userns` 放行规则，`flags=(unconfined)`，与 `prepare-vps.sh` 及 `docs/runbooks/install-start-stop-runbook.md:532-540` 已批准的文本逐字一致；没有改全局 `kernel.apparmor_restrict_unprivileged_userns`。`socat` 等包确实扩大了 runner 账号可用的网络工具，但与 CI VPS 相同且 SRT 需要，属于既有取舍。
- **资源耗尽**：只多装四个小包，没有循环、递归或新的无界任务；脚本原有的 40 GiB 磁盘检查仍在。
- **不可撤销操作**：`/etc/apparmor.d/bwrap` 和服务状态会持久保留；`uninstall-runner.sh` 和 runbook 的 ARM 卸载步骤（`:201`）不会移除该 profile。可通过 `install-start-stop-runbook.md:603` 的手工命令撤销，但 ARM 的卸载路径没有提这一点。
- **文档/代码一致**：profile 路径、文本、包名基本一致；但 runbook 对 ARM 当前是否跑 integration 的描述与 `ci.yml` 不一致，见意见 2。

### 1（低）apparmor_parser 失败没有 CI_ARM_PREPARE_FAILED 标记和约定退出码

文件：`scripts/operations/ci-runner/prepare-arm.sh:54`（相关 `:66-68`，调用方 `scripts/operations/ci-runner/install-arm-runners.sh:52`）

问题：新加的 `apparmor_parser -r` 直接暴露在 `set -euo pipefail` 下，没有 `|| fail ...`。若 `/etc/apparmor.d` 不存在、AppArmor 未启用、`apparmor_parser` 缺失或规则被拒绝，脚本会以 parser 自身的退出码（常见 1 或 127）中止，不会打印 `CI_ARM_PREPARE_FAILED`；末尾的 `for tool` 检查也不包含 `apparmor_parser`。而 step 3 的调用方明确提示会看这一行。

证据：
```sh
apparmor_parser -r "$APPARMOR_PROFILE"
...
for tool in bwrap socat rg nft visudo useradd groupadd getent sha256sum curl ss python3 sshd git; do
```
```sh
on_arm "sudo bash $REMOTE/prepare-arm.sh" || failed 3 "prepare-arm.sh refused or failed; its CI_ARM_PREPARE_FAILED line says why"
```

读代码证实：失败路径和缺失的标记如上述；`fail()` 只在显式调用时打印该行（`:12`）。推测（未在真机复现）：正常安装 `apparmor-utils` 的 Ubuntu 24.04 不会触发；只有 parser 不可用或加载被拒时才暴露。

建议：改为 `apparmor_parser -r "$APPARMOR_PROFILE" || fail "could not load $APPARMOR_PROFILE" 76`（或复用 75），并把 `apparmor_parser` 加入末尾工具检查。

### 2（低）runbook 说 ARM 装这些是给 integration 沙箱用例用，但当前没有 ARM integration 作业

文件：`docs/runbooks/ci-vps-runner-runbook.md:186`（对照 `:180`、`.github/workflows/ci.yml:249-266`、`:314`、`:357`）

问题：新文档把安装理由写成“integration 测试里沙箱用例要的……少了这几样，沙箱用例在 ARM 上报 `JOB_HOST_DEPENDENCIES_UNAVAILABLE`”，但当前两个 integration 分片都是 `runner: ci-vps`，ARM 只跑 policy/static/tooling/security；本 PR 最后一个提交还删除了 `.github/workflows/arm-integration-trial.yml`。这段会让读者以为 ARM 现在会跑 integration。文档也未提实际安装的 `apparmor-utils`，而新测试专门检查了它。

证据：
```yaml
          - key: integration-2
            runner: ci-vps
...
  tooling:
    runs-on: ci-arm
...
  security:
    runs-on: ci-arm
```
`docs/runbooks/ci-vps-runner-runbook.md:180`：“build、browser、tests 和汇总作业仍在 CI 服务器上”。

读代码证实：`ci.yml` 和 `docs:180` 如上述；`git show b44a31528` 显示删除 `arm-integration-trial.yml`。推测：作者可能是在为将来的 ARM 试跑做准备；若如此，文档应明确写成“为后续/手工试跑准备”。

建议：把“integration 测试里沙箱用例要的”改成“为在 ARM 上手工或将来试跑 integration 时准备”，或明确当前没有 ARM integration 作业；并把 `apparmor-utils` 补进文字。

### 3（低）新增测试只做静态文本比对，没覆盖 profile 路径、退出码和实际加载

文件：`test/tooling/ci-runner-scripts.test.mjs:2972-2985`

问题：用例检查了四个包名、`profile_text` 与 VPS 相等、`apparmor_parser -r "$APPARMOR_PROFILE"` 字符串、以及 tool 循环里有 `bwrap socat rg`，但没有断言 ARM 的 `APPARMOR_PROFILE` 指向 `/etc/apparmor.d/bwrap`，没有断言“已存在且内容不同则 75 拒绝”这一分支，也没有执行 `prepare-arm.sh`（同文件 `:2955-2970` 也只读源码）。因此把 ARM 的 profile 写到别的路径、或删掉内容比较分支，这个测试仍会通过。

证据：
```js
    expect(profile(arm)).toBeDefined();
    expect(profile(arm)).toBe(profile(vps));
    expect(arm).toContain('apparmor_parser -r "$APPARMOR_PROFILE"');
    expect(arm).toMatch(/^for tool in .*\bbwrap socat rg\b/mu);
```
```sh
if [ -e "$APPARMOR_PROFILE" ]; then
  [ "$(cat "$APPARMOR_PROFILE")" = "$profile_text" ] || fail "$APPARMOR_PROFILE exists with other content" 75
```

读代码证实：断言范围就是上述几条。推测：实际 `apparmor_parser`/`bwrap` 行为需要真机验证，当前没有对应的自动检查。

建议：至少补 `expect(value(arm, "APPARMOR_PROFILE")).toBe("/etc/apparmor.d/bwrap")`（或断言与 VPS 相同），并断言 `|| fail "$APPARMOR_PROFILE exists with other content" 75` 这段文本；真机加载与 bwrap 可用性可作为试跑记录。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 改动只涉及 CI 准备脚本、tooling 测试和 runbook，不触碰系统提示、工具定义、历史消息或遮盖逻辑；发给模型的内容仍然只在末尾追加，每轮变化的 `bwrap` 版本只出现在 `CI_ARM_PREPARED` 日志行（`prepare-arm.sh:69-70`），不进任何模型请求。依据规则第 4、10 条。

2. **不会让同一段文字在不同请求里变成不同字节。** profile 文本是固定字面量，两个脚本逐字相同并由测试比较；新增动态值只有 `bwrap --version` 的输出，且只写日志。没有依赖前后文的遮盖、带时间的字段或无序集合。

3. **有自动检查，但只到静态文本层。** 新增用例会随 tooling 项目在 ARM 的 tooling 作业运行；反向删包、删 `apparmor_parser` 行、改 profile、删 tool 列表中的 `bwrap socat rg`，都会让对应断言失败（由断言语义可推知，本环境未实际运行）。但测试不执行脚本，不验证 `apparmor_parser` 和 bwrap 真能工作；没有提交的反向/mutation 用例，作者说的“改脚本前失败”是一次性手工验证。作者引用的 sandbox-runtime 行号（`node_modules/...`）本检出没有依赖，**未核实**。

4. **逐个值核对结果：**
   - `APPARMOR_PROFILE=/etc/apparmor.d/bwrap`：产生于 `prepare-arm.sh:10`，使用于 `:49-54`；与 `prepare-vps.sh:10` 及 `install-start-stop-runbook.md:495/530` 的已批准路径一致，可接受。
   - `profile_text`：产生于 `:42-48`，用于写文件、内容比较和 parser（`:50-54`），测试比较（`:2982-2983`）；与文档已批准文本一致。
   - 退出码 `75`：产生于 `:50`，唯一使用方是 `install-arm-runners.sh:52` 的通用 `failed 3`，不按具体码分支，能接受；但 runbook 未记录该码（诊断层面的小缺口）。
   - 包名 `bubblewrap/socat/ripgrep/apparmor-utils`：产生于 `:37`，由 apt 消费；测试 `:2978-2981` 校验；文档 `:186` 只列了前三者，漏了 `apparmor-utils`。
   - `bwrap/socat/rg` 工具名：产生于 `:66`，由 `command -v` 消费；测试 `:2985` 校验。
   - `CI_ARM_PREPARED ... bwrap=<版本>`：产生于 `:69`；`grep` 未发现任何代码解析这行，只有人和 runbook 阅读，追加字段不会破坏使用方。
