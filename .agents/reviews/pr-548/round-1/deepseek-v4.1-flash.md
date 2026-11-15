以下按严重度排列；读代码证实的与推测的分开写。未运行测试（本次工具限制），测试结论来自读代码。

## 读代码证实的

### 1. 高：`actions/undo` 只凭设备签名就把请求当成“主人亲自点的撤销”，绕过外来内容硬拒绝，也不要求本人确认
- 文件:行：`packages/platform-node/src/device-api-routes.ts:873-882`；`packages/application/src/services/device-action-service.ts:424-427、858-875`；`apps/agent-service/src/production-device-action-authorization.ts:59-60`
- 问题：路由只做设备签名认证，没有像改设备策略那样使用 `authenticated.confirmed`。服务端随后无条件写 `ownerInitiated: true`，而该值唯一作用就是把 `readUntrustedContent` 强制改成 `false`，从而跳过“该动作不允许来自外来内容”的硬拒绝。设备私钥持有者或设备上的恶意进程可以声称“主人在场”，触发服务端自动生成反向动作；`calendar.update`、`contact.update` 的反向动作在无外来内容时会被 `action_preauthorize_owner_data` 预先授权，不需要主人再确认。
- 证据：
  - `device-api-routes.ts:874-882`：`const authenticated = await authenticate(request); ... await actions(authenticated).undo({ device: authenticated.device, actionId: body["id"] })`
  - 对比 `device-api-routes.ts:918-921` 的策略修改：`ownerPresent: authenticated.confirmed`
  - `device-action-service.ts:424-427`：`readUntrustedContent: input.ownerInitiated === true ? false : await this.#options.readUntrustedContent(input.runId)`
  - `device-action-service.ts:867-875`：`ownerInitiated: true`
  - `production-device-action-authorization.ts:59-60`：`if (!intent.untrustedOriginAllowed && intent.readUntrustedContent) return { decision: "deny", ... }`
- 建议：撤销路由要求确认密钥签名/近期本人认证，把 `authenticated.confirmed` 传给服务；只有确认过才允许把 `ownerInitiated` 置真。或者在撤销路径上不使用“主人亲自”这一特权，只按普通动作走审批。并记录撤销来源。

### 2. 中：反向动作本身还能再被撤销，设备可无限链式生成动作并反复改写日历/联系人
- 文件:行：`packages/application/src/services/device-action-service.ts:826-839、858-876`；`packages/application/src/services/device-action-registry.ts:565、603`
- 问题：`#undoPlan` 只检查原记录 `state === "succeeded"` 且登记项有 `undo`，完全不区分这条记录是不是服务端生成的反向动作。`calendar.update` 的反向动作也是 `calendar.update`，它成功后同样能再撤销；设备每次回报一个 `evidence.before` 就能继续生成下一条反向动作。结果是一条可以无限延续的动作链，DB 行、参数/结果 Payload、审批和审计都会持续增长；配合上一条的高风险问题，设备还能反复把事件改到任意值。
- 证据：
  - `device-action-service.ts:826-839`：`if (record.state !== "succeeded") return null; ... if (!registration?.undo) return null; ... const plan = registration.undo(args, evidence);`
  - `device-action-service.ts:867-875`：`return this.request({ runId: record.runId, toolCallId: undoToolCallId(record.id), ... ownerInitiated: true })`
  - `device-action-registry.ts:565`：`undo: undoRestoring("calendar.update", "eventId", CALENDAR_CHANGEABLE, true)`
- 建议：把服务端生成的撤销动作标记出来（例如沿用 `toolCallId` 的 `undo:` 前缀判断，或持久记录父动作/深度），禁止再撤销，或限制深度和每小时次数。单纯依赖固定的 `toolCallId` 只能防同一条动作被撤两次，防不住新动作链。

### 3. 中：`calendar.delete` 的撤销只恢复 7 个字段，其它事件属性会被静默丢掉
- 文件:行：`packages/application/src/services/device-action-registry.ts:208-216、258-268`；设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:540`
- 问题：`undoDeletedEvent` 只从 `evidence.before` 中挑 `CALENDAR_FIELDS`（title/start/end/allDay/calendar/location/notes），再调用 `calendar.create`。如果原事件带重复规则、参与者、提醒、URL、附件等字段，代码不会报错，也不会让撤销不可用，而是创建一个缺这些属性的新事件，随后视图仍记为 `done`。这不符合文档说的“删之前存原样，可恢复”。
- 证据：
  - `device-action-registry.ts:208-216`：`const CALENDAR_FIELDS = ["title", "start", "end", "allDay", "calendar", "location", "notes"] as const;`
  - `device-action-registry.ts:258-268`：`const restored = Object.fromEntries(CALENDAR_FIELDS.filter((field) => before[field] !== undefined).map(...)); return { action: "calendar.create", arguments: restored };`
  - 设计文档 `:540`：`calendar.delete ... 删之前存原样，可恢复`
- 建议：明确 9B 的 `evidence.before` 必须只包含这 7 个字段；若设备可能回报其它字段，要么扩展 `calendar.create`/证据合同，要么在这些字段存在时拒绝提供撤销（不要静默丢失）。补一个带额外字段的负向/行为用例。`evidence.before` 的实际内容我没有在服务端代码中找到约束，标“未核实”。

### 4. 中：关键反向用例缺失，作者第 3 条“失败的反向动作不重试”没有自动检查
- 文件:行：`test/integration/device-actions.test.ts:1019-1025、1033-1039、1086-1090`；`test/integration/device-action-home-approval.test.ts:180-202`
- 问题：现有用例覆盖了“不可撤销 409”“不存在 404”“撤销后 pending”“回报成功后 done”“撤销进审批 waiting_owner”，但没有覆盖这些关键反向路径：
  - 反向动作失败/被拒/过期后再次 `POST actions/undo` 是否还返回同一条记录、是否真的不新建动作（作者明确宣称“失败的反向动作不重试”）；
  - 第二台设备撤销第一台设备的动作是否 404；
  - 原动作未 succeeded（queued/delivered/failed/result_unknown）是否 409；
  - 原动作所在 run 读过外来内容时，撤销是否仍进入审批询问，而不是被硬拒或直接执行；
  - 设备策略关闭反向动作、设备不再支持反向动作时返回什么。
  新加的 home/approval 用例测的是普通审批回调，不测撤销审批。
- 证据：现有集成断言只到 `undo` 为 `"pending"` 和 `"done"`：
  - `:1025`：`expect((await views()).find(({ id }) => id === changed)?.undo).toBe("pending");`
  - `:1039`：`expect((await views()).find(({ id }) => id === changed)?.undo).toBe("done");`
  - `:1087`：`expect(undone.body).toMatchObject({ state: "waiting_owner" });`
- 建议：补上述反向用例，尤其“反向失败后再撤一次”和“跨设备撤销”，并断言 `rows()` 数量不增加。现有“撤销计划”单测会随纯函数回退而失败，但无法替代这些端到端路径。

### 5. 低：`alarm.set`、`device_reminder.*` 仍标成可逆但没有 undo，与设计文档不一致；撤销路由也未写进接口表
- 文件:行：`packages/application/src/services/device-action-registry.ts:466、630、666`；设计文档 `docs/execution/specs/2026-11-11-apple-device-body-design.md:541-543、221`
- 问题：登记表里 `alarm.set`、`device_reminder.complete`、`device_reminder.create` 都是 `reversible: true`，但这次没有给它们 `undo`，于是 `DeviceActionView` 会同时出现 `reversible: true` 和 `undo: "none"`。设计文档明确写这三个动作“可撤销”。此外接口表没有 `actions/undo`，提交说明也写了 `Docs: deferred (fast mode)`，说明文档确实落后于代码。
- 证据：
  - `device-action-registry.ts:466-467`：`reversible: true, untrustedOriginAllowed: true`（alarm.set，其后无 undo）
  - `device-action-registry.ts:630-631、666-667`：device_reminder.complete/create 同样是 `reversible: true`，无 undo
  - 设计文档 `:541`：`reminder.create、reminder.complete ... 可撤销`；`:543`：`alarm.set ... 可撤销`
- 建议：明确这一批只实现日历/联系人撤销，并在设计文档里改写“可撤销”的范围；或者在 `views()` 输出里区分“动作本身可逆”和“现在能提供撤销”。同时补 `actions/undo` 到接口表，避免客户端按文档实现时漏掉。

## 推测

### 6. 中低：撤销不核对对象当前状态，可能把原动作之后的新修改一并覆盖
- 文件:行：`packages/application/src/services/device-action-service.ts:826-839、858-875`；`packages/application/src/services/device-action-registry.ts:233-256`
- 问题：反向参数完全来自原动作的 `args` 和 `evidence.before`，请求里没有携带目标对象的当前版本、当前摘要或 `If-Match` 之类的前置条件。推测：如果主人在原动作成功后又修改了同一事件/联系人，点撤销会无条件把旧值写回去，覆盖中间的新修改，而且视图仍显示 `done`。
- 证据：`undoRestoring` 只做 `changed.map((field) => [field, before[field]])`，没有读取 `mirror` 的当前值；`request` 也没有期望版本参数。
- 建议：在 `undo` 计划/请求里带上原动作后的目标版本或当前状态摘要，执行前重新读镜像或由设备做 compare-and-swap；不一致时返回“目标已变化，不能直接撤销”。这条依赖后续是否有并发编辑，属于设计风险，未在测试中覆盖。

### 7. 低：视图可能显示 `available`，实际撤销却因目标已不在镜像/策略已变而 409
- 文件:行：`packages/application/src/services/device-action-service.ts:826-856、883-904`；`packages/platform-node/src/device-api-routes.ts:873-890`
- 问题：`#undoState` 只调用 `#undoPlan`，后者校验反向参数结构，不检查目标镜像是否存在、设备是否仍支持、策略是否禁用反向动作；真正 `undo()` 走 `request` 时才做这些检查。推测会出现“首页给撤销按钮，点下去 409”的体验/一致性问题。
- 证据：`#undoPlan` 只做 `validateDeviceActionArguments(target.parameters, plan.arguments)`；`request` 后续才走 `#context`、`supportedBy`、`policy.blockedActions`。
- 建议：若要在 UI 上展示 `available`，在 `#undoState` 里复用目标可用性检查；否则把 `available` 定义成“参数可算”，并在客户端把 409 当正常状态处理。影响不大，属于一致性风险。

## 侧重检查

- 错误路径：`POST actions/undo` 的非法/多余字段走 `only`+`DEVICE_ACTION_ID_PATTERN` 返回 400；不存在或别的设备返回 404；结构上不可撤返回 409；反向请求自身被策略拒绝时返回 200 `{id,state:"rejected"}`。前三条代码正确；最后一条语义偏松，已在第 4 条建议补测。
- 不合规范/不可信输入：`report()` 只把 evidence 限制为普通对象并限 64KB，不校验字段语义；撤销时只按目标 action 的参数结构校验，`evidence.before` 的语义完全由设备提供。上面第 1、2、3 条都与此有关。
- 安全：核心问题是设备签名被等同于“主人亲自撤销”，且没有确认密钥/近期认证；设备由此可以触发服务端反向动作。
- 资源耗尽：每调用一次 `views()`，对 succeeded 记录会额外读 `resultRef`、`argumentsRef` 并查一次反向 invocation；默认 `GET actions` 只取 OPEN_STATES，影响有限；真正的风险是第 2 条的无界反向动作链。
- 不可撤销/不可逆操作：反向 `calendar.delete` 仍要求 `ownerPresence`，但反向 `calendar.update/contact.update` 在中风险、无外来内容时可能被规则预先授权；这与第 1 条叠加。
- 规则/文档一致性：本次没有改提示词、工具定义或历史消息；但设计文档的“可撤销”范围、接口表和代码不一致，见第 5 条。提交说明已写 `Docs: deferred (fast mode)`，属于已知延后，但不能当作文档已同步。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本改动只新增设备 HTTP 路由、服务端 device action 逻辑和 `GET actions` 的返回字段；`undo()` 不调用模型，不写 thread message、系统提示、工具定义或遮盖结果。`ownerInitiated` 只影响授权 intent 的 `readUntrustedContent` 布尔值，不进入提示词。发给模型的内容仍只在末尾追加，本轮会变的值不受这次改动影响。依据：`device-api-routes.ts:873-890`、`device-action-service.ts:858-876`；未发现任何 `undo` 路径进入 prompt 组装。

2. **不会让同一段文字在不同请求里变成不同字节。** 本次没有新增模型请求文本；反向参数由常量数组 `CALENDAR_FIELDS`/`CALENDAR_CHANGEABLE`/`CONTACT_FIELDS` 顺序生成，指纹函数会排序键和列表。会变化的是 `GET actions` 响应里的 `undo` 状态（`available`→`pending`→`done/failed`），它是设备接口响应，不是模型内容；如果未来客户端把这个字段拼进模型输入，才会成为每轮变化的值，这一点不在本仓库代码里，标“未核实”。

3. **有自动检查，但反向覆盖不完整。** 纯函数 `undo` 计划有单测；集成测试覆盖了撤销后 `pending`、反向成功后 `done`、不可撤销 409、不存在 404、撤销进审批 `waiting_owner`；新增 home/approval 用例覆盖设备经 `home/act` 同意/拒绝普通审批。若删掉撤销实现，这些断言会失败。但作者宣称的“失败的反向动作不重试”没有用例，跨设备撤销、原动作未成功、撤销时外来内容仍询问、策略/支持列表变化也都没有反向用例，不能算已验证（见第 4 条）。

4. **大部分新值两端能对上，但有两个缺口。**
   - `actions/undo` 的 `id`：客户端产生，路由用 `DEVICE_ACTION_ID_PATTERN` 校验，服务按同一 id 读记录；两端一致。
   - `toolCallId = "undo:<actionId>"`：服务端产生，存储层要求长度 1–256 且 `(run_id, tool_call_id)` 唯一，长度满足；但该命名空间没有对模型工具调用 id 做保留/校验，理论上可能与同 run 的模型 call 冲突（低风险）。证据：`device-action-service.ts:177`、迁移 `20261114172043_device_actions.sql:54、60`。
   - `plan.action`/`plan.arguments`：登记项产生，`#undoPlan` 先查目标登记并校验参数，`request` 再校验一次；目标不存在时返回 `null`，两端可接受。但登记表的 `undo` 目标没有在注册时静态校验，改名后会运行时退化为不可撤（低）。
   - `undo` 状态字符串：服务产生的 `none/available/pending/done/failed` 只由设备 `GET actions` 返回，仓库内没有第二个使用方；9B 设备端如何消费未核实，也没有共享契约校验。作者说“API 要说明哪些动作能撤”，这一点只靠该字段，缺少文档/契约。
   - `ownerInitiated`：只在 `undo()` 产生、在 `request()` 消费，没有类型之外的校验；正是第 1 条的安全缺口。
   - `{id,state}` 响应：路由产生，现有测试只断言 `state`；没有外部客户端代码校验，且反向动作被拒时仍返回 200，语义未在文档中固定（未核实）。
   - `reversible` 与 `undo`：`alarm.set`/`device_reminder.*` 一端说可逆、另一端没有撤销，见第 5 条。
   - `DEVICE_API_ROUTES` 与实际路由都加了 `actions/undo`，这一处两端一致。
