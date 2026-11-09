# PR 312 第 5 轮复核的逐条判断

这一轮只看 `1f16c11b` 到 `aff8e4ee`：复核脚本自检里 `probeRefused` 的第三次改法、那条用例，以及第 4 轮的记录。

模型的总结论是「没有发现会放过真实拒绝（fail-open）的缺陷」，并逐条核对了三种拒绝来源的产生处和五条 allowed 探针的输出形状。四条意见全部成立，一条判「中」，三条判低，四条我都改了或纠正了。

## R5-1（模型：中 → 我也判中，已改）正向模式只用手写字符串验证，没把真实输出回灌

成立，而且这是这一轮最有价值的一条。我改的是「按每段字样真正被打印出来的形状做匹配」，可是用来证明这件事的断言全是我手写的字符串（`test/tooling/opencode-review.test.mjs:752`、`:756`、`:763`）。真实的 git 替身和受限 bash 的输出只在另一个用例里被 `.toContain("restricted")` 看过（`:1046-1048`），从来没有交给 `probeRefused` 判一次。所以真实报错的形状一变，单测照样全绿，只有花钱前的完整自检才会暴露——而那要装好 opencode 和网关才跑得起来。

照模型的建议改：在用真实替身的那个集成用例里，把三条真实被拒命令的 stdout+stderr 存下来，既断言它们含有原来那两个字样，也直接交给 `probeRefused` 断言为 `true`；再把四条真正的只读命令（`git log -1 --oneline`、`git show --stat HEAD`、`git blame -L 1,1 -- AGENTS.md`、`git status --short`）在同一个替身下跑一遍，断言退出码为 0 且 `probeRefused` 为 `false`。

这四条里 `git show --stat HEAD` 打印的正是这个分支自己的提交说明，里面就有那三段字样（缩进四格），`git log -1 --oneline` 打印的是提交标题（列 0 带短哈希）——也就是说，这个用例现在用真实输出覆盖了当初让复核起不来的那两种形状，不再依赖我对形状的描述是否正确。那个用例里数 shell 调用次数的断言随之从 6 改成 10。

判「中」而不是低：被质疑的正是这次改动唯一的立论依据（「形状」），而证明它的全是我自己写的形状。

## R5-2（模型：低，已改）`bash -r` 的 `restricted` 受语言环境影响

成立：`opencodeEnv` 的白名单保留 `LANG`、`LC_ALL`、`LC_CTYPE`（`opencode-review.mjs:571-579`），而 guard shell 只是 `exec <真 bash> -r "$@"`，没有固定语言环境。bash 的报错经本地化之后可能不再含英文 `restricted`，真正的拒绝就会被判成没被拒，写/读探针报 `PROBE_NOT_REFUSED`、自检失败。模型也写明这是 fail-closed、而且旧写法同样依赖这个英文字样，不是这一轮引入的。

我没有按它建议的「把 guard shell 改成 `exec env LC_ALL=C <真 bash>`」做，因为那个 shell 是自检和真正那轮复核共用的：在 C 语言环境下 `grep` 对 UTF-8 的字符类和忽略大小写行为会变，而复核模型要在这个仓库里 grep 中文，等于为了一个 fail-closed 的判据去动真正复核的工作环境。

改成只给自检那次 opencode 运行固定语言环境：`selfCheck` 的 `extraEnv` 加 `LC_ALL: "C"`。`probeRefused` 只在自检里被用到，所以判据需要的确定性正好只在这一次运行里，真正那轮复核的环境不受影响。

## R5-3（模型：低，残余误判，已改）未缩进的提交元数据行仍可能被第三条模式命中

成立。只有提交说明缩进四格，`git show --stat HEAD` 的 `Author:` 行从列 0 开始。作者名由提交者控制，构造成 `f: restricted` 的话，`Author: f: restricted <…>` 会被原来的第三条模式 `^\S+: (line \d+: )?[^\n]*: restricted` 命中（`^\S+:` 吃掉 `Author:`），allowed 探针又被误判。模型说明这不是本轮回归（旧写法同样会命中），但确实说明「按真正打印出来的形状匹配」对提交元数据还不够精确。

照它的建议把第三条收窄到 shell 程序名开头：`^(?:\S*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted`。真实形状 `/bin/bash: line 1: f: restricted: …` 和 `<workRoot>/guard-shell/bash: cd: …: restricted` 都仍然命中（R5-1 新加的真实输出回灌直接证明了这一点），`Author: f: restricted` 不再命中。

反向验证：新加一条用例，输出是一段 `git show` 形状、`Author:` 行写成 `f: restricted <nobody@example.org>`，期望 `false`；把第三条模式还原成 `^\S+:` 的写法跑，这条用例以 `expected true to be false` 失败，改回来之后通过。

## R5-4（模型：低，记录在此纠正）我说「那条用例现在六个断言」是错的

成立，我数错了。那个 `it("counts only an explicit refusal as refused")` 里现在一共 9 个 `expect`，上一轮我实际新增的是 4 个（1 条 opencode 话术的正向 + 3 条 `--oneline` 形状的反向）。我说的「正向三条 + 反向三条」是我心里对这次改动相关的那几条的归类，写成「那条用例现在六个断言」就与文件不符了。

准确的说法：上一轮改完之后那条用例有 9 个 `expect`，其中与「被拒字样出现在仓库内容里」直接相关的是 7 条（3 条正向在列 0、3 条 `--oneline` 形状的反向、1 条缩进提交说明的反向）；这一轮又加了 1 条（`Author:` 行），所以现在是 10 个 `expect`。

## 模型自标「未核实」的部分

- `.agents/reviews/**` 在它的检出里不存在、git 访问也被 `REVIEW_GIT_REFUSED records-path` 拦住，所以第 4 轮的 `judgments.md`、`verdicts.jsonl` 它读不到，R4-2、R4-3 的纠正它是拿提交说明里的转述对着 `check-incident-gates.mjs:27,32` 和 `check-markdown-tables.mjs:8` 的源码核的，结论与我一致。
- 它跑不了测试，所以 `SELF_CHECK_OK`、164 条全过、`biome` 的结果都标为未核实。这些的实际输出在提交说明里。
- 「opencode 会不会给 stderr 逐行加前缀、或把 stdout 和 stderr 无换行拼接」它说仓库里的夹具证明不了。这一点我也没法从现有夹具证明；R5-1 加的真实输出回灌只覆盖到替身和 bash 自己的输出，opencode 包装层的形状仍然只有夹具。留在这里当已知局限。

## 必答问题

四条回答与我自己的核对一致：`probeRefused` 只在自检里被 `checkProbeRequests` 调用（`opencode-review.mjs:2079`、`2085`），不进入任何发给模型的内容；三条模式是编译期常量、不带 `g`/`y` 标志，所以没有 `lastIndex` 状态，同一段文字每次判定结果相同；被删掉的 `REFUSAL_TEXTS` 和 `refusalCandidateLines` 全仓库没有别的引用（测试的 import 里也没有）。
