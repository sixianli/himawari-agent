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
仓库就是当前目录，已检出 0cefc1a6370e5039bbe2c97d6add41ee1e08d054。
对比基准是 1a3a1efecf4fc494057d44989d18d2603ff89fb9，先运行 git diff 1a3a1efecf4fc494057d44989d18d2603ff89fb9..0cefc1a6370e5039bbe2c97d6add41ee1e08d054 看改动。
上一轮复核到 0740e10050e704e94471fc08b53cc080357a562e，先看 git diff 0740e10050e704e94471fc08b53cc080357a562e..0cefc1a6370e5039bbe2c97d6add41ee1e08d054 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 312 第 10 轮复核材料

## 这一轮要看什么，以及这是最后一轮

范围：`--previous 0740e100` 到 `--head 0cefc1a6`，一个提交，是按你上一轮（第 9 轮）
四条低做的修改。

这是本 PR 的收口轮：只要你这一轮没有中、高严重度的意见，我就合并，剩下的低和「可以
更好」一次性列给 Andy。所以请把力气放在「有没有会出错的东西」上，而不是继续提可以
更好的写法。具体三问：

1. 这一轮的改动有没有引入「真实的拒绝会被漏判」或「正常输出会被误判」的路径？没有
   就直接说没有。
2. 有没有把任何已有的断言变成永远成立（vacuous）？第 7 轮你抓到过一次，所以每轮都查。
3. `englishMessages` 现在被 `gitChildEnv` 和 `opencodeChildEnv` 两处共用。请逐键核对
   这两个函数的返回值与改之前的差异，确认只在我声称的那几处不同，并确认没有哪个消费端
   因为多了 `LC_CTYPE`/`LC_MESSAGES`/`LANGUAGE` 或少了 `LC_ALL` 而出问题。

## 背景：这段逻辑是干什么的

复核脚本在真正花钱之前会跑一次自检：在一份一次性的仓库副本里，用一个 git 替身和
`bash -r` 限制 opencode 能做什么，然后发一批探针命令，检查哪些该成功、哪些该被拒。
`probeRefused(call)` 判断一条探针命令有没有被拒掉。误判的两个方向都是 fail-closed：
allowed 探针被误判成被拒 → `PROBE_READ_COMMAND_BLOCKED`；write/read 探针漏判 →
`PROBE_NOT_REFUSED`。两种都让自检失败、整轮复核起不来。

判据是三条行首锚定的模式（`REFUSAL_PATTERNS`）：git 替身写的
`REVIEW_GIT_REFUSED <问题码>`、受限 bash 写的 `<shell 路径>: [line N: ]<词>: restricted`、
opencode 自己的拒绝话术。这三段由三个不同的进程打印，所以语言环境要在三个地方都固定。

## 这一轮改了什么

**R9-1** 没按你建议的「把 `LC_MESSAGES`、`LANGUAGE` 加进 `GIT_KEPT_ENV`」改，理由是那个
白名单的语义是「原样放行父进程的值」，加进去等于放行日文。抽出共用的
`englishMessages(env)`：固定 `LC_MESSAGES: "C"`、`LANGUAGE: "C"`，把字符类显式写成
`LC_CTYPE`，`gitChildEnv` 和 `opencodeChildEnv` 都在最后展开它，`LC_ALL` 从两个白名单
（`GIT_KEPT_ENV`、`OPENCODE_KEPT_ENV`）里删掉。`opencodeChildEnv` 里仍保留
`delete env.LC_ALL`，因为 `extraEnv` 也可能带它进来。新增用例
`makes the real git report errors in English without losing the character locale`。

**R9-2** `englishMessages` 里 `const ctype = env.LC_CTYPE ?? env.LC_ALL ?? env.LANG`，
三个都没有时不设 `LC_CTYPE`。新增用例
`[review env] a parent that carries its character locale only in LC_ALL keeps it`，覆盖
「只有 `LC_ALL`」和「三个都没有」两种父环境。

**R9-3** guard shell 的包装脚本加 `export LANGUAGE=C`；集成用例那次语言环境探测也显式
设上 `LANGUAGE=ja_JP`。

**R9-4** 那次探测从 `echo "[$LC_ALL]/[$LC_MESSAGES]"` 改成在包装脚本里跑 `env`，断言
「没有任何一行以 `LC_ALL=` 开头」并且 `LC_MESSAGES=C`、`LANGUAGE=C` 各自整行出现。
`env` 不打印未设置的变量、空串会打印成 `LC_ALL=`，所以重新区分了「未设置」和「空串」，
而且不含 `${...}`、不触发 `noTemplateCurlyInString`。请核对这条断言是否真的比上一版强，
以及用 `env` 做探测会不会把别的东西带进断言（例如这一行的匹配方式是否够严）。

**你给的那个正则我核对后不采纳**
`^(?:(?:\.{0,2}\/)[^\n]*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted`：我核了你的说法，
路径部分被限成必须以 `/`、`./`、`../` 开头，`Author: f: restricted` 不以这三者开头，所以
对第 5 轮 R5-3 那个误判是安全的。不采纳的理由是收益为零而风险不为零：复核只在 Linux 上
跑，`command -v bash` 不会返回带空格的路径；而这条模式是自检唯一的拒绝判据，本 PR 已经
为它改了六次。记为已知局限留给 Andy。如果你认为这个判断本身有错（例如本项目真的会在
路径含空格的机器上跑复核），请直接说，并按中/高严重度写。

## 已知的、不在本轮范围内的

- main 上三条密钥扫描（gitleaks）假阳性导致 CI 的 `security` 检查红；要改的是
  `ci/rules/gitleaks.toml` 的白名单，属于 main，已有另一个线程在修。
- main 上 ADR 0181 重号，本地 `test/tooling/adr-numbers.test.mjs` 因此失败；本 PR 不新增
  ADR。
- 仓库两份 opencode 事件夹具都只有成功命令，没有「被拒绝」的事件。由此派生的两个已知
  局限：集成用例喂给 `probeRefused` 的是 `stdout+stderr` 而不是真正消费端的
  `part.state.output`；以及 `output` 为空白串（例如 `"\n"`）时仍会压掉 `error`。补一份含
  被拒命令的夹具不在本 PR 范围内。
- 「真 git 打印的字真的变英文了」这件事本容器证不了（没装非英文语言包），所以 R9-1 的
  用例量的是交给真 git 的环境变量。

## 验证结果（我实际跑过的）

- `test/tooling/opencode-review.test.mjs`：170 条全过（623 秒）。
- `npm run lint`：全仓库 2232 个文件通过。`biome format` 对改动的两个文件通过。
- 四条改动各有反向验证，具体报错文本写在
  `.agents/reviews/pr-312/round-9/judgments.md` 和提交说明里。
