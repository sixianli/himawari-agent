# PR 312 第 9 轮复核的逐条判断

这一轮看的是按第 8 轮意见改出来的那个提交（`61c5a107` → `0740e100`）。模型的总评是
**本轮增量没有高、中严重度缺陷**，没有新增的「拒绝漏判」或「正常输出误判」路径，也没有
新增的空转断言，并且确认 R8-4 反而补上了一个原有的漏判。

它给了 4 条低，四条都成立，四条都改了。其中前两条抓的是我上一轮那句「opencode 及它
启动的一切都用英文报错」「`LANG` 和 `LC_CTYPE` 保留，所以字符类仍是 UTF-8」——两句都
只在特定条件下成立。

这一轮有三处改动在非测试文件，`--accept-low` 只认测试文件，所以同样不记账本，再复核
一轮。这是我给自己定的收口条件：第 10 轮只要没有中、高，就按自主合并规则合并，剩下的
低和「可以更好」一次性列给 Andy，不再继续这个循环。

## R9-1（模型：低，已改）真实 git 拿不到新加的那两个变量

成立，而且它指出的是我上一轮那句话和那个用例名的硬伤。上一轮我只在 `opencodeChildEnv`
里固定了消息语言，而 git 替身调用真 git 时用的是 `gitChildEnv(process.env)`，它按
`GIT_KEPT_ENV` 这个白名单过滤，白名单里有 `LANG`、`LC_ALL`，没有 `LC_MESSAGES`、
`LANGUAGE`。所以父进程 `LANG=ja_JP.UTF-8` 时，真 git 的 gettext 报错仍可能是日文；而我
那个用例叫「opencode and everything it starts report errors in English」，却只检查
`opencodeChildEnv` 的返回值，没有覆盖真 git 这一条。

它同时把影响范围说清楚了，我核对一致：现在三类拒绝文本分别由 git 替身（Node 写死
ASCII）、受限 bash、opencode 自己打印，`probePlan` 里没有哪条探针依赖真 git 的报错文本，
所以这不会直接造成漏判；问题是说法不实，以及将来加一条依赖真 git 报错的探针就会踩上。

没有照它建议的「把 `LC_MESSAGES`、`LANGUAGE` 加进 `GIT_KEPT_ENV`」改——白名单是「原样
放行父进程的值」，加进去等于把父进程的日文放行，方向反了。抽出一个共用的
`englishMessages(env)`：它固定 `LC_MESSAGES: "C"`、`LANGUAGE: "C"`，并把字符类保下来
（见 R9-2），然后 `gitChildEnv` 和 `opencodeChildEnv` 都展开它，同时把 `LC_ALL` 从两个
白名单里删掉。新增用例
`makes the real git report errors in English without losing the character locale`，直接对
`gitChildEnv({ PATH, LANG: "ja_JP.UTF-8", LC_ALL: "ja_JP.UTF-8" })` 做整体相等断言。

反向验证：`gitChildEnv` 去掉 `...englishMessages(env)`，该用例以
`expected { PATH: '/bin', …(6) } to deeply equal { PATH: '/bin', …(9) }` 失败。

局限写清楚：这条用例量的是交给真 git 的环境变量，不是「真 git 打印的字真的变英文了」。
后者要在装了日文语言包的机器上才能证，本容器没装，所以在这里跑「设日文看报错」只会
因为语言包缺失而退回英文、什么都证明不了（这和第 7 轮 R7-1 的局限是同一件事）。

## R9-2（模型：低，已改）父进程只有 `LC_ALL` 时，删掉它会让字符类退回 C

成立。我上一轮说「`LANG` 和 `LC_CTYPE` 保留，所以字符类仍是 UTF-8」，这句话只在父进程
本来就有这两个变量时成立；如果父进程只靠 `LC_ALL=zh_CN.UTF-8` 提供 UTF-8，删掉它之后
子进程只剩 `LC_MESSAGES=C`，字符类退回 C/POSIX，复核模型在仓库里 grep 中文就会受影响。
我上一轮那个用例的父环境同时给了三个变量，所以证明不了这种情况。

照它的建议改：`englishMessages` 里 `const ctype = env.LC_CTYPE ?? env.LC_ALL ?? env.LANG`，
把字符类显式写成 `LC_CTYPE`，再删 `LC_ALL`。父进程三个都没有时不凭空造一个。新增用例
`[review env] a parent that carries its character locale only in LC_ALL keeps it`：父进程只有
`LC_ALL=zh_CN.UTF-8` 时断言 `LC_CTYPE` 变成 `zh_CN.UTF-8`、`LC_ALL` 不在、`LC_MESSAGES`
是 `C`；父进程什么都没有时断言 `LC_CTYPE` 也不在。

反向验证：把 `ctype` 改成只读 `env.LC_CTYPE`，该用例以
`expected undefined to be 'zh_CN.UTF-8'` 失败。

## R9-3（模型：低，已改）guard shell 的「第二道」没处理 `LANGUAGE`

成立，而且是我自己上一轮的前提没走完：我在判断记录里写了「glibc 下 `LANGUAGE` 优先级
高于 `LC_MESSAGES`，不设它等于留一个口子」，却只在 `opencodeChildEnv` 里设了它，包装
脚本里只有 `unset LC_ALL` 和 `export LC_MESSAGES=C`。生产路径有
`opencodeChildEnv` 兜着，但包装脚本单独被调用时就不是自足的第二道。

改法：包装脚本加 `export LANGUAGE=C`。同时按它的提醒，把集成用例里那次语言环境探测的
环境也显式设上 `LANGUAGE=ja_JP`，不再依赖宿主环境碰巧没设这个变量。

反向验证：删掉包装脚本里的 `export LANGUAGE=C`，集成用例以
`expected [ 'IS_SANDBOX=1', …(237) ] to include 'LANGUAGE=C'` 失败。

## R9-4（模型：低，已改）新的 locale 断言不再区分「未设置」和「空串」

成立，这是对我上一个提交说明里「证明力不变」那句话的纠正。我为了绕开 `biome lint` 的
`noTemplateCurlyInString`，把 `echo ${LC_ALL-unset}/${LC_MESSAGES-unset}` 换成
`echo "[$LC_ALL]/[$LC_MESSAGES]"`，而后者对「未设置」和「空串」都打印 `[]`。虽然 glibc 下
这两者对类别解析是同一回事，但断言本身确实弱了一档。

它建议保留一条只检查键存在性的断言。改得更直接：那次探测改成在包装脚本里跑 `env`，
然后断言「没有任何一行以 `LC_ALL=` 开头」、并且 `LC_MESSAGES=C` 和 `LANGUAGE=C` 各自作为
整行出现。`env` 不打印未设置的变量，空串会打印成 `LC_ALL=`，所以这条断言重新区分了
两者，而且不含 `${...}`、不触发那条 lint 规则。

反向验证：删掉包装脚本里的 `unset LC_ALL`，该断言以 `expected true to be false` 失败
（`LC_ALL=` 那一行出现了）。

## 模型给的那个正则，我核对后不采纳

它按我在材料里的请求，给出了一个既容忍路径空格、又不会命中 `Author: f: restricted` 的
写法：`^(?:(?:\.{0,2}\/)[^\n]*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted`，并自标「没有
运行验证」。我核对了它的说法：路径部分被限成必须以 `/`、`./` 或 `../` 开头，`Author:` 确实
不以这三者开头，所以它对那个误判是安全的。

不采纳的理由不是它不对，而是收益为零而风险不为零：复核只在 Linux 上跑，`command -v bash`
返回的是 `/usr/bin/bash` 或 `/bin/bash`，路径里不会有空格（它自己也写「本仓库运行环境是
Linux，风险很低」）；而这条模式是整个自检唯一的拒绝判据，这个 PR 已经为它改了六次、每次
都被下一轮挑出问题。为了一个在本项目不会出现的形状再动它一次不值得。记为已知局限连同
这个现成的模式一起留给 Andy：如果以后复核要在 bash 路径含空格的机器上跑，用这个写法，
不要把路径部分放宽成 `.*`。

## 模型自标「未核实」的部分

- 它跑不了测试和 `npm run lint`，所以 168 条、33 条和 lint 通过都标未核实。实际输出在
  提交说明里。
- 真 git 的本地化输出跨机器会变——这正是 R9-1，已改。
- `output` 为空白串（例如 `"\n"`）时仍会压掉 `error`：它标为未核实，我也不改。`||` 对
  `"\n"` 是真值，所以会取这个空白串。要处理得先知道真实事件里「被拒但 output 是空白串」
  到底存不存在，而仓库两份夹具都只有成功命令。记为已知局限，和「补一份含被拒命令的
  opencode 事件夹具」是同一件待办。
- 它没有重新审查此前各轮与提示词相关的全部改动，只核了本轮增量。

## 必答问题

四条回答与我自己的核对一致。它在第四条里逐个核对了 `GUARD_ENV` 的产生端和消费端，并
确认 `spend-guard.mjs` 用的是 falsy 判断、唯一不传守卫的调用方是 passthrough 探针，所以
「键不存在」是被接受的形状——这正是 R8-1 改法的前提，由它独立核对过一遍。
