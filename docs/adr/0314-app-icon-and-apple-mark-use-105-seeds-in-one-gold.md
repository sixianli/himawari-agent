---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/1bc2b8886e7af7292d87642d057a78c8788860d7/docs/adr/0308-sunflower-mark-seed-count-follows-its-size-except-the-chat-puck.md"
superseded_by: ""
date: "2026-11-28"
covers: "clients/apple/scripts/make-app-icons.mjs, clients/apple/App/Brand.xcassets/**, clients/apple/Sources/HimawariDesign/SunflowerSeeds.swift, clients/apple/Sources/HimawariDesign/Sunflower.swift, clients/apple/Sources/HimawariChat/ChatPuck.swift, clients/apple/Tests/HimawariManageTests/SunflowerSeedsTests.swift, docs/assets/apple-clients/2026-11-25-v4/tokens.json, test/tooling/apple-app-icon.test.mjs, scripts/render-brand-assets.mjs, assets/brand/himawari/README.md"
verified_at: "1bc2b8886e7af7292d87642d057a78c8788860d7"
---

# ADR 0314：App 图标和苹果端标志改成 105 粒一色金

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

本 ADR 取代 [ADR 0308](https://github.com/sixianli/himawari-agent/blob/1bc2b8886e7af7292d87642d057a78c8788860d7/docs/adr/0308-sunflower-mark-seed-count-follows-its-size-except-the-chat-puck.md)。2026-11-28 Andy 要 App 图标“使用更多的点”，或者重新出一批图标给他选。候选页（<https://claude.ai/artifact/BnX7DRAxGSgwZjbaE69D6d>）里有 89、105、120、144、233 粒五档，以及近看花盘、初升、点成花瓣、金底、一色金五种新构图。Andy 选了“105 粒，用 H（一色金）这一套风格”，看过图标和动效的预览（<https://claude.ai/artifact/J28tajuzhQMRPQKrDej8DD>）后说：“这一套我很喜欢，就这么做，就要这个”。

原来的配色是种子从花心的深褐经琥珀过渡到外圈的金色。一色金去掉这段过渡，所有种子同一种金色，只靠大小区分里外，花心最新的几粒仍用浅色，表示“刚长出来”。

105 不是斐波那契数。种子按黄金角一粒粒往外排，螺旋的形状只取决于黄金角，和总数无关；总数只决定最外圈在哪里收口。在图标大小下，105 粒和 89、144 粒的外圈看不出差别。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **App 图标用 105 粒、一色金。** iPhone 的浅色和深色外观都是深灰底 `#1e1d1d` 上一朵金色花盘，花盘占图标的 80%；着色外观是黑底上的灰度花盘，由系统染色；Mac 图标是带阴影的圆角方块，花盘占 64%；手表图标花盘占 88%。所有种子用向日葵金 `#f5b230`，最新的 6% 用浅金 `#ffecaa`。
2. **生成脚本搬出网页端。** 图标由 `node clients/apple/scripts/make-app-icons.mjs` 生成（需要 Chromium，可用环境变量 `CHROMIUM_PATH` 指定），种子数学写在这个脚本自己里，不再从 `apps/control-center` 导入，网页端删掉时不受影响。`scripts/render-brand-assets.mjs` 只剩网页的标志、标签页图标和 PWA 图标。
3. **App 里的标志也改成一色金。** 深色主题种子用 `#f5b230`、最新几粒用 `#ffecaa`；浅色主题种子用琥珀色 `#d27c12`、最新几粒用深金 `#9a6200`。向日葵金放在浅色背景 `#fcfcfb` 上对比只有 1.9:1，看不清；`#d27c12` 是 3.08:1，达到 WCAG 2.1 对图形的 3:1 最低要求（[WCAG 1.4.11 非文字对比度](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html)）。预览页上浅色用的是 `#d68014`，在 `#fcfcfb` 上只有 2.94:1，所以加深了一点。
4. **大标志用 105 粒，小标志的分档不变。** 显示直径 28pt 及以下 21 粒、29 到 46pt 34 粒、47 到 56pt 55 粒，这三档保留 ADR 0308 的理由：小尺寸下点太多会挤成一片。原来 57 到 72pt 的 89 粒和更大的 144 粒合成一档，改为 105 粒。
5. **主对话顶部毛玻璃小圆从 89 粒改为 105 粒。** 粒数仍写在设计 token `chat.puck.seeds`；忙时在七成和整朵之间来回，也就是 73.5 到 105 粒（画出 74 到 105 粒）。
6. **ADR 0308 的其余决定照旧：** 点多时每粒按 `√(55/粒数)` 变小、花盘大小不变；长满一盘约 16 秒；平时以十分之一速度慢慢长；系统打开“减少动态效果”时一律静止；`SunflowerMark` 按实际边长自动选粒数。
7. **网页端不改。** 网页按 [ADR 0309](0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md) 要删除，它的标志、标签页图标和 PWA 图标照 ADR 0308 原样保留，直到删除。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只加点、保留褐到金的过渡（89、144、233 粒）。** Andy 看过后选了一色金。233 粒在 11 月 15 日已被否过，缩小后看不出是向日葵。
- **新构图：近看花盘、初升、点成花瓣、金底。** 都放进了候选页，Andy 没选。
- **浅色主题也用向日葵金。** 对比度只有 1.9:1，花在白底上发虚，不用。
- **小标志也一律 105 粒。** 38pt 的聊天头像里每粒只有约 1.5pt，挤成一片；保留小尺寸分档。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 测试：`test/tooling/apple-app-icon.test.mjs` 检查生成脚本不引用网页端代码、图标是 105 粒、只有金和浅金两种颜色，并检查三端图标文件的尺寸和不透明；`clients/apple/Tests/HimawariManageTests/SunflowerSeedsTests.swift` 检查新分档、小圆 105 粒和呼吸范围、两个主题下除最新几粒外只有一种颜色，以及浅色种子对背景至少 3:1。
- Safari 扩展的图标由 `clients/apple/scripts/make-sunflower-svg` 调 `SunflowerSeeds` 生成，跟着变成一色金。
- 苹果端代码在云端线程里编译不了，合并前由 CI 的 iPhone 编译检查。
- 未测量：真机上 105 粒标志的帧率；原来的 144 粒档没有页面用到，89 粒的 Himawari 页头像改成 105 粒后每粒变小约 8%。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0308：标志按显示大小取种子数，主对话顶部小圆例外用 89 粒](https://github.com/sixianli/himawari-agent/blob/1bc2b8886e7af7292d87642d057a78c8788860d7/docs/adr/0308-sunflower-mark-seed-count-follows-its-size-except-the-chat-puck.md)（本 ADR 取代它）
- [ADR 0309：App 用通行密钥直接登录，网页整体删除](0309-apps-sign-in-with-passkeys-and-the-web-is-removed.md)
- [界面设计规范](../ui-ux-design-guide.md)
- [标志资源说明](../../assets/brand/himawari/README.md)

[↑ 返回阅读导航](#contents)
