# PR 456 代码复核材料

## 问题

Himawari 给模型的工具有两条授权路。读文件、写代码、联网搜索先组一份动作意图交给权限引擎（`ActionPolicyService`）。建提醒、取消提醒、定规则、撤销规则这几个内置工具只查“这个工具这一轮给没给模型”。决定和前提见 `docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md`。

## 目标（只做 ADR 的第 1 步）

- 新增工具动作登记表（`packages/application/src/services/tool-action-registry.ts`），生产的行在 `apps/agent-service/src/production-tool-actions.ts`。没登记的工具不给模型。
- 上面四个有后果的内置工具执行前走统一出口（`apps/agent-service/src/owner-scope-authorization.ts`）：组动作意图，过规则手册新增的“动作”闸门（`packages/application/src/rules/action-rules.ts`），再进权限引擎。
- 内置规则 `action_preauthorize_owner_data` 预先授权“中风险、能撤销、只动主人自己数据”的动作，用现有的长期授权做法（`applyOwnerPolicyAuthorization`），背后有一条 `product_state_records` 记录（键 `action-rule:<规则编号>`）。
- 事实代码登记表（`packages/application/src/services/policy-fact-registry.ts`），`validateGovernedActionIntent` 拒绝表外或没排序的代码。

## 约束

- 第 1 步行为不变：主人正常让她建提醒、定规则，仍然直接做，不出审批卡片。
- 发给模型的工具定义（字节和顺序）不能变。
- 不改数据库表。
- 任务管理（`execution_task_status`、`output`、`cancel`）只登记，授权照旧。
- 外来内容相关的事实和规则是第 2 步，这个 PR 不做。

## 作者的说法（请逐条核对，不要直接采信）

1. 全部 23 个工具的名字和定义哈希与 main 相同（`apps/agent-service/test/production-runtime-tools.unit.test.ts` 里带 `[ADR-0257]` 的用例，哈希取自干净的 origin/main）。
2. 统一出口返回“等主人点头”时工具不执行，同一次调用重放不会重复建审批，主人同意后只执行一次；返回拒绝时不执行（`test/integration/tool-action-registry.test.ts`）。
3. 同一次工具调用重放时，动作意图是冻结后读回来的（`#ownerScopeGate` 里的 `freeze`），不会因为时钟变了换一个意图。
4. 长期授权记录被关掉（`enabled: false`）后，新的动作改成问主人。
5. 读取类内置工具（recall、reminder_list、rule_list）不经过统一出口，和以前一样。
6. 现有读文件、写代码、联网搜索三条路现在写出的事实代码都在登记表里且已排序，不会被新加的校验拒掉。

请特别看：统一出口有没有能被绕过的路径；`#ownerScoped` 里“先查上次结果、再过出口、再执行”的顺序有没有重复执行或漏授权的情况；并发的两次相同调用；`#standingAuthorization` 在记录不存在、被关掉、规则修订号变了三种情况下是否正确；登记表校验有没有漏掉会让有后果的工具被当成读取的情况。
