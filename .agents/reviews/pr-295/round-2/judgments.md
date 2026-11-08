# PR 295 第 2 轮复核逐条判断

复核提交 bbca32f（仅 DeepSeek，经 Magpie，97 步，约 0.10 美元；本 PR 累计 0.35 美元）。机器可读的版本在 `verdicts.jsonl`。

仍有一条中高的“会出错”：E1，与第 1 轮 D1 是同一问题（待确认记忆会被模型的 `unchanged`/高置信度 `update` 转正），转正逻辑是 Andy 明说不动的范围，线程没有擅自改，等 Andy 决定。其余“会出错”均为低，已补测试和文档。

| 编号 | 意见 | 类别 | 判断 |
|---|---|---|---|
| E1 | 待确认记忆可被 unchanged/update 转正 | 会出错（中高） | 等 Andy 决定 |
| E2 | 无上限、同权排序 | 可以更好 | 列给 Andy |
| E3 | 黄金对账空转 | 会出错（低） | 已加带原话的低分用例 |
| E4 | `tentativeMemoryIds` 生产无人使用 | 可以更好 | 不改 |
| E5 | 服务层用 quote 非空代替 evidenceVerified | 可以更好 | 与 D7 同，现在唯一调用方已核实 |
| E6 | personLinks 反向用例缺失 | 会出错（低） | 已补 |
| E7 | ADR 漏写 update 路径 | 会出错（低） | 已补 |
