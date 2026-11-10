# PR 353 第 5 轮：只看第 4 轮之后的修改

第 4 轮意见和处理见 `.agents/reviews/pr-353/round-4/judgments.md`（其中两条判为不成立，理由和源码位置写在里面）。这一轮的修改都在 docs/pi-development-guide.md：缓存预热补官方 warm/stop 原话、写明预热沿用遮盖 fetch 和密钥但没有准入和用量记录、记用量要先扩展用量表；磁盘路径写明接端口的最低要求；“每轮新建会话”改成每次运行。

Pi 1.5.0 源码在 node_modules/@earendil-works/pi-coding-agent 下（dist/core/sdk.js、dist/core/cache-warmer.js），如果读不到，就把相关说法标为未核实，不要据此判成立。
