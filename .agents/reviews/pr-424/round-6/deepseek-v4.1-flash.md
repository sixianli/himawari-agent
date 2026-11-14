## 读代码证实的

### 1. 中高 —— `claim` 把“读不到归属标记”当成“换了设备”，会整库清空（含未发出的消息）

**文件：** `clients/apple/Sources/HimawariCore/PairingDecisions.swift:41-46`，`clients/apple/Sources/HimawariCore/LocalStore.swift:27-29`

```swift
// PairingDecisions.swift
41    public func claim(for owner: String) throws {
42        let mark = Data(owner.utf8)
43        if read(Self.ownerName) == mark { return }
44        try removeAll()
45        try write(Self.ownerName, mark)
46    }
```

```swift
// LocalStore.swift
27    public func read(_ name: String) -> Data? {
28        lock.withLock { try? Data(contentsOf: directory.appendingPathComponent(name)) }
29    }
```

`read` 把任何错误都吞成 `nil`。因此“文件不存在”和“文件存在但暂时读不出”在 `claim` 里完全等价，都会走到 `removeAll()`。这不是“与本次设备不同才清空”，而是“只要不能确认为同一设备就清空”。同一文件里 `RestoreDecision` 对 unreadable 的处理相反：

```swift
// PairingDecisions.swift:15
if presence.contains(.unreadable) { return .unreadable }
```

**影响：**
- 从没有写过 `owner` 的旧构建升级（本 PR 前几轮的构建）第一次启动会删除 `outbox.json`、`threads-cache.json`、`stream-cursor`。**未发出的待发消息没有服务器副本，删了就找不回。**
- 只要 `owner` 因文件保护、临时 I/O 错误读失败，也会先删光再尝试写标记；写标记失败时已经造成不可逆数据丢失。
- 新增测试 `aStoreLeftByAnotherPairingIsEmptiedBeforeUse` 第 67–69 行实际上把“没有标记 + 有数据 → 清空”固化成了期望行为。

**建议：** 区分 absent / unreadable。归属文件存在但读不出时应抛错（进入 `storageUnavailable`），绝不能删；归属文件不存在时单独决定迁移策略（建议：已有数据且当前有配对记录时先认领，而不是清空；只有明确发现不同 `deviceId` 才清空）。同时补“读失败不删数据”的反向测试。

---

### 2. 中 —— `forget()` 忽略清空失败，但新的确认文案承诺“对话和密钥都会删除”

**文件：** `clients/apple/Sources/HimawariShell/AppModel.swift:304-321`，`clients/apple/Sources/HimawariShell/Resources/zh-Hans.lproj/Localizable.strings:43`

```swift
// AppModel.swift
311        try? store?.removeAll()
312        if store == nil, let fresh = try? FileLocalStore.applicationSupport(named: "himawari-device") {
313            try? fresh.removeAll()
314        }
315        store = nil
316        try? keys.delete(.device)
317        try? keys.delete(.confirm)
318        try? save(nil)
```

```text
// zh-Hans Localizable.strings:43
"pairing.startOver.confirm" = "清掉后，这台 iPhone 上存的对话和密钥都会删除，要重新扫码配对。";
```

本轮把 `removeAll` 改成会抛错，但 `forget` 仍然全部用 `try?` 吞掉，并且无论清空是否成功都继续删密钥和配对记录。确认对话框明确承诺“对话和密钥都会删除”，实际可能留下旧对话文件。`activate()` 的 `claim` 失败后用户走“清掉，重新配对”时，这条路径正好会被走到。

**建议：** 至少在 `removeAll` 失败时不要向用户宣称已删除；更稳妥的是先成功清空本地数据，再删密钥/配对记录，失败则停在可重试页。若“删除密钥必须继续”是刻意的，确认文案应改成不会误导的说法。

---

### 3. 中 —— 本轮最关键的运行时改动完全没有自动检查

**文件：** `clients/apple/Tests/HimawariCoreTests/PairingProblemTests.swift:36-82`；`clients/apple/Sources/HimawariChat/ChatStore.swift:104-111, 306-309, 377-388`

已确认：测试只覆盖纯决策函数和 `FileLocalStore`：

```swift
36  @Suite struct PairingDecisionTests {
37      @Test func restoreNeverForgetsWhenSomethingIsOnlyUnreadable() { ... }
45      @Test func aRefusedPairingLeavesNothingBehindButAnUnknownOutcomeKeepsTheKeys() { ... }
54      @Test func theExecutionStreamNeedsRoomForTwoConnections() { ... }
62      @Test func aStoreLeftByAnotherPairingIsEmptiedBeforeUse() throws { ... }
76      @Test func emptyingAStoreThatCannotBeListedFails() throws { ... }
```

而以下新行为没有任何测试：
- `ChatStore.limitStreams`：关闭已开执行流、配置晚到后重开、`wantedThreadId` 被 `unwatch` 清掉后的行为。
- `flush` 收到 `DEVICE_REVOKED` 是否调用 `onSessionInvalid`，以及普通网络错误是否**不会**调用。
- `loadTexts` / `newThread` 的 revoked 分支。
- `activate()` 在 `claim` 失败时停在哪一页、能否退出。
- `ui-review.sh` 的 `--only` 校验。

仓库根目录的 `npm run check` 只跑 `check:apple-design`（`package.json:32`），不跑 `swift test`；这些 Swift 测试只能在 Mac/云端手动执行。

**建议：** 用假的 `DeviceAPI`/`LocalStore` 给 `ChatStore` 加单元测试，至少覆盖：`streamConnections` 由 nil→1 关闭、1→2 重开；`flush` 的 revoked 与 `URLError` 两条分支；`loadTexts`/`newThread` 的 revoked 分支。`ui-review.sh` 至少加一个 shell 级用例。

---

### 4. 低 —— 作者说 `--only` 的“重复值报错”，实际重复值被静默去重

**文件：** `clients/apple/scripts/ui-review.sh:41`

```bash
[ "${#chosen[@]}" -gt 0 ] && [ "${#chosen[@]}" -eq "$(printf '%s' "$only" | tr ',' '\n' | grep . | sort -u | grep -c .)" ] || ...
```

`chosen` 是按场景集合循环加入的，天然不含重复；右侧加了 `sort -u` 后也不计重复。因此 `--only a,a`（实际写法 `--only A` 重复一次）会通过，不是报错。空值确实会报错（`only` 被包成 `",,"`，`chosen` 为空）。**说法与代码不一致。**

**建议：** 如果需求是拒绝重复，去掉 `sort -u`，保留 `grep -c .`；如果需求是允许重复并去重，修改说明，并补测试。

---

## 推测 / 未核实

- **`owner` 读失败的具体触发条件（推测）：** iOS 的 `.completeFileProtection`（`LocalStore.swift:39`）在锁屏时会让文件内容不可读；应用若在解锁前初始化 `AppModel`，就会出现 `read == nil → removeAll`。该应用未在 `Info.plist` 配置后台模式，因此正常使用下触发概率不高，但这是上面的中高问题最现实的入口。未在真机复现。
- **`streamConnections` 两端的语义（未核实）：** `Models.swift:46` 消费服务器值，`PairingDecisions.swift:32-34` 假定“总值 ≥ 2 才允许执行流”。服务器实现不在本仓库（材料说在 PR 404），我无法确认它是“总连接数”还是“剩余执行流连接数”。若是后者，`>= 2` 会过度关闭执行流；若是前者则正确。按 I-73 的教训，这个共享边界需要服务器的契约/集成用例来核对，目前只有客户端自己的测试 `theExecutionStreamNeedsRoomForTwoConnections`。
- **撤销清理与在途写入的竞态（推测）：** `checkRevoked()` 是异步 `Task`（`AppModel.swift:290-292`），而 `refreshThreads()`/`load()` 在 `forget()` 执行 `removeAll` 之后仍可能继续 `persist()`（`ChatStore.swift:187, 205, 390-392`）。即使清空成功，旧的 `threads-cache.json` 也可能被重新写回。下次配对时 `claim` 会再清一次，所以影响有限，但“吊销时清空”并不严格成立。
- **`warm_up` 的说明与代码（低）：** 作者说“固定用第一个静态场景”，代码是 `warm_up="${scenes[0]}"`（`ui-review.sh:34`）。当前 `DemoScenes` 第一项是 `03-chat-list`，所以今天成立；一旦有人在前面插入 `motion-*`，预热会变成动效场景。建议明确过滤 `motion-*` 后再取第一个。

---

## 侧重检查

- **错误路径 / 不可信输入：** `streamConnections` 为负数、0、1 都只会关闭执行流（`allowed` 返回 false），不会崩溃或越界，安全；`--only` 的非法场景名会报错，但重复值不再报错（见问题 4）。`owner` 写入的是 `deviceId` 原文，只作为 `LocalStore` 文件名 `"owner"` 的数据，不参与路径拼接，没有路径穿越。
- **资源耗尽：** 执行流在 `streamConnections < 2` 时关闭，`wantedThreadId` 只保留一个，没有新增无界集合或循环；`ui-review.sh` 的等待循环新增了空闲提前返回，未引入新的无限等待。
- **不可撤销操作：** “清掉，重新配对”已加系统确认，三语键都存在且被使用（`PairingView.swift:25-28`）。但底层 `removeAll` 失败被吞掉，与确认文案不一致（见问题 2）；吊销路径同样依赖 `forget` 的最好努力删除。
- **规则/文档一致性：** `README.md` 的 `Icon(.message)` 与 `Icon.swift:37`、`scripts/icons.json:39` 一致；`pairing.startOver.confirm` 在 en/ja/zh-Hans 三份资源中都存在；`test/tooling/apple-design-check.test.mjs` 从 `lineSpacing` 改为 `lineHeight` 与生成的 `DesignTokens.swift:148` 一致。作者没有提到这两处改动，但它们是正确的小修。
- **作者说法逐条核对：**
  - 1、2、4、5、7 已对照代码成立。
  - 3 的“`loadTexts` 和 `newThread` 出错都走 `onSessionInvalid`”不准确：只有 `DeviceAPIError.isRevoked`（`code == "DEVICE_REVOKED"`）才会走（`ChatStore.swift:371-375`、`382-391`、`262-267`）；普通网络错误不会把设备当成被移除，这正是期望行为。
  - 6 的“重复值报错”不成立（见问题 4）；“预热固定用第一个静态场景”目前只是“第一个场景”恰好是静态场景。

---

## 必答问题

**1. 是否改变模型已经见过的请求开头？**

没有改变。这个客户端不组装系统提示、工具定义或历史；它只发 `POST /threads`（`requestId`、`answerLocale`）和 `POST /messages`（`messageId`、`threadId`、`expectedRevision`、`text`），见 `DeviceAPI.swift:164-170`、`178-186`。本轮改动都在本地存储、流控制和错误处理上，没有改这两个请求体的字段、顺序或内容。因此对客户端而言，发给服务器的内容没有变成“非末尾追加”，也没有把每轮变化的值塞进开头。服务器如何把这些拼成模型请求属于 PR 404，**未核实**；但本轮没有触碰该路径。

**2. 同一段文字会不会在不同请求里变成不同字节？**

没有新增这种风险。`loadTexts` 用 `Set` 后显式 `.sorted()`（`ChatStore.swift:378`）只是展示顺序，且是确定的；`claim` 写入的标记只取决于稳定的 `deviceId`；新增文案是静态本地化字符串；`ui-review.sh` 的 `sort -u` 也是确定的。本轮没有新增时间字段、哈希、无序集合或依赖后文的遮盖。`OutgoingMessage.createdAt` 的 `Date()` 是既有代码，不是本轮引入。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**

有部分：新增 5 条 `PairingDecisionTests`，对 `RestoreDecision`、`PairingAttempt`、`ExecutionStreamPolicy`、`FileLocalStore.claim/removeAll` 有正反用例；如果实现改成“unreadable 也 forget”“1 个连接也允许”“列出目录失败不抛错”，这些用例会失败。`FileLocalStore` 不可列目录的反向用例也确实期望抛错。

但本轮真正有风险的三条路径没有自动检查：`limitStreams` 的关流/重开、`flush` 的 `DEVICE_REVOKED` 分支、`loadTexts`/`newThread` 的新入口，以及 `activate` 的 `claim` 失败页面。`swift test` 也不在根 `npm run check` 里，只能手动跑。因此不能把“91 条全过”当作这轮改动的保护网。

**4. 每个新值的两端是否都能接受？**

- `owner` 文件名：产生与消费都在同一个 `claim` 扩展里；`FileLocalStore`/`MemoryLocalStore` 都实现了 `removeAll`；与现有文件名 `outbox.json`、`threads-cache.json`、`stream-cursor` 不冲突。**但**消费端把“读不到”和“没有”混为一谈，导致误清空（问题 1）。
- `removeAll()` 协议方法：两个实现类都补上了，没有其他实现者。
- `streamConnections` / `streamsNeeded = 2`：服务器产生、客户端消费，但服务器契约不在本仓库，**两端校验未核实**；这是最像 I-73 的一个点，需要服务器契约或集成用例确认阈值含义。
- `pairing.startOver.confirm`：三份本地化资源都有，`PairingView` 使用，两端一致。
- `--only` 的场景清单：产生端是命令行，消费端是 `DemoScenes`；重复值的校验与作者说法不一致（问题 4）。
- `RestoreDecision` 的三个 case：`AppModel` 的 `switch` 已全覆盖，无遗漏。

**补充回答作者重点问题 2（`activate()` 在 `claim` 失败时界面停在哪、能不能出来）：**

`activate()` 的 `catch` 把 `phase` 设为 `.unpaired(.storageUnavailable)`（`AppModel.swift:252-254`）。`PairingView` 对该状态显示“重试”和“清掉，重新配对”（`PairingView.swift:46-53`），所以能出来：
- 存储恢复后按“重试”走 `retryReadingKeys → restore → activate`；
- 或按“清掉，重新配对”，确认后走 `cancelPairing → forget`，即使 `removeAll` 再次失败，密钥和配对记录仍会被删除并进入 `.unpaired(nil)`（`AppModel.swift:304-321`）。

不会卡死在 `activate()` 内部。但“清掉”是否真的清掉了本地对话，取决于问题 2 的 `try? removeAll()`，确认文案目前可能不准确。
