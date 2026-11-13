# PR 488 第 1 轮逐条判断

- 第 1 条（中，会出错）：成立，已修。`check-lint.mjs` 现在和 `check-format.mjs` 一样有子进程用例，断言 biome 参数是 `lint --error-on-warnings --diagnostic-level=warn .`、退出码透传、biome 缺失时报 `LINT_CHECK_UNAVAILABLE`。反向验证：删掉 `--error-on-warnings`，该用例失败；恢复后 16 个用例全过。
- 第 2 条（低）：成立，可以更好，不改。没有人给 `npm run lint` 传参数，钩子和 CI 都跑全仓。
- 第 3 条（低，会出错）：成立，已修。用例改名，I-100 引用新的参数用例。

本轮花费 0.04 美元，PR 累计 0.04 美元。修了中档意见，需要再复核一轮。
