# PR 321 第 2 轮复核（增量）

背景和目标见第 1 轮材料（briefs/round1-code-review.md）和第 1 轮判断（round-1/judgments.md）。本轮增量：
- 指纹改成每个文件 `git diff -U0 --binary --no-textconv --no-ext-diff --no-renames` 去掉 `@@`、`index` 行后取 SHA-256（空白、权限位、二进制内容参与）；文件名含 U+FFFD、diff 为空时返回 null，退回全量比较。
- `lowFixCheck`：新口径对不上记录的 `files` 时，再按旧口径（不传 mainRef）重算一次，任一口径相同就放行。
- 规则文字（model-review.md 第 6 步、交接一节、第 3 步 --accept-low）已改，写明盲区和多报情形。
- 补了空白、权限、二进制、--accept-low 夹合入 main、旧口径记录的测试。

## 请重点看
1. 新指纹有没有新的漏报或误报（例如 `--binary` 输出里有随基线变化的内容、行结束符、submodule、符号链接、删除/新增文件在合入 main 后指纹是否稳定）。
2. 旧口径兜底会不会放过本不该放行的 low-fix 记录。
3. 请自己读代码找问题；清单只是参考，也请提出你认为更好的做法。
