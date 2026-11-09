# PR 312 第 6 轮复核的逐条判断

这一轮看的是按第 5 轮意见改出来的那个提交（`aff8e4ee` → `27d9bc2a`）。模型的总结论是方向正确、四条都基本落实、失败方向仍然是 fail-closed，没有发现会放过真实拒绝的缺陷。

五条意见里四条成立，一条我不采纳并用真实夹具说明理由。

## R6-1（模型：中 → 我也判中，已改）真实输出的覆盖依赖外层仓库当前的 HEAD

成立，而且它抓住了我上一轮那条「真实输出回灌」的要害。集成用例只是 `git clone --depth 3` 当前工作区，然后对当前 HEAD 跑那四条只读命令，所以覆盖到什么形状完全由「这次检出的提交」决定。模型逐条核过：当前 HEAD 的说明里只有 `restricted` 一段，没有 `REVIEW_GIT_REFUSED`，也没有 opencode 的那句话术，`Author:` 行是 `Andy` 而不是 R5-3 要防的 `f: restricted`，`--oneline` 的标题一段都没有。所以我在上一个提交说明里写「`git show --stat HEAD` 打印的正是这个分支自己的提交说明（含那三段字样）」只对其中一段成立——这一点和 R6-4 是同一件事。更要紧的是，换一个提交说明或作者，这个用例会静默失去覆盖。

照它的建议改：克隆出来之后，先用真实 git（不经过 `guard.shell`，所以不影响数 shell 调用次数的断言）在副本里造一个提交，作者名就是 `f: restricted`，标题是 `REVIEW_GIT_REFUSED --output bash: line 1: x: restricted`，正文是 opencode 那句话术。这样那四条只读命令打印出来的是：

- `git show --stat HEAD` 的 `Author: f: restricted <nobody@example.org>`（列 0，正是 R5-3 要防的形状）；
- `git log -1 --oneline` 的 `<短哈希> REVIEW_GIT_REFUSED --output bash: line 1: x: restricted`（列 0，正是 R4-1 要防的形状）；
- `git show` 正文里缩进四格的三段字样（正是 R4-1 之前那一版要防的形状）。

覆盖不再依赖外层仓库的 HEAD 是什么样子。

反向验证（这是这条意见真正要的东西）：把 `probeRefused` 还原成第二代写法（只在不缩进的行里做子串匹配），那四条只读命令的循环就在真实输出上变红——`test/tooling/opencode-review.test.mjs:1093` 以 `expected true to be false` 失败。也就是说历史上那两个 bug 现在由真实的 git 输出拦住，而不是由我手写的字符串拦住。

## R6-2（模型：低，已改，而且它的改法比我的好）`LC_ALL: "C"` 作用面过宽，也没有测试证明它到得了受限 bash

成立，两点都对，而且它给的替代方案比我上一轮选的好。

我上一轮之所以把语言环境固定在自检那次 opencode 运行上、而不动共用的 guard shell，理由是 `LC_ALL=C` 会连 `LC_CTYPE` 一起覆盖，`grep` 对 UTF-8 的字符类和忽略大小写会变，而复核模型要在这个仓库里 grep 中文。模型指出：真正需要固定的只是**消息语言**，那是 `LC_MESSAGES`，它不影响字符类。用 `LC_MESSAGES=C` 就没有我担心的副作用，于是可以放进共用的 guard shell——这样自检和真正那轮复核的 shell 报错都固定为英文，而且是在我们自己写的那个包装脚本里生效，不再依赖「opencode 会不会把继承到的环境变量传给它启动的 bash」这个我证明不了的环节。

照它的改：guard shell 的包装脚本加一行 `export LC_MESSAGES=C`，`selfCheck` 的 `extraEnv` 里那个 `LC_ALL: "C"` 删掉。

它还指出我没有任何测试检查这件事。补上：集成用例里多跑一次 `cd <root>`，这次把 `LC_ALL` 和 `LANG` 都设成 `ja_JP.UTF-8`，断言它的输出仍然被 `probeRefused` 判为 `true`。数 shell 调用次数的断言随之从 10 改成 11。

这条用例的局限要说清楚：容器里没有装日文语言包，所以 bash 本来也会退回英文消息，它证明的是「设了别的语言环境之后这条路仍然走得通、判据仍然成立」，不是「本地化真的被 `LC_MESSAGES=C` 盖掉了」。后者要有装了语言包的机器才能证。

## R6-3（模型：低 → 我判为不采纳，用真实夹具说明）opencode 如果给工具输出加前缀，收窄后的模式会漏判

它说的消费端路径是对的：`probeRefused` 实际拿到的是 opencode 事件里的 `part.state.output`（`opencode-review.mjs:367`），而集成用例喂的是 `result.stdout + result.stderr`，两者不是同一条路。它据此推测：如果 opencode 把 stderr 包一层前缀（例如 `Error: bash: …: restricted`），旧的 `^\S+:` 还能命中、新的 `^(?:\S*\/)?(?:ba)?sh:` 不能。

它自己把这一条标为推测，说仓库夹具证明不了。我去查了夹具，结论是能证伪：`test/tooling/fixtures/opencode-review/glm-events.jsonl` 里真实 `bash` 工具的 `part.state.output` 是命令的原始输出，第一个字符就是 `git diff --stat` 那一行开头的空格，没有任何前缀。

不采纳的理由不只是「夹具显示没有前缀」，还有一个更硬的：按它的建议容忍行首若干前缀，等于回到 `^\S+:`，而那恰好就是上一轮 R5-3 要我堵住的 `Author: f: restricted` 误判。两条意见在这里是相反方向的，不能同时满足；我选择按真实夹具的形状来，而不是按推测的形状放宽。它指出的「集成用例喂的不是真正的消费端形状」我记在这里当已知局限：要真覆盖这一段，得有一份含被拒命令的 opencode 事件夹具，现有的两份都只有成功命令。

## R6-4（模型：低，已改）提交说明里「含那三段字样」与当前 HEAD 不符

成立，这就是 R6-1 的另一面。上一个提交说明里那句话只对 `restricted` 一段成立。按 R6-1 造出提交之后，这句话在新的用例里变成真的；这一轮的提交说明也按实际情况写。

它同时核对了 R5-4 的那个数字：那条用例现在是 10 个 `expect`，与我上一轮纠正后的说法一致。

## R6-5（模型：提示，非本轮缺陷 → 列为「可以更好」）`...extraEnv` 展开在安全关键字段之后

事实成立：`runOpencode` 里 `...extraEnv` 排在 `PATH`、`SHELL`、`OPENCODE_CONFIG` 这些之后，所以 `extraEnv` 里只要出现同名键就会静默覆盖这些边界。现在所有调用方传进去的都是内部常量（canary marker、网关那几个变量），这一轮删掉 `LC_ALL` 之后更少了，没有实际问题。

列给 Andy 当「可以更好」，不在本 PR 改：把 `extraEnv` 限成白名单键，或者在 `selfCheck` 里显式拼装。这是复核脚本的结构改动，和本 PR 的三条实质改动无关，顺手改会让这个已经偏长的 PR 更偏。

## 模型自标「未核实」的部分

- `LC_ALL=C`（这一轮已改成 guard shell 里的 `LC_MESSAGES=C`）到不到 opencode 启动的 bash：它说仓库代码只到 opencode 进程为止。改成在我们自己的包装脚本里 export 之后，这个不确定性没有了——包装脚本就是 bash 的直接父进程。
- 它跑不了测试，所以 164 条全过、`biome`、`derive` 的结果都标未核实。实际输出在提交说明里。
- `.agents/reviews/**` 它读不到（git 守卫拦住、工作区也没检出），所以第 5 轮记录的原文它没核对，只核了提交说明里的转述。

## 必答问题

四条回答与我自己的核对一致。其中第一条它多核了一层，值得记下来：复核提示词里的必答问题是从 `model-review.md` 的 checklist 段读的（`opencode-review.mjs:2328-2333`），而本 PR 改的是第 140 行的「提交前检查」，不在那一段里，所以连复核模型自己的提示词前缀都没变。
