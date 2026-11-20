## 复核范围

对比了 `b28d50fc..5aa7daee` 的增量，并按材料重点核对了 5 个冲突文件及它们直接相连的使用端；另外抽查了合入 main 后与 batch8 相邻的 `production-http-composition.ts`、`PerceptionServiceOptions/PerceptionStorePort`、`searchAsk` 配置，以及 `DeviceAPIError` 的所有解构点。没有运行 tsc、测试或 Swift 编译（本轮工具只能读代码和用 git 查看），所以作者说的“tsc 通过、1354 条通过、Mac 编译通过”均未核实。

另需指出：增量并不只是“5 个冲突文件”。`b28d50..5aa7` 还带入了 main 的 PR 503/526/530/532 等代码，包括新增迁移 `packages/persistence-sqlite/src/migrations/20261114175847_perception_search_index_state.sql`。所以“不改数据库表”只在 PR 484 自身改动范围内成立，按整个分支 diff 看并不成立。

## 意见

### 1（低）新增的 5 个图标不在 icons.json 里，按文档重跑 make-icons 会把它们删掉

文件：`clients/apple/Sources/HimawariDesign/Icon.swift:11,30,32,67,80`；`clients/apple/scripts/icons.json`；`clients/apple/scripts/make-icons.mjs:12-15,43`；使用端 `clients/apple/Sources/HimawariManage/SettingsRootView.swift:56,59`。

问题：本次合并把 main 的 `bolt`、`device-laptop`、`device-watch`、`qrcode-off`、`upload` 五个 `IconName` 和对应 imageset 带进了本分支，但 `icons.json` 的清单里没有这五项。`make-icons.mjs` 会先 `rmSync` 整个 `Icons.xcassets`，再只按 `icons.json` 的键重新生成；一旦有人按 `clients/apple/README.md` 的说明运行该脚本，这五个图标资产会被删掉，`Icon(.bolt)`、`Icon(.upload)` 等会变成缺图。当前资产还在，所以不是立即崩，但清单与代码已不一致。

证据：
- `Icon.swift:11` `case bolt`，`:30` `case deviceLaptop = "device-laptop"`，`:32` `case deviceWatch = "device-watch"`，`:67` `case qrcodeOff = "qrcode-off"`，`:80` `case upload`。
- `icons.json:9-10` 是 `"bell"` 直接接 `"brand-safari"`，没有 `bolt`；`:29-32` 是 `device-mobile` 直接接 `download`，没有 `device-laptop`/`device-watch`；`:65-67` 是 `point` 接 `puzzle`，没有 `qrcode-off`；`:78-79` 是 `trash` 接 `user`，没有 `upload`。
- `make-icons.mjs:12-15`：
  ```js
  const icons = JSON.parse(readFileSync(new URL("./icons.json", import.meta.url), "utf8"));
  const catalog = join(resourcesDir, "Icons.xcassets");
  rmSync(catalog, { recursive: true, force: true });
  mkdirSync(catalog, { recursive: true });
  ```
  `:43` `for (const [key, spec] of Object.entries(icons)) {`。
- `SettingsRootView.swift:56` 使用 `SettingsRow(icon: .bolt, ...)`，`:59` 使用 `SettingsRow(icon: .upload, ...)`，说明这些图标不是死代码。

建议：把五项补进 `icons.json`（`"bolt": 1.6`、`"device-laptop": 1.6`、`"device-watch": 1.6`、`"qrcode-off": 1.6`、`"upload": 1.6`，或按实际需要标成 `custom`），并在 `check-design` 里加一条检查：`IconName.allCases` 的 rawValue 必须都能在 `icons.json` 或 imageset 目录中找到。该缺口来自 main 的图标改动，不是本轮 5 个冲突文件的取舍，但合并后本分支同样会中招。

## 读代码证实的

- `DeviceAPIClient.swift` 的冲突结果就是 main 的版本：`ErrorBody.Inner` 同时有 `reasonCode` 和 `reason`，`check` 里用 `reason: body?.reason ?? body?.reasonCode`（`DeviceAPIClient.swift:229-240`）；只有一份 `reason`，没有重复属性。
- `Icon.swift` 两边都保留：batch8 的 `clock`、`earLarge`、`playerPause`、`point`、`shieldLock` 和 main 的 `bolt`、`deviceLaptop`、`deviceWatch`、`qrcodeOff`、`upload` 都在；对应 imageset 文件也都存在。
- `face-id.svg` 确实取了 main 的版本，和 batch8 版本只差文件末尾换行，无内容损失。
- `DemoScenes.swift` 两边都保留：`import HimawariListenUI` 和 `import HimawariManage` 都在；`DemoScene` 同时有收听场景和 manage 场景；`other` switch 覆盖了全部 `DemoScene` case，没有重复或遗漏。
- `ManageDemoScreen` 的 rawValue 与 `DemoScene` 中对应 case 的 rawValue 完全一致（`ManageDemo.swift:7-23` 对 `DemoScenes.swift:14-28`）。
- `RootView.swift` 保留了 main 的 `settingsOpen` 无默认值、`settings != nil` 初始化、`settingsOverride`、`memoryOverride`、`OpenThread.draft`，也保留了 batch8 的 `listening`/`listenOpen`、`ListenOverlay`、`ListenEntrySheet`、`onAppear` 创建 `ListeningController`。`OpenThread(threadId:draft:)` 与 `ChatView(store:threadId:draft:close:)` 签名匹配；`SettingsRootView(api:confirmKey:close:removedThisDevice:)` 和 `MemoryRootView(api:confirmKey:talk:)` 的签名也匹配。
- `MainTabsView` 新增的 `memory:`/`settings:` 参数只在 `DemoScenes.manage` 使用，调用处类型和参数顺序正确；`TodayView(listening:openListening:openSettings:)` 的 memberwise 初始化与唯一调用点一致。
- `Package.swift` 合并后同时保留了 batch8 的 `HimawariListen`/`HimawariListenUI`/`HimawariListenEngine`/`ListenEval` 和 main 的 `HimawariManageTests`，没有重复 testTarget。
- `production-http-composition.ts` 中 batch8 的 `voiceAddressee`/`utterancePrefetch` 仍在；main 新增的 `readPerceptionText` 只有一个定义，`searchIndex` 新字段的两个构造点（`production-http-composition.ts:1444`、`test/fixtures/device-api-harness.ts:401`）都已同步。
- `PerceptionStorePort` 新增的 `listStaleSearchRecords`/`replaceSearchTerms` 在 sqlite 和 durable adapter 都有实现；`searchAsk` 新增的 `indexTermLimit`/`indexRebuildBatch` 在默认值、严格解析、生产组装和测试之间一致。
- `DeviceAPIError.server` 改成 4 个关联值后，所有解构点都用了 4 个模式：`DeviceTransport.swift:48`、`SpokenCommand.swift:124`、`PairingDecisions.swift:24,55`、`PairingRecord.swift:36`、`Handover.swift:405,423`、`Outbox.swift:130`、`MenuBarModel.swift:131` 等；没有遗留 3 个模式的调用。
- 仓库中没有残留冲突标记（`<<<<<<<`/`=======`/`>>>>>>>`）。

## 推测 / 未核实

- `DemoScenes.manage` 现在用 `MainTabsView` 渲染 manage 屏，会触发 `RootView.swift:148-151` 的 `.onAppear` 创建 `ListeningController`；该控制器初始化会读取 voiceprint 文件、在 iOS 上安装通知代理并设置全局 `ListenCommandCenter` handler。Demo 截图环境是否会因此出现额外收听卡片或通知副作用，Linux 上无法验证，建议 Mac 线程顺带看一眼。这是合并后才出现的组合，但不是明确的错误。
- 作者说的“Mac 线程另外编译通过”“60 个测试文件 1354 条通过”“9 条 Jev 集成测试”均未在本环境运行，未核实。

## 侧重检查

- 错误路径：`SpokenCommand` 只接受服务端 `reason` 能映射到 `SpokenCommandRefusal` 的 409；未知 reason 会继续抛错，不会静默执行（`SpokenCommand.swift:122-130`）。addressee 判断的超时、异常、模型不匹配、非法概率都返回 `null`，最终落到 `addressed_unsure`（`voice-addressee.ts:149-158,129-132`）。
- 不可信输入：`heardName` 做过控制字符/格式字符过滤和长度截断（`SpokenCommand.swift:23,31,35-43`）；发给 Jev 的文本先过 `redactForExternalText`（`voice-addressee-decision.ts:54,67-68`）；服务端返回的 `reason` 只用于枚举匹配，不拼接执行。
- 安全：`/v1/decisions` 请求强制 `zeroDataRetention: true`（`voice-addressee-decision.ts:74`）；响应体有 64 KiB 上限（`:113-130`）；本增量没有新增日志输出或把密钥写入 URL 的路径。
- 资源耗尽：addressee 有 1.5 秒超时、每设备每分钟 20 次、每设备 64 条缓存，缓存过期会清理，失败/预算不足的条目会删除（`voice-addressee.ts:103-132,161-182`）；本增量没有新增无界集合。
- 不可撤销操作：`removedThisDevice` 只在“移除本机”明确操作后调用（`Settings/DevicePages.swift:122`），不是由任意错误自动触发；`RootView.swift:129-132` 只把它接到 settings 的回调。
- 规则/文档一致性：本增量没有改动提示词目录或 `prompt-prefix.md`；`voiceAddressee` 配置键在 `VoiceAddresseeConfiguration`、`VOICE_ADDRESSEE_DEFAULTS`、`VOICE_ADDRESSEE_RANGES` 与 `parseVoiceAddressee` 之间一致（`strict-configuration.ts:1574-1602`）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本增量不涉及：没有改会话系统提示、工具定义、历史存储或出口遮盖；`DeviceAPIClient` 只改错误解码，Apple UI 文件与模型请求无关，`production-http-composition.ts` 的增量来自 main 的感知搜索索引。PR 484 的 addressee 判断是独立的 `/v1/decisions` 调用，`voiceAddresseeRequestBody` 先放固定的 `questions`，再把本次 `heardName`/`heardSentence` 放在该请求的 `input` 里（`voice-addressee-decision.ts:55-74`），不写回主对话历史。因此主对话仍是“只在末尾追加”，每轮变化值不进入前缀。依据 `prompt-prefix.md#rules` 第 4 条。
2. **会不会让同一段文字在不同请求里变成不同的字节？** 本增量没有引入依赖前后文的遮盖、时间字段或无序集合。addressee 请求每次新建 `known: new Map()` 和顺序占位符，输入相同则请求体相同；`production-http-composition.ts` 新增的 `version` 由 `projectionVersion`、固定常量和配置值组成，`perceptionSearchEvidenceText` 按固定规则表顺序拼接，不依赖对象遍历或数据库返回顺序。未发现本增量造成的不确定字节。
3. **有没有自动检查，反向用例会失败吗？** 有。`DeviceHTTPClientTests.swift:161-168` 的 `serverReasonCodeIsKeptWithTheErrorCode` 会在 `reasonCode` 不再被解码时失败；`ListeningTests.swift:63-83` 会分别在 `reason` 字段丢失或 refusal 映射丢失时失败。`DeviceAPIError` 的 4 值解构若不同步，相关 Swift 编译会失败。5 个冲突文件的 UI 组合没有 Linux 自动测试，Mac 编译声明未核实；`IconName` 与 `icons.json` 之间也没有自动检查，这正是上面第 1 条能长期漏掉的原因。
4. **每个值的使用端都能接受吗？** 已逐个核对：`DeviceAPIClient.ErrorBody.reasonCode/reason` → `DeviceAPIError.server` 第 4 个值 → `DeviceTransport`/`SpokenCommand`/`PairingDecisions` 等所有解构点均按 4 值处理，`DeviceTransport` 还把第 4 值重新写成 `reasonCode` 给 `ManageGateway`；`IconName` 新 case → `Icon` 按 rawValue 取 imageset，资产存在，但 `icons.json` 缺 5 项（见意见 1）；`ManageDemoScreen` rawValue → `DemoScene` 匹配；`MainTabsView` 新参数 → `DemoScenes` 调用匹配；`OpenThread.draft` → `ChatView` 初始化匹配；`AppModel.confirmKey` → `SettingsRootView`/`MemoryRootView` 类型匹配；`removedThisDevice` → `DevicePage` 回调匹配；main 新增的 `PerceptionServiceOptions.searchIndex` 必填字段、`PerceptionStorePort` 新方法、`searchAsk` 新配置键都有对应生产组装和测试实现同步更新。未发现无法接受的使用端，唯一清单缺口是 `icons.json`。
