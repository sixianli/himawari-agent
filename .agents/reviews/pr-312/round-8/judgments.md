# PR 312 第 8 轮复核的逐条判断

这一轮看的是 `b291add7` → `61c5a107` 两个提交：按第 7 轮五条意见做的修改（`4d5a6e5b`），以及 CI 上那条真实失败的测试修复（`61c5a107`）。

模型的总结论是**没有高、中严重度缺陷**：第 7 轮五条的说法与代码一致，没有「真实拒绝被漏判」或「正常输出被误判」的新增路径，也没有新的空转断言。它给了 3 条低、2 条自标未核实。

三条低我全改了，并额外采纳了它列在「未核实」里的一条（`output` 为空串时漏判），因为那一条我用仓库代码能确认是真的。另一条未核实的（bash 路径含空格）我不改，理由在下面。

因为这四条里有三条动的是非测试文件，`--accept-low` 只认测试文件，所以这一轮不记账本，按规则再跑一轮复核。

## R8-1（模型：低，已改）`limitsPath` 为空时 `extraEnv` 仍能接管花费守卫那个变量

成立。上一轮我把那段环境抽成 `opencodeChildEnv` 时，花费守卫的变量写的是
`...(limitsPath ? { [GUARD_ENV]: limitsPath } : {})`——`limitsPath` 为空时这一整项被省略，于是 `extraEnv` 里同名的键原样留下。我上一轮新加的那条用例只覆盖了「有 limitsPath」的情况，所以「extraEnv 接管不了边界键」这句保证在没有花费守卫的调用上并不成立。

模型自己把范围说清楚了，我核对一致：现在所有调用方（`selfCheck`、`passthroughProbe`、`reviewOnce`）传进去的 `extraEnv` 都不含这个键，所以不是可利用的漏洞；而且旧代码（`...extraEnv` 排在最后）在这个场景同样是 `extraEnv` 获胜，不是这一轮引入的回归。

改法：这个键无条件写在 `...extraEnv` 之后，然后在 `limitsPath` 为空时把它删掉，这样「无论有没有花费守卫，调用方都接管不了它」。新增用例 `[review env] extraEnv cannot supply the spend guard when the run has none`：`limitsPath: undefined` 而 `extraEnv` 指向攻击者路径，断言这个键根本不在子进程环境里。

反向验证：把那一行还原成原来的三元展开并删掉 `delete`，新用例以 `expected true to be false` 失败。

## R8-2（模型：低，已改）「统一带 `-c`」的说法略过头，还有三处重复内联身份

成立，这是我上一个提交说明里的一句过头话。`run` 现在确实统一前置那组 `-c`，但 `commitAll`、`commitCloud` 和 merge 那条用例里原来内联的 `-c user.name=t -c user.email=t@t` 我没删，于是同一组参数被传两遍。git 取后者、值又相同，所以行为没变；问题在于以后只改 `GIT_SETTINGS` 的人会以为这三处也覆盖到了。按它的建议把三处内联删掉，`GIT_SETTINGS` 成为唯一来源。

验证：`test/tooling/review-delegate.test.mjs` 33 条全过，正常环境和屏蔽全局 git 身份（`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`）两种情况各跑一次都全过。

## R8-3（模型：低，已改，而且它指出的是我上一轮那个理由的漏洞）opencode 自己的拒绝话术没有语言保护

成立。上一轮我拒绝它「把 `LANG`/`LC_ALL` 也列为受保护键」的建议，理由是「R7-1 的修复发生在 bash 启动的那一刻，`extraEnv` 里放什么语言环境都盖不过它」。这个理由只覆盖了受限 bash 那一条路径。三段拒绝字样里有一段是 opencode 自己打印的，而 opencode 这个进程的语言环境来自 `opencodeEnv(parentEnv)`，`OPENCODE_KEPT_ENV` 原样保留 `LANG`、`LC_ALL`、`LC_CTYPE`——`unset LC_ALL` 只写在 guard shell 的包装脚本里，管不到 opencode 自己。所以如果 opencode 按语言环境本地化那句话术，`probeRefused` 会漏判（后果仍是 fail-closed：`PROBE_NOT_REFUSED`，复核起不来）。opencode 的源码不在仓库里，它是否本地化未核实。

改法没有照它的建议「把 `LANG`/`LC_ALL` 列为受保护键」，因为那样只能挡住 `extraEnv`，挡不住真正的来源——父进程的语言环境。改成在 `opencodeChildEnv` 里直接固定消息语言：加 `LC_MESSAGES: "C"` 和 `LANGUAGE: "C"`（`LANGUAGE` 在 glibc 下优先级高于 `LC_MESSAGES`，不设它等于留一个口子），并把继承来的 `LC_ALL` 删掉（它的优先级高于所有单项类别，这正是第 7 轮 R7-1 的教训）。`LANG` 和 `LC_CTYPE` 保留，所以字符类仍是 UTF-8，复核模型在仓库里 grep 中文不受影响。guard shell 里的 `unset LC_ALL` + `export LC_MESSAGES=C` 保留，作为第二道。

新增用例 `[review env] opencode and everything it starts report errors in English`：父进程和 `extraEnv` 同时把 `LC_ALL`、`LC_MESSAGES`、`LANGUAGE` 设成日文，断言子进程环境里没有 `LC_ALL`、`LC_MESSAGES` 和 `LANGUAGE` 都是 `C`，而 `LANG` 和 `LC_CTYPE` 原样保留。

反向验证：删掉那两行和 `delete env.LC_ALL`，新用例以 `expected true to be false` 失败。

## R8-4（模型列在「未核实」里，我核实后采纳并改了）`output` 为空串时不会回退到 `error`

它写的是「若真实 opencode 事件对『被拒』是 `state.output === ""` 且 `state.error` 有拒绝文本，`??` 不会回退到 error」。事件的真实形状确实未核实（这是 R6-3 记下的已知局限：仓库两份夹具都只有成功命令），但**代码层面这一条不用夹具就能确认**：`??` 只在 `null`/`undefined` 时回退，空串是真值判断里的假值但不是 nullish，所以 `output: ""` 会原样取空串，`error` 被丢弃。这是既有代码，不是这一轮引入的。

我采纳并改了，因为它在正确的方向上而且代价为零：改成 `part.state?.output || part.state?.error || ""`，即「优先用非空的 output，否则用 error」。这里的两个值都是文本，不存在 `0` 之类会被误当假值的情况。新增用例 `reads a refusal out of the error field when the command printed nothing`：一条 `status: "error"`、`output: ""`、`error` 里带 `REVIEW_GIT_REFUSED --output` 的 `tool_use` 事件，断言 `summarizeEvents` 取到的是 error 的文本、并且 `probeRefused` 判为 `true`。

反向验证：改回 `??`，新用例以 `expected '' to be 'REVIEW_GIT_REFUSED --output'` 失败。

## 不采纳的一条（模型也自标未核实）bash 路径含空格时漏判

它指出 `^(?:\S*\/)?(?:ba)?sh:` 里的 `\S*` 不允许路径中有空格，所以如果 `command -v bash` 返回带空格的路径，真实拒绝会漏判；它自己写明「本仓库运行环境是 Linux，风险很低」。

不改，理由是放宽这一段会把第 5 轮 R5-3 刚堵住的口子重新打开：要容忍空格就得把路径部分写成 `.*`，而正是「行首到第一个冒号之间可以是任意内容」这种宽松写法让 `git show` 的 `Author: f: restricted` 被误判成拒绝（作者名由提交者控制）。两条意见方向相反，我按真实运行环境的形状来。记为已知局限：如果以后复核要在 bash 路径含空格的机器上跑，这条模式要重做，而且不能靠放宽路径部分来做。

## 模型自标「未核实」的其余部分

- 它读不到 `origin/main` 这个 ref（git 守卫拦住），所以我说的「这个文件与 `origin/main` 逐字节相同」它没法核对，只能确认在给定的 `1a3a1ef`..`b291add7` 区间内该文件未改动。这与我的说法不矛盾：`1a3a1ef` 就是合并进来的那个 main 提交。
- 它跑不了测试，所以 165/33 条全过、`biome`、`derive` 的结果都标未核实。实际输出在提交说明里。

## 我自己这一轮额外发现并修掉的一处

第 7 轮那个提交（`4d5a6e5b`）里，我新加的那条语言环境断言用的是 `viaShell("echo ${LC_ALL-unset}/${LC_MESSAGES-unset}", …)`。这个字符串字面量里的 `${...}` 会被 `biome lint` 的 `noTemplateCurlyInString` 规则报警，而 `npm run lint` 带 `--error-on-warnings`，所以那个提交会让仓库的 lint 门槛失败。原因是我在加完这条断言之后只跑了 `biome format`、没有再跑 `biome lint`。

改成 `viaShell('echo "[$LC_ALL]/[$LC_MESSAGES]"', …)`，期望 `[]/[C]`——不用 `${}`，而且 `unset` 和空串在 glibc 下对语言环境的解析是同一回事，证明力不变。反向验证：删掉包装脚本里的 `unset LC_ALL`，这条断言以 `expected '[ja_JP.UTF-8]/[C]…' to be '[]/[C]'` 失败。`npm run lint` 现在对全仓库 2232 个文件通过。

## 必答问题

四条回答与我自己的核对一致，其中第一条它多核了一层：除了这一轮改的子进程环境和测试，它顺带核对了本 PR 范围内唯一会改变「模型看到的文字」的 `limitBytes`，确认它是在生成工具结果时计算、随消息追加，不回头重写历史。
