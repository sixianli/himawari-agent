---
status: active
document_type: adr
decision_status: accepted
supersedes: docs/adr/0126-sunflower-mark-grows-233-seeds.md
superseded_by: ""
date: "2026-11-15"
---

# ADR 0283：标志的种子从 233 粒减到 55 粒，所有尺寸同一个点数；苹果三端 App 用它做桌面图标

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-11-15，Andy 发现装到 iPhone 上的 Himawari App 在桌面上没有图标（显示系统默认的空白图标）。查下来，main 上 iPhone、Mac、手表三个 App 都没有 App 图标资源集（`AppIcon.appiconset`），工程设置里也没有写图标名（`ASSETCATALOG_COMPILER_APPICON_NAME`），所以 Xcode 打包时根本没有图标可放。

同一天 Andy 说现在的标志“圆点数量太多了”，“当 logo 或者是 icon 很小的时候，就看不出来是个什么”。[ADR 0126](0126-sunflower-mark-grows-233-seeds.md) 定的标志在大图用 233 粒种子、小图用 89 粒；24px 以下 233 粒挤成一团，看不出一粒粒种子，也看不出向日葵。

线程先后出了六批全新造型（写实向日葵、扁平花瓣、字母和假名、抽象几何、细线、有体积的图标、家纹），Andy 都没有选，最后定下：“你用之前选定的那一个，然后把点弄少一点”。线程按同一套数学做了 233、89、55、34、21 五档对比（项目共享文件夹 `app-icon/logo-seed-counts-v7.html`，带动效），Andy 选“55 粒”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **标志的样子不变，只改种子数。** 仍然只由圆点构成；第 n 粒种子（从花心起）距中心 `19.7/√55 × √年龄`，角度 `n × 137.508°`（黄金角）；颜色按年龄从亮白金色（最新）经深褐、琥珀过渡到金色（最老）。种子数是 **55**（斐波那契数，花盘上顺时针 21 条、逆时针 34 条螺旋都还能看出来）。
2. **所有尺寸同一个点数。** 不再分大图 233 粒、小图 89 粒：网页的 `SunflowerMark` 去掉 `detail` 参数，苹果端的 `SunflowerMark` 去掉 `detail:` 参数和 `SunflowerDetail` 类型。
3. **种子按比例放大。** 点数少了，每粒放大到让花盘仍然铺满：半径从 `0.43 + 0.72 × √(年龄占比)` 改为 `0.8 + 1.33 × √(年龄占比)`（约为原来的 1.85 倍，即 `√(233/55) × 0.9`）。最老种子的淡出从 6 粒缩到 1.5 粒，免得外圈一大半都是半透明的。
4. **动效规则不变。** 仍然只有首页大图（每秒 0.35 粒）和正在回答的标志会长新种子，其余静止；系统开启“减少动态效果”时一律静止；全页共用一个逐帧计时器。正在回答时每秒长的粒数从 7 降到 3.4（`7 × √(55/233)`），否则 55 粒每 8 秒就整盘换一遍，看起来像在闪。苹果端 `SunflowerMark(growing:)` 用同一个速度。
5. **苹果三端的桌面图标。** 新建 `clients/apple/App/Brand.xcassets`，放两套图标：
   - `AppIcon`：iPhone 用一张 1024×1024，分浅色（米白底 `#fbf8f1`，最新的种子用 `#b8741a`，否则在浅底上像个洞）、深色（底色 `#1e1d1d`，和网页 PWA 图标相同）、着色（黑底灰度，系统按主人选的颜色上色）三种外观；Mac 用 16 到 1024 的十张，按 Apple 的 Mac 图标网格画成带阴影的圆角方块。
   - `WatchAppIcon`：手表一张 1024×1024，深色底，系统裁成圆形。
   三个 App 的 Debug 和 Release 配置都写上 `ASSETCATALOG_COMPILER_APPICON_NAME`，并把 `Brand.xcassets` 加进各自的资源。
6. **一处生成。** 网页标志文件（新的 `assets/brand/himawari/v4/logo-sunflower-disc.svg`）、4 张 PWA 图标和苹果三端的全部图标，都由 `node scripts/render-brand-assets.mjs` 用 `brand-seeds.ts` 的同一份种子数学生成；`v3/` 的 233 粒留作历史参照。Safari 扩展的葵盘和图标仍按 `clients/apple/README.md` 的命令从 `SunflowerSeeds.swift` 生成。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **大图保留 89 或 233 粒，只有小图减少。** 大图更细腻，但同一个标志在不同地方长得不一样，Andy 也只选了一个点数。放弃。
- **55 粒加小图 34 粒两档。** 16px 下 34 粒更清楚，但又回到两套点数；55 粒在 16px 下已经能看出一粒粒种子。放弃。
- **34 或 21 粒。** 小尺寸最清楚，但大图上螺旋感变弱，21 粒已经不像花盘。Andy 选了 55。
- **重新设计造型（花瓣、字母、几何、家纹等六批）。** Andy 都没有选。
- **图标背景全用深色。** 和网页 PWA 图标一致，但浅色模式的桌面上会很重；iOS 18 起图标可以分浅色、深色、着色三种外观，就各给一张。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 首页大图、侧栏、回答前的小标志、登录页、PWA 图标、Safari 扩展、苹果端各处和三端桌面图标，都是同一个 55 粒的花盘。
- 测试 `apps/control-center/test/brand.unit.test.ts` 改为检查 55 粒；`test/tooling/brand-asset.test.mjs` 检查 `v4` 文件与代码一致；新增 `test/tooling/apple-app-icon.test.mjs`，检查三个 App 的两种配置都写了图标名、资源里有 `Brand.xcassets`、资源集里列出的每张图都在且像素尺寸对、iPhone 和手表的图没有透明通道、iPhone 有浅色、深色、着色三种外观。反向验证：在 main 上（没有图标设置）这个测试失败，加上后通过。
- `npm run check:brand` 改查 `v4` 文件。
- 苹果端代码在云端线程里编译不了，合并前由 Mac 线程编译一次 iOS、Mac、手表三个 App，并在真机上看一眼桌面图标。
- 未测量：真机上首页大图的帧率和耗电（点数少了，只会更省）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0126：标志换成“生长”的向日葵](0126-sunflower-mark-grows-233-seeds.md)（本 ADR 取代它）
- [界面设计规范](../ui-ux-design-guide.md)
- [标志资源说明](../../assets/brand/himawari/README.md)

[↑ 返回阅读导航](#contents)
