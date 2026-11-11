# PR 412 第 1 轮判断

没有“会出错”的意见，全部是可以更好：
- d1：共享函数缺单测。已新增 test/tooling/chromium-launch.test.ts（6 条，含 3 条反向），并手动删掉“显式配置不回退”判断验证了反向用例会失败。
- d2 / g2：默认优先于 /opt，是 PR 410 第 1 轮中等意见的结论（避免在两个浏览器都有的主机上换掉默认浏览器），不是新引入；已有单测锁定。
- d3 / g1：依赖 Playwright 报错文案。已提成常量 MISSING_BROWSER_MESSAGE 并由单测固定；Playwright 没有更稳的错误码。
