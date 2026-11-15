## 查过的范围

- 对比：`git diff 239ecdc0..873c6e7c`（本轮增量）、`git diff 5834935d..873c6e7c`（PR 相对 main 的净改动）。
- 逐条读了增量实际改到的文件：`HomeFeed.swift`、`MenuBarFeed.swift`、`DeviceHomeSource.swift`、`HomeFeedModel.swift`、`MenuBarModel.swift`、`AppModel.swift`、`Package.swift`、`TodayHeader.swift`、`Brand.xcassets`、`Icons.xcassets`、`icons.json`、`README.md`、`ui-review`、`make-icons.mjs`、`ui-review.sh`、图标一致性测试。
- 顺着值的两端读了服务端：`packages/platform-node/src/device-api-routes.ts` 的 `/home/act`、`MACHINE_STRING`、replay key，以及 `OutgoingMessage.newId()`。
- 相关检查/规则：`HomeFeedTests`、`HomeFeedModelTests`、`HomeActPresenceTests`、`MacInputTests`、`test/tooling/apple-icon-consistency.test.mjs`、`scripts/check-design.mjs`、ADR 0276、I-73。
- 未做/未核实：没有运行任何测试或构建；`.agents/instructions/prompt-prefix.md` 当前工作树未检出，只能按代码核对；没有重读 main 带进来的整个手表功能。

---

### 1 低 第 3 轮意见 2 没有改：`reset()` 仍挡不住在途请求把旧服务器快照写回，也仍没清 `DeviceHomeSource` 的请求编号缓存

**文件**：`clients/apple/Sources/HimawariShell/Today/HomeFeedModel.swift:61`、`:73`；`clients/apple/Sources/HimawariShell/Today/DeviceHomeSource.swift:8`、`:19`

**问题**：材料说第 3 轮意见已修改，但代码没有改。`reset()` 只清内存字段；`refresh()` 在 `await` 之后无条件写 `snapshot = next`；`DeviceHomeSource` 的 `requestIds` 仍是私有字典，没有任何清空入口。`git log 239ecdc..873c6e7c -- HomeFeedModel.swift` 无输出，`DeviceHomeSource` 相对 239ecdc 只换了第 21 行的请求编号生成函数。

**证据（读代码证实）**：

```swift
public func reset() {
    snapshot = nil
    settled = []
    busy = []
    toast = nil
    failed = false
}
...
let next = try await source.read(locale: locale)
snapshot = next
```

```swift
private var requestIds: [String: String] = [:]
...
let requestId = requestIds[key] ?? DeviceAPI.newActionRequestId()
```

**推测**：只有在 `reset()` 发生时恰好有一条 `refresh()`/`decide()` 在途，旧服务器的响应才会在 reset 后落回 `snapshot`；换服务器后如果新请求失败，旧服务器条目会继续显示。这是可复现的竞态，不是每次必现。

**建议**：给 `HomeFeedModel` 加代次 token（`await` 前记下，返回后不一致就丢弃结果），`reset()` 递增代次；给 `HomeFeedSource` 协议加 `reset()`，`DeviceHomeSource` 用它清 `requestIds`；`AppModel.emptyStore()` 同时调用两者；补一个 Mac 测试，让 `read` 在 reset 期间挂起再返回，断言旧快照不会写回。

---

### 2 低 第 3 轮意见 3 没有改：`choice` 仍逐条过滤 binding，正向无 binding、负向有 binding 时负向仍会变成主按钮

**文件**：`clients/apple/Sources/HimawariCore/HomeFeed.swift:166`、`:175`

**问题**：`choice` 仍是先按动作逐条过滤 `$0.binding != nil || approvalId != nil`，再从留下来的动作里挑正向/负向。若服务端给非审批条目一个无 binding 的正向动作和一个有 binding 的负向动作，正向被剔除，负向进入 `else if let negative` 分支，成为唯一 `confirm`。`git diff 239ecdc..873c6e7c -- HomeFeed.swift` 只有删除 `HomeRequestId` 的 6 行，这段逻辑没动。

**证据（读代码证实）**：

```swift
public var choice: HomeChoice? {
    HomeChoice(actions.filter { $0.binding != nil || approvalId != nil })
}
...
} else if let negative {
    confirm = negative
    decline = nil
}
```

**推测**：这要求一份不合规范/不可信的 home.read payload；正常服务端会给非审批动作都发 binding。因此是防御性问题，不是已知服务器行为。

**建议**：先判断整组动作是否可发送，再选主按钮；非审批条目若正向动作没有 binding，整个 `choice` 返回 `nil`（该条目按普通行显示），不要用负向动作顶替主按钮。补反向用例：正向无 binding、负向有 binding，断言 `choice == nil`（或至少 `confirm` 不是负向动作）。

---

### 3 低 `himawari` 字样搬到 `Brand.xcassets` 后没有自动检查守着新资源

**文件**：`test/tooling/apple-icon-consistency.test.mjs:27`；`clients/apple/scripts/make-icons.mjs:13`；`clients/apple/Sources/HimawariDesign/TodayHeader.swift:84`；`clients/apple/Package.swift:30`

**问题**：搬迁本身是对的：`make-icons.mjs` 只删除/重建 `Icons.xcassets`，`Brand.xcassets` 不会被清；`Package.swift` 的 `.process("Resources")` 会处理两个 catalog；`Image("wordmark", bundle: .module)` 按资源名查找。但现有的图标一致性测试只扫描 `Resources/Icons.xcassets/`，`Brand.xcassets` 完全不在检查范围内。

**证据（读代码证实）**：

```js
return readdirSync(new URL("Resources/Icons.xcassets/", design))
  .filter((entry) => entry.endsWith(".imageset"))
```

```js
const catalog = join(resourcesDir, "Icons.xcassets");
rmSync(catalog, { recursive: true, force: true });
```

```swift
Image("wordmark", bundle: .module)
```

**推测**：若以后 `Brand.xcassets` 被改名、漏提交，或 `.process` 配置变化，Swift 仍能编译，只在界面上显示空白；只有 Mac 截图能发现，Linux 的 `swift test` 和图标测试都不会失败。

**建议**：在 `apple-icon-consistency.test.mjs` 里加一条对 `Resources/Brand.xcassets/wordmark.imageset/wordmark.svg` 的存在性断言（或单独一个品牌资源测试），并断言 `make-icons.mjs` 不会触碰 `Brand.xcassets`。这样反向删除资源时测试会失败。

---

## 侧重检查

- **错误路径**：`DeviceHomeSource.act` 在成功、`OwnerPresenceError.declined`、4xx 时清请求编号，网络错误/5xx 保留编号用于同一次动作重试；这与服务端 `homeActReplays` 的按 `device.id + requestId` 去重一致。读代码确认，未见新错。
- **不合规范/不可信输入**：服务端 `/home/act` 要求 `requestId` 通过 `MACHINE_STRING`，`binding` 必须是字符串；`DeviceAPI.newActionRequestId()` 生成 `act_` + base64url，长度约 26，字符集符合。`HomeChoice` 对无 binding 动作的防御仍有第 2 条问题。
- **安全**：本次增量没有新增密钥、日志或网络出口；请求编号不是秘密，仅用于幂等。没有发现把新值写进日志或持久化的地方。
- **资源耗尽**：`DeviceHomeSource.requestIds` 只按“条目+动作+binding”增长，且成功/4xx 会删除；服务端 replay 表有上限（main 现有代码）。本轮没有新增无界集合。
- **不可撤销操作**：今天页仍只通过 `DeviceActionsModel.respond` 或 `HomeFeedSource.act` 触发设备动作；本轮只改请求编号和 `act` 的调用方式，没有改变审批/签名路径。请求编号重试复用反而保证了重试不会重复执行。
- **规则/文档一致性**：README 的 wordmark 路径已同步到 `Brand.xcassets`；`ui-review/latest` 确实从分支删除，脚本默认输出改到仓库外缓存。另发现 main 现有的 `clients/apple/ui-review/watch-latest/` 仍在版本控制中，`watch-ui-review.sh:5` 也写到仓库目录，与 ADR 0276 只点名 `latest/`、`mac-latest/` 的精神不一致；但这不是本轮增量引入的（`git diff 5834935d..HEAD -- clients/apple/ui-review` 为空），未计入意见。
- **模型请求开头**：本 PR 的净改动（`5834935d..HEAD`）没有任何 `packages/prompt-catalog`、系统提示、工具定义或消息历史改动；今天页只读写设备网关 `/home`，不参与模型请求构造。

---

## 作者说法核对

- “第 3 轮成立的意见 2、3 已修改”：**与代码不符**。`HomeFeedModel.swift` 自 239ecdc 没有任何提交；`HomeFeed.swift` 相对 239ecdc 只删了 `HomeRequestId`，`choice` 逻辑原样保留。第 4 轮补充列的改动里也没有这两项。
- “请求编号改用 `DeviceAPI.newActionRequestId()`（`act_` 前缀），删掉 `HomeRequestId`，Mac 菜单栏恢复主线版本”：**属实**。`HomeFeed.swift` 已无 `HomeRequestId`；`MenuBarModel.swift:125`、`DeviceHomeSource.swift:21` 都调用 `newActionRequestId()`；服务端 `MACHINE_STRING` 接受这种字符集。
- “`MenuBarFeed` 的 `act` 拆出按字段版本，原 `act(key:action:HomeAction…)` 委托给它，行为不变”：**属实**。`MenuBarFeed.swift:113-124` 的委托字段一一对应，`Body` 编码字段和改前一致。
- “himawari 字样从 `Icons.xcassets` 挪到 `Brand.xcassets`”：**属实**，文件是纯 rename，README 两处路径已更新；但新增目录缺少自动检查（见意见 3）。
- “`ui-review/latest` 按 ADR 0276 从分支删除”：**属实**；相对 main 没有净改动，说明 main 本身已不再跟踪 `latest/`。
- “Linux 上 `swift test` 293 个通过、check-design/format/lint 通过”：**未核实**，本轮不能运行命令，只做了静态核对。

---

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本 PR 的净改动没有系统提示、工具定义、历史消息或遮盖逻辑；`home.read`/`home/act` 是设备网关接口，`DeviceHomeSource` 和 `TodayPage` 不构造模型消息。发给模型的内容仍是只追加、每轮变化只落在最后一条消息——这一条本轮没有触及。规则文件 `.agents/instructions/prompt-prefix.md` 当前工作树未检出，原文未核实，但代码侧没有任何模型请求改动。239ecdc..HEAD 里出现的 `packages/prompt-catalog` 改动来自合并 main，已在 main 基线内，不属于 PR 489。

2. **不会让同一段模型输入变成不同字节。** 本增量唯一的新随机值是 `newActionRequestId()` 生成的请求编号，它是设备动作的幂等键，不进入模型上下文；同一次动作重试会复用同一个编号。`choice`、`shownActions`、`HomeLayout` 都基于有序数组过滤/取首项，不用 Set 或哈希顺序；没有新增带时间的序列化字段。`generatedAt` 是服务器 home payload，属于界面数据，不是模型输入。

3. **自动检查情况**：
   - 请求编号：`HomeFeedTests.swift:88-95` 用 2000 个样本校验长度、首字符和服务端字符集，改坏生成器会失败；但没有跨语言测试直接调用服务端 `MACHINE_STRING`，两端的规则是各自维护的。
   - `act` 拆分：`HomeActPresenceTests.swift:70-93` 只断言路径和签名，不断言请求体里的 `key/action/binding`；如果把字段传错，这些测试不会失败。本次靠读代码确认字段对应正确。
   - wordmark 迁移：图标测试只扫 `Icons.xcassets`，删掉 `Brand.xcassets` 或改 imageset 名字都不会让任何自动检查失败（见意见 3）。
   - 第 3 轮意见 2、3：没有反向用例。`HomeFeedModelTests` 没有“reset 时在途 read 返回旧快照”的用例；`HomeFeedTests` 没有“正向无 binding、负向有 binding”的用例，所以这两个问题即使存在也不会被现有测试抓住。
   - Linux `swift test`、check-design、format、lint：未核实，未运行。

4. **逐个值的使用端**：
   - `DeviceAPI.newActionRequestId()`：产生于 `MenuBarFeed.swift:99`，使用于 `MenuBarModel.swift:125`、`DeviceHomeSource.swift:21`、`WatchModel.swift:304`、`HomeFeedTests.swift:90`；服务端 `device-api-routes.ts:1498-1499` 用 `MACHINE_STRING`（`:165`）校验，`act_` 开头、允许的 `_`、长度都在范围内，使用端能接受。
   - 字段版 `act(key:action:binding:ownerPresence:requestId:presence:)`：产生于 `MenuBarFeed.swift:117`，使用于 `HomeFeed.swift:249`、`MenuBarFeed.swift:113-114`、`WatchModel.swift:184`；请求体字段 `key/action/binding/requestId` 与服务端解构的 `:1491`、允许键 `:1494` 一致，`ownerPresence` 分支也沿用原来的 challenge/签名逻辑，能接受。
   - `Brand.xcassets/wordmark`：产生于新目录，使用于 `TodayHeader.swift:84` 的 `Image("wordmark", bundle: .module)`；`Package.swift:30` 的 `.process("Resources")` 会处理该 catalog，资源名未被 `Icons.xcassets` 重复定义，静态核对能接受；运行时加载未核实。
   - `icons.json` 新增的 `bolt`、`device-laptop`、`device-watch`、`qrcode-off`、`upload`：来自 main；`Icon.swift` 和 `Icons.xcassets` 都有对应项，一致。
   - `Package.swift` 新增 `HimawariShellTests` target：测试目录存在，Linux 分支不编译它，能接受。
   - `ui-review/latest` 删除：`ui-review.sh:7` 只写仓库外缓存，没有代码读取仓库内 `latest/`，能接受。
   - README 的 `Brand.xcassets` 路径：与实际文件和 `make-wordmark.py` 命令参数一致，能接受。
