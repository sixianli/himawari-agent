# PR 353 第 4 轮：只看第 3 轮之后的修改

第 3 轮意见和处理见 `.agents/reviews/pr-353/round-3/judgments.md`。这一轮的修改都在 docs/pi-development-guide.md：
- 磁盘路径一句改成仓库只有 `resources` 端口的接口、没有实现，以后接这个端口要先出方案。
- Andy 2026-11-10 定缓存预热要保留：“设置”一节补官方管预热的写法（`promptCache`、`cache_warming_decision`、`cache_warm` 用量条目）、预热不经过 Himawari 替换的请求函数、DeepSeek 不需要预热、每轮关会话导致空闲预热跑不起来；D7 一行和接入点总表跟着改。

请核对这些说法和 Pi 1.5.0 源码（node_modules/@earendil-works/pi-coding-agent 的 dist/core/cache-warmer.js、dist/core/sdk.js）以及 Himawari 代码是否一致。
