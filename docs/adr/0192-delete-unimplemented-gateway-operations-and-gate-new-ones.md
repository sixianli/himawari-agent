---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-09"
covers: "ci/operations-pending.json, ci/operations-removed.json, packages/gateway-contracts/src/contracts-v2.ts, packages/persistence-sqlite/test/memory-reminder-cancelled-migration.contract.test.ts, packages/persistence-sqlite/test/migration-engine.contract.test.ts, scripts/check-operations.mjs, test/integration/production-memory-capture.test.ts, test/tooling/operations-check.test.mjs"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0192：删除没人实现、没人调用的网关操作，并加检查拦住新的空壳

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [逐项删除的理由](#deletions)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 P1-4（Andy 2026-10-31 写，2026-11-08 按 main 重核，2026-11-09 同意变更清单和“待接入名单”的做法）。前端和后端之间约定了一批操作（网关 v2 的查询和命令，定义在 `packages/gateway-contracts/src/contracts-v2.ts`），其中一些只有名字没有实现，一些实现了没人调用，还有前端点的是 A 后端做的是 B。写得快、没人检查“定义了的东西有没有人用”，这类空壳会越积越多，没人知道哪些是真的。

动手前对着代码核对的现状（main fd283e43）：约定里共 96 个查询和命令（不含只作回执的快照和事件），其中 78 个在删除后保留。块里点名的 4 类都存在：

- 提醒的“取消”和“忽略”写成同一个状态 `dismissed`；模型工具 `reminder_cancel` 也一样。
- 重建线程搜索投影的 `rebuildSearch`，全仓只有一处集成测试调用。
- `memory.search`、`memory.detail`（和它们的回执 `memory.snapshot`）：前端记忆页走 `memory.overview.read`，后端没有处理分支。
- 记忆投影：`HybridMemoryProvider` 实现了 `MemoryProviderProjectionPort`，保留；没有实现者的只有 `memory.snapshot` 和界面清单里的 `MemoryProjection` 这个名字。

扫描还发现块里没写的两类：另有 14 个操作后端和前端都没有、也没有测试（连同上面 4 类里的 `memory.search`、`memory.detail`，共 18 个，全部删除）；约 23 个操作缺调用方、缺测试或两者都缺，其中一部分后端适配器已实现但生产没有装配。

产品愿景的取舍依据：边界与可逆性优先于效率。删除的都是没有任何调用方的约定，可以从提交历史恢复；保留但缺项的不静默删除，登记在名单里等 Andy 决定。

<a id="decision"></a>

## 决定

1. **提醒补真取消**：迁移 0085 把 `memory_reminders.status` 的约束改成 `scheduled`、`dismissed`、`cancelled`，只有 `scheduled` 的行没有关闭时间（原来是只有 `dismissed` 的行有）。`memory.reminder.respond` 的 `cancel` 和模型工具 `reminder_cancel` 都写 `cancelled`：不再出现在到期和即将到来列表，年度提醒也不顺延，记忆本身保留（界面文案本来就这样写）。`dismiss` 仍然是“这一次先不管”，年度提醒顺延到下一年。关闭时间沿用 `dismissed_at` 这个列名，含义是“这条提醒被关闭的时间”，不改名以免多一次改表。老数据里已有的 `dismissed` 行不回填：Andy 的规则是不为旧数据做兼容，旧行无法区分当时点的是取消还是忽略。
2. **删除 `rebuildSearch`**：端口方法、SQLite 实现、适配器和唯一的集成测试调用。线程搜索投影按需写入，没有任何生产、脚本或模型工具需要重建它。
3. **从约定里删除 18 个操作和 8 个只服务它们的回执**（见下节）。界面清单里因此没有任何操作的页面（任务、收件箱与摘要、追踪、设置）改成“约定缺失、集成被阻止”，`isSurfaceInstalled` 对没有任何操作的页面返回“未安装”，不再因为空列表而判成已安装。
4. **新增检查 `npm run check:operations`**（`scripts/check-operations.mjs`，属于 `npm run check`）：对约定里每个查询和命令，要求同时有后端实现（`apps/*/src`、`packages/*/src` 里有它的字面量，生产安装名单本身不算）、调用方（`apps/control-center/src`、`scripts`、`apps/admin-cli/src` 里有人发送它，界面文案 id 不算）、测试（真正的测试文件里引用它，夹具不算）。缺一项就报红并写明缺哪项。生产安装名单（`PRODUCTION_*_OPERATIONS`）里出现约定里没有的名字也报红。
5. **待接入名单 `ci/operations-pending.json`**：缺项但暂时保留的操作逐项登记，理由必须写明缺什么、为什么留着。名单里的操作一旦补齐，检查要求移出；名单外新增的缺项直接报红；名单里写了约定里没有的操作、或没写理由，都报红。名单目前登记 23 项，按理由分四组：自主建议、反思、委派、改进（`autonomy-gateway-adapter` 已实现但生产没装配、前端没有页面）；主机文件和工作区（`host-workspace-gateway-adapter`，同样情况）；已安装但前端没有入口的几项（`workspace.copy.*`、`memory.basis.read`、`proactive.audit.respond`）；`github.monitor.set_state`（`integration-github` 已实现，生产没装配）。这些是否整组删除，由 Andy 以后单独决定。
6. **已删除名单 `ci/operations-removed.json`**：记下这次删出约定的 26 个名字。检查要求它们不得回到约定里，也不得在后端、前端、脚本和测试里再以带引号的字面量出现（界面文案 id 的 `message("名字")` 和计时标签 `measure(…, "名字")` 除外）；删掉这份名单文件本身也会报红，防止留下指向已删操作的残余引用（第 1 轮复核就发现过一处测试仍在用 `session.revoke`）。
7. **页面状态**：任务、收件箱摘要、追踪、设置四个页面现在没有可用的约定，在清单里标为 `contractStatus: "missing"`、`integrationPolicy: "blocked"`；任务页面仍然保留 `github.monitor.set_state` 在待接入名单里。会话与设备页面靠原生设备入口显示，不受已安装名单限制。`isSurfaceInstalled` 对线程页直接返回真，对健康与部署页只看依赖是否可用，其余页面要求至少有一个操作且全部已安装。
8. **提醒的“取消”**：迁移 0085 给 `memory_reminders.status` 加入 `cancelled`；已取消的提醒只接受再次取消和恢复（`restore`，PR 625 加入：改回已排期、时间不变，提醒页“最近取消”和取消后的“撤销”都发它），忽略和稍后提醒会被拒绝（`MEMORY_REMINDER_CANCELLED`）。模型工具 `reminder_cancel` 和网关的取消一样，也能把已忽略的提醒改成已取消。

<a id="deletions"></a>

## 逐项删除的理由

以下操作在约定里有定义，但后端没有任何处理分支、前端和脚本没有任何人发送、也没有测试在使用（夹具和契约往返测试不算）。逐个确认过没有隐藏调用方：模型工具、脚本、测试夹具、管理命令行里都没有。

| 操作 | 删除理由 |
| --- | --- |
| `thread.checkpoint.request` | 后端没有处理分支，前端没有人发送，没有测试使用 |
| `thread.timeline` | 后端没有处理分支，前端没有人发送；线程内容走独立的线程 v3 网关 |
| `task.set_state`、`task.list`、`task.detail` | 任务页没有实现，后端没有处理分支 |
| `settings.read`、`settings.update` | 设置页没有实现，后端没有处理分支；已有的设置各自用专门的操作（如 `owner.preferences.*`） |
| `inbox.list`、`inbox.detail`、`inbox.digest` | 收件箱和摘要页没有实现，后端没有处理分支 |
| `trace.timeline`、`trace.detail` | 追踪页没有实现，后端没有处理分支 |
| `identity.sessions`、`identity.session_detail`、`session.revoke` | 会话与设备页用原生设备接口，不走网关 v2 |
| `health.status` | 健康页直接读 `/api/health/v1/dependencies` |
| `memory.search`、`memory.detail` | 记忆页走 `memory.overview.read` |
| 回执 `task.snapshot`、`inbox.snapshot`、`digest.snapshot`、`memory.snapshot`、`trace.snapshot`、`settings.snapshot`、`session.snapshot`、`health.snapshot` | 只服务上面被删的查询，没有别的操作返回它们 |

同时删除只服务它们的辅助定义（[attentionLevelSchema](https://github.com/sixianli/himawari-agent/blob/fd283e437a172cfbe807dddaae5da674cc814c18/packages/gateway-contracts/src/contracts-v2.ts)、[integrationHealthSchema](https://github.com/sixianli/himawari-agent/blob/fd283e437a172cfbe807dddaae5da674cc814c18/packages/gateway-contracts/src/contracts-v2.ts)），以及 e2e 夹具服务器和契约夹具里对应的假数据。

<a id="options"></a>

## 放弃的做法

- **把名单里的操作和适配器一并删除**：严格按块的规则它们都该删，但那是三个网关适配器、前端治理页和一批测试，不是“清理空壳”的量级，回归风险大。改成登记并逐项写理由，由 Andy 以后单独定。
- **用 `status = 'dismissed'` 加一列区分取消和忽略**：状态本身表达得最清楚，也让“到期”“即将到来”的查询不必多一个条件。
- **取消提醒时同时删除它的记忆**：界面文案一直写“记忆本身保留”，删除记忆是另一个决定，也会和进行中的敏感记忆改动重叠。
- **检查只看生产安装名单**：会漏掉约定里定义了、却从没安装也没有调用的名字，也就是这次删掉的大部分。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `npm run check:operations`：真实仓库零报红；`test/tooling/operations-check.test.mjs` 的 `[P1-4]` 用例带反向输入：缺后端、缺调用方（界面文案同名不算）、缺测试（夹具不算）、名单里的操作已齐全、名单项没理由或不在约定里、安装名单里有约定外的名字，都必须报红。
  - `test/integration/production-memory-capture.test.ts`：取消写 `cancelled`、忽略写 `dismissed`，两者可区分；年度提醒取消后不再顺延；`reminder_cancel` 工具同样写 `cancelled`。去掉这次修改时这些断言失败。
  - `test/tooling/operations-check.test.mjs` 的已删除名单用例：已删操作以 `type:`、`case`、`send(...)` 等字面量残留、已删操作或回执回到约定都报红，界面文案 id 和计时标签不误报。
  - `packages/persistence-sqlite/test/memory-reminder-cancelled-migration.contract.test.ts`：旧的待办和已忽略提醒整行保留，外键、索引、约束仍在。
  - `packages/persistence-sqlite/test/migration-engine.contract.test.ts` 等迁移测试：0085 能在旧库上应用，当前版本号是 85。
- 不改变发给模型的请求开头：`reminder_cancel` 的名称、参数和说明文字都没变，只是执行后写的状态不同。
- 迁移 0085 随下次上线生效；表里没有需要回填的数据。
- 已知缺口（不在这次做）：名单里的 23 项是否删除；`memory.basis.read` 要等记忆页接入。

<a id="references"></a>

## 关联文档

- [ADR 0194](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md)：`memory.basis.read` 的来源。
- [ADR 0143](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0143-decision-ledger-for-model-gate-decisions.md)：决策记录（原“决策账本”）。
- [产品愿景](../product-vision.md)：边界与可逆性优先于效率。
