## 侧重检查（先看我查了什么）

- **错误路径/不可信输入**：现有出口代理对 `http` 只允许已登记的 `host:port`，拒绝非公网地址，断网/权限变化会关闭，有 128 连接上限和 10 秒超时（`packages/runtime-sandbox/src/network-egress.ts:50-79,131-137,194-203`）；但 **https 只做 CONNECT 隧道**（`:138-179`），看不到方法、路径、请求体。方案把这层改成“解 TLS 换真值”，等于新写一个高权限 MITM，方案没有写它如何校验上游证书、限制方法/路径/注入位置、限制请求/响应大小、禁止日志。现有 `injectProgramSecrets` 更是把**真值**写进沙箱程序输入（`apps/execution-worker/src/program-secret-injection.ts:39,53`），与方案“程序手里只有替身”直接冲突。
- **安全**：现有钥匙串封装写的是 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，没有 `kSecAttrSynchronizable`（`clients/apple/Sources/HimawariCore/KeychainValueStore.swift:44-58`），既不能同步，也不是“每次读取都要 Face ID”。Secure Enclave 封装只有 `.confirm` 角色带 `.userPresence`，`.device` 角色没有（`SecureEnclaveKeys.swift:75`）。批准通知的 `authenticationRequired` 只保证“设备已解锁”，不保证 Face ID（Apple 原话）。批准签名、临时公钥、重放、设备撤销、主密钥轮换都没有闭环。
- **资源耗尽**：现有代理有连接数/超时/头部大小限制；方案的出口守门和批准流程没有写请求体/响应体上限、批准频率限制、临时密钥生命周期、并发任务隔离。
- **不可撤销操作**：登录提交、付款/转账、删除条目、换手机、丢手机后的设备撤销与全量重加密都没有定义；远程抹掉不能撤销已同步到其他 Apple 设备的钥匙。
- **规则/文档/代码一致性**：v4 删掉了 v3 的 `check:vault-canary`、`check:vault-contract`（`plan-v3.md:51-54`），没有对应自动检查；引用的 `payload-protector.ts` 是服务器 KEK 的信封加密，不是手机主密钥；引用的 `KeychainValueStore.swift` 不能同步；引用的 ADR 0285 未合入 main、未核对原文（`plan-v4.md:73`）；对 Meta/Claude/1Password 的比较与一手材料不一致。

---

## 证实的（按严重度从高到低）

### 1. 严重度高：核心承诺“iCloud 同步 + 每次 Face ID”按现有代码和 Apple 约束不成立

**问题**：方案说总钥匙放 iCloud 钥匙串、只有苹果设备能看、用前 App 要求 Face ID（`plan-v4.md:11,16,29,69`）。现有 `KeychainValueStore` 写入时用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，且从不设 `kSecAttrSynchronizable`（`KeychainValueStore.swift:44-58`）。因此：
- 第三方 App 默认不同步；要同步必须显式设 `kSecAttrSynchronizable`。Apple 原文：“by default, keychain items added by third-party apps don’t sync. Developers need to set the `kSecAttrSynchronizable` attribute.”（https://support.apple.com/guide/security/sec0a319b35f/web）
- 带 `ThisDeviceOnly` 的保护类不能同步。Apple 原文：“Items stored or obtained using the `kSecAttrSynchronizable` key may not also specify a `kSecAttrAccessible` value that is incompatible with syncing (namely, those whose names end with `ThisDeviceOnly`).”（https://developer.apple.com/documentation/security/ksecattrsynchronizable）
- `AfterFirstUnlock` 意味着设备首次解锁后，即使再锁屏，App 仍可读取该条；现有封装也没有 `SecAccessControl`/LAContext。也就是说，“没有锁屏密码或 Face ID 用不了钥匙”不成立。
- Apple 的 Face ID 钥匙串示例用的是 `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly + .userPresence`，并明确说因为 `DeviceOnly`，该项 **isn’t eligible for the iCloud keychain**（https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id）。同步与“每次读取都要生物识别”能否同时成立，方案没有验证；即使可行，也绝不是现有封装。
- 设备签名钥匙：现有 `.device` 角色创建时没有 `.userPresence`，只有 `.confirm` 有（`SecureEnclaveKeys.swift:72-94`）。如果批准签名用 `.device`，手机上的恶意代码可以不经用户在场就签名，“证明这台手机发的”不等于“证明主人批准的”。

**建议**：
1. 新建专门的保险箱钥匙项，不要复用现有 `KeychainValueStore`；先做原型验证 `kSecAttrSynchronizable` + `kSecAttrAccessControl`（`.biometryCurrentSet` 或 `.userPresence`）是否可同时成立。若不可，改为“Secure Enclave 包装的主密钥 + iCloud 只同步包好的备份”，或“仅本机 SE + 打印恢复码”，不要同时承诺两者。
2. 批准签名必须用 `.confirm` 这类带 `.userPresence` 的 SE 密钥，并且每次释放都显式走 LAContext；通知解锁不能替代。
3. 把“App 要求 Face ID”改成“Secure Enclave/钥匙串 ACL 强制”，并在文档中写清降级到设备密码的情况。

### 2. 严重度高：出口守门是重写，且现有代码把真值直接交给沙箱程序

**问题**：方案说 API key 和沙箱程序“程序手里只有替身值”，出口守门“用自己的证书解开沙箱发出的 https”（`plan-v4.md:36`）。但：
- 现有 HTTPS 出口是 CONNECT 隧道（`network-egress.ts:138-179`），只看到 `host:port`（`:149-154`），看不到方法、路径、请求头/体；也没有 TLS 终止、CA 安装、HTTP/2 处理。
- 现有沙箱程序注入解析 `secretRefs` 后，直接 `values[name] = await input.secrets.resolve(...)`，再把真值放进 `secrets` 返回（`program-secret-injection.ts:39,53`）。这正是方案要禁止的行为，必须替换。
- Anthropic 的一手文档明确：做占位符替换必须让代理终止 TLS；“Masking requires … TLS termination”；每个 mask 条目要限制 `injectHosts`；“Allowing broad domains such as github.com can create paths for data exfiltration”；Node 的 `fetch()` 默认忽略代理，需要 `NODE_USE_ENV_PROXY=1` 或 netns/iptables（https://code.claude.com/docs/en/sandboxing）。这些方案都没写。
- 现有出口代理由独立容器、internal network、只读、cap-drop、单独用户运行（`execution-backend/egress-proxy.ts:232-260,323-349`），这是好的基础；但把它升级成 MITM 会引入 CA 私钥、上游证书校验、HTTP/2、日志/内存等新攻击面。

**建议**：不要把“现有 https 隧道”说成“已有出口守门”。单独设计一个按 job 隔离的 TLS 终止代理：
- 上游证书必须正常校验并可固定；只对登记过的 `host + method + path + header/body 字段` 注入，禁止出现在 URL/query；
- 替身用随机 256 位 + HMAC 映射，不能用可猜的 `HIMAWARI_SURROGATE_xxx`；
- 响应按原样和常见编码遮真值；限制请求/响应大小、时间、并发；绝不记录 body/header；
- 替换 `injectProgramSecrets` 为只注入替身，并补反向测试（见第 5 条）；
- 浏览器登录 POST 不应经过同一个“可读 body”的注入路径，否则出口守门也会看到密码；浏览器路径应直接走受控 CONNECT/单独策略，或明确把出口守门纳入与保险箱程序相同的信任边界。

### 3. 严重度高：批准绑定不完整，重放/替换/通知泄露没有闭环

**问题**：
- 方案说签名“绑定这次办事、这一项、这个网站、过期时间，只能用一次”（`plan-v4.md:30`），但没有绑定**第 6 步的临时公钥**、**手机返回的密文摘要**、以及**服务器签发的一次性 nonce**。如果签名不覆盖临时公钥/密文，替换或重放的空间就存在；如果“办事编号”由服务器自选且不落库校验，重放无法防。
- 现有 `DeviceSignature` 的 nonce 是客户端生成的（`DeviceSignature.swift:48,98`），服务端必须保存并拒绝复用；方案没有写这个消费端。
- `authenticationRequired` 的 Apple 原文只是：“The action can be performed only on an unlocked device. When the user selects an action with this option, the system prompts the user to unlock the device.”（https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions/authenticationrequired）它不等于 Face ID；设备已解锁时甚至不会弹。方案把它当成“系统要求 Face ID 解锁”（`plan-v4.md:29`）不成立。
- 批准卡片要显示“哪段对话、她要做什么”（`plan-v4.md:28`），这些是不可信文本；方案没有说按纯文本渲染、不能用它覆盖签名过的条目/网站。1Password 明确把请求的每个字段当 untrusted claim、只作为纯文本展示（https://support.1password.com/1password-claude-security/）。
- 锁屏通知本身会显示“招商银行网银（ebank.cmbchina.com）”和对话摘要，旁边的人能看到；方案没有通知隐私/摘要最小化。

**建议**：服务端生成一次性 `approvalNonce`，短 TTL，原子消费；手机签名覆盖 `nonce + 设备 id + 条目 id + 精确 origin + 方法 + preparedActionHash/pageVersion + 临时公钥 + 密文摘要 + 过期时间`；用 `.confirm` 的 SE 钥匙并要求用户在场；通知只显示通用文案，解锁后再拉详情；所有不可信文本纯文本渲染，权威字段只来自签名过的元数据；加批准频率限制和异常提醒。

### 4. 严重度高：威胁模型把“服务器被攻破平时”“网页钓鱼”写成“无”，与方案自身承认的事实矛盾

**问题**：
- 方案写“服务器被完全攻破（平时）| 只拿到密文 | … | 无”（`plan-v4.md:47`）。但条目名字、允许网站是服务器明文（`:19`），攻击者能拿到“你有哪家银行、哪些网站”的元数据；被攻破的服务器还可以一直潜伏，等你某次正常批准时拿到该项钥匙并解密密码（`:48` 已承认）。所以“平时无”应改成“未批准时无真值；元数据会泄露；一旦批准，攻击者可长期保留”。
- 方案写“网页里藏指令骗她去钓鱼网站填密码 | … | 无”（`:50`）。但第 5 步的“浏览器真实地址”是**服务器自己**检查的；手机只核对服务器送来的网站字符串（`:29`），没有独立看到浏览器。服务器被攻破时，这个“双重核对”只剩一重；手机无法判断浏览器实际在哪。方案自己的“被攻破服务器伪造批准请求”行（`:49`）也承认了这一点。
- “偷听网络 … 无”（`:55`）也过强：如果服务器临时私钥后来从内存/快照泄露，录下的密文可解；只有在私钥确实短暂且未被攻破时才成立。
- “1Password 只是少一处风险”（`:64`）是轻描淡写：1Password 的浏览器和钥匙都在本机，密码从不经过 agent/服务商基础设施（https://support.1password.com/1password-claude-security/）。它去掉的正是本方案最大的“服务器使用时看到明文”风险。

**建议**：把风险表改成条件式结论：“服务器诚实且未被攻破时……；服务器被攻破时……”。不要写“无”；把元数据泄露、批准时泄露、URL 由服务器自述、临时私钥生命周期都列为剩余风险。对高价值账户明确建议本机浏览器/Passkey/OAuth 路径，服务器填表只作为低风险或明确接受风险的选项。

### 5. 严重度高：v4 没有任何自动检查，v3 的门槛被删掉了

**问题**：v4 全文没有“自动检查”一节；v3 有 `npm run check:vault-canary` 和 `npm run check:vault-contract`，并明确反向用例（`plan-v3.md:51-54`）。I-73 的教训就是“只看了改动，没问清单里的 id 能通过后端校验吗”（`docs/incidents-and-gates.md:112`）。本方案新增的值比 I-73 多得多（条目 id、字段 id、origin、签名、临时公钥、nonce、密文、替身、出口策略），却没有任何“每个值两端都接受”的检查。

**建议**：恢复并扩展成硬门槛，至少：
- `check:vault-canary`：canary 密码/钥匙跑完录入、列出、批准、填表、API 注入、沙箱；扫描每个发给模型的请求、历史、数据库、日志、推送正文、沙箱输出、错误信息、截图/可访问性树；反向：故意把 canary 放进工具结果/编码后结果/错误，必须失败。
- `check:vault-contract`：每个新值用同一规则过产生端和消费端；反向值必须被拒（origin 大小写/端口、条目 id、签名字节、密文 AAD、nonce 复用）。
- `check:vault-approval`：重放、过期、错条目、错 origin、错设备、nonce 复用、旧签名回滚，全部失败。
- `check:vault-egress`：非允许 host、重定向、DNS rebinding、私网地址、URL/query 中替身、超大请求/响应、响应回显，全部失败。
- `check:prompt-prefix` 增加保险箱用例：列表顺序固定、不带时间/用量、工具冻结、遮盖确定；反向：重排列表、加时间、轮换密码后旧历史遮法变化，必须失败。

### 6. 严重度高：没有设备撤销、主密钥轮换、全量重加密；丢手机/换手机的处置不完整

**问题**：方案对“手机丢了”只写“没有锁屏密码或 Face ID 用不了钥匙；远程抹掉”（`plan-v4.md:56`）。但：
- 钥匙在 iCloud 钥匙串会同步到其他苹果设备；远程抹掉手机不会撤销其他设备，也不会让服务器上的密文失效。
- 服务器只存密文，但如果手机曾被攻破、或某台同步设备被攻破，攻击者拿到主密钥后可解所有条目；没有轮换主密钥和重加密流程。
- 密码修改/条目删除后，旧密文仍可被旧钥匙解开；没有版本/重加密。
- v3 有 rewrap（`payload-protector.ts:273`），v4 把钥匙移到手机后没有对应的重加密设计。

**建议**：增加“设备列表/撤销设备、主密钥轮换、所有条目重加密、旧设备立即失效”的流程；批准签名要绑定设备 id 和撤销列表；换手机要能选择“迁移并吊销旧设备”或“只本机 + 恢复码”；文档写清“所有 Apple 设备丢光/Apple ID 丢”的数据丢失风险。

### 7. 严重度高：检查与填充之间存在 TOCTOU，填表/提交/清理也没有按 1Password/Muse 的强约束设计

**问题**：流程是第 5 步检查页面 → 第 6 步推送 → 用户 Face ID（可能几秒到几十秒）→ 第 9 步填充（`plan-v4.md:27-31`）。页面在这段时间可以跳转、改表单、加覆盖层。现有网页能力已经用 `pageVersion`/`finalUrl` 在 execute 前重新核对（`packages/application/src/services/web-capability-service.ts:318-325`），方案没有说复用它。第 10 步只说“提交登录”，没有说由保险箱程序在 agent 看不见时原子完成“填→提交→验证成功标记”，也没有说失败时关闭页面/清 cookie/禁用截图与可访问性树。1Password 的做法是“While 1Password fills, the agent sleeps … fills, submits, verifies … if submission fails, clears every filled value”（https://support.1password.com/1password-claude-security/）；Meta 的浏览器子代理看的是 accessibility tree 而不是 raw DOM，填表时 agent 被暂停（https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse）。方案没有这些约束，密码可能在填表期间被页面脚本、截图、可访问性树或浏览器 trace 暴露给模型。

**建议**：批准绑定到 `preparedActionHash + pageVersion + finalUrl + 表单 action origin`；填充前立即重新 inspect，页面变了就作废重问；由保险箱程序（不是模型）在同一原子步骤内填、提交、验证成功标记；期间 agent 完全暂停、不读 DOM/截图/可访问性树；失败关闭页面/清空上下文；登录只用 POST，禁止 GET 把密码放 URL；不使用自动填充/表单历史/Playwright trace/video。

### 8. 严重度中：条目钥匙密文没有绑定条目 id，存在“批准 A 却释放 B 的钥匙”的替换空间

**问题**：方案说“每一项的小钥匙 | 用总钥匙加密后存服务器”（`plan-v4.md:17`），但没有说加密的 AAD 绑定 owner、条目 id、字段、版本。服务器可以把自己记录的 B 条目的“小钥匙密文”冒充成 A 条目的发给手机；手机若只用总钥匙解密、不核对 AAD，就会把 B 的钥匙加密给服务器，服务器随后可解 B 的密码，而用户以为自己只批准了 A。现有 `payload-protector.ts` 的 AAD 已经包含 `ownerId/agentId/ref/classification/contentType`（`:86-103`），说明仓库知道这个模式；方案引用它却没有把这个性质的客户端版本写出来。

**建议**：客户端用 AES-256-GCM，AAD 至少包含 `schemaVersion + ownerId + itemId + fieldId + itemVersion`；服务器不能替换条目/字段/版本。列出每个值的产生端和消费端，过 `check:vault-contract`（I-73）。同时给签名元数据加单调版本/计数器，防止服务器回放旧版“允许网站”更宽的签名。

### 9. 严重度中：Apple 凭据导入不是“调一个 ASCredentialImportManager 就有”，需要凭据提供者扩展

**问题**：方案说 iOS 26 苹果“密码”App 的“导出到其他 App”选 Himawari（`plan-v4.md:39`）。Apple 文档要求 App 参与凭据交换必须在其 credential provider extension 的 Info.plist 里声明 `SupportsCredentialExchange` 和 `SupportedCredentialExchangeVersions`，并注册 `ASCredentialExchangeActivityType`；导出方调用 `exportCredentials(_:)` 后系统才显示目标 App（https://developer.apple.com/documentation/authenticationservices/ascredentialimportmanager）。方案只引用了类名，没提扩展、entitlement、活动类型。论坛报告“第三方 App 不出现在列表”很可能就是这个原因，方案自己也标了“未核实”。如果导入不可用，“一次导入、没有门槛”的前提就不成立。

**建议**：把“凭据提供者扩展 + capability + activity type + 真机验收”列为前置条件；不能用导入时，明确回退到“用到才问/手动加”，不要把它当已成立。

### 10. 严重度中：`payload-protector.ts` 不能直接当手机端加密复用

**问题**：方案把 `packages/platform-node/src/payload-protector.ts:16,183` 当作“已有信封加密”（`plan-v4.md:79`）。但该类的 `#wrapDek` 用服务器 `HostSecretMaterialSource` 解析 KEK（`:321-330,351-363`），总钥匙在手机上时服务器没有这个 KEK，不能按原样使用。可以用它做服务器侧的二次静态加密，但它不是“手机主密钥加密”的实现。

**建议**：明确分成两层：手机端 AES-GCM（CryptoKit）+ 服务器端可选的信封加密；两者算法/版本/AAD 分开写，别让读者以为已有代码直接可用。

### 11. 严重度中：若干一手来源被误读，方案里的对比会误导决策

- **Meta Muse**：官方文章说“code in the runtime cell or a worker only ever sees a ‘surrogate’ token”“Sentinel … layer 4 and layer 7: hostname, resolved and final destination IP, port, protocol, HTTP method, path, and the actual decoded request”，浏览器子代理“sees an accessibility tree snapshot of the page — not the raw DOM”“while secure credential storage is filling a form, the agent is paused”（https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse）。方案只学了“换真值”，没学 L4/L7 策略、SSRF、DOM 隔离、暂停；而且“钥匙在 Meta 手里”与官方“credentials … stored in your VM, not in centralized Meta infrastructure”不完全一致。
- **Claude 托管 agent**：Anthropic 说“GitHub credentials are stored encrypted on Anthropic's servers and never enter the session VM. The VM holds a short-lived credential scoped to that session”（https://code.claude.com/docs/en/security/）；Managed Agents vaults 用 `allowed_hosts` + `injection_location`（header/body）在出口替换占位符（https://platform.claude.com/docs/en/managed-agents/vaults）。方案写“长期放行，只管 API”（`plan-v4.md:66`）不准确。
- **1Password**：见上，方案“少一处风险”低估了本机浏览器/本机钥匙的差别。
- **Docker 沙箱**：方案没有给一手来源，未核实；不要把三家混成“同一做法”。

**建议**：逐条改成可核对的原话，删掉没有一手来源的“同一做法”，把“Meta 有、我们没有”的 L4/L7、SSRF、DOM 隔离、暂停、taint 之类明确列为待补。

### 12. 严重度中：Prompt 前缀没有明确设计，可能改变已发请求开头

**问题**：方案要新增“列出保险箱”等工具；工具定义变了会触发按对话换新（`prompt-prefix.md:42-45`）。方案没有说“所有保险箱工具一次加齐、之后冻结”，也没有说列表输出必须**排序固定、无时间/用量/次数**、只作为末尾工具结果追加。v3 写了“排序固定，不含值和时间”（`plan-v3.md:24`），v4 删掉了。若条目名字/允许网站被放进系统提示，用户编辑条目就会改老对话的开头。遮盖方面：若把保险箱真值加入出口遮盖集合，新增/轮换一个密码会让旧历史里同一段文字的遮法变化；`prompt-prefix.md:81` 已把“遮盖密钥轮换”列为缓存失效原因，规则 11 要求遮盖只取决于它自己和前面内容（`:53-56`）。方案没有冻结“每个对话的遮盖值集合”，旧的密码在轮换后可能不再被识别，甚至明文发给模型。

**建议**：工具一次加齐并冻结；列表只放在末尾工具结果，顺序固定，不带时间/用量；条目编辑只追加新结果，不改旧消息；为保险箱值建立**按对话冻结的遮盖集合**，轮换后旧历史仍按旧集合遮，或把已遮结果作为已发内容保存；在 `check:prompt-prefix` 加反向用例。

### 13. 严重度低：前提 1 依赖未合入、未读原文的 ADR 0285

**问题**：方案自己写“ADR 0285 决定 7（分支 … 未合入 main，未核对原文）”（`plan-v4.md:73`）。仓库当前没有 `docs/adr/0285*`。用未读原文的未合入决定作为“必答规则”的前提，不满足仓库对证据的要求。

**建议**：先读原文/合入后再作为前提；否则把这条标成“待确认”，不要用它决定批准粒度。

---

## 推测/未核实的

1. **同步 + 每次生物识别能否同时成立**：Apple 文档明确 `ThisDeviceOnly` 不能同步，Face ID 示例又用 `ThisDeviceOnly` 并说不能进 iCloud Keychain；但 `kSecAttrSynchronizable` + `kSecAttrAccessControl`（`.userPresence`）是否被支持，文档没有直接给结论。需要真机原型；未核实。
2. **`authenticationRequired` 在 Apple Watch / 已解锁设备 / 无 Face ID 设备上的具体行为**：文档只说解锁；是否弹 Face ID、是否可用密码、Watch 上能否批准，未核实。
3. **ASCredentialImportManager 的第三方 App 列表问题**：论坛报告未读全文；需要真机 + 扩展配置验证。
4. **iCloud 钥匙串恢复路径**：Apple 文档说 2FA 账户用 device passcode 恢复 escrow，并需要已登记手机号收 SMS（https://support.apple.com/guide/security/secure-icloud-keychain-recovery-secdeb202947/web）。这与方案“苹果要求用你已有设备的锁屏密码才能加入同步”（`plan-v4.md:57`）不是同一条路径；具体攻击组合需要按账户设置核实。
5. **Stagehand/Playwright 行为**：版本、iframe/Shadow DOM 穿透、截图/可访问性树是否暴露 input value，未在仓库中核实；方案引用 v3 的来源，但 v4 没有重新核对。
6. **Meta Sentinel 的公开绕过研究**：搜索结果提到 NebuSec/CSA 有绕过分析，我没有读到原文；不能作为定论，但说明“有 Sentinel 就安全”不成立，应做红队。
7. **多租户隔离**：仓库看起来是单 owner/多 job；如果生产上多个 owner 共用出口守门/保险箱服务，方案没有写按 owner/job 隔离。是否多租户未核实。
8. **“生产机无 swap、关核心转储”**：这是部署配置，不在仓库代码里；即使做了，Node/Chromium 的堆、页面 JS、IndexedDB、localStorage、崩溃报告仍可能留明文，未核实。

---

## 如果由我来定，我会怎样改这份方案

我不会按 v4 的“所有密码都在服务器浏览器里填、钥匙在手机”直接实施。我会把它拆成三条路，按风险选择：

1. **高价值账户（银行、邮箱、支付）**：优先 Passkey/OAuth；没有就用 1Password 式**本机浏览器/本机扩展填充**，服务器只编排，密码不经过服务器。这样“服务器被攻破”不会在批准时泄露密码。
2. **API key / 沙箱程序**：保留出口替身方案，但做成真正的、按 job 隔离的 TLS 终止代理：上游证书校验/固定、`host + method + path + header/body 注入位置`白名单、禁止 URL/query、随机 HMAC 替身、响应遮真值、大小/时间/并发限制、绝不记录 body、fail closed；替换现有 `injectProgramSecrets` 的真值注入。
3. **必须服务器填表的低风险账户**：才走 v4，但必须补齐：
   - 每设备 Secure Enclave 包装的主密钥；iCloud 只存包好的备份或明确接受“同步即多设备可解”；`.biometryCurrentSet/.userPresence` 强制；设备撤销、主密钥轮换、全量重加密、恢复码。
   - 客户端 AES-GCM，AAD 绑定 owner/条目/字段/版本；条目钥匙用 HKDF 派生或至少 AAD 绑定；签名元数据带版本/计数器，手机缓存最新版，拒绝回滚。
   - 服务端一次性 nonce + 短 TTL；签名覆盖 nonce、条目、精确 origin、方法、preparedActionHash/pageVersion、临时公钥、密文摘要；`.confirm` 的 SE 签名；通知通用文案；不可信文本纯文本展示。
   - 浏览器 broker 在沙箱外，agent 只看 accessibility tree、不看 DOM/不能执行 JS、填表和提交时完全暂停；prepare/execute 用现有 `pageVersion/finalUrl` 重新核对；精确 origin + 表单 action；只用 POST；填→提交→验证→清理原子完成；失败关闭页面；禁用截图/trace/video/自动填充。
   - 恢复并扩展 v3 的 `check:vault-canary`、`check:vault-contract`，新增 `check:vault-approval`、`check:vault-egress`、`check:vault-recovery`，并接进 `npm run check`；每条都要有“去掉修复后必须失败”的反向用例。
   - 读 ADR 0285 原文；修正 Meta/Claude/1Password 比较；把“服务器被攻破平时无”“网页钓鱼无”改成条件式剩余风险。

---

## 逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**按 v4 目前的写法：不能保证，需要补设计。**
- 新增保险箱工具会改变工具定义；按 `prompt-prefix.md:42-45`，工具集合变了要按对话换新一次，老对话的请求开头会变一次。必须“所有保险箱工具一次加齐、之后冻结”，并保留换新记录。
- “她列出保险箱”（`plan-v4.md:24`）应当只作为**末尾工具结果**追加；条目名字/允许网站不能放进系统提示或更早的历史。v4 没有写这一点；v3 写了排序固定、不含时间（`plan-v3.md:24`），v4 丢了。
- 每轮会变的值（当前网站、批准状态、这次用了哪一项、页面版本）必须只在最后一条消息/工具结果；不能进系统提示、工具定义或更早位置。
- 遮盖结果：如果保险箱真值进入出口遮盖集合，新增/轮换密码会改变旧历史同一段文字的遮法（`prompt-prefix.md:81`），不满足“已发内容不变”。必须按对话冻结遮盖集合，或把已遮结果当已发内容保存。
- 结论：**只有在补上“工具一次加齐并冻结、列表末尾追加且排序固定、不带时间/用量、遮盖集合按对话冻结”之后，才能说仍然只在末尾追加。**

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**会有风险，v4 没有排除。**
- 服务器数据库返回的“允许网站”列表如果没排序，顺序可能变；必须固定排序/规范化。
- 条目名字/允许网站被用户编辑后，如果每轮重新列在历史中间，同一段文字会变；只能追加新结果，不改旧消息。
- 使用时间、最近使用、次数、批准 id、nonce、临时公钥、签名如果进入模型可见内容，都会变；v4 说模型只看名字/网站，但需要明确禁止这些字段。
- 遮盖：密码轮换/条目删除会让旧历史里同一段文字的遮法变化，甚至旧的密码不再被识别；必须冻结遮盖集合。
- 客户端密文的随机 nonce 本身没问题（不进模型）；但不要把密文/签名/时间放进模型上下文。
- 结论：**按现状不满足字节确定性；补上规范化、固定排序、禁止时间字段、按对话冻结遮盖后才能满足。**

### 3. 改动有没有对应的自动检查？反向用例是否真的会失败？

**没有。** v4 全文没有自动检查；v3 的 `check:vault-canary`、`check:vault-contract`（`plan-v3.md:51-54`）被删掉，也没有任何反向用例。必须补：
- canary 全链路泄露扫描 + 反向注入；
- 每个新值两端契约检查 + 反向非法值；
- 批准重放/过期/错条目/错 origin/错设备/nonce 复用；
- 出口 host/method/path/注入位置/重定向/DNS rebinding/大小限制；
- prompt prefix 的列表顺序/时间字段/工具冻结/遮盖轮换；
- 丢手机/撤销设备/主密钥轮换/旧设备失效；
- iOS 真机：同步、Face ID、导入扩展、通知行为。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**v4 没有逐个列出，且已发现至少四处两端不一致：**
- **总钥匙/钥匙串**：产生端（新钥匙串项）与消费端（iCloud 同步、Face ID、App 读）不一致：现有 `KeychainValueStore` 是 `ThisDeviceOnly`、无 `Synchronizable`、无 ACL（`KeychainValueStore.swift:44-58`）。
- **条目钥匙密文**：方案没有写 AAD 绑定条目 id/字段/版本（`plan-v4.md:17`）；服务器可替换密文，手机可能把 B 的钥匙当成 A 释放。
- **允许网站/origin**：用户/导入产生“网站”，消费端有手机核对、服务器浏览器核对、`web-capability-service` 的 `exactOrigin`（`web-capability-service.ts:137-139,250-252`）；方案没有规定用精确 origin（scheme+host+port）还是可注册域，也没有说端口/大小写/尾点归一化。用可注册域会让 `evil.bank.com` 被当成 `bank.com`。
- **设备签名钥匙**：产生端 `SecureEnclaveKeys.swift:75` 只有 `.confirm` 有 `.userPresence`；消费端方案要求“证明主人批准”，如果用的是 `.device` 就不满足。
- **临时公钥/nonce/签名**：产生端服务器/手机，消费端验签、重放表；方案没有说 nonce 落库、一次性消费、签名覆盖公钥/密文。
- **替身 token**：产生端出口守门，消费端沙箱程序；方案示例 `HIMAWARI_SURROGATE_xxx` 可猜，且没有说 HMAC/随机、映射、注入位置。
- **出口策略**：产生端用户/条目，消费端代理；现有代理只认 `host:port`（`network-egress.ts:63,149-154`），不接受 method/path/字段，方案的新值没有对应的消费端实现。
- **导入的 URL**：产生端 Apple Passwords，消费端允许网站；需要规范化并逐个真机验收。

结论：**不满足 I-73；必须先列“新值清单”，给每个值写产生端、消费端、校验规则和反向用例，再动工。**
