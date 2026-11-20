### 1、高：既有 tooling 检查会被这次改动弄红，PR 没有同步修改测试
- 文件:行：`test/tooling/apple-entitlement-variants.test.ts:8-10,19-21,30-33`；`clients/apple/App/Watch/Himawari.keychain-only.entitlements:4-5`；`clients/apple/App/WatchWidgets/WatchWidgets.keychain-only.entitlements:4-5`；`clients/apple/App/Watch/Himawari.entitlements:5-8`；`clients/apple/App/WatchWidgets/WatchWidgets.entitlements:5-8`。
- 问题：测试只匹配带引号的 `CODE_SIGN_ENTITLEMENTS`。这次把手表和小组件改成带引号的模板后，参与匹配的模板从 3 个变成 5 个；测试要求每个完整权限文件同时含 `application-groups` 和 `keychain-access-groups`，每个 `.keychain-only` 也必须含 `keychain-access-groups`。手表/小组件的完整文件只有 App Group，新增的两个 `.keychain-only` 是空字典，因此测试必然失败。
- 证据（读代码证实，未实际执行 vitest）：
  - `const lines = [...project.matchAll(/CODE_SIGN_ENTITLEMENTS = "([^"]+)";/gu)]`
  - `expect(full).toContain("keychain-access-groups");`
  - `expect(keychainOnly).toContain("keychain-access-groups");`
  - 新增文件只有 `<dict>` / `</dict>`，没有 `keychain-access-groups`。
  - 改动前手表/小组件两行不带引号，不进入这个正则；改动后才第一次进入，所以这是本次改动直接暴露的失败。
- 建议：如果手表/小组件确实需要共享钥匙串，给完整和 `.keychain-only` 两种文件补 `keychain-access-groups`；但从 `WatchModel.swift:70-72` 看手表用的是默认钥匙串组、没有传 accessGroup，更合理的做法是改测试为按目标核对实际需要的键，同时保留“`.keychain-only` 不得含 `application-groups`”。另外正则应同时匹配不带引号的赋值，避免再漏检。
- 作者说法与代码不一致：作者说“云端只能跑 swift test”，但这条检查是 Node/vitest，Linux 上可跑（`package.json:99` 的 `test:tooling`，`ci/policy.json:232-234` 的 tooling 项目），CI 的 tooling 作业会执行它。

### 2、中：免费签名说明没让用户给手表和小组件目标选 Team，按文档操作仍可能签不过
- 文件:行：`clients/apple/README.md:42`、`clients/apple/README.md:167`；`clients/apple/App/Himawari.xcodeproj/project.pbxproj:1035,1063,1091,1119`。
- 问题：README 的签名步骤只列了 `Himawari`、`HimawariShareExtension`、`HimawariSafariExtension` 三个目标；新增的“手表装到真机”一段也只说选 `Himawari` 方案。但 `HimawariWatch` 和 `HimawariWatchWidgets` 的 `DEVELOPMENT_TEAM` 仍为空。即使 App Group 不再挡签名，这两个目标仍需要 Team 和描述文件，免费账号按现有文档操作还可能在签名阶段失败。
- 证据（读代码证实）：工程里四个手表/小组件配置都有 `DEVELOPMENT_TEAM = "";`；README:42 明确只让选三个目标的 Team。
- 推测（未核实）：Xcode 在真正 Run 时可能弹窗要求选 Team，用户可现场补上；但文档没有覆盖这条路径，不能据此认定“照文档就能装”。
- 建议：把 `HimawariWatch`、`HimawariWatchWidgets` 加进选 Team 的步骤，并说明免费账号改 Bundle Identifier 时这两个目标也要改；最好在 Mac 上用免费账号实际跑一次 `xcodebuild -scheme Himawari`。

### 3、中：README 的“清空 HIMAWARI_APP_GROUP”对手表和小组件目标无效
- 文件:行：`clients/apple/README.md:43`、`clients/apple/README.md:167`；`clients/apple/App/Himawari.xcodeproj/project.pbxproj:745,762`、`:1037,1065,1093,1122`；`clients/apple/App/Watch/Info.plist:31-32`；`clients/apple/App/WatchWidgets/Info.plist:23-24`。
- 问题：工程级的 `HIMAWARI_APP_GROUP` 是 `group.win.siyi.himawari`，但手表和小组件在目标级又各自写了一遍同样的值，目标级会覆盖工程级。README 让用户在 Xcode 里清空“工程级”设置，手表和小组件的 `Info.plist` 仍然会写入 `group.win.siyi.himawari`，并没有真正清空。签名不再因为权限文件失败，但运行时仍会尝试使用一个没有授权的 App Group。
- 证据（读代码证实）：
  - 工程级：`HIMAWARI_APP_GROUP = group.win.siyi.himawari;`
  - 手表目标级：同样四行覆盖值。
  - `HimawariAppGroup` 在手表/小组件 Info.plist 里都是 `$(HIMAWARI_APP_GROUP)`。
- 推测（未核实）：`WatchComplicationStore` 用 `UserDefaults(suiteName:)` 且对返回值做了 `guard`（`Sources/HimawariCore/WatchGlance.swift:309-320`），真机上大概率不会崩溃，但可能读不到共享状态，实际行为没有在手表上验证。
- 建议：删掉手表/小组件目标级的四行 `HIMAWARI_APP_GROUP`，让它们继承工程级值；付费默认仍是同一个 `group.win.siyi.himawari`，默认行为不变，而免费签名时工程级清空才能传播下去。或者明确要求用 `xcodebuild HIMAWARI_APP_GROUP=` 或逐个目标改，并把 README 的“三个目标”改成实际目标数。

### 4、低：README 把 Bundle ID 的改法写成“同一个前缀”，且工程里实际有 5 处需要同步
- 文件:行：`clients/apple/README.md:167`；`clients/apple/App/Himawari.xcodeproj/project.pbxproj:791,817,1045,1073,1102,1131`；`clients/apple/App/Watch/Info.plist:35-36`。
- 问题：`WKCompanionAppBundleIdentifier` 必须精确等于 iPhone App 的 Bundle Identifier，不能只是“同一个前缀”；手表应是 iPhone Bundle ID 加 `.watchkitapp`，小组件应是手表 Bundle ID 加 `.widgets`。另外 Debug/Release 各有独立设置，`pbxproj` 里至少 5 处要同步，不只是“三处”。仓库里没有自动检查保证 companion、手表、小组件的 ID 和 iPhone ID 前缀一致。
- 证据（读代码证实）：`WKCompanionAppBundleIdentifier` 是硬编码的 `win.siyi.himawari`；手表 `PRODUCT_BUNDLE_IDENTIFIER` 是 `win.siyi.himawari.watchkitapp`；小组件是 `win.siyi.himawari.watchkitapp.widgets`；iPhone 目标也有 Debug/Release 两处。
- 建议：README 写出精确映射（iPhone ID、iPhone ID + `.watchkitapp`、手表 ID + `.widgets`），不要只说“同一个前缀”；并考虑把 companion 改成从构建设置派生，或在 tooling 检查里校验这几个 ID 的一致性。

**侧重检查**

- 错误路径：检查了 suffix 为空、`.keychain-only`、文件路径和文件存在性；路径本身能解析到新文件，但文件内容不满足既有关卡。
- 权限与安全：这次改动移除了手表/小组件的 App Group 权限，方向正确；手表钥匙串使用默认 access group（`WatchModel.swift:70-72`，`KeychainValueStore` 未传 accessGroup），小组件不直接读钥匙串，没有发现新增秘密、网络输入或提权。
- 资源耗尽、不可撤销操作：本 diff 没有运行时循环、删除/覆盖数据或部署操作，不适用。
- 规则、说明文档和代码一致性：README 与 `pbxproj` 在 Team、`HIMAWARI_APP_GROUP`、Bundle ID 三处不一致，已分别列为意见 2、3、4。
- 未核实：无法在当前 Linux 环境编译 Xcode 工程或装真机；未实际执行 vitest（只能读代码推演）；未核实手表真机上未授权 App Group 的 `UserDefaults` 行为，也未核实 Xcode 对空 Team 是否自动提示。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 只改 `clients/apple/App` 的 Xcode 工程、两个 entitlements 和 README，没有改系统提示、工具定义、历史消息、遮盖或请求组装代码；没有新增每轮变化的值，也没有把任何内容插到历史中间。发给模型的内容仍由未改动的请求层决定，本改动没有触碰“只在末尾追加”的路径。本次未运行 `check:prompt-prefix`，但它与本改动无交集。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 不会。新增的只是构建期确定性的权限文件路径替换，不参与模型请求序列化；没有新增时间、哈希、随机值、无序集合或依赖前后文的遮盖规则。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 没有新增自动检查，作者也写了 `Layer-0-tests: none`。既有的 `test/tooling/apple-entitlement-variants.test.ts` 会覆盖这些文件，但这次改动会把它弄红（见意见 1）。该测试没有新增反向夹具；它的 `not.toContain("application-groups")` 理论上能在 `.keychain-only` 混入 App Group 时失败，但没有 fixture 证明这条路径，而且本次实际失败的是 `toContain("keychain-access-groups")`，不是 App Group 反向用例。该检查是 Node/vitest，Linux 可运行，CI tooling 作业会跑，所以“云端只能跑 swift test”的说法不成立。

4. **每个值的产生处和使用处是否都能接受？**
   - `HIMAWARI_ENTITLEMENTS_SUFFIX`：产生于工程级两处配置（`project.pbxproj:746,763`），消费者是 5 个 target 的 `CODE_SIGN_ENTITLEMENTS`。默认空串能解析回原文件，Xcode 可接受；`.keychain-only` 能解析到新文件，但 tooling 测试不接受其内容。
   - 新增 `.keychain-only` 文件：Xcode 签名能接受空字典，但既有测试要求 `keychain-access-groups`，两端不一致；而且文件名叫 keychain-only、内容是空字典，与 iOS/分享/Safari 现有的 keychain-only 文件（含钥匙串组）不一致。
   - `HIMAWARI_APP_GROUP`：工程级和目标级都在产生；消费者是手表/小组件 Info.plist 和完整 entitlements。免费签名按 README 清空工程级时，目标级覆盖导致手表/小组件 Info.plist 仍带 App Group，文档与代码两端不一致。
   - Bundle ID / `WKCompanionAppBundleIdentifier`：产生处是 `pbxproj` 的多个 `PRODUCT_BUNDLE_IDENTIFIER` 和硬编码的 `Watch/Info.plist`；README 说“三处/同一个前缀”，没有自动检查两端一致。用户按文档改时可能漏掉 Debug/Release 或把 companion 改错。
   - `DEVELOPMENT_TEAM`：手表/小组件的产生处是空字符串，README 的免费签名步骤没有要求设置它，按文档操作仍可能签不过。

结论：默认付费构建的权限文件路径确实和原来一致，这一点作者说得对；但“这次改动只影响免费签名、不会破坏其他检查”不成立，既有 tooling 测试会失败，免费签名文档也没有覆盖 Team 和 `HIMAWARI_APP_GROUP` 的目标级覆盖问题。
