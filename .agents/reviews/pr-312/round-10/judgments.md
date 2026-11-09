# PR 312 第 10 轮复核的逐条判断

这一轮看的是按第 9 轮意见改出来的那个提交（`0740e100` → `0cefc1a6`）。模型的总评是
**高：无。中：无。**，并写明「本轮增量没有中、高严重度问题；没有发现新增的『真实拒绝被
漏判』或『正常输出被误判』路径，也没有发现新增的空转断言」。它同时确认我上一轮不采纳
那条 bash 路径正则（命令名带空格的情形）不构成中、高问题，留作已知局限即可。

它给了 5 条低，五条都成立，五条都改了。前四条围绕第 9 轮新抽出的 `englishMessages`：
取值次序、空串、测试缺口、以及包装脚本这一层不自足；第 5 条是本 PR 自己造成的文档漂移。

按我给自己定的收口条件，这一轮没有中、高，所以不再开第 11 轮：这五条低的修改用
`--accept-low 10` 记进账本，逐条列给 Andy 抽查。账本以外的改动落在 3 个文件
（`scripts/model-review/opencode-review.mjs` 6 行、`test/tooling/opencode-review.test.mjs`
23 行、`.agents/instructions/model-review.md` 2 行），每个都在每文件 30 行以内，并且有测试
文件的新增，满足 `lowFixProblems` 的门槛。

## R10-1（模型：低，已改）`LANG` 这一支没有用例

成立。第 9 轮我加的三条用例分别喂了 `LC_ALL`+`LC_CTYPE`、只有 `LC_ALL`、`LANG`+`LC_ALL`，
确实没有一条只带 `LANG`，而父进程最常见的恰恰是只有 `LANG`。这是测试缺口，不是当前代码
错误——但它指出的后果是对的：实现退化成 `LC_CTYPE ?? LC_ALL` 时现有用例全绿。

改法：那条用例改名为 `the character locale comes from LC_ALL, then LC_CTYPE, then LANG`，
原有断言保留，末尾加一个 `ctypeOf` 辅助函数逐个场景断言，其中包括只有 `LANG` 的一条；
`gitChildEnv` 那条用例也加上 `gitChildEnv({ PATH, LC_ALL: "", LANG: "ja_JP.UTF-8" }).LC_CTYPE`
等于 `ja_JP.UTF-8`（一条同时盖住 `LANG` 这一支和下面 R10-3 的空串）。

反向验证：把 `englishMessages` 的取值改成只认 `LC_ALL`、`LC_CTYPE` 两个（去掉 `env.LANG`），
该用例以 `AssertionError: expected undefined to be 'zh_CN.UTF-8'` 失败；改回来后通过。

## R10-2（模型：低，已改）`extraEnv` 的 `LC_CTYPE` 会被父环境压掉

成立，但方向上我不采纳它「让 extraEnv 排在后面，或从合并后的 env 计算」的建议：`extraEnv`
是调用方传进来的额外变量，自检用例里它正是攻击面（第 8 轮刚补的边界用例就是证明
`extraEnv` 接管不了 `PATH`、`SHELL`、`OPENCODE_CONFIG`、`XDG_CONFIG_HOME`、
`GIT_CONFIG_GLOBAL` 和花费守卫）。字符类决定模型能不能 grep 中文，属于同一类边界，应当由
父环境决定，不该让 `extraEnv` 改。

所以它说的「隐性规则、没有用例」我照改，规则本身保持「父环境赢」：在那条边界用例里给
`parentEnv` 加 `LC_CTYPE: "zh_CN.UTF-8"`、给 `extraEnv` 加 `LC_CTYPE: "ja_JP.UTF-8"`，断言
结果是 `zh_CN.UTF-8`。这样这条规则从隐性变成写死在用例里的显性规则。

反向验证：照它建议的第二种写法改成 `...englishMessages({ ...parentEnv, ...extraEnv })`，该
用例以 `AssertionError: expected 'ja_JP.UTF-8' to be 'zh_CN.UTF-8'` 失败。它建议的第一种写法
（把 `...extraEnv` 挪到 `englishMessages` 之后）更糟：同一条用例先在
`AssertionError: expected '/attacker/opencode.json' to be '/work/opencode.json'` 上失败，因为
那样 `extraEnv` 连配置文件路径和花费守卫都能接管——这正是不采纳它的理由。

## R10-3（模型：低，已改）空串会挡住回退

成立。`??` 只认 `undefined`／`null`，`LC_CTYPE=""` 会被当成有值，于是写出 `LC_CTYPE: ""`
并且丢掉 `LC_ALL`，字符类退回 C；它举的对比也对：旧实现把 `LC_ALL` 原样放行时，
`LC_ALL=""`+`LANG=ja_JP.UTF-8` 下真 git 还能按 `LANG` 取字符类。

顺带发现并一起修的一处：取值次序原来写成 `env.LC_CTYPE ?? env.LC_ALL ?? env.LANG`，而
POSIX 的优先级是 `LC_ALL` 高于各个 `LC_*`、再高于 `LANG`（这正是第 7 轮 R7-1 让我在包装
脚本里 `unset LC_ALL` 的依据）。父环境同时设了两个且不同值时，旧写法会取错那一个。
现在统一成 `[env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value)`：一处同时解决空串
（`find` 跳过空串）和次序。

反向验证：改回 `env.LC_CTYPE ?? env.LC_ALL ?? env.LANG`，`opencodeChildEnv` 那条用例以
`AssertionError: expected 'ja_JP.UTF-8' to be 'zh_CN.UTF-8'`（次序那条断言先触发）失败，
`gitChildEnv` 那条用例以 `AssertionError: expected '' to be 'ja_JP.UTF-8'`（空串那条）失败。

一处说明：`ctypeOf({ LC_ALL: "", LC_CTYPE: "", LANG: "" })` 的结果是 `""`，不是没有这个键。
因为 `OPENCODE_KEPT_ENV` 这个白名单本来就原样放行父进程的 `LC_CTYPE`，空串也照样放行；
`englishMessages` 只负责不凭空造值，这一点由同一条用例里 `fromNothing` 那组断言
（父进程三个变量都没有时 `"LC_CTYPE" in env === false`）证明。

## R10-4（模型：低，已改）包装脚本没有补回字符类

成立。包装脚本是第二层，设计上就该自足——集成用例本来就是直接调它，父进程只有 `LC_ALL`
时 `bash -r` 的字符类会退回 C。它给的两个选项里我选第一个（在脚本里补 `LC_CTYPE`），因为
第二个（写进注释或文档）靠的是读者遵守约定，而本项目不写代码注释。

改法（按它提醒的 `noTemplateCurlyInString` 避开 `${...}`，所以不用嵌套默认值写法）：

    ctype="$LC_ALL"
    if [ -z "$ctype" ]; then ctype="$LC_CTYPE"; fi
    if [ -z "$ctype" ]; then ctype="$LANG"; fi
    unset LC_ALL
    if [ -n "$ctype" ]; then LC_CTYPE="$ctype"; export LC_CTYPE; fi

次序和 `englishMessages` 一致，空串也一样跳过。集成用例里加两条断言：父环境
`LC_ALL=ja_JP.UTF-8` 时 `env` 里出现 `LC_CTYPE=ja_JP.UTF-8`；三个都是空串时
`LC_CTYPE` 那一行只有空值（`["LC_CTYPE="]`），即包装脚本没有凭空造出一个值。

反向验证：去掉包装脚本里取值和导出 `LC_CTYPE` 的那四行，该用例以
`AssertionError: expected [ 'IS_SANDBOX=1', …(236) ] to include 'LC_CTYPE=ja_JP.UTF-8'` 失败。

## R10-5（模型：低，已改）说明文档的白名单描述过期

成立，而且这处漂移是本 PR 自己造成的：`gitChildEnv` 的白名单本来就有 `TERM`，本 PR 又给
它加了 `LC_CTYPE`、`LC_MESSAGES=C`、`LANGUAGE=C` 并删掉 `LC_ALL`，文档那句没跟着改。

改法：`.agents/instructions/model-review.md` 那句补上 `TERM`，并写明真 git、受限 bash 和
opencode 自己都拿到同一套消息语言设置（`englishMessages`）：删掉会盖过一切的 `LC_ALL`，
固定 `LC_MESSAGES=C`、`LANGUAGE=C`，按 `LC_ALL`、`LC_CTYPE`、`LANG` 的次序把字符类接过来
写进 `LC_CTYPE`。门槛：`npm run check:glossary` 和文档治理的严格校验照跑。

## 二、三节（推测、可以更好）

它第二节把 R10-2、R10-3 的影响明确标为「推测性」，与我上面的判断一致，不另算。
第三节的「可以更好」没有新增条目，只重复了前几轮已经列给 Andy 的那几条（KiB/MiB 写法、
`limitBytes` 的 `toFixed(1)` 与 `Math.round` 不一致、白名单用例只覆盖 21 个码里的 11 个、
`inspectToolResultRecovery` 改名、工厂函数给两个返回类型、`output` 是纯空白时仍压掉
`error`），我按规则不改，一次性列给 Andy。
