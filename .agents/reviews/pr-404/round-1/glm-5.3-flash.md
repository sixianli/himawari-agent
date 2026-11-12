# PR 404 复核报告（基准 1a68a5a3 → c99e7f25）

## 侧重检查（测试覆盖 / 文档一致性 / 普通流程走查）

我走的流程：网页「设置→设备」添加设备（`POST /api/devices/v1/pairing-codes`，带 CSRF）→ 生成配对码（只存 SHA-256，10 分钟）→ 设备 `POST /api/device/v1/pair`（无签名入口，redeem 后 pending）→ 网页确认（写一行 `devices` + 一条 `product_sessions`，置 active）→ 设备用 P-256 签名请求 → `verifyDeviceRequest` → 状态检查 → 记 nonce → 读内部会话 → touch → `/threads`、`/messages`（protectText×2 → 网关命令，按 messageId 幂等）、`/stream`（心跳时 `stillActive` 复核）→ 网页吊销（同时吊销配对设备行、内部会话、浏览器设备行，清空 nonce）→ 流在下一次心跳收到 `IDENTITY_SESSION_INVALID` 结束。

- 已覆盖：配对码错/过期/已用、pending 403、验签矩阵（重放、改正文、改查询、换主机、时钟差、未知键、confirm 标签）、nonce 存满 429、正文超限 413、消息去重（第二次返回 `payload.replayed:true`）、流续传与未知编号整份重取、吊销三件事、主人停用、导出凭据不出现+导入不恢复+篡改行被拒、配置解析反例、真实 Chromium 网页正反流程。
- **没有测试覆盖的路径（本次改动新增代码）**：
  - 事件流**过滤**（计划第 1 批任务 4/5 明确要求“事件流只发和这台设备有关的事件”并写 `test/integration/device-connection.test.ts`）——当前订阅是主人全部线程事件，无过滤，也没有该测试文件（见发现 1）。
  - `bounded()` 的 `CONNECTION_MAX_LIFETIME` 重连事件从未触发过（3600 秒上限，无测试）。
  - `/api/devices/v1/*` 各管理路由的输入校验分支（deviceId 正则、expectedRevision、rename 的 name 类型）无 HTTP 层用例。
  - `/threads` 的 `after` 非法值 400 分支、`touchDevice` 写入的 `lastSeenAt` 无断言。
  - `/messages`、`/threads`、`/stream` 的响应没有像 pair/confirm/list/config 那样断言不含内部会话编号/authenticationRef（作者说法 4 的测试只盖了四个响应，见发现 4）。
  - `npm run check`“50 步全过”无法在本次复核中运行验证（未核实）；`check:steps` 链条确实包含新改的 `check:data-export`（REQUIRED 82→85，与新增 3 条用例一致）。

## 发现（按严重度）

1. **中 · docs/execution/plans/2026-11-11-apple-device-body-plan.md:81-82 vs packages/platform-node/src/device-api-routes.ts:339-373**
   问题：计划第 1 批任务 4/5 要求“事件流只发和这台设备有关的事件”并新建 `test/integration/device-connection.test.ts`；实现里设备流订阅的是 `thread.events`、范围只有 ownerId，**把主人所有对话的事件都发给设备**，无设备相关性过滤，`device-connection.test.ts` 不存在（我 glob 过，只有 device-api/device-request-signature/device-settings-browser 三个新文件）。PR 自称“第 1 批”，与计划不符；设备会收到网页发起对话的私人事件。
   证据：路由中订阅 payload 只有 `scope.ownerId/agentId` 和 `afterCursor`；计划原文“事件流只发和这台设备有关的事件”“实现路由和事件过滤”。
   建议：要么本批补过滤与测试，要么在 PR 里明确声明这条推迟到哪一批并更新计划（现在 PR 描述未提）。

2. **低 · packages/platform-node/src/device-api-routes.ts:139-148（catch-all `device.all("/*")`）**
   问题（说法 1 的边界）：Fastify 插件通配 `/*` 不匹配不带斜杠的 `/api/device/v1` 本身；该路径不进插件作用域，onRequest 钩子不跑，会落到应用级 404，错误码不是 `DEVICE_PATH_NOT_ALLOWED`（推测，依据 find-my-way 通配语义；测试只测了 `/api/device/v1/web-session` 等带斜杠路径，device-api.test.ts:252-259）。另外 device API 未安装（`options.devices` 缺失）时同路径也是普通 404。
   建议：加一条无斜杠路径的用例或接受该差异并在文档写明。

3. **低 · packages/persistence-sqlite/src/sqlite-paired-device-operations.ts（renameDevice）**
   问题：confirm 时用 `device.name` 建 `devices`（浏览器设备）行的 label；rename 只更新 `paired_devices`，不改 `devices.label`，两处名字会永久不一致（Identity/会话页显示旧名）。证据：confirmDevice 的 INSERT 带 `device.name`；renameDevice 的 UPDATE 只有 `paired_devices SET name`。
   建议：rename 时同步 UPDATE devices.label，或声明为已知取舍。

4. **低 · test/integration/device-api.test.ts:115-127**
   问题：说法 4“内部会话编号和 authentication_ref 不出现在**任何**响应里”只对 pair/confirm/config/list 四个响应做了逐字节反查；`/messages`、`/threads`、`/stream` 的响应体没有同样断言（按构造这些是网关领域响应，泄漏可能性低，但缺反向用例）。
   建议：把流/消息/列表响应体加进同一组 `not.toContain` 断言。

5. **低 · docs/execution/specs/2026-11-11-apple-device-body-design.md:583、706 vs packages/application/src/ports/device-limits.ts:1-20**
   问题：设计文档写“硬上限的**九个**配置键”、`device.prefetch.cache` 一行；代码是**十个**键（prefetch 拆成 entries/bytes）。决定记录在计划（“ten hard limits，No old key kept”），设计文档没有同步。文档与代码不一致。
   建议：更新设计文档的上限表和登记表行。

6. **低 · packages/persistence-sqlite/src/sqlite-paired-device-operations.ts（createPairingCode）**
   问题：每次 startPairing 插入一行，只清理“已过期或已用”的行；主人反复点“添加设备”会在 10 分钟内累积多个有效码（自伤型，无服务端上限）。建议：同会话/同主人同时最多一个有效码。

7. **备注（非缺陷）**：`authenticate()` 在内部会话有效性检查之前已写入 nonce（paired-device-service.ts:226-246 顺序：verify → 状态 → recordNonce → readSession → touch）；会话被吊销的请求也消耗 nonce 容量，语义可接受，仅记录。

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。本次 diff 不碰系统提示、工具定义、历史组装或遮盖规则（diff 清单无任何 prompt/runtime 文件）。设备消息是以 `actorType:"owner"` 走既有对话网关的**新命令**，天然只在末尾追加；每轮会变的值（`occurredAt`、查询用 messageId 里的时间）都只在新消息/新命令里，不改写历史。依据 prompt-prefix 规则核对通过。
2. **同一段文字会不会变成不同字节？** 读代码证实：无。内容侧 `stableSuffix = sha256(deviceId+"\n"+messageId)` 固定（device-api-routes.ts:54）；payloadRef = `sha256(authenticationRef+"\0"+idempotencyKey)` 固定（production-http-composition.ts:487-489），遮盖沿用既有确定性实现；幂等键被不同内容复用时直接抛 CONFLICT（production-http-composition.ts:492-502），不会静默换内容。时间性字段只在单次请求自己的新消息里。导出侧新表查询有固定 `ORDER BY paired_at, id`。
3. **有没有自动检查、反向用例会不会真的失败？** 有，覆盖面好：device-api（重放/篡改/换主机/时钟差/白名单外路径/pending/吊销/nonce 满/超限）、验签单元反向（错键、错路径、confirm 标签下用设备键）、导出三条反向（凭据不出现、导入不恢复、加公钥的行被拒）、配置解析反向（未知键、越界、connectionMax<heartbeat）、真实浏览器反向（未确认连不上、吊销后连不上）。反向断言都点名具体错误码，去掉守卫即失败——但我无法实际改代码跑红，运行结果（含“50 步全过”）**未核实**。缺口见发现 1、4。
4. **每个新值两端都校验吗？** 逐对核对过，基本闭环：设备号 `dev_`+22 字符——服务生成、管理路由正则、迁移 CHECK（26 长 + 前缀）、导出 schema 正则、验签 keyid 正则（16-64 含 `dev_`）一致；配对码 22 字符/哈希 64 hex 与两端正则和 DB CHECK 一致；nonce 16-64 与 DB CHECK 一致；`device:`/`session:`+32hex 能过 `devices`/`product_sessions` 的宽松 TEXT 主键，authenticationRef `sha256:64hex` 有端口校验且有 UNIQUE 索引（迁移 0010），随机生成不冲突；十个上限键在 strict-configuration（拒绝未知）、config 响应、UI `limitLabels`（10 个映射，类型闭合）三端一致；导出清单 `pairedDevices` 在 schema、verify 计数核对（verify.ts:434-439）、import（恒 0）、demo-pack、`check-data-export` REQUIRED=85 各端一致。发现的唯一断点：rename 不同步 `devices.label`（发现 3）。

**未核实清单**：`npm run check` 实际运行结果；Fastify 对无斜杠路径的精确匹配行为（发现 2 标为推测）；macOS/iOS 客户端侧（不在本仓库）。
