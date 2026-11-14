## 复核结论

### 读代码证实的发现（按严重度）

#### 1. 【高，针对后续实现】专用内存池在现有模板里落不下来

- 文件：`scripts/operations/ci-runner/gh-runner.service.in:9`、`scripts/operations/ci-runner/runners.sh:49-57`、`scripts/operations/ci-runner/install-runner.sh:30`、`install-runner.sh:111`
- 问题：ADR 第 1 步要求 3 号进独立 `ghgate.slice`，预留/上限 2 GB。但服务模板写死 `Slice=gh-runners.slice`，渲染函数只替换 `@USER@`、`@ROOT@`、`@NAME@`、`@OTHER_ROOT@`、`@SHARE@`、`@SHARE_GROUP@`，没有 slice 或内存变量；安装脚本也只备份和安装 `gh-runners.slice`，没有 `ghgate.slice`。按 ADR 列出的 PR A 文件清单实现，3 号仍会和检查 runner 同池，`ghgate.slice` 也不会被安装、备份或卸载。
- 证据：
  - `gh-runner.service.in:9`：`Slice=gh-runners.slice`
  - `gh-runner.service.in:25-26`：`MemoryHigh=14G` / `MemoryMax=15G`
  - `runners.sh:51-56` 的 `sed` 只替换 `@USER@`、`@ROOT@`、`@NAME@`、`@OTHER_ROOT@`、`@SHARE@`、`@SHARE_GROUP@`
  - `install-runner.sh:30`、`install-runner.sh:111` 只处理 `gh-runners.slice`
- 建议：把模板参数化（例如 `Slice=@SLICE@`、`MemoryHigh=@MEMORY_HIGH@`、`MemoryMax=@MEMORY_MAX@`、`TasksMax=@TASKS_MAX@`），在 `runner_select` 里按 runner 设置；新增并安装 `ghgate.slice`，同时补进 `INSTALL_PATHS`、卸载清单和回滚备份；加一条 `render_runner_unit 3` 的测试，断言 `Slice=ghgate.slice`、2 GB 限额，并加反向用例。

#### 2. 【中】“藏另外两个 runner 目录”只有一个路径变量

- 文件：`scripts/operations/ci-runner/gh-runner.service.in:37`、`scripts/operations/ci-runner/runners.sh:16`、`runners.sh:23`、`runners.sh:54`
- 问题：ADR 第 1 步要求 3 号看不到另外两个 runner 的目录。但模板只有 `@OTHER_ROOT@` 一个占位符，`runners.sh` 每个编号也只设一个 `RUNNER_OTHER_ROOT`，渲染只替换一次。三个 runner 时，3 号最多只能藏两个目录中的一个。
- 证据：
  - `gh-runner.service.in:37`：`InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -@OTHER_ROOT@`
  - `runners.sh:16`：`RUNNER_OTHER_ROOT=/srv/gh-runner-2`
  - `runners.sh:23`：`RUNNER_OTHER_ROOT=/srv/gh-runner`
  - `runners.sh:54`：`-e "s|@OTHER_ROOT@|$RUNNER_OTHER_ROOT|g"`
- 建议：改成两个占位符或一个按 runner 生成的路径列表，并在 `runner_select` 里分别设置；测试要覆盖 1 号看不到 2、3 号，2 号看不到 1、3 号，3 号看不到 1、2 号。

#### 3. 【中】PR A 的跨文件对照测试与 PR B 的文件改动顺序矛盾

- 文件：`docs/adr/0256-gate-job-gets-its-own-runner.md:87`、同文件 `:94-97`、`scripts/ci/contracts.mjs:7`、`ci/policy.schema.json:64`、`.github/actionlint.yaml:3-4`
- 问题：ADR 把“读 `runners.sh`、`contracts.mjs`、`ci/policy.json`、`ci.yml`、`.github/actionlint.yaml`、`ci/policy.schema.json`，断言 3 号标签是 `ci-vps-gate`”的跨文件用例放在 PR A；但 `gateRunnerLabel`、policy 的 required 成员、`ci.yml` 的 `runs-on`、schema 枚举、actionlint 标签都在 PR B 才改。当前 `contracts.mjs:7` 只有 `linuxRunnerLabel = "ci-vps"`，schema 第 64 行枚举只有 `ci-vps` 和 `macos-15`，actionlint 也只列 `ci-vps`。这个用例在 PR A 不可能按描述通过；若放宽，又不能在 PR A 验证真正的两端一致性。
- 证据：
  - ADR `:87` 把跨文件对照用例列在 PR A
  - ADR `:95` 才说 PR B 新增 `gateRunnerLabel` 并同步 schema、actionlint
  - `contracts.mjs:7`：`export const linuxRunnerLabel = "ci-vps";`
  - `ci/policy.schema.json:64`：`"enum": ["ci-vps", "macos-15"]`
- 建议：把跨文件一致性测试整体放到 PR B；PR A 只测 `runners.sh`、注册/卸载/渲染/内存池。或者 PR A 先加 `gateRunnerLabel` 常量但不使用，PR B 再接线。I-73 的教训就是“每个值都要同时检查产生端和使用端”。

#### 4. 【中低】新增 runner 3 的消费点没有列全

- 文件：`scripts/operations/ci-runner/uninstall-runner.sh:17`、`scripts/operations/ci-runner/prepare-vps.sh:39`、`scripts/operations/ci-runner/gh-runner-nft.service:4`
- 问题：ADR 的 PR A 清单只点名 `runners.sh`、`register-runner.sh`、`uninstall-runner.sh`、暂停/恢复脚本和测试，但没有点名这些也会受 3 号影响的文件：
  - `uninstall-runner.sh:17` 的 `SHARED_UNITS` 没有 `ghgate.slice`，`all` 卸载后可能留下新 slice；
  - `prepare-vps.sh:39` 的 needrestart 验证只检查 `gh-runner.service` 和 `gh-runner-2.service`，不验证 3 号；
  - `gh-runner-nft.service:4` 的 `Before` 只列 1、2 号（这一项因 runner 服务自身有 `Requires/After` 不一定会出错，但清单应同步）。
- 证据：
  - `uninstall-runner.sh:17`：`SHARED_UNITS="/etc/systemd/system/gh-runners.slice ..."`
  - `prepare-vps.sh:39`：`for my $unit (qw(gh-runner.service gh-runner-2.service))`
  - `gh-runner-nft.service:4`：`Before=gh-runner.service gh-runner-2.service`
- 建议：在 PR A 的清单里逐项列出这些文件；卸载测试要覆盖 `uninstall-runner.sh all` 后 `ghgate.slice` 也消失，`prepare-vps.sh` 的验证循环改为遍历 `RUNNER_IDS`。

#### 5. 【低】ADR 元数据与 0176 的 `amended_by` 不一致

- 文件：`docs/adr/0256-gate-job-gets-its-own-runner.md:7`、`docs/adr/0176-ci-on-ovh-vps.md:9`、`docs/adr/0256...:100`
- 问题：0256 在 `amends` 里声明修订 0176，但 0176 的 `amended_by` 仍只有 0241，没有 0256。仓库里 0198、0219、0225 等被后续 ADR 修订时都同步了 `amended_by`。另外 0256 说“ADR 0241 的判定一条不改”，却把 0241 列进 `amends`，含义可能不准确。
- 证据：
  - 0256 `:7`：`amends: "docs/adr/0176-ci-on-ovh-vps.md, docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md"`
  - 0176 `:9`：`amended_by: "docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md"`
  - 0256 `:100`：`ADR 0241 的判定一条不改`
- 建议：在 0176 的 `amended_by` 加上 0256；确认是否真的需要把 0241 列为 `amends`，若不需要则删除。

#### 6. 【低】第 2 步“同样两个 runner”与第 1 步的三个 runner 不一致

- 文件：`docs/adr/0256-gate-job-gets-its-own-runner.md:109`
- 问题：第 2 步写“main 的确认仍然和 PR 用同样两个 runner”，但第 1 步已经增加第 3 个 gate runner，且 PR 的 `ci/required` 在 PR B 后跑在 gate 上；main 的完整确认也会调用 `ci.yml`，其中 required 同样跑在 gate 上。这个“两个”只适用于 main 的轻量确认和检查作业，不适用于 main 的完整确认。
- 证据：0256 `:82`、`:95` 说明 3 号 runner 和 required 改到 `ci-vps-gate`；`:109` 仍写“同样两个 runner”。
- 建议：改成“main 的轻量确认仍用两个检查 runner；完整确认的 required 和 PR 一样用 gate runner”，避免读者误解。

### 推测 / 未核实

- 作者说“严格校验错误数 13 个，和 main 相同”：仓库里没有 `document-governance` skill，无法运行 `validate_docs.py --strict`，未核实。按已读到的仓库内检查（`check:adr-numbers`、`check:docs-links`、`check:glossary`、`check:markdown-tables`）看，新 ADR 的编号、标题和相对链接没有明显问题，但这不等于严格校验的 13 个错误数。
- 28 次排队、20 次只剩 `ci/required`、policy 峰值 2.68 GB、main 确认等待近 4 小时、Andy 在决定卡片上的选择：均来自外部接口/决定卡片，仓库里无法核实。
- `ghgate.slice` 的 2 GB 是否够 `ci/required`（要装 Node、工具和 gate 依赖）：未核实；ADR 自己也说要先量。建议先量峰值再写死 `MemoryMax`，否则可能把 gate 自己的 OOM 变成所有 PR 的阻塞。
- `.agents/reviews/pr-450/...` 和 `topic-ci-*` 记录在当前稀疏检出中不可读，`git show` 也被环境拒绝，内容未核实。

## 侧重检查

- **错误路径**：3 号掉线时 gate 会排队，ADR 的应急标签方案是可行的；但应急标签加在 1 号后，现有 `pause-runners.sh` 只按每个 runner 的常规标签增删（`mac-runners.sh:4` 当前是单一 `LABEL=$RUNNER_LABEL`），实现时必须确保暂停时连临时 `ci-vps-gate` 标签也移除，否则会出现“服务要停但 GitHub 仍派 gate 任务”的窗口。
- **不可信输入**：`ci/required` 执行 PR 合并提交里的脚本（`ci.yml:350-366`），和检查作业同一信任范围；ADR 已写明 3 号不比另外两个更可信。移动 runner 本身不扩大信任边界。报告仍从共享目录读取并按摘要核对，未改变。
- **安全**：`ci-vps-gate` 标签隔离检查作业是可行的；但 `InaccessiblePaths` 目前只有一个“另一个 runner”路径，3 号无法同时藏两个目录（见发现 2）。防火墙规则通过 `installed_runner_ids` 自动覆盖新增账号，这一点没问题。
- **资源耗尽**：核心问题是发现 1 的 slice/模板缺口；不修的话，3 号仍在共享池里，gate 仍可能被检查作业的内存压力拖死。
- **不可撤销操作**：安装 3 号会重新生成 1、2 号服务文件，必须先暂停；ADR 已写明。卸载脚本没有把 `ghgate.slice` 纳入共享单元（发现 4），会留下残留。
- **规则/文档一致性**：ADR 的大部分行号和原话与仓库一致；已核对 `ci.yml:324-327`、`main.yml:9-11`、`runners.sh:1-29`、`register-runner.sh:11-29`、`uninstall-runner.sh:10-14`、`gh-runner.service.in:9/25-26/37`、`gh-runners.slice:6-7`、`check-policy.mjs:1191`、`policy.schema.json:64`。与 ADR 0241、0243 没有直接决定冲突；与 0176 的修订关系有 `amended_by` 元数据不一致（发现 5）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 PR 的 diff 只有 `docs/adr/0256-...md` 和 `.agents/reviews/...`，没有改系统提示、工具定义、历史、遮盖或任何模型请求组装路径。`prompt-prefix.md:27-29` 的“固定在前、会变的值只放最后一条消息”和第 35 条“只能末尾追加”没有受到影响；本 PR 也没有新增每轮变化的值。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。本 PR 没有代码、序列化或遮盖逻辑变化；ADR 正文里的日期是静态 front matter，评审记录里的时间/费用不会进入产品模型请求。若将来把 ADR 或记录作为资料块使用，它是新增的输入内容，不是对已发历史的改写。`prompt-prefix.md:51-54` 的确定性要求没有被触碰。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   本 PR 没有新增自动检查，也没有本 PR 对应的反向用例。ADR 里提到的跨文件对照、升级函数、`main-workflow.mjs` 反向用例都还在后续 PR，尚未实现，因此现在无法验证“反向用例会失败”。现有文档检查会覆盖 ADR 编号、链接等，但不验证 ADR 的现状判断和后续方案。作者说的 13 个严格校验错误数未核实（技能不在仓库，无法运行）。

4. **每个产生或修改的值，使用它的地方都能接受吗？**
   本 PR 自身没有可执行值；ADR 计划新增的值逐项核对如下：
   - `ci-vps-gate`：当前 `ci/policy.schema.json:64`、`.github/actionlint.yaml:4`、`scripts/ci/contracts.mjs:7`、`check-policy.mjs:323` 都还不接受；ADR 计划在 PR B 同步，这是必须的。
   - `ghgate.slice`：当前 `gh-runner.service.in:9` 写死 `gh-runners.slice`，`install-runner.sh:30/111` 也不安装它；只按 ADR 列出的改动实现会失效（发现 1）。
   - runner id `3`：`register-runner.sh:11-14` 只接受 `1|2`，`uninstall-runner.sh:10-14` 只接受 `2|all`，ADR 计划改；`install-runner.sh` 会遍历 `RUNNER_IDS`，但 `prepare-vps.sh:39` 的验证仍只覆盖 1、2 号，`uninstall-runner.sh:17` 的共享单元没有 `ghgate.slice`。
   - `gateRunnerLabel` / `upgradeGateRunnerPolicy`：当前不存在；ADR 计划在 PR B 加到 `contracts.mjs` 和 `check-policy.mjs`，同时必须改 `check-policy.mjs:323` 对“所有非 macOS 成员都等于 `linuxRunnerLabel`”的校验，否则 required 改成 gate 会被拒绝。
   - `main-confirmation`：`main-workflow.mjs:48` 当前硬编码 `main-confirmation-${github.run_id}`；ADR 计划同步硬规则和反向用例，方向正确。
   - required 的 policy 成员：`ci/policy.json:134` 当前是 `ci-vps`，`ci.yml:327` 也是；改动必须同时覆盖 schema、actionlint、contracts、check-policy 和 ci.yml，缺一处就会在合并闸门或 policy 校验处失败。

**总体建议**：ADR 的方向和大部分现状引用是对的；真正需要先补的是“3 号 runner 的服务模板/安装/卸载/回滚和内存池”这条实现链，以及把 PR A/PR B 的跨文件测试顺序理清。否则后续 PR 很可能按 ADR 做出来一个“标签是专用、内存却没隔离、卸载还留残件”的 runner。
