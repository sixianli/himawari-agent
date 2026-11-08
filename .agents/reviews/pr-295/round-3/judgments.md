# PR 295 第 3 轮复核逐条判断

复核提交 be84f56（仅 DeepSeek，经 Magpie；本 PR 累计 0.41 美元）。这是 Andy 定的三轮上限的最后一轮，修完不再复核。机器可读的版本在 `verdicts.jsonl`。

没有中、高的“会出错”意见。两条低的“会出错”已修；三条“可以更好”不改，列给 Andy。

| 编号 | 意见 | 类别 | 判断 |
|---|---|---|---|
| F1 | 转正门禁的生产接线（从记忆的 tentative 属性算出 tentativeIds 再传给解析器）没有端到端用例 | 会出错（低） | 已在 `test/integration/production-memory-capture.test.ts` 加两轮用例：无原话的 unchanged 仍是待确认，带原话的 unchanged 转正 |
| F2 | 账本的 `tentativeMemoryIds` 是“送进提示的”，不是“用了的” | 可以更好 | 代码和 ADR 0179 决定 4、5 已写明，只是复核材料的措辞；不改 |
| F3 | 原话核对只做子串匹配，不要求与待确认记忆相关 | 可以更好 | 不改，列给 Andy |
| F4 | update、merge 的反向用例其实由旧规则兜底，测不到新分支 | 会出错（低） | 已改：只有 unchanged 那条声称依赖新分支，update、merge 另列并写明是通用规则 |
| F5 | 服务层用 quote 非空代替 evidenceVerified | 可以更好 | 与第 2 轮 E5 同，唯一调用方已核实；不改 |

信息项：提示清单 sha256 由 `prompt-catalog.unit.test.ts` 在容器里跑过，通过。
