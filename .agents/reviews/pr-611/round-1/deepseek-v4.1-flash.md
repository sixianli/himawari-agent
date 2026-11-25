## 复核范围说明

先核对材料：`git log --oneline 5206b1c9..3bda3cfe` 只有 `3bda3cfe docs(review)` 和 `fe2fd361 feat(apple)` 两个提交；`git show --stat fe2fd361` 显示功能提交只改了 `project.pbxproj`、`Watch/Info.plist`、`README.md`、`watch-ui-review.sh` 四个文件。给定的基准 `5206b1c9` 实际是 PR 598 的合并提交，而 `fe2fd361` 的父提交是 `3633e576`（`5206b1c9` 的第一父提交），所以 `git diff 5206b1c9..3bda3cfe` 里混入了 PR 598 的反向差异。下面把 `fe2fd361` 当作 PR 611 本身来评，混入的回退单列为低严重度事项。

---

### 1. 中：新 Bundle ID 没有同步到 Apple 推送允许清单，启用 `applePush` 时注册会被 403 拒绝

**文件:行**：`packages/platform-node/src/device-push.ts:158`、`packages/platform-node/src/strict-configuration.ts:1507`、`packages/platform-node/src/apple-push-sender.ts:30`、`docs/execution/specs/2026-11-11-apple-device-body-design.md:492`、`clients/apple/App/Himawari.xcodeproj/project.pbxproj:745`

**问题**：Bundle ID 不只用于 Xcode 签名，它还是 Apple 推送的 topic 来源。服务器配置 `runPolicy.applePush.topics` 按 bundle ID 做允许清单，登记令牌时不在清单里的会被拒绝；小组件和实时活动的 topic 又在这个基础 topic 上追加 `.push-type.widgets` / `.push-type.liveactivity`。PR 把 iPhone 这组 ID 从 `win.siyi.himawari*` 改成了 `win.siyi.himawari.app*`，但仓库里没有任何地方同步推送允许清单。

**证据（读代码证实）**：

```ts
// packages/platform-node/src/device-push.ts:158
if (
  !configuration.topics.includes(topic as string) ||
  !configuration.environments.includes(environment as ApplePushEnvironment)
)
  throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.TOPIC_NOT_ALLOWED, 403);
```

```ts
// packages/platform-node/src/strict-configuration.ts:1507
topics: list<string>("topics", (value) => APPLE_PUSH_TOPIC_PATTERN.test(value)),
```

```ts
// packages/platform-node/src/apple-push-sender.ts:30
if (pushType === "widgets") return `${bundleId}.push-type.widgets`;
if (pushType === "liveactivity") return `${bundleId}.push-type.liveactivity`;
```

```md
<!-- docs/execution/specs/2026-11-11-apple-device-body-design.md:492 -->
服务器配置 `runPolicy.applePush` 里列出允许的 App 标识（bundle ID，苹果给每个 App 的唯一名字）和环境，登记令牌时不在名单里的被拒。
```

**读代码证实**：服务器确实用配置里的 bundle ID 列表校验登记请求；topic 的后缀由基础 bundle ID 派生。

**推测/未核实**：`applePush` 生产配置是否已启用、iOS 端注册代码是否使用自身 `Bundle.main.bundleIdentifier`，不在本次检出的代码里；当前 Swift 源码中没有搜到 `registerForRemoteNotifications` 或 APNs 注册代码，所以这可能只是潜在问题。仓库里的推送测试夹具目前仍写着旧值（如 `test/integration/push-channels.test.ts:62` 的 `win.siyi.himawari`），这些测试不会因为改成新 ID 而失败。

**建议**：明确把 `win.siyi.himawari.app` 和 `win.siyi.himawari.app.watchkitapp` 加入部署时的 `runPolicy.applePush.topics`，并在 PR/README 里写明；如果当前生产没有开启 `applePush`，也应说明“此改动对推送无影响”。可加一条轻量检查，断言仓库里出现的生产 topic 配置与新 bundle ID 一致（测试夹具可以保留旧值，但要区分夹具和生产配置）。

---

### 2. 中：`watch-ui-review.sh` 自带第二份 Bundle ID，按 README 改前缀后会用旧 ID 启动

**文件:行**：`clients/apple/scripts/watch-ui-review.sh:9`、`:48-50`、`:64`、`clients/apple/README.md:44`；对照 `clients/apple/scripts/ui-review.sh:118`

**问题**：README 告诉用户“改工程级的 `HIMAWARI_BUNDLE_PREFIX` 这一处即可”，但 `watch-ui-review.sh` 的 `bundle` 不是从工程或构建产物读取，而是读环境变量并带一个写死的默认值。用户只改 Xcode 工程级设置、不额外导出环境变量时，构建出来的手表 App 用新前缀，脚本却仍用 `win.siyi.himawari.app.watchkitapp` 启动，`simctl launch` 会找不到 App。

**证据（读代码证实）**：

```bash
# clients/apple/scripts/watch-ui-review.sh:9
bundle="${HIMAWARI_BUNDLE_PREFIX:-win.siyi.himawari.app}.watchkitapp"
```

```bash
# clients/apple/scripts/watch-ui-review.sh:48
taskpolicy -b xcodebuild -project "$root/App/Himawari.xcodeproj" -scheme HimawariWatch -configuration Debug \
...
# clients/apple/scripts/watch-ui-review.sh:64
xcrun simctl launch --terminate-running-process "$udid" "$bundle" ...
```

```md
<!-- clients/apple/README.md:44 -->
...改工程级的 HIMAWARI_BUNDLE_PREFIX 这一处即可；如果提示被占用，把它改成别的...
```

对照 `ui-review.sh` 的做法是正确的：

```bash
# clients/apple/scripts/ui-review.sh:118
bundle="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")"
```

**读代码证实**：脚本的 bundle ID 和工程的 bundle ID 是两个独立来源；默认值刚好一致时才正常工作。另外 `xcodebuild` 那行没有显式传入 `HIMAWARI_BUNDLE_PREFIX`，如果用户只设环境变量、工程值没变，构建和启动也可能不一致。

**建议**：像 `ui-review.sh:118` 一样，从 `$app/Info.plist` 读取 `CFBundleIdentifier`，删掉脚本里的默认 bundle ID。这样 README 的“改一处”才成立，也符合 I-73 的“一个值只在一端认”。

---

### 3. 中：没有任何自动检查，反向用例不存在，苹果端编译也尚未验证

**文件:行**：`git show fe2fd361` 提交说明；`clients/apple/App/Himawari.xcodeproj/project.pbxproj:792/892/944/994/1044/1099`；`docs/incidents-and-gates.md:147`

**问题**：这次改动把 8 个 Bundle ID、`WKCompanionAppBundleIdentifier` 和工程级变量连在一起，但目前只有人工核对。提交说明自己写着 `Layer-0-tests: none`，并说“待 CI 和 Mac 编译验证”；仓库里也没有任何脚本检查 pbxproj 里的这些关系。只要哪个后缀写错、少改一个 Debug/Release、或者手表 companion 和主 App 不一致，Linux 上的 `npm run check` 都发现不了。

**证据（读代码证实）**：

```text
feat(apple): iPhone 目标的 Bundle ID 改用工程级前缀 HIMAWARI_BUNDLE_PREFIX

Layer-0-tests: none
Fast-mode-checks: 改动只有 pbxproj、Info.plist、README、shell 脚本；npm run check 在云端线程运行（见 PR）；待 CI 和 Mac 编译验证
Docs: deferred (fast mode)
```

`docs/incidents-and-gates.md:147` 的 I-112 明确记录苹果端改动没有通用编译门槛，曾导致合并后 main 编译失败。

**读代码证实**：工程文件中主 App、分享扩展、Safari 扩展、灵动岛、手表、手表小组件的 Debug/Release 都引用了变量，静态看关系正确；但没有任何自动测试或编译记录作为门槛。

**建议**：加一个不需要 Xcode 的文本级检查，放进 `npm run check`，解析 `project.pbxproj` 并断言：

- 主 App 的 `PRODUCT_BUNDLE_IDENTIFIER` 等于 `$(HIMAWARI_BUNDLE_PREFIX)`；
- `.share`、`.safari`、`.listen-activity` 都以主 App ID 加点开头；
- 手表等于主 App ID + `.watchkitapp`；
- 手表小组件等于手表 ID + `.widgets`；
- `Watch/Info.plist` 的 `WKCompanionAppBundleIdentifier` 等于主 App ID；
- Mac 目标仍是 `win.siyi.himawari.mac`；
- Debug、Release 两套配置都满足。

再配反向用例：把任意一处改错时检查必须失败。Mac 上还可以用 `xcodebuild -showBuildSettings` 复核展开后的值；至少要在合并前留下 Mac 编译通过的记录。

---

### 4. 低：README 的目标清单漏了 `HimawariListenActivity` 的 Team 设置，且“改一处即可”与后面的分组说明矛盾

**文件:行**：`clients/apple/README.md:44`；`clients/apple/App/Himawari.xcodeproj/project.pbxproj:985`、`:1009`

**问题**：README 第 2 步让用户给目标选 Team 时，只列了 `Himawari`、`HimawariShareExtension`、`HimawariSafariExtension` 三个 iPhone 目标，以及两个手表目标，没有列 `HimawariListenActivity`；但同一句又说“灵动岛的编号由 `HIMAWARI_BUNDLE_PREFIX` 拼出来”。`HimawariListenActivity` 的 Debug/Release 都写着 `DEVELOPMENT_TEAM = "";`，用户按 README 操作时可能不给它选 Team，自动签名就会失败。这个遗漏不是本 PR 引入的，但本 PR 改写了同一段并新增了灵动岛描述，仍未补上。

同一段还有表述冲突：前面说“改工程级的 `HIMAWARI_BUNDLE_PREFIX` 这一处即可”，后面又说 App Group 和钥匙串分组“改了 Bundle Identifier 时最好一起改”。对使用自己 Apple ID 的开发者来说，后一句才是完整的操作。

**证据（读代码证实）**：

```md
<!-- clients/apple/README.md:44 -->
...中间 TARGETS 下的 Himawari、HimawariShareExtension、HimawariSafariExtension 三个目标（要装手表 App 时还有 HimawariWatch、HimawariWatchWidgets 两个目标），各自在 Signing & Capabilities 里把 Team 选成你的 Apple ID。...分享扩展、Safari 扩展、灵动岛和手表的编号都由工程级的 `HIMAWARI_BUNDLE_PREFIX` 拼出来。...改工程级的 HIMAWARI_BUNDLE_PREFIX 这一处即可...
```

```text
// clients/apple/App/Himawari.xcodeproj/project.pbxproj:985
DEVELOPMENT_TEAM = "";
// clients/apple/App/Himawari.xcodeproj/project.pbxproj:1009
DEVELOPMENT_TEAM = "";
```

**建议**：把 `HimawariListenActivity` 加进需要选 Team 的目标清单；把“改一处即可”改成“Bundle ID 只需改 `HIMAWARI_BUNDLE_PREFIX`，但如果要用自己的 Team，App Group 和钥匙串分组也要检查/修改”。

---

### 5. 低：给定对比基准不是功能提交的父提交，diff 混入了 PR 598 的反向改动

**文件:行**：`git diff 5206b1c9..3bda3cfe` 输出；`git show --stat fe2fd361`；`git log --oneline 5206b1c9..3bda3cfe`

**问题**：给定 diff 里出现了删除 `.agents/reviews/pr-598/*`、删除 `SenseDetailView` 的“只停同步/停同步并删除”确认框、删除 `SensesModel.serverCopyRemovable`、删除三种语言 `detail.stop*` 文案等改动。这些都不是 PR 611 的功能提交改的；`fe2fd361` 只动了 4 个文件，它的父提交是 `3633e576`，而 `5206b1c9` 是 `3633e576` 之上的 PR 598 合并提交。也就是说，PR 611 分支基于 PR 598 合并之前的主线。

**证据（读代码证实）**：

```text
$ git log --oneline 5206b1c9..3bda3cfe
3bda3cfe docs(review): PR 611 brief
fe2fd361 feat(apple): iPhone 目标的 Bundle ID 改用工程级前缀 HIMAWARI_BUNDLE_PREFIX

$ git show --stat fe2fd361
 .../apple/App/Himawari.xcodeproj/project.pbxproj   | 26 ++++++++++++----------
 clients/apple/App/Watch/Info.plist                 |  2 +-
 clients/apple/README.md                            |  4 ++--
 clients/apple/scripts/watch-ui-review.sh           |  2 +-
 4 files changed, 18 insertions(+), 16 deletions(-)
```

**推测**：正常情况下用三方合并把该分支合进当前 main，PR 598 的改动会保留，不会真的被回退；但如果有人把这份 `5206b1c9..3bda3cfe` 的 diff 当成补丁应用，就会连带删掉 PR 598 的内容。分支也缺少 PR 598 的上下文，合并时可能产生本可避免的冲突。

**建议**：先把分支 rebase/merge 到 `5206b1c9` 或当前 main，再以 `fe2fd361` 的真实父提交重跑 diff；复核和合并时不要把 PR 598 的反向差异算到 PR 611 头上。

---

## 侧重检查

- **错误路径**：`watch-ui-review.sh` 在用户按 README 改前缀后会走到 `simctl launch` 失败；脚本有 `set -euo pipefail`，但没有为这个情况给出可读的 `WATCH_UI_REVIEW_FAILED` 提示，只会输出 simctl 的错误。见第 2 条。
- **不合规范/不可信输入**：pbxproj 里的变量引用和引号本身没有问题；`HIMAWARI_BUNDLE_PREFIX` 是构建系统常量，不接受运行时输入。真正的外部输入边界在服务器：`runPolicy.applePush.topics` 必须接受新的 topic，否则登记返回 403。见第 1 条。
- **安全**：`iOS/Himawari.entitlements` 的 App Group 仍是 `$(HIMAWARI_APP_GROUP)`，钥匙串仍用 `$(AppIdentifierPrefix)$(HIMAWARI_KEYCHAIN_GROUP)`，没有跟着 bundle ID 写死；未发现新增的密钥暴露或权限扩大。手表 `WatchModel.swift:70` 用 bundle ID 派生钥匙串 service，改 ID 后旧 service 名下的配对数据不会被新 App 读到，但这是换新 App 身份的自然结果，不是安全漏洞。
- **资源耗尽/不可撤销**：没有循环、下载、写文件或删除操作。换 bundle ID 会让旧 App 的容器、旧 APNs 注册和旧钥匙串 service 名与新 App 断开，属于需要使用者重新安装/配对的不可逆副作用；仓库里没有迁移逻辑，也没有说明，建议在发布说明里提一句。
- **规则/文档/代码一致**：已核对 README 第 44、188 行与 pbxproj/Info.plist 的对应关系；`README:44` 的 Team 目标清单漏了 `HimawariListenActivity`（第 4 条）；`watch-ui-review.sh` 与 README 的“改一处即可”不一致（第 2 条）。`delivery-mode.md:26` 允许 fast mode 用 `Docs: deferred (fast mode)` 推迟完整文档校验，本提交的说明格式本身符合这条规则。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会改变。PR 611 的功能提交只改了 Xcode 工程、Watch 的 Info.plist、README 和一个 UI 复核脚本，没有改系统提示、工具定义、历史消息、遮盖或请求组装代码。给定的 `5206b1c9..3bda3cfe` 里虽然还有 `SenseDetailView.swift`、`SensesModel.swift` 和 `Localizable.strings` 的差异，但那是 PR 598 的反向差异，且都是客户端 UI/文案，不进入模型请求。按 [`prompt-prefix.md` 第 4、5 条](../../.agents/instructions/prompt-prefix.md#append-only)，这次改动没有触碰“已发内容只能追加”的路径；按第 2 条，也没有把每轮变化的值塞进系统提示或工具定义。结论：这次改动不改变请求开头，也不改变“会变的值放最后一条消息”的现状。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？**

不会。Bundle ID 是构建期确定的常量，同一份构建里每次请求都相同；它不参与出口遮盖、记忆选择、时间戳、工具顺序或任何 JSON 序列化。`watch-ui-review.sh` 里的环境变量只影响本地启动的 App，不进入模型请求。按 [`prompt-prefix.md` 第 10、11 条](../../.agents/instructions/prompt-prefix.md#deterministic)，这次改动没有引入依赖前后文的遮盖或无序遍历。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

没有。提交说明明确写 `Layer-0-tests: none`，改动里没有新增测试；`scripts/` 下也没有检查 pbxproj bundle ID 关系的脚本。现有推送测试夹具仍用旧 ID，例如 `test/integration/push-channels.test.ts:62` 的 `const TOPIC = "win.siyi.himawari";`，它们不会因为工程改成新前缀而失败，所以也不能算反向用例。因此“反向用例会失败”这件事目前不成立，因为没有反向用例。建议按第 3 条加文本级检查和反向夹具。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐个核对结果：

- **`HIMAWARI_BUNDLE_PREFIX`**：产生于 `project.pbxproj:745`（Debug）和 `:763`（Release），是工程级配置。被 14 处 `PRODUCT_BUNDLE_IDENTIFIER` 使用（主 App `:792/:817`、分享扩展 `:892/:918`、Safari 扩展 `:944/:970`、灵动岛 `:994/:1018`、手表 `:1044/:1071`、手表小组件 `:1099/:1127`），还被 `Watch/Info.plist:36` 的 `WKCompanionAppBundleIdentifier` 使用。静态核对：主 App 等于前缀；各扩展以主 App ID 加点开头；手表等于主 App ID + `.watchkitapp`；小组件等于手表 ID + `.widgets`；companion 等于主 App ID。Xcode 侧这些使用方都能接受这种变量展开，但能否真正通过签名/编译还没有 Mac 记录。
- **Mac 目标 ID**：`project.pbxproj:843/:868` 仍是 `win.siyi.himawari.mac`，没有被前缀改到，符合作者说法。
- **`watch-ui-review.sh` 的 `bundle`**：它不读工程配置，只读环境变量默认值，和工程是两份来源；按 README 改工程级前缀后它会用旧 ID。见第 2 条。
- **Apple 推送 topic**：服务器用 `runPolicy.applePush.topics` 校验登记 topic，而 topic 按 bundle ID 和 `.push-type.*` 派生；PR 没有同步允许清单。见第 1 条。生产是否启用 `applePush` 未核实。
- **测试夹具/文档**：`test/integration/*` 和 `packages/platform-node/test/startup-configuration.unit.test.ts:1638` 仍写着旧 topic，但它们是夹具，不会导致测试失败，也不会保护这次改动；README 的主 App/手表描述已更新，但漏了灵动岛目标的 Team 设置。见第 4 条。

结论：Xcode 工程内部的 ID 关系是自洽的；问题主要在两个非 Xcode 使用方（推送允许清单、UI 复核脚本）以及缺少自动检查。

---

## 结论

没有发现会直接破坏模型请求缓存、遮盖确定性或现有编译的高严重度代码错误。`project.pbxproj` 的变量引用、引号、Debug/Release 覆盖、Mac 目标隔离和扩展前缀关系从静态阅读看都是正确的。主要风险是：新的 Bundle ID 没有同步到 Apple 推送允许清单（条件性）、`watch-ui-review.sh` 维护了第二份 ID、没有自动检查且尚未在 Mac 上编译验证，以及给定 diff 基准选错导致混入 PR 598 的反向改动。
