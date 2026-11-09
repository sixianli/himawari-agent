# PR 321 第 3 轮复核的逐条判断

只跑 DeepSeek（增量）。没有中、高意见；模型自己也说本轮只有低意见，并确认 latin1 往返无损。

- R3-1、R3-2：成立，低，已修。指纹只对两个提交之间内容确有差异的文件计算（`only` 过滤），子进程数随之减少，main 已先含相同改动的文件也不再被多报；规则文字同步。
- R3-3：成立，低，已补测试 `falls back to every changed file when the merge base cannot be found`（反向：给不存在的 `--main-ref` 时必须退回全量比较并报 `unreviewed other.txt`）。空 diff 和文件名含替换字符两条退回分支都是保守方向，沿用同一条 `return null` 路径，未另加用例。
- R3-4：成立，低。已加 `--inter-hunk-context=0`；文件名里真有合法替换字符时多报一次，不会漏报，保持保守不改。
- R3-5：观察，不是缺陷：纯 main 带入的文件不再由本脚本扫描，是新规则的本意，main 自己有 gitleaks。不改。
