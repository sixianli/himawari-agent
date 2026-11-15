### 1. 高 — 对比基准不是这个 PR 实际合入的基线，“已合进最新 main”的说法不成立

文件:行：`git diff ed4d42f3b67a0ed65dc7948835ed18055bdd3d09..982da2990b7bb73d0f23a5a81c770be7f874cbbb`；`apps/agent-service/src/production-capability-lifecycle.ts`

问题：材料说这一轮“合进了最新 main”，但 982 的历史里没有 ed4d42（PR #435 的合并提交），也没有 2ed0e85ce、ef8b152f7。当前 100 个文件的 diff 里混进了大量“main 有、PR 分支没有”的反向改动，不能当成这个 PR 的改动来审。

证据：
- `git log --oneline -12 982da2990b7bb73d0f23a5a81c770be7f874cbbb` 的第一行是 b493e62db，随后是 f6997c3b0…，没有 ed4d42。
- `git diff --stat f6997c3b0..982da2990b7bb73d0f23a5a81c770be7f874cbbb` 是 57 个文件、4866 insertions、92 deletions；而 `git diff --stat f6997c3b0..ed4d42f3b67a0ed65dc7948835ed18055bdd3d09` 是 52 个文件，里面 `production-capability-lifecycle.ts | 42 ++++`。
- 反过来 `git diff ed4d42..982` 显示该文件 `42 -`，`production-approval-gateway.ts` 删掉 `PRODUCTION_CAPABILITY_OPERATIONS`、`recentAuthenticationRef` 等；这些是 main 新增、PR 分支没有的内容，不是 PR 删的。
- `git log --oneline ed4d42..982 -- apps/agent-service/src/production-capability-lifecycle.ts` 没有任何提交。

建议：用 merge-base 的三点 diff（或先 rebase 到 ed4d42）重新确定评审范围；本轮应只看 `f6997c3b0..982` 的 57 个文件。不要把 capability 生命周期、治理页 recentAuthentication 等 43 个文件的差异记到本 PR 头上。

### 2. 中 — 删除 GitHub 监控历史会删 runs，却不清理这些 run 的 device_actions 和 payloads

文件:行：`packages/persistence-sqlite/src/sqlite-durable-operations.ts:3771`、`:3801-3821`、`:3865-3869`；`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:783`、`:807`、`:846`

问题：本 PR 只给受管删除（thread/run/task）加了 `#removeDeviceActions`，但另一个会删除 runs 的路径 `deleteGitHubMonitorHistory` 没同步清理。`device_actions.run_id` 没有外键（迁移 `:53` 只是 `TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128)`），所以这些行会留下来，`arguments_ref`/`result_ref` 的 payload 也不会被收集。

证据：
- `deleteGitHubMonitorHistory` 先收集 `runIds`，随后只从 `run_checkpoints`、`run_payload_artifacts`、`approval_requests`、`trace_events` 等表收集 `payloadRefs`（`:3801-3821`），最后 `DELETE FROM runs WHERE id IN (...)`（`:3865-3869`），全程没有 `device_actions`。
- 对比 `sqlite-governed-deletion.ts` 的 `#removeDeviceActions`（`:1026-1045`）以及三处调用（`:783`、`:807`、`:846`）。
- 删除后这些动作还会被 `/actions` 列出、被设备 claim、被数据导出，只是 `threadId` 变成 null。

建议：在 `deleteGitHubMonitorHistory` 里复用同一套 device action 收集/删除逻辑（或把 `device_actions.run_id` 改成 `REFERENCES runs(id) ON DELETE CASCADE` 并在删除前先收集 payload refs）；补一条“删监控历史后 device_actions 和 payload 都清掉”的测试。

### 3. 中 — 工具定义仍对模型说“会先请主人确认”，describe 仍返回 `confirm: true`，但生产授权实际上把所有非只读动作直接拒绝

文件:行：`packages/prompt-catalog/src/perception.ts:15`；`packages/application/src/services/device-action-service.ts:177-183`、`:192-204`

问题：作者说法第 3、4 条自己承认审批未接上、非读动作一律拒绝；模型看到的工具描述却仍是“涉及删除、对外发送、花钱、门锁的动作会先请主人确认”，`describe` 也继续返回 `confirm: !reads`。当前实际行为是 `ReadOnlyDeviceActionAuthorization` 对非低风险只读动作返回 `approval_not_connected`，不会弹确认卡。这是规则/提示文字与代码不一致，而且是本 PR 删掉同步确认钩子后变得更明显。

证据：
- `perception.ts:15`：“…涉及删除、对外发送、花钱、门锁的动作会先请主人确认。”
- `device-action-service.ts:178-182`：`if (intent.actionKind === "READ" && intent.risk === "LOW" && !intent.ownerPresence) return { decision: "allow", ownerPresent: false }; return { decision: "deny", reasonCode: "approval_not_connected" };`
- `device-action-service.ts:196-203`：`reads` 为真才 `confirm: false`，其余一律 `confirm: true`。
- 集成测试 `test/integration/device-actions.test.ts:427-454` 也确认所有非读动作都得到 `rejected / approval_not_connected`。

建议：本 PR 至少在工具描述或 describe 的 `confirm` 语义上改成“需要审批，但目前审批未接上会被拒绝”，或让 `confirm` 反映授权端口当前是否支持审批；注意工具定义属于冻结的请求开头（prompt-prefix 规则 6/7），上线后再改只对新对话生效，最好现在改。

### 4. 低 — “最近结束的动作列表”按 created_at 排序且固定 100 条，没有游标，超过上限时真正最近结束的会被挤掉

文件:行：`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:218-235`；`packages/platform-node/src/device-api-routes.ts:108-110`、`:671-690`

问题：`finishedSince` 分支把“打开中的动作”和“finished_at >= since 的动作”混在一起，但排序仍是 `ORDER BY created_at, id LIMIT 100`。当打开中的动作或更早创建的动作超过 100 条时，最近结束的动作可能完全取不到；路由也没有分页游标。

证据：
- `sqlite-device-action-operations.ts:218-224`：`SELECT ... WHERE ... AND (? IS NULL OR state IN ('waiting_owner', 'queued', 'delivered', 'result_unknown') OR finished_at >= ?) ORDER BY created_at, id LIMIT ?`
- `device-api-routes.ts`：`DEVICE_ACTION_VIEW_LIMIT = 100`，`GET /actions` 只把 `finishedSince` 传下去。

建议：`finishedSince` 场景按 `finished_at DESC, created_at DESC, id` 排序，或把打开中的动作与已结束动作分开查询；至少给列表加游标/分页，避免 100 条之后不可见。

### 5. 低 — 设备动作的状态变化没有完整落到 decision_ledger

文件:行：`packages/application/src/services/device-action-service.ts:287-296`、`:549-565`、`:730-747`；`packages/persistence-sqlite/src/migrations/20261114172043_device_actions.sql:85-97`；`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:239-275`

问题：两条路径会导致决策记录缺项：
1. `settleDue` 在 SQLite 事务里改完状态并提交，之后 `settle()` 才逐条 `#ledger()`；`claim`、`decide`、`changePolicy` 也是先改库再写账。写账失败时状态已经不可逆地变了，下一次 `settleDue` 不会再返回这些记录，账目永久缺失。
2. 设备撤销由数据库触发器直接把 `waiting_owner/queued` 改成 `rejected`、`delivered` 改成 `result_unknown`，完全没有经过 `DeviceActionService`，因此不会追加 `decision_ledger`（policy 变更那条除外）。

证据：
- `device-action-service.ts:288-295`：`const settled = await store.settleDue(...); for (const record of [...settled.expired, ...settled.unknown]) { await this.#ledger(record); ... }`
- `sqlite-device-action-operations.ts:241-274`：状态更新全在 `database.transaction(...)` 内完成并返回。
- 迁移 `:89-96` 的触发器直接 `UPDATE device_actions ... SET state = 'rejected' ...` / `SET state = 'result_unknown' ...`。
- `sqlite-decision-ledger-operations.ts:140-147` 的账本写入是 `ON CONFLICT(id) DO NOTHING`，但没有任何补偿/重放机制。

建议：把 ledger 写入与状态变更放进同一事务（或记录待写账任务并可重试）；撤销触发器路径增加一个应用层补账步骤，并补测试验证撤销后的 rejected/result_unknown 也有 ledger 记录。

**侧重检查**

- 错误路径与不合规输入：抽查了 `DeviceActionService.request/report/reportSupported/changePolicy` 的入参校验。`report` 限制额外键、id 格式、outcome 枚举、evidence 为普通对象且 ≤64 KiB、reason ≤500 字符；`reportSupported` 限制 ≤500 个名字、每个 ≤64；`changePolicy` 要求本人在场、revision 非负、blockedActions 去重且都在 registry。跨设备报告会被 `wrong_device`/`not_found` 拒掉（`device-action-service.ts:612-613`、`:651-654`）。这些路径结论正常。
- 资源耗尽：`result_unknown` 在 `settleDue` 里不处理（只处理 `waiting_owner/queued/delivered`），`claim` 每次都会重新取它（`sqlite-device-action-operations.ts:244-248`、`:298-308`）。设备一直不回报或已被撤销时，这些行会长期累积并被反复下发；是否属于已判不成立的“终态动作保留期”我无法读到 judgments，未核实。`blockedActions` 数组长度没有单独上限，只依赖请求体大小限制；`views` 每次 GET 会解密最多 100 条参数/结果，高频轮询有额外开销。这些是推测性风险，未见对应测试。
- 不可撤销操作：`#removeDeviceActions` 只覆盖受管删除的 thread/run/task（`sqlite-governed-deletion.ts:783/807/846`），监控历史删除路径遗漏（见意见 2）。设备本身不在 `GovernedDeletionObjectType`（`sqlite-governed-deletion.ts:38`：`"thread" | "run" | "task" | "memory" | "payload"`）里，因此不存在“删设备时清 payload”的路径；只能靠 `paired_devices` 的 `ON DELETE CASCADE` 删行，payload 不会一起清。这一点是读代码确认的，但没有测试覆盖。
- 安全：设备 API 新路由全部 `signed: true`，`actions.policy` 还要求 `authenticated.confirmed`（`device-api-routes.ts` 新路由块）。`report` 的 evidence/reason 会进入模型工具结果；`DeviceActionRegistration.resultOrigin` 没有被任何代码读取（`grep resultOrigin` 只命中 tool-action-registry 和注册表定义），所以“外部来源结果”没有额外标记/遮盖。设备返回的 evidence 直接进入模型上下文，是否存在提示注入面属于推测。
- 规则/文档一致：prompt-prefix 规则要求 `device_action`/`perception_read` 工具定义固定；`perceptionToolDescriptors()` 未改，测试 `device-actions.test.ts:303-350` 还断言工具定义字节不变，这一点符合。工具描述与实际确认行为不一致见意见 3。

**读代码证实的**

- 意见 1 的提交历史与两套 diff 统计。
- 意见 2 的 `deleteGitHubMonitorHistory` 缺少 device action 清理，以及 `device_actions.run_id` 无外键。
- 意见 3 的 `TOOL_DEVICE_ACTION` 文字、`confirm: !reads`、`ReadOnlyDeviceActionAuthorization` 行为。
- 意见 4 的 `ORDER BY created_at, id LIMIT` 与固定 100 条、无游标。
- 意见 5 的 settle/claim 写账在事务外，以及撤销触发器不经过应用层。
- 迁移插入的 `device_action` + 9 个 outcome 与 `DECISION_OUTCOMES.device_action`、`DEVICE_ACTION_RECORD_STATES`、`DEVICE_ACTION_REASON_CODES`、SQL CHECK 列表逐项一致；`dact_` + 32 hex 同时满足迁移 `length=37/substr='dact_'`、`DEVICE_ACTION_ID_PATTERN`、数据导出 schema。
- 新增 perception 配置键 `actionExpirySeconds/actionPresenceExpirySeconds/actionWaitSeconds/actionClaimBatch` 被默认值、范围、`strict-configuration.ts:1501-1509` 的自动遍历解析和设备动作服务同时接受。
- 导出侧 `PERCEPTION_FILE_KEYS`、`DATA_FILES`、`SCHEMA_FILES`、`snapshot.ts`、`export.ts`、`import.ts`、manifest counts 都同步加了 `devicePolicies/deviceActions`；测试用 `toMatchObject`，不会因新增计数键失败。

**推测/未核实**

- 监控触发的 run 是否真的会调用 `device_action`：工具装配看起来是同一套，但未找到专门证据，未核实。
- `result_unknown` 长期不结束是否属于已被判为“终态动作保留期”的问题，未核实；如果已在 Andy 的待定项里，可忽略这一条。
- 新增反向用例“真的会失败”：我无法运行测试，只能确认用例存在且断言方向正确（例如 `device-actions.test.ts:427` 的审批未接上、`:461` 的跨设备/未送达/未读回、`:1207` 的策略关闭、`:1253` 的撤销、`:1373` 的删除）。这些测试在 `ci/policy.json` 的 integration/contracts 项目里，但 `npm run check` 只跑 `package.json` 的 `check:steps`（`scripts/run-all-checks.mjs:32`），并没有全量 integration/contracts；因此它们是否在本次流程中自动执行，未核实。
- prompt-manifest 的新增/删除条目哈希是否与文字匹配，未核实（无法运行 sha256 校验）。

**必答问题**

1. 不会改变模型已经见过的请求开头。系统提示和 `device_action`/`perception_read` 工具定义未改（`perceptionToolDescriptors()` 不变，测试 `device-actions.test.ts:303-350` 还断言字节不变）。新增的 `reason.*`、`usage.device-reminder` 都是 `layer: "tool-result"`，只作为工具结果追加在末尾；删除的 `tools.result.device-action.unconfirmed` 也是工具结果，原文字没有数字或会被出口遮盖认成秘密的内容，所以即使它从固定文字清单消失、旧历史里的这段被按外来内容重新检查，遮出的字节也不会变。每轮会变的设备状态、evidence、reason 都在最后追加的工具结果里，不在系统提示或工具定义里。
2. 不会让同一段文字变成不同字节。`describe` 的设备按 id 排序、动作按名字排序、参数字段排序；参数校验后按键名排序，指纹对数组排序；`detail` 的时间来自设备参数或镜像数据，不含当前时间；`usage` 是固定文字。`DeviceActionService` 只在工具结果里返回 state/reason/evidence/note，不把 detail 塞进模型请求；设备提交的 evidence 本身若相同则 JSON 键序由设备原样保留。没有发现依赖前后文的遮盖或无序集合进入请求开头。
3. 有自动检查，但“反向用例真的会失败”未能执行验证。新增 `test/integration/device-actions.test.ts`（integration 项目）和 `packages/persistence-sqlite/test/device-actions-migration.contract.test.ts`（contracts 项目），覆盖迁移参照表、未知动作、审批未接上、跨设备报告、未读回成功、策略关闭、撤销、删除/导出等，反向用例标题和断言方向正确。但它们不在 `npm run check` 的 `check:steps` 里，且我无法运行测试，所以是否真的会在旧代码上失败、以及在当前流程中是否一定执行，未核实。意见 2 的监控历史删除路径没有测试。
4. 逐个核对结果：`device_action` 的 `id`（`dact_` + 32 hex）在迁移 CHECK、`DEVICE_ACTION_ID_PATTERN`、路由 report 校验、导出 schema 四处一致；`state`（8 个）、`reasonCode`（11 个）、`actionKind`（11 个）、`risk`（4 个）、`dataClassification`（4 个）在迁移 CHECK、`DECISION_OUTCOMES`/`ACTION_KINDS`/`ACTION_RISK_LEVELS`、导出 schema 之间一致；`device_action` 的 9 个 ledger outcome 与迁移插入、`DECISION_OUTCOMES.device_action` 一致；4 个新配置键在 defaults、ranges、strict-configuration、设备动作服务之间一致；导出文件键、schema 路径、snapshot 查询、manifest counts 之间一致。发现两处两端不一致：`device_actions.run_id` 的生产者是服务，消费它的 `deleteGitHubMonitorHistory` 没有清理（意见 2）；触发器产生的 `rejected/result_unknown` 没有进 `decision_ledger`（意见 5）。
