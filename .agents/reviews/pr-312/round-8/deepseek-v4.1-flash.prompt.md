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
仓库就是当前目录，已检出 61c5a107f71bd3aee65c8cdc104e323ff8639bb3。
对比基准是 1a3a1efecf4fc494057d44989d18d2603ff89fb9，先运行 git diff 1a3a1efecf4fc494057d44989d18d2603ff89fb9..61c5a107f71bd3aee65c8cdc104e323ff8639bb3 看改动。
上一轮复核到 b291add7f400980a2a9760532c2c0aa77b712973，先看 git diff b291add7f400980a2a9760532c2c0aa77b712973..61c5a107f71bd3aee65c8cdc104e323ff8639bb3 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 312 第 8 轮复核材料

## 这一轮要看什么

范围：`--previous b291add7` 到 `--head 61c5a107`，两个提交。

- `4d5a6e5b`：按你上一轮（第 7 轮）五条意见做的修改，全在复核脚本及其测试上。
- `61c5a107`：修 CI 上一条真实失败的测试，文件是 `test/tooling/review-delegate.test.mjs`。

这段自检逻辑我已经改了六次，前面每一轮你都指出上一次还没改干净，其中两次是我自己
把一个有效的修复换成了无效的、或者把已有的断言弄成了空转。所以这一轮请着重做两件事：

1. 明确说：按你读到的代码，还有没有「真实的拒绝会被漏判」或「正常输出会被误判」的
   路径。如果没有，请直接说没有。
2. 明确说：这两个提交有没有把任何已有的断言变成「永远成立」（vacuous）。上一轮你抓到
   的 `--allow-empty` 就是这种，请用同样的眼光看这一次新增和改动的每条断言。

## 背景：这段逻辑是干什么的

复核脚本在真正花钱之前会跑一次自检：在一份一次性的仓库副本里，用一个 git 替身和
`bash -r` 限制 opencode 能做什么，然后发一批探针命令，检查哪些该成功、哪些该被拒。
`probeRefused(call)` 判断一条探针命令有没有被拒掉。误判的两个方向都是 fail-closed：
allowed 探针被误判成被拒 → `PROBE_READ_COMMAND_BLOCKED`；write/read 探针漏判 →
`PROBE_NOT_REFUSED`。两种都让自检失败、整轮复核起不来。

判据是三条行首锚定的模式（`REFUSAL_PATTERNS`）：git 替身写的
`REVIEW_GIT_REFUSED <问题码>`、受限 bash 写的 `<shell 路径>: [line N: ]<词>: restricted`、
opencode 自己的拒绝话术。

## 第 7 轮五条意见各自改了什么

**R7-1（你判高）** `LC_MESSAGES=C` 被继承来的 `LC_ALL` 压过。你说得对，我上一轮把一个
有效的修复（`extraEnv` 里的 `LC_ALL: "C"`）换成了无效的。现在 guard shell 的包装脚本是
`unset LC_ALL` 后再 `export LC_MESSAGES=C`。你同时指出我那条 localized 断言证明不了
这件事（容器没装日文语言包，bash 本来就退回英文消息），所以补了一条不依赖语言包的
直接断言：让包装脚本跑 `echo ${LC_ALL-unset}/${LC_MESSAGES-unset}`，父进程同时设
`LC_ALL=ja_JP.UTF-8` 和 `LC_MESSAGES=ja_JP.UTF-8`，期望输出 `unset/C`。数 shell 调用
次数的断言 11 → 12。

请核对：`unset LC_ALL` 放在这个位置是否真的管到 `exec` 出来的 bash 及其子进程；
有没有别的途径让 `LC_ALL` 或消息语言重新进来（例如 bash 启动文件、opencode 自己再设
一遍、`extraEnv`）；那条 `unset/C` 断言是不是真的会在改动被还原时变红（我实测会，
报 `expected 'ja_JP.UTF-8/C…' to be 'unset/C'`，请核对判断逻辑本身）。

**R7-2（你判中，我按高档处理）** `--allow-empty` 让 `git diff HEAD~1 HEAD` 变空 diff，
外部 diff 的两条安全断言空转。现在集成用例在副本的 `AGENTS.md` 第 1 行前插一个锚点，
再用 `git commit --all` 提交，提交非空。

请核对：这两条断言现在是否真的活了；以及这个「真的改了 AGENTS.md」有没有反过来让
别的断言失效（例如 `git status --porcelain` 必须为空那条、数 shell 调用次数那条、
`git blame` 那条）。

**R7-3（你判低）** 空提交不改 `AGENTS.md`，blame 第 1 行归给真实历史作者。按 R7-2 改成
非空提交之后，blame 第 1 行的作者是 `f: restricted`。请核对这一条是否真的成立。

**R7-4（你判低）** 测试里造提交的 git 命令用了开发者的全局配置。现在 clone 和 commit
都显式传 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_SYSTEM=/dev/null`、
`GIT_CONFIG_NOSYSTEM=1`，提交再加 `-c commit.gpgsign=false`。

**R7-5（你判低，上一轮我曾列给 Andy，这一轮接受你的反驳改了）** `...extraEnv` 排在
安全关键字段之后。原来那段环境是在 `runOpencode` 里内联拼的、没法单独测，现在抽成
导出的 `opencodeChildEnv({ parentEnv, cwd, configPath, limitsPath, gitGuard, extraEnv })`，
`...extraEnv` 紧跟 `...opencodeEnv(parentEnv)`，边界键排在它后面。新增用例
`[review env] extraEnv cannot take over the guard path, the shell or the config`：传一个把
`PATH`、`SHELL`、`OPENCODE_CONFIG`、`XDG_CONFIG_HOME`、`GIT_CONFIG_GLOBAL`、花费守卫
那个变量全部指向「攻击者」路径的 `extraEnv`，断言六个边界键仍是 guard 自己的值，一个
不冲突的键照常透传。

请核对：抽函数之后逐键的值与原来是否完全一致（有没有漏键、有没有把 `process.env`
换成 `parentEnv` 时出错）；受保护键的清单够不够。你上一轮建议顺带把 `LANG`/`LC_ALL`
也列为受保护键，我没做，理由是 R7-1 的修复发生在 bash 启动的那一刻，`extraEnv` 里
放什么语言环境都盖不过它（那条 `unset/C` 断言就是在父进程同时设了两个变量的情况下
通过的）。请判断这个理由站不站得住。

## 第二个提交：委派用例的 git 身份

CI 的 `policy` 检查在 `4d5a6e5b` 上失败，唯一一条失败是
`test/tooling/review-delegate.test.mjs` 的
`[delegate] refuses a merge commit and a history that touched code even if the final tree is clean`，
报错是 `git revert --no-edit HEAD` 的 `Author identity unknown`。根因：那个夹具把作者
身份只加在 `commit` 这一条路径上，而 `git revert` 同样要写提交却走不带身份的 `run`；
CI runner 账号没有全局 git 身份，所以只在 CI 现形。

这个文件与 `origin/main` 逐字节相同，不是本 PR 改出来的，但它和 R7-4 是同一类缺陷，
所以一并修了：夹具里所有 git 调用（含三条 `git init`/`git clone`）统一带
`-c user.name=t -c user.email=t@t -c commit.gpgsign=false`，并统一传那三个
`GIT_CONFIG_*`；原来只给 `commit` 用的 `identity` 常量删掉。

请核对：统一加这组 `-c` 会不会改变某条用例原本想验证的行为（例如有没有用例依赖
「提交没有签名」或「提交者身份不同」）；统一隔离 git 配置会不会让某条用例在 CI 上反而
失败；以及这 33 条用例里还有没有别的会写提交、却走不带身份路径的 git 子命令。

## 已知的、不在本轮范围内的

- main 上有三条密钥扫描（gitleaks）的假阳性，CI 的 `security` 检查因此红；两个命中文件
  与 `origin/main` 逐字节相同，历史那条命中 `origin/main` 的祖先 `e5edb5469`。要改的是
  `ci/rules/gitleaks.toml` 的白名单，属于 main，已有另一个线程在修。
- main 上 ADR 0181 重号，本地 `test/tooling/adr-numbers.test.mjs` 因此失败；本 PR 不新增
  ADR。
- 第 6 轮 R6-3 记下的已知局限仍然存在：仓库里两份 opencode 事件夹具都只有成功命令，
  没有「被拒绝」的事件，所以集成用例喂给 `probeRefused` 的是 `stdout+stderr`，不是真正
  消费端的 `part.state.output`。补一份含被拒命令的夹具不在本 PR 范围内。

## 验证结果（我实际跑过的）

- `test/tooling/opencode-review.test.mjs`：165 条全过（672 秒）。
- `test/tooling/review-delegate.test.mjs`：33 条全过；另外在屏蔽全局 git 身份
  （`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`）的情况下也 33 条全过，
  修复前同样条件下复现出与 CI 一致的 `1 failed | 32 passed`。
- 五条修改各有反向验证，具体报错文本写在 `.agents/reviews/pr-312/round-7/judgments.md`
  和两个提交说明里。
- `biome format`、`biome lint` 对改动的三个文件通过；`derive` 对这两次改动分别列出
  对应的测试文件，`L0_RELATED_TESTS_OK`。
