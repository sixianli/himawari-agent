# PR 353 第 3 轮：只看第 2 轮之后的修改

第 2 轮意见和处理见 `.agents/reviews/pr-353/round-2/judgments.md`。这一轮的修改（提交 18b32a8a）：
- docs/pi-development-guide.md：D5 位置列补上 `pi-tool-batch-continuation.ts` 读 `agent.state.messages`；磁盘路径一句改成授权由 `resources` 端口负责、适配器只查非空和不重复；`tool_call` 先于 `execute` 一条写明仓库还没有测试锁住。
- AGENTS.md：“见下文”改成“见上文”并加锚点链接。

请核对这些修改是否解决了第 2 轮的问题，是否引入新的与代码或现有规则不符的说法。
