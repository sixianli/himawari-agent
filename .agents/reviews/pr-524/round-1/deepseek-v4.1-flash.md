已对照 `e71227d..496fe71` 逐项核对。改动全部在 Apple 客户端、测试和 README 内，没有改服务端或提示词组装。下面按严重度排列，并区分读代码证实与推测。

### 1、中、免费签名下 App 里的分享开关对扩展无效，README/PR 的说法与代码相反

- 文件：`clients/apple/Sources/HimawariShare/EntryViews.swift:20-22,170,202`、`clients/apple/Sources/HimawariShell/RootView.swift:41`、`clients/apple/Sources/HimawariShare/ExtensionSupport.swift:99-104`、`clients/apple/Sources/HimawariCore/SharedVault.swift:58-63`、`clients/apple/Sources/HimawariCore/Handover.swift:476-479,516,542-544`、`clients/apple/README.md:41`
- 问题：README 说“扩展里‘开或关’的开关也只在扩展自己里记着”，但开关实际在 App 的设置页：`RootView.swift:41` 的 `HandoverEntryRoute` 只由 `HimawariShell`（App）渲染；扩展里没有这个开关。免费签名下扩展走 `SharedVault.handoverStore()` 的 `FileLocalStore.applicationSupport(...)` 分支，和 App 是两个容器。结果：
  - 在 App 关掉分享/Safari 开关，只写进 App 自己的 store，分享扩展和 Safari 扩展仍按 `HandoverSettings` 默认值 `shareOn = true`、`safariOn = true` 运行，用户以为关掉了，实际没关。
  - Safari 扩展第一次发送时把 `safariUsedAt` 写进扩展自己的 store，App 里的 `state(.safari)` 仍看到 `nil`，App 会一直停在“还没设置好 Safari”的引导页。
- 证据：
  - `EntryViews.swift:20-22`：`self.init(store: try? SharedVault(bundle: bundle).handoverStore())`
  - `ExtensionSupport.swift:100-104`：`let vault = SharedVault(bundle: bundle)` … `queuesOffline: vault.sharesStorageWithApp`
  - `SharedVault.swift:58-63`：没有 `appGroup` 时 `return try FileLocalStore.applicationSupport(named: Self.handoverStoreName)`
  - `Handover.swift:476-479`：`public init(shareOn: Bool = true, safariOn: Bool = true, safariUsedAt: Date? = nil)`
  - `Handover.swift:516`：`if entry == .safari, safariUsedAt == nil { return .notSetUp }`
- 建议：把 `HandoverSettings` 放进免费签名也能用的共享钥匙串（PR 已声明钥匙串分组可用），这样两种签名下开关和 `safariUsedAt` 都能跨 App/扩展；如果坚持不共享，README 必须改成“App 里的开关在免费签名下不影响扩展，扩展按默认开启”，并单独说明 Safari 引导页不会前进。加一条免费签名路径的测试或用可注入的 store 覆盖这种分离。

### 2、中、`notSent` 把“结果未知”说成“没传上”，重分享会产生重复投递和孤儿附件

- 文件：`clients/apple/Sources/HimawariCore/Handover.swift:97-104,369-417,419-430,546-551`
- 问题：`queuesOffline == false` 时，任何 `courier.deliver` 返回 `.queued` 都被改成 `.failed(.notSent)`。但 `.queued` 不等于“肯定没发出去”：`HandoverCourier.deliver` 在 `uploadAttachment`、`createThread`、`send` 之后遇到 5xx/429/408、`invalidResponse`，或落到最后的通用 `catch`，都会返回 `.queued`。这时服务端可能已经提交，客户端却显示“没传上，稍后再分享一次”；用户按提示重新分享会生成新的 `Handover.newId()`，进而得到新的 `attachmentRequestId` / `threadRequestId` / `messageId`，原来的幂等重试路径没有被使用，可能出现重复消息、重复感知记录或已上传但无人引用的附件。
- 证据：
  - `Handover.swift:388`：`switch try await api.send(message)`
  - `Handover.swift:415`：`catch { return .queued }`
  - `Handover.swift:426`：`if status == 429 || status >= 500 || status == 408 { return .queued }`
  - `Handover.swift:548-550`：`if outcome == .queued { guard queuesOffline else { return .failed(.notSent) } ... }`
  - `Handover.swift:97-104`：`newId()` 以及 `recordId`、`threadRequestId`、`messageId` 都由这个 id 派生
- 推测/未核实：服务端是否会在发出 5xx/断连前先提交，取决于服务端实现，我没有读服务端提交顺序；但客户端无法区分“确定没发”和“可能已发”，这一点由上面的代码即可确认。
- 建议：把 `.queued` 拆成“在任何副作用之前确定没发”和“结果未知”两类；前者才显示 `notSent`，后者用“结果未知/可能已经传上”或保留原有队列重试，避免用“没传上”促使重复分享。若保留重分享，至少让重复的同一内容在短时间内复用同一 `id`，维持幂等。

### 3、中、新增的权限变体测试可能跑不起来，也没有逐配置、逐目标校验

- 文件：`test/tooling/apple-entitlement-variants.test.ts:5,7-11,17`、`package.json`（`"type": "module"`、`check:steps`）、`clients/apple/App/Himawari.xcodeproj/project.pbxproj:243-262,537-585`
- 问题：
  1. `__dirname` 在 ESM 测试里通常不存在；仓库其他 60 多处 tooling 测试都用 `fileURLToPath(import.meta.url)` 或 `import.meta.dirname`（如 `test/tooling/client-parity.test.ts:3,20`）。若 Vitest 不注入 `__dirname`，该文件在加载时就会 `ReferenceError`，测试根本跑不到断言。
  2. 作者的 `Fast-mode-checks: npm run check` 不会运行它：`npm run check` 只按 `check:steps` 跑固定脚本，tooling 测试由 `npm test` / CI 的 tests 阶段执行（`ci/policy.json:214` 确实包含 `test/tooling/**/*.test.ts`），所以“跑过 check”不等于跑过这个新测试。
  3. 测试把三个模板放进 `Set` 后只看模板是否存在、硬编码 `paths.length === 3`。如果某个目标的 Debug 配置回退成未带后缀的路径、而 Release 仍正确，去重后仍是 3 个模板，测试会漏报。项目里还有第四个会签名的 `HimawariMac` 目标（`project.pbxproj:243-262`，其配置在 `:537-585` 没有 `CODE_SIGN_ENTITLEMENTS`），所以测试名“every signed target”和硬编码 3 都与实际目标集合不一致，也违反作者“不写死数量”的约束。
- 证据：
  - `apple-entitlement-variants.test.ts:5`：`const app = path.resolve(__dirname, "../../clients/apple/App");`
  - `apple-entitlement-variants.test.ts:8-10`：`new Set([...project.matchAll(...)])`
  - `apple-entitlement-variants.test.ts:17`：`expect(paths.length).toBe(3);`
  - `project.pbxproj:243-262`：`HimawariMac` 是一个 `PBXNativeTarget`
- 推测/未核实：Vitest 是否给测试上下文注入 `__dirname` 未在本机核实；若注入了，第 1 点不成立，但第 2、3 点仍成立。
- 建议：改用 `fileURLToPath(import.meta.url)`；从 `PBXNativeTarget` 和 `XCConfigurationList` 逐个枚举每个目标的 Debug/Release 配置，断言每条 `CODE_SIGN_ENTITLEMENTS` 都带后缀且解析后的文件存在；不要硬编码 3，明确排除或单独断言没有 entitlements 的 Mac 目标；把这个测试接入 `npm run check` 的某一步，或在 CI 中确认执行。条件允许时再用 `xcodebuild -showBuildSettings` / 模拟器构建验证变量真的展开。

### 4、中、新代码没有被任何 Swift 编译覆盖：`swift test` 会跳过 `SharedVault` 和 `ExtensionSupport`，作者也未在 Mac/iOS 上编译

- 文件：`clients/apple/Sources/HimawariCore/SharedVault.swift:1,53-56`、`clients/apple/Sources/HimawariShare/ExtensionSupport.swift:1,104`、`clients/apple/App/SafariExtension/SafariExtension.keychain-only.entitlements:7`
- 问题：`SharedVault.swift` 整个文件在 `#if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)` 里，`ExtensionSupport.swift` 在 `#if canImport(UIKit)` 里。`swift test` 在 Mac/Linux 上不会编译这两个文件，所以新加的 `sharesStorageWithApp` 和它唯一的调用点 `queuesOffline: vault.sharesStorageWithApp` 从未被类型检查；作者又明确说 Mac 上尚未编译。免费账号能否签含自定义 `keychain-access-groups` 的 entitlements 也未在仓库内验证——如果免费 Personal Team 同样不允许这个能力，这个 PR 仍然装不上，目标落空。
- 证据：
  - `SharedVault.swift:1`：`#if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)`
  - `ExtensionSupport.swift:1`：`#if canImport(UIKit)`
  - `ExtensionSupport.swift:104`：`queuesOffline: vault.sharesStorageWithApp`
  - 新权限文件 `SafariExtension.keychain-only.entitlements:7`：`<string>$(AppIdentifierPrefix)$(HIMAWARI_KEYCHAIN_GROUP)</string>`
- 推测/未核实：Apple 免费账号对自定义 `keychain-access-groups` 的支持情况是外部事实，仓库内没有证据；我没有联网核实。
- 建议：用免费 Apple ID 在真实 Xcode 工程上对三个 iOS 目标做一次模拟器/真机构建并安装，至少跑一次 `xcodebuild`；把这次构建纳入可重复的验证记录。若钥匙串分组也不被免费账号接受，需要重新考虑配对凭据的传输方式或明确要求付费账号，而不是只去掉 App Group。

## 侧重检查

- 错误路径：`api.configuration()` 失败、`uploadAttachment`/`createThread`/`send` 失败、`invalidResponse`、通用 `catch` 都会变成 `.queued`，在免费签名下统一变 `.notSent`；这正是第 2 条风险。`queue.add` 失败仍返回 `.failed(.rejected)`，未变。
- 不合规范或不可信输入：`HandoverContent.page(from:)` 仍只接受 `http`/`https`（`Handover.swift:60-66`），本次未改；`HIMAWARI_ENTITLEMENTS_SUFFIX` 是开发者本机构建设置，不是远端输入；`SharedVault.setting` 对空值和未展开的 `$(` 都返回 `nil`，能防住 Info.plist 未替换的情况（`SharedVault.swift:26-30`）。
- 安全与隐私：改动移除了 App Group，缩小了跨 App 数据面，这是正向的；但第 1 条导致免费签名下 App 的关闭开关被静默忽略，属于用户预期与隐私控制不一致。没有新增密钥、团队号或网络出口。
- 资源耗尽：`notSent` 在附件已上传、线程/消息可能已创建后立即丢弃本地状态，重分享会再传一次，可能留下孤儿附件并放大服务端存储；原有队列本身没有条数上限，但那是既有问题。
- 不可撤销操作：`notSent` 不删除服务端数据，但会让用户以为没发而重复操作；权限文件选择只是本机构建参数，可逆。
- 规则文件、说明文档与代码一致性：README 的“扩展开关”说法与代码相反（第 1 条）；测试标题“every signed target”与项目里实际存在的 `HimawariMac` 目标不一致（第 3 条）；“不写死数量”被测试里的 `3` 和 `2` 违反。作者其余说法——不写注释、未动模型请求、默认构建仍用完整权限、未改配对钥匙串、`notSent` 文案不说“稍后在 App 重试”——均与代码一致。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只涉及 `clients/apple/**`、`test/tooling/**` 和 README，没有改提示词目录、Pi 运行时、消息序列化或服务端请求组装；`Handover`、`PerceptionRecordUpload` 的字段和 id 生成也没有改。因此发给模型的内容仍然只在末尾追加，每轮会变的值仍然不在请求开头。唯一的行为差别是免费签名下某些内容可能完全不再投递（用户需重新分享），这是“有没有这条数据”的差别，不是已发请求开头字节的变化。

2. **不会让同一段文字在不同请求里变成不同字节。** 新值只有固定的枚举字符串 `notSent`、运行时布尔 `queuesOffline`/`sharesStorageWithApp` 和三种语言的固定 UI 文案；没有新增时间字段、无序集合或依赖前后文的遮盖。`createdAt`、`safariUsedAt` 是既有逻辑，本次未改，且不进入模型请求。

3. **有自动检查，但覆盖不完整，反向用例也不都可靠。** 正向：`HandoverTests.swift:257-265` 覆盖 `queuesOffline: false` 返回 `.failed(.notSent)`、不排队；`safari-panel.test.ts:87-93` 覆盖面板显示该文案；`apple-entitlement-variants.test.ts` 覆盖权限文件内容。反向：既有 `HandoverTests.swift:236-255` 保证默认路径仍返回 `.queued` 并留在队列里。问题在第 3、4 条：权限测试可能因 `__dirname` 跑不起来、不在 `npm run check` 里、按模板去重会漏掉单个配置回退、还硬编码数量；`SharedVault`/`ExtensionSupport` 没有被 `swift test` 编译，也没有真实 Xcode 构建验证。

4. **逐个核对产生处和使用处：**
   - `HIMAWARI_ENTITLEMENTS_SUFFIX`：产生于 `project.pbxproj:459,476`（两个工程级配置，默认 `""`）；使用于 `:496,521,590,616,642,668` 六条 `CODE_SIGN_ENTITLEMENTS`。三种模板分别解析到 `iOS/Himawari*.entitlements`、`ShareExtension/ShareExtension*.entitlements`、`SafariExtension/SafariExtension*.entitlements`，三个 `.keychain-only` 新文件都存在。默认空串仍指向原文件，付费构建不变。
   - `notSent`：产生于 `Handover.swift:549`；使用于 `HandoverSheet.swift:147` 的 `L.text("outcome.\(problem.rawValue)")`，三种语言的 `Localizable.strings:26` 都有 `outcome.notSent`；`keepsWhatWasRead` 对 `.failed` 返回 `false`，Safari 的 `SafariBridge` 通过 `phase.line` 取同一文案。两端能对上。
   - `queuesOffline`：产生于 `ExtensionSupport.swift:104`（两个扩展都经过 `HandoverExtension.desk`），使用于 `Handover.swift:549`；默认值 `true` 让其他调用方保持旧行为。能对上。
   - `sharesStorageWithApp`：产生于 `SharedVault.swift:53-56`，只有 `ExtensionSupport.swift:104` 一个使用点；返回 `false` 时 `handoverStore()` 也走本地目录（`SharedVault.swift:58-63`），两端语义一致。唯一不足是它只检查“本进程能否打开容器”，并不证明 App 也打开了同一个容器；默认同工程设置下没问题。
   - 新增 Safari 场景 `22-gaps-2j-safari-not-sent`：定义于 `safari-panel-review.mjs:60-64`，使用于 `safari-panel.test.ts:88`；场景注入的 `kept: false` 与真实 `.failed(.notSent)` 的 `keepsWhatWasRead == false` 一致。
   - README 的“扩展开关”说法是唯一明确对不上的使用方，见第 1 条；测试的硬编码数量和“every signed target”说法见第 3 条。
