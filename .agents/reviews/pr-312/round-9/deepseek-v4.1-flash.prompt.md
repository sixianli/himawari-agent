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
仓库就是当前目录，已检出 0740e10050e704e94471fc08b53cc080357a562e。
对比基准是 1a3a1efecf4fc494057d44989d18d2603ff89fb9，先运行 git diff 1a3a1efecf4fc494057d44989d18d2603ff89fb9..0740e10050e704e94471fc08b53cc080357a562e 看改动。
上一轮复核到 61c5a107f71bd3aee65c8cdc104e323ff8639bb3，先看 git diff 61c5a107f71bd3aee65c8cdc104e323ff8639bb3..0740e10050e704e94471fc08b53cc080357a562e 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 312 第 9 轮复核材料

## 这一轮要看什么

范围：`--previous 61c5a107` 到 `--head 0740e100`，一个提交，是按你上一轮（第 8 轮）
意见做的修改。你上一轮的结论是没有高、中严重度缺陷，给了 3 条低和 2 条自标未核实。
三条低我全改了，另外采纳了你「未核实」里那条能用仓库代码确认的，还顺带修了我自己
漏下的一处 lint 报警。

请着重做三件事：

1. 明确说：这一轮的改动有没有引入「真实的拒绝会被漏判」或「正常输出会被误判」的路径。
   没有就直接说没有。
2. 明确说：有没有把任何已有的断言变成永远成立（vacuous）。第 7 轮你抓到过一次
   （`--allow-empty`），所以这一项每轮都要查。
3. `opencodeChildEnv` 这次从纯粹的对象字面量变成了「先构造再删两个键」。请逐键核对
   它的返回值与改之前是否只在我声称的那几处不同，特别是 `delete` 的两个键有没有把
   别的调用方需要的东西删掉。

## 背景：这段逻辑是干什么的

复核脚本在真正花钱之前会跑一次自检：在一份一次性的仓库副本里，用一个 git 替身和
`bash -r` 限制 opencode 能做什么，然后发一批探针命令，检查哪些该成功、哪些该被拒。
`probeRefused(call)` 判断一条探针命令有没有被拒掉。误判的两个方向都是 fail-closed：
allowed 探针被误判成被拒 → `PROBE_READ_COMMAND_BLOCKED`；write/read 探针漏判 →
`PROBE_NOT_REFUSED`。两种都让自检失败、整轮复核起不来。

判据是三条行首锚定的模式（`REFUSAL_PATTERNS`）：git 替身写的
`REVIEW_GIT_REFUSED <问题码>`、受限 bash 写的 `<shell 路径>: [line N: ]<词>: restricted`、
opencode 自己的拒绝话术。这三段分别由三个不同的进程打印，是这一轮 R8-3 的关键。

## 这一轮改了什么

**R8-1（你判低）** 花费守卫那个变量原来写成
`...(limitsPath ? { [GUARD_ENV]: limitsPath } : {})`，`limitsPath` 为空时整项被省略，
`extraEnv` 里的同名键就留下了。改成无条件写在 `...extraEnv` 之后，再在 `limitsPath`
为空时 `delete`。新增用例 `[review env] extraEnv cannot supply the spend guard when the
run has none`。请核对：`delete` 之后这个键是真的不在对象里（不是值为 `undefined`），
以及 `runOpencode` 把这个环境交给 `spawn` 时，有没有调用方依赖「这个键存在但为空」。

**R8-2（你判低）** `commitAll`、`commitCloud` 和 merge 那条用例里三处重复内联的
`-c user.name=t -c user.email=t@t` 删掉，`GIT_SETTINGS` 成为唯一来源。请核对：这 33 条
用例里所有会写提交的 git 子命令现在是否都经过 `run`，有没有哪条用例原本依赖「这一次
提交的身份与别处不同」。

**R8-3（你判低，你指出我上一轮那个理由只覆盖了 bash 一条路径）** 没有照你建议的
「把 `LANG`/`LC_ALL` 列为受保护键」改，因为那只挡得住 `extraEnv`、挡不住真正的来源
（父进程经 `opencodeEnv` 继承）。改成在 `opencodeChildEnv` 里加 `LC_MESSAGES: "C"` 和
`LANGUAGE: "C"`，并 `delete env.LC_ALL`。`LANG` 和 `LC_CTYPE` 保留，所以字符类仍是
UTF-8，你在仓库里 grep 中文不受影响。guard shell 里的 `unset LC_ALL` +
`export LC_MESSAGES=C` 保留作为第二道。新增用例
`[review env] opencode and everything it starts report errors in English`。

请核对：这三个变量的组合在 glibc 下是否真的能让 opencode 及它启动的一切用英文报错；
`LANGUAGE` 是否确实优先于 `LC_MESSAGES`；删掉 `LC_ALL` 而保留 `LANG`/`LC_CTYPE` 会不会
让某个消费端拿到不一致的语言环境；以及还有没有第四条「拒绝文本」的来源是我没覆盖的。

**R8-4（你列在「未核实」，我核实后采纳）** `String(part.state?.output ?? part.state?.error ?? "")`
的 `??` 只在 null/undefined 时回退，空串不是 nullish，所以 `output: ""` 会丢掉 `error`。
改成 `output || error || ""`。新增用例
`reads a refusal out of the error field when the command printed nothing`。
请核对：这个改动会不会让某个原本依赖「output 为空串」的地方行为变化（例如统计、
`printable`、落盘的原始事件），以及 `||` 在这两个值上有没有别的假值风险。

**不采纳一条（你也自标未核实）** `^(?:\S*\/)?(?:ba)?sh:` 的 `\S*` 不容忍路径里的空格。
要容忍就得把路径部分写成 `.*`，那正好把第 5 轮 R5-3 堵住的口子重新打开：`git show`
的 `Author: f: restricted` 会被误判成拒绝，而作者名由提交者控制。你自己写明本仓库是
Linux、风险很低。如果你认为还有既能容忍空格、又不会放过 `Author:` 这类形状的写法，
请直接给出那个模式。

**顺带修的一处** 上一个提交里那条语言环境断言写成
`viaShell("echo ${LC_ALL-unset}/${LC_MESSAGES-unset}", …)`，字符串字面量里的 `${...}`
会触发 `biome lint` 的 `noTemplateCurlyInString`，而 `npm run lint` 带
`--error-on-warnings`，所以 `4d5a6e5b` 会让 lint 门槛失败。改成
`viaShell('echo "[$LC_ALL]/[$LC_MESSAGES]"', …)`、期望 `[]/[C]`。请核对这条断言的证明力
是否与原来相同（glibc 下 unset 与空串对语言环境的解析是否同一回事）。

## 已知的、不在本轮范围内的

- main 上有三条密钥扫描（gitleaks）的假阳性，CI 的 `security` 检查因此红；要改的是
  `ci/rules/gitleaks.toml` 的白名单，属于 main，已有另一个线程在修。
- main 上 ADR 0181 重号，本地 `test/tooling/adr-numbers.test.mjs` 因此失败；本 PR 不新增
  ADR。
- 仓库两份 opencode 事件夹具都只有成功命令，没有「被拒绝」的事件，所以集成用例喂给
  `probeRefused` 的是 `stdout+stderr`，不是真正消费端的 `part.state.output`。补一份含被拒
  命令的夹具不在本 PR 范围内。R8-4 新增的那条用例是手写的事件，不是真实夹具。

## 验证结果（我实际跑过的）

- `test/tooling/opencode-review.test.mjs`：168 条全过（692 秒）。
- `test/tooling/review-delegate.test.mjs`：33 条全过，正常环境和屏蔽全局 git 身份
  （`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`）两种情况各一次。
- `npm run lint`：全仓库 2232 个文件通过。`biome format` 对改动的三个文件通过。
- 四条改动和那处 lint 修复各有反向验证，具体报错文本写在
  `.agents/reviews/pr-312/round-8/judgments.md` 和提交说明里。
