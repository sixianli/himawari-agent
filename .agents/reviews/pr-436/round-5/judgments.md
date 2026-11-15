# PR 436 第 5 轮判断

没有中、高严重度的“会出错”意见。

## 会出错 · 低（已改）
- d1 整理阶段“改状态失败”没有用例：已在 `still adopts the proposal when tidying the other waiting proposals fails` 里补上（去掉兜底后失败）。
- d3 文档说“一条规则生效时”范围比代码宽：文档改为“经采纳提议或主人原话生效时”，并写明漏掉的会留到过期。

## 可以更好（不改，列给 Andy）
- d2 整理失败没有日志：规则写入器目前没有日志通道。
