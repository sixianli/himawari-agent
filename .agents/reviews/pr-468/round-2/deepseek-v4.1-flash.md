## 结论

本轮增量只改 Apple 客户端（`clients/apple`），没有改服务器或模型请求组装。共发现 1 个与“不转圈”目标直接相关的缺口、1 个设备状态轮询缺口，以及 3 个较低风险的发送/展示/测试问题。未发现会让模型已见过的请求开头变化。

---

## 问题（按严重度从高到低）

### 1. 中：`status` 记录遇到新阶段时仍会一直“思考/转圈”

- 文件:行：`clients/apple/Sources/HimawariCore/Execution.swift:154-159`；`clients/apple/Sources/HimawariChat/ProcessRowView.swift:43-44`
- 问题：本轮只处理了“种类不认识”和“`tool` 配新阶段”。如果服务器给 `kind: "status"` 的记录发来一个不认识的新阶段（例如未来的 `waiting_for_input`），宽松解码会把它变成 `.unrecognized`，于是第 154 行的 `latest.phase == .waiting` 不成立；而 `steps()` 只收集 `tool`/`unrecognized` 种类，`status` 记录不会进步骤列表。若这一轮没有工具步骤，第 159 行直接返回 `.thinking`，界面按 `shimmering: true` 一直闪，正好是这次想避免的“转圈”。
- 证据：
  - `Execution.swift:154`：`if let latest = sorted.last, latest.phase == .waiting, latest.kind == .tool || latest.kind == .status {`
  - `Execution.swift:159`：`guard let current = steps.last else { return .thinking }`
  - `ProcessRowView.swift:43-44`：`case .thinking:` → `ProcessLineLabel(..., shimmering: true)`
- 读代码证实：路径成立；推测：触发需要服务器未来在 `status` 记录上使用新阶段。
- 建议：对“最新记录是 `status` 且阶段不认识”单独处理成非转圈的未知状态（或显式等待态），并补 `kind: "status"` + 未知阶段的用例，包含“没有任何工具步骤”的轮次。现有测试只覆盖了 `tool` + 新阶段（`ServerValueTests.swift:89-97`）。

### 2. 中：设备状态 `unrecognized` 的等待页能出来，但可能永远轮询

- 文件:行：`clients/apple/Sources/HimawariShell/AppModel.swift:75-78`、`228-247`
- 问题：`restore` 把 `.unrecognized` 与 `.pending` 一样进入等待页并启动 `waitForConfirmation()`。该循环没有次数或总时长上限，只有 `configuration()` 成功或 `DEVICE_REVOKED` 才退出。设计文档写明“只有 active 能通过验签”（`docs/execution/specs/2026-11-11-apple-device-body-design.md:178、734`），所以一个服务器新加的状态（例如 `suspended`）既不会变成 active，也不会返回 `DEVICE_REVOKED`，客户端就每 10 秒一次永远轮询。用户只能点“取消”，而 `cancelPairing()` 会删密钥和本地记录、要求重新配对。
- 证据：
  - `AppModel.swift:76-78`：`case .pending, .unrecognized:` → `phase = .waitingForConfirmation(...)`；`waitForConfirmation()`
  - `AppModel.swift:232-245`：`while !Task.isCancelled { ... } catch {} ... delay = min(delay * 2, 10)`，无退出上限
  - `PairingView.swift:200`：等待页只有 `cancelPairing()` 这一条退路
- 读代码证实：等待页确实会出现；轮询确实没有上限。推测：实际永久轮询取决于服务端返回非 active、非 revoked 的新状态。
- 建议：给等待确认设置总时长/次数上限，超时后进入明确的“状态未知/请更新 App”页面，或把 `.unrecognized` 当作需要人工处理的独立状态，而不是无期限 pending。并补 `AppModel.restore` 的自动用例。

### 3. 低：`ReleaseChannel.unrecognized` 现在可以被编码进配对请求，服务端会拒绝

- 文件:行：`clients/apple/Sources/HimawariCore/Models.swift:15`；`clients/apple/Sources/HimawariShell/AppModel.swift:46-47、153`；`clients/apple/Sources/HimawariCore/DeviceAPI.swift:48-56`；`packages/gateway-contracts/src/contracts-v2.ts:526`
- 问题：新增 `.unrecognized` 后，`ReleaseChannel(rawValue: "unrecognized")` 变成合法值。`AppModel` 用 `channel.flatMap(ReleaseChannel.init(rawValue:)) ?? .direct` 读取 `Info.plist` 的 `$(HIMAWARI_RELEASE_CHANNEL)`；如果构建设置误写成 `unrecognized`（或未来代码直接传 `.unrecognized`），它会被原样放进 `PairingRequest` 发给服务器。服务端 `DEVICE_RELEASE_CHANNELS` 没有这个值，配对会被拒，并被 `PairingProblem.from` 映射成 `.codeInvalid`，用户看到“配对码无效”而不是配置错误。
- 证据：
  - `AppModel.swift:47`：`releaseChannel = channel.flatMap(ReleaseChannel.init(rawValue:)) ?? .direct`
  - `DeviceAPI.swift:48-56`：`PairingRequest(... releaseChannel: releaseChannel ...)`
  - `contracts-v2.ts:526`：`export const DEVICE_RELEASE_CHANNELS = ["direct", "testflight", "app_store", "mac_direct"] as const;`
  - `PairingRecord.swift:40`：`"DEVICE_PAIRING_REQUEST_INVALID"` → `.codeInvalid`
- 读代码证实：发送路径存在。当前 `project.pbxproj:189、213` 两个配置都是 `direct`，正常构建不会触发。
- 建议：不要让 `.unrecognized` 成为可发送值；配对路径在编码前校验 release channel 只能是清单里的四种，或给“仅解码用的宽松值”和“可发送值”分开类型。

### 4. 低：不认识的 `MessageRole` 被当作普通回答，可能误展示

- 文件:行：`clients/apple/Sources/HimawariCore/ServerValues.swift:26-28`；`clients/apple/Sources/HimawariChat/ChatStore.swift:157、226`；`clients/apple/Sources/HimawariChat/ChatView.swift:171-186`
- 问题：`.agent` 回退会让未知角色的消息以“助手回答”样式显示，还会进入线程列表预览（`lastMessageText` 只看 `role != .system`）和进程行关联（`role == .agent`）。如果未来服务器新增的是工具/系统类角色，客户端会把它当作回答展示，语义上不准确；而且没有像执行阶段那样保留“未知”值供界面区分。
- 证据：
  - `ServerValues.swift:27`：`public static var fallback: MessageRole { .agent }`
  - `ChatStore.swift:157`：`messages.last(where: { $0.role != .system })`
  - `ChatStore.swift:226`：`if message.role == .agent, let runId = message.runId ...`
  - `ChatView.swift:171-186`：`.agent` 渲染为正文回答
- 读代码证实：行为如上；推测：未知角色是否属于“回答”取决于未来协议。
- 建议：增加 `.unrecognized` 角色或在展示层显式区分，至少不要让它进入线程摘要和进程行关联；补一个 transcript/预览层用例。

### 5. 低：关键路径没有自动检查，测试名称大于实际覆盖

- 文件:行：`clients/apple/Tests/HimawariCoreTests/ServerValueTests.swift:61-68`、`76-97`；`clients/apple/Package.swift:19-38`
- 问题：
  - `aPairingWithANewDeviceStatusIsNeitherConnectedNorRemovedAndSurvivesStorage` 只验证了解码和钥匙串往返，没有验证“既不当已连接也不当已移除”的 `AppModel.restore` 行为，名字比测试内容大。
  - 没有任何测试覆盖 `AppModel.restore` 对 `.unrecognized` 的等待/轮询分支，也没有覆盖 `ProcessRowView` 的 `.unrecognized` 渲染分支。
  - Linux 的 SwiftPM 配置不编译 `HimawariShell`/`HimawariChat`（`#if os(Linux)` 下 `interfaceTargets = []`），所以作者说的 `swiftc -parse` 之外，这两处界面/状态机逻辑没有自动运行验证。
- 证据：
  - `ServerValueTests.swift:61-68`：只做 `decode` 和 `JSONEncoder/JSONDecoder` 往返
  - `Package.swift:19-24`：Linux 下界面 target 为空
- 读代码证实：覆盖范围如上。
- 建议：把设备状态决策抽到 `HimawariCore` 里做纯函数测试（例如“unrecognized → 等待，不做 destructive 操作”），并补 status + 未知阶段、未知角色在 transcript 中的用例。

---

## 侧重检查

- **错误路径/不可信输入**：`LenientServerValue.init(from:)` 只接受字符串，非字符串会抛错（`ServerValueTests.swift:28-30` 覆盖）；未知字符串不会崩，统一回退。缺失字段仍会解码失败，符合预期。没有发现注入或越界解析。
- **安全/不可撤销操作**：`.unrecognized` 不会自动删数据，只有 `DEVICE_REVOKED` 才 `forget`，这一点比把未知状态当 revoked 安全。但等待页的“取消”会删密钥和本地记录（`AppModel.swift` 的 `cancelPairing` → `forget`），所以问题 2 的永久轮询会把用户逼到破坏性重配对，需注意。
- **资源耗尽**：`waitForConfirmation` 无总时长/次数上限（`AppModel.swift:228-247`），未知状态或持续非 revoked 错误会无限轮询；这是本轮最明确的资源消耗风险。
- **分支完整性**：检查了 `PairedDeviceStatus` 的 `switch`（`AppModel.swift:75-83` 已覆盖 `pending`/`unrecognized`/`active`/`revoked`）、`MessageRole` 的 `switch`（`ChatView.swift:171-186` 仍只覆盖三种，因为没有新增枚举 case）。客户端没有对 `DeviceKind`/`ReleaseChannel`/`ExecutionPhase` 的遗漏 `switch`。
- **规则/文档一致性**：`prompt-prefix.md` 管的是模型请求，本次改动不碰请求组装；`docs/.../2026-11-11-apple-device-body-design.md:701-702、734` 仍只列 `iphone/watch/mac`、四种发布渠道和 `pending/active/revoked`，而代码手工加了客户端专用 `unrecognized`；文档还说这些 Swift 枚举“由清单生成”，但仓库里没找到生成/一致性检查，存在后续生成覆盖或两端清单漂移的风险。建议在文档或清单里明确这是“仅解码回退值”。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次改动只涉及 `clients/apple` 的服务端响应解码、状态机和界面；没有改服务器端模型请求组装，也没有改客户端发出去的 `OutgoingMessage` 文本。客户端新增的 `unrecognized` 只存在于解码路径，配对请求的 `kind` 仍是硬编码 `.iphone`，`releaseChannel` 仍来自构建设置。就本改动范围而言，发给模型的内容没有新增、重排或改写；没有发现任何“每轮变化值”被加进请求开头。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 新增值都是固定字符串（`"unrecognized"`），映射是纯函数；`ProcessLine.steps` 仍按 `sequence` 排序并保持首次出现顺序，没有新增时间字段、无序集合或依赖前后文的遮盖。钥匙串/线程缓存的 JSON 编码与模型请求无关。

### 3. 有没有对应的自动检查，反向用例会不会真的失败？

**部分有。** 解码回退、`ProcessLine.steps` 和 `make` 的新行为有测试；按代码推断，把 `MessageRole` 回退改回 `.system`、把 `steps` 过滤改回只认 `.tool`、把 `make` 的等待条件改回 `kind != .message`，对应 `ServerValueTests.swift:10-19、76-97` 会失败。
**缺的是**：`AppModel.restore` 的 `.unrecognized` 等待/轮询分支、`ProcessRowView` 的 `.unrecognized` 渲染分支、以及“`.unrecognized` 不会被放进配对请求”都没有自动检查；后两者在 Linux 下甚至不编译。作者说的 105 条全过我无法运行验证（本次只能读文件和 git）。

### 4. 每个新值/改动值，产生处和使用处两端都能接受吗？

- **`ExecutionRecordKind.unrecognized` / `ExecutionPhase.unrecognized`**：只在客户端从服务器响应解码时产生，使用处是 `Execution.swift:103、127-128、154` 和界面分支；客户端不回传执行记录。服务端契约 `thread-contracts-v3.ts:591-600` 仍只认 `message/tool/status` 和七种阶段，因此不存在“客户端发未知值给服务端”的问题。风险在问题 1 的 `status` + 未知阶段。
- **`PairedDeviceStatus.unrecognized`**：由 `PairedDeviceInfo`/`PairingRecord` 解码产生，使用处是 `AppModel.restore`/`submit`；服务端 `DEVICE_STATUSES`（`contracts-v2.ts:513`）只认三种，但配对请求里没有 `status` 字段，客户端不会发它。钥匙串编码/解码往返成立（回退值本身就是合法 rawValue）。
- **`DeviceKind.unrecognized`**：只在解码服务器返回的 `PairedDeviceInfo` 时产生，当前没有被业务使用；配对请求的 `kind` 是硬编码 `.iphone`（`AppModel.swift:151`）。服务端 `DEVICE_KINDS`（`contracts-v2.ts:512`）不接受它，但当前没有发送路径。
- **`ReleaseChannel.unrecognized`**：由解码服务器返回产生，当前没有被业务使用；但 `init(rawValue:)` 会接受构建设置里的 `"unrecognized"`，而配对请求会原样发送它，服务端 `DEVICE_RELEASE_CHANNELS`（`contracts-v2.ts:526`）拒绝——见问题 3。当前 `project.pbxproj` 固定 `direct`，正常构建不触发。
- **`MessageRole` 回退 `.agent`**：只在客户端展示层使用，不参与请求；但会影响线程预览、回答展示和进程行关联（见问题 4）。
- **第 1 轮已引入、仍值得留意的值**：`ThreadStatus` 回退 `.active`、`MessageStatus` 回退 `.committed`。当前客户端没有用 `ThreadStatus` 做权限/删除判断，所以暂无实际影响；但未知状态被当成活跃/已提交，未来接入删除、归档逻辑时要重新核对两端。
