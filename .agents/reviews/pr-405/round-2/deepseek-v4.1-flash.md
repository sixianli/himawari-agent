结论：这个 PR 只改文档、复核记录和原型素材，没有改模型请求代码；但设计里“只凭设备密钥能做什么”的分档有会放宽权限的缺口，另有几处产生值的一端和使用值的一端对不上。下面先写读代码证实的问题，再写推测/需确认的风险。

## 一、读代码证实的问题

### 1. 【高】`memory.mutate` 一个类型横跨“日常/改”，正文分档只给“收紧”做了
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:210-217`、`packages/gateway-contracts/src/contracts-v2.ts:1637-1653`、`apps/agent-service/src/production-memory-control.ts:1277-1318`
- 问题：设计把“移到废纸篓（能恢复）、恢复”放在“日常”（设备密钥即可），把“删记忆”放在“改”（要确认密钥/面容）。但代码里这两类都走同一个消息类型 `memory.mutate`，同一个 `action` 字段还包含 `correct`（改记忆正文）、`restore_version`（恢复旧版本）。设计只规定“收紧”每一行要写正文条件，没有规定“日常/改”也要按 `action` 细化。
- 证据：
  - `contracts-v2.ts:1639-1648`：`"correct"`、`"delete"`、`"restore"`、`"recover"`、`"restore_version"` 同在一个枚举。
  - `production-memory-control.ts:1312-1314`：`if (action === "delete")` 实际调用 `this.options.memory.trash(...)`，只是移到废纸篓，不是永久删除；`:1277-1285` 的 `correct` 会改写记忆正文；`:1295-1305` 的 `restore_version` 会恢复旧版本。
  - 设计 `:211` 写“日常：……恢复、移到废纸篓（能恢复）”，`:210` 写“改：……删记忆”。
- 后果：如果实现按“移到废纸篓/恢复”把整个 `memory.mutate` 登记成“日常”，只拿到设备密钥的人就能用 `correct`/`restore_version` 改写或回滚记忆，不需要面容；如果按“删记忆”登记成“改”，那么“移到废纸篓/恢复”又需要面容，直接违背设计的“日常”定义。两种读法都不安全或自相矛盾。
- 建议：在能力表里按 `action` 给 `memory.mutate` 写明确条件（至少区分 `correct`、`delete`、`recover`、`restore_version`），或拆成多个消息类型；补反向用例：只用设备密钥签 `memory.mutate correct`/`restore_version` 必须被拒，签 `delete`/`recover` 才按“日常”放行（或反过来，但必须二选一写清）。另外要明确永久删除记忆到底走哪个命令，因为当前用户可调的 `delete` 只是 trash，永久删除是后台过期清理（`production-memory-control.ts:338-345`）。

### 2. 【高】`proactive.settings.set` 是多字段开关，“收紧”用静态正文条件挡不住放宽方向
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:217`、`packages/gateway-contracts/src/contracts-v2.ts:500-506`
- 问题：设计把 `proactive.settings.set` 举为“一个类型管两个方向、还带别的字段”的例子，并说“收紧”每一行要写明“正文必须恰好是哪些字段、取哪个值”。但 `proactive.settings.set` 的正文是 `{ enabled, quietHours, importantSenders }`。一个静态条件无法表达“只允许 `enabled:false`，同时要求 `quietHours`/`importantSenders` 保持当前值”；如果实现只检查 `enabled === false`，那么只拿到设备密钥的人可以在同一次“收紧”请求里删掉免打扰时段、往 `importantSenders` 增加最多 200 个地址，实际是把提醒**放宽**，却不用面容。
- 证据：`contracts-v2.ts:500-506` 明确是三个字段；设计 `:217` 自己承认“还同时带免打扰时段和重要发件人”，但给出的解法仍是“正文必须恰好是哪些字段、取哪个值”。
- 建议：把主动提醒拆成独立的“关/开”消息类型，或要求服务器把非方向字段与当前存储值逐个比较，只有它们完全不变时才按“收紧”。补反向用例：`enabled:false` 同时修改 `quietHours` 或 `importantSenders` 必须被拒；现有“正文多带一个字段被拒”测不到这种情况，因为这些字段不是“多带”，而是本来就在正文里。

### 3. 【高】“确认密钥签名算近期身份验证”和现有消费端对不上
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:219,221,246,554`、`packages/application/src/ports/recent-authentication.ts:5-8`、`packages/application/src/services/recent-authentication-service.ts:56-73`、`packages/platform-node/src/built-in-identity.ts:247-266`
- 问题：设计说“确认密钥的签名同时算‘近期身份验证’”，又说内部 `product_sessions`“不算近期身份验证”。但现有 `RecentAuthenticationGuard` 只认三种来源：`cloudflare_access_login_time`、`built_in_mfa`、`provider_step_up`；并且要求 `authentication.recentAuthenticationEvidence` 存在、来源合法、与会话绑定。现有 `BuiltInIdentity.authenticate` 会给每个会话自动附上 `source: "built_in_mfa"` 的 evidence。设计没有说明：
  1. 确认密钥签名要新增哪种 evidence 来源，或如何映射到现有三种来源；
  2. 如何构造 evidence 的 `externalSubjectRef`、`authenticationRef`、`authenticatedAt`；
  3. 内部会话如何**不**带 evidence（否则按现有 `built_in_mfa` 路径，它会被当成近期验证）。
- 证据：
  - `ports/recent-authentication.ts:5-8`：来源联合类型只有三种。
  - `recent-authentication-service.ts:56-73`：没有 evidence 或来源非法就拒绝。
  - `built-in-identity.ts:247-266`：浏览器会话一律带上 `built_in_mfa` evidence。
  - `approval-service.ts:71-76`：审批服务本身只检查 `recentAuthenticationRef` 非空，真正把关靠上面的 guard。
- 后果：要么实现时把确认密钥伪装成 `built_in_mfa`（审计语义错误，且内部会话可能自动过关），要么新增来源/证据类型但设计没有写，导致实现者各自发挥；两种都可能让“要主人本人在场”的审批被绕过或根本用不了。
- 建议：在设计和值表里明确新增 `device_confirmation_key`（或同类）来源、evidence 的生成位置、内部会话不附 evidence 的构造方式，以及 `recentAuthenticationRef` 由服务器覆盖；补反向用例：只用设备密钥签高风险审批必须被拒、只用内部会话必须被拒、确认密钥签名才通过。

### 4. 【高/中】“服务器填授权/近期验证引用”与 `machineString`、签名正文摘要冲突
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:221`、`packages/gateway-contracts/src/thread-contracts-v3.ts:238-247`、`packages/gateway-contracts/src/contracts-v2.ts:1821-1828,2529`、`packages/gateway-contracts/src/validation.ts:65-73`
- 问题：设计说“正文里的授权引用和近期验证引用由服务器填，手机必须发空值；只有确认密钥签过的请求才填近期验证引用”。但有些命令的这两个字段是**非空 `machineString`**：
  - `thread.delete_permanently`：`authorizationRef: machineString`、`recentAuthenticationRef: machineString`（`thread-contracts-v3.ts:244-245`）。
  - `workspace.commit`：`recentAuthenticationRef: machineString`（`contracts-v2.ts:1827`）。
  `machineString` 要求 1 到 128 个字符、首字符是字母或数字（`validation.ts:65-73`），空字符串直接失败。手机发“空值”根本过不了合约校验。另一方面，如果服务器先验签/正文摘要、再把引用填进去，正文已经变了，设备密钥签名覆盖的正文摘要和确认密钥覆盖的正文摘要都会对不上；如果先填再验签，服务器就必须在合约校验前注入，而设计没有写这个顺序和占位值。
- 证据：设计要求“手机必须发空值”；`thread-contracts-v3.ts:244-245` 和 `contracts-v2.ts:1827` 是非空字段；`contracts-v2.ts:2529` 还要求 high/critical 命令的 `authorizationRef` 非空。
- 建议：定义服务器注入发生在合约解析之前，并规定一个确定的占位值（例如固定字符串）或把服务器拥有的字段从签名摘要中排除；明确设备只签“注入前”的规范正文，服务器验证后再注入。补集成测试：`thread.delete_permanently`/`workspace.commit` 由设备发起时，空值、占位值、服务器注入后的正文摘要三种情况都要覆盖。

### 5. 【中】`check:client-parity` 读“消息类型全集”会包含事件和快照，按现在的描述不可实现或会误报
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:223`、`packages/gateway-contracts/src/contracts-v2.ts:22-132`、`packages/gateway-contracts/src/thread-contracts-v3.ts:19-60`
- 问题：设计说 `check:client-parity` 读 `GATEWAY_V2_MESSAGE_TYPES` 和 `THREAD_GATEWAY_MESSAGE_TYPES` 的“消息类型全集”，并说“全集里的每一种……都要在能力表里登记”。但这两个数组不只包含客户端发起的查询和命令，还包含大量服务端事件和快照，例如 `contracts-v2.ts:121-131` 的 `collection.snapshot`、`approval.snapshot`、…、`stream.event`，以及 `thread-contracts-v3.ts` 里的 `thread.events`、`thread.event`、`thread.command_result`、`thread.conflict` 等。把这些都要求登记成“读/日常/收紧/改/手机上不做”没有意义；如果实现时按 `kind` 过滤成 query/command，设计又应该写明。
- 证据：上述数组的实际内容；现有 `scripts/check-operations.mjs:45-63` 的 `readContractOperations` 已经按 `kind === "query" || "command"` 过滤，说明“全集”并不等于“客户端请求全集”。
- 建议：在设计中明确只取 `kind` 为 command/query 的类型，并说明 thread v3 与 v2 的重复项如何去重；补反向用例：能力表里出现一个不存在的类型应失败（现在只描述了“没登记的类型被拒”，没描述“多登记不存在的类型”）。

### 6. 【中】新原生页面声称“能力表/读”有对应命令，但没有定义端点或消息类型
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:176,241,266-286`、`packages/gateway-contracts/src/contracts-v2.ts:22-132`
- 问题：设计说“生成配对码、确认、改名、移除设备在客户端能力表里都是‘改’，列设备是‘读’”，还说“感知到的”页“数据来自第 3 批的接口”。但设备 API 表里没有：
  - 列设备、生成配对码、确认配对、移除设备的端点；
  - 读取感知记录的页面查询端点；
  - 对应的网关消息类型。
  `GATEWAY_V2_MESSAGE_TYPES` 中也没有 device/pair/perception 相关类型。`check:client-parity` 只保证“现有消息类型都登记”，不会发现“新功能根本没有消息类型/端点”。
- 证据：`design.md:266-286` 的路径表；`contracts-v2.ts:22-132` 的类型全集；`design.md:241` 的“数据来自第 3 批的接口”。
- 建议：把 `GET devices`、`POST pairing/code`、`POST pairing/confirm`、`POST devices/revoke`、`GET perception`（或等价的 gateway 消息类型）补进 API 表和合约，并让 parity 检查覆盖“表里每一项都必须有实现端点”，而不只是“每个合约类型都在表里”。

### 7. 【中】`POST payload/text` 不是字面意义上的“同一个处理程序”，且 64 KB 是字符不是字节
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:221,286`、`packages/platform-node/src/http-gateway-server.ts:1233-1250,1270,1294`
- 问题：设计说设备接口 `POST payload/text` 和网页 `/api/payload/v1/text` 是“同一个处理程序”。现有 `admitText` 里包含 `assertMutationBoundary`（同源检查）、浏览器 `authenticate` 和 CSRF 校验；设备接口按 ADR 0229 决定第 4 条是**不经过浏览器同源检查**的，不能直接复用这个 handler。可以复用底层的 payload admission/store，但外层认证必须不同，设计应写清楚。另外，`admitText` 比较的是 `body.content.length > maximumCharacters`，即 UTF-16 代码单元数，不是字节数；路由传的是 `64 * 1024`。中文/emoji 下 64K 字符对应的 UTF-8 字节明显超过 64 KB。
- 证据：`http-gateway-server.ts:1240` 的 `assertMutationBoundary`、`:1242` 的 CSRF、`:1270` 的 `body.content.length`、`:1294` 的 `admitText(64 * 1024, "text/plain")`。
- 建议：把设计改成“复用同一份 payload admission/store 逻辑，设备认证和 CSRF 走另一层”；把上限写成“64K 字符（UTF-16 代码单元）”或改成真正的字节上限；补中文/emoji 边界用例。

### 8. 【中】`tasks` 页面并非“没有任何查询和命令”
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:242`、`apps/control-center/src/app/control-center-inventory.ts:153-166`
- 问题：设计把 `tasks`、`inbox-digest`、`trace`、`settings` 一起写成“这四个页面在网页清单里 `contractStatus` 是 `missing`，没有任何查询和命令”。但 `tasks` 的清单里 `queries: []`、`mutations: ["github.monitor.set_state"]`，有一条命令。
- 证据：`control-center-inventory.ts:157-158`、`:166`。
- 后果：`github.monitor.set_state` 必须在能力表里单独分档（很可能是“手机上不做”或“改”），否则 `check:client-parity` 会失败；同时“tasks 页没有任何命令”的“手机上不做”理由不成立。
- 建议：改正这句话，明确 `tasks` 页有一条命令，并在能力表里给它一个明确档位和原因。

### 9. 【中】ADR 0229/0247、详细设计、实施计划的互相引用不完整
- 文件:行：`docs/adr/0229-native-apple-clients-and-device-api.md:1-8`、`docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:7`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:11,65,68`、`docs/execution/plans/2026-11-11-apple-device-body-plan.md:11`
- 问题：
  - ADR 0247 有 `amends: "docs/adr/0229-..."`，但 ADR 0229 的 frontmatter 没有 `amended_by`；仓库里被修订的 ADR 通常会写，例如 `docs/adr/0176-ci-on-ovh-vps.md:10` 有 `amended_by`。
  - 详细设计 `:11` 仍说“两份 ADR（ADR 0229、ADR 0230）”，`:65` 的“决定”来源仍只列 0229/0230，没有 0247。
  - 实施计划 `:11` 的来源也只列 0229/0230，没有 0247。
- 后果：读者只看 ADR 0229 会看到“嵌网页”等已被 0247 否定的原文；只看设计/计划会以为决定仍只有两份 ADR。
- 建议：给 ADR 0229 加 `amended_by: "docs/adr/0247-..."`，并在设计和计划的来源/状态说明里加入 ADR 0247，明确“0229 原文保留，0247 修订决定第 3、4 条”。

### 10. 【低】`memory.settings.set` 的行号仍是 schema 声明处，不是 payload 定义处
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:217`、`docs/adr/0247-...md:50`、`packages/gateway-contracts/src/contracts-v2.ts:1494-1497`
- 问题：文档写 `contracts-v2.ts:1494`，`:1494` 是 `const memorySettingsSetCommandSchema = object({`，`payload` 在 `:1496`。这不是安全漏洞，但作者说“行号小错”已修，这里仍不精确。
- 建议：改成 `:1494-1496` 或 `:1496`。

## 二、推测或需要设计补充确认的风险

### 11. 【中】配对二维码的 `origin` 没有说明设备是否固定校验；二维码里还有长期服务令牌
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:170,175,176`
- 推测点：设计只写了二维码 JSON 里带 `v`、`origin`、`code` 和可选 `access`，没有说设备是否把 `origin` 固定成预期服务器。若攻击者替换/篡改二维码，让设备连到自己的服务器，设备本地算出的 6 位数字和攻击者服务器算出的数字可以一致（因为公钥是设备自己生成的），6 位确认数字挡不住“换服务器”这一类；合法网页上可能根本没有待确认设备。二维码里还带长期共享的 Cloudflare 服务令牌（`access.clientId`/`clientSecret`），截图或“拷贝配对链接”会把它泄露；设计只说了泄露后可轮换，没有说 `POST pair` 的限流/防刷。
- 建议：在设备端固定校验 `origin`（最好再固定服务器公钥/证书），在确认页显示 origin；不要把长期服务令牌放进二维码，或改成一次性/短期的入口凭据；给 `POST pair` 加按 IP/令牌的限流。

### 12. 【中】配对码“只能用一次”和挑战值“只能用一次”的原子性没有写到表约束
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:169,219,255-256`
- 推测点：设计说配对码 10 分钟、只能用一次，挑战值靠 `device_request_nonces` 挡重放；但表字段只写了“设备编号、随机值、过期时间”，没有写 `(设备编号, 随机值)` 唯一键/主键，也没有写“插入和判断在同一条语句/同一事务里完成”。如果实现先查后写，两个并发请求可能都用同一个挑战值或同一个配对码。
- 建议：明确 `device_request_nonces` 的唯一约束和原子插入；配对码用 `UPDATE ... WHERE used_at IS NULL AND expires_at > now` 或等价事务消费；给并发重放/并发配对补反向用例。

## 三、侧重检查

- 错误路径/重放：挑战值方向基本可行（HMAC 绑设备编号 + `device_request_nonces`），但表约束、清理和并发原子性未写；配对码单次消费未写原子性。
- 不可信输入：`memory.mutate` 的 `action`、`proactive.settings.set` 的 `quietHours`/`importantSenders`、客户端提供的 `authorizationRef`/`recentAuthenticationRef`、二维码 `origin` 都缺少服务端强制校验；设计多处写“手机必须发空值/核对数字”，仍是客户端义务，不是服务端保证。
- 不可撤销操作：`thread.delete_permanently` 没有被明确分到“改”；`memory.mutate` 的 `delete` 实际只是 trash，`correct`/`restore_version` 可能误落“日常”；这两点会造成“不能撤回”的后果或反向的面容摩擦。
- 资源耗尽：`POST pair` 和 `approvals/challenge` 没有限流；二维码携带长期服务令牌；`device.nonce.retained` 有上限但没有清理机制说明；`POST payload/text` 的 64 KB 实际按字符算。
- 规则/文档/代码一致：`tasks` 页“没有任何命令”与清单不符；`settings` 页写“手机上不做”但原型/界面基线里明确有设置页；ADR 0229 缺 `amended_by`，设计和计划来源缺 0247；`POST payload/text`“同一个处理程序”与浏览器鉴权耦合不符。
- 配对安全：6 位数字只绑两把公钥、并且手机本地计算，这一点本身合理；问题在 `origin` 固定、服务令牌暴露、配对码原子消费和“iPhone 发起配对”的命令分档没有端到端验证。只拿到设备密钥不能生成/确认配对，前提是能力表真的把这几项登记成“改”；目前没有对应消息类型和反向用例。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   这个提交本身不会：改动只有 `docs/`、`.agents/reviews/` 和原型素材，没有改任何组装模型请求的代码。设计仍要求感知内容只以“这一轮末尾追加的工具结果”出现（`design.md:711`），每轮变化的当前时间/资料只放在末尾（`:712`）。设计里提到的“加两个新工具会让老对话重建一次请求开头”（`:715`）是**将来**实施那一步的一次性变化，ADR 0229 决定第 7 条已说明 Andy 同意；不是本 PR 已经发生的变化。结论：本 PR 的代码/配置没有改变系统提示、工具定义、历史消息或遮盖结果；设计层面仍保持只追加。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   新增的值里，`pairingNumber` 是对两把公钥的确定性 SHA-256 截断，稳定；挑战值、配对码、二维码是随机/时间相关的，但它们不进模型请求。`perception.extract` 明确按固定键排序、当前时间放最后（`design.md:712-713`），同一批记录/日历/时间下字节相同；`redactForEgress` 的 `known` 只从前往后传播，删除/改动同批前面的记录会改变后面记录的遮盖，但这只影响**以后新发的后台请求**，不影响已经发出去的对话。结论：没有发现新的“同一段文字在不同请求里变成不同字节”的模型可见路径。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   这个 PR 没有新增任何测试文件；设计里列的 `device-gateway.test.ts`、`device-limits.test.ts`、`check:client-parity` 都是第 11 批及以后才实现的计划，不是当前可执行的检查。当前能说的只有：提交说明称六项文档检查通过、`validate_docs.py --strict` 有 13 个既有错误且没有新增；这个我无法在仓库里运行验证（工具不在仓库，按规则也不能运行），标记为**未核实**。
   反向用例也不够：现有描述里的“正文多带一个字段被拒”可能只是合约层 `object` 的 unknown-field 拒绝，不一定证明能力表的分档判断生效；“只用设备密钥签 `memory.settings.set` 的 `capturePaused:false` 被拒”是有效的，但没有覆盖 `proactive.settings.set` 的 `enabled:false` + 改 `quietHours`/`importantSenders`，也没有覆盖 `memory.mutate` 的 `correct`/`restore_version`。因此即使按当前列表补测试，上面第 1、2 条漏洞仍可能漏过。

4. **每个新值，产生它的地方和使用它的地方都能接受吗？**
   不能全部接受，主要有这些对不上：
   - `memory.mutate` 的 `action`：能力表按类型分档，但实际一个类型含 `correct`/`delete`/`recover`/`restore_version`，两端对“日常/改”的理解会不一致。
   - `proactive.settings.set` 的三个字段：设计用“静态正文条件”，但使用端是整对象设置，无法只凭静态条件保证“只放宽/只收紧”。
   - `authorizationRef`/`recentAuthenticationRef`：设计说服务器填、手机发空值，但 `thread.delete_permanently`/`workspace.commit` 的字段是非空 `machineString`，且填值会改变签名正文摘要。
   - “确认密钥签名 = 近期身份验证”：产生端没有新增 evidence 来源，使用端 `RecentAuthenticationGuard` 只认三种来源；内部 `product_sessions` 还可能被 `BuiltInIdentity` 自动附上 `built_in_mfa` evidence。
   - `check:client-parity`：使用端读的“类型全集”包含事件/快照，和“客户端请求”不是同一个集合。
   - `pairingNumber`/二维码 `access`：产生端是服务器/网页，使用端是设备，但没有 schema/合约和端到端校验；`access` 的两个字段是否必须同时出现、`origin` 是否固定都没写。
   - “感知到的”页、设备列表、生成/确认配对、移除设备：设计声称有“读/改”命令，但 API 表和消息类型里没有对应的产生者，parity 检查不会发现。
   - `tasks` 的 `github.monitor.set_state`：页面清单里有，设计说“没有任何命令”，使用端能力表可能漏登记。
   - `POST payload/text` 的引用：设备产生，网页同一个 handler 消费；但该 handler 当前绑定了浏览器同源/会话/CSRF，且 64 KB 是字符不是字节。
   - `device_request_nonces`：挑战值产生端依赖它挡重放，但表没有写唯一键/原子插入/清理，使用端能否真正“只用一次”未定。
