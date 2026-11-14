<a id="apple-clients"></a>
# Himawari 苹果客户端

这里是 Himawari 的 iPhone App 和 Mac 菜单栏 App（以后还有 Apple Watch）。设计和分批见[详细设计](../../docs/execution/specs/2026-11-11-apple-device-body-design.md)和[实施计划](../../docs/execution/plans/2026-11-11-apple-device-body-plan.md)；界面照 Andy 2026-11-12 批准的原型第 2 版 `docs/assets/apple-clients/2026-11-12-v2/` 做（颜色、尺寸、字号由其中的 `tokens.json` 生成）。现在做到第 2 批（配对、对话列表、聊天）、第 6 批（分享面板、Safari 扩展）和第 10B 批（Mac 菜单栏 App）。

- [代码怎么分](#layout)
- [在 Mac 上构建、测试、装到 iPhone](#on-the-mac)
- [在云端跑单元测试](#in-the-cloud)
- [和服务器对齐的固定测试数据](#vectors)
- [图标](#icons)
- [截图对照原型](#ui-review)
- [分享面板和 Safari 扩展](#handover)
- [Mac 菜单栏 App](#mac-app)

<a id="layout"></a>
## 代码怎么分

`Package.swift` 是一个 Swift 包（Swift Package，苹果的代码打包方式，Xcode 能直接打开），分成几个目标（target，一个目标就是一块单独编译的代码）：

| 目标 | 放什么 | 谁维护 |
| --- | --- | --- |
| `HimawariCore` | 设备签名（按 RFC 9421，一种给 HTTP 请求签名的标准）、密钥（存在手机的安全芯片里）、配对、和服务器通信、事件流、待发消息队列、本地缓存。只用 Foundation，能在 Linux 上编译和测试 | 第 2 批 |
| `HimawariDesign` | 颜色（浅色深色两套）、Himawari 说的话用的衬线字、卡片、胶囊按钮、玻璃圆钮、页签栏、葵盘标志、图标 | 第 2 批；别的批要加共用组件先找第 2 批线程 |
| `HimawariChat` | 对话列表和聊天 | 第 2 批 |
| `HimawariManage` | 记忆、设置等管理页面；现在只有两个入口占位 | 第 11 批 |
| `HimawariShare` | 把东西“交给 Himawari”：分享面板、Safari 扩展的原生部分、两个入口的设置页 | 第 6 批 |
| `HimawariShell` | 三页签外壳、配对页、整个 App 的状态 | 第 2 批 |
| `HimawariMacUI` | Mac 菜单栏 App 的界面和逻辑（App 目标叫 `HimawariMac`）：菜单栏的向日葵和面板、⌥ 空格输入条、拖文件、动文件前的清单、唯一的设置页、配对窗口。只在 macOS 上编译 | 第 10B 批 |

`App/Himawari.xcodeproj` 是 App 本身的 Xcode 工程，有三个目标：App（入口文件 `App/iOS/HimawariApp.swift`）、分享扩展 `App/ShareExtension`、Safari 扩展 `App/SafariExtension`（扩展，extension，是 iOS 允许 App 嵌在别的 App 里出现的小部件）。其余代码都从上面的包里来。

[返回目录](#apple-clients)

<a id="on-the-mac"></a>
## 在 Mac 上构建、测试、装到 iPhone

需要 Xcode 26 或更新的版本，手机系统 iOS 26 或更新。现在用免费的 Apple ID 就能装到自己手机上（免费账号装的 App 7 天后要重新装一次）。

1. 在 Xcode 里打开 `clients/apple/App/Himawari.xcodeproj`。第一次打开会自动下载依赖的 `swift-crypto` 包，等左边栏不再转圈。
2. 左边栏点最上面的 Himawari 工程 → 中间 TARGETS 下的 Himawari、HimawariShareExtension、HimawariSafariExtension 三个目标，各自在 Signing & Capabilities 里把 Team 选成你的 Apple ID。如果提示 Bundle Identifier 被占用，把 `win.siyi.himawari` 改成别的（例如末尾加你的名字），两个扩展的 `win.siyi.himawari.share`、`win.siyi.himawari.safari` 前面要跟着改成一样的。三个目标共用一个 App Group（`HIMAWARI_APP_GROUP`，让 App 和扩展共用一块存储）和一个钥匙串分组（`HIMAWARI_KEYCHAIN_GROUP`，让扩展能用 App 配对时存的设备密钥），这两个值在工程级的构建设置里，改了 Bundle Identifier 时最好一起改。
   免费的 Apple ID 不支持 App Group，三个目标都签不过。这时在 Xcode 里把工程级构建设置 `HIMAWARI_APP_GROUP` 清空，并把 `HIMAWARI_ENTITLEMENTS_SUFFIX` 设成 `.keychain-only`（命令行是 `xcodebuild HIMAWARI_APP_GROUP= HIMAWARI_ENTITLEMENTS_SUFFIX=.keychain-only`），三个目标就只用钥匙串分组。代价是扩展和 App 不再共用存储：分享面板和 Safari 扩展传不上去时不会排队，会显示“没能确认传上，稍后再分享一次”（可能已经传上，只是没收到回复），要重新分享一次，同一内容可能因此收到两份；App 里“开或关”的开关和 Safari 的“已用过”记录也只写进 App 自己的存储，扩展看不到：扩展一直按默认开着，App 里关掉分享或 Safari 并不会让扩展停下，Safari 引导页也不会因为扩展用过而前进。付费账号用默认设置，不用改。
3. 用数据线连上 iPhone，窗口顶部的设备选你的 iPhone，按 ⌘R。第一次装完，在手机“设置 → 通用 → VPN 与设备管理”里信任你的开发者证书，再点开 App。
4. 跑单元测试：在 Xcode 里另外打开 `clients/apple/Package.swift`，顶部设备选 “My Mac”，按 ⌘U。全部通过是绿色对勾。

[返回目录](#apple-clients)

<a id="in-the-cloud"></a>
## 在云端跑单元测试

`HimawariCore` 不依赖界面，云端容器里装上 Linux 版 Swift（6.2 或更新）就能跑：

```bash
cd clients/apple
swift test
```

在 Linux 上包里只有 `HimawariCore` 和它的测试，界面目标只在苹果系统上编译（`Package.swift` 里按系统区分）。界面代码只能在 Mac 上的 Xcode 里编译和看。

[返回目录](#apple-clients)

<a id="vectors"></a>
## 和服务器对齐的固定测试数据

`Tests/HimawariCoreTests/Fixtures/signature-vectors.json` 由 `scripts/make-signature-fixture.mjs` 用 Node 生成：里面有两把测试用的 P-256 密钥、按服务器同样的做法拼出的签名原文和 Node 签出的签名，以及配对核对数字的期望值。Swift 测试核对三件事：拼出的签名原文和服务器一字不差；Node 签的签名 Swift 验得过；配对核对数字和服务器算的一样。改了签名规则或核对数字的算法，要重新生成：

```bash
node clients/apple/scripts/make-signature-fixture.mjs clients/apple/Tests/HimawariCoreTests/Fixtures/signature-vectors.json
```

这两把密钥只用于测试，不对应任何真实设备。

[返回目录](#apple-clients)

<a id="icons"></a>
## 图标

图标用 Tabler Icons（一套开源线条图标，MIT 许可证）的 outline 款，不用苹果自带的 SF Symbols。代码里只写名字，例如 `Icon(.message)`；颜色跟着文字色走。用到哪些图标、每个的线宽，写在 `scripts/icons.json`：常规的 1.6，返回、关闭、加号、小箭头 2.2。

要加图标：先在 `scripts/icons.json` 里加一行，再在 `Sources/HimawariDesign/Icon.swift` 的 `IconName` 里加同名的一项，然后重新生成：

```bash
mkdir -p /tmp/tabler && cd /tmp/tabler && npm pack @tabler/icons@3.35.0 && tar xzf tabler-icons-3.35.0.tgz && cd -
node clients/apple/scripts/make-icons.mjs /tmp/tabler/package clients/apple/Sources/HimawariDesign/Resources
```

脚本把每个 SVG 改好线宽后放进 `Icons.xcassets`（Xcode 的图片资源目录），按模板图片处理；许可证原文和版本号放进 `Licenses/`，以后的致谢页（第 11 批设置页）用 `ThirdPartyLicense.all` 读出来显示，第 2 批还没有界面用它。

[返回目录](#apple-clients)

<a id="ui-review"></a>
## 截图对照原型

界面要和 Andy 批准的原型逐屏对照。`App` 的调试版带一套示例数据（`Sources/HimawariShell/DemoScenes.swift`，只在调试版里编译）：启动参数 `-HimawariDemoScene <场景名>` 让 App 直接显示某一屏，不连服务器。场景名就是截图文件名，以原型图的编号开头（例如 `16-chat-states-3-sending`），`motion-` 开头的是动效录屏。示例数据的时钟固定在 2026-11-12 15:00，截静态图时关掉动效，所以每次截出来一样。

在 Mac 上一条命令（需要 Xcode 26 和 iPhone 16e 模拟器，宽 390 点）：

```bash
clients/apple/scripts/ui-review.sh
```

它建一个叫 “Himawari 390pt” 的模拟器，把状态栏固定成 9:41，编译调试版并装上，浅色、深色各截一遍全部场景（PNG 放 `clients/apple/ui-review/latest/`），并录下动效（微光、切页签、面板弹出、内容在玻璃下滚动；有 `avconvert` 时压成 960×540 的 MP4）。截图宽度不是 1170 像素（390 点 × 3）就报错停下。

设计线程验收通过后：

```bash
clients/apple/scripts/ui-review.sh --approve
```

把这批截图存进 `Tests/Snapshots/iPhone-390/`，成为快照。之后改界面时跑 `clients/apple/scripts/ui-review.sh --check`：重新截图，用 `scripts/compare-snapshots.swift` 逐像素比较，任一张图里颜色差超过 3/255 的像素多于 0.05%（约 1500 个像素，小于一个 44 点见方的图标）就报 `SNAPSHOT_DIFF` 并失败；快照少了哪个场景也失败。比这更小的局部改动拦不住，动效录屏不做自动比对，只交设计线程看。

[返回目录](#apple-clients)

<a id="handover"></a>
## 分享面板和 Safari 扩展

两条路把东西交给 Himawari，界面照原型“让 Himawari 感知”第 6 屏和“补画的几处”第 1、2 屏：

- 分享面板：在别的 App 里点分享 → Himawari。网页、链接、文字、图片都行；从 Safari 分享时用 `App/ShareExtension/PagePreprocessor.js` 读出这一页的全文。界面是 `HimawariShare` 里的 `HandoverSheet`。
- Safari 扩展：在 Safari 里点 Himawari，弹出的小面板是网页（`App/SafariExtension/Resources/` 下的 `popup.html`、`popup.css`、`popup.js`），它在你点的那一页执行 `page.js` 读出全文，再经 `background.js` 交给原生部分 `SafariWebExtensionHandler` 发给服务器。面板上的字也由原生部分给，和分享面板用同一份文案。

写了要它做什么，就开一个新对话，这一页作为附件；没写，就只存一条感知记录。没连上服务器时先排队，回到 App 时自动补交。

面板的颜色、尺寸都来自 `tokens.json`：`tokens.css` 由生成脚本产出，`npm run check:apple-design` 检查它是不是最新，并拦下面板代码里直接写的颜色和尺寸。改了 `tokens.json` 后：

```bash
node clients/apple/scripts/make-design-tokens.mjs docs/assets/apple-clients/2026-11-12-v2/tokens.json clients/apple/Sources/HimawariDesign/Generated/DesignTokens.swift clients/apple/App/SafariExtension/Resources/tokens.css
```

面板左上角的葵盘和扩展图标从 App 里画葵盘的同一套算法生成（`Sources/HimawariDesign/SunflowerSeeds.swift`）：

```bash
cd clients/apple
swiftc -o /tmp/make-sunflower-svg Sources/HimawariDesign/SunflowerSeeds.swift scripts/make-sunflower-svg/main.swift
/tmp/make-sunflower-svg full App/SafariExtension/Resources/images/sunflower.svg
node scripts/make-safari-icons.mjs App/SafariExtension/Resources/images/sunflower.svg App/SafariExtension/Resources/images 48 96 128 256 512
```

Safari 面板的截图不用模拟器：`node clients/apple/scripts/safari-panel-review.mjs [输出目录]` 用 Chromium 打开面板、模拟 Safari 的接口，浅色、深色各截一遍全部状态（默认放 `clients/apple/ui-review/safari-panel/`）。找不到浏览器时用 `HIMAWARI_CHROMIUM_PATH` 指定。`test/tooling/safari-panel.test.ts` 用同一套场景检查面板的行为。分享面板和两个设置页的截图走上一节的 `ui-review.sh`。

[返回目录](#apple-clients)

<a id="mac-app"></a>
## Mac 菜单栏 App

Mac 上只做原型 Version 46 画板“每一端做什么”里的六样，没有主窗口、聊天窗口和管理页。Xcode 工程里的 `HimawariMac` 目标就是它，入口文件 `App/macOS/HimawariMacApp.swift`，其余代码在 `Sources/HimawariMacUI/`。

- 配对：Mac 不扫码。在 iPhone 的 Himawari 里“设置 → 设备 → 添加设备”，点“Mac 不方便扫：发配对链接过去”，把配对链接（以 `himawari-pair:` 开头）发到 Mac 上。用隔空投送发来时，Mac App 认领 `himawari-pair` 这个链接开头：还没连上时直接打开配对窗口并填好，已经连上时不打开（只记下，下次打开配对窗口时填进去）；别的方式发来的，复制后窗口出现或 App 回到前台时会从剪贴板自动填进去，也可以手动粘贴。没有 iPhone 时也可以在网页设置里添加。
- 输入条：默认按 ⌥ 空格叫出，快捷键在设置页可改；被别的 App 占用时设置页写明。叫出的那一刻读一次前台 App、正在看的文件和选中的文字（读文件和选中文字要在“系统设置 › 隐私与安全性 › 辅助功能”里允许 Himawari），显示成可以点 × 拿掉的小条，发出前不再刷新。带着的东西先传到服务器换成引用，再照网页附件的格式（`<file name ref bytes kind/>` 标签，和 `apps/control-center/src/draft-attachments.ts` 逐字一致，固定测试数据由 `scripts/make-attachment-fixture.mjs` 从网页代码生成）接在正文后面发出。读不出文字的文件只传文件名和路径。
- 文件夹和网址规则在 `Sources/HimawariCore/MacAccess.swift`：路径先解开符号链接和 `..` 再按路径分段和允许的文件夹比，只读文件夹不许改；网址只许 `https` 加主机名单。
- Mac 上的短信：设置页这个开关打开、并在“系统设置 › 隐私与安全性 › 完全磁盘访问权限”里允许 Himawari 后，按心跳间隔从 `~/Library/Messages/chat.db`（信息 App 的数据库）只读地取打开之后的新消息，每条传成一条 `message.text` 感知记录（`POST perception`，每批条数取服务器配置 `device.perception.batch_records`）。打开时从最新一条开始，不补读以前的；关掉就停，并忘掉读到哪里，再打开也不补关着那段。不发消息，也不标已读。正文为空时从 `attributedBody` 列（信息 App 用 NSArchiver 存的富文本）里取：不用系统的反序列化，而是 `Sources/HimawariCore/TypedStreamText.swift` 只按长度取出其中的文字，数据不对就跳过这一条，不会让 App 崩溃。读数据库在后台进行，不卡界面。一批里每条都被服务器拒收时不往后挪，等下次再试；只有个别被拒才跳过那几条。发出去的消息不带对方号码当发件人。表结构不事先假定：每次先用 `PRAGMA table_info` 读出 `message`、`handle` 两张表有哪些列，可有可无的列缺了就退一步（例如没有 `handle` 就不带发件人），`guid`、`date`、`service` 缺了就不读，并在设置页写明缺哪几列。没有完全磁盘访问权限、打不开数据库、传不上去、服务器还不收，设置页那一行都写明，不静默失败。读表的代码在 `Sources/HimawariMacUI/MessagesDatabase.swift`，转成记录的规则在 `Sources/HimawariCore/MessageSensing.swift`。

截图：

```bash
clients/apple/scripts/mac-ui-review.sh
```

它编译调试版，用启动参数 `-HimawariMacDemo <文件夹>` 让 App 按 `Sources/HimawariMacUI/MacDemoScenes.swift` 里的示例数据把每一屏画成 PNG（浅色、深色各一张），放到 `clients/apple/ui-review/mac-latest/`，少一张就报错。

[返回目录](#apple-clients)
