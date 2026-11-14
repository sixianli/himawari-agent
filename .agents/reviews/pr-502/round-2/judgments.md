# PR 502 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，可以更好：### 1. 中｜新缓存没有上限，模型答案可以累积保留大量路径列表和文件全文。plan-claims.mjs 两个模块级 Map 确实无淘汰；脚本一次运行只处理一个 PR 的答案，实际规模有限；已在 claimsProblems 入口清空，缓存只活在一次调用内
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 中偏低｜`isAdrPath` 跳过整个 `docs/adr/`，而不是只跳过 ADR 文件，可能少报“旧代码仍在”。isAdrPath 用 startsWith 比 ADR_PATH_PATTERN 宽；已改用 ADR_PATH_PATTERN，补非 ADR 文件仍命中的用例；触发：被引旧代码被挪进 docs/adr/ 下的非 ADR 文件（如 docs/adr/tools/old.ts）；后果：commit-quote-still-in-head 漏报一次，只是少拒绝一个本该拒绝的说法，不丢数据；判低理由：只有故意把旧代码放进 docs/adr 非 ADR 文件才触发，后果是少拒绝一次
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 低｜新行为的主要反向用例有，但失败路径和“真正的改名”没有覆盖。已补 docs/adr 非 ADR 文件用例和恰好 400 个文件的边界用例；git diff 失败难以在夹具里构造（提交已过祖先检查），真改名夹具不支持删除旧文件，本轮已用真实历史验证 diff 输出目标路径，沿用现有代码路径
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低｜作者对改动范围的说明与 HEAD 提交不一致，ADR 0270 也没有记录新增行为。docs/adr/0270-faster-review-rounds.md:57 缺新增的 commit-quote-check-incomplete 和 docs/adr 例外；已补一句；作者范围说明与 HEAD 提交不一致属主线程材料问题，不是代码问题；触发：读 ADR 0270 第 4 点的人以为未提及的情形不会被拒；后果：文字不全，不误导核心行为
