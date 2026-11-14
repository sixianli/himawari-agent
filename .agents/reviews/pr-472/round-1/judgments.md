# PR 472 第 1 轮判断

- D1 成立，会出错（低）：设计文档 `docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md` 的 `modelRef` 说明没写 completions 要求，已补。
- D2 成立，会出错（低）：用例标题说“failed”但只覆盖了回答无效。已加一条 `model.failed` 的调用，标题改为“even when the model fails or one release fails”。
- D3 成立，会出错（低）：`pi-model-transport.ts` 的 `release` 逐个删除，第一个失败会跳过后面的。改为在预评里每个 ref 单独 `release` 并各自吞错；用例让输入释放失败，断言回答仍被释放，换回旧写法该用例失败。没有改边界层，免得影响其他调用方。

改动超过 `--accept-low` 的 30 行上限（测试文件 36 行），所以再复核一轮。
