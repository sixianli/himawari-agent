**本轮查过的范围**

- 增量 `c6d1163f..f3f55e07` 的全部 11 个文件，重点读了 `popup.js`、`Handover.swift`、`SafariBridge.swift`、`HandoverTests.swift`、`safari-panel-review.mjs`、`test/tooling/safari-panel.test.ts`。
- 证据指向旧代码时继续读了 `AppModel.swift`、`SharedVault.swift`、`KeychainValueStore.swift`、`SecureEnclaveKeys.swift`、`LocalStore.swift`、`HandoverDesk`、`page.js`、`safari-panel-review.d.mts`，并对照了设计文档的队列上限。
- 未核实：`swift test` 的实际通过数、Mac/iOS 编译、设计验收、真机 Safari/分享扩展；这些都无法用当前工具运行。

---

### 1. 中高：钥匙串 service 改成固定的 `himawari.device` 且没有迁移，已配对设备会读不到旧凭据（上一轮意见 1 仍未修）

- 文件:行：`clients/apple/Sources/HimawariCore/SharedVault.swift:7`、`:36-38`；`clients/apple/Sources/HimawariShell/AppModel.swift:60-63`、`:78-92`、`:409-419`
- 问题：旧代码用 `(bundle.bundleIdentifier ?? "himawari") + ".device"` 作为 service；本 PR 改成固定 `"himawari.device"`。配对记录和 Secure Enclave 密钥都只从新 service 读取，没有读旧 service 的迁移逻辑。升级后 `restore()` 看到新 service 全部 absent，会走 `.forget`，已配对用户要重新配对。
- 证据（读代码证实）：
  - `SharedVault.swift:7`：`public static let service = "himawari.device"`
  - `SharedVault.swift:36-38`：`KeychainValueStore(service: Self.service, ...)`
  - `SharedVault.swift:40-42`：`pairingRecord()` 只读 `keychain.read(Self.recordAccount)`，没有旧 service 分支。
  - `git diff afcaff..c6d -- clients/apple/Sources/HimawariShell/AppModel.swift` 的旧行仍是 `let service = (bundle.bundleIdentifier ?? "himawari") + ".device"`。
  - `AppModel.swift:416-418` 的 `forget` 只删除新 service 下的密钥和记录，旧记录留在旧 service，旧设备在服务器上也不会被吊销。
- 推测：升级用户的真实影响未在真机验证；但 service 名变化且无迁移代码，旧记录不会被新查询命中，这是确定的。
- 建议：增加一次性迁移：新 service 为空时，按旧 bundle id 拼出旧 service 读取 `pairing-record` 和设备密钥，复制到新 service 后再删旧值；迁移失败或旧记录存在时写入日志/状态。补一条旧 service 数据迁移到新 service 的自动测试，并覆盖“迁移后服务器上的旧设备怎么办”。

---

### 2. 中高：待传队列仍无上限、无淘汰，增量又把 `serverOutdated`/`limitReached` 永久保留，队列可以无限增长（上一轮意见 4 仍成立并被加重）

- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:447-449`、`:455-466`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:567`、`:758`
- 问题：`HandoverQueue.add` 对大小、条数、类型一律照写，没有任何 500 MB 或按类型的淘汰；`drain` 现在对 `.queued`、`.failed(.serverOutdated)`、`.failed(.limitReached)` 全部 `continue`。如果服务器长期不更新或当天限额不恢复，这些项会一直留在磁盘上，且每次新的 `hand()` 都会先 `drain` 一遍，重复发请求。
- 证据（读代码证实）：
  - `Handover.swift:447-449`：`add` 只有 `try store.write(...)`，没有容量检查。
  - `Handover.swift:460-464`：`case .queued, .failed(.serverOutdated), .failed(.limitReached): continue`。
  - 设计文档 `:567`：`device.queue.bytes` 默认 `500 MB`，到上限“先丢最旧的低价值类型，并通知”；`:758` 同样要求“先丢最旧的低价值类型，记数”。
  - 仓库里没有队列字节数统计、淘汰或通知代码。
- 推测：真实用户能积累多少条取决于服务器版本和断网时长；但无上限是代码事实，“长期不更新服务器”会把所有内容永久留在本地，属于资源耗尽风险。
- 建议：在 `HandoverQueue` 里按字节数/条数实施上限，达到时按设计文档淘汰最旧的低价值项并记录；把 `serverOutdated`/`limitReached` 与普通离线队列分开处理或限制重试频率；加一条超限淘汰的自动测试。

---

### 3. 中：意见 3 只修了 `drain`；首次交付遇到 `serverOutdated`/`limitReached` 仍然不入队，内容照样丢

- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:542-547`、`:409-412`
- 问题：`HandoverDesk.hand` 只有 `outcome == .queued` 才 `queue.add`。首次交付直接返回 `.failed(.serverOutdated)` 或 `.failed(.limitReached)` 时，内容不会进入队列；但 UI 文案仍让用户“更新服务器后再交”或“今天到上限”，用户可能已经关闭分享面板，原内容就丢了。同一个 outcome 从 `drain` 里返回会被保留，从 `hand` 里返回却不会，行为不一致。
- 证据（读代码证实）：
  - `Handover.swift:543-546`：`let outcome = await courier.deliver(handover); if outcome == .queued { try queue.add(handover) }`。
  - `Handover.swift:461` 对已在队列里的同类结果却是 `continue`。
  - `HandoverCourier.outcome` 在配置缺 attachments/perception 或 ingest 返回 limitReached 时直接返回 `.failed(...)`，不会变成 `.queued`。
- 推测：如果产品有意要求首次失败后用户重新分享，这不算错误；但与“排队项不删”的修复放在一起，用户会看到两种相同结果对应两种不同持久化行为。
- 建议：明确产品语义。如果 `serverOutdated`/`limitReached` 应当稍后自动重试，就让 `hand` 也把这些结果入队；如果不应该，就在 UI 里明确说“需要重新分享/重试”，不要暗示内容已被保留。补一条 `hand` 首次遇到 serverOutdated/limitReached 的测试。

---

### 4. 中低：Safari 面板的 `kept` 默认是 true，`.unpaired`/`unreachable` 仍会显示“这一页的全文”

- 文件:行：`clients/apple/App/SafariExtension/Resources/popup.js:14`、`:61-63`、`:45-47`；`clients/apple/Sources/HimawariShare/SafariBridge.swift:35-47`；`clients/apple/Sources/HimawariShare/HandoverSheet.swift:139-158`
- 问题：`kept = reply.kept !== false` 把“没有这个字段”当成“全文已保留”。`SafariBridge.describe` 只在 `.finished(outcome)` 时写 `kept`；`.unpaired` 和背景脚本失败的 `.unreachable` 都没有这个字段，于是面板仍显示 `tabelog.com · 这一页的全文`，即使根本没有交给 App。这是失败时默认“已保留”的 fail-open 语义。
- 证据（读代码证实）：
  - `popup.js:14`：`let kept = true;`
  - `popup.js:63`：`kept = reply.kept !== false;`
  - `popup.js:45-47`：`kept ? words["sheet.fullPage"] : ""`
  - `SafariBridge.swift:37`：只有 `.finished` 才 `reply["kept"] = outcome.keepsWhatWasRead`。
  - `SafariBridge.swift:22` 的 `describe(.unpaired)` 不带 `kept`。
  - 另外 `page.js:4` 的 `text` 可能为空，而 `popup.js:98` 只要 URL 可读就设 `textRead = true`，空正文也会显示“全文”。
- 推测：`.unreachable` 是否真的发生取决于 Safari native messaging 失败频率；但代码路径存在，且默认值方向是错的。
- 建议：`showOutcome` 默认 `kept = false`，只有明确 `reply.kept === true` 才显示全文；编辑阶段单独保留 `kept = true`。`SafariBridge.describe` 对 `.unpaired` 明确返回 `kept: false`。同时把 `textRead` 改成要求 `page.text` 非空。补 unpaired/unreachable/空正文的测试。

---

### 5. 中低：超长 request 仍然先上传附件再拒绝（上一轮意见 5 未修）

- 文件:行：`clients/apple/Sources/HimawariCore/Handover.swift:373-378`；`clients/apple/Tests/HimawariCoreTests/HandoverTests.swift:169-176`
- 问题：`conversationPlan` 先 `uploadAttachment`，再用 `MessageAttachments.fits` 检查 request 长度；超长时返回 `.failed(.tooLarge)`，`hand` 又不会入队，整页内容丢失，同时服务器上留下一个不会再被引用的附件。
- 证据（读代码证实）：
  - `Handover.swift:374`：`let ref = try await api.uploadAttachment(...)`。
  - `Handover.swift:376-378`：之后才 `if !MessageAttachments.fits(...) { return .failed(.tooLarge) }`。
  - 测试 `HandoverTests.swift:175` 明确断言请求路径是 `["/api/device/v1/config", "/api/device/v1/attachments"]`，证明测试本身也知道附件已经上传；它只检查没有开 thread。
- 推测：服务器是否保留这个附件取决于服务端实现（本 PR 不含服务端），但客户端确实多发了一次上传。
- 建议：在 `uploadAttachment` 之前用附件文本/图片大小和 request 组成做一次预检；或者先用占位 ref 计算 `fits`，通过后再上传。补一条“超长 request 不上传附件”的反向测试。

---

### 6. 低：`kept` 没有同步到面板类型声明，部分场景与真实 bridge 不一致，bridge 端无测试

- 文件:行：`clients/apple/scripts/safari-panel-review.mjs:55-58`、`:60-75`；`clients/apple/scripts/safari-panel-review.d.mts:9-15`；`clients/apple/Sources/HimawariShare/SafariBridge.swift:37`；`test/tooling/safari-panel.test.ts:80-85`、`:87-101`
- 问题：
  - 新场景 `22-gaps-2h-safari-failed` 的 `hand` 带了 `kept: false`，但 `PanelHand` 类型没有 `kept` 字段。
  - `22-gaps-2e-safari-entry-off` 和 `22-gaps-2f-safari-removed` 没有 `kept: false`，而真实 `SafariBridge` 对 `.entryOff`/`.deviceRemoved` 会发送 `keepsWhatWasRead == false`，所以设计截图/测试场景与真实行为不一致。
  - `test/tooling/safari-panel.test.ts` 的 `kept` 是场景直接给的；即使删掉 `SafariBridge.swift:37`，这个测试仍然通过，说明“bridge 产生 kept”没有被自动检查。
- 证据（读代码证实）：
  - `safari-panel-review.d.mts:9-15` 的 `PanelHand` 只有 `phase`、`done`、`line`、`button`、`link`。
  - `safari-panel-review.mjs:60-75` 的两个场景没有 `kept`。
  - `SafariBridge.swift:37` 是唯一产生 `kept` 的代码。
  - `test/tooling/safari-panel.test.ts:80-85` 只覆盖新失败场景，`:87-101` 只检查 entry-off 的按钮，不检查副标题。
- 建议：在 `PanelHand` 加 `kept?: boolean`；给 entry-off/removed 场景补 `kept: false`；给 `SafariBridge.describe` 加单元测试，分别断言 delivered/queued 为 true、failed/entryOff/deviceRemoved 为 false。这样 I-73 提到的“产生端和使用端都要有校验”才成立。

---

### 7. 低：新增队列并发回归测试是时序相关的 add/add，只覆盖 `serverOutdated`，不能稳定证明旧实现的竞争已修（上一轮意见 6 只部分成立）

- 文件:行：`clients/apple/Tests/HimawariCoreTests/HandoverTests.swift:211-234`
- 问题：新测试用 60 个任务向两个 `HandoverQueue` 并发 `add`，依赖调度器产生交错；没有 barrier、没有可控存储、也没有 `remove` 与 `add` 并发。旧实现（`handover-index` 的读-改-写）确实可能丢项，但这个测试也可能因为线程恰好串行而通过，不是确定性反向用例。此外 `try? queues[...].add(item)` 吞掉写入错误，且只测了 `serverOutdated`，没有测同一行里的 `limitReached`。
- 证据（读代码证实）：
  - `HandoverTests.swift:225-231`：`withTaskGroup` + `try? queues[offset % 2].add(item)`。
  - 测试只断言 `queues[0].pending().map(\.id) == ids`，没有断言 `add` 的错误。
  - `theQueueKeepsWhatAnOutdatedServerCouldNotTakeYet` 只覆盖 `serverOutdated`，没有 `limitReached`。
- 推测：在 CI 多核环境下这个测试大概率能撞出旧实现的竞争，但不能保证每次；它不是“去掉修复必红”的确定性门槛。
- 建议：用一个可控的 `LocalStore` 在旧实现的读-改-写位置强制交错，或显式测试 add/add 与 add/remove 两种竞争；不要用 `try?` 吞错；补 `limitReached` 保留测试。这样反用例才会稳定失败。

---

**上一轮意见逐条核对**

- 意见 1（钥匙串 service）：未改，仍成立，见意见 1。
- 意见 2（Safari `.failed` 显示全文）：`.failed` 路径已通过 `kept: false` + `popup.js` 修好；但 `.unpaired`/`.unreachable` 的默认值仍有同类问题，且 bridge 端无测试，见意见 4、6。
- 意见 3（排队项被 `drain` 删除）：`drain` 已保留 `serverOutdated`/`limitReached`，这条具体问题已修；但首次 `hand` 仍不入队，行为不对称，见意见 3。
- 意见 4（队列无上限、无淘汰）：未改，且因新增保留永久失败项而更严重，见意见 2。
- 意见 5（超长 request 上传后才拒绝）：未改，见意见 5。
- 意见 6（旧实现的回归测试也能通过）：新增了并发测试，但仍是时序相关且覆盖不全，只算部分修好，见意见 7。

---

**侧重检查**

- 错误路径：检查了 `HandoverCourier.deliver` 的旧服务器/限额/超长路径、`HandoverDesk.hand` 的入队条件、`HandoverQueue.drain` 的保留/删除分支、`SafariBridge.describe` 与 `popup.js` 的失败状态。发现意见 3、4、5。
- 不合规范或不可信输入：`HandoverContent.page(from:)` 仍只接受 http/https，`popup.js` 用 `textContent` 写入页面标题/正文，未发现新增注入点；新增的 `kept` 是后端 bool，不是用户输入。空 `innerText` 被当成“已读全文”是一个既有的边界问题，已在意见 4 附带指出。
- 安全：钥匙串 service 迁移缺失会留下旧设备记录，且 `forget` 只删新 service 的密钥，未发现新增的密钥泄漏或日志泄漏。`DEVELOPMENT_TEAM` 仍为空，未发现团队号。
- 资源耗尽：队列无上限、无淘汰，且新保留策略会积累永久失败项，见意见 2；超长 request 仍会先上传附件，见意见 5。
- 不可撤销操作：`drain` 的 `remove` 仍会删除 `.failed(.tooLarge)`、`.failed(.rejected)` 等项；本次未改这些删除分支，但保留/删除语义与 UI 不完全一致，见意见 3。
- 规则、说明文档和代码一致性：设计文档 `device.queue.bytes = 500 MB` 与代码无上限不一致，见意见 2；`safari-panel-review.d.mts` 与新增 `kept` 不一致，见意见 6；`test/tooling/safari-panel.test.ts` 的场景和真实 `SafariBridge` 对 entry-off/removed 不一致，见意见 6。
- 未核实：`swift test`、Mac/iOS 编译、设计验收、真机 Safari/分享扩展、服务端 PR 451 的附件接口行为。

---

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不涉及。本次增量只改客户端交接队列和 Safari 面板；没有改系统提示、工具定义、历史消息或 `HandoverPlanner`/`HandoverCourier` 的消息拼装。交接内容仍作为新 thread/message 或感知记录发给服务端，模型请求的组装不在本 PR。服务端 PR 451 的行为未核实。
2. **同一段文字会不会在不同请求里变成不同字节？** 不涉及本次增量。`kept` 只是 UI bool；队列保留复用原来的 `Handover.id`/`createdAt`，没有新增时间字段、无序集合或依赖前后文的遮盖。`PerceptionRecordUpload.evidence` 的字典编码顺序是旧代码既有情况，本次未改，且不是模型请求。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 部分有：
   - `drain` 保留 `serverOutdated` 有正向测试，旧实现会失败；但没有 `limitReached` 的保留测试。
   - Safari 面板新测试会验证 `kept:false`，但 `kept` 由 mock 直接给，删掉 `SafariBridge.swift:37` 仍然通过；unpaired/unreachable 也没有测试。
   - 并发测试是时序相关，不能保证在旧实现上稳定失败，且只测 add/add。
   - 队列上限、超长 request 预检、钥匙串迁移均无自动检查。作者说的 Linux 176 项通过、Mac 编译和设计验收，我无法运行，未核实。
4. **每个新增/修改的值，两端都能接受吗？**
   - `kept`：产生端 `SafariBridge.swift:37`，使用端 `popup.js:63`，通过 native messaging 的 bool 能传；但类型声明 `safari-panel-review.d.mts:9-15` 没有 `kept`，使用端默认把缺失当 true，entry-off/removed 场景也没提供 `kept:false`。两端不一致，见意见 4、6。
   - `.failed(.serverOutdated)`/`.failed(.limitReached)` 的保留：枚举本身存在，`drain` 能接受；`AppModel.deliverWaitingHandovers` 只关心 `.deviceRemoved`，不会误处理。但 `HandoverDesk.hand` 不把同类首次结果入队，语义不对称，见意见 3。
   - 新场景 id `22-gaps-2h-safari-failed`：被 `test/tooling/safari-panel.test.ts` 和截图脚本使用，没有注册表校验，运行时可用；但对应类型声明和真实 bridge 行为没有同步，见意见 6。
   - 本次没有新增配置键、清单项或序列化格式；`DEVELOPMENT_TEAM` 已核对为空。
