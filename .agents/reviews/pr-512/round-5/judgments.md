# PR 512 第 5 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 低：只剩“没有绑定串动作”的待办时，菜单栏卡片消失但红点仍显示有件数，这件待办在 Mac 上不可见也没有出口。MenuBarFeed.swift:38 mostPressing 需要 shownActions 非空；MenuBarController.swift:78 红点用 awaitingCount；README:170 已写 Mac 不为无绑定串动作画按钮，这是上一轮第 1 条中高修复的取舍，第 5 轮只剩低；触发：服务器只返回一条没有绑定串动作的待办（如账号需要重新连接）；后果：Mac 菜单栏红点仍计 1 件，面板里没有卡片，这件事只能到 iPhone 上处理；不丢数据不出错，只是提示不一致
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 低：服务器归一化只测了内部 `sameServer`，没有测 `offerable` 的接线，改回直接比较也不会红。WatchGlanceTests.swift:163-171 测的是 sameServer，offerable 的现有用例两边 origin 本来相等；功能已正确（WatchGlance.swift:250 调 sameServer），只是测试接线可以更牢，不会让现有行为出错
