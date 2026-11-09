# PR 321 第 1 轮复核

## 问题
`scripts/model-review/opencode-review.mjs` 的 `--assert-reviewed` 把“最后一个复核点到当前 HEAD 之间所有非记录目录的文件差异”当作未复核改动（`unreviewed <文件>`）。合入 main 会带进 main 的文件差异，所以 main 每前进一次就多一轮复核。

## 目标
PR 自己的改动没变（只是合入了 main）就不要求再复核；PR 自己的改动变了、合并有冲突、合并时有手工改动，仍要求复核。`main-not-merged`（origin/main 必须已在分支里）保留不变。

## 作者的做法（未经核对，请自己读代码判断）
- 新增 `ownChangePrints`/`unreviewedFiles`：对每个文件取它相对 `merge-base(mainRef, 提交)` 的 `git diff -U0 --no-renames`，用 `git patch-id --stable` 得指纹，复核点和当前提交逐文件比较，指纹不同的文件才报 `unreviewed`。算不出合并基线时退回原来的全部文件差异。
- `lowFixProblems`（--accept-low 的规模核对）和覆盖记录的新旧判断也改用 `unreviewed`File 的口径。
- 规则文字 `.agents/instructions/model-review.md` 第 6 步和交接一节已同步（Andy 已同意改）。

## 请重点看
1. 有没有一种“PR 自己的改动变了”却被判成一致（漏报）的情形：例如重命名、权限位改动、二进制文件、删除文件、patch-id 对只差上下文/行号的差异的忽略是否会掩盖真实改动（比如同一文件里 PR 的改动被挪到别处、被 main 的同样改动“吞掉”）。
2. 指纹为空时的退路（`tree:` 前缀）是否安全。
3. `--accept-low`、覆盖记录、`walkChain` 里 `lowFixCheck` 的改口径是否让旧账本的判断结果发生变化。
4. 请自己读代码找问题；清单只是参考，不要局限于这几项，也请提出你认为更好的做法。
