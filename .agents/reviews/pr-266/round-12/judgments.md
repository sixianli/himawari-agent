# PR 266 第 12 轮判定（两个模型的完整复核）

这一轮看整个 PR（bc380a6e 到 5f21139b）。第 10 轮账本断开，复核脚本要一轮两个模型都参加、不带 `--previous` 的完整复核才能重新接上。Andy 批准按最坏情况累计 1.22 美元。实际花费 DeepSeek 0.0703 美元、GLM 0.0451 美元，累计 0.9294 美元。

| 编号 | 模型说法 | 判定 | 处理 |
| --- | --- | --- | --- |
| D1 | README 说 `npm run check` 不含 tooling 测试，和代码不一致 | 不成立：main 的 `check:steps` 早已单独跑多个 tooling 测试文件，README 说的是完整 `test:tooling` 不能被替代 | 不改 |
| D2 | bootstrap 和记录同时删掉一项时检查放行 | 成立，可以更好：是明显的有意改动，复核能看到 | 不改，列给 Andy |
| D3 | 只认 `originals` 里的字面量，动态写法看不到 | 推测，可以更好：当前没有这种写法 | 不改，列给 Andy |
| D4 | 源码摘要不统一换行，CRLF 检出会误报 | 可以更好，同第 10 轮 D5 | 不改 |
| G1–G5 | `run-review.py`、`review-explanations.json`、`run_diff.py`、`tag_assess.py` 的问题 | 不成立：这些文件在仓库里都不存在，GLM 复核的不是本 PR | 不改 |

没有成立的“会出错”意见，复核结束。
