# PR 388 第 3 轮逐条判断

- **r3-1**（中）「工具说明仍允许只给 excludePhrases」：成立。工具说明 `mcp.propose-rule` 改为「senderDomains、senderAddresses、phrases、words 至少给一项，只给 excludePhrases 不算」，提示词清单同步。只改外部 MCP 客户端看到的工具说明，Himawari 自己发给模型的请求不变。
- **r3-2**（低）「缺少只给 excludePhrases 的反向用例」：成立，参数不合法用例加 `{ excludePhrases: ["広告"] }`。

费用：第 3 轮 0.0944 美元，累计 0.4958 美元。连续三轮都有中（三轮的中各不相同，都已改）。按规则这次改完不再复核，停下问 Andy。
