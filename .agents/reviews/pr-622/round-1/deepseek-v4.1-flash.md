### 1. 高：批准失败路径会留下未清零的字段明文
- 文件:行：`packages/application/src/services/vault-service.ts:490-556`
- 问题：解密后的字段只放进 `released` 后才归 `wipeAll` 管；当前项在字段循环中途失败时，已解密到 `fields` 的值不在 `released` 里，不会被抹掉。成功解密后 `recordUsage` 失败时，整个 `released` 也不会被抹掉。这直接违反「服务器……用完抹掉」。
- 证据（读代码证实）：
  - `const released: ReleasedVaultItem[] = []; const wipeAll = () => { for (const item of released) ... }`（490-493）
  - 字段先写进 `fields`，所有字段成功后才 `released.push(...)`（516-537）
  - `catch` 只调 `wipeAll()`（539-541）；若失败发生在 `fields` 循环中，`released` 仍为空
  - `recordUsage` 在 `try` 之外（557-566）；它抛错时既不 `wipeAll`，也不 `#settle`
  - 另外 `decryptField` 返回的临时 Buffer 还被 `Buffer.from(...)` 复制一次，原 Buffer 未清零（526-532）
- 建议：把「字段解密 → 使用记录 → settle」包进同一个 `try/finally`；`finally` 中对当前 `fields`、`released` 统一清零；只有真正把 secrets 交给调用方时才跳过清零。同时给「去掉 wipe 必须导致测试失败」加反向用例。

### 2. 高：保险箱页面和批准页没有任何入口，批准推送没有人处理
- 文件:行：`clients/apple/Sources/HimawariManage/Vault/VaultPages.swift:42,585`、`clients/apple/Sources/HimawariShell/AppDelegate.swift:18-26`、`apps/agent-service/src/production-apple-push.ts:166-191`
- 问题：`VaultRootView` 和 `VaultApprovalView` 只有定义，没有被任何地方引用；推送里的 `vaultRequestId` 也没有消费者。用户既打不开保险箱，点批准通知也不会进入批准页。
- 证据（读代码证实）：
  - 全仓库 `clients/apple` 搜索 `VaultRootView|VaultApprovalView`，只有这两个定义处
  - `AppDelegate` 收到远程通知只处理 `SilentWithdrawPush.notificationId(in:)`，否则 `.noData`（23-25）
  - 推送载荷写了 `vaultRequestId: input.requestId` 和 `navigate: "/"`（187-190），但客户端没有读取 `vaultRequestId` 的代码
- 建议：在设置页接入 `VaultRootView`；通知点击按 `vaultRequestId` 打开 `VaultApprovalView`；加一条自动检查，至少断言载荷里的键有客户端消费者，或加真实通知路由测试。

### 3. 中：请求先被标成 approved，再解密；解密或记录失败后状态与结果不一致
- 文件:行：`packages/application/src/services/vault-service.ts:478-489,539-566`
- 问题：`decideRequest(status: "approved")` 在解密之前执行；之后 `listItems` 抛错不在 `try` 内，解密失败在 `catch` 里只把 waiter settle 成 denied，但数据库中的请求已是 approved。重试会得到 410，使用记录却记成 failed；`listItems` 抛错时 waiter 要等计时器才结束，可能最终被 settle 成 expired。审计上会出现「approved 但没交付秘密」。
- 证据（读代码证实）：
  - 478-486：`decideRequest({ status: "approved" })` 后 `if (!decided) ...`
  - 487-489：`listItems` 在 `try` 之外
  - 539-556：失败时 `#settle(id, {kind:"denied"})` 并写 `outcome: "failed"`，但状态已是 approved
  - 557-566：成功路径的记录失败会直接跳出，不 settle
- 建议：先完成 `listItems` 和所有解密，再原子地把请求标成 approved；或者增加明确的 `failed` 终态，保证「决定状态、使用记录、settle、清零」同一路径完成，失败时不会留下 approved。

### 4. 中：过期和 pending 请求只靠内存计时器；重启后会在库里永久留着，也没有数量上限或清理
- 文件:行：`packages/application/src/services/vault-service.ts:340-347,350-370,382-386`、`packages/persistence-sqlite/src/sqlite-vault-operations.ts:271-282`
- 问题：等待器和过期计时器都在进程内存里；服务重启后数据库里的 `pending` 行还在，但没有 waiter，也没有计时器。`listPendingRequests` 只是过滤 `expires_at > now`，不会把过期行改成 expired；`approve` 会因没有 waiter 直接 410，也不会关掉这行。`rotation`/`delete` 自动关 pending 时只改状态，不写 usage，和显式 deny/expire 不一致。
- 证据（读代码证实）：
  - `#waiters` + `setTimeout` 构造内存等待器（340-347）
  - `#expire` 只在计时器触发时决定 expired（350-370）
  - `listPendingRequests` 的 SQL 只 `SELECT ... WHERE status='pending' AND expires_at > ?`（271-282），没有更新
  - `applyChange` 批量改 `status='denied'`（sqlite-vault-operations.ts:214-218），`#closeAll` 不写 usage（382-386）
- 推测部分：如果后续真的由模型触发大量 `requestRelease`，当前没有每个 scope 的 pending 请求上限，可能在 120 秒窗口内堆积请求、推送和数据库行；这一 PR 里 `requestRelease` 还没有生产调用方。
- 建议：启动时或定期按 `expires_at` 收敛 pending；读 pending 时可顺手落 expired；给每 scope 的 pending 数量设上限；自动关闭也写 usage。

### 5. 中：手机能生成 28 字节的空字段密文，服务器最小长度却是 29 字节
- 文件:行：`packages/application/src/services/vault-service.ts:170`、`clients/apple/Sources/HimawariCore/Vault/VaultCrypto.swift:114,193`、`clients/apple/Sources/HimawariCore/Vault/VaultSession.swift:158`
- 问题：这是 I-73 那类「两端校验不一致」。Swift 对空字符串 + AES-GCM 得到 12+16=28 字节密文，服务器 `parseItem` 要求至少 29 字节，导致整次 `vault/change` 被拒；`VaultSession.add` 没有像 `replace` 那样拒绝空值，`password` 或可选字段为空时就能触发。
- 证据（读代码证实）：
  - 服务器：`vaultBase64(ciphertextsInput[field], 29, VAULT_LIMITS.ciphertextBytes)`（vault-service.ts:170）
  - Swift：`ciphertexts[field] = try Self.sealAESGCM(Data((item.values[field] ?? "").utf8), ...)`（VaultCrypto.swift:114）
  - Swift 解密侧只要求 `combined.count >= 28`（VaultCrypto.swift:193）
  - `VaultSession.replace` 有 `guard !value.isEmpty`（158），但 `add` 没有对应校验
- 建议：两端统一最小长度（28 或 29 选一个），或在手机端 `add`/`seal` 拒绝空字段；把这个边界加进 `vault-contract` 的真实数据库反向用例。

### 6. 低到中：自动检查存在，但没有把 Swift 核心和数据库边界真正纳入 `npm run check`
- 文件:行：`package.json:27,42-45`、`test/integration/vault-contract.test.ts`、`clients/apple/Package.swift`
- 问题：四个 `check:vault-*` 确实在 `check:steps` 里，反向用例也真实（批准字段篡改、过期、重放、回滚、注销设备、rotation 漏项、泄漏工具结果）。但 `npm run check` 只跑 JS 的 integration 测试，没有 `swift test`；`vault-contract` 读的是静态夹具，无法发现 Swift 或服务器实现漂移；它也没有覆盖 `wrappedKey`、字段密文、`ephemeralPublicKey`、`signature`、`purpose`、`pageVersion`、`runId`、状态/outcome 这些新增值的数据库边界。
- 证据（读代码证实）：
  - `check:steps` 里的 `check:vault-*` 都是 `vitest run ... --project integration`（42-45）
  - `clients/apple/Package.swift` 单独定义 `HimawariCoreTests`，但根 `package.json` 没有对应的 Swift 测试步骤
  - `vault-contract.test.ts` 只校验正则辅助函数、origin/name/fields 和两个静态向量
- 建议：把 `swift test`（至少 `HimawariCoreTests`）纳入能在 Linux 跑的检查，或在 Mac 上作为合并前必跑记录；让夹具由两端代码生成或有交叉生成步骤；给每个新增值加真实 SQLite 插入/拒收边界测试；再加「删除 wipe 或去掉 `decided` 校验时测试必须失败」的反向用例。作者说的「Swift 核心 19 个测试在 Linux 上通过」我未核实，也无法从当前改动确认它已成为门槛。

### 7. 低：打开保险箱列表时为了显示用户名，会解密整项的密码
- 文件:行：`clients/apple/Sources/HimawariCore/Vault/VaultSession.swift:113-115`、`clients/apple/Sources/HimawariManage/Vault/VaultModel.swift:30-35`
- 问题：`username(of:)` 直接 `keyring.open(item.sealed)`，而 `open` 会解密该项所有字段；`VaultModel.load` 又对列表里的每一项调用它。仅打开列表就会把所有密码短暂解密进内存，扩大明文暴露面。
- 证据（读代码证实）：
  - `return try keyring.open(item.sealed).values["username"]`（VaultSession.swift:115）
  - `VaultModel.load` 对每个 item 调 `session.username(of: item)`（VaultModel.swift:33-34）
- 建议：加一个只解指定字段的窄接口，或让 `username(of:)` 只解密并返回 `username` 字段。

**侧重检查**
- 错误路径：查了 `approve` 的 `listItems`、HPKE 解封、JSON/TOTP 解析、字段解密、`recordUsage`、`#settle`；发现第 1、3 条。通知失败后请求和 waiter 会留到超时，这是有意的兜底，未单独列为意见。
- 不可信输入：`approve`/`deny` 用 `exactKeys` 校验字段；`vault/change` 逐项校验 id、name、kind、origin、fields、base64 长度；`/vault/usage` 的 `itemId` 也过 `VAULT_PATTERNS.itemId`；`purpose` 拒绝隐藏字符。总体做得较严；唯一发现的跨端边界问题是第 5 条。
- 安全边界：服务器确实不保存总钥匙；`VAULT_PHONE_ONLY_FIELDS` 让服务器在批准时跳过 `totp`；HPKE/HKDF/AAD/manifest 字节在 Swift、测试手机和 Node 三端核对一致；重放、过期、注销设备分别由 `decideRequest` 的 `status='pending'`/`expires_at` 条件和路由认证保证。发现第 1、2、7 条。
- 资源耗尽：主要问题是第 4 条；`requestRelease` 目前没有生产调用方，所以「模型刷请求」还是推测。`vault_list` 最多 500 项，工具输出没有额外上限，但这一 PR 风险有限。
- 不可撤销操作：rotation 采用「先写 next、服务器收下后换 current」；失败后靠 `.next` 恢复，逻辑成立。删除、rotation 会关闭 waiter；但自动关闭不写 usage，见第 4 条。
- 规则/文档一致性：工具描述本身是固定的，`vault_list` 的结果排序固定且只出现在末尾工具结果；但代码在未配置 vault 时会不提供该工具（`production-runtime-tools.ts:612`），和规范里「没开保险箱时工具照样在，只是如实回答」有缝隙。批准推送/页面与设计规格不一致，见第 2 条。迁移文件能被 `loadBundledMigrations` 自动按时间戳发现（`migration-engine.ts:1352-1365`），不需要手工登记；新文件没有代码注释，和「不写代码注释」一致。
- 未核实：Swift 页面在 Mac/Xcode 下是否编译通过；`check:prompt-catalog` 的两个新 sha256 是否与文本一致；作者说的 19 个 Swift 测试是否真的跑过。

**必答问题 1**
不会修改已经存入历史的用户消息、系统提示历史或工具结果，但会给旧对话带来一次请求开头变化：改动新增了 `vault_list` 工具定义（`production-runtime-tools.ts:612`），工具集合变了，按规则第 6 条允许换新一次，但这次 PR 没有展示该换新记录。之后同一对话里工具定义固定；每轮会变的保险箱内容只出现在 `vault_list` 的工具结果，位于本次请求末尾的追加消息，不会进系统提示或工具定义。另一个细微点：工具是否提供取决于 `options.vault` 是否存在，而不是保险箱里有没有项；生产里 `vault` 在 `webEnabled` 分支创建（`service-main.ts` 中 `vault = new VaultService(...)`），所以生产配置下稳定，但规范里的「所有对话固定提供」不是由工具描述本身保证的。

**必答问题 2**
模型可见的固定文字没有新增时间、请求计数或随机值：工具描述是 `TOOL_VAULT_LIST.text`；清单字节按项 id、origins、fields 排序，由 `VaultManifest.bytes`/`vaultManifestBytes` 确定；`listedVaultItems` 按 name、id 排序；`parseItem` 对 origins、fields 排序。`vault_list` 的结果随保险箱状态变化，但只作为工具结果追加在末尾，同一个状态下排序确定。推送载荷里的 `requestId`、过期时间不属于模型请求。所以没有发现新的「同一段文字在不同请求里变字节」问题。

**必答问题 3**
有对应检查，且反向用例不是空壳：`vault-approval` 会篡改 nonce/origin/pageVersion/ephemeralPublicKey/expiresAt/itemIds/itemVersions/deviceId 并期望失败，还覆盖过期、重放、密文偷换、回滚、deny；`vault-recovery` 覆盖注销设备和 rotation 漏项；`vault-contract` 有 reject 夹具；`vault-canary` 有一个故意泄漏的工具结果反向用例。局限：Swift 核心测试不在 `npm run check`（见第 6 条）；静态夹具不能发现 Swift 实现漂移；`vault-canary` 没有扫描设计里说的「发给模型的请求、对话记录、日志、沙箱输出」；`check:vault-approval` 的 `-t vault-approval` 不包含 `[vault-recovery]` 里的注销设备用例（注销设备由 `check:vault-recovery` 覆盖）。所以结论是「有检查，但作者说的全覆盖不成立」。

**必答问题 4**
逐个核对结果：
- `vi_`/`vr_` id：产生端 16 字节 base64url + 3 字符前缀，长度 25；数据库 `vault_items.id`/`vault_release_requests.id` 要求 25 且匹配前缀，Swift `isItemId`/`isRequestId` 要求 22 字符 token，测试手机同规则；通过。
- nonce：服务端 32 字节 base64url 43 字符；数据库 `vault_release_requests.nonce` 要求 43 且 UNIQUE；`VAULT_PATTERNS.nonce`、Swift `isNonce` 都是 43；通过。
- `wrappedKey`：Swift AES-GCM 60 字节 → base64 80；服务端只收 60 字节，数据库 `wrapped_key` 要求 80 字符；通过。
- `signature`：HMAC-SHA256 32 字节 → 44 字符；数据库 `vault_manifests.signature` 要求 44；通过。
- `ephemeralPublicKey`/`enc`：P-256 非压缩公钥 65 字节 → 88 字符；数据库 `ephemeral_public_key` 要求 88；批准 `enc` 要求 65 字节；通过。
- origin：`https://` + host + 可选端口，数据库 9–300 字符；`vaultOrigin`/`VaultContract.origin` 的规范化一致；通过。
- `status`/`outcome`：数据库 status 只收 `pending|approved|denied|expired`，服务端写值一致；outcome 数据库只限长度，Swift `VaultUsageOutcome` 的 `approved|denied|expired|filled|failed` 与服务端写值一致；通过。
- `targetType: "owner-vault"`：只在 TypeScript 注册表/Builtin preflight 使用，已同时加入两处，测试也更新；没有数据库枚举约束；通过。
- `vault.list`：工具动作行、描述符、prompt catalog、`builtInCapabilityFacts` 都能接受；通过。
- `vault_approval` push kind：服务端能产生，但客户端没有任何消费者（见第 2 条），所以「使用它的地方能接受」这一点不成立。
- 唯一读到的两端校验不一致是字段密文：Swift 空值 28 字节，服务器最小 29 字节（第 5 条）。
- 未核实：`check:vault-contract` 没有覆盖上述大部分数据库边界，`wrappedKey`/`ciphertext`/`ephemeralPublicKey`/`signature` 的边界是否真的能在真实 SQLite 写入，只有集成流程间接覆盖。
