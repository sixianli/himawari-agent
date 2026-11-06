# PR 260 复核报告（复核到 57910cd，基准 a429ff0）

## 复核路径

先看全量 diff 与 3b41b0e 之后的增量，再逐个核对改动文件与其两端：`resume-runners.sh` 对照 `mac-runners.sh`（label_states/has_label/add_label）与 Runbook/ADR 0169 的文字，`install-runner.sh` 的 ERR trap 对照 mount-namespace 测试，`vitest.workspace.ts` 对照 `test-timeout.test.mjs` 与 4 份文档，`hermes-runner-scripts.test.mjs` 对照脚本消息。未运行任何测试（无权限），静态核对为主。

## 问题清单（按严重度从高到低）

**1｜低｜.agents/instructions/test-and-production-hosts.md:14（及 test-host-operations-runbook.md:61）｜“唯一的例外”措辞与另两份文档不完全对齐**
证据：这两处写「不放宽测试时限（唯一的例外：`tooling` 项目的单条测试时限是 15 秒…）」；而 `docs/architecture-v0.1.md:621` 写「integration 仍为 30000ms，tooling 为 15000ms…其他未自设时限的项目使用 Vitest 默认 5000ms」。integration 的 30 秒大于默认 5 秒，严格说也是一处例外，只是它早于本次改动存在。建议：把「唯一的例外」改成同时点名 integration 30 秒与 tooling 15 秒，或注明 integration 是既有值。

**2｜低｜scripts/operations/hermes-runner/resume-runners.sh:9-12,14-17｜多条错误路径无测试覆盖**
证据：新增的 resume 测试（test/tooling/hermes-runner-scripts.test.mjs:498-632）覆盖了对账不一致、启服务失败、等上限、打标签失败、标签回读失败等 9 条；但第 9 行上传失败、第 10 行 Hermes 列表失败、第 11 行 GitHub 列表失败三条 `RUNNER_RESUME_FAILED labels and services untouched` 路径，以及第 15 行 trap 里 `github_runners` 读不到时标签写成 `unread` 的路径均无断言。且全文件所有 resume 用例只用 `labelled:false`（第 553、565 等行均显式传参），「标签已存在则跳过加标签」分支（脚本第 21 行）没有被测过。建议：补至少 2 条：已带标签时直接进启服务、上传/列表失败时不动 Hermes。

**3｜低｜docs/runbooks/hermes-self-hosted-runner-runbook.md:5｜contract_sha256 是否与正文重新封存一致无法核实**
证据：diff 把该值从 `bac7863…` 换成 `f8a2a59c…`；封存校验是 `document-governance` 技能的手动步骤，仓库内已无自动门槛（incidents-and-gates.md:45 记 I-06「`npm run check:docs` 已于 2026-10-31 删除…不再拦提交」）。我只能确认值变了，不能确认它是按当前代码算出的。建议：完整模式下跑一次 `validate_docs.py . --strict` 并留证据。

**4｜信息｜docs/adr/0169-…md:104｜新顺序未经 Hermes 实测，作者已在文内如实声明**
证据：「新顺序还没在 Hermes 上实测」。与 Runbook 第 146 行的描述一致，无隐瞒，但请在合并前安排一次真机恢复验证。

**5｜信息｜vitest.workspace.ts:8｜随之删除的两条注释丢失了原有说明**
证据：diff 删除了「Tooling owns synthetic Git repositories…」和「Durable integration cases start workers…」两行。「不写代码注释」是作者声明的约束， hormones此变动本身自洽，但这两段理由没有落进任何文档，属单向损失。建议：如需保留，可在对应 ADR 或 spec 里补一句。

**无中、高严重度问题。** 作者关于 PR 260 第 2 轮的全部说法（消息改法、四处文档更新、ADR 0169 测试清单、新增测试）逐条与代码相符；作者说法中未能核实的只有「旧顺序跑新测试有 6 条失败」这一**具体数目**（方向已证实，见必答第 3 题）。

## 侧重检查

普通流程「暂停 → 恢复」：
- 暂停 `pause-runners.sh`：入口、对账、去标签、等空闲、停服务共 18 条测试（hermes-runner-scripts.test.mjs:307-496），覆盖完整，含锁定、中断、部分失败。
- 恢复 `resume-runners.sh`：本次改动核心（先加标签→回读→启服务→等线上），9 条测试覆盖（第 499-632 行）。
- 未覆盖路径（经入口可走到）：resume 的上传失败（脚本第 9 行）、Hermes/GitHub 列表失败（第 10-11 行）、中断时 GitHub 同时读不到、已带标签的跳过分支（第 21 行）——对应第 2 条问题。
- `install-runner.sh`：仅在另一主机/无 root 的拒绝（第 766-825 行）和 mount-namespace 回滚（第 1051-1202 行）有覆盖；成功路径有 mount-namespace 用例。ERR trap 新消息有断言（第 1173 行 `INSTALL_STEP_FAILED line \d+ exit 1: return 1`）。
- `vitest.workspace.ts` 的 tooling 15 秒由 `test-timeout.test.mjs:39` 锁住，`registeredTests`（quality/qualification）没有名为 tooling 的项目（ci/policy.json 无 `"project": "tooling"`），不会漏改某个注册测试项目。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。读代码证实：diff 只涉及运维脚本、测试、配置与文档，`packages/`、`apps/` 下零改动，系统提示、工具定义、历史消息、遮盖逻辑均未触碰；vitest 的 `env/toolingEnvironment` 只用于测试环境。附带说明（推断）：`.agents/instructions/test-and-production-hosts.md` 会进入代理会话的提示，但这属于新一轮会话正常加载 changed 文档，不是对已发内容的改写。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。脚本输出的所有可变部分（`service_states`、`label_states`）由主机状态决定，同状态输出逐字节相同；输出顺序按 `$NAMES` 稳定；无时间戳、无无序集合进入输出文本；遮盖未涉及。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 有，且方向上会失败。读代码证实：旧 resume 消息是「services not started …queued jobs keep waiting」「labels=removed」，新测试断言（第 560、572、612、625 行）引用新文案，旧脚本必不匹配；旧 `install-runner.sh` 无 `INSTALL_STEP_FAILED`（scripts/…/install-runner.sh:53 是新增 echo），第 1173 行断言必失败；旧配置无 `testTimeout: 15_000`，`test-timeout.test.mjs:39` 的 `expect(…).toBe(15_000)` 必失败。「恰好 6 条」「恰好 N 处」这类**数目**是推测，未经运行。
4. **每个新值的两端核对**：①「did not start the services」「an active runner may already take queued jobs」「labels=restored」——产生于 resume-runners.sh:28/36/50，消费端为 Runbook:146 段落与测试第 560/572/612/625 行，文案一致；② toolsing `testTimeout: 15_000`——产生于 vitest.workspace.ts:46，消费端为 Vitest 运行时与 test-timeout.test.mjs:39，另有 4 处文档（test-and-production-hosts.md:14、test-host-operations-runbook.md:61、architecture-v0.1.md:621、quality-gates 设计 spec:151）全部写 15 秒；③ `INSTALL_STEP_FAILED line … exit …: $BASH_COMMAND`——产生于 install-runner.sh:53，消费端测试第 1173 行按正则接受，`$BASH_COMMAND` 只会出现安装命令与下载 URL，不含注册 token（token 只经 stdin，register-runner.sh:16）；④ Runbook 引用的 ADR 0168 存在且 0168 引用的 ADR 0170 文件存在（glob 证实）。唯一不能确认的是第 3 条清单里的 runbook 封存摘要（见问题清单第 3 条）。
