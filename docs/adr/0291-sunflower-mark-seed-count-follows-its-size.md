---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/383003adb908eda96f097796905caaa5a4b705dd/docs/adr/0283-sunflower-mark-keeps-55-seeds-and-apps-get-icons.md"
superseded_by: ""
date: "2026-11-25"
covers: "apps/control-center/src/components/brand-seeds.ts, apps/control-center/src/components/brand.tsx, apps/control-center/test/brand.unit.test.ts, apps/control-center/public/favicon.svg, assets/brand/himawari/README.md, assets/brand/himawari/v4/logo-sunflower-disc.svg, clients/apple/Sources/HimawariDesign/SunflowerSeeds.swift, clients/apple/Sources/HimawariDesign/Sunflower.swift, clients/apple/Tests/HimawariManageTests/SunflowerSeedsTests.swift, scripts/render-brand-assets.mjs, scripts/check-brand-assets.mjs, test/tooling/apple-app-icon.test.mjs, test/tooling/brand-asset.test.mjs"
verified_at: "383003adb908eda96f097796905caaa5a4b705dd"
---

# ADR 0291：标志按显示大小取种子数，小图点少、大图点多

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0283](https://github.com/sixianli/himawari-agent/blob/383003adb908eda96f097796905caaa5a4b705dd/docs/adr/0283-sunflower-mark-keeps-55-seeds-and-apps-get-icons.md) 定的是“所有尺寸同一个点数，55 粒”。2026-11-25 Andy 看了 iPhone 上主对话的小头像（38pt）和“她的页面”的大头像（58pt）后说：“放大的情况下使用点多一点的 logo，缩小的情况下使用点少一点的 logo。目的是什么呢？目的是无论这个 logo 放大还是缩小，在人眼里看过去的视觉效果都是一致的。”

固定 55 粒时，种子的大小跟着标志一起缩放：38pt 的头像里最大的一粒直径约 3.5pt，58pt 的头像里约 5.3pt，72pt 的大图里约 6.6pt。小图里点挤成一片，大图里点又显得粗。人眼判断“是不是同一个图案”看的是每粒点的实际大小和点与点的间距，所以要让这两样在各个尺寸下大致不变。

业界做法：字体的“光学尺寸”（Apple 的 SF Pro 分 Text 和 Display 两套字形，按字号自动切换，见 [Apple 字体说明](https://developer.apple.com/fonts/)；OpenType 的 `opsz` 轴，见 [OpenType 规范](https://learn.microsoft.com/en-us/typography/opentype/spec/dvaraxistag_opsz)）就是同一个思路：小字号用更粗、更疏的字形，大字号用更细、更密的字形，让不同大小看起来是同一个字体。图标也一样，Apple 的人机界面指南要求小尺寸图标简化细节，见 [Apple 人机界面指南：App 图标](https://developer.apple.com/design/human-interface-guidelines/app-icons)。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **种子数按标志的显示直径分档。** 粒数取最接近 `(半径 ÷ 3.2pt)²` 的斐波那契数，保持向日葵的螺旋感：

   | 显示直径 | 种子数 | 用在哪里 |
   | --- | --- | --- |
   | 28pt 及以下 | 21 | 网页侧栏和回答前的小标志（24px）、网页标签页图标 |
   | 29 到 46pt | 34 | iPhone 主对话头像（38pt） |
   | 47 到 56pt | 55 | 网页打开页（56px）、App 桌面图标（花盘约占图标的 78%） |
   | 57 到 72pt | 89 | iPhone“她的页面”头像（58pt）、网页首页大图（72px） |
   | 72pt 以上 | 144 | 更大的展示图 |

2. **种子随点数变小或变大，花盘大小不变。** 花盘半径仍是 19.7（48 宽的画布里）；第 n 粒距中心 `19.7/√粒数 × √年龄`，半径在 ADR 0283 的 `0.8 + 1.33 × √(年龄占比)` 上再乘 `√(55/粒数)`，所以点越多每粒越小，点间距和每粒占的面积成比例。
3. **生长动画按总时长不变来定速度。** 正在回答时每秒长 `粒数 ÷ 16` 粒（55 粒时约 3.4 粒，和原来一样），不管哪个大小，长满一整盘都约 16 秒，看起来节奏一致；网页首页大图慢慢长的速度是这个的十分之一。系统打开“减少动态效果”时一律静止，不变。
4. **由显示大小自动决定，调用方不用传参数。** 苹果端 `SunflowerMark` 在画布里按实际边长选粒数；网页 `SunflowerMark` 在页面排版后量出 SVG 的实际大小再选，尺寸变化时重新选。两端用同一张表（`SunflowerSeeds.seedCount(forDiameter:)` 和 `seedCountFor`）。
5. **网页标签页图标用 21 粒。** 新增 `apps/control-center/public/favicon.svg`，由 `node scripts/render-brand-assets.mjs` 用同一份种子数学生成，`npm run check:brand` 检查它和代码一致。
6. **ADR 0283 的其余决定照旧：** 苹果三端桌面图标、PWA 图标和 `assets/brand/himawari/v4/logo-sunflower-disc.svg` 仍是 55 粒（它们的花盘显示直径落在 55 粒那一档），由同一个脚本生成；配色、黄金角、淡出、只在表达状态时才动，都不变。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **保持所有尺寸 55 粒。** 实现最简单，但正是 Andy 指出的问题：小图挤、大图粗。放弃。
- **调用方手动传粒数（例如 `SunflowerMark(seeds: 34)`）。** 每处都要记得传对，改了大小也容易忘记改粒数。按实际大小自动选更不容易出错。放弃。
- **连续地按大小算粒数（不取斐波那契数）。** 大小一变粒数就跟着变，向日葵的两组螺旋会断开、看起来乱。只用斐波那契数分档。
- **动画保持每秒 3.4 粒。** 144 粒的大图要 40 多秒才长满，看起来比小图慢很多；21 粒的小图 6 秒就换一盘，像在闪。改为总时长不变。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- iPhone 主对话头像变成 34 粒、“她的页面”头像变成 89 粒，两处最大的一粒直径都约 4.3pt；网页侧栏小标志变成 21 粒、首页大图变成 89 粒。
- 测试：`clients/apple/Tests/HimawariManageTests/SunflowerSeedsTests.swift` 检查分档、每档静止时画出的粒数、点多时每粒更小而花盘大小一致、每档长满一盘都是 16 秒；`apps/control-center/test/brand.unit.test.ts` 检查同样几点，并检查标志按量出的实际大小选粒数（72px 时画出 89 粒）。
- 网页标志第一次画出时还没量过大小，先按最小的 24px（21 粒）画，排版后、浏览器绘制前立刻换成正确的粒数，用户看不到切换。
- 苹果端代码在云端线程里编译不了，合并前由 CI 的 iPhone 编译检查。
- 未测量：真机上 144 粒大图的帧率（目前没有用到 72pt 以上的标志）。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0283：标志的种子从 233 粒减到 55 粒](https://github.com/sixianli/himawari-agent/blob/383003adb908eda96f097796905caaa5a4b705dd/docs/adr/0283-sunflower-mark-keeps-55-seeds-and-apps-get-icons.md)（本 ADR 取代它）
- [界面设计规范](../ui-ux-design-guide.md)
- [标志资源说明](../../assets/brand/himawari/README.md)

[↑ 返回阅读导航](#contents)
