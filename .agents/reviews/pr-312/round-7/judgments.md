# PR 312 第 7 轮复核的逐条判断

这一轮看的是按第 6 轮意见改出来的那个提交（`27d9bc2a` → `b291add7`）。模型给了五条：1 高、1 中、3 低。五条全部成立，而且前两条抓住的都是我上一轮自己改坏的地方——一条让修复实际无效，一条让已有的安全断言变成空转。五条我都改了，每条都有红绿验证。

## R7-1（模型：高 → 我也判中、高档，已改）`LC_MESSAGES=C` 会被继承来的 `LC_ALL` 压过

成立，而且这是我上一轮按 R6-2 改动时的直接错误。我把 `selfCheck` 的 `extraEnv` 里的 `LC_ALL: "C"` 删掉，换成在 guard shell 的包装脚本里 `export LC_MESSAGES=C`，理由是只需要固定消息语言、不想动字符类。但 POSIX 里 `LC_ALL` 的优先级高于所有单项类别，而 `OPENCODE_KEPT_ENV`（`opencode-review.mjs:571-578`）恰好原样保留 `LANG`、`LC_ALL`、`LC_CTYPE`。所以只要跑复核的机器上有 `LC_ALL=ja_JP.UTF-8` 这类设置，包装脚本那行 `export` 就不起作用，受限 bash 的 `restricted` 报错可能是本地化文本，`REFUSAL_PATTERNS` 要求的英文串匹配不到。方向仍是 fail-closed（自检会报 `PROBE_NOT_REFUSED`，复核起不来，不会放过真实拒绝），但我上一轮等于把一个有效的修复换成了一个无效的修复，比改之前更弱。

照它的建议改：包装脚本在 `export LC_MESSAGES=C` 之前先 `unset LC_ALL`。这样 `LC_MESSAGES=C` 真正生效，`LC_CTYPE` 仍可从 `LANG` 继承，复核模型在仓库里 grep 中文不受影响。

它还指出我上一轮新加的那条 localized 断言证明不了这件事：容器里没装 `ja_JP.UTF-8`，bash 本来就会退回英文消息，所以把 `unset LC_ALL` 删掉它也不会变红。这一点完全正确。补一条直接断言：让包装脚本跑 `echo ${LC_ALL-unset}/${LC_MESSAGES-unset}`，父进程同时设 `LC_ALL=ja_JP.UTF-8` 和 `LC_MESSAGES=ja_JP.UTF-8`，期望输出 `unset/C`。这条不依赖任何语言包是否安装，它直接量的就是「到了 bash 手里，LC_ALL 没了，LC_MESSAGES 是 C」。

反向验证：把 `unset LC_ALL` 这一行删掉再跑，`test/tooling/opencode-review.test.mjs` 以 `expected 'ja_JP.UTF-8/C\n/usr/bin/bash: warning…' to be 'unset/C'` 失败。

## R7-2（模型：中 → 我也判中、高档，已改）`--allow-empty` 让外部 diff 的两条安全断言变成空转

成立。我上一轮为了造出危险的作者名和标题，用了 `git commit --allow-empty`，于是新 HEAD 的树和 HEAD~1 完全相同。后面那三条 `git diff HEAD~1 HEAD` 探针没有任何文件差异，`GIT_EXTERNAL_DIFF` 和 `diff.external` 指定的程序根本不会被 git 调用。断言照样通过，但它们什么都没在查——哪怕 guard 对外部 diff 的拦截彻底坏掉也发现不了。这两条断言不是这一轮新加的，是原有的安全覆盖，被我的改动削弱了。

照它的建议改：造提交时真的改动 `AGENTS.md`（在第 1 行前插一个锚点），用 `git commit --all` 提交，提交非空。

反向验证（这次是双向的）：
- 现在这两条断言是活的——把 git 替身里的 `gitChildEnv(process.env)` 换成 `process.env`（即不再净化危险的 git 环境变量），用例以 `expected '?? 100644\n?? 1c68cd88…' to be ''` 失败，正是 `GIT_EXTERNAL_DIFF=touch` 真的被调用、在工作区留下了以哈希和模式命名的文件。
- 当初确实是空转——在一份同样的临时克隆里用 `--allow-empty` 造提交，`git diff HEAD~1 HEAD | wc -c` 是 0，即使不净化环境、直接 `GIT_EXTERNAL_DIFF=touch git diff HEAD~1 HEAD`，`git status --porcelain` 也仍然是空的。

## R7-3（模型：低，已改）`git blame -L 1,1 -- AGENTS.md` 没覆盖到危险的作者名

成立，而且它指出的是我上一轮提交说明里的一句过头话：我写四条只读命令覆盖了历史两个 bug 的形状，但空提交不动 `AGENTS.md`，blame 第 1 行仍然归给真实历史里的作者，出现 `Author: f: restricted` 的只有 `git show --stat HEAD`。按 R7-2 改成修改 `AGENTS.md` 第 1 行的非空提交之后，blame 第 1 行的作者就是 `f: restricted`，这句话才成立。一处改动同时解决 R7-2 和 R7-3。

## R7-4（模型：低，已改）测试里的 `git clone`/`git commit` 用的是开发者的全局 git 配置

成立。真实复核跑 git 时有 `GIT_ENV` 做隔离，我在测试里造提交却没有。开发者机器上如果有 `commit.gpgsign=true`、指向会拒绝提交的 `core.hooksPath`、或者奇怪的别名和模板，这个用例会在他机器上失败或行为不同。照它的建议改：这两条命令显式传 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_SYSTEM=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`，提交再加 `-c commit.gpgsign=false`。

## R7-5（模型：低，这一轮改了，不再留给 Andy）`...extraEnv` 展开在安全关键字段之后

第 6 轮我把这条列为「可以更好」、留给 Andy，理由是它属于复核脚本的结构改动、和本 PR 的实质改动无关。模型这一轮反驳了后半句，我接受：本 PR 本身就在动 `extraEnv`（删掉了 `LC_ALL`），而 R7-1 的修复又把语言环境的保证放进了包装脚本；将来谁往 `extraEnv` 里放一个同名键，就能静默覆盖 `PATH`（guard 的 git 替身）、`SHELL`（guard shell）、`OPENCODE_CONFIG` 这些边界。它给的改法成本极低。

改法比它建议的再往前一步：原来那段环境是在 `runOpencode` 里内联拼的，没法单独测。抽成导出的 `opencodeChildEnv({ parentEnv, cwd, configPath, limitsPath, gitGuard, extraEnv })`，`...extraEnv` 挪到紧跟 `...opencodeEnv(parentEnv)` 之后，所有边界键排在它后面，行为与原来逐键相同、只有覆盖方向反了。新增用例 `[review env] extraEnv cannot take over the guard path, the shell or the config`：传一个把 `PATH`、`SHELL`、`OPENCODE_CONFIG`、`XDG_CONFIG_HOME`、`GIT_CONFIG_GLOBAL`、花费守卫那个变量全部指向「攻击者」路径的 `extraEnv`，断言六个边界键都还是 guard 自己的值，同时一个不冲突的键（`REVIEW_TEST_MARKER`）照常透传。

反向验证：把 `...extraEnv` 挪回末尾，这条用例以 `expected '/attacker/bin' to be '/guard/bin:/usr/bin'` 失败。

它还建议顺带把 `LANG`/`LC_ALL` 也列入受保护键。这一条我不做，因为 R7-1 的修复已经让它没有意义：包装脚本里 `unset LC_ALL` 加 `export LC_MESSAGES=C` 发生在 bash 启动的那一刻，`extraEnv` 里放什么语言环境都盖不过它（上面那条 `unset/C` 的断言在父进程同时设了 `LC_ALL` 和 `LC_MESSAGES` 的情况下通过）。

## 模型对 R6-3、R6-5 的复核

- R6-3（我上一轮不采纳「容忍行首前缀」）：它核了消费端（`opencode-review.mjs:367`）和夹具 `glm-events.jsonl`，确认 `part.state.output` 是命令原始输出、没有前缀，也确认放宽成 `^\S+:` 会重新命中 `Author: f: restricted`，因此同意不采纳。它保留的那个未核实点和我上一轮记的局限是同一件事：现有两份夹具里只有成功命令，没有「被拒绝」的 opencode 事件，所以如果将来 opencode 把拒绝话术放进带前缀的 `error` 字段，行首锚定会漏判。要真覆盖这一段需要新造一份含被拒命令的事件夹具，不在本 PR 范围内，留给 Andy 当「可以更好」。
- R6-5：见 R7-5，这一轮已改。

## 模型自标「未核实」的部分

- `LC_ALL` 优先级高于 `LC_MESSAGES` 是 POSIX 语义，它没法在本机验证 bash 的 ja_JP 翻译是否真的把 `restricted` 翻掉。这一点我也没法验证，容器里没装语言包。但新加的 `unset/C` 断言绕开了这个问题：它量的是环境变量到达 bash 时的值，不依赖任何语言包。
- 容器是否装了 `ja_JP.UTF-8`：没装。它据此判断那条 localized 断言「等于什么都没证明」，判断正确，所以这一轮补了直接断言。那条 localized 断言保留，它证明的是「设了别的语言环境之后这条路仍然走得通、判据仍然成立」。
- 它跑不了测试，所以测试结果都标未核实。实际输出在提交说明里。
- 它提到 `docs/assets/others/Anthropic_SRT_AI_Agent_Integration_Guide_2026-09-07.md` 写着不要假设所有 Linux 镜像有同一 locale，认为新断言与之不一致。这一条我不认为是冲突：那条 localized 断言并不要求 `ja_JP.UTF-8` 存在（断言的是 `probeRefused` 仍为 `true`，语言包缺失时 bash 退回英文消息，断言照样成立），新加的 `unset/C` 断言更是完全不涉及语言包。

## 必答问题

四条回答与我自己的核对一致。第一条它多核了一层：`LC_ALL=C` 原本只在 `selfCheck` 的 `extraEnv` 里，`LC_MESSAGES` 只影响工具执行环境，系统提示、工具定义、历史和遮盖规则这一轮都没动，所以模型已经见过的请求开头不变。
