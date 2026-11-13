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
仓库就是当前目录，已检出 f370e2c45bfa28f85e742d6c67cb102cc53d0668。
对比基准是 db9f2c2e55c0c81b3e6e236196eda6915846d3c7，先运行 git diff db9f2c2e55c0c81b3e6e236196eda6915846d3c7..f370e2c45bfa28f85e742d6c67cb102cc53d0668 看改动。
上一轮复核到 7c1937115153bd7ae7c4ae505e858470701d8bbc，先看 git diff 7c1937115153bd7ae7c4ae505e858470701d8bbc..f370e2c45bfa28f85e742d6c67cb102cc53d0668 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# 作者说明：PR 459 第 5 轮，只看第 4 轮之后的两处改动

第 4 轮没有中、高意见。之后有两处新改动：

1. 合并 main（带进 PR 440 的平台假设清单检查）后，按 ARM 测试机线程的要求运行 `node scripts/check-platform-assumptions.mjs --write`，更新 `scripts/platform-assumptions.json`：浏览器、构建、本地、运行、测试脚本里不再写死 linux-x64，所以删掉它们的计数；新增 `scripts/ci/platforms.mjs`、`scripts/ci/install-tools.mjs` 和 `test/tooling/toolchain-platforms.test.mjs` 的计数（这些文件按平台列规则或测各平台，写出 x86 字样是有意的）。改后检查通过：PLATFORM_ASSUMPTIONS passed kinds=7 occurrences=397。
2. `test/tooling/ci-runner-scripts.test.mjs` 里“uninstall-runner.sh all 删除第三个 runner”的用例在 CI 机上失败：`UNINSTALL_INCOMPLETE still present: /etc/gh-runner`。原因：用例只在 /etc/gh-runner 上挂空 tmpfs，目录本身仍在；用例里的 rm 是假的，脚本检查 `[ -e /etc/gh-runner ]` 如实报未删干净。CI 机上真有这个目录，本地没有，所以本地一直通过。现在在 bwrap 的私有挂载空间里把整个 /srv 和 /etc 换成空 tmpfs，再建出 /etc/systemd/system 和 /etc/sudoers.d。两个同类用例的断言都把脚本的完整 stderr 作为失败信息。本地先建出 /etc/gh-runner 复现了失败，改后通过。

请重点核对：

1. 把整个 /etc 换成空 tmpfs 后，`uninstall-runner.sh all` 路径上还有没有命令依赖 /etc 下的真实文件（例如 bash、mount、动态链接器、id/getent 的真实实现），在别的机器上会不会因此行为不同或失败；用例里的假命令是否覆盖了脚本在 all 路径上调用的全部外部命令。
2. 这个用例现在是否仍能证明它要证明的事：脚本对三个 runner 和共享文件都发出了删除命令，并在什么都不剩时报 UNINSTALL_OK。
3. 同文件里“只删第二个 runner”的用例还只在 /srv、/etc/systemd/system、/etc/gh-runner 上挂 tmpfs，它在 CI 机上会不会因为同样的原因（目录本身还在、或别的真实路径）失败。
4. platform-assumptions.json 的新计数是否和这些文件现在的内容一致，有没有把不该保留的写死 x86 的地方记成了合法。
5. 这个改动会不会改变模型已经见过的请求开头（本 PR 不碰发给模型的内容，请确认）。
