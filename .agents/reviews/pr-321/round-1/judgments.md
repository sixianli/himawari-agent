# PR 321 第 1 轮复核的逐条判断

两个模型一共 14 条意见，全部有依据。指纹原先用 `git patch-id --stable`，它忽略空白，也不看权限位，二进制文件的比较结果也不确定；本轮改成自己取每个文件 `git diff -U0 --binary` 的 SHA-256（去掉 `@@` 和 `index` 行），根因是“用了会忽略真实改动的比较”，不是逐个补洞。

| 编号 | 模型 | 说法 | 判断 |
|---|---|---|---|
| D1、G2 | DeepSeek、GLM | 空白、缩进改动不被发现 | 成立，中，已修（新指纹保留空白）；补测试 `whitespace-only, mode-only and binary…`，反向：加尾随空格必须报 `unreviewed code.txt` |
| D2 | DeepSeek | 有内容改动的文件被 chmod 不被发现 | 成立，中，已修（diff 里的 mode 行进指纹）；同一条测试里 chmod 必须报 `unreviewed` |
| G1 | GLM | 二进制改动可能被放行 | 成立（推测，未实测），中，已修（`--binary` 把内容放进 diff）；测试 `a binary file changed…` |
| D3 | DeepSeek | `--accept-low` 规模核对可被“挪动/空白”绕过 | 成立但降为低：空白已由新指纹拦住，剩下同文件内按原顺序搬动代码，需要故意构造；规则本来防手误不防有意；盲区写进规则；另补 `counts only the PR's own files…` 测试 |
| D4、G4 | 两个 | 旧账本 low-fix 记录会 `files-differ` | 成立，低，已修：新口径对不上时再按旧口径重算，任一口径相同即放行；测试 `still accepts a record written before…`（反向：多写 `bogus.txt` 仍报 `files-differ`） |
| G3 | GLM | 文件名含无效 UTF-8 时指纹退化 | 成立，低，已修：遇到 U+FFFD 返回 null，退回全量比较 |
| D5、G6 | 两个 | main 先含相同改动时多报；文档“随时可以”过度承诺 | 成立（多报方向，安全），低，已修文字；多报写进规则 |
| G5 | GLM | 共享文件行数含 main 的行 | 成立（误拒方向），低，规则里写明“偏多不偏少” |
| D6、G7 | 两个 | 测试标题与断言矛盾；缺反向用例 | 成立，低，已修标题并补空白、权限、二进制、`--accept-low`×合入 main、旧口径记录五类用例 |
| D7 | DeepSeek | 子进程数随文件数增长，可缓存 | 可以更好，不改行为；列给 Andy，不改 |
