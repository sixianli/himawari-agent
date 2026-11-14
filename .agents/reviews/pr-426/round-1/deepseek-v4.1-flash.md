我先看改动范围和仓库结构。
# 复核结论

未发现能直接绕过“改”档确认、或让设备在主人不在场时执行永久删除/执行代码的逻辑漏洞。挑战值的绑定、过期、一次性、并发唯一性，以及“收紧不夹带”都与代码一致。需要处理的主要问题是：**实现已越过现有 ADR/设计文档的边界、`proactive.pause` 的档位定义与安全含义不一致、审计写入顺序/可选性，以及若干测试与客户端契约缺口。**

---

## 一、按严重度排列的问题

### 1.【中】【证实】代码越过了现有 ADR 0229 和设计文档的明确决定，本提交没有同步改 ADR

- 位置：`docs/adr/0229-native-apple-clients-and-device-api.md:95`、`:102`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:190`、`:231`；实现见 `packages/gateway-contracts/src/client-capabilities.ts:96-180`、`packages/platform-node/src/device-api-routes.ts:608-623`
- 问题：ADR 0229 决定第 3 条写的是“记忆页、规则、设置、用量明细嵌现有网页”，第 4 条写“设备能调用的是白名单，不是网页能做的全部；只拿到设备密钥、主人不在场时，做不了改规则、删记忆、导出”。设计文档第 231 行也写“设备接口里没有‘改规则’‘删记忆’‘导出数据’，这些只在嵌入的网页里做”。本 PR 却给原生页面登记了 `memory.create`、`memory.category.set`、`memory.mutate`、`memory.import.*`、`thread.delete_permanently`、`grant.revoke`、`host.file.*`、`workspace.*` 等几乎全部 v2 管理命令，并通过 `/api/device/v1/gateway` 直接放行（高风险项虽仍需确认密钥，但架构前提已变）。
- 证据：
  - ADR：`聊天主界面……用苹果原生界面。记忆页、规则、设置、用量明细嵌现有网页`（第 95 行）；`设备能调用的命令是一张白名单……不是网页能做的全部`（第 102 行）。
  - 设计：`设备接口里没有“改规则”“删记忆”“导出数据”，这些只在嵌入的网页里做`（第 231 行）。
  - 代码：`CLIENT_CAPABILITY_TABLE` 中 `change("v2", "memory.create")`、`change("v2", "memory.mutate")`、`change("v2", "grant.revoke")`、`change("thread-v3", "thread.delete_permanently")` 等。
- 建议：合并前让 Andy/设计线程明确以 ADR 修订（supersede/amend）记录这次从“嵌网页”改为“全原生 + 设备网关”的决定；只改设计文档、不改 ADR，会让仓库里同时存在两套互相矛盾的权威说明。作者材料说“设计文档由 PR 405 改”，但材料没有提到 ADR。

### 2.【中】【证实】`proactive.pause` 定为“收紧”后，只拿设备密钥就能在主人不在场时静默关闭全部主动提醒

- 位置：`packages/gateway-contracts/src/client-capabilities.ts:106`；`apps/agent-service/src/production-proactive.ts:641-645`；`packages/application/src/services/proactive-mail-check-service.ts:712-713`
- 问题：档位定义是“收紧（只会让 Himawari 收集更少）”，但 `proactive.pause` 做的是 `enabled:false`，会让主动邮件检查直接返回不运行。它既不减少“收集”，也不只是“提醒文案”，而是让主人失去重要发件人/审批/提醒的通知。它被登记为 `tighten`，因此 `dispatchDeviceGatewayRequest` 不要求确认密钥，只凭设备密钥即可执行。虽然会写审计，但审计是事后记录，不能阻止或要求在场。
- 证据：
  - `tighten("v2", "proactive.pause"),`
  - `case "proactive.pause": { const settings = await store.readSettings(scope); await store.writeSettings({ ...scope, ...settings, enabled: false, now }); ... }`
  - `const settings = await store.readSettings(scope); if (!settings.enabled) return undefined;`
- 建议：要么把 `proactive.pause` 改成“改”档（与 `proactive.settings.set` 一致），要么在 ADR/能力表里明确写“暂停提醒是收紧档的例外”，并确认“设备密钥泄露即可屏蔽提醒”的风险可接受。至少应当让客户端在暂停时显示这是无在场验证的操作。

### 3.【低-中】【证实】审计是可选项，且“先执行、后写审计”

- 位置：`packages/platform-node/src/device-gateway.ts:139`、`:145-171`；`packages/platform-node/src/device-api-routes.ts:112`；`packages/platform-node/src/http-gateway-server.ts:126`
- 问题一：`audit?: AuditLedgerPort` 在设备路由和 HTTP 组合里都是可选的。生产组合目前传了 `repository.auditLedger()`，但类型上允许漏传；一旦漏传，“收紧和改每次写审计”会静默失效。对一个“不可撤销操作”的闸门来说，审计应当是必需依赖。
- 问题二：`dispatchDeviceGatewayRequest` 先 `await forward(input)`，成功后才 `record("completed")`。如果审计写失败（例如 SQLite 磁盘满、`assertDiskHeadroom` 抛错），已经成功的操作（包括 `thread.delete_permanently`）会让客户端收到 500，客户端可能认为失败并重试。失败路径里 `await record("failed"); throw error` 也可能让审计异常覆盖原始错误。
- 证据：
  - `readonly audit?: AuditLedgerPort;`
  - `result = await forward(input); ... await record("completed");`
  - `catch (error) { await record("failed"); throw error; }`
- 建议：设备网关的 `audit` 改为必需；在真正执行前先写意图/“accepted”记录（或在同一事务里落审计与操作），并让审计失败不改变已执行操作的结果语义（至少记录到日志并返回已完成）。

### 4.【低】【证实】`memory.page.viewed` 是写命令，却登记为“读”档

- 位置：`packages/gateway-contracts/src/client-capabilities.ts:139`
- 问题：`{ gateway: "v2", type: "memory.page.viewed", kind: "command", tier: READ }`。它是 command（会写 `lastViewedAt` 之类的状态），却享受“读”档：不要求确认，也不写审计。影响很小，但与“读=不改数据”的档位语义不一致；并且契约测试只校验 kind 与合约一致，不校验“读档必须是 query”。
- 证据：
  - `{ gateway: "v2", type: "memory.page.viewed", kind: "command", tier: READ },`
- 建议：把它归到 `routine`（并在文档里说明理由），或在契约测试里加一条“read 档不允许 command”的断言；如果确实有意为之，请在能力表/设计文档里写明例外。

### 5.【低】【证实】测试覆盖缺口：文本上传的拒绝路径、v1 转发、审计失败路径没有反向用例

- 位置：`test/integration/device-gateway.test.ts:38-54`（只测 201 成功）；`packages/gateway-contracts/src/client-capabilities.ts:64-71` 有 v1 类型，但测试中 `gatewayBody` 全部使用 `v2`/`thread-v3`
- 问题：
  - 新的 `/payloads/text/new` 只测了成功路径；没有测试空正文、超长正文、未知字段、非法 `dataClassification`、缺失/非法 `idempotencyKey`，也没有测试它与 `/api/payload/v1/text` 的拒绝行为一致。作者“共用校验”在代码上成立（两边都调用 `parseTextAdmission`），但没有自动证明。
  - v1 网关（`trigger.admit`、`thread.create`、`thread.close`、`approval.respond`、`run.cancel` 及查询）没有任何集成测试；`forward` 的 v1 分支没有被执行过。
  - 审计的 `failed` 分支、审计写入失败、`GATEWAY_UNAVAILABLE` 都没有测试。
- 证据：
  - 测试 helper：`async function text(...) { ... expect(response.statusCode).toBe(201); ... }`
  - `BODY_KEYS.v1` 与 `forward` 的 `case "v1"` 存在，但测试文件只构造 `gateway: "v2"` 和 `gateway: "thread-v3"`。
- 建议：补 `/payloads/text/new` 的表驱动反向用例（与网页路由共用同一组输入），补一个 v1 读 + 一个 v1 改的集成用例，补审计写失败时的行为测试。

### 6.【低】【证实】新的线上值（占位值 `"device"`、网关请求体字段）没有进入生成的客户端清单

- 位置：`packages/platform-node/src/device-gateway.ts:68-74`；`test/tooling/client-parity.test.ts:60-113`
- 问题：客户端必须知道两件事：`authorizationRef`/`recentAuthenticationRef` 只能填字面量 `"device"`；请求体顶层只允许 `gateway/type/messageId/idempotencyKey/dataClassification/risk/payload`。这两件事目前只写在服务器代码里，生成的 `ClientCapabilities.swift` 只包含类型/档位/`tightenPayload`，契约测试也不覆盖请求体形状。客户端 PR 很容易把占位值或字段名写错，而服务器只会回 400。
- 证据：
  - `export const DEVICE_REFERENCE_PLACEHOLDER = "device";`
  - `BODY_KEYS` 的 v1/v2/thread-v3 白名单。
  - `renderSwift(...)` 中只生成 `ClientCapability(gateway:type:kind:tier:tightenPayload:)`。
- 建议：把占位值和允许的顶层字段一起纳入生成清单（Swift 常量 + 契约测试），或至少在 `client-capabilities.contract.test.ts` 里断言这些值与客户端清单一致。

### 7.【低】【推测】进程内随机挑战密钥和多进程/多副本部署不兼容

- 位置：`packages/platform-node/src/paired-device-service.ts:102-104`、`:232-264`
- 问题：`#challengeKey` 在构造函数里随机生成。若生产以多进程/多副本运行，实例 A 发出的挑战到实例 B 校验时 `#challengeValid` 一定失败（`DEVICE_CHALLENGE_INVALID`）。作者说明这是设计（“进程启动时随机密钥”），所以这是部署前提问题，不是实现错误；我没有在仓库里核实生产是否单进程/单副本。
- 证据：
  - `this.#challengeKey = (options.randomBytes ?? randomBytes)(32);`
  - `createHmac("sha256", this.#challengeKey)`，没有共享存储或配置密钥。
- 建议：确认生产是单进程；如果是多副本，需要改成共享密钥/持久化密钥，或在部署文档里明确要求会话亲和。

### 8.【低】【证实】作者“收紧……正文必须恰好是规定的值”的说法不覆盖所有 `tighten` 类型

- 位置：`packages/gateway-contracts/src/client-capabilities.ts:70-74`（`run.cancel`）、`:188` 附近（`thread.run.cancel`）
- 问题：`run.cancel` / `thread.run.cancel` 也是 `tighten`，但它们的正文是任意 `runId`/`reasonCode`，并不存在“恰好是规定的值”的校验。真正受精确约束的只有带 `tightenPayload` 的 `muse.intake.set`、`memory.settings.set`，以及空正文的 `proactive.pause`。这是说法与代码不一致，不是安全漏洞。
- 证据：
  - `tighten("v1", "run.cancel")`、`tighten("thread-v3", "thread.run.cancel")`
  - `requiredClientTier` 只在 `entry.tightenPayload` 存在时做 `sameFlags`。
- 建议：修正说明为“收紧档中，修改设置的命令必须恰好是规定的值；取消运行等命令按各自契约校验”。

---

## 二、侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性）

**读代码证实的：**

- **未确认的“改”在执行和审计之前被拒**：`device-gateway.ts:142-144` 先判断 `tier === "change" && !confirmed` 并抛 403，之后才进入 `forward`/`record`。测试 `device-gateway.test.ts:138-165` 覆盖，且它检查 `audits(h) === []`。
- **挑战值的设备绑定、过期、一次性、并发唯一**：
  - 设备绑定：`#challengeMac(deviceId, head)`（`paired-device-service.ts:232-239`），外设备的挑战 MAC 不匹配。
  - 过期：`Math.floor(now.getTime()/1000) <= head.readUInt32BE(0)`（`:263`）。
  - 一次性/并发：挑战被当作请求 nonce，写入 `device_request_nonces`；SQLite 改为 `INSERT ... ON CONFLICT DO NOTHING` + `changes === 1`（`sqlite-paired-device-operations.ts:279-296`），同一事务内判断。测试 `device-gateway.test.ts:179-204`、`:323-338` 覆盖外设备/过期/复用/并发。
- **收紧夹带**：`sameFlags` 要求键数完全相等且值严格相等（`client-capabilities.ts:246-256`）；`muse.intake.set`、`memory.settings.set` 的 v2 schema 也是严格单字段对象（`contracts-v2.ts:685-688`、`:1471-1474`）；`proactive.pause` 的 payload 是严格 `object({})`（`contracts-v2.ts:507-510`），未知字段会被 `object` 拒绝。测试 `device-gateway.test.ts:281-321`、`client-capabilities.contract.test.ts:66-99` 覆盖。
- **不可信输入**：网关顶层字段白名单（`device-gateway.ts:70-74`）、payload 内 `authorizationRef`/`recentAuthenticationRef` 只允许 `"device"`（`:100-107`）、严格 schema 拒绝未知字段（`validation.ts:174-176`）、路径白名单由 `DEVICE_API_ROUTES` 生成（`device-api-routes.ts:46-68`）。未发现原型污染或字段夹带路径。
- **近期验证只来自确认签名**：`authenticate` 仅在 `verified.confirmed` 且 `ownerSubject` 返回绑定主体时构造 `recentAuthenticationEvidence`（`paired-device-service.ts:329-351`）；`RecentAuthenticationGuard` 校验来源、owner、device、session、时间窗（`recent-authentication-service.ts:53-127`）；普通设备的内部会话确实没有近期验证凭据（`test/integration/device-api.test.ts:302-319` 断言无 evidence、`recentAuthenticatedAt` 为 epoch、guard 拒绝）。
- **不可撤销操作**：`thread.delete_permanently`、`host.file.execute`（尤其 permanent_delete）、`workspace.commit` 的 payload 都要求 `recentAuthenticationRef`，且网关把它们登记为 `change`（`client-capabilities.ts:63`、`:152`；`contracts-v2.ts:1718-1727`、`:2500-2509`），未确认请求在 schema 之前就被网关拒掉。
- **资源耗尽**：挑战签发无状态、无表写入；nonce 表按设备限制 `maximumRetained`，满了返回 429（`sqlite-paired-device-operations.ts:285-295`）；device 路由有硬 body limit（`device-api-routes.ts:258-260`、`:273-275`）。未发现新的无界循环或表增长点。
- **文档一致性**：`.claude/rules/prompt-prefix.md` 约束的提示词组装代码本 PR 没有改动；但如问题 1 所述，ADR/设计文档与实现不一致。

**推测/未核实：**

- 多进程部署下挑战密钥不共享（问题 7）。
- 手机通过网关提交 `thread.message.submit` 时可以自带 `occurredAt`（`product-thread-gateway-adapter.ts:755-777`）；旧的设备 `/messages` 路由是服务器 `now()`（`device-api-routes.ts:564-574`）。上下文组装在“没有快照”路径上会按 `occurredAt` 排序（`context-formation-service.ts:207-217`）。我**没有核实**已有快照/冻结信封下，回填旧时间的消息是否会改变历史顺序或请求开头；需要额外确认。同理，该路径也允许手机自报 `dataClassification`，旧设备消息路径是硬编码 `"private"`。
- `ownerSubject`/`audit` 在测试 fixture 与生产组合中都已接上，但其他未来组合是否记得传 `audit` 属于开放风险（问题 3）。

---

## 三、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**没有证据表明会改变。** 本 PR 没有修改系统提示、工具定义、历史序列化或遮盖代码；它新增的是设备控制面入口，命令被交给与网页相同的 `AgentGatewayV2Port` / `AgentThreadGatewayPort` 处理程序（`device-gateway.ts:174-227`）。新增/替换的值（挑战值、审计 id、`authenticationRef`、`correlationId`）都在控制面消息里，不进入模型上下文。依据 `.claude/rules/prompt-prefix.md` 第 2、4 条：本轮变化的值应放最后一条用户消息，已发内容只追加；本 PR 没有触碰这两条所约束的代码。

**一个需要确认的例外**：`thread-v3 thread.message.submit` 现在可以经设备网关提交，并且 `occurredAt` 是客户端提供的（`product-thread-gateway-adapter.ts:776`、`thread-command-service.ts:211`），而旧的设备 `/messages` 路由固定用服务器时间（`device-api-routes.ts:574`）。我只确认了“透传”，**未核实**它是否能在已有快照下把消息插到历史中间。若不能，则不影响开头；若能，则属于风险，需补测试或改成服务器时间。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会**，就模型可见内容而言：没有改提示词/历史/遮盖的序列化路径；`correlationId` 是 `deviceId + messageId` 的确定性哈希（`device-gateway.ts:112-114`），挑战值只用于 HTTP 控制面，不进入文本；`withServerFilledReferences` 替换的是 `authorizationRef`/`recentAuthenticationRef`，它们只出现在控制面 payload，不进入发给模型的文本。同一设备会话内 `authenticationRef` 是稳定的；即使与网页会话不同，也不影响同一段模型文本的字节。

**未核实**：`occurredAt`/`dataClassification` 的客户端自报是否会影响历史排序或内容可见性（见上）；这属于既有 `thread.message.submit` 契约的行为，不是本 PR 新造的序列化逻辑，但本 PR 把它开放给了手机。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，且关键反向用例是真失败型，不是形式断言：**

- `device-gateway.test.ts:138-165`：去掉 `change` 的确认检查后，`muse.data.clear` 会被执行并返回 200、审计非空，测试会失败。
- `device-gateway.test.ts:179-204`：去掉设备绑定/过期检查后，外设备或过期挑战会成功；测试会失败。
- `device-gateway.test.ts:323-338`：nonce 插入回退到“先查再写”时，并发用例可能两个都成功；测试会失败。SQLite 现在是原子 `INSERT ... ON CONFLICT DO NOTHING`。
- `device-gateway.test.ts:281-321`：`muse.intake.set`/`memory.settings.set` 的 `sameFlags` 退化成“包含即可”时，`{capturePaused:true, extra:true}` 会被当作收紧并返回 200；测试期望 403，会失败。
- `device-api.test.ts:302-319`：给普通设备会话伪造近期验证证据或改 `recentAuthenticatedAt` 后，guard 断言会失败。
- `client-capabilities.contract.test.ts` 与 `client-parity.test.ts`：表漏登一种合约类型、Swift 清单没重生成都会失败；`check:client-parity` 已加入 `check:steps`，`npm run check` 会跑到。

**缺口**：`/payloads/text/new` 的拒绝路径、v1 转发、审计 `failed` 分支、多进程挑战、占位值/请求体生成清单没有自动检查（问题 5、6、7）。另外，Swift“表里加一种类型而文件没重生成就对不上”的用例只是对 `renderSwift` 的结果做比较，真正的防回归是前一条“文件内容等于生成结果”的相等断言；这条够了，但反向用例本身偏形式化。

### 4. 每个产生/修改的值，每个使用它的地方都能接受吗？

逐项核对（读代码证实）：

- **`proactive.pause`**：
  - 产生：`contracts-v2.ts:507-510` 的 schema、`GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`；`client-capabilities.ts:106`；`Generated/ClientCapabilities.swift`；`gateway-v2.fixture.ts`；`production-proactive.ts:55-56` 安装表和执行 switch；`ci/operations-pending.json`。
  - 使用：设备网关 `forward` 按 `entry.gateway` 调 v2；`AgentGatewayV2Service.installedOperations` 包含它；`ProductionProactive.execute` 有 case；`proactive-mail-check-service` 读 `settings.enabled`。
  - 结论：契约、安装表、执行器、能力表、Swift、fixture、pending 台账都一致；`check:operations` 因网页无调用方而要求 pending 项，已添加。**未核实**客户端代码（不在本仓库）。
- **`device_confirmation_key`**：`ports/recent-authentication.ts:5-9` 的联合类型与 `services/recent-authentication-service.ts:31-38` 的 `validSource` 同时加了；没有其他枚举/开关需要同步（全仓库 grep 只有这两处）。可用。
- **`DEVICE_REFERENCE_PLACEHOLDER = "device"`**：服务器端产生/校验在 `device-gateway.ts:68`、`:100-107`；客户端需要知道它，但生成的 Swift 清单没有包含（问题 6）。**这是当前唯一的“产生方有、使用方清单没有”的缺口。**
- **新路由**：`DEVICE_API_ROUTES` 加了 `approvals/challenge`、`gateway`、`payloads/text/new`，`DEVICE_ROUTE_PATTERNS` 由同一数组生成，`onRequest` 路径白名单会接受；handler 也按相同相对路径注册在 `DEVICE_API_PREFIX` 下。两端一致。
- **新错误码**：`DEVICE_GATEWAY_*` 在 `device-api-routes` 抛出，`http-gateway-server.ts:905-907` 的全局错误处理会映射为 `{ error: { code } }` 和状态码；测试按这些码断言。一致。
- **`text-admission.ts`**：网页 `/api/payload/v1/text` 与设备 `/payloads/text/new` 都调用 `parseTextAdmission`；设备路由先剥离 `idempotencyKey`，其余字段与网页完全一致（`device-api-routes.ts:585-600`、`http-gateway-server.ts:1393-1413`）。一致。
- **`audit` / `ownerSubject`**：生产组合 `production-http-composition.ts:1200-1208` 与测试 harness 都已传；类型上仍可选（问题 3）。
- **`memory.page.viewed` 的档位**：能通过契约校验，但档位语义不匹配（问题 4）。

---

## 四、对作者自述的逐条核对

| 作者说法 | 结论 |
| --- | --- |
| 没有确认签名的“改”请求在写审计和转发之前就被拒 | **属实**。`device-gateway.ts:142-144` 先抛 403；测试 `:138-165` 同时断言无审计。 |
| 别的设备、过期、重复使用的挑战值都被拒；并发只成功一个 | **属实**。HMAC 绑定设备、过期时间在 MAC 内、nonce 表原子插入；测试 `:179-204`、`:323-338`。 |
| 收紧档不能被用来夹带别的设置改动 | **属实**（muse/memory 精确匹配；proactive.pause 空正文 schema）。测试覆盖。注意 `run.cancel` 类收紧命令本来就不要求“规定值”，作者说法过度概括。 |
| 设备的内部会话本身不带近期验证凭据 | **属实**。`device-api.test.ts:302-319` 断言无 evidence 且 guard 拒绝；只有确认签名才构造 evidence（`paired-device-service.ts:329-351`）。 |
| 挑战值不建表，进程启动时随机密钥 | **属实**。`paired-device-service.ts:100-104`。多进程部署风险见问题 7。 |
| 收紧和改每次写审计 | **有条件属实**：生产组合传了 audit，但类型是可选的；审计在操作成功后写，失败会返回 500（问题 3）。 |
| 手机只能填占位值 `"device"` | **属实**。`device-gateway.ts:100-107`；测试 `:382-406` 覆盖 null/伪造值。 |
| 设备上传文字和网页共用校验 | **代码属实**；缺少设备端拒绝路径测试（问题 5）。 |
| 检查覆盖能力表/Swift/页面一致 | **属实**，`check:client-parity` 已接入 `check:steps`；但未覆盖占位值和请求体形状（问题 6）。 |
| 设计文档由 PR 405 改 | **部分属实**：设计文档确实没在本提交改；但 ADR 0229 的决定 3/4 与本次架构直接冲突，材料没有说要改 ADR（问题 1）。 |
