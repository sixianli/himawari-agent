# P1 第二批：环境权限上限、扩权分类与缩小上限

日期：2026-09-25 UTC。对应[隔离执行实施计划的 P1](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p1)前四项。规则来源是 Spec 的[环境权限上限与换新环境](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#envelope)和[谁可以批准扩权](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#expansion-approval)。本批实现的是判断规则和协调服务的换新环境操作；它们还没有接到真实的工具调用路径（属于 P3），测试里的后端仍是测试替身（只模拟后端应答的测试程序）。

<a id="contents"></a>

## 目录

- [用词](#terms)
- [上限规则](#rules)
- [扩权由谁批准](#classification)
- [审批需要携带的内容](#approval-context)
- [撤权与过期](#withdrawal)
- [改前失败与反向检查](#red-runs)
- [验证命令与结果](#verification)
- [留给后续阶段的事](#later)

<a id="terms"></a>

## 用词

| 用词 | 意思 |
| --- | --- |
| Run（一轮） | 用户每发一条消息，产品就启动一个 Run，直到这条消息处理完 |
| 环境权限上限 | 一个隔离环境里任何程序最多能做的事：能读写哪些目录、能连哪些网络目标，以及资源额度 |
| 扩权 | 把新能力加进本轮环境的上限；获批后一律换一个新环境 |
| 委托清单 | 由人配置、带版本号的扩权项列表，自动审查只能批准其中的项，例如“允许访问 npm registry” |
| 范围授权 | 已有的、覆盖一类操作的授权记录，与只批准一次的授权相对 |
| 自动审查 | 现有的自动审批组件；它作出的决定要单独标明来源，不能显示成用户确认 |

[↑ 返回目录](#contents)

<a id="rules"></a>

## 上限规则

实现：[`execution-envelope-policy.ts`](../../../../../packages/application/src/services/execution-envelope-policy.ts) 的 `decideEnvelopeChange`；测试：[`execution-envelope-policy.unit.test.ts`](../../../../../packages/application/test/execution-envelope-policy.unit.test.ts)。

| 规则 | 测试中的断言 |
| --- | --- |
| 本轮第一个调用确定初始上限 | 第一个调用由人批准时，上限等于它获准的目录和网络目标，资源额度取主机策略；不需要换环境 |
| 上限内的调用不换环境 | 目标在上限内时返回“在上限内” |
| 超出上限要扩权并换新环境 | 返回扩权项；批准齐全后新上限 = 旧上限 + 新能力，且必须换新环境 |
| 同一目录由读升级为写 | 仍算扩权，要由人批准，新上限里该目录改为可写 |
| 文件工具不扩大上限 | 目标在上限外时判为超出上限，不产生扩权项 |

协调服务新增 `rotate`（先整体停止当前环境并接收停止证明，再按新上限建下一个环境）。集成测试[“adds a delegated capability only by stopping the environment and creating the next one”](../../../../integration/task-execution-environment.test.ts)在真实 SQLite 上验证：委托清单内的 npm registry 由自动审查按当前清单批准后，旧环境被释放，停止记录写明原因和会被停掉的后台程序，第 2 个环境的上限包含 npm registry，后端一共创建两次。停止未确认时不建新环境，旧环境的占用仍挡住其他任务。

[↑ 返回目录](#contents)

<a id="classification"></a>

## 扩权由谁批准

| 能力 | 谁可以批准 | 测试中的断言 |
| --- | --- | --- |
| 写入不在上限内的目录 | 只能由人 | 自动审查的决定不生效，第一个调用里也一样 |
| 清单外的网络目标、清单外的目录读取 | 只能由人 | 同上 |
| 委托清单内的项 | 自动审查或人 | 自动审查的决定必须引用当前版本的清单；引用旧版本，或只是对命令作出的自动批准（没有引用清单），都不生效 |
| 凭据 | 每次由人在本次审批中确认 | 凭据从不进入上限；自动审查和范围授权都不能代替 |

**范围授权代替当次确认**：只有同时满足“由人作出、状态有效且未过期、明确覆盖”才代替。明确覆盖的含义是同一主机的同一授权根目录且访问级别足够，或完全相同的网络目标；上级目录的授权不能推出子目录。自动审查作出的、已过期的、已撤销或用完的授权都不能代替。代替时，这项能力在上限里的期限跟随该授权。

**委托清单合同**：[`execution-environment-v1.ts`](../../../../../packages/execution-contracts/src/execution-environment-v1.ts) 的 `executionDelegationListSchema` 只接受完全相同的网络目标和目录读取两类；写目录、凭据、通配或没有端口的网络目标，以及重复项，在解析配置时直接拒绝。

[↑ 返回目录](#contents)

<a id="approval-context"></a>

## 审批需要携带的内容

`envelopeApprovalContext` 给出审批要展示的内容：当前环境已有的能力、这次要加的能力；需要换新环境时，再列出会被停掉的后台程序；不换环境时不列。它还没有写进实际的审批请求，原因见[留给后续阶段的事](#later)。

[↑ 返回目录](#contents)

<a id="withdrawal"></a>

## 撤权与过期

- `envelopeAfterWithdrawal` 去掉来源授权已撤销或已过期的能力，并给出剩余能力里最早的到期时间。
- 协调服务的 `withdraw` 在有能力被去掉时停掉当前环境，按剩下的能力建新环境；被去掉的目录对应的环境级占用（`lease`，整个环境持有的工作目录占用登记）一起去掉。换新原因在有撤销时记为撤权，否则记为过期；没有能力被去掉时不换环境。
- 集成测试让网络目标 A 比 B 早到期：到 A 的期限时，第 2 个环境只保留 B，返回的下一次到期时间是 B 的期限；再撤销目录授权时，第 3 个环境没有目录和占用，另一个 Run 随即可以使用该目录。

[↑ 返回目录](#contents)

<a id="red-runs"></a>

## 改前失败与反向检查

- 测试先放进仓库再加实现：规则测试因模块不存在无法加载；委托清单合同测试 1 项失败；换新环境的 3 项集成测试失败，其中 `withdraw` 那一项的错误是 `f.coordinator.withdraw is not a function`。这些只证明测试写在实现之前，不证明行为。
- 为确认测试能发现规则缺陷，逐项临时破坏实现后重跑，再按原样恢复（逐字节比对一致）：

| 临时破坏 | 结果 |
| --- | --- |
| 自动审查引用任何版本的清单都算数 | 2 项失败 |
| 范围授权不检查是否由人作出 | 1 项失败 |
| 缩小上限时忽略已过期的能力 | 1 项失败 |
| 凭据只要有任何审批就算已确认 | 1 项失败 |

[↑ 返回目录](#contents)

<a id="verification"></a>

## 验证命令与结果

基于提交 `98cb7dc` 加上本批改动，Node.js 22.22.3，macOS。测试套件在本机沙箱之外运行，因为沙箱禁止监听本机端口和套接字。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`；改动文件的 `biome format` 与 `biome lint --error-on-warnings` | 通过 |
| `npm run test:contracts` | 355 项通过（比上一批多 1 项委托清单合同测试） |
| `npm run test:unit` | 1967 项通过（多 14 项上限规则测试） |
| `npm run test:integration` | 1774 项通过；`installable-node-services.test.ts`、`production-http-composition-process.test.ts` 共 6 项需要 `npm test` 提供的预打安装包，这一轮没有运行 |
| `npm run test:e2e` | 3 项通过 |
| `npm run check:pi-compat` | 130 项通过 |
| `validate_docs.py --strict .` | 通过 |

完整输出在 [`raw-logs.tar.gz`](raw-logs.tar.gz)。提交后另跑正式的 `npm test`，结果见下一段。

[↑ 返回目录](#contents)

<a id="later"></a>

## 留给后续阶段的事

- **审批请求携带环境信息（P3）**：审批请求由现有 ActionPolicy 生成；要等 P3 把工具准入接到任务环境，才能把当前能力和会被停掉的后台程序写进审批请求，并与审批摘要绑定。会话内显示属于 P6 的审批卡片任务。
- **把现有授权记录映射为“由谁作出”（P3）**：规则只看来源标记。P3 接入时，带自动审查记录的审批映射为自动审查；Owner 保存的长期策略授权（例如联网搜索“记住选择”）是否算“由人作出”，需要在接入时按 Spec 核对后决定，本批没有预设。
- **委托清单的保存与审计（P5）**：本批只有配置合同和规则；清单的持久保存、每次修改的审计和按清单批准的审计属于 P5 的委托清单任务。
- **到期自动触发（P3/P4）**：`withdraw` 返回下一次到期时间，但还没有计时或恢复流程在那一刻调用它。
- **端到端验收**：ITE-10、ITE-16、ITE-20 的真实用户路径在 P3。

[↑ 返回目录](#contents)
