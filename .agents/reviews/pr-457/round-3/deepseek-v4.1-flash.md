## 结论

本轮增量（`ce942046..13aa903c`）的核心逻辑我逐行核对过：`label_states` 对 `extra`/`mixed` 的划分、`resume-runners.sh` 对 `mixed` 的拒绝、`gate-fallback.sh on` 的 online 检查，都与作者说法一致，未发现会让服务在错误标签下启动的新组合。只发现两处低严重度的文档/代码不一致，以及一个测试覆盖缺口。

## 发现（按严重度）

### 1. 低：运行手册引用的失败输出与代码实际输出不一致
- 文件: `docs/runbooks/ci-vps-runner-runbook.md:169`
- 问题：手册说 `ci-vps-1` 离线时“打印 `GATE_FALLBACK_FAILED ci-vps-1 is offline`”，实际输出还带后续说明。
- 证据（亲自读到）：
  - 手册原文：“`ci-vps-1` 在 GitHub 上不是 `online` 时也拒绝……打印 `GATE_FALLBACK_FAILED ci-vps-1 is offline`，标签不动。”
  - `scripts/operations/ci-runner/gate-fallback.sh:33-36`：
    ```sh
    [ "$(runner_field "$TABLE" "$FALLBACK" 3)" = online ] || {
      echo "GATE_FALLBACK_FAILED $FALLBACK is $(runner_field "$TABLE" "$FALLBACK" 3) on GitHub, so it could not take the jobs either; labels untouched"
      exit 1
    }
    ```
- 说明：测试只做子串匹配（`toContain("GATE_FALLBACK_FAILED ci-vps-1 is offline")`），所以不会失败；属文档精确性问题。
- 建议：把手册改成完整输出，或写成“以 `GATE_FALLBACK_FAILED ci-vps-1 is offline` 开头”。

### 2. 低：ADR 0172 仍把它写成“给每个 runner 加回 `ci-vps`”
- 文件: `docs/adr/0172-resume-runners-labels-first.md:59`
- 问题：本 PR 已改成按 runner 加各自标签（`ci-vps-gate` 加给汇总 runner），但这份 `status: active`、`superseded_by: ""` 的 ADR 仍写“给每个缺标签的 runner 加回 `ci-vps`”。ADR 0256 的 `amends` 只列了 0176、0241，没有把 0172 标为被修订。
- 证据（亲自读到）：
  - ADR 0172 第 59 行：“给每个缺标签的 runner 加回 `ci-vps`，再从 GitHub 读一遍。”
  - `scripts/operations/ci-runner/resume-runners.sh:20-24` 用 `own_label "$name"` 按 runner 取标签；`runners.sh:39-48` 对 3 号返回 `ci-vps-gate`。
- 说明：ADR 0172 的核心决定（先加标签再启动）仍成立，只有“具体加哪个标签”这一句过时；属既有文档、非本轮增量新增。
- 建议：在 ADR 0256 的修订关系或 ADR 0172 加一条“按 runner 的标签由 ADR 0256 修订”的说明。

### 3. 低/建议：`gate-fallback.sh on` 不检查“第 3 个 runner 是否真的不在线”
- 文件: `scripts/operations/ci-runner/gate-fallback.sh:28-37`
- 问题：脚本只检查 `ci-vps-1` 带 `ci-vps` 且为 `online`，没有检查 `ci-vps-gate` 是否离线；即使 3 号健康，也能把应急标签加上，导致汇总作业可能在两个 runner 间分流、与检查作业共用资源。
- 证据（亲自读到）：该段只做了 `has_label ... RUNNER_CHECK_LABEL` 和 `runner_field ... 3 = online` 两项检查，随后直接 `add_label`，没有读取 `ci-vps-gate` 的状态。
- 说明：这是设计上的宽松；运行手册写的是“3 号坏了时”才用，靠操作者遵守。后果（分流、挤占检查 runner 资源）是推测，未实测。
- 建议：至少在手输出里提示“确认 `ci-vps-gate` 已离线”；若要更严，可在 3 号仍 `online` 时拒绝或要求确认。

## 侧重检查

我重点查看了错误路径、不可信输入、资源上限和不可撤销操作：

- **GitHub 读取失败**：`resume-runners.sh:25` 读失败后 `TABLE=""`，`label_states` 全部记为 `unread`，命中拒绝分支、不启动服务；`pause-runners.sh:47-60` 同样把 `unread` 当残留，恢复标签并以 1 退出。行为正确。
- **标签删除失败**：`pause-runners.sh:38-45,56-59` 记录已删项并在失败时 `put_labels_back`，不碰服务。`gate-fallback.sh:37-39` 添加失败后重新读取并报 `GATE_FALLBACK_FAILED`。行为正确。
- **不可信输入/注入**：`gate-fallback.sh:8-14` 只接受 `on|off`；`has_label`（`mac-runners.sh:45-50`）用逗号包住做精确匹配，标签字符串不会当通配模式；未发现 `eval` 或把 GitHub 返回内容拼进命令。
- **资源上限**：`ghgate.slice` 为 `MemoryMin/High/Max=2G`、`TasksMax=1024`，`gh-runners.slice` 为 17G/18G、4096，合计 MemoryMax 20G，和手册/测试一致；未见新的无界资源使用。
- **不可撤销操作**：`uninstall-runner.sh:10-13` 新增接受 `3`；删除账号/目录本身不可逆，但手册要求先 `pause-runners.sh`。脚本自身不检查是否还有 `Runner.Worker`，这与已有的 2 号卸载模式相同，非本轮新增缺陷。
- **暂停时的 mixed**：`pause-runners.sh` 对每个 runner 用 `managed_labels_on` 去掉全部受管标签，mixed 的“多出来的标签”也会被去掉；之后 `label_states` 读到 `off` 才会停服务。没有发现 mixed 导致标签残留却继续停服务的问题，反而能借暂停把 mixed 清掉。

## 对作者说法的核对

- “`label_states` 只把 `ci-vps-1` 同时带 `ci-vps` 和 `ci-vps-gate` 记成 `extra`，其他‘自己的标签+另一个受管标签’记成 `mixed`”：**成立**。`mac-runners.sh:95` 要求 `name == fallback`（`runner_select 1` 得到的 `ci-vps-1`）且受管标签正好是 `ci-vps ci-vps-gate`；`:97-99` 对仍带自己标签的其他组合给 `mixed`。
- “有没有别的标签组合仍会让服务在标签不对时启动”：我把三种 runner × 受管标签组合都过了一遍。resume 只放行 `on` 和 `extra`；`on` 要求受管标签等于该 runner 自己的标签，`extra` 只可能是 `ci-vps-1` 带 `ci-vps`+`ci-vps-gate`。`ci-vps-2`/`ci-vps-gate` 带两个标签都是 `mixed`，只有 `ci-vps-1` 带 `ci-vps-gate` 是 `foreign`，都会被拒绝。**未发现其他会让服务启动的错误组合。**
- “`pause-runners.sh` 对 `mixed` 照样去掉全部受管标签有没有问题”：**没有问题**，这是暂停想要的语义；它也顺带清掉 mixed，之后再 resume 只恢复各自标签。
- “`gate-fallback.sh on` 在 `ci-vps-1` 不是 `online` 时拒绝”：**成立**（`gate-fallback.sh:33-36`）。
- “c73eecacc 的 diff 里手册第 5 行摘要已经变了”：**成立**。基线 `3086f38b2` 是 `sha256:021373d7...`，`c73eecacc` 已是 `sha256:fcfda7ac...`，本轮再封存为 `sha256:528e3003...`。摘要值本身是否正确无法运行封存脚本核对，**未核实**。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本 PR 的 diff 只涉及 `.github/workflows`、`docs/`、`scripts/ci`、`scripts/operations/ci-runner` 和 `test/tooling`，没有改系统提示、工具定义、历史消息、遮盖或运行时适配器代码，所以“只追加、每轮变化值在最后一条消息”这条性质不受影响。模型请求构造代码未改动，我也没有在运行时侧重新验证（未核实，但改动范围足以排除）。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会由本改动引起。新增的 `mixed`/`extra` 只是运维脚本内部状态字符串，`ghgate.slice`、`status` 字段等都不进入模型请求；没有新增时间字段、随机值或无序集合到模型可见的序列化内容里。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有。
   - `test/tooling/ci-runner-scripts.test.mjs` 新增：3 号带 `ci-vps` → `mixed`、2 号带 `ci-vps-gate` → `mixed`、`ci-vps-1` 带两标签 → 允许、`gate-fallback on` 离线拒绝、恢复/暂停三个 runner 等。
   - 按代码推断：去掉 `mixed` 分支后旧逻辑会把 `ci-vps-2`/`ci-vps-gate` 的两标签状态判成 `extra`，resume 会继续启动服务，新增用例会失败；去掉 online 检查后 on 会成功加标签、状态为 0，新增离线用例也会失败。反向用例设计是有效的。
   - 我因工具限制只允许读和 git 命令，**没有实际运行测试**。
   - 测试缺口：没有专门覆盖“`pause-runners.sh` 遇到 2 号/汇总 runner 的 `mixed` 状态”的用例（行为上通用逻辑能处理，但缺少回归保护）。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `mixed`：产生于 `mac-runners.sh:98`；使用于 `resume-runners.sh:28-31`（拒绝并退出 1）、`pause-runners.sh:49-55`（默认当作未清干净，阻止停服务）、运行手册和测试。两端一致。
   - `extra`：产生于 `mac-runners.sh:96`；`resume-runners.sh:27-36` 不匹配任何拒绝分支，因此放行；手册和测试都把它当允许的应急状态。一致。
   - `status` 列：`mac-runners.sh:38` 的 jq 固定输出 `[id,name,status,busy,labels]`，所以第 3 列是 status；`gate-fallback.sh:33,40` 和 `resume-runners.sh:48` 都按第 3 列读。一致。
   - `RUNNER_IDS=1 2 3` 与各编号入口：`runner_select` 支持 1/2/3，`register-runner.sh:12` 接受 `1|2|3`，`uninstall-runner.sh:11` 接受 `2|3`/`all`，install/pause/resume 都按 `RUNNER_IDS` 或已安装账号遍历。`uninstall-runner.sh` 仍不能单独卸载 1 号，但这是既有设计、非本轮引入。
   - `ghgate.slice`：`install-runner.sh:30,111` 安装/备份，`uninstall-runner.sh:17` 在 `all` 时删除，`runners.sh:41` 让 3 号指向它，测试校验其限额。一致。
   - `contract_sha256`：本轮从 `fcfda7ac...` 更新到 `528e3003...`，与脚本改动在同一增量里；具体摘要是否正确无法运行封存工具，未核实。
