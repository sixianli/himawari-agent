你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 1f16c11bea42883ddc110ebbfbf16e2ac927ee3d。
对比基准是 1a3a1efecf4fc494057d44989d18d2603ff89fb9，先运行 git diff 1a3a1efecf4fc494057d44989d18d2603ff89fb9..1f16c11bea42883ddc110ebbfbf16e2ac927ee3d 看改动。
上一轮复核到 0fb3a24d1110cdc3d45f7246b0bac6a5140ca451，先看 git diff 0fb3a24d1110cdc3d45f7246b0bac6a5140ca451..1f16c11bea42883ddc110ebbfbf16e2ac927ee3d 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 312 第 4 轮复核材料

## 这一轮要看什么

只有一处改动需要你判断，范围很窄：`--previous 0fb3a24d`（第 2 轮复核过的那个提交）到 `--head 9d1e6de5`（现在的分支头）之间，除了第 3 轮的复核记录文件，实质改动只有一行指令文字。

`--previous 0fb3a24d` 到 `9d1e6de5` 之间还夹着一个合并提交 `bf5cbcf6`（把 main `1a3a1efe` 合进分支），那次合并和它的冲突解决已经是第 3 轮复核的对象，结论是正确、两边都不丢，这一轮不用重看。所以这一轮真正要判断的是：

1. `.agents/instructions/model-review.md:140` 这一行的改写是否正确、是否与仓库里其他说法一致。
2. 新增的 `.agents/reviews/pr-312/round-3/` 记录里，`judgments.md` 和 `verdicts.jsonl` 对第 3 轮三条意见的判断和降级理由，是否和它们引用的代码、脚本行为一致。

## 第一项改动：那行指令原来和现在

原文（main 合进来之前就有，main 自己也有同样这一行）：

> - 提交前检查：目前 `package.json` 里没有 `check:gitleaks` 这个脚本，云端线程不用跑它；以后若加了，任务说明里的“有就先运行”一句已经覆盖，云端线程提交记录之前先运行它，因为模型写出的意见里可能有长得像密钥的文字。

改成：

> - 提交前检查：`npm run check:gitleaks`（`package.json` 里的 `check:gitleaks`，也是 `npm run check` 的一步，见[交付模式](delivery-mode.md#fast-mode)）已经存在，云端线程提交记录之前必须先运行它，因为模型写出的意见里可能有长得像密钥的文字（事故 I-90）。它以 `GITLEAKS_GATE_FAILED` 失败时，先看命中的是不是这一轮新写的记录：是就按它打印的办法处理，不是就在汇报里写明命中在哪个文件、和这次的记录无关。

改的原因是第 3 轮复核指出这句话的开头和 `package.json` 直接矛盾。请自己核对：`package.json` 里 `check:gitleaks` 这个脚本是否存在、`check:steps` 里是否有它、`.agents/instructions/delivery-mode.md` 和 `docs/incidents-and-gates.md` 的 I-90 行怎么说，以及新文字里那个指向 `delivery-mode.md#fast-mode` 的链接锚点是否存在。`npm run check:instruction-links` 我跑过，输出 `checked=187 errors=0`，但请不要只信这句话。

## 第二项：第 3 轮的判断记录

`.agents/reviews/pr-312/round-3/judgments.md` 和同目录的 `verdicts.jsonl` 写了三条判断：

- R3-1（上面那行指令）：模型判「中」，我降为「低」，理由是它不是这次冲突解决改坏的、是 main 上原有的不一致，而且原句后半部分自带「以后若加了就先运行」的后手。
- R3-2（合并后没跑 `check:gitleaks`）：我补跑了，三条命中都不在 `.agents/reviews/pr-312/**` 里，而且把 `origin/main` 检出到 worktree 跑出同样三条命中，所以判定是 main 原有的假阳性，本 PR 不改 `ci/rules/gitleaks.toml`。
- R3-3（`check:incident-gates` 证明不了冲突两边都不丢）：我补跑了 `check:markdown-tables`（`files=403 errors=0`），并说明真正的证据是 I-84 行的 md5 与合并基相同、combined diff 里 I-90 来自 main 侧；它建议给 `check-incident-gates` 加「已知编号必须存在」的断言，我不采纳。

请核对这些说法和代码、脚本的实际行为是否一致，特别是：`scripts/check-incident-gates.mjs` 是不是真的不校验列数、`scripts/check-markdown-tables.mjs` 是不是真的校验列数；R3-2 里「不在 `.agents/reviews/pr-312/**`」的结论你可能读不到那些文件（上一轮你的工具以 `REVIEW_GIT_REFUSED records-path` 拒绝过），读不到就直接说读不到，不要替它下结论。

## 本 PR 的三条实质改动（背景，已经复核过三轮，不用重看）

1. 给模型看的字节上限按 1024 换算（`production-sandbox-tool-result.ts` 的 `limitBytes`），内存读作「1024 MB」、输出读作「48 KB」。
2. `SAFE_TOOL_REASON_CODES` 从两份一模一样的副本合成 `thread-execution-state.ts` 的一处导出，投影侧改成 import，靠读源码文本比对的 `test/tooling/safe-tool-reason-codes.test.mjs` 随之删除。
3. 恢复函数去掉 `recordUnrecoverable` 开关：`production-run-composition.ts` 给延续授权那条路另建一个不带 `resultUnrecoverable` 回调的实例，并在 `sqlite-sandbox-execution-v2.test.ts` 的 `loss-unrecoverable` 里断言它一条记录都不写。

## 这一轮跑过的检查

- `npm run check:instruction-links`：`checked=187 errors=0`
- `npm run check:markdown-tables`：`files=403 errors=0`
- `npm run check:incident-gates`：`incidents=86 errors=0`
- `npm run check:gitleaks`：三条命中，与 `origin/main` 的 worktree 上跑出的完全相同（`blocking=3`），都是测试夹具假阳性，不在本 PR 改动的文件里。
- `scripts/layer0-tests/check-layer0-tests.py derive` 对这一轮的改动没有列出任何文件（没有改产品源码）。

## 必答问题

1. 这个改动会不会改变模型已经见过的请求开头？
2. 会不会让同一段文字在不同请求里变成不同的字节？
3. 有没有对应的自动检查，反向用例会不会真的失败？
4. 每个产生或修改的值，两端校验都能接受吗？

## 补充：这一轮的头换成了 026bfdff，多了一处修复

第一次跑这一轮时自检失败了两次，都停在
`SELF_CHECK_FAILED … PROBE_READ_COMMAND_BLOCKED bash git show --stat HEAD`。
根因是复核脚本自己的 `probeRefused` 用「输出里是否包含 `REVIEW_GIT_REFUSED`」
判断一条探针命令有没有被 git 替身拒掉，而 `git show --stat HEAD` 会连提交说明
一起打印，上一个提交 `9d1e6de5` 的说明里恰好引用了这个错误码（它在复述第 3 轮
模型报的 `REVIEW_GIT_REFUSED records-path`）。于是一条正常执行的命令被判成被拒。

`026bfdff` 按根因改：把这个标记从 `REFUSAL_TEXTS`（纯子串匹配）移到新的
`REFUSAL_PATTERNS`，用 `^REVIEW_GIT_REFUSED ` 加 `m` 标志只认行首；替身写的那
一行仍然匹配，`git show` 缩进四格打印的提交说明和 diff 正文（每行带 `+`/`-`/
空格前缀）都不再误判。另外两条（opencode 自己的拒绝话术、`bash -r` 的
`: restricted`）本来就出现在行中，保持子串匹配不动。

所以这一轮要判断的第三项是：

3. `scripts/model-review/opencode-review.mjs` 里 `probeRefused`、`REFUSAL_TEXTS`、
   `REFUSAL_PATTERNS` 的这处改动，以及 `test/tooling/opencode-review.test.mjs`
   里新加的那条反向用例。请核对：收窄之后 git 替身真正写出的那一行是否仍然会
   被判成被拒（替身的写法在同一个文件里，搜 `GIT_REFUSED, problem` 能找到），
   有没有别的地方依赖原来的子串匹配，以及这样收窄会不会放过真正被拒的情形。

反向验证我做了：把 `probeRefused` 还原成改之前的写法，新用例以 `- false / + true`
失败；改回来之后 `test/tooling/opencode-review.test.mjs` 164 条全过。

## 再补充：头换成 1f16c11b，上面那处修复我改了两次

`026bfdff` 只收窄了 git 替身那一个标记，自检仍然以同样的
`PROBE_READ_COMMAND_BLOCKED bash git show --stat HEAD` 失败——我第一次没把根因
找完。真正的范围更大：`probeRefused` 把三段「被拒」的字样（opencode 自己的拒绝
话术、git 替身的标记、`bash -r` 的 `: restricted`）按子串在整段输出里找，而
`git show --stat HEAD` 会把提交说明一起打印，说明里只要复述过其中任何一段，一条
正常执行完的命令就被判成被拒。`026bfdff` 的说明在解释第一次修复时同时写到了另外
两段，于是又撞上同一个坑。

`1f16c11b` 按共同点改：拒绝这件事总是由替身、`bash -r` 或 opencode 自己在一行
开头打印，而 `git show`、`git log` 打印的提交说明每行缩进四格。所以
`probeRefused` 改成只在不以空白开头的行里找这三段字样，三段都恢复成普通子串匹配，
`026bfdff` 加的 `REFUSAL_PATTERNS` 删掉。

所以第三项要判断的是 `1f16c11b` 之后的最终形态（`REFUSAL_TEXTS`、
`refusalCandidateLines`、`probeRefused`）和那条反向用例。请特别看：这样收窄会不会
放过真正被拒的情形（替身写在列 0、`bash -r` 的报错写在列 0、opencode 的拒绝话术
写在列 0，是否都还能认出来），以及有没有别处依赖原来的整段子串匹配。

反向验证：那条用例的输出里三段字样各出现一次、都放在缩进四格的提交说明里，期望
`false`；还原成改之前的写法跑，用例失败；改回来之后该文件 164 条全过。
