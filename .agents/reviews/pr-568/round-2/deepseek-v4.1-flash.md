本轮复核范围：`git diff 67f73fa9..0c2d0ff3` 实际只改了 `clients/apple/App/Himawari.xcodeproj/project.pbxproj`、`clients/apple/README.md`、`test/tooling/apple-entitlement-variants.test.ts`，另有 `.agents/reviews` 记录；上一提交引入的两个 `.keychain-only` 权限文件也一并核对。未运行 vitest 或 Xcode（本轮只能用读取和 git 命令），以下“已核实”均为静态读码结论。

### 1、中（未核实，基准里已有）：iOS 目标重复的 `CODE_SIGN_ENTITLEMENTS` 可能让主 App 的 `.keychain-only` 不生效
文件:行：`clients/apple/App/Himawari.xcodeproj/project.pbxproj:777`、`:784`、`:803`、`:810`；`test/tooling/apple-entitlement-variants.test.ts:8`。

问题：同一个 `buildSettings` 字典里，iOS Debug 和 Release 各写了两次 `CODE_SIGN_ENTITLEMENTS`：第一次是静态 `iOS/Himawari.entitlements`，第二次才是带 `HIMAWARI_ENTITLEMENTS_SUFFIX` 的路径。测试正则只匹配带引号的值，因此完全看不见前一条。

证据（读代码证实）：
```text
777: CODE_SIGN_ENTITLEMENTS = iOS/Himawari.entitlements;
784: CODE_SIGN_ENTITLEMENTS = "iOS/Himawari$(HIMAWARI_ENTITLEMENTS_SUFFIX).entitlements";
803: CODE_SIGN_ENTITLEMENTS = iOS/Himawari.entitlements;
810: CODE_SIGN_ENTITLEMENTS = "iOS/Himawari$(HIMAWARI_ENTITLEMENTS_SUFFIX).entitlements";
8: const lines = [...project.matchAll(/CODE_SIGN_ENTITLEMENTS = "([^"]+)";/gu)]...
```
这不是本次增量引入的（基准 `0c738f3b` 里已有），本次也没有改这两行；但如果 Xcode 解析重复键时取第一条，主 App 在免费签名下仍会用完整权限文件，README 里“App、分享扩展、Safari 扩展三个目标只用钥匙串分组”就不成立。

推测：Xcode 对重复键取第一条还是最后一条，本轮没有 Mac 环境，未核实。

建议：删掉 `:777`、`:803` 的静态重复行；测试改为明确列出期望的五个模板，并对未加引号、重复键或缺失目标报错，而不是只靠正则在现有文本里“能抓到几条算几条”。

### 2、低：README 仍把工程说成“三个目标”，与新增手表目标和免费签名后果不一致
文件:行：`clients/apple/README.md:32`、`:42`、`:43`。

问题：增量在 `:42` 加了“要装手表 App 时还有 HimawariWatch、HimawariWatchWidgets 两个目标”，但同一段仍写“三个目标共用一个 App Group”“免费的 Apple ID 不支持 App Group，三个目标都签不过”“三个目标就只用钥匙串分组”。代码已经让清空工程级 `HIMAWARI_APP_GROUP` 影响到手表和小组件，实际会失败/改变行为的是五个安装目标，而不是三个。

证据（读代码证实）：
```text
42: ...三个目标（要装手表 App 时还有 HimawariWatch、HimawariWatchWidgets 两个目标）...
42: ...三个目标共用一个 App Group...
43: 免费的 Apple ID 不支持 App Group，三个目标都签不过。...三个目标就只用钥匙串分组。
```
手表段落 `:167` 单独说明了手表和小组件用空权限文件，因此不是完全没写，只是第 2 步的“三个目标”会误导。

建议：第 2 步改成“五个目标”（或明确区分“三个 iPhone 目标”和“两个手表目标”），并说明手表/小组件在免费签名下用的是空权限文件，不是钥匙串分组。

### 3、低：新增测试只数 `HIMAWARI_APP_GROUP` 的总数，不能证明它只在工程级
文件:行：`test/tooling/apple-entitlement-variants.test.ts:47-50`。

问题：测试标题说“leaves HIMAWARI_APP_GROUP only at project level”，但断言只检查全工程文件里出现 2 次。当前工程级恰好 2 次（`project.pbxproj:745`、`:762`），所以能通过；如果把工程级的一条挪到某个目标级、总数仍为 2，测试也会通过，小组件的清空行为会再次失效。

证据（读代码证实）：
```text
47: it("leaves HIMAWARI_APP_GROUP only at project level so clearing it reaches every target", () => {
48:   const all = [...project.matchAll(/HIMAWARI_APP_GROUP = ([^;]*);/gu)];
49:   expect(all.length).toBe(2);
50: });
```
另外，`test/tooling/apple-entitlement-variants.test.ts:8-18` 的模板提取在某个目标的两份配置都变成不带引号时会静默少一个模板，`lines.length === templates.length * 2` 仍然成立，该目标就不再被检查。

建议：解析或按目标配置块核对，断言四个手表/小组件目标配置里没有 `HIMAWARI_APP_GROUP`，并断言五个模板都实际出现在测试集合里；不要只用总数和 `>= 3`。

### 4、低：作者说法不完整，增量还从四个目标配置里删掉了 `HIMAWARI_APP_GROUP`
文件:行：`clients/apple/App/Himawari.xcodeproj/project.pbxproj` 中手表 Debug/Release 和小组件 Debug/Release 四处（当前 `:1032-1037`、`:1059-1064`、`:1086-1091`、`:1114-1119`）。

问题：作者说“只改了手表和小组件各两处（Debug/Release）的 `CODE_SIGN_ENTITLEMENTS`”，但增量 diff 同时删除了这四处目标级的 `HIMAWARI_APP_GROUP = group.win.siyi.himawari;`。这次删除正是让“清空工程级 `HIMAWARI_APP_GROUP`”对手表生效的关键，反而是上一轮意见 3 的修复内容，PR 描述漏掉了。

证据（读代码证实，`git diff 67f73fa9..0c2d0ff3`）：
```diff
-                HIMAWARI_APP_GROUP = group.win.siyi.himawari;
                 HIMAWARI_RELEASE_CHANNEL = direct;
```
在手表和小组件各两个配置里共四行。

建议：更新 PR 描述，明确写出“删除四个目标级 `HIMAWARI_APP_GROUP` 覆盖，改为继承工程级值”；否则复核者会误以为清空工程级仍然到不了手表。

**上一轮意见逐条核对**
- 意见 1（tooling 检查会红）：已改好。测试现在对 `Watch/`、`WatchWidgets/` 跳过 keychain 断言，静态逻辑上能通过；但覆盖盲区见上面第 1、3 条。
- 意见 3（README 清空 App Group 对手表无效）：功能层面已改好。目标级 `HIMAWARI_APP_GROUP` 已删除，清空工程级值后手表和小组件会继承空值；README 仍有“三个目标”的措辞问题，见第 2 条。
- 意见 2（免费签名没让用户选手表 Team）：已改好。`README:167` 已写 HimawariWatch、HimawariWatchWidgets 也要选 Team，工程里手表配置仍是 `DEVELOPMENT_TEAM = ""`（`:1035`、`:1062`、`:1089`、`:1117`），需要用户自己选。
- 意见 4（Bundle ID 写成“同一个前缀”）：已改好。`README:167` 改成精确对应关系，实际值与代码一致：iPhone `:791`/`:817` 为 `win.siyi.himawari`，手表 `:1044`/`:1071` 为 `.watchkitjoin` 后缀（实际是 `.watchkitapp`），小组件 `:1099`/`:1127` 为 `.watchkitapp.widgets`，`Watch/Info.plist:36` 的 `WKCompanionAppBundleIdentifier` 为 `win.siyi.himawari`。唯一小问题是 `WKCompanionAppBundleIdentifier` 只有 Info.plist 一处，不在 Debug/Release 各一份。

**读代码证实的结论**
- 默认付费行为不变：工程级 `HIMAWARI_ENTITLEMENTS_SUFFIX = ""` 仍在 `:746`、`:763`；`HIMAWARI_APP_GROUP = group.win.siyi.himawari` 仍在 `:745`、`:762`；手表/小组件完整权限文件 `Watch/Himawari.entitlements`、`WatchWidgets/WatchWidgets.entitlements` 仍是原来的 App Group 文件。
- 免费签名路径存在：`Watch/Himawari.keychain-only.entitlements` 和 `WatchWidgets/WatchWidgets.keychain-only.entitlements` 都是空字典；`CODE_SIGN_ENTITLEMENTS` 对四个手表配置解析正确。
- 空 App Group 的下游消费端能接受：`Sources/HimawariWatchUI/WatchModel.swift:75-76` 和 `App/WatchWidgets/HimawariWatchWidgets.swift:13` 把空字符串传给 `WatchComplicationStore`，`Sources/HimawariCore/WatchGlance.swift:305-319` 用 `UserDefaults(suiteName:)`，空 suite 返回 nil 后 `save` 直接返回、`load` 返回 `.unknown`，不会崩溃，和 README“只显示向日葵”一致。
- 手表完整权限文件本来就没有 `keychain-access-groups`，所以空的 `.keychain-only` 文件没有改变手表的钥匙串访问方式；手表 `WatchModel.swift:72` 用的是默认钥匙串组。

**推测/未核实**
- Xcode 对 `:777`/`:784` 重复键的解析顺序未核实。
- 未在 Mac 上构建，未在真机上验证免费 Apple ID 的最终签名结果。
- 未运行 `apple-entitlement-variants.test.ts`；上面关于测试通过/失败的判断来自静态逻辑推演。

**侧重检查**
- 错误路径：权限文件不存在时 Xcode 会构建失败；测试会检查五个模板的完整文件和 `.keychain-only` 文件存在。缺口是测试可能静默漏掉某个目标（见第 1、3 条）。
- 不合规范/不可信输入：本轮改动没有接受运行时用户输入，也没有新增解析逻辑；README 的 Bundle ID 操作是人工输入，已核对与工程实际值一致。
- 安全：手表和小组件免费签名时去掉 App Group 只影响共享存储，不影响默认钥匙串；没有新增日志、网络请求或秘密暴露。手表完整权限文件本来就不含共享钥匙串组，故没有把钥匙串数据暴露给别的 App。
- 资源耗尽/不可撤销操作：不涉及。
- 规则/文档/代码一致性：发现 README“三个目标”与五个安装目标不一致，以及作者说法漏掉四处 `HIMAWARI_APP_GROUP` 删除；付费默认行为与代码一致。

**必答问题**
1. 不会改变模型已经见过的请求开头。本轮改动只涉及 Xcode 工程配置、README 和 tooling 测试，没有碰系统提示、工具定义、历史消息、遮盖或任何请求组装代码；不存在“只在末尾追加”或“每轮变值放在最后一条消息”的行为变化。依据：[prompt-prefix.md](../../.agents/instructions/prompt-prefix.md#rules)。
2. 不会让同一段文字在不同请求里变成不同字节。本轮没有序列化、遮盖、集合顺序或带时间字段的改动；新增的构建配置值不会进入模型请求。
3. 有自动检查，但反向用例不完整。`test/tooling/apple-entitlement-variants.test.ts` 会检查权限文件存在、完整文件有 App Group、`.keychain-only` 没有 App Group；重新把手表目标级的 `HIMAWARI_APP_GROUP` 加回来会使计数变成 3 而失败。但把工程级的一条挪到目标级且总数仍为 2 时不会失败；某个目标的两份配置都不带引号时会从模板集合静默消失，测试也不会失败（见第 1、3 条）。README 和真实 Xcode 构建没有自动检查。
4. 逐个核对了本轮产生/修改的值：
   - `HIMAWARI_ENTITLEMENTS_SUFFIX`：产生于工程级配置，被四个手表/小组件 `CODE_SIGN_ENTITLEMENTS` 使用，测试解析出的两个文件都存在，Xcode 使用端可接受。
   - `HIMAWARI_APP_GROUP`：现在只产生于工程级，被手表/小组件 Info.plist 的 `HimawariAppGroup` 和完整权限文件使用；空值在 `WatchComplicationStore` 中安全退化为不共享存储，和 README 一致。
   - Bundle ID / `WKCompanionAppBundleIdentifier`：README 的映射与实际工程值一致；若用户改 iPhone Bundle ID，需要同步修改手表、小组件和 Info.plist，测试没有自动核对这条人工操作。
   - 新增权限文件名：`Watch/Himawari.keychain-only.entitlements`、`WatchWidgets/WatchWidgets.keychain-only.entitlements` 均存在且为空字典，符合免费签名用途。
   - 新增的 `HIMAWARI_APP_GROUP` 删除：使用端是 Xcode 的工程级继承和 Info.plist 替换；按构建设置继承规则应生效，但实际构建未在 Mac 上验证。依据：[I-73](../../docs/incidents-and-gates.md#incidents) 的教训，这里两端的校验（测试与 Xcode）并不完全闭合，缺口已在第 1、3 条列出。
