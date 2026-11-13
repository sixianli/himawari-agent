# PR 423 第 5 轮逐条判断

- ds-1（高，成立，实际运行复现）：main 新合入的“每天回看对话”也走 parseMemoryCandidates，但没接裁判，待确认记忆永远不确认。`test/integration/memory-conversation-review.test.ts` 的既有用例在合入后失败。已改：回看解析也返回 supportChecks，回看服务顺序调用同一个裁判后重新解析；既有用例补上裁判回答后通过，新增两条反向用例（裁判判否、裁判两次答非所问都不确认）。
- ds-2（低）：用例改名，写明它不锁预留大小。
- ds-3（低）：ADR 0249 写明首字符是字母或数字、转大写。
- ds-4（不成立）：抽取失败时不搜单号是 ADR 0249 决定 3 写明的设计（“预估超限、超时、失败时不搜单号”，`docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md`），不是缺陷；要不要加诊断记录列给 Andy。
