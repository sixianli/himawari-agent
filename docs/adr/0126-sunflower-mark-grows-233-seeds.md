---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: docs/adr/0283-sunflower-mark-keeps-55-seeds-and-apps-get-icons.md
date: "2026-10-30"
---

# ADR 0126：标志换成“生长”的向日葵：233 颗种子按黄金角从花心长出，只有首页大图和正在回答的标志会动

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [业界做法](#industry)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-30，Andy 说线上的葵盘标志（96 颗种子，`apps/control-center/src/components/brand.tsx`）“还不够好看”，要求重新设计几版并带动效。线程在项目共享文件夹 `logo-redesign/` 里先后做了点阵呼吸、带花瓣、纯圆点花瓣、1005 点精细版、三批自由设计共十几版原型，Andy 逐版批注：

- 要求整个标志只由圆点构成，动效只靠每个点的大小和颜色，位置不动（第二轮）；
- 自由设计第一批里选了第 2 版“生长”（同日 17:14 记为备选，18:30 定稿）；
- 在“生长”的 7 个变体里选“原版精修”，再要求加入“向日葵按斐波那契螺旋排列”这个特性；
- 在 4 种让螺旋显出来的做法里选 **A：加密到 233 点**（17:52）。

原因：线上的 96 颗种子其实已经按黄金角排列，但点太稀、大小差太大，眼睛连不出螺旋线。233 是斐波那契数，和真实花盘的顺时针 13 条、逆时针 21 条螺旋一致。

线上现状：标志出现在侧栏左上角、首页中间、登录页、每条回答前、等待中的回答、加载页和 4 张 PWA 图标里。旧的动效是 CSS：忙碌时整体旋转加每个点放缩，首页大图在 90 秒里转一圈。

[↑ 返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

2026-10-30 实际打开的一手资料：

- MDN `prefers-reduced-motion`：“Indicates that a user has enabled the setting on their device for reduced motion”，设置用来让界面“removes, reduces, or replaces motion-based animations”，因为这类动画“can trigger discomfort for those with vestibular motion disorders”，缩放和平移大物体就是触发源。
- W3C WCAG 2.2 成功标准 2.3.3：“Motion animation triggered by interaction can be disabled, unless the animation is essential to the functionality or the information being conveyed.”
- MDN `requestAnimationFrame`：让浏览器“call a user-supplied callback function before the next repaint”，并且“paused in most browsers when running in background tabs or hidden `<iframe>`s, in order to improve performance and battery life”。

共同点：位置、缩放这类运动动画要能被系统设置关掉；逐帧动画用 `requestAnimationFrame`，浏览器会在页面不可见时自动暂停。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **标志的样子。** 只由圆点构成。第 n 颗种子（从花心起）距中心 `spacing × √age`，角度 `n × 137.508°`（黄金角）；颜色按年龄从亮白金色（最新）经深褐、琥珀过渡到金色（最老），大小随年龄变大，最老的几颗淡出。
2. **点数。** 首页大图、登录页、加载页用 **233 点**；侧栏、回答前这类 24px 左右的小标志用 **89 点**，点放大 25%。都是斐波那契数。
3. **谁会动。** 种子的位置每帧变化（新种子从花心长出，把老种子推向外圈），纯 CSS 做不出，所以用一个全页共用的 `requestAnimationFrame` 计时器（`joinGrowth`）逐帧更新。只有两类标志加入计时器：正在回答的标志（每秒长 7 颗种子）和首页大图（每秒 0.35 颗，几秒一颗新种子）。其余全部是静止的一张画：已完成的回答、侧栏、登录页。没有标志在动时，计时器一帧都不跑。
4. **减少动态效果。** 系统开启 `prefers-reduced-motion: reduce` 时，所有标志不加入计时器，保持静止。
5. **颜色。** 种子颜色不再跟浅色、深色主题的 12 档黄走，而是同一组固定颜色：深褐、琥珀、金色，这三种在深浅两种底色上都清楚。唯独最新的几颗种子（占比小于 6%）在深色底上是亮白金色，在浅色底上会像一个洞，所以给它们一个类名 `seed-new`，由 CSS 按主题取色（深色 `#ffecaa`，浅色 `#b8741a`）；PWA 图标固定在深色底上，用亮白金色。
6. **图标和资源。** 标志文件 `assets/brand/himawari/v3/logo-sunflower-disc.svg` 由 `scripts/render-brand-assets.mjs` 用同一份种子数学生成；3 张 PWA 图标和 `apple-touch-icon.png` 由同一个脚本在深色底（`#1e1d1d`）上渲染；`npm run check:brand` 检查 v3 文件和代码一致。
7. **基准。** 原型和真实网页截图存 `docs/assets/control-center/2026-10-30-v13/`，登记到 AGENTS.md 的基准列表；`v2/` 的 96 点葵盘留作历史参照。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **继续用 CSS 动画，只调点数和颜色。** 只能做大小、颜色、整体旋转，做不出“新种子从花心长出、老种子被推向外圈”，而这正是 Andy 选这一版的原因。放弃。
- **每个标志各自开一个逐帧循环。** 一屏里有很多条回答，每条前面一个标志，各开循环会让页面越来越慢。改为全页共用一个计时器，只有正在动的标志才加入。
- **让侧栏和已完成回答的标志也慢慢长。** 一屏上同时动的东西太多，也违背 UI 规范“颜色和动效只表达含义”：只有“正在回答”才该动。放弃。
- **1005 点精细版。** 花盘和花瓣最清楚，但 Andy 看过后仍不满意，且 1005 个圆每帧更新太重。放弃。
- **加花瓣、螺旋臂染色、年轮着色、日冕等变体。** 都在原型里做过，Andy 选了最朴素的“加密到 233 点”。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 小标志（89 点）和大标志（233 点）的 DOM 里分别有 91 和 235 个 `<circle>`（比点数多 2 个备用，长出新种子时复用），静止时不再有任何 CSS 动画；动起来时每帧直接改这些圆的属性，不经过 React 渲染。
- 测试 `apps/control-center/test/brand.unit.test.ts`：种子数、黄金角位置、新种子从花心向外、忙碌时位置逐帧变化、已完成回答和减少动态效果下计时器数为 0。反向验证：把“减少动态效果”判断拿掉，或让所有标志都加入计时器，对应测试失败。
- 门槛：`npm run check:brand`（`scripts/check-brand-assets.mjs`）在 `npm run check` 里；v3 文件被改动后失败，重新生成后通过。
- 真实网页验收（Chromium，`test/e2e/fixtures/control-center-browser-server.mjs` 假后端，1280 和 390 宽）：首页大图 233 个可见点且 3.5 秒内位置变化；侧栏标志 89 个可见点、1.5 秒内位置不变；已完成回答的标志不动且没有“忙碌”标记；系统设为减少动态效果时首页大图也不动。正在回答的标志的逐帧位置变化由单元测试覆盖，真实网页里未单独录屏。
- 未测量：真机（iPhone）上首页大图的帧率和耗电。上线后请在手机上看一次首页。
- 旧版的“悬停时转 40°”和“首页 90 秒转一圈”取消：种子长出来本身就是动效。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [工程案例库：案例 69](../engineering-casebook.md#case-sunflower-growth-mark)
- [界面设计规范](../ui-ux-design-guide.md)
- [标志资源说明](../../assets/brand/himawari/README.md)
- [v13 原型与截图](../assets/control-center/2026-10-30-v13/logo-growth-prototype.html)
- [想法记录 IDEA-20261030-001：标志备选“生长”与“ひ”](../ideas/IDEA-20261030-001-himawari-logo-candidates-grow-and-hi.md)

[↑ 返回阅读导航](#contents)
